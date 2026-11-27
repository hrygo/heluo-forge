import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelFailureLogger } from '../src/model-failure-log.mjs';
import { createManagedModelRuntime, createNativeGatewayAdapter } from '../src/managed-models.mjs';
import { IamError } from '../src/errors.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
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
function fixture({ tokenFailure = null, logFailure, diagnoseFailure, finishFailureCode = null, native = false,
  manual = [], failMovedAdapter = false, iamOverride, sendModelRequest, beforeModelFetch } = {}) {
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
  let lastSignal = null;
  const iam = iamOverride ?? {
    getView: () => structuredClone(view),
    readModelSelection: async () => ({
      subject: 'person-a', saved: true, models: { 'enterprise-chat': {} }, defaultModelId: 'enterprise-chat', manual,
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
  // One transport models the gateway: it follows the request signal, counts the
  // requests that actually reached it, and can fail by throwing as well as by a
  // finish chunk, because the shipped adapter produces both shapes.
  const transport = async function* (key, callOptions = {}) {
    lastSignal = callOptions.signal ?? null;
    if (finishFailureCode) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: finishFailureCode, message: 'synthetic transport failure' } } };
      return;
    }
    requests += 1; credential = key;
    yield { type: 'text-delta', text: 'first' };
    if (releaseChunk) {
      // The transport follows the request signal: an aborted request ends here,
      // exactly like a socket that is torn down.
      await new Promise((resolve, reject) => {
        const signal = callOptions.signal;
        const abort = () => reject(Object.assign(new Error('transport aborted'), { name: 'AbortError' }));
        signal?.addEventListener('abort', abort, { once: true });
        releaseChunk.promise.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
      });
    }
    if (failAfterFirstChunk) throw new IamError('IAM_GATEWAY_BINDING_CHANGED', 'synthetic mid-stream binding change', { retryable: true });
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  // The host installs the native adapter, so the recovery has to hold through it:
  // its per-call key resolution is where a binding change surfaces, and a stand-in
  // adapter alone cannot prove the retry survives that boundary.
  const nativeLoader = {
    async import(specifier) {
      if (specifier === '@deepseek-ai/dsh-llm-pi-ai') {
        return {
          PiAiAdapter: class PiAiAdapter {
            constructor(adapterOptions) { this.options = adapterOptions; }
            providerInfo(id) { const profile = this.options.profiles().get(id); return profile ? { id, name: profile.displayName } : undefined; }
            providerRetryPolicy(id) { return this.options.profiles().get(id)?.retryPolicy; }
            async resolveModel(provider, model) { return { provider, id: model, name: model }; }
            async listModels(provider) { return this.options.profiles().get(provider)?.piProvider.getModels() ?? []; }
            async prepareCall(provider, model) {
              return { model: await this.resolveModel(provider, model), stream: callOptions => this.stream(callOptions) };
            }
            stream(callOptions) {
              const profile = this.options.profiles().get('enterprise');
              const resolveApiKey = this.options.resolveApiKey;
              return (async function* () {
                // The host asks for the key on every call: this is the call site
                // that reports a binding change before anything is sent.
                const key = await resolveApiKey();
                const model = profile.piProvider.getModels().find(candidate => candidate.id === callOptions.model);
                yield* profile.piProvider.stream(model, {}, {
                  ...callOptions, apiKey: key, ...(sendModelRequest ? { fetch: sendModelRequest } : {}),
                });
              })();
            }
          },
        };
      }
      if (specifier === '@earendil-works/pi-ai/api/openai-completions.lazy') {
        return {
          openAICompletionsApi: () => ({
            async *stream(model, context, streamOptions) {
              if (sendModelRequest || beforeModelFetch) {
                beforeModelFetch?.();
                const response = await streamOptions.fetch(`${model.baseUrl}/chat/completions`, {
                  method: 'POST', headers: streamOptions.headers, signal: streamOptions.signal,
                });
                if (!response.ok) {
                  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ENTERPRISE_GATEWAY_REQUEST_REJECTED' } } };
                  return;
                }
              }
              yield* transport(streamOptions.apiKey, streamOptions);
            },
            streamSimple: (model, context, streamOptions) => transport(streamOptions.apiKey, streamOptions),
          }),
        };
      }
      throw new Error(`unexpected import: ${specifier}`);
    },
  };
  const createAdapter = async adapterOptions => {
    builds += 1;
    if (failMovedAdapter && adapterOptions.config.managedModels.baseURL === MOVED_GATEWAY) throw new TypeError();
    if (native) {
      return createNativeGatewayAdapter({ ...adapterOptions, host: { ...adapterOptions.host, loader: nativeLoader } });
    }
    const { resolveKey, resolveIamToken } = adapterOptions;
    const dispatch = async function* (callOptions = {}) {
      attempts += 1;
      // The host asks for the key while building the request: a failure here
      // means nothing was sent, which is what makes the retry safe.
      const key = await resolveKey();
      if (typeof resolveIamToken === 'function') await resolveIamToken();
      yield* transport(key, callOptions);
    };
    return {
      providerInfo: id => ({ id, name: '企业模型' }),
      providerRetryPolicy: () => undefined,
      resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
      prepareCall: async (provider, model) => ({ model: { provider, id: model, name: model }, stream: callOptions => dispatch(callOptions) }),
      stream: callOptions => dispatch(callOptions),
    };
  };
  const runtime = createManagedModelRuntime({
    host, iam, config: { defaultProvider: 'enterprise', managedModels: { baseURL: GATEWAY } },
    createAdapter, logFailure, diagnoseFailure,
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
    get discover() { return discover; }, get credential() { return credential; }, get lastSignal() { return lastSignal; },
    setConnection(next) { connection = { ...connection, ...next }; },
    setCredential(next) { view = { ...view, gatewayCredential: { ...view.gatewayCredential, ...next } }; },
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
const expiredAccess = () => ({ state: 'expired', renewal: 'available', accessExpiresAt: new Date(Date.now() - 10).toISOString() });
const until = async (condition, label, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await tick();
  }
};

for (const entry of ['prepareCall', 'stream']) test(`${entry} renews an expired session before using the same route`, async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const refresh = Promise.withResolvers();
  let renewals = 0;
  const session = {
    assertCurrent() {},
    async renew() {
      renewals += 1;
      await refresh.promise;
      f.change({ state: 'ready', accessExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    },
  };
  f.iam.captureModelSession = () => session;
  f.change(expiredAccess());
  const work = (async () => {
    const stream = entry === 'prepareCall' ? (await f.adapter.prepareCall(options.provider, options.model)).stream : f.adapter.stream;
    return chunks(stream(options));
  })();
  await tick();
  assert.equal(f.requests, 0, 'no model request may leave while IAM is renewing');
  refresh.resolve();
  const result = await work;
  assert.equal(renewals, 1);
  assert.equal(finishOf(result).kind, 'stop');
  assert.equal(f.requests, 1);
});

test('a call is not dispatched when its session changes during preflight', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const release = Promise.withResolvers();
  const started = Promise.withResolvers();
  let changed = false;
  f.iam.captureModelSession = () => ({
    assertCurrent() { if (changed) throw new IamError('IAM_NOT_SIGNED_IN', 'synthetic session replacement'); },
    async renew() { started.resolve(); await release.promise; },
  });
  f.change(expiredAccess());
  const result = chunks(f.adapter.stream(options));
  await started.promise;
  changed = true;
  f.change({ state: 'ready', accessExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  release.resolve();
  assert.equal(failureOf(await result), 'IAM_LOGIN_REQUIRED');
  assert.equal(f.requests, 0);
});

test('an expired session without a refresh window cannot use an installed route', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  let renewals = 0;
  f.iam.captureModelSession = () => ({ assertCurrent() {}, renew() { renewals += 1; } });
  f.change({ ...expiredAccess(), renewal: 'unavailable' });
  assert.equal(failureOf(await chunks(f.adapter.stream(options))), 'IAM_LOGIN_REQUIRED');
  assert.equal(renewals, 0);
  assert.equal(f.requests, 0);
});

for (const outcome of ['cancelled', 'timed out', 'unreachable']) test(`preflight ${outcome} never dispatches a model request`, async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refresh = Promise.withResolvers();
  const started = Promise.withResolvers();
  f.iam.captureModelSession = () => ({
    assertCurrent() {},
    async renew() { started.resolve(); await refresh.promise; },
  });
  f.change(expiredAccess());
  const controller = new AbortController();
  const pending = chunks(f.guard({ ...options, signal: controller.signal }, () => f.adapter.stream(options)));
  await started.promise;
  if (outcome === 'cancelled') controller.abort();
  else if (outcome === 'timed out') t.mock.timers.tick(5000);
  else refresh.reject(new IamError('IAM_UNREACHABLE', 'synthetic outage'));
  const result = await pending;
  if (outcome === 'cancelled') assert.equal(finishOf(result).kind, 'aborted');
  else assert.equal(failureOf(result), 'ENTERPRISE_IAM_UNAVAILABLE');

  // A shared rotation can succeed after this waiter has left. It cannot send
  // the old call or block someone from starting a later one.
  refresh.resolve();
  f.change({ state: 'ready', accessExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  await tick();
  assert.equal(f.requests, 0);
  assert.equal(finishOf(await chunks(f.adapter.stream(options))).kind, 'stop');
  assert.equal(f.requests, 1);
});

for (const source of ['deadline timer', 'expired view']) test(`an already dispatched stream still stops at the ${source} without renewal or replay`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  let renewals = 0;
  f.iam.captureModelSession = () => ({ assertCurrent() {}, renew() { renewals += 1; } });
  f.change({ renewal: 'available' });
  const release = f.holdChunks();
  t.after(() => release.resolve());
  const stream = f.adapter.stream(options)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.type, 'text-delta');
  const pending = stream.next();
  if (source === 'deadline timer') t.mock.timers.tick(60_001);
  else {
    f.change(expiredAccess());
    assert.deepEqual(await f.adapter.listModels(options.provider), []);
  }
  assert.equal(f.lastSignal.aborted, true);
  assert.equal((await pending).value.reason.failure.code, 'IAM_LOGIN_REQUIRED');
  assert.equal((await stream.next()).done, true);
  assert.equal(renewals, 0);
  assert.equal(f.requests, 1);
});

test('a stale prepared call cannot use a replacement login for the same subject', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  let login = 1;
  f.iam.captureModelSession = () => {
    const captured = login;
    return {
      assertCurrent() { if (login !== captured) throw new IamError('IAM_NOT_SIGNED_IN', 'synthetic replacement login'); },
      renew() { assert.fail('a stale prepared call cannot renew on behalf of the next login'); },
    };
  };
  const prepared = await f.adapter.prepareCall(options.provider, options.model);
  login += 1;
  assert.equal(failureOf(await chunks(prepared.stream(options))), 'IAM_LOGIN_REQUIRED');
  assert.equal(f.requests, 0);
});

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

test('re-saving the key does not interrupt an answer already in progress', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const release = f.holdChunks();
  const stream = f.adapter.stream(options);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.text, 'first');
  // Same address, same person, new key write: the catalogue is rebuilt in the
  // background, but the transport of the answer already in flight survives.
  f.setCredential({ generation: 'gen-2', enteredAt: new Date().toISOString() });
  f.setConnection({ key: 'key-2', generation: 'gen-2' });
  f.change({});
  await tick();
  release.resolve();
  const rest = [];
  for (let step = await iterator.next(); !step.done; step = await iterator.next()) rest.push(step.value);
  assert.equal(finishOf(rest).kind, 'stop', 'a Key save must not cut the answer');
  assert.equal(f.lastSignal?.aborted, false, 'the in-flight transport keeps its signal');
  assert.equal(f.requests, 1);
});

