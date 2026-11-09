import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { createIamService } from '../src/service.mjs';
import { createIamRoutes } from '../src/routes.mjs';
import { IamError } from '../src/errors.mjs';
import { createGrantStore, GATEWAY_REF } from '../src/store.mjs';
import { createAtomicGatewayFixture, gatewayAtomicOptions, seedLegacyGateway } from './support/atomic-gateway.mjs';
import { mountPanel } from './support/client-panel.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const config = {
  issuer: 'https://iam.corp.example', clientId: 'synthetic-client',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
};
const input = { key: `uag-${'a'.repeat(32)}`, deviceLabel: 'synthetic-device' };
const errorStatus = {
  IAM_GATEWAY_ATOMIC_UNVERIFIED: 503,
  IAM_GATEWAY_LEGACY_READ_ONLY: 409,
  IAM_GATEWAY_CHANGED: 409,
  IAM_GATEWAY_WRITE_UNKNOWN: 503,
};

async function setup(t, { capability = true, grantAtomic = false, signedIn = true, options = {}, fixture = createAtomicGatewayFixture() } = {}) {
  const { credentials } = fixture;
  if (signedIn) await createGrantStore(credentials).write({
    version: 1, issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-subject',
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', scope: 'openid',
    obtainedAt: new Date(now - 60000).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
  });
  let requests = 0;
  const service = createIamService(config, {
    credentials, now: () => now,
    ...(capability ? fixture.options : {}),
    ...(grantAtomic ? { verifyAtomicStore: (candidate) => candidate === credentials } : {}),
    fetch: async () => { requests++; throw new Error('no network permitted'); },
    ...options,
  });
  t.after(() => service.dispose());
  return { ...fixture, service, requests: () => requests };
}

function assertUnchanged(fixture, before) {
  assert.equal(isDeepStrictEqual(fixture.pair(), before), true, 'stored pair must remain unchanged');
}

function pauseCommit(t, adapter) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  adapter.beforeCommit = async () => { entered.resolve(); await released.promise; };
  t.after(released.resolve);
  return { entered: entered.promise, release: released.resolve };
}

test('grant atomic verification alone never enables gateway mutations or fallback writes', async (t) => {
  const f = await setup(t, { capability: false, grantAtomic: true });
  const before = f.pair();
  let fallbackWrites = 0;
  for (const method of ['set', 'unset', 'deleteRecord']) {
    f.credentials[method] = async () => { fallbackWrites++; };
  }
  for (const operation of [() => f.service.saveGatewayCredential(input), () => f.service.clearGatewayCredential()]) {
    await assert.rejects(operation(), { code: 'IAM_GATEWAY_ATOMIC_UNVERIFIED' });
  }
  assertUnchanged(f, before);
  assert.equal(fallbackWrites, 0);
  assert.equal(f.requests(), 0);
});

test('an explicit exact gateway capability permits a bound subject without trusting grant writes', async (t) => {
  const f = await setup(t);
  const view = await f.service.saveGatewayCredential(input);
  const stored = f.pair();
  assert.equal(stored.record?.payload?.version, 2);
  assert.equal(stored.record?.payload?.ownerSubject === 'synthetic-subject', true);
  assert.equal(stored.value === input.key, true);
  assert.equal(view.gatewayCredential.state, 'configured');
  assert.equal(f.adapter.commits, 1);
  assert.equal(f.requests(), 0);
});

test('a capability bound to another credentials object cannot enable gateway writes', async (t) => {
  const other = createAtomicGatewayFixture();
  const f = await setup(t, { options: other.options });
  const before = f.pair();
  await assert.rejects(f.service.saveGatewayCredential(input), { code: 'IAM_GATEWAY_ATOMIC_UNVERIFIED' });
  assertUnchanged(f, before);
  assert.equal(other.adapter.commits, 0);
});

