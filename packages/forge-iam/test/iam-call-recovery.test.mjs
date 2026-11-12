import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { IamError } from '../src/errors.mjs';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { createAtomicGatewayFixture, seedGateway } from './support/atomic-gateway.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

// CORP-DSH-PLAN-018: benign changes must not surface as failures, and a real
// failure must name an action. These cases pin the recovery boundaries: which
// change rebuilds the adapter, which one is adopted in place, and which one is
// never retried because the request may already have left.

const GATEWAY = 'https://gateway.corp.example/v1';
const MOVED_GATEWAY = 'https://gateway-b.corp.example/v1';
const CATALOGUE = { data: [{ id: 'enterprise-chat' }] };
const options = { provider: 'enterprise', model: 'enterprise-chat', messages: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));

/** `projects` answers one model per gateway address; it can be told to fail the new one. */
function fixture({ tokenFailure = null, logFailure } = {}) {
  let view = {
    state: 'ready', principal: 'person-a', accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
    gatewayCredential: { state: 'configured', matchesAccount: true },
  };
  const listeners = new Set();
  let epoch = 'epoch-1';
  let connection = { baseURL: GATEWAY, key: 'key-1', generation: 'gen-1', subject: 'person-a' };
  let builds = 0; let attempts = 0; let requests = 0; let credential = null;
  let discover = 0; let movedGatewayDown = false;
  let holdDiscovery = null;
  let releaseChunk = null;
  let failAfterFirstChunk = false;
  const iam = {
    getView: () => structuredClone(view),
    readModelSelection: async () => ({
      subject: 'person-a', saved: true, models: { 'enterprise-chat': {} }, defaultModelId: 'enterprise-chat',
    }),
    saveModelSelection: async next => ({ subject: 'person-a', saved: true, ...structuredClone(next) }),
    getModelAccessEpoch: () => epoch,
    resolveGatewayConnection: async () => structuredClone(connection),
    getAccessToken: async () => {
      if (tokenFailure) throw new IamError(tokenFailure, 'synthetic token failure');
      return 'synthetic-iam-token';
    },
    async *watch(signal) {
      yield structuredClone(view);
      while (!signal.aborted) {
        const value = await new Promise(resolve => {
          const receive = () => { cleanup(); resolve(structuredClone(view)); };
          const abort = () => { cleanup(); resolve(null); };
          const cleanup = () => { listeners.delete(receive); signal.removeEventListener('abort', abort); };
          listeners.add(receive); signal.addEventListener('abort', abort, { once: true });
        });
        if (value) yield value;
      }
    },
  };
  let adapter; let guard;
  const host = {
    llm: { registerAdapter(routes, value) { adapter = value; return () => { }; } },
    on(name, callback) { assert.equal(name, 'llm/stream'); guard = callback; return () => { }; },
    emit() { },
  };
  const createAdapter = async ({ resolveKey, resolveIamToken }) => {
    builds += 1;
    const dispatch = async function* () {
      attempts += 1;
      // The host asks for the key while building the request: a failure here
      // means nothing was sent, which is what makes the retry safe.
      const key = await resolveKey();
      if (typeof resolveIamToken === 'function') await resolveIamToken();
      requests += 1; credential = key;
      yield { type: 'text-delta', text: 'first' };
      if (releaseChunk) await releaseChunk.promise;
      if (failAfterFirstChunk) throw new IamError('IAM_GATEWAY_BINDING_CHANGED', 'synthetic mid-stream binding change', { retryable: true });
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    return {
      providerInfo: id => ({ id, name: '企业模型' }),
      providerRetryPolicy: () => undefined,
      resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
      prepareCall: async (provider, model) => ({ model: { provider, id: model, name: model }, stream: () => dispatch() }),
      stream: () => dispatch(),
    };
  };
  const runtime = createManagedModelRuntime({
    host, iam, config: { defaultProvider: 'enterprise', managedModels: { baseURL: GATEWAY } },
    createAdapter, logFailure,
    requestHeaders: async () => ({}),
    fetch: async url => {
      if (holdDiscovery) await holdDiscovery.promise;
      discover += 1;
      if (String(url).startsWith(MOVED_GATEWAY)) {
        return movedGatewayDown ? new Response('', { status: 503 }) : Response.json(CATALOGUE);
      }
      if (String(url).startsWith(GATEWAY)) return Response.json(CATALOGUE);
      throw new Error(`unexpected discovery address: ${url}`);
    },
  });
  return {
    iam, runtime, get adapter() { return adapter; }, get guard() { return guard; }, get builds() { return builds; },
    get attempts() { return attempts; }, get requests() { return requests; },
    get discover() { return discover; }, get credential() { return credential; },
    setConnection(next) { connection = { ...connection, ...next }; },
    setEpoch(next) { epoch = next; },
    failMovedGateway(next = true) { movedGatewayDown = next; },
    holdNextDiscovery() { holdDiscovery = Promise.withResolvers(); return holdDiscovery; },
    holdChunks() { releaseChunk = Promise.withResolvers(); return releaseChunk; },
    failAfterFirstChunk() { failAfterFirstChunk = true; },
    change(next) { view = { ...view, ...next }; for (const listener of [...listeners]) listener(); },
  };
}

const chunks = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
const finishOf = result => result.at(-1)?.reason ?? {};
const failureOf = result => finishOf(result).failure?.code;
const until = async (condition, label, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await tick();
  }
};