test('the native adapter retries exactly once after the binding moves before dispatch', async t => {
  // Greptile P2: the recovery must be proven through the adapter the host really
  // installs, not only through the stand-in used by the other cases.
  const f = fixture({ native: true });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  // The call was prepared against gateway A; the connection moves to B before
  // dispatch, so the adapter's own per-call key resolution fails first.
  f.setConnection({ baseURL: MOVED_GATEWAY, key: 'key-2', generation: 'gen-2' });
  const result = await chunks(f.adapter.stream(options));
  assert.equal(finishOf(result).kind, 'stop');
  assert.equal(f.builds, 2, 'one rebuild bound to the new address');
  assert.equal(f.requests, 1, 'exactly one model request reaches the gateway');
  assert.equal(f.credential, 'key-2');
  assert.equal(failureOf(result), undefined);
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

test('a successful directory cannot replay a call on an adapter that failed to initialize', async t => {
  const f = fixture({ failMovedAdapter: true });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  f.setConnection({ baseURL: MOVED_GATEWAY });
  const result = await chunks(f.adapter.stream(options));
  assert.equal(f.runtime.getView().state, 'ready');
  assert.equal(f.runtime.getView().error, null);
  assert.equal(failureOf(result), 'ENTERPRISE_MODELS_UNAVAILABLE');
  assert.equal(f.attempts, 1);
  assert.equal(f.requests, 0);
});

test('a saved manual model can be retried on the new gateway while its directory is pending', async t => {
  const f = fixture({ native: true, manual: [{ id: options.model }] });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const buildsAtStart = f.builds;
  const hold = f.holdNextDiscovery();
  t.after(() => hold.resolve());
  f.setConnection({ baseURL: MOVED_GATEWAY, key: 'key-2', generation: 'gen-2' });
  f.failMovedGateway();

  const pending = chunks(f.adapter.stream(options));
  await until(() => f.builds > buildsAtStart, 'manual adapter for the new gateway');
  await tick();
  assert.equal(f.requests, 1, 'dispatch does not wait for the new directory');
  assert.equal(finishOf(await pending).kind, 'stop');
  assert.equal(f.credential, 'key-2');

  const sync = assert.rejects(f.runtime.refresh(), { code: 'ENTERPRISE_GATEWAY_UNAVAILABLE' });
  hold.resolve();
  await sync;
  assert.equal(f.runtime.getView().error, 'ENTERPRISE_GATEWAY_UNAVAILABLE');
  assert.equal(finishOf(await chunks(f.adapter.stream(options))).kind, 'stop');
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

test('a transport that reports the binding change as a finish chunk is not retried', async t => {
  const f = fixture({ finishFailureCode: 'IAM_GATEWAY_BINDING_CHANGED' });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.adapter.stream(options));
  assert.equal(failureOf(result), 'IAM_MODEL_CONTEXT_CHANGED');
  assert.equal(f.attempts, 1, 'the retry budget only covers the thrown path');
  assert.equal(f.requests, 0);
});

// --- service layer: the key no longer waits on a token refresh -------------

async function sessionFixture(t, { accessOffsetMs = 600_000, refreshOffsetMs = 3_600_000, tokenOutage = false, beforeJwks } = {}) {
  const subject = 'E1001';
  const oidc = await startMockOidc({ accessTtl: 600, subject });
  t.after(() => oidc.close());
  const atomic = createAtomicGatewayFixture();
  let credentials = atomic.credentials;
  const start = Date.now();
  let clock = start;
  oidc.refreshTokens.set('refresh-a', { subject });
  const store = createGrantStore(credentials);
  const grant = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer,
    subject, clientId: oidc.clientId, refreshToken: 'refresh-a', accessToken: 'access-a', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + accessOffsetMs).toISOString(),
    refreshExpiresAt: new Date(clock + refreshOffsetMs).toISOString(),
  };
  await store.write(grant);
  seedGateway(atomic.credentials, {
    value: 'uag-synthetic-key', baseURL: GATEWAY, ownerSubject: subject, issuer: oidc.endpoints.issuer,
    deviceLabel: 'synthetic', enteredAt: new Date(clock).toISOString(),
  });
  const openService = async () => {
    const service = createIamService({
      ...oidc.endpoints, clientId: oidc.clientId, redirectUri: 'http://127.0.0.1:4567/iam/callback',
    }, {
      credentials: atomic.credentials,
      getCredentials: () => credentials,
      ...atomic.options,
      verifyAtomicStore: candidate => candidate === atomic.credentials,
      now: () => clock,
      monotonic: () => clock - start,
      fetch: async (url, init) => {
        // A preflight failure happens before any refresh claim.
        if (String(url).endsWith('/jwks')) {
          if (tokenOutage) throw new Error('synthetic preflight outage');
          if (beforeJwks) await beforeJwks();
        }
        return fetch(url, init);
      },
    });
    t.after(() => service.dispose());
    await service.hydrate();
    return service;
  };
  const service = await openService();
  return { service, oidc, store, grant, credentials: atomic.credentials, key: 'uag-synthetic-key',
    openService,
    advance(ms, { notify = true } = {}) {
      clock += ms;
      if (notify) return service.notifyView();
    },
    replaceProvider(next) { credentials = next; },
  };
}

async function modelRuntimeFor(t, service, { beforeModelFetch } = {}) {
  await service.saveModelSelection({ models: { [options.model]: {} }, defaultModelId: options.model });
  const posts = [];
  const { adapter, runtime, guard } = fixture({
    iamOverride: service, native: true, beforeModelFetch,
    async sendModelRequest(url, init) {
      posts.push({ url, method: init.method, token: new Headers(init.headers).get('X-IAM-Token') });
      return new Response('synthetic response');
    },
  });
  t.after(() => runtime.dispose());
  await runtime.ready;
  assert.deepEqual((await adapter.listModels(options.provider)).map(model => model.id), [options.model]);
  return { adapter, posts, guard, runtime };
}

function holdNextGrantRead(t, credentials) {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const read = credentials.readRecord.bind(credentials);
  let hold = true;
  credentials.readRecord = async key => {
    const record = await read(key);
    if (key === GRANT_KEY && hold) {
      hold = false;
      started.resolve();
      await release.promise;
    }
    return record;
  };
  return { started: started.promise, release: release.resolve };
}

for (const [scenario, holdGrantRead, refreshAvailable, guarded] of [
  ['before fetch', false, true, false],
  ['during the dispatch grant read', true, true, false],
  ['during the dispatch grant read through the Host guard', true, true, true],
  ['during the dispatch grant read without a refresh window', true, false, false],
]) {
  test(`a model call crosses its access expiry ${scenario}`, { timeout: 6000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const accessOffsetMs = 240_000;
    const f = await sessionFixture(t, { accessOffsetMs, refreshOffsetMs: refreshAvailable ? 3_600_000 : accessOffsetMs });
    const expireAccess = () => {
      // Simulate the wall clock crossing the deadline before the Host's timer fires.
      t.mock.timers.setTime(Date.parse(f.grant.accessExpiresAt) + 1);
      f.advance(accessOffsetMs + 1, { notify: false });
    };
    const readStarted = Promise.withResolvers();
    let fetchEntered = false;
    const { adapter, posts, guard, runtime } = await modelRuntimeFor(t, f.service, {
      beforeModelFetch() {
        if (fetchEntered) return;
        fetchEntered = true;
        if (holdGrantRead) readStarted.resolve(holdNextGrantRead(t, f.credentials));
        else expireAccess();
      },
    });
    assert.equal(f.service.getView().state, 'ready');

    const prepared = guarded ? await adapter.prepareCall(options.provider, options.model) : null;
    const call = chunks(prepared ? guard(options, next => prepared.stream(next)) : adapter.stream(options));
    if (holdGrantRead) {
      const read = await readStarted.promise;
      await read.started;
      assert.deepEqual(posts, []);
      assert.equal(f.oidc.counts.refresh, 0);
      expireAccess();
      if (guarded) assert.equal(runtime.getView().error, 'IAM_LOGIN_REQUIRED');
      read.release();
    }

    const finish = finishOf(await call);
    assert.equal(fetchEntered, true, 'the native SDK must reach the dispatch fetch');
    assert.deepEqual({ kind: finish.kind, code: finish.failure?.code, refreshes: f.oidc.counts.refresh, posts: posts.length }, refreshAvailable
      ? { kind: 'stop', code: undefined, refreshes: 1, posts: 1 }
      : { kind: 'error', code: 'IAM_LOGIN_REQUIRED', refreshes: 0, posts: 0 });
    if (refreshAvailable) {
      const { grant: complete } = await f.store.read();
      assert.equal(complete.sessionInstanceId, f.grant.sessionInstanceId);
      assert.notEqual(complete.accessToken, f.grant.accessToken);
      assert.deepEqual(posts, [{ url: `${GATEWAY}/chat/completions`, method: 'POST', token: complete.accessToken }]);
    }
  });
}

for (const [name, priorPost] of [
  ['a verified connection failure leaves the retry eligible for dispatch renewal', false],
  ['a verified connection failure after an image rejection preserves the earlier dispatch', true],
]) {
  test(name, { timeout: 6000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const accessOffsetMs = 240_000;
    const f = await sessionFixture(t, { accessOffsetMs });
    await f.service.saveModelSelection({ models: { [options.model]: {} }, defaultModelId: options.model });
    const endpoint = `${GATEWAY}/chat/completions`;
    const fetch = globalThis.fetch;
    const posts = [];
    const retryAttempt = priorPost ? 3 : 2;
    let attempts = 0;
    let transportCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (url !== endpoint) return fetch(url, init);
      if (++transportCalls === retryAttempt - 1) {
        const refused = Object.assign(new Error('synthetic connection refusal'), { code: 'ECONNREFUSED', syscall: 'connect' });
        throw new TypeError('synthetic fetch failed', { cause: refused });
      }
      posts.push({ method: init.method, token: new Headers(init.headers).get('X-IAM-Token') });
      const rejectedImage = priorPost && transportCalls === 1;
      return new Response('synthetic response', { status: rejectedImage ? 400 : 200 });
    });
    const { adapter, guard, runtime } = fixture({
      iamOverride: f.service, native: true,
      beforeModelFetch() {
        if (++attempts !== retryAttempt) return;
        t.mock.timers.setTime(Date.parse(f.grant.accessExpiresAt) + 1);
        f.advance(accessOffsetMs + 1, { notify: false });
      },
    });
    t.after(() => runtime.dispose());
    await runtime.ready;
    const request = priorPost ? { ...options, messages: [{ role: 'user', content: [{ type: 'image' }] }] } : options;
    const prepared = await adapter.prepareCall(request.provider, request.model);
    const finish = finishOf(await chunks(guard(request, next => prepared.stream(next))));

    assert.equal(attempts, retryAttempt, 'the known unsent failure must reach the SDK retry');
    assert.deepEqual({ kind: finish.kind, code: finish.failure?.code, refreshes: f.oidc.counts.refresh, transportCalls }, priorPost
      ? { kind: 'error', code: 'IAM_LOGIN_REQUIRED', refreshes: 0, transportCalls: 2 }
      : { kind: 'stop', code: undefined, refreshes: 1, transportCalls: 2 });
    const { grant: complete } = await f.store.read();
    assert.equal(complete.sessionInstanceId, f.grant.sessionInstanceId);
    assert.equal(complete.accessToken === f.grant.accessToken, priorPost);
    assert.deepEqual(posts, [{ method: 'POST', token: complete.accessToken }]);
  });
}

