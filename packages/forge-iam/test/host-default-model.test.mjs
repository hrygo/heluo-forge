import test from 'node:test';
import assert from 'node:assert/strict';
import { alignHostDefaultModel, HOST_DEFAULT_RESULTS as R } from '../src/host-default-model.mjs';
import { createManagedModelRuntime } from '../src/managed-models.mjs';

function sdk({ selection, providers = [{ id: 'enterprise', name: '企业模型' }], models = {}, saveFails = false } = {}) {
  const saves = [];
  let current = selection;
  return {
    saves,
    service: {
      currentSelection: () => current,
      async saveSelection(next) { if (saveFails) throw new Error('editor down'); saves.push(next); current = next; },
    },
    llm: {
      listProviders: () => providers,
      async listModels(id) {
        const list = models[id];
        if (list instanceof Error) throw list;
        return (list ?? []).map(model => ({ provider: id, id: model }));
      },
    },
  };
}
const enabledSet = (...ids) => id => ids.includes(id);
const base = { provider: 'enterprise', target: 'alpha', enterpriseUsable: enabledSet('alpha', 'beta'), isCurrent: () => true };

test('a default pointing at a disabled official provider is replaced by the enterprise default', async () => {
  const s = sdk({ selection: { provider: 'deepseek-account', model: 'deepseek-chat' } });
  assert.equal(await alignHostDefaultModel({ ...base, ...s }), R.ALIGNED);
  // No reasoningEffort: the adapter applies the model's lower bound.
  assert.deepEqual(s.saves, [{ provider: 'enterprise', model: 'alpha' }]);
});

test('an enterprise default that was disabled is moved to the current enterprise default', async () => {
  const s = sdk({ selection: { provider: 'enterprise', model: 'zeta', reasoningEffort: 'high' } });
  assert.equal(await alignHostDefaultModel({ ...base, ...s }), R.ALIGNED);
  assert.deepEqual(s.saves, [{ provider: 'enterprise', model: 'alpha' }]);
});

test('a still-usable selection is never touched, enterprise or not', async () => {
  for (const selection of [
    { provider: 'enterprise', model: 'beta', reasoningEffort: 'max' },
    { provider: 'local', model: 'qwen' },
  ]) {
    const s = sdk({ selection, providers: [{ id: 'enterprise', name: 'e' }, { id: 'local', name: 'l' }], models: { local: ['qwen'] } });
    assert.equal(await alignHostDefaultModel({ ...base, ...s }), R.KEPT);
    assert.deepEqual(s.saves, []);
  }
});

test('a registered provider that no longer lists the model is provably unusable', async () => {
  const s = sdk({ selection: { provider: 'local', model: 'gone' }, providers: [{ id: 'local', name: 'l' }], models: { local: ['qwen'] } });
  assert.equal(await alignHostDefaultModel({ ...base, ...s }), R.ALIGNED);
});

test('unknown is not unusable: a failing listModels or unreadable selection preserves the setting', async () => {
  const failing = sdk({ selection: { provider: 'local', model: 'qwen' }, providers: [{ id: 'local', name: 'l' }], models: { local: new Error('timeout') } });
  assert.equal(await alignHostDefaultModel({ ...base, ...failing }), R.UNKNOWN);
  for (const selection of [undefined, null, { provider: 1 }, Promise.resolve({ provider: 'x', model: 'y' })]) {
    const s = sdk({ selection });
    assert.equal(await alignHostDefaultModel({ ...base, ...s }), R.UNKNOWN);
    assert.deepEqual(s.saves, []);
  }
});

test('no write without a usable target, without the SDK, or after the context changed', async () => {
  const s = sdk({ selection: { provider: 'deepseek-account', model: 'x' } });
  assert.equal(await alignHostDefaultModel({ ...base, ...s, target: null }), R.NO_TARGET);
  assert.equal(await alignHostDefaultModel({ ...base, ...s, target: 'zeta' }), R.NO_TARGET);
  assert.equal(await alignHostDefaultModel({ ...base, ...s, service: undefined }), R.UNSUPPORTED);
  assert.equal(await alignHostDefaultModel({ ...base, ...s, llm: {} }), R.UNSUPPORTED);
  assert.equal(await alignHostDefaultModel({ ...base, ...s, isCurrent: () => false }), R.STALE);
  assert.deepEqual(s.saves, []);
});

test('a failed save is reported once and never retried', async () => {
  const s = sdk({ selection: { provider: 'deepseek-account', model: 'x' }, saveFails: true });
  assert.equal(await alignHostDefaultModel({ ...base, ...s }), R.FAILED);
});

// --- Runtime integration: the first-login scenario end to end. ---

