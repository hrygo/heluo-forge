import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { apply } from '../src/index.mjs';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY, GATEWAY_REF } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { seedLegacyGateway } from './support/atomic-gateway.mjs';

const clock = Date.parse('2030-01-01T00:00:00.000Z');
const sentinel = 'SYNTHETIC_PRIVATE_MODEL_CONTEXT';
const config = {
  issuer: 'https://iam.corp.example', clientId: 'synthetic-client',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  redirectUri: 'http://127.0.0.1:9/iam/callback', defaultProvider: 'enterprise', defaultModel: 'corp-model',
};
const settle = () => new Promise(setImmediate);

function recordingSdk({ selection = { provider: 'enterprise', model: 'chosen-model', reasoningEffort: 'high' },
  providers = [{ id: 'enterprise', name: 'Synthetic enterprise' }], list, current } = {}) {
  const counts = { list: 0, current: 0, saveAccess: 0 };
  const stored = selection;
  const llm = { listProviders() { counts.list++; return list ? list() : providers; } };
  const agentDefaultModel = {
    currentSelection() { counts.current++; return current ? current() : stored; },
    get saveSelection() { counts.saveAccess++; throw new Error(sentinel); },
  };
  return { llm, agentDefaultModel, counts, stored };
}

async function seeded({ gateway = 'matching', signedIn = true } = {}) {
  const credentials = new MemoryCredentials();
  if (signedIn) await createGrantStore(credentials).write({
    version: 1, issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-subject',
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', scope: 'openid',
    obtainedAt: new Date(clock - 60000).toISOString(), accessExpiresAt: new Date(clock + 3600000).toISOString(),
  });
  if (gateway !== 'missing') seedLegacyGateway(credentials, {
    value: `uag-${'a'.repeat(32)}`, ownerSubject: gateway === 'matching' ? 'synthetic-subject' : 'synthetic-other',
    enteredAt: new Date(clock).toISOString(),
  });
  return credentials;
}

// In-memory Cordis lifecycle only: no profile, server, model calls or SDK writes.
function fakeContext(credentials, sdk) {
  const services = new Map([['credentials', credentials]]);
  if (sdk) { services.set('llm', sdk.llm); services.set('agentDefaultModel', sdk.agentDefaultModel); }
  const provided = new Map();
  const effects = [];
  const injections = new Set();
  const events = new Map();
  let disposed = false;
  const ctx = {
    get: (name) => provided.get(name) ?? services.get(name),
    provide(name, value) { provided.set(name, value); return () => provided.delete(name); },
    effect(callback) { const off = callback(); effects.push(off); return off; },
    on(name, callback) {
      const listeners = events.get(name) ?? new Set(); events.set(name, listeners); listeners.add(callback);
      return () => listeners.delete(callback);
    },
    inject(dependencies, callback) {
      const entry = { dependencies, callback, off: undefined };
      const mount = () => {
        if (disposed || !dependencies.every((name) => services.has(name))) return;
        entry.off = callback({ ...ctx, ...Object.fromEntries(dependencies.map((name) => [name, services.get(name)])) });
      };
      entry.mount = mount; injections.add(entry); mount();
      return () => { entry.off?.(); entry.off = undefined; injections.delete(entry); };
    },
    replace(name, value) {
      for (const entry of injections) if (entry.dependencies.includes(name)) { entry.off?.(); entry.off = undefined; }
      if (value === undefined) services.delete(name); else services.set(name, value);
      for (const entry of injections) if (entry.dependencies.includes(name)) entry.mount();
    },
    emit(name) { for (const callback of [...(events.get(name) ?? [])]) callback(); },
    listenerCount(name) { return events.get(name)?.size ?? 0; },
    async unload() {
      disposed = true;
      for (const off of effects.splice(0).reverse()) if (typeof off === 'function') await off();
    },
  };
  return ctx;
}

async function host(t, { sdk = recordingSdk(), gateway = 'matching', signedIn = true, defaultModel = 'corp-model' } = {}) {
  const credentials = await seeded({ gateway, signedIn });
  const ctx = fakeContext(credentials, sdk);
  apply(ctx, { ...config, defaultModel });
  const service = ctx.get('iam');
  t.after(() => ctx.unload());
  await service.hydrate();
  await settle();
  return { ctx, service, credentials, sdk };
}

