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
  let selectionGeneration = 0;
  const iam = {
    getView: () => structuredClone(view),
    async readModelSelection() {
      return selection
        ? { subject: 'person-a', saved: true, ...structuredClone(selection) }
        : { subject: 'person-a', saved: false, models: {}, defaultModelId: null };
    },
    async saveModelSelection(next) {
      selectionGeneration += 1;
      selection = { models: structuredClone(next.models ?? {}), defaultModelId: next.defaultModelId ?? null };
      return { subject: 'person-a', ...structuredClone(selection) };
    },
    getModelAccessEpoch: () => String(selectionGeneration),
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

test('managed gateway configuration keeps plain HTTP on loopback and needs an opt-in elsewhere', () => {
  assert.equal(validateManagedModels(configuration).issues, undefined);
  assert.ok(validateManagedModels({ ...configuration, baseURL: 'http://gateway.corp.example/v1' }).issues);
  assert.equal(validateManagedModels({ ...configuration, baseURL: 'http://gateway.corp.example/v1' }, true).issues, undefined);
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
  [429, 'private-body', 'ENTERPRISE_GATEWAY_RATE_LIMIT'],
  [400, 'private-body', 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'],
  [404, 'private-body', 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'],
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

test('a revoked credential is remembered and never replayed', async t => {
  let dispatches = 0; let fetches = 0;
  const f = fixture({
    fetch: async () => { fetches++; return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] })); },
    createAdapter: async () => ({
      async *stream() {
        dispatches++;
        yield { type: 'finish', reason: { kind: 'error', failure: { status: 401, responseBody: JSON.stringify({ error: { code: 'credential_revoked' } }) } } };
      }
    })
  });
  t.after(() => f.runtime.dispose()); await f.runtime.ready;
  const first = await chunks(f.adapter.stream(options));
  assert.equal(first.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
  const second = await chunks(f.adapter.stream(options));
  assert.equal(second.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
  assert.equal(dispatches, 1);
  const fetched = fetches;
  await f.runtime.refresh().catch(() => { }); await tick();
  assert.equal(fetches, fetched);
  assert.equal(f.runtime.getView().error, 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED');
});

test('a rejected request is not reported as an unreachable gateway', async t => {
  // The status sits in a different place per SDK: plain `status`, an AI SDK
  // `statusCode`, a response object, or one level deeper after a transport retry.
  const shapes = status => [
    { status },
    { statusCode: status },
    { response: { status } },
    { cause: { statusCode: status } },
  ];
  for (const [status, code] of [[400, 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'], [404, 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'], [429, 'ENTERPRISE_GATEWAY_RATE_LIMIT'], [503, 'ENTERPRISE_GATEWAY_UNAVAILABLE']]) {
    for (const shape of shapes(status)) {
      const f = fixture({
        createAdapter: async () => ({
          async *stream() { throw Object.assign(new Error('private-body'), shape); }
        })
      });
      t.after(() => f.runtime.dispose()); await f.runtime.ready;
      const result = await chunks(f.adapter.stream(options));
      assert.equal(result.at(-1).reason.failure.code, code, JSON.stringify(shape));
      assert.equal(JSON.stringify(result).includes('private-body'), false);
    }
  }
});

test('a rate limit or exhausted quota reported as an error code is not reported as an unreachable gateway', async t => {
  for (const [thrownCode, code] of [['RATE_LIMIT', 'ENTERPRISE_GATEWAY_RATE_LIMIT'], ['QUOTA', 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED']]) {
    const f = fixture({
      createAdapter: async () => ({
        async *stream() { throw Object.assign(new Error('private-body'), { code: thrownCode }); }
      })
    });
    t.after(() => f.runtime.dispose()); await f.runtime.ready;
    const result = await chunks(f.adapter.stream(options));
    assert.equal(result.at(-1).reason.failure.code, code, thrownCode);
  }
});

test('an unrecognised failure is neither called unreachable nor rejected', async t => {
  // A gateway swap or SDK upgrade can introduce a code this build never saw.
  // Guessing "cannot connect" sent the user to check a network that was fine.
  for (const shape of [{}, { status: 'not-a-number' }, { cause: {} }, { code: 'SOMETHING_NEW' }, { code: 'UNKNOWN' }]) {
    const f = fixture({
      createAdapter: async () => ({
        async *stream() { throw Object.assign(new Error('private-body'), shape); }
      })
    });
    t.after(() => f.runtime.dispose()); await f.runtime.ready;
    const result = await chunks(f.adapter.stream(options));
    assert.equal(result.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_CALL_FAILED', JSON.stringify(shape));
  }
});

test('only evidence of unreachability is reported as an unreachable gateway', async t => {
  for (const shape of [
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    { code: 'NETWORK' },
    { code: 'TIMEOUT' },
    { code: 'SERVER_ERROR' },
    { statusCode: 503 },
  ]) {
    const f = fixture({
      createAdapter: async () => ({
        async *stream() { throw Object.assign(new Error('private-body'), shape); }
      })
    });
    t.after(() => f.runtime.dispose()); await f.runtime.ready;
    const result = await chunks(f.adapter.stream(options));
    assert.equal(result.at(-1).reason.failure.code, 'ENTERPRISE_GATEWAY_UNAVAILABLE', JSON.stringify(shape));
  }
});

test('a gateway error body decides the class when the code table cannot', async t => {
  // Shapes seen in the wild: OpenAI `error.code`, RFC 9457 `type`, LiteLLM
  // router cooldowns, and a body embedded in the error message.
  const cases = [
    [{ statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' }, 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED'],
    [{ statusCode: 429, responseBody: '{"error":{"type":"rate_limit_exceeded"}}' }, 'ENTERPRISE_GATEWAY_RATE_LIMIT'],
    [{ statusCode: 429, message: '429: {"code":"model_cooldown","last_upstream_error":"x"}' }, 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED'],
    [{ message: '400: {"error":{"code":"context_length_exceeded"}}' }, 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'],
    [{ responseBody: '{"type":"https://example.test/problems/quota-exceeded"}' }, 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED'],
    [{ code: 'SOMETHING_NEW', statusCode: 503 }, 'ENTERPRISE_GATEWAY_UNAVAILABLE'],
    [{ code: 'SOMETHING_NEW', responseBody: '{"error":{"code":"never_seen_before"}}' }, 'ENTERPRISE_GATEWAY_CALL_FAILED'],
  ];
  for (const [shape, code] of cases) {
    const f = fixture({
      createAdapter: async () => ({
        async *stream() { throw Object.assign(new Error('private-body'), shape); }
      })
    });
    t.after(() => f.runtime.dispose()); await f.runtime.ready;
    const result = await chunks(f.adapter.stream(options));
    assert.equal(result.at(-1).reason.failure.code, code, JSON.stringify(shape));
    assert.equal(JSON.stringify(result).includes('insufficient_quota'), false);
    assert.equal(JSON.stringify(result).includes('private-body'), false);
  }
});

test('a request the gateway rejects is not reported as an unreachable gateway', async t => {
  for (const [chunkCode, code] of [['INVALID_REQUEST', 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'], ['RATE_LIMIT', 'ENTERPRISE_GATEWAY_RATE_LIMIT'], ['QUOTA', 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED']]) {
    const f = fixture({
      createAdapter: async () => ({
        async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: chunkCode, message: 'private-body' } } }; }
      })
    });
    t.after(() => f.runtime.dispose()); await f.runtime.ready;
    const result = await chunks(f.adapter.stream(options));
    assert.equal(result.at(-1).reason.failure.code, code);
    assert.equal(JSON.stringify(result).includes('private-body'), false);
  }
});

test('an unsupported reasoning level names the level instead of the network', async t => {
  const f = fixture({
    createAdapter: async () => ({
      async *stream() { throw Object.assign(new Error('private-body'), { code: 'UNSUPPORTED_REASONING_EFFORT' }); }
    })
  });
  t.after(() => f.runtime.dispose()); await f.runtime.ready;
  const result = await chunks(f.adapter.stream(options));
  assert.equal(result.at(-1).reason.failure.code, 'ENTERPRISE_MODEL_REASONING_UNSUPPORTED');
  assert.equal(JSON.stringify(result).includes('private-body'), false);
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
  assert.equal(f.runtime.getView().models[0].reasoning, true);
  assert.deepEqual(f.runtime.getView().models[0].reasoningEfforts, { off: 'off', low: 'low', medium: 'medium', high: 'high' });
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
  // Heartbeats never become events, so the profile cannot rely on them to keep
  // a slow first token alive; the bound matches the host default.
  assert.equal(capturedOptions.profiles().get('enterprise').streamIdleTimeoutMs, 300000);
});

test('the native adapter injects the current IAM token at call time and keeps it out of the catalogue', async () => {
  let capturedOptions; let captured;
  const protocol = {
    stream: (model, context, options) => { captured = options; },
    streamSimple: (model, context, options) => { captured = options; },
  };
  let token = 'iam-token-1';
  await createNativeGatewayAdapter({
    host: {
      loader: {
        async import(specifier) {
          if (specifier === '@deepseek-ai/dsh-llm-pi-ai') {
            return { PiAiAdapter: class { constructor(opts) { capturedOptions = opts; } } };
          }
          if (specifier === '@earendil-works/pi-ai/api/openai-completions.lazy') {
            return { openAICompletionsApi: () => protocol };
          }
          throw new Error(`unexpected import: ${specifier}`);
        },
      },
    },
    config: {
      defaultProvider: 'enterprise',
      managedModels: {
        baseURL: 'https://gw.example/v1',
        models: applyModelOptions([{ id: 'm1', contextWindow: 200000, maxTokens: 64000, input: ['text'] }], {}),
      },
    },
    resolveKey: async () => 'synthetic-only',
    resolveIamToken: async () => token,
  });
  const profile = capturedOptions.profiles().get('enterprise');
  await capturedOptions.resolveApiKey('enterprise', profile);
  profile.piProvider.streamSimple('m1', {}, { headers: { 'x-base': '1' } });
  assert.equal(captured.headers['X-IAM-Token'], 'iam-token-1');
  assert.equal(captured.headers['X-Consumer-Type'], 'personal');
  assert.equal(captured.headers['x-base'], '1');
  assert.equal(captured.headers.Authorization, undefined);
  token = 'iam-token-2';
  await capturedOptions.resolveApiKey('enterprise', profile);
  profile.piProvider.stream('m1', {}, undefined);
  assert.equal(captured.headers['X-IAM-Token'], 'iam-token-2');
  assert.equal(captured.headers['X-Consumer-Type'], 'personal');
  assert.equal(JSON.stringify(profile.piProvider.getModels()).includes('iam-token'), false);
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

test('getView synchronously clears ghost ready state when session signs out or gateway credential is cleared', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.ready;
  assert.equal(f.runtime.getView().state, 'ready');
  assert.equal(f.runtime.getView().models.length, 1);

  // Synchronously mutate IAM view without waiting for async watch() microtask
  f.change({ state: 'signed-out', principal: null });
  const viewAfterSignOut = f.runtime.getView();
  assert.equal(viewAfterSignOut.state, 'unconfigured');
  assert.equal(viewAfterSignOut.error, null);
  assert.deepEqual(viewAfterSignOut.models, []);
  assert.deepEqual(viewAfterSignOut.enabled, []);
  assert.equal(viewAfterSignOut.defaultModelId, null);
});

test('catalogue transitions notify the plugin view channel, not only the SDK event', async t => {
  let changes = 0;
  const f = fixture({ onChange: () => { changes += 1; } });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  // A catalogue flip without an IAM transition must reach view subscribers,
  // and never more often than the change it describes.
  assert.ok(changes >= 1);
  assert.ok(changes <= f.events.filter(event => event === 'llm/adapters-updated').length);
  assert.equal(f.runtime.getView().state, 'ready');
});

test('the first-run default write does not abort the sync it belongs to', async t => {
  let discovery = 0;
  const f = fixture({ fetch: async () => { discovery += 1; return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] })); } });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(f.runtime.getView().state, 'ready');
  // The selection write bumps the access epoch; if the flight treated that as
  // foreign it would need a second discovery round and flash "error".
  assert.equal(discovery, 1);
  assert.deepEqual(f.runtime.getModelOptions(), { 'enterprise-chat': {} });
});

test('a repeated catalogue failure is published once, not once per refresh', async t => {
  let changes = 0; let discovery = 0;
  const f = fixture({
    fetch: async () => { discovery += 1; return new Response('{"error":"denied"}', { status: 401 }); },
    onChange: () => { changes += 1; },
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(f.runtime.getView().state, 'error');
  const published = changes;
  await f.runtime.refresh().catch(() => { });
  await f.runtime.refresh().catch(() => { });
  // Each frame this notification produced would re-enter the observer loop:
  // an unchanged failure must stay silent or one bad gateway spins forever.
  assert.equal(changes, published);
  assert.ok(discovery >= 3);
});

test('a transient failure keeps the last catalogue and advertises its retry', async t => {
  let offline = false;
  const f = fixture({
    fetch: async () => {
      if (offline) throw new Error('offline');
      return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] }));
    },
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const fresh = f.runtime.getView();
  assert.equal(fresh.state, 'ready');
  assert.equal(fresh.stale, false);
  assert.ok(Number.isFinite(fresh.syncedAt));

  offline = true;
  await f.runtime.refresh().catch(() => { });
  const stale = f.runtime.getView();
  assert.equal(stale.state, 'error');
  assert.equal(stale.stale, true);
  // The list survives: a blank panel is worse than a marked-stale one.
  assert.deepEqual(stale.models.map(model => model.id), ['enterprise-chat']);
  assert.ok(Number.isFinite(stale.retryAt));
});

test('an expired session keeps the catalogue for the same person and gateway', async t => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.deepEqual(f.runtime.getView().models.map(model => model.id), ['enterprise-chat']);
  f.change({ state: 'expired' });
  // Same person, same gateway: the display list is not erased by a lapsed token.
  assert.deepEqual(f.runtime.getView().models.map(model => model.id), ['enterprise-chat']);
  f.change({ state: 'signed-out', principal: null });
  assert.deepEqual(f.runtime.getView().models, []);
});

test('a catalogue refresh recovers after the token lapses on the same person', async t => {
  let discovery = 0;
  const f = fixture({
    // A real fetch rejects immediately on an already-aborted signal, before any
    // connection exists; the fixture must do the same or it hides the defect.
    fetch: async (url, init) => {
      if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
      discovery += 1;
      return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] }));
    },
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  // The panel stays open past the token's deadline: the runtime cancels this
  // identity's work and marks the session expired, without a new identity.
  f.change({ accessExpiresAt: new Date(Date.now() - 1000).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.runtime.getView().error, 'IAM_LOGIN_REQUIRED');
  const before = discovery;
  // The same person's session comes back with no identity change at all. The
  // cancellation must not outlive it: every later discovery used to abort at
  // 0 ms and read as an unreachable gateway.
  f.change({ accessExpiresAt: new Date(Date.now() + 60000).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 10));
  await f.runtime.refresh();
  const view = f.runtime.getView();
  assert.equal(view.state, 'ready');
  assert.equal(view.error, null);
  assert.deepEqual(view.models.map(model => model.id), ['enterprise-chat']);
  assert.ok(discovery > before);
});

test('a stale catalogue still retries and its countdown clears', async t => {
  let offline = false;
  const f = fixture({
    retryDelays: [5],
    fetch: async () => {
      if (offline) throw new Error('offline');
      return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] }));
    },
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  offline = true;
  await f.runtime.refresh().catch(() => { });
  const failed = f.runtime.getView();
  assert.equal(failed.error, 'ENTERPRISE_GATEWAY_UNAVAILABLE');
  assert.ok(Number.isFinite(failed.retryAt));
  offline = false;
  await new Promise(resolve => setTimeout(resolve, 60));
  const recovered = f.runtime.getView();
  // Keeping the last catalogue must not cancel the recovery of the list.
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.error, null);
  assert.equal(recovered.retryAt, null);
});

test('a cancelled discovery is reported as a cancelled sync, not an unreachable gateway', async t => {
  let failure = null;
  const f = fixture({
    retryDelays: [60000],
    fetch: async () => {
      if (failure) throw failure;
      return new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] }));
    },
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  failure = new DOMException('This operation was aborted', 'AbortError');
  await f.runtime.refresh().catch(() => { });
  const cancelled = f.runtime.getView();
  assert.equal(cancelled.error, 'ENTERPRISE_MODEL_SYNC_CANCELLED');
  // Retrying a request we cancelled ourselves repeats the cancellation.
  assert.equal(cancelled.retryAt, null);
  failure = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  await f.runtime.refresh().catch(() => { });
  const timedOut = f.runtime.getView();
  // A real timeout is still a retryable gateway failure and says so.
  assert.equal(timedOut.error, 'ENTERPRISE_GATEWAY_UNAVAILABLE');
  assert.ok(Number.isFinite(timedOut.retryAt));
});