test('V1 gateway data remains readable and immutable even with the exact joint capability', async (t) => {
  const f = await setup(t);
  seedLegacyGateway(f.credentials, { value: input.key, ownerSubject: 'synthetic-subject', enteredAt: new Date(now).toISOString() });
  const before = f.pair();
  assert.equal((await f.service.loadGatewayCredential({ force: true })).state, 'configured');
  for (const operation of [() => f.service.saveGatewayCredential(input), () => f.service.clearGatewayCredential()]) {
    await assert.rejects(operation(), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  }
  assertUnchanged(f, before);
  assert.equal(f.adapter.commits, 0);
});

test('clear remains available while signed out when the joint capability is explicitly trusted', async (t) => {
  const fixture = createAtomicGatewayFixture();
  const writer = await setup(t, { fixture });
  await writer.service.saveGatewayCredential(input);
  const f = await setup(t, { fixture, signedIn: false });
  assert.equal(f.service.getView().signedIn, false);
  const view = await f.service.clearGatewayCredential();
  assert.equal(f.pair().value === undefined, true);
  assert.equal(view.gatewayCredential.state, 'unconfigured');
  assert.equal(f.adapter.commits, 2);
});

for (const outcome of ['throw', 'missing-receipt']) {
  test(`a committed gateway transaction with ${outcome} is unknown, never rolled back or retried`, async (t) => {
    const f = await setup(t);
    if (outcome === 'throw') f.adapter.afterCommit = () => { throw new Error('synthetic private backend failure'); };
    else {
      const cas = f.adapter.compareAndSwap.bind(f.adapter);
      f.adapter.compareAndSwap = async (...args) => { await cas(...args); return undefined; };
    }
    await assert.rejects(f.service.saveGatewayCredential(input), { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
    assert.equal(f.adapter.attempts, 1);
    assert.equal(f.adapter.commits, 1);
    assert.equal(f.pair().value === input.key, true);
    assert.equal(f.pair().record?.payload?.version, 2);
    assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
  });
}

for (const operation of ['save', 'clear']) {
  for (const lifecycle of ['dispose', 'provider-replacement', 'exclusive-revoked']) {
    test(`${operation} commit guard rejects ${lifecycle} after the transaction was queued`, async (t) => {
      const fixture = createAtomicGatewayFixture();
      const replacement = createAtomicGatewayFixture();
      let current = fixture.credentials;
      let exclusive = { ok: true };
      const f = await setup(t, { fixture, options: {
        ...gatewayAtomicOptions(fixture, replacement),
        getCredentials: () => current,
        recheckExclusive: () => exclusive,
      } });
      if (operation === 'clear') await f.service.saveGatewayCredential(input);
      const before = f.pair();
      const beforeReplacement = replacement.pair();
      const commits = f.adapter.commits;
      const gate = pauseCommit(t, f.adapter);
      const pending = operation === 'save' ? f.service.saveGatewayCredential(input) : f.service.clearGatewayCredential();
      const rejected = assert.rejects(pending);
      await gate.entered;
      if (lifecycle === 'dispose') await f.service.dispose();
      else if (lifecycle === 'provider-replacement') current = replacement.credentials;
      else exclusive = { ok: false, reason: 'synthetic-revocation' };
      gate.release();
      await rejected;
      assertUnchanged(f, before);
      assertUnchanged(replacement, beforeReplacement);
      assert.equal(f.adapter.commits, commits);
      assert.equal(f.requests(), 0);
    });
  }
}

test('a local sign-out supersedes a queued save before its atomic commit', async (t) => {
  const f = await setup(t, { grantAtomic: true });
  const before = f.pair();
  const gate = pauseCommit(t, f.adapter);
  const pending = f.service.saveGatewayCredential(input);
  const rejected = assert.rejects(pending);
  await gate.entered;
  await f.service.signOut();
  gate.release();
  await rejected;
  assertUnchanged(f, before);
  assert.equal(f.adapter.commits, 0);
});

test('V2 metadata and separately resolved value must match before the service reports configured', async (t) => {
  const f = await setup(t);
  await f.service.saveGatewayCredential(input);
  f.credentials.refs.set(GATEWAY_REF, `uag-${'b'.repeat(32)}`);
  const summary = await f.service.loadGatewayCredential({ force: true });
  assert.equal(summary.state, 'invalid');
  assert.equal(summary.matchesAccount === true, false);
});

for (const [code, status] of Object.entries(errorStatus)) {
  test(`credential routes map ${code} to ${status} without private failure details`, async () => {
    const handler = createIamRoutes({ clearGatewayCredential: async () => {
      throw new IamError(code, 'safe gateway failure', { value: input.key });
    } }, { getConnection: () => ({ requestRejection: () => undefined }) });
    const request = new EventEmitter();
    Object.assign(request, { method: 'DELETE', url: '/api/forge-iam/credential', headers: {
      'x-forge-iam-request': '1', 'content-type': 'application/json',
    } });
    let body;
    const response = { setHeader() {}, end(value) { body = value; } };
    await handler(request, response);
    assert.equal(response.statusCode, status);
    assert.equal(JSON.parse(body).error.code, code);
    assert.equal(body.includes(input.key), false);
  });

  test(`the client explains ${code} and retains it only in the diagnostic code whitelist`, async (t) => {
    const copied = [];
    const panel = await mountPanel(async () => Response.json({
      state: 'error', error: code, configured: true, signedIn: false, missing: [], exclusive: 'ok',
    }), { navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } } });
    t.after(() => panel.close());
    assert.equal(panel.text(panel.render()).includes(`操作失败：${code}`), false);
    const button = panel.findButton(panel.render(), '复制问题信息');
    assert.ok(button);
    await button.props.onClick();
    const diagnostic = JSON.parse(copied[0]);
    assert.equal(diagnostic.errorCode, code);
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      'format', 'version', 'pagePhase', 'iamState', 'configured', 'signedIn', 'exclusive',
      'gatewayState', 'errorCode', 'missingConfigCount',
    ].sort());
  });
}