function readonly(result, reason) {
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, { mode: 'read-only', written: false, verified: false, reason });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
}

function pauseGateway(t, credentials, { fail = false } = {}) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const resolve = credentials.resolve.bind(credentials);
  let armed = true;
  credentials.resolve = async (ref) => {
    if (ref === GATEWAY_REF && armed) {
      armed = false; entered.resolve(); await released.promise;
      if (fail) throw new Error(sentinel);
    }
    return resolve(ref);
  };
  t.after(released.resolve);
  return { entered: entered.promise, release: released.resolve };
}

test('real apply hydrates IAM and coordinates a fixed read-only result without touching saveSelection', async (t) => {
  const f = await host(t);
  assert.equal(f.service.getView().state, 'ready');
  assert.equal(f.sdk.counts.list > 0, true, 'ready Host must actually sample the SDK');
  const before = structuredClone(f.sdk.stored);
  readonly(await f.service.reconcileDefaultModel(), 'existing-selection-preserved');
  assert.equal(isDeepStrictEqual(f.sdk.stored, before), true);
  assert.equal(f.sdk.counts.saveAccess, 0);
});

test('an empty defaultModel never obtains model services or starts SDK reads', async (t) => {
  const credentials = await seeded();
  let bindings = 0;
  const sdk = recordingSdk();
  const service = createIamService({ ...config, defaultModel: '' }, {
    credentials, now: () => clock, getModelSelectionServices: () => { bindings++; return sdk; },
  });
  t.after(() => service.dispose());
  await service.hydrate();
  readonly(await service.reconcileDefaultModel(), 'default-model-unconfigured');
  assert.equal(bindings, 0);
  assert.deepEqual(sdk.counts, { list: 0, current: 0, saveAccess: 0 });
});

for (const [name, selection] of [
  ['enterprise', { provider: 'enterprise', model: 'chosen-model', reasoningEffort: 'high', extra: sentinel }],
  ['official', { provider: 'official', model: 'old-model', reasoningEffort: 'medium' }],
  ['another provider', { provider: 'another', model: 'another-model' }],
  ['empty strings', { provider: '', model: '' }],
  ['partial', { provider: 'enterprise' }],
  ['null', null], ['undefined', undefined], ['array', []],
]) {
  test(`the Host preserves ${name} selection without inferring an explicit or empty state`, async (t) => {
    const sdk = recordingSdk({ current: () => selection });
    const f = await host(t, { sdk });
    const before = structuredClone(selection);
    readonly(await f.service.reconcileDefaultModel(), ['enterprise', 'official', 'another provider'].includes(name)
      ? 'existing-selection-preserved' : 'selection-unprovable');
    assert.equal(isDeepStrictEqual(selection, before), true);
    assert.equal(sdk.counts.saveAccess, 0);
  });
}

test('a missing target provider returns a fixed read-only status and never changes the current selection', async (t) => {
  const f = await host(t, { sdk: recordingSdk({ providers: [] }) });
  readonly(await f.service.reconcileDefaultModel(), 'enterprise-provider-unavailable');
  assert.equal(f.sdk.counts.saveAccess, 0);
});

for (const situation of ['missing-sdk', 'signed-out', 'missing-gateway', 'wrong-owner']) {
  test(`the Host ${situation} does not sample model services`, async (t) => {
    const sdk = recordingSdk();
    const f = await host(t, { sdk: situation === 'missing-sdk' ? null : sdk,
      signedIn: situation !== 'signed-out',
      gateway: situation === 'missing-gateway' ? 'missing' : situation === 'wrong-owner' ? 'other' : 'matching' });
    readonly(await f.service.reconcileDefaultModel(), situation === 'missing-sdk' ? 'model-services-unavailable'
      : situation === 'signed-out' ? 'iam-not-ready' : 'gateway-credential-unavailable');
    assert.deepEqual(sdk.counts, { list: 0, current: 0, saveAccess: 0 });
  });
}

