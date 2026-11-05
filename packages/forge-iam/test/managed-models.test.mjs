import test from 'node:test';
import assert from 'node:assert/strict';
import { applyModelOptions, buildThinkingLevelMap, createManagedModelRuntime, createNativeGatewayAdapter, validateManagedModels } from '../src/managed-models.mjs';

const configuration = { baseURL: 'https://gateway.corp.example/v1' };
function fixture(overrides = {}) {
  let view = {
    state: 'ready', principal: 'person-a', accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
    gatewayCredential: { state: 'configured', matchesAccount: true }
  };
  const listeners = new Set();
  let selection = overrides.selection ?? null;
  const iam = {
    getView: () => structuredClone(view),
    async readModelSelection() {
      return selection
        ? { subject: 'person-a', saved: true, ...structuredClone(selection) }
        : { subject: 'person-a', saved: false, models: {}, defaultModelId: null };
    },
    async saveModelSelection(next) {
      selection = { models: structuredClone(next.models ?? {}), defaultModelId: next.defaultModelId ?? null };
      return { subject: 'person-a', ...structuredClone(selection) };
    },
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
  const host = {
    llm: { registerAdapter(routes, value) { adapter = value; return () => events.push('dispose'); } },
    on(name, callback) { assert.equal(name, 'llm/stream'); guard = callback; return () => { }; },
    emit(name) { events.push(name); }
  };
  const backend = {
    providerInfo: id => ({ id, name: '企业模型' }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, imageRequestTarget: (_p, _m, i) => i,
    async resolveModel(provider, model) { return { provider, id: model, name: model }; },
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: o => this.stream(o) }; },
    async *stream(options) { calls++; credential = await options.resolveKey(); yield { type: 'text', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; },
  };
  const runtime = createManagedModelRuntime({
    host, iam, config: { defaultProvider: 'enterprise', managedModels: configuration },
    fetch: async (url, init) => {
      assert.equal(url, configuration.baseURL + '/models');
      assert.equal(init.headers.authorization, 'Bearer synthetic-only');
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] }));
    },
    requestHeaders: async () => ({}),
    ...overrides,
    createAdapter: overrides.createAdapter ?? (async ({ resolveKey }) => new Proxy(backend, {
      get(target, key) {
        if (key === 'stream') return options => target.stream({ ...options, resolveKey });
        if (key === 'prepareCall') return async (provider, model) => ({ model: await target.resolveModel(provider, model), stream: options => target.stream({ ...options, resolveKey }) });
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      }
    }))
  });
  return {
    iam, runtime, events, get adapter() { return adapter; }, get guard() { return guard; }, get calls() { return calls; }, get credential() { return credential; },
    get selection() { return selection; },
    change(next) { view = { ...view, ...next }; for (const listener of [...listeners]) listener(); }
  };
}
const chunks = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
const options = { provider: 'enterprise', model: 'enterprise-chat', messages: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('managed gateway configuration permits HTTP/HTTPS and rejects embedded credentials and invalid fields', () => {
  assert.equal(validateManagedModels(configuration).issues, undefined);
  assert.equal(validateManagedModels({ ...configuration, baseURL: 'http://gateway.corp.example/v1' }).issues, undefined);
  assert.equal(validateManagedModels({ ...configuration, baseURL: 'http://127.0.0.1:8000/v1' }).issues, undefined);
  for (const candidate of [
    { ...configuration, baseURL: credentialURL() },
    { ...configuration, baseURL: 'ftp://gateway.corp.example/v1' },
    { ...configuration, apiKey: 'synthetic' },
    { ...configuration, models: [{ id: 'same' }, { id: 'same' }] },
  ]) {
    assert.ok(validateManagedModels(candidate).issues);
  }
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
  const f = fixture({
    createAdapter: async () => ({
      async *stream(options) {
        requestSignal = options.signal; yield { type: 'text-delta', text: 'first' }; entered.resolve();
        await new Promise(resolve => requestSignal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'text-delta', text: 'must-not-deliver' };
      },
    })
  });
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
  const f = fixture({
    createAdapter: async () => ({
      async *stream() {
        dispatches++; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'private-body' } } };
      }
    })
  });
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

  // Resetting options clears custom overrides and restores 200K/64K default capacities
  await f.runtime.updateModelOptions({});
  assert.equal(f.runtime.getView().models[0].contextWindow, 200000);
  assert.equal(f.runtime.getView().models[0].maxTokens, 64000);
  assert.equal(f.runtime.getView().models[0].reasoning, false);
});