for (const [outcome, expected] of [
  ['the renewal budget is exhausted', 'ENTERPRISE_IAM_UNAVAILABLE'],
  ['the caller cancels', 'aborted'],
  ['the session signs out', 'IAM_LOGIN_REQUIRED'],
  ['the gateway key changes', 'IAM_MODEL_CONTEXT_CHANGED'],
]) {
  test(`local dispatch renewal cannot send after ${outcome}`, { timeout: 6000 }, async t => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const f = await sessionFixture(t, {
      accessOffsetMs: 240_000,
      async beforeJwks() {
        started.resolve();
        await release.promise;
      },
    });
    let observedExpiry = false;
    const { adapter, posts, guard, runtime } = await modelRuntimeFor(t, f.service, {
      beforeModelFetch() {
        if (observedExpiry) return;
        observedExpiry = true;
        t.mock.timers.setTime(Date.parse(f.grant.accessExpiresAt) + 1);
        f.advance(240_001, { notify: false });
        runtime.getView();
      },
    });
    const controller = new AbortController();
    const call = chunks(guard({ ...options, signal: controller.signal }, next => adapter.stream(next)));
    await started.promise;
    if (expected === 'ENTERPRISE_IAM_UNAVAILABLE') {
      t.mock.timers.tick(5000);
      assert.equal(failureOf(await call), expected, 'the timeout must be reported before the issuer replies');
    } else if (expected === 'aborted') {
      controller.abort();
      assert.equal(finishOf(await call).kind, expected);
    } else if (expected === 'IAM_LOGIN_REQUIRED') {
      const signedOut = f.service.signOut();
      release.resolve();
      await signedOut;
    } else {
      await f.service.saveGatewayCredential({ key: 'another-synthetic-key' });
    }
    release.resolve();
    const finish = finishOf(await call);
    assert.equal(finish.failure?.code ?? finish.kind, expected);
    assert.deepEqual(posts, []);
    await tick();
    assert.deepEqual(posts, []);
  });
}