test('a re-saved key at the same address is adopted without rebuilding the adapter', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(f.builds, 1);
  await chunks(f.adapter.stream(options));
  assert.equal(f.credential, 'key-1');
  // Same address and owner, new key material: the write generation moves.
  f.setConnection({ key: 'key-2', generation: 'gen-2' });
  const result = await chunks(f.adapter.stream(options));
  assert.equal(finishOf(result).kind, 'stop');
  assert.equal(f.credential, 'key-2', 'the call must use the new key');
  assert.equal(f.builds, 1, 'a key swap is not an address change');
  assert.equal(f.attempts, 2);
});

test('an address change rebuilds once and retries the dispatch once', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  f.setConnection({ baseURL: MOVED_GATEWAY, key: 'key-2', generation: 'gen-2' });
  const result = await chunks(f.adapter.stream(options));
  assert.equal(finishOf(result).kind, 'stop');
  assert.equal(f.builds, 2, 'exactly one rebuild');
  assert.equal(f.attempts, 2, 'the failed attempt plus one retry');
  assert.equal(f.requests, 1, 'the retry is the only request that reached the gateway');
  assert.equal(f.credential, 'key-2');
  assert.equal(failureOf(result), undefined);
});

test('a rebuild that fails keeps a specific code instead of the unknown-failure bucket', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  f.setConnection({ baseURL: MOVED_GATEWAY });
  f.failMovedGateway();
  const result = await chunks(f.adapter.stream(options));
  assert.equal(finishOf(result).kind, 'error');
  assert.equal(failureOf(result), 'ENTERPRISE_GATEWAY_UNAVAILABLE');
  assert.notEqual(failureOf(result), 'ENTERPRISE_GATEWAY_CALL_FAILED');
  assert.equal(f.requests, 0);
});

test('a changed owner asks for a sign-in instead of retrying under another person', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  f.setConnection({ subject: 'person-b', key: 'key-of-b' });
  const result = await chunks(f.adapter.stream(options));
  assert.equal(failureOf(result), 'IAM_LOGIN_REQUIRED');
  assert.equal(f.requests, 0, 'nothing is sent under a different owner');
  assert.equal(f.builds, 1, 'a different owner is not a transport to rebuild');
});

test('switching the model selection mid-answer lets the answer finish', async t => {
  const f = fixture({});
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const release = f.holdChunks();
  const stream = f.adapter.stream(options);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.text, 'first');
  f.setEpoch('epoch-2');
  f.change({});
  await tick();
  release.resolve();
  const rest = [];
  for (let step = await iterator.next(); !step.done; step = await iterator.next()) rest.push(step.value);
  assert.equal(finishOf(rest).kind, 'stop', 'the answer must not be aborted by a selection change');
  assert.equal(f.requests, 1);
});

test('a binding change after the first chunk is never retried', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const release = f.holdChunks();
  f.failAfterFirstChunk();
  const stream = f.adapter.stream(options);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.text, 'first');
  // The binding moves while the answer is being read: a retry here would
  // deliver the same answer twice.
  f.setConnection({ baseURL: MOVED_GATEWAY });
  release.resolve();
  const rest = [];
  for (let step = await iterator.next(); !step.done; step = await iterator.next()) rest.push(step.value);
  assert.equal(failureOf(rest), 'IAM_MODEL_CONTEXT_CHANGED');
  assert.equal(f.attempts, 1, 'no second dispatch after the first chunk');
  assert.equal(f.builds, 1, 'a started answer must not rebuild under the reader');
  assert.equal(f.requests, 1);
});

test('a prepared call that outlived its binding is re-prepared and sent once', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const prepared = await f.adapter.prepareCall(options.provider, options.model);
  f.setConnection({ baseURL: MOVED_GATEWAY, key: 'key-2', generation: 'gen-2' });
  const result = await chunks(prepared.stream(options));
  assert.equal(finishOf(result).kind, 'stop');
  assert.equal(f.builds, 2, 'the catalogue is rebuilt for the new address');
  assert.equal(f.requests, 1, 'only one request reaches the gateway');
  assert.equal(f.credential, 'key-2');
});

test('cancelling before the retry window prevents the second dispatch', async t => {
  const controller = new AbortController();
  let attempts = 0;
  const runtimeFixture = fixture();
  t.after(() => runtimeFixture.runtime.dispose());
  await runtimeFixture.runtime.ready;
  const dispatch = async function* () {
    attempts += 1;
    await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    // Even the retryable code must not restart a cancelled request.
    throw new IamError('IAM_GATEWAY_BINDING_CHANGED', 'synthetic binding change', { retryable: true });
  };
  const stream = runtimeFixture.guard({ ...options, signal: controller.signal }, dispatch);
  const timer = setTimeout(() => controller.abort(), 5);
  const result = await chunks(stream);
  clearTimeout(timer);
  assert.equal(result.at(-1).reason?.kind, 'aborted');
  assert.equal(attempts, 1, 'a cancelled request must not be retried');
  assert.equal(runtimeFixture.builds, 1);
});