for (const failure of ['list', 'current', 'list-getter', 'current-getter', 'async-list', 'async-current']) {
  test(`SDK ${failure} failures are fixed, read-only and never expose their original text`, async (t) => {
    const sdk = recordingSdk();
    const name = failure.startsWith('list') || failure === 'async-list' ? 'listProviders' : 'currentSelection';
    const owner = name === 'listProviders' ? sdk.llm : sdk.agentDefaultModel;
    if (failure.endsWith('getter')) Object.defineProperty(owner, name, { get() { throw new Error(sentinel); } });
    else owner[name] = () => {
      if (failure.startsWith('async-')) return Promise.reject(new Error(sentinel));
      throw new Error(sentinel);
    };
    const f = await host(t, { sdk });
    readonly(await f.service.reconcileDefaultModel(), failure.startsWith('async-') ? 'model-sdk-contract-invalid' : 'model-read-failed');
    assert.equal(sdk.counts.saveAccess, 0);
    assert.equal(f.service.getView().state, 'ready');
  });
}

for (const failure of [false, true]) {
  for (const lifecycle of ['dispose', 'credentials', 'llm', 'agentDefaultModel', 'clear-start', 'cancel-start']) {
    test(`a paused ${failure ? 'failed' : 'successful'} gateway read cannot publish across ${lifecycle}`, async (t) => {
      const f = await host(t);
      const before = { ...f.sdk.counts };
      const gate = pauseGateway(t, f.credentials, { fail: failure });
      const pending = f.service.reconcileDefaultModel();
      await gate.entered;
      if (lifecycle === 'dispose') await f.ctx.unload();
      else if (lifecycle === 'credentials') f.ctx.replace('credentials', await seeded());
      else if (lifecycle === 'llm' || lifecycle === 'agentDefaultModel') f.ctx.replace(lifecycle, recordingSdk()[lifecycle]);
      else if (lifecycle === 'clear-start') await assert.rejects(f.service.clearGatewayCredential(), { code: 'IAM_GATEWAY_ATOMIC_UNVERIFIED' });
      else await f.service.cancelSignIn();
      gate.release();
      readonly(await pending, 'model-context-changed');
      assert.equal(f.sdk.counts.saveAccess, 0);
      assert.equal(f.sdk.counts.list, before.list);
      assert.equal(f.sdk.counts.current, before.current);
    });
  }
}

test('replacing only the scoped binding invalidates a paused read over the same two SDK instances', async (t) => {
  const credentials = await seeded();
  const sdk = recordingSdk();
  let binding = Object.freeze({ llm: sdk.llm, agentDefaultModel: sdk.agentDefaultModel });
  const service = createIamService(config, { credentials, now: () => clock,
    getModelSelectionServices: () => binding });
  t.after(() => service.dispose());
  await service.hydrate(); await settle();
  const before = { ...sdk.counts };
  const gate = pauseGateway(t, credentials);
  const pending = service.reconcileDefaultModel();
  await gate.entered;
  binding = Object.freeze({ llm: sdk.llm, agentDefaultModel: sdk.agentDefaultModel });
  gate.release();
  readonly(await pending, 'model-context-changed');
  assert.equal(sdk.counts.list - before.list, 0);
  assert.equal(sdk.counts.current - before.current, 0);
  assert.equal(sdk.counts.saveAccess, 0);
});

test('a getter returning a fresh wrapper cannot prove one stable SDK binding scope', async (t) => {
  const credentials = await seeded();
  const sdk = recordingSdk();
  const service = createIamService(config, { credentials, now: () => clock,
    getModelSelectionServices: () => Object.freeze({ llm: sdk.llm, agentDefaultModel: sdk.agentDefaultModel }) });
  t.after(() => service.dispose());
  await service.hydrate(); await settle();
  readonly(await service.reconcileDefaultModel(), 'model-context-changed');
  assert.deepEqual(sdk.counts, { list: 0, current: 0, saveAccess: 0 });
});

test('a real sign-out invalidates an in-flight model observation at its start', async (t) => {
  const credentials = await seeded();
  const sdk = recordingSdk();
  const service = createIamService(config, { credentials, now: () => clock,
    verifyAtomicStore: (candidate) => candidate === credentials, getModelSelectionServices: () => sdk });
  t.after(() => service.dispose());
  await service.hydrate(); await settle();
  const gate = pauseGateway(t, credentials);
  const pending = service.reconcileDefaultModel();
  await gate.entered;
  const signingOut = service.signOut();
  gate.release();
  readonly(await pending, 'model-context-changed');
  await signingOut;
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(sdk.counts.saveAccess, 0);
});