test('a model call adopts a local rotation while its first grant read is stalled', { timeout: 6000 }, async t => {
  const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
  const { adapter, posts } = await modelRuntimeFor(t, f.service);
  assert.equal(f.advance(240_001).state, 'expired');
  const read = holdNextGrantRead(t, f.credentials);
  const call = chunks(adapter.stream(options));
  await read.started;
  await f.service.captureModelSession().renew();
  const { grant: complete } = await f.store.read();
  assert.equal(complete.refreshOperation.state, 'complete');
  assert.equal(complete.sessionInstanceId, f.grant.sessionInstanceId);
  assert.notEqual(complete.accessToken, f.grant.accessToken);
  await until(() => posts.length > 0, 'model POST using the completed rotation');
  assert.equal(finishOf(await call).kind, 'stop');
  assert.deepEqual(posts, [{ url: `${GATEWAY}/chat/completions`, method: 'POST', token: complete.accessToken }]);
  read.release();
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(f.oidc.counts.refresh, 1);
});

test('a model call reads another Host’s completed rotation before its stalled read times out', { timeout: 6000 }, async t => {
  const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
  const peer = await f.openService();
  const { adapter, posts } = await modelRuntimeFor(t, f.service);
  assert.equal(f.advance(240_001).state, 'expired');
  assert.equal(peer.notifyView().state, 'expired');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const read = holdNextGrantRead(t, f.credentials);
  const call = chunks(adapter.stream(options));
  await read.started;
  await peer.captureModelSession().renew();
  const { grant: complete } = await f.store.read();
  assert.equal(complete.refreshOperation.state, 'complete');
  assert.equal(f.service.getView().state, 'expired');

  t.mock.timers.tick(4000);
  await until(() => posts.length === 1, 'model POST using the other Host’s completed rotation');
  assert.equal(finishOf(await call).kind, 'stop');
  assert.deepEqual(posts, [{ url: `${GATEWAY}/chat/completions`, method: 'POST', token: complete.accessToken }]);
  read.release();
  await tick();
  assert.equal(f.oidc.counts.refresh, 1);
  assert.equal(posts.length, 1);
});

