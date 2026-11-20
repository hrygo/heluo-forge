import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { createIamService } from '../src/service.mjs';
import { createGrantStore, createGatewayCredentialStore, GATEWAY_RECORD_KEY, GATEWAY_REF } from '../src/store.mjs';
import { BINDING_REASONS, evaluateGatewayBinding, resolveTargetBaseURL } from '../src/gateway-binding.mjs';
import { createAtomicGatewayFixture } from './support/atomic-gateway.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const issuer = 'https://iam.corp.example';
const gatewayA = 'https://gateway-a.corp.example/v1';
const gatewayB = 'https://gateway-b.corp.example/v1';
const baseConfig = {
  issuer, clientId: 'synthetic-client',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
};
const key = `uag-${'a'.repeat(32)}`;
const record = extra => ({
  version: 3, ownerSubject: 'synthetic-subject', issuer, baseURL: gatewayA,
  enteredAt: '2030-01-01T00:00:00.000Z', writeOperationId: randomUUID(),
  valueDigest: 'a'.repeat(64), ...extra,
});

// ── 纯判定：每条理由都能被单独触发，绑定成立时没有任何理由 ──────────────

test('a v3 record bound to the same issuer and address is the only bound case (issue #226)', () => {
  assert.deepEqual(evaluateGatewayBinding({ credential: record(), expectedIssuer: issuer, authoritativeBaseURL: gatewayA }), { bound: true, addressMatches: true });
  // Without an enterprise preset the saved address is still the anchor.
  assert.equal(evaluateGatewayBinding({ credential: record(), expectedIssuer: issuer }).bound, true);
});

test('every unprovable binding reports its own reason (issue #226)', () => {
  const cases = [
    [undefined, BINDING_REASONS.LEGACY_UNBOUND],
    [record({ version: 2 }), BINDING_REASONS.LEGACY_UNBOUND],
    [record({ version: 1 }), BINDING_REASONS.LEGACY_UNBOUND],
    [record({ issuer: '' }), BINDING_REASONS.ISSUER_MISSING],
    [record({ issuer: 'https://other-iam.corp.example' }), BINDING_REASONS.ISSUER_CHANGED],
    [record({ baseURL: undefined }), BINDING_REASONS.ADDRESS_MISSING],
    [record({ baseURL: gatewayB }), BINDING_REASONS.ADDRESS_CHANGED],
  ];
  for (const [credential, reason] of cases) {
    const result = evaluateGatewayBinding({ credential, expectedIssuer: issuer, authoritativeBaseURL: gatewayA });
    assert.equal(result.bound, false, reason);
    assert.equal(result.reason, reason);
  }
  // A trusted issuer that this instance does not know cannot pin anything.
  assert.equal(evaluateGatewayBinding({ credential: record(), expectedIssuer: '', authoritativeBaseURL: gatewayA }).reason, BINDING_REASONS.ISSUER_CHANGED);
});

test('the send target is the authoritative address, never the stored one alone (issue #226)', () => {
  assert.equal(resolveTargetBaseURL({ credentialBaseURL: gatewayB, authoritativeBaseURL: gatewayA }), gatewayA);
  assert.equal(resolveTargetBaseURL({ credentialBaseURL: gatewayA }), gatewayA);
  assert.equal(resolveTargetBaseURL({}), undefined);
});

// ── 记录层：v3 必须带 issuer 与地址；v2 可被一次重录替换；v1 仍只读 ─────────

function storeFixture() {
  const fixture = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(fixture.credentials, fixture.options);
  return { ...fixture, store };
}

test('saving without a trusted issuer or a target address is refused (issue #226)', async () => {
  const f = storeFixture();
  const base = { value: key, ownerSubject: 'synthetic-subject', enteredAt: '2030-01-01T00:00:00.000Z' };
  for (const input of [{ ...base, baseURL: gatewayA }, { ...base, issuer }, { ...base }]) {
    await assert.rejects(() => f.store.save(input), (error) => error.code === 'IAM_GATEWAY_BINDING_INCOMPLETE');
  }
  assert.equal(f.credentials.refs.size, 0);
  assert.equal(f.credentials.records.size, 0);
});