test('getView/getPrincipal are side-effect-free and SDK events coalesce without a gateway feedback loop', async (t) => {
  const f = await host(t);
  assert.equal(f.ctx.listenerCount('llm/adapters-updated'), 1);
  const before = { ...f.sdk.counts };
  for (let index = 0; index < 20; index++) { f.service.getView(); f.service.getPrincipal(); }
  await settle();
  assert.deepEqual(f.sdk.counts, before);
  const gate = pauseGateway(t, f.credentials);
  const pending = f.service.reconcileDefaultModel();
  await gate.entered;
  const duplicate = f.service.reconcileDefaultModel();
  for (let index = 0; index < 20; index++) f.ctx.emit('llm/adapters-updated');
  gate.release();
  await Promise.all([pending, duplicate]); await settle();
  assert.equal(f.sdk.counts.list - before.list <= 2, true, 'burst must coalesce into bounded observations');
  assert.equal(f.sdk.counts.list - before.list >= 1, true);
  const after = { ...f.sdk.counts };
  await settle();
  assert.deepEqual(f.sdk.counts, after, 'own gateway read must not re-trigger the coordinator');
  f.ctx.replace('llm', undefined);
  assert.equal(f.ctx.listenerCount('llm/adapters-updated'), 0);
  f.ctx.emit('llm/adapters-updated'); await settle();
  assert.deepEqual(f.sdk.counts, after);
});

test('an externally refreshed gateway state triggers one bounded read-only observation', async (t) => {
  const f = await host(t, { gateway: 'missing' });
  assert.equal(f.sdk.counts.list, 0);
  seedLegacyGateway(f.credentials, { value: `uag-${'a'.repeat(32)}`, ownerSubject: 'synthetic-subject', enteredAt: new Date(clock).toISOString() });
  await f.service.loadGatewayCredential({ force: true }); await settle();
  assert.equal(f.sdk.counts.list, 1);
  assert.equal(f.sdk.counts.saveAccess, 0);
});

for (const failure of ['list', 'current', 'list-getter', 'current-getter']) {
  test(`successful OIDC callback keeps its grant and identity when model ${failure} fails`, async (t) => {
    const credentials = await seeded({ signedIn: false });
    const sdk = recordingSdk();
    const name = failure.startsWith('list') ? 'listProviders' : 'currentSelection';
    const owner = name === 'listProviders' ? sdk.llm : sdk.agentDefaultModel;
    if (failure.endsWith('getter')) Object.defineProperty(owner, name, { get() { throw new Error(sentinel); } });
    else owner[name] = () => { throw new Error(sentinel); };
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
    let nonce;
    let revocations = 0;
    const service = createIamService({ ...config, revocationEndpoint: `${config.issuer}/revoke` }, {
      credentials, now: () => clock, verifyAtomicStore: (candidate) => candidate === credentials,
      getOrigin: () => 'http://127.0.0.1:9',
      getModelSelectionServices: () => sdk,
      fetch: async (url) => {
        if (String(url) === config.jwksUri) return Response.json({ keys: [jwk] });
        if (String(url) === `${config.issuer}/revoke`) { revocations++; return new Response('', { status: 200 }); }
        assert.equal(String(url), config.tokenEndpoint);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
        const claims = Buffer.from(JSON.stringify({ iss: config.issuer, aud: config.clientId, sub: 'synthetic-subject',
          iat: clock / 1000, exp: clock / 1000 + 3600, nonce })).toString('base64url');
        const body = `${header}.${claims}`;
        const idToken = `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
        return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
          token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: idToken });
      },
    });
    t.after(() => service.dispose());
    const attempt = await service.startSignIn();
    const authorization = new URL(attempt.authorizationUrl);
    nonce = authorization.searchParams.get('nonce');
    const callback = new URL(config.redirectUri);
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'synthetic-code');
    const view = await service.handleCallback(callback.href);
    assert.equal(view.state, 'ready');
    await settle();
    readonly(await service.reconcileDefaultModel(), 'model-read-failed');
    const grant = await credentials.readRecord(GRANT_KEY);
    assert.equal(grant?.payload?.refreshToken === 'synthetic-refresh', true);
    assert.equal(service.getView().signedIn, true);
    assert.equal(revocations, 0);
    assert.equal(sdk.counts.saveAccess, 0);
  });
}
