import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedModelRuntime, validateManagedModels } from '../src/managed-models.mjs';

const configuration = { baseURL: 'https://gateway.corp.example/v1' };
function fixture(overrides = {}) {
  let view = { state: 'ready', principal: 'person-a', accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
    gatewayCredential: { state: 'configured', matchesAccount: true } };
  const listeners = new Set();
  const iam = {
    getView: () => structuredClone(view),
    async resolveGatewayConnection() { return { baseURL: configuration.baseURL, key: 'synthetic-only', generation: 'one' }; },
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
  const events = []; let adapter; let guard; let calls = 0; let credential;
  const host = { llm: { registerAdapter(routes, value) { adapter = value; return () => events.push('dispose'); } },
    on(name, callback) { assert.equal(name, 'llm/stream'); guard = callback; return () => {}; },
    emit(name) { events.push(name); } };
  const backend = {
    providerInfo: id => ({ id, name: '企业模型' }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_p, _m, i) => i,
    async resolveModel(provider, model) { return { provider, id: model, name: model }; },
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: o => this.stream(o) }; },
    async *stream(options) { calls++; credential = await options.resolveKey(); yield { type: 'text', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; },
  };
  const runtime = createManagedModelRuntime({ host, iam, config: { defaultProvider: 'enterprise', managedModels: configuration },
    fetch: async (url, init) => {
      assert.equal(url, configuration.baseURL + '/models');
      assert.equal(init.headers.authorization, 'Bearer synthetic-only');
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] }));
    },
    requestHeaders: async () => ({}),
    ...overrides,
    createAdapter: overrides.createAdapter ?? (async ({ resolveKey }) => new Proxy(backend, { get(target, key) {
      if (key === 'stream') return options => target.stream({ ...options, resolveKey });
      if (key === 'prepareCall') return async (provider, model) => ({ model: await target.resolveModel(provider, model), stream: options => target.stream({ ...options, resolveKey }) });
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } })) });
  return { iam, runtime, events, get adapter() { return adapter; }, get guard() { return guard; }, get calls() { return calls; }, get credential() { return credential; },
    change(next) { view = { ...view, ...next }; for (const listener of [...listeners]) listener(); } };
}
const chunks = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
const options = { provider: 'enterprise', model: 'enterprise-chat', messages: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('managed gateway configuration rejects public HTTP, embedded credentials and static catalogues', () => {
  assert.equal(validateManagedModels(configuration).issues, undefined);
  for (const candidate of [ { ...configuration, baseURL: 'http://gateway.corp.example/v1' },
    { ...configuration, baseURL: credentialURL() },
    { ...configuration, apiKey: 'synthetic' }, { ...configuration, models: [{ id: 'same' }, { id: 'same' }] } ]) {
    assert.ok(validateManagedModels(candidate).issues);
  }
  assert.ok(validateManagedModels({ ...configuration, baseURL: 'http://127.0.0.1:8000/v1' }).issues);
  assert.ok(validateManagedModels({ ...configuration, baseURL: 'http://127.0.0.1:8000/v1' }, true).value);
});

test('login advertises approved models; request takes account credential, not a standalone key', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
  assert.deepEqual((await f.adapter.listModels('enterprise')).map(m => m.id), ['enterprise-chat']);
  const prepared = await f.adapter.prepareCall(options.provider, options.model);
  const result = await chunks(prepared.stream(options));
  assert.equal(result[0].text, 'ok'); assert.equal(f.calls, 1); assert.equal(f.credential, 'synthetic-only');
});

test('logout hides models and denies prepared calls with login message without invoking transport', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
  const prepared = await f.adapter.prepareCall(options.provider, options.model);
  f.change({ state: 'signed-out', principal: null }); await tick();
  assert.deepEqual(await f.adapter.listModels('enterprise'), []);
  const result = await chunks(prepared.stream(options));
  assert.equal(result.at(-1).reason.failure.code, 'IAM_LOGIN_REQUIRED');
  assert.match(result.at(-1).reason.failure.message, /重新登录/);
  assert.equal(f.calls, 0); assert.ok(f.events.includes('llm/adapters-updated'));
});

test('all-route waterfall refuses standalone providers and unknown enterprise model IDs', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
  for (const request of [{ ...options, provider: 'standalone' }, { ...options, model: 'unapproved' }]) {
    const result = await chunks(f.guard(request, () => { throw new Error('must not dispatch'); }));
    assert.equal(result.at(-1).reason.failure.code, 'ENTERPRISE_MODEL_NOT_ALLOWED');
  }
});

test('expiry, credential removal and account replacement invalidate captured calls', async t => {
  for (const next of [{ accessExpiresAt: Date.now() - 1 }, { gatewayCredential: { state: 'unconfigured' } }, { principal: 'person-b' }]) {
    const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
    const prepared = await f.adapter.prepareCall(options.provider, options.model);
    f.change(next); await tick();
    const result = await chunks(prepared.stream(options));
    assert.equal(result.at(-1).reason.kind, 'error'); assert.equal(f.calls, 0);
  }
});