test('providerRetryPolicy returns complete ResolvedNormalRetryPolicy with retryableCodes array', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const policy = f.adapter.providerRetryPolicy('enterprise');
  assert.equal(policy.mode, 'normal');
  assert.equal(policy.maxRetries, 0);
  assert.equal(Array.isArray(policy.retryableCodes), true);
  assert.equal(policy.retryableCodes.includes('RATE_LIMIT'), false);
  assert.equal(typeof policy.initialDelayMs, 'number');
  assert.equal(typeof policy.maxDelayMs, 'number');
  assert.equal(typeof policy.jitterRatio, 'number');
});

test('discovery sorts models stably by id and createNativeGatewayAdapter configures compat and thinkingLevelMap', async t => {
  const f = fixture({
    fetch: async () => new Response(JSON.stringify({
      data: [{ id: 'opencode-zen-2' }, { id: 'gpt-6-luna' }, { id: 'gemini-3.5-flash' }, { id: 'gpt-6-astra' }],
    })),
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  // The catalogue is ordered, but only the auto-enabled default is usable until
  // this person turns the others on.
  assert.deepEqual(
    (await f.adapter.listModels('enterprise')).map(m => m.id),
    ['gemini-3.5-flash'],
  );
  assert.equal(f.selection.defaultModelId, 'gemini-3.5-flash');
  const enabled = await f.runtime.updateModelOptions({
    'gemini-3.5-flash': {}, 'gpt-6-astra': {}, 'gpt-6-luna': {}, 'opencode-zen-2': {},
  });
  assert.deepEqual(enabled.enabled.sort(), ['gemini-3.5-flash', 'gpt-6-astra', 'gpt-6-luna', 'opencode-zen-2']);
  assert.deepEqual(
    (await f.adapter.listModels('enterprise')).map(m => m.id),
    ['gemini-3.5-flash', 'gpt-6-astra', 'gpt-6-luna', 'opencode-zen-2'],
  );

  let capturedOptions;
  const rawModels = [{ id: 'default-model', name: 'default-model', contextWindow: 200000, maxTokens: 64000, input: ['text'], inputModalities: ['text'] },
  { id: 'custom-model', name: 'custom-model', contextWindow: 200000, maxTokens: 64000, input: ['text'], inputModalities: ['text'] }];
  const overlaid = applyModelOptions(rawModels, {
    'custom-model': { maxTokens: '16K', reasoningEfforts: { off: null, high: 'high' } },
  });
  await createNativeGatewayAdapter({
    host: {
      loader: {
        async import(specifier) {
          if (specifier === '@deepseek-ai/dsh-llm-pi-ai') {
            return { PiAiAdapter: class { constructor(opts) { capturedOptions = opts; } } };
          }
          if (specifier === '@earendil-works/pi-ai/api/openai-completions.lazy') {
            return { openAICompletionsApi: () => ({ stream: () => { }, streamSimple: () => { } }) };
          }
          throw new Error(`unexpected import: ${specifier}`);
        },
      },
    },
    config: { defaultProvider: 'enterprise', managedModels: { baseURL: configuration.baseURL, models: overlaid } },
    resolveKey: async () => 'synthetic-only',
  });
  const profile = capturedOptions.profiles().get('enterprise');
  assert.equal(Array.isArray(profile.retryPolicy.retryableCodes), true);
  // Only custom-model has an explicit maxTokens override
  assert.equal(profile.configuredMaxTokens.has('default-model'), false);
  assert.equal(profile.configuredMaxTokens.get('custom-model'), 16000);
  const catalog = profile.piProvider.getModels();
  const customEntry = catalog.find(m => m.id === 'custom-model');
  assert.equal(customEntry.reasoning, true);
  assert.deepEqual(customEntry.thinkingLevelMap, buildThinkingLevelMap({ off: null, high: 'high' }));
  assert.equal(customEntry.thinkingLevelMap.low, null);
  assert.equal(customEntry.thinkingLevelMap.high, 'high');
  assert.equal(customEntry.compat.supportsStore, false);
  assert.equal(customEntry.compat.supportsDeveloperRole, false);
  assert.equal(customEntry.compat.maxTokensField, 'max_tokens');
});

test('first run enables and persists one catalogue model without any user input', async t => {
  const f = fixture({ fetch: async () => new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }] })) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  // Sorted catalogue order decides "first", not the response order.
  assert.deepEqual(f.selection, { models: { alpha: {} }, defaultModelId: 'alpha' });
  assert.deepEqual((await f.adapter.listModels('enterprise')).map(m => m.id), ['alpha']);
  const view = f.runtime.getView();
  assert.equal(view.defaultModelId, 'alpha');
  assert.deepEqual(view.models.filter(m => m.enabled).map(m => m.id), ['alpha']);
  assert.equal(view.models.find(m => m.id === 'zeta').enabled, false);
});