test('a bound record stores issuer and address and round-trips (issue #226)', async () => {
  const f = storeFixture();
  const saved = await f.store.save({ value: key, issuer, baseURL: gatewayA, ownerSubject: 'synthetic-subject', enteredAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(saved.credential.version, 3);
  assert.equal(saved.credential.issuer, issuer);
  assert.equal(saved.credential.baseURL, gatewayA);
  assert.deepEqual(await f.store.resolve(saved.credential), { value: key, source: 'keychain' });
});

test('an unbound v2 record can be replaced once by a bound v3 record (issue #226)', async () => {
  const f = storeFixture();
  // A record written before the binding existed: same digest rules, no issuer.
  f.credentials.records.set(GATEWAY_RECORD_KEY, {
    kind: 'grant',
    payload: {
      version: 2, ownerSubject: 'synthetic-subject', baseURL: gatewayA, enteredAt: '2030-01-01T00:00:00.000Z',
      writeOperationId: randomUUID(),
      valueDigest: createHash('sha256').update(key).digest('hex'),
    },
  });
  f.credentials.refs.set(GATEWAY_REF, key);
  const saved = await f.store.save({ value: `${key}-new`, issuer, baseURL: gatewayA, ownerSubject: 'synthetic-subject', enteredAt: '2030-01-02T00:00:00.000Z' });
  assert.equal(saved.credential.version, 3);
  assert.equal(f.credentials.refs.get(GATEWAY_REF), `${key}-new`);
});

test('a v1 record is invalid and stays read-only instead of being migrated (issue #226)', async () => {
  const f = storeFixture();
  f.credentials.records.set(GATEWAY_RECORD_KEY, {
    kind: 'grant', payload: { version: 1, ownerSubject: 'synthetic-subject', enteredAt: '2030-01-01T00:00:00.000Z' },
  });
  f.credentials.refs.set(GATEWAY_REF, key);
  // No value digest means the record cannot be verified, so it is not migrated
  // and not repairable in place; the stored pair is untouched.
  const before = f.pair();
  assert.deepEqual(await f.store.read(), { ok: false, reason: 'invalid-credential', errors: ['unsupported gateway credential version'] });
  assert.deepEqual(f.pair(), before);
  await assert.rejects(
    () => f.store.save({ value: key, issuer, baseURL: gatewayA, ownerSubject: 'synthetic-subject', enteredAt: '2030-01-02T00:00:00.000Z' }),
    (error) => error.code === 'IAM_GATEWAY_LEGACY_READ_ONLY',
  );
});

// ── 服务层：保存门禁、发送目标、重录提示与 A→B→A ──────────────────────

async function serviceWith(t, { managedModels = { baseURL: gatewayA }, fixture = createAtomicGatewayFixture() } = {}) {
  await createGrantStore(fixture.credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer, clientId: baseConfig.clientId, subject: 'synthetic-subject',
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', scope: 'openid',
    obtainedAt: new Date(now - 60000).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
  });
  const service = createIamService(
    { ...baseConfig, ...(managedModels === null ? {} : { managedModels }) },
    { credentials: fixture.credentials, now: () => now, ...fixture.options, fetch: async () => { throw new Error('no network permitted'); } },
  );
  t.after(() => service.dispose());
  return { ...fixture, service };
}

test('a save request carrying a different address is rejected and stores nothing (issue #226)', async (t) => {
  const f = await serviceWith(t);
  await assert.rejects(
    () => f.service.saveGatewayCredential({ key, baseURL: gatewayB }),
    (error) => error.code === 'IAM_GATEWAY_URL_MISMATCH' && !JSON.stringify(error).includes(key),
  );
  assert.equal(f.credentials.refs.has(GATEWAY_REF), false);
  assert.equal(f.credentials.records.has(GATEWAY_RECORD_KEY), false);
});

test('a matching save records the authoritative address and issuer (issue #226)', async (t) => {
  const f = await serviceWith(t);
  const view = await f.service.saveGatewayCredential({ key });
  assert.equal(view.gatewayCredential.state, 'configured');
  assert.equal(view.gatewayCredential.baseURL, gatewayA);
  assert.equal(view.gatewayCredential.issuer, issuer);
  assert.equal(view.gatewayCredential.addressAuthoritative, true);
  const payload = f.credentials.records.get(GATEWAY_RECORD_KEY).payload;
  assert.equal(payload.issuer, issuer);
  assert.equal(payload.baseURL, gatewayA);
});

test('the call target is the authoritative address, and the Key is never sent elsewhere (issue #226)', async (t) => {
  const f = await serviceWith(t);
  await f.service.saveGatewayCredential({ key });
  const connection = await f.service.resolveGatewayConnection();
  assert.equal(connection.baseURL, gatewayA);
  assert.equal(connection.key, key);
});

test('an address switch stops the call instead of sending the old Key to the new gateway (issue #226)', async (t) => {
  const saved = createAtomicGatewayFixture();
  const first = await serviceWith(t, { managedModels: { baseURL: gatewayA }, fixture: saved });
  await first.service.saveGatewayCredential({ key });
  // The same stored credentials are now read by an instance configured for B.
  const second = await serviceWith(t, { managedModels: { baseURL: gatewayB }, fixture: saved });
  await assert.rejects(
    () => second.service.resolveGatewayConnection(),
    (error) => error.code === 'IAM_GATEWAY_CREDENTIAL_REBIND_REQUIRED' && error.details?.reason === BINDING_REASONS.ADDRESS_CHANGED,
  );
  const view = await second.service.loadGatewayCredential({ force: true });
  assert.equal(view.state, 'rebind-required');
  assert.equal(view.rebindReason, BINDING_REASONS.ADDRESS_CHANGED);
  assert.equal(view.baseURL, gatewayB);
  // The Key still exists; it is simply never handed to a different target.
  assert.equal(saved.credentials.refs.get(GATEWAY_REF), key);
});

test('A → B → A returns to a usable binding without destroying the earlier record (issue #226)', async (t) => {
  const saved = createAtomicGatewayFixture();
  const a = await serviceWith(t, { managedModels: { baseURL: gatewayA }, fixture: saved });
  await a.service.saveGatewayCredential({ key });
  const b = await serviceWith(t, { managedModels: { baseURL: gatewayB }, fixture: saved });
  await assert.rejects(() => b.service.resolveGatewayConnection(), (error) => error.code === 'IAM_GATEWAY_CREDENTIAL_REBIND_REQUIRED');
  // Re-entering the Key for B is the one allowed path forward.
  const rebind = await b.service.saveGatewayCredential({ key: `${key}-for-b` });
  assert.equal(rebind.gatewayCredential.state, 'configured');
  assert.equal((await b.service.resolveGatewayConnection()).baseURL, gatewayB);
  assert.equal((await b.service.resolveGatewayConnection()).key, `${key}-for-b`);
  // Rolling the enterprise configuration back to A is itself a switch: the B
  // record is now bound to B, so A requires its own re-entry rather than silently
  // reusing whichever Key happens to be stored.
  const back = await serviceWith(t, { managedModels: { baseURL: gatewayA }, fixture: saved });
  await assert.rejects(
    () => back.service.resolveGatewayConnection(),
    (error) => error.code === 'IAM_GATEWAY_CREDENTIAL_REBIND_REQUIRED' && error.details?.reason === BINDING_REASONS.ADDRESS_CHANGED,
  );
  const again = await back.service.saveGatewayCredential({ key: `${key}-for-a` });
  assert.equal(again.gatewayCredential.state, 'configured');
  assert.equal((await back.service.resolveGatewayConnection()).baseURL, gatewayA);
});

test('a record written before the binding existed asks for one re-entry and is not sent (issue #226)', async (t) => {
  const fixture = createAtomicGatewayFixture();
  const f = await serviceWith(t, { fixture });
  // v2 payload: the shape older releases wrote, with a valid value digest.
  fixture.credentials.records.set(GATEWAY_RECORD_KEY, {
    kind: 'grant',
    payload: {
      version: 2, ownerSubject: 'synthetic-subject', baseURL: gatewayA, enteredAt: '2030-01-01T00:00:00.000Z',
      writeOperationId: randomUUID(),
      valueDigest: createHash('sha256').update(key).digest('hex'),
    },
  });
  fixture.credentials.refs.set(GATEWAY_REF, key);
  await assert.rejects(
    () => f.service.resolveGatewayConnection(),
    (error) => error.code === 'IAM_GATEWAY_CREDENTIAL_REBIND_REQUIRED' && error.details?.reason === BINDING_REASONS.LEGACY_UNBOUND,
  );
  const view = await f.service.loadGatewayCredential({ force: true });
  assert.equal(view.state, 'rebind-required');
  // One re-entry binds it and the Key is usable again.
  const bound = await f.service.saveGatewayCredential({ key });
  assert.equal(bound.gatewayCredential.state, 'configured');
});

test('a changed trusted issuer stops the call without touching the stored Key (issue #226)', async (t) => {
  const saved = createAtomicGatewayFixture();
  const first = await serviceWith(t, { fixture: saved });
  await first.service.saveGatewayCredential({ key });
  const moved = createIamService(
    { ...baseConfig, issuer: 'https://iam-2.corp.example', managedModels: { baseURL: gatewayA } },
    { credentials: saved.credentials, now: () => now, ...saved.options, fetch: async () => { throw new Error('no network permitted'); } },
  );
  t.after(() => moved.dispose());
  // The grant of the previous issuer is refused first; either way no Key leaves
  // the process, and the panel still explains why a re-entry is needed.
  await assert.rejects(
    () => moved.resolveGatewayConnection(),
    (error) => ['IAM_GATEWAY_CREDENTIAL_REBIND_REQUIRED', 'IAM_GRANT_CONTEXT_MISMATCH'].includes(error.code),
  );
  const view = await moved.loadGatewayCredential({ force: true });
  assert.equal(view.state, 'rebind-required');
  assert.equal(view.rebindReason, BINDING_REASONS.ISSUER_CHANGED);
  assert.equal(saved.credentials.refs.get(GATEWAY_REF), key);
});

test('without an enterprise preset the saved address is the anchor and still binds (issue #226)', async (t) => {
  const f = await serviceWith(t, { managedModels: null });
  await assert.rejects(() => f.service.saveGatewayCredential({ key }), (error) => error.code === 'IAM_GATEWAY_BINDING_INCOMPLETE');
  const view = await f.service.saveGatewayCredential({ key, baseURL: gatewayA });
  assert.equal(view.gatewayCredential.state, 'configured');
  assert.equal(view.gatewayCredential.addressAuthoritative, false);
  assert.equal((await f.service.resolveGatewayConnection()).baseURL, gatewayA);
});