test('an IAM token failure reaches the person as a service code, not as an unknown failure', async t => {
  const f = fixture({ tokenFailure: 'IAM_UNREACHABLE' });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.adapter.stream(options));
  assert.equal(failureOf(result), 'ENTERPRISE_IAM_UNAVAILABLE');
  assert.equal(f.requests, 0, 'no model request is sent without a usable token');
});

test('a mapped failure records its internal code without widening the failure object', async t => {
  const logged = [];
  const f = fixture({ tokenFailure: 'IAM_UNREACHABLE', logFailure: (detailCode, code) => logged.push([detailCode, code]) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.adapter.stream(options));
  const failure = finishOf(result).failure;
  assert.equal(failure.code, 'ENTERPRISE_IAM_UNAVAILABLE');
  // The client contract types this as { code, message }: diagnosis stays out.
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'message']);
  assert.deepEqual(logged, [['IAM_UNREACHABLE', 'ENTERPRISE_IAM_UNAVAILABLE']]);
});

test('a credential-storage failure reaches the person as a storage code', async t => {
  const f = fixture({ tokenFailure: 'CRED_DECRYPT_FAILED' });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.adapter.stream(options));
  assert.equal(failureOf(result), 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE');
});

test('a refresh voided by a context change rebuilds for the version that is current now', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const buildsAtStart = f.builds;
  const hold = f.holdNextDiscovery();
  const pending = f.runtime.refresh();
  await tick();
  // The person changes context while the catalogue request is in flight.
  f.setEpoch('epoch-2');
  f.change({});
  await tick();
  hold.resolve();
  await assert.rejects(pending, { code: 'IAM_MODEL_CONTEXT_CHANGED' });
  await until(() => f.discover >= 3, 'the compensating rebuild');
  const result = await chunks(f.adapter.stream(options));
  assert.equal(finishOf(result).kind, 'stop', 'the current version must have a working adapter');
  assert.ok(f.builds > buildsAtStart, 'a rebuild happened for the current version');
});

// --- service layer: the key no longer waits on a token refresh -------------

async function sessionFixture(t, { accessOffsetMs = 600_000, tokenOutage = false } = {}) {
  const oidc = await startMockOidc({ accessTtl: 600 });
  t.after(() => oidc.close());
  const atomic = createAtomicGatewayFixture();
  const clock = Date.now();
  oidc.refreshTokens.set('refresh-a', { subject: 'E1001' });
  await createGrantStore(atomic.credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer,
    subject: 'E1001', clientId: oidc.clientId, refreshToken: 'refresh-a', accessToken: 'access-a', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + accessOffsetMs).toISOString(),
    refreshExpiresAt: new Date(clock + 3_600_000).toISOString(),
  });
  seedGateway(atomic.credentials, {
    value: 'uag-synthetic-key', baseURL: GATEWAY, ownerSubject: 'E1001',
    deviceLabel: 'synthetic', enteredAt: new Date(clock).toISOString(),
  });
  const service = createIamService({
    ...oidc.endpoints, clientId: oidc.clientId, redirectUri: 'http://127.0.0.1:4567/iam/callback',
  }, {
    credentials: atomic.credentials,
    ...atomic.options,
    verifyAtomicStore: candidate => candidate === atomic.credentials,
    now: () => clock,
    fetch: async (url, init) => {
      // A preflight failure is the token layer's own unreachable case: it
      // happens before any refresh claim, so nothing is consumed.
      if (tokenOutage && String(url).endsWith('/jwks')) throw new Error('synthetic preflight outage');
      return fetch(url, init);
    },
  });
  t.after(() => service.dispose());
  await service.hydrate();
  return { service, oidc, key: 'uag-synthetic-key' };
}

test('the gateway key resolves from a session whose access token already expired', async t => {
  const f = await sessionFixture(t, { accessOffsetMs: -1_000 });
  assert.equal(f.service.getView().state, 'expired');
  const connection = await f.service.resolveGatewayConnection();
  assert.equal(connection.key, f.key);
  assert.equal(connection.subject, 'E1001', 'the binding carries its owner');
  assert.equal(f.oidc.counts.refresh, 0, 'resolving the key alone must not mint a token');
});

test('a token refresh failure is reported by the token layer, not by the key layer', async t => {
  const f = await sessionFixture(t, { accessOffsetMs: -1_000, tokenOutage: true });
  const connection = await f.service.resolveGatewayConnection();
  assert.equal(connection.key, f.key, 'the key does not inherit the token outage');
  await assert.rejects(f.service.getAccessToken(), { code: 'IAM_UNREACHABLE' });
});