test('a model call sends a valid access token while renewal is stalled before claim', { timeout: 6000 }, async t => {
  const jwksStarted = Promise.withResolvers();
  const releaseJwks = Promise.withResolvers();
  const f = await sessionFixture(t, { accessOffsetMs: 240_000, async beforeJwks() {
    jwksStarted.resolve();
    await releaseJwks.promise;
  } });
  const { adapter, posts } = await modelRuntimeFor(t, f.service);
  assert.equal(f.advance(195_000).state, 'ready');
  const refresh = f.service.getAccessToken();
  try {
    await jwksStarted.promise;
    assert.equal((await f.store.read()).grant.refreshOperation, undefined);
    const call = chunks(adapter.stream(options));
    await until(() => posts.length > 0, 'model POST during JWKS preflight');
    assert.equal(finishOf(await call).kind, 'stop');
    assert.deepEqual(posts, [{ url: `${GATEWAY}/chat/completions`, method: 'POST', token: f.grant.accessToken }]);
    assert.equal(f.oidc.counts.refresh, 0);
  } finally {
    releaseJwks.resolve();
    await refresh;
  }
  assert.equal(posts.length, 1);
  assert.equal(f.oidc.counts.refresh, 1);
});

for (const outcome of ['after the cutoff', 'after cancellation']) {
  test(`a local rotation ${outcome} cannot dispatch an old model call`, { timeout: 6000 }, async t => {
    const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
    const { adapter, posts } = await modelRuntimeFor(t, f.service);
    assert.equal(f.advance(240_001).state, 'expired');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const read = holdNextGrantRead(t, f.credentials);
    const controller = new AbortController();
    const call = chunks(adapter.stream({ ...options, signal: controller.signal }));
    await read.started;
    if (outcome === 'after the cutoff') t.mock.timers.tick(5000);
    else controller.abort();
    // The independent rotation may still complete while the original read is held.
    await f.service.captureModelSession().renew();
    assert.equal((await f.store.read()).grant.refreshOperation.state, 'complete');
    const result = await call;
    if (outcome === 'after the cutoff') assert.equal(failureOf(result), 'ENTERPRISE_IAM_UNAVAILABLE');
    else assert.equal(finishOf(result).kind, 'aborted');
    read.release();
    await tick();
    assert.deepEqual(posts, []);
    assert.equal(f.oidc.counts.refresh, 1);
  });
}