function runtimeFixture({ hostSelection, catalog = ['zeta', 'alpha'], fetch, retryDelays = [] } = {}) {
  let view = {
    state: 'ready', principal: 'person-a', accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
    gatewayCredential: { state: 'configured', matchesAccount: true },
  };
  const listeners = new Set();
  let stored = null;
  let hold = null;
  let adapter;
  const events = [];
  const s = sdk({ selection: hostSelection, providers: [{ id: 'enterprise', name: '企业模型' }] });
  const host = {
    llm: {
      registerAdapter(_routes, value) { adapter = value; return () => { }; },
      listProviders: () => [{ id: 'enterprise', name: '企业模型' }],
      listModels: route => adapter.listModels(route),
    },
    on() { return () => { }; },
    emit(name) { events.push(name); },
  };
  const iam = {
    getView: () => structuredClone(view),
    async readModelSelection() { return stored ? { saved: true, ...structuredClone(stored) } : { saved: false, models: {}, defaultModelId: null }; },
    async saveModelSelection(next) { if (hold) await hold; stored = structuredClone(next); },
    async resolveGatewayConnection() { return { baseURL: 'https://gateway.corp.example/v1', key: 'synthetic-only', generation: 'one' }; },
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
  const runtime = createManagedModelRuntime({
    host, iam, config: { defaultProvider: 'enterprise', managedModels: { baseURL: 'https://gateway.corp.example/v1' } },
    fetch: fetch ?? (async () => new Response(JSON.stringify({ data: catalog.map(id => ({ id })) }))),
    requestHeaders: async () => ({}),
    createAdapter: async () => ({ resolveModel: async (p, m) => ({ provider: p, id: m, name: m }), async *stream() { } }),
    getHostDefaultModel: () => s.service,
    retryDelays,
  });
  return {
    runtime, events, saves: s.saves, get stored() { return stored; },
    holdSaves() { let release; hold = new Promise(resolve => { release = resolve; }); return () => { hold = null; release(); }; },
    change(next) { view = { ...view, ...next }; for (const listener of [...listeners]) listener(); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('first login: the shipped official default is switched to the auto-enabled enterprise model', async t => {
  const f = runtimeFixture({ hostSelection: { provider: 'deepseek-account', model: 'deepseek-chat' } });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.deepEqual(f.saves, [{ provider: 'enterprise', model: 'alpha' }]);
  assert.equal(f.runtime.getView().hostDefaultModel, 'aligned');
  // The client catalogue reloads its default on this event.
  assert.ok(f.events.filter(e => e === 'llm/adapters-updated').length >= 2);
});

test('a person who already chose an enabled enterprise model keeps it across restarts', async t => {
  const f = runtimeFixture({ hostSelection: { provider: 'enterprise', model: 'alpha', reasoningEffort: 'high' } });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.deepEqual(f.saves, []);
  assert.equal(f.runtime.getView().hostDefaultModel, 'kept');
});

test('disabling the model new conversations use moves the default to a still-enabled one', async t => {
  const f = runtimeFixture({ hostSelection: { provider: 'deepseek-account', model: 'x' }, catalog: ['alpha', 'beta'] });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  await f.runtime.updateModelOptions({ alpha: {}, beta: {} });
  assert.deepEqual(f.saves, [{ provider: 'enterprise', model: 'alpha' }]);
  await f.runtime.updateModelOptions({ beta: {} });
  assert.deepEqual(f.saves.at(-1), { provider: 'enterprise', model: 'beta' });
});

test('a save that races a sign-out is refused instead of landing in the next state', async t => {
  const f = runtimeFixture({ hostSelection: { provider: 'enterprise', model: 'alpha' }, catalog: ['alpha', 'beta'] });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  const release = f.holdSaves();
  const pending = f.runtime.updateModelOptions({ alpha: {}, beta: {} });
  await tick();
  f.change({ state: 'signed-out', principal: null });
  release();
  await assert.rejects(pending, { code: 'IAM_MODEL_CONTEXT_CHANGED' });
  assert.equal(f.runtime.getView().state, 'unconfigured');
  assert.deepEqual(f.runtime.getView().enabled, []);
});

test('saves are serialised: the last submission wins', async t => {
  const f = runtimeFixture({ hostSelection: { provider: 'enterprise', model: 'alpha' }, catalog: ['alpha', 'beta'] });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  await Promise.all([f.runtime.updateModelOptions({ alpha: {}, beta: {} }), f.runtime.updateModelOptions({ beta: {} })]);
  assert.deepEqual(Object.keys(f.stored.models), ['beta']);
  assert.deepEqual(f.runtime.getView().enabled, ['beta']);
});

test('expiry clears the catalogue state together with the backend', async t => {
  const f = runtimeFixture({ hostSelection: { provider: 'enterprise', model: 'alpha' } });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(f.runtime.getView().state, 'ready');
  f.change({ accessExpiresAt: new Date(Date.now() - 1).toISOString() });
  await tick();
  const view = f.runtime.getView();
  assert.notEqual(view.state, 'ready');
  assert.deepEqual(view.models, []);
});

test('a transient gateway outage at start-up heals with bounded retries; a rejected credential does not retry', async t => {
  let calls = 0;
  const f = runtimeFixture({
    hostSelection: { provider: 'enterprise', model: 'alpha' }, retryDelays: [0, 0],
    fetch: async () => (++calls < 3 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ data: [{ id: 'alpha' }] }))),
  });
  t.after(() => f.runtime.dispose());
  await f.runtime.ready;
  assert.equal(f.runtime.getView().state, 'error');
  for (let i = 0; i < 20 && f.runtime.getView().state !== 'ready'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.runtime.getView().state, 'ready');
  assert.equal(calls, 3);

  let rejected = 0;
  const g = runtimeFixture({ retryDelays: [0, 0], fetch: async () => { rejected++; return new Response('', { status: 401 }); } });
  t.after(() => g.runtime.dispose());
  await g.runtime.ready;
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(rejected, 1);
  assert.equal(g.runtime.getView().error, 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED');
});