for (const [state, label] of [
  ['invalid', '记录不一致，已保留'],
  ['owner-mismatch', '属于其他账号，请核对记录'],
]) {
  test(`the client ${state} status preserves existing records without promising a replacement`, async (t) => {
    const panel = await mountPanel(async () => Response.json({
      state: 'ready', error: null, configured: true, signedIn: true, missing: [], exclusive: 'ok',
      gatewayCredential: { state },
    }));
    t.after(() => panel.close());
    const rendered = panel.render();
    assert.equal(panel.text(rendered).includes(label), true);
    assert.equal(panel.text(rendered).includes('重新录入'), false);
    assert.equal(panel.text(rendered).includes('粘贴到下方'), false);
    // Status alone cannot identify a legacy record: let Host policy decide
    // whether an explicitly trusted V2 pair can still be replaced.
    assert.equal(panel.findButton(rendered, '保存凭据')?.props.disabled, false);
  });
}

test('Host model credential read requires a current grant and matching account; logout keeps no access', async t => {
  const f = await setup(t, { grantAtomic: true });
  await f.service.hydrate();
  await f.service.saveGatewayCredential({ ...input, baseURL: 'https://gateway.corp.example/v1' });
  assert.equal(await f.service.resolveGatewayCredential(), input.key);
  assert.equal(JSON.stringify(f.service.getView()).includes(input.key), false);
  await f.service.signOut();
  await assert.rejects(f.service.resolveGatewayCredential(), { code: 'IAM_NOT_SIGNED_IN' });
});

test('Host credential read does not adopt a different account or an orphan key', async t => {
  const f = await setup(t, { grantAtomic: true });
  await f.service.hydrate();
  seedLegacyGateway(f.credentials, { value: input.key, ownerSubject: 'another-person', enteredAt: new Date(now).toISOString() });
  await assert.rejects(f.service.resolveGatewayCredential(), { code: 'IAM_GATEWAY_CREDENTIAL_REQUIRED' });
});

test('gateway address and an opaque compatible Key commit together and remain Host-only', async t => {
  const f = await setup(t, { grantAtomic: true }); await f.service.hydrate();
  const key = 'synthetic-compatible-key';
  await f.service.saveGatewayCredential({ key, baseURL: 'https://gateway.corp.example/' });
  const connection = await f.service.resolveGatewayConnection();
  assert.equal(connection.baseURL, 'https://gateway.corp.example'); assert.equal(connection.key, key);
  assert.equal(f.service.getView().gatewayCredential.baseURL, connection.baseURL);
  assert.equal(JSON.stringify(f.service.getView()).includes(key), false);
  const before = f.pair();
  await assert.rejects(f.service.saveGatewayCredential({ key, baseURL: credentialURL() }), { code: 'IAM_GATEWAY_URL_INVALID' });
  assertUnchanged(f, before);
});

function credentialURL() {
  const url = new URL('https://gateway.corp.example/v1');
  url.username = 'synthetic-user'; url.password = 'synthetic-password';
  return url.href;
}