test('the configured default model wins while the gateway still advertises it', async t => {
  const f = fixture({
    config: { defaultProvider: 'enterprise', defaultModel: 'beta', managedModels: configuration },
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] })),
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.deepEqual(f.selection, { models: { beta: {} }, defaultModelId: 'beta' });
  assert.deepEqual((await f.adapter.listModels('enterprise')).map(m => m.id), ['beta']);
});

test('a discovered but unenabled model is refused by prepareCall, resolveModel and the stream guard', async t => {
  const f = fixture({ fetch: async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'zeta' }] })) });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  await assert.rejects(f.adapter.prepareCall('enterprise', 'zeta'), { code: 'ENTERPRISE_MODEL_NOT_ALLOWED' });
  await assert.rejects(f.adapter.resolveModel('enterprise', 'zeta'), { code: 'ENTERPRISE_MODEL_NOT_ALLOWED' });
  const streamed = await chunks(f.guard({ provider: 'enterprise', model: 'zeta', messages: [] }, async function* () { yield { type: 'text', text: 'leak' }; }));
  assert.equal(streamed[0].type, 'finish');
  assert.equal(streamed[0].reason.failure.code, 'ENTERPRISE_MODEL_NOT_ALLOWED');
  assert.equal(f.calls, 0);
  // The enabled default still works.
  const prepared = await f.adapter.prepareCall('enterprise', 'alpha');
  assert.equal((await chunks(prepared.stream({ ...options, model: 'alpha' })))[0].text, 'ok');
});

test('a stored selection is adopted on the next start instead of being re-defaulted', async t => {
  const f = fixture({
    selection: { models: { beta: { maxTokens: '8K' }, alpha: {} }, defaultModelId: 'beta' },
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }, { id: 'zeta' }] })),
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.deepEqual((await f.adapter.listModels('enterprise')).map(m => m.id), ['alpha', 'beta']);
  const view = f.runtime.getView();
  assert.deepEqual(view.enabled.sort(), ['alpha', 'beta']);
  assert.equal(view.models.find(m => m.id === 'beta').maxTokens, 8000);
  // Untouched by the start-up path: no rewrite, no extra id.
  assert.deepEqual(f.selection, { models: { beta: { maxTokens: '8K' }, alpha: {} }, defaultModelId: 'beta' });
});

test('an explicitly empty selection stays empty instead of re-enabling a default', async t => {
  const f = fixture({
    selection: { models: {}, defaultModelId: null },
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }] })),
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.deepEqual(await f.adapter.listModels('enterprise'), []);
  await assert.rejects(f.adapter.prepareCall('enterprise', 'alpha'), { code: 'ENTERPRISE_MODEL_NOT_ALLOWED' });
});

test('a stale or disabled defaultModelId is re-assigned to an enabled catalog model', async t => {
  const f = fixture({
    selection: { models: { beta: {} }, defaultModelId: 'ghost-model' },
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] })),
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(f.runtime.getView().defaultModelId, 'beta');
});

test('syncDefaultModel explicitly triggers default alignment and safeGet retrieves host property', async t => {
  let alignedTarget = null;
  const agentDefaultModel = {
    currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-chat' }),
    saveSelection: async ({ provider, model }) => { alignedTarget = `${provider}:${model}`; },
  };
  const host = {
    agentDefaultModel,
    llm: {
      registerAdapter() { return () => {}; },
      listProviders: () => [{ id: 'enterprise', name: '企业模型' }],
      listModels: async () => [{ provider: 'enterprise', id: 'alpha', name: 'alpha' }],
    },
    on(name, cb) { return () => {}; },
    emit() {},
  };
  const f = fixture({
    host,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }] })),
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(typeof f.runtime.syncDefaultModel, 'function');
  await f.runtime.syncDefaultModel();
  assert.equal(alignedTarget, 'enterprise:alpha');
});

test('a new model selection epoch keeps the active gateway usable for new calls', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
  f.iam.getModelAccessEpoch = () => 'new-selection';
  const prepared = await f.adapter.prepareCall(options.provider, options.model);
  const result = await chunks(prepared.stream(options));
  assert.equal(result[0].text, 'ok');
});