test('signed-out discovery makes no network request and returns a sign-in error', async t => {
  let requests = 0;
  const f = fixture({ fetch: async () => { requests++; return new Response('{"data":[]}'); } });
  t.after(() => f.runtime.dispose());
  f.change({ state: 'signed-out', principal: null }); await f.runtime.ready;
  await assert.rejects(f.runtime.refresh(), { code: 'IAM_LOGIN_REQUIRED' });
  assert.equal(requests, 0);
});

test('a discovery response arriving after logout cannot repopulate the catalogue', async t => {
  const pending = Promise.withResolvers(); const entered = Promise.withResolvers();
  const f = fixture({ fetch: async () => { entered.resolve(); return pending.promise; } });
  t.after(() => f.runtime.dispose()); await entered.promise;
  f.change({ state: 'signed-out', principal: null });
  pending.resolve(new Response('{"data":[{"id":"enterprise-chat"}]}')); await f.runtime.ready;
  assert.deepEqual(await f.adapter.listModels('enterprise'), []);
  assert.deepEqual(f.runtime.getView().models, []);
});

test('model-list errors are classified without returning gateway response bodies', async t => {
  for (const [status, body, code] of [[401, 'private-body', 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED'],
    [403, 'private-body', 'ENTERPRISE_GATEWAY_FORBIDDEN'],
    [200, '{"data":[{"id":"same"},{"id":"same"}]}', 'ENTERPRISE_MODEL_CATALOG_INVALID'],
    [200, 'not-json-private-body', 'ENTERPRISE_MODEL_CATALOG_INVALID']]) {
    const f = fixture({ fetch: async () => new Response(body, { status }) });
    t.after(() => f.runtime.dispose()); await f.runtime.ready;
    assert.equal(f.runtime.getView().error, code);
    assert.equal(JSON.stringify(f.runtime.getView()).includes('private-body'), false);
    assert.deepEqual(await f.adapter.listModels('enterprise'), []);
  }
});

test('logout aborts a live transport and prevents a late chunk from being delivered', async t => {
  let requestSignal;
  const entered = Promise.withResolvers();
  const f = fixture({ createAdapter: async () => ({
    async *stream(options) {
      requestSignal = options.signal; yield { type: 'text-delta', text: 'first' }; entered.resolve();
      await new Promise(resolve => requestSignal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'text-delta', text: 'must-not-deliver' };
    },
  }) });
  t.after(() => f.runtime.dispose()); await f.runtime.ready;
  const iterator = f.adapter.stream(options)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.text, 'first');
  const pending = iterator.next(); await entered.promise;
  f.change({ state: 'signed-out', principal: null });
  const result = await pending;
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.value.reason.failure.code, 'IAM_LOGIN_REQUIRED');
  await iterator.return();
});

test('a refreshed session reloads the standard catalogue and can make a new call', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
  f.change({ accessExpiresAt: new Date(Date.now() + 120000).toISOString() }); await tick();
  await f.runtime.refresh();
  assert.equal((await f.adapter.listModels('enterprise')).length, 1);
  assert.equal((await chunks(f.adapter.stream(options))).at(-1).reason.kind, 'stop');
});

test('transport authentication failure differs from IAM logout and does not replay', async t => {
  let dispatches = 0;
  const f = fixture({ createAdapter: async () => ({ async *stream() {
    dispatches++; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'private-body' } } };
  } }) });
  t.after(() => f.runtime.dispose()); await f.runtime.ready;
  const result = await chunks(f.adapter.stream(options));
  assert.equal(result.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED');
  assert.equal(JSON.stringify(result).includes('private-body'), false); assert.equal(dispatches, 1);
});

function credentialURL() {
  const url = new URL('https://gateway.corp.example/v1');
  url.username = 'synthetic-user'; url.password = 'synthetic-password';
  return url.href;
}

test('missing Host adapter capability closes the model surface without breaking account availability', async () => {
  const runtime = createManagedModelRuntime({ host: {}, iam: {}, config: {} });
  await runtime.ready;
  assert.deepEqual(runtime.getView().models, []);
  await assert.rejects(runtime.refresh(), { code: 'ENTERPRISE_MODELS_UNAVAILABLE' });
  await runtime.dispose();
});


test('same-session token renewal preserves a prepared gateway call while updating its expiry', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
  const prepared = await f.adapter.prepareCall(options.provider, options.model);
  f.change({ accessExpiresAt: new Date(Date.now() + 120000).toISOString() }); await tick();
  assert.equal((await chunks(prepared.stream(options))).at(-1).reason.kind, 'stop');
  assert.equal(f.calls, 1);
});

test('fine-grained model options apply capacity and modality overrides to catalog and listModels', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal((await f.adapter.listModels('enterprise'))[0].inputModalities[0], 'text');

  await f.runtime.updateModelOptions({
    'enterprise-chat': {
      name: '定制企业大模型',
      contextWindow: '128K',
      maxTokens: '8K',
      inputModalities: ['text', 'image'],
      reasoningEfforts: { off: null, high: 'high' },
    },
  });

  const models = await f.adapter.listModels('enterprise');
  assert.equal(models[0].name, '定制企业大模型');
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);

  const view = f.runtime.getView();
  assert.equal(view.models[0].contextWindow, 128000);
  assert.equal(view.models[0].maxTokens, 8000);
  assert.equal(view.models[0].reasoning, true);
});