for (const outcome of ['sign-out', 'a replacement login']) {
  test(`a stalled model preflight cannot dispatch after ${outcome}`, { timeout: 6000 }, async t => {
    const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
    const { adapter, posts } = await modelRuntimeFor(t, f.service);
    assert.equal(f.advance(240_001).state, 'expired');
    const read = holdNextGrantRead(t, f.credentials);
    const call = chunks(adapter.stream(options));
    await read.started;
    if (outcome === 'sign-out') {
      await f.service.signOut();
      assert.equal(f.service.getView().state, 'signed-out');
    } else {
      await f.store.write({
        ...f.grant, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url'), accessToken: 'replacement-access',
        accessExpiresAt: new Date(Date.parse(f.grant.accessExpiresAt) + 60_000).toISOString(),
      });
      assert.equal((await f.service.syncFromStore()).state, 'ready');
    }
    read.release();
    assert.equal(failureOf(await call), 'IAM_LOGIN_REQUIRED');
    assert.deepEqual(posts, []);
    assert.equal(f.oidc.counts.refresh, 0);
  });
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

test('a still-valid access token keeps the key resolvable after its refresh token expired', async t => {
  // The two factors decay independently: with access valid, the request can be
  // served as-is even though renewing the session is no longer possible.
  const f = await sessionFixture(t, { accessOffsetMs: 600_000, refreshOffsetMs: -1_000 });
  const connection = await f.service.resolveGatewayConnection();
  assert.equal(connection.key, f.key);
  assert.equal(f.oidc.counts.refresh, 0, 'a valid access token needs no refresh');
});

test('a session with both factors expired is not a usable session', async t => {
  const f = await sessionFixture(t, { accessOffsetMs: -1_000, refreshOffsetMs: -1_000 });
  await assert.rejects(f.service.resolveGatewayConnection(), { code: 'IAM_NOT_SIGNED_IN' });
});

test('concurrent model preflights share the same token rotation', async t => {
  const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
  const first = f.service.captureModelSession();
  const second = f.service.captureModelSession();
  assert.equal(f.advance(240_001).state, 'expired');
  await Promise.all([first.renew(), second.renew(), f.service.getAccessToken()]);
  assert.equal(f.oidc.counts.refresh, 1);
  assert.equal(f.service.getView().state, 'ready');
  assert.doesNotThrow(() => first.assertCurrent());
  assert.doesNotThrow(() => second.assertCurrent());
});

for (const outcome of ['new snapshot', 'old snapshot', 'replaced login', 'withdrawn provider', 'sign-out']) {
  test(`delayed model preflight after a successful renewal: ${outcome}`, { timeout: 5000 }, async t => {
    const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
    const slowSession = f.service.captureModelSession();
    const fastSession = f.service.captureModelSession();
    assert.equal(f.advance(240_001).state, 'expired');
    const readStarted = Promise.withResolvers();
    const releaseRead = Promise.withResolvers();
    t.after(() => releaseRead.resolve());
    const read = f.credentials.readRecord.bind(f.credentials);
    let holdFirst = true;
    f.credentials.readRecord = async key => {
      if (key !== GRANT_KEY || !holdFirst) return read(key);
      holdFirst = false;
      const old = outcome === 'new snapshot' ? null : await read(key);
      readStarted.resolve();
      await releaseRead.promise;
      return old ?? read(key);
    };
    const slow = slowSession.renew().then(() => 'ready', cause => cause.code);
    await readStarted.promise;
    await fastSession.renew();
    const result = (await f.store.read()).grant;
    assert.equal(result.refreshOperation.state, 'complete');
    assert.equal(f.service.getView().state, 'ready');
    let expected = 'ready';
    if (outcome === 'replaced login') {
      await f.store.write({ ...result, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url') });
      expected = 'IAM_NOT_SIGNED_IN';
    } else if (outcome === 'withdrawn provider') {
      f.replaceProvider(new MemoryCredentials());
      expected = 'IAM_CREDENTIALS_UNAVAILABLE';
    } else if (outcome === 'sign-out') {
      await f.service.signOut();
      expected = 'IAM_NOT_SIGNED_IN';
    }
    releaseRead.resolve();
    assert.equal(await slow, expected);
    assert.equal(f.oidc.counts.refresh, 1, 'the slow caller must never mint a second token');
  });
}

test('dispatch uses a newer durable token for the same login without adopting a different session', async t => {
  const f = await sessionFixture(t);
  const handle = f.service.captureModelSession();
  const complete = {
    ...f.grant, accessToken: 'rotated-access', refreshToken: 'rotated-refresh',
    refreshOperation: { version: 1, state: 'complete', id: f.grant.sessionInstanceId, base: refreshBaseId(f.grant, f.grant.sessionInstanceId) },
  };
  await f.store.write(complete);
  assert.equal(await handle.withDispatchAccessToken(token => token), 'rotated-access');
  await f.store.write({ ...complete, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url') });
  await assert.rejects(handle.withDispatchAccessToken(() => assert.fail('replacement login cannot dispatch')), { code: 'IAM_NOT_SIGNED_IN' });
  assert.equal(f.oidc.counts.refresh, 0);
});

test('a slow ordinary token read cannot restore the previous deadline after dispatch adopts a rotation', { timeout: 5000 }, async t => {
  const f = await sessionFixture(t);
  const session = f.service.captureModelSession();
  const readStarted = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  t.after(() => releaseRead.resolve());
  const read = f.credentials.readRecord.bind(f.credentials);
  let holdFirst = true;
  f.credentials.readRecord = async key => {
    const record = await read(key);
    if (key === GRANT_KEY && holdFirst) {
      holdFirst = false;
      readStarted.resolve();
      await releaseRead.promise;
    }
    return record;
  };
  const tokenRead = f.service.getAccessToken();
  await readStarted.promise;
  const id = f.grant.sessionInstanceId;
  const complete = {
    ...f.grant, accessToken: 'rotated-access', refreshToken: 'rotated-refresh',
    accessExpiresAt: new Date(Date.parse(f.grant.accessExpiresAt) + 100_000).toISOString(),
    refreshOperation: { version: 1, state: 'complete', id, base: refreshBaseId(f.grant, id) },
  };
  await f.store.write(complete);
  assert.equal(await session.withDispatchAccessToken(token => token), complete.accessToken);
  releaseRead.resolve();
  assert.equal(await tokenRead, complete.accessToken);
  assert.equal(f.service.getView().accessExpiresAt, complete.accessExpiresAt);
  assert.equal(f.oidc.counts.refresh, 0);
});

test('dispatch cannot use a token while a persisted refresh is pending', async t => {
  const f = await sessionFixture(t);
  const handle = f.service.captureModelSession();
  await f.store.write({ ...f.grant, refreshOperation: {
    version: 1, state: 'pending', id: f.grant.sessionInstanceId, base: f.grant.sessionInstanceId,
  } });
  await assert.rejects(handle.withDispatchAccessToken(() => assert.fail('pending refresh cannot dispatch')), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(f.oidc.counts.refresh, 0);
});

test('a model preflight cannot renew a different login for the same subject', async t => {
  const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
  const handle = f.service.captureModelSession();
  assert.equal(f.advance(240_001).state, 'expired');
  await f.store.write({ ...f.grant, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url') });
  await assert.rejects(handle.renew(), { code: 'IAM_NOT_SIGNED_IN' });
  assert.equal(f.oidc.counts.refresh, 0);
});

test('a model preflight bound to a withdrawn provider fails closed', async t => {
  const f = await sessionFixture(t, { accessOffsetMs: 240_000 });
  const handle = f.service.captureModelSession();
  assert.equal(f.advance(240_001).state, 'expired');
  f.replaceProvider(new MemoryCredentials());
  await assert.rejects(handle.renew(), { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
  assert.equal(f.oidc.counts.refresh, 0);
});


test('nested stream wrappers record a failure once without exposing its upstream message', async t => {
  const events = [];
  const f = fixture({ tokenFailure: 'IAM_UNREACHABLE', diagnoseFailure: value => events.push(value) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.guard(options, () => f.adapter.stream(options)));
  assert.equal(failureOf(result), 'ENTERPRISE_IAM_UNAVAILABLE');
  assert.equal(events.length, 1);
  assert.equal(events[0].detailCode, 'IAM_UNREACHABLE');
  assert.equal(events[0].stage, 'unknown');
  assert.doesNotMatch(JSON.stringify(events), /synthetic token failure/);
});

test('local refusal is recorded before dispatch and a diagnostic exception is harmless', async t => {
  const events = [];
  const f = fixture({ diagnoseFailure: value => { events.push(value); throw Error('disk unavailable'); } });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.adapter.stream({ ...options, model: 'disabled-model' }));
  assert.equal(failureOf(result), 'ENTERPRISE_MODEL_NOT_ALLOWED');
  assert.equal(f.requests, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'local');
});


test('preparation rejection records one local diagnostic', async t => {
  const events = [];
  const f = fixture({ diagnoseFailure: event => events.push(event) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  await assert.rejects(f.adapter.prepareCall('enterprise', 'disabled-model'), { code: 'ENTERPRISE_MODEL_NOT_ALLOWED' });
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'local');
  assert.equal(f.requests, 0);
});

test('downstream finish failures remain mapped and have unknown dispatch state', async t => {
  const events = [];
  const f = fixture({ finishFailureCode: 'AUTH', diagnoseFailure: event => events.push(event) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.adapter.stream(options));
  assert.equal(failureOf(result), 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED');
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'unknown');
});


test('model resolution rejection is recorded locally', async t => {
  const events = [];
  const f = fixture({ diagnoseFailure: event => events.push(event) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  await assert.rejects(f.adapter.resolveModel('enterprise', 'disabled-model'), { code: 'ENTERPRISE_MODEL_NOT_ALLOWED' });
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'local');
});


test('a real failure from the runtime reaches the on-disk diagnostic', async t => {
  const home = mkdtempSync(join(tmpdir(), 'forge-runtime-log-'));
  const f = fixture({ tokenFailure: 'IAM_UNREACHABLE', diagnoseFailure: createModelFailureLogger({ home }) });
  t.after(async () => { await f.runtime.dispose(); rmSync(home, { recursive: true, force: true }); });
  await f.runtime.ready;
  await chunks(f.guard(options, () => f.adapter.stream(options)));
  const rows = readFileSync(join(home, 'logs', 'forge-iam-model-failures.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1);
  const event = JSON.parse(rows[0]);
  assert.equal(event.detailCode, 'IAM_UNREACHABLE');
  assert.equal(event.code, 'ENTERPRISE_IAM_UNAVAILABLE');
  assert.equal(event.stage, 'unknown');
  assert.doesNotMatch(rows[0], /synthetic token failure|person-a|key-1/);
});


test('an unknown upstream code keeps the host warning without exposing its value', async t => {
  const logged = [];
  const f = fixture({ finishFailureCode: 'private-upstream-value', logFailure: (...args) => logged.push(args) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(failureOf(await chunks(f.adapter.stream(options))), 'ENTERPRISE_GATEWAY_CALL_FAILED');
  assert.deepEqual(logged, [['UNRECOGNIZED', 'ENTERPRISE_GATEWAY_CALL_FAILED']]);
});

for (const scenario of [
  { name: 'sign-out', next: { state: 'signed_out', principal: null }, code: 'IAM_LOGIN_REQUIRED' },
  { name: 'credential removal', next: { gatewayCredential: { state: 'unconfigured', matchesAccount: false } }, code: 'IAM_GATEWAY_CREDENTIAL_REQUIRED' },
]) {
  test(`nested stream logs one failure after ${scenario.name}`, async t => {
    const events = [];
    const f = fixture({ diagnoseFailure: event => events.push(event) });
    t.after(() => f.runtime.dispose());
    await f.runtime.ready;
    const hold = f.holdChunks();
    const stream = f.guard(options, () => f.adapter.stream(options))[Symbol.asyncIterator]();
    const first = await stream.next();
    assert.equal(first.value.type, 'text-delta');
    f.change(scenario.next);
    hold.resolve();
    const last = await stream.next();
    assert.equal(last.value.reason.failure.code, scenario.code);
    assert.equal((await stream.next()).done, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].code, scenario.code);
  });
}

test('a regular downstream chunk is not emitted after sign-out', async t => {
  const events = [];
  const f = fixture({ diagnoseFailure: event => events.push(event) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const stream = f.guard(options, () => (async function* () {
    yield { type: 'text-delta', text: 'before' };
    f.change({ state: 'signed_out', principal: null });
    yield { type: 'text-delta', text: 'must-not-escape' };
  })());
  const result = await chunks(stream);
  assert.equal(result[0].text, 'before');
  assert.equal(failureOf(result), 'IAM_LOGIN_REQUIRED');
  assert.equal(result.some(chunk => chunk.text === 'must-not-escape'), false);
  assert.equal(events.length, 1);
});

test('authorization change after an inner failure still controls the visible error', async t => {
  const events = [];
  const f = fixture({ tokenFailure: 'IAM_UNREACHABLE', diagnoseFailure: event => events.push(event) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const stream = f.guard(options, () => (async function* () {
    for await (const chunk of f.adapter.stream(options)) {
      f.change({ state: 'signed_out', principal: null });
      yield chunk;
    }
  })());
  const result = await chunks(stream);
  assert.equal(failureOf(result), 'IAM_LOGIN_REQUIRED');
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'ENTERPRISE_IAM_UNAVAILABLE');
});

test('nested streams record a gateway credential revocation once', async t => {
  const events = [];
  const f = fixture({ finishFailureCode: 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED', diagnoseFailure: event => events.push(event) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const result = await chunks(f.guard(options, () => f.adapter.stream(options)));
  assert.equal(failureOf(result), 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
});
