import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelSelectionStore, MODEL_SELECTION_KEY } from '../src/store.mjs';
import { createModelSelection } from '../src/service-model-selection.mjs';
import { createServiceState } from '../src/service-state.mjs';
import { MAX_MANUAL_MODELS } from '../src/model-options.mjs';
import { createManagedModelRuntime } from '../src/managed-models.mjs';

function makeMemoryCredentials(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async unset(key) { map.delete(key); },
    async resolve(key) { return map.get(key) ?? null; },
    async listRecords() { return [...map.keys()]; },
    async delete(key) { map.delete(key); },
    async readRecord(key) { return map.get(key) ?? null; },
    async modifyRecord(key, fn) {
      const next = await fn(map.get(key) ?? null);
      if (next !== undefined) map.set(key, next);
      return next;
    },
    async deleteRecord(key) { map.delete(key); },
  };
}

test('store: parseModelSelection 兼容 version:1、清洗 manual 并回报 manualTruncated', async () => {
  const oversize = Array.from({ length: MAX_MANUAL_MODELS + 5 }, (_, i) => ({
    id: `manual-${i}`,
    addedAt: i === 0 ? 'not-iso' : '2026-11-13T00:00:00.000Z',
  }));
  const creds = makeMemoryCredentials({
    [MODEL_SELECTION_KEY]: {
      kind: 'grant',
      payload: {
        version: 1,
        type: 'heluo-iam-model-selection',
        subject: 'u-1',
        models: { 'manual-0': {} },
        defaultModelId: 'manual-0',
        manual: [
          { id: 'manual-0', addedAt: 'bad-date' },
          { id: 'manual-0', addedAt: '2026-11-13T01:00:00.000Z' },
          'bad-entry',
          { id: '' },
          ...oversize.slice(1),
        ],
      },
    },
  });
  const store = createModelSelectionStore(creds);
  const res = await store.read();
  assert.equal(res.ok, true);
  assert.equal(res.selection.manual.length, MAX_MANUAL_MODELS);
  assert.equal(res.selection.manualTruncated, 5);
  assert.equal(res.selection.manual[0].id, 'manual-0');
  assert.equal(res.selection.manual[0].addedAt, undefined);

  await assert.rejects(
    () => store.save({
      subject: 'u-1',
      models: {},
      manual: Array.from({ length: MAX_MANUAL_MODELS + 1 }, (_, i) => ({ id: `m-${i}` })),
    }),
    (err) => err.code === 'IAM_MODEL_SELECTION_INVALID',
  );
});

test('service-model-selection: 四个返回点均给出 manual 与 manualTruncated 默认值并透传保存', async () => {
  const creds = makeMemoryCredentials();
  const store = createModelSelectionStore(creds);
  const ctx = {
    disposed: false,
    state: 'ready',
    exclusive: { ok: true },
    lastGrant: { subject: 'u-1', accessToken: 'synthetic-access', accessExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    knownIssuer: () => 'https://iam.corp.example',
    assertExclusive() {},
  };
  const sessionTarget = {
    async read() { return { ok: true, grant: ctx.lastGrant }; },
  };
  let targetPresent = false;
  const provider = {
    storeCredentials: creds,
    gatewayEpoch: 1,
    ensure: () => (targetPresent ? sessionTarget : null),
    atomicBinding: () => creds,
    get modelSelectionStore() { return store; },
  };
  const grants = { assertGrantContext() {}, ownerOf: () => sessionTarget, async prepareAuthentication() {} };
  const ms = createModelSelection({
    config: { defaultModel: '', defaultProvider: 'enterprise' },
    options: {},
    ctx,
    provider,
    grants,
    now: () => Date.now(),
    getAuthEpoch: () => 1,
    isSigningOut: () => false,
    getLoadGateway: async () => ({ state: 'configured', matchesAccount: true }),
  });

  // 1) owner() null
  assert.deepEqual(await ms.readSelection(), { subject: null, saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 });

  // 2) no target
  targetPresent = true;
  provider.storeCredentials = {};
  assert.deepEqual(await ms.readSelection(), { subject: 'u-1', saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 });

  // 3) record absent
  provider.storeCredentials = creds;
  assert.deepEqual(await ms.readSelection(), { subject: 'u-1', saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 });

  // 4) saved & read back
  await ms.captureSettings().saveSelection({ models: { 'm-a': {} }, defaultModelId: 'm-a', manual: [{ id: 'm-a' }] });
  const loaded = await ms.readSelection();
  assert.equal(loaded.saved, true);
  assert.deepEqual(loaded.manual, [{ id: 'm-a' }]);
  assert.equal(loaded.manualTruncated, 0);
});

test('service-state: 不可恢复或网关未就绪时 modelAccess.manualTruncated === 0 且 models === []', () => {
  const ss = createServiceState({
    config: { issuer: 'https://iam.corp.example', clientId: 'c1', defaultProvider: 'enterprise', defaultModel: '' },
    options: {
      getManagedModelRuntime: () => ({
        getView: () => ({
          managed: true,
          state: 'ready',
          models: [{ id: 'm-1' }],
          manualTruncated: 3,
        }),
      }),
    },
    configured: true,
    now: () => Date.now(),
    monotonic: () => 0,
    getGatewaySummary: () => ({ state: 'unconfigured', matchesAccount: false }),
    getMetadataIssuer: () => 'https://iam.corp.example',
    scheduleReconcile: () => {},
    scheduleRenewal: () => {},
    clearPendingObservation: () => {},
    onFailReset: () => {},
  });
  const view = ss.view();
  assert.deepEqual(view.modelAccess.models, []);
  assert.equal(view.modelAccess.manualTruncated, 0);
});

function makeRuntime({ gatewayModels = [], savedRecord: initialRecord, catalogStatus = 200, readThrows = false, iam: injectedIam } = {}) {
  const state = {
    adapterBuilds: 0,
    savedRecord: initialRecord ?? { subject: 'u-1', saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 },
    gatewayModels: [...gatewayModels],
    failWrites: false,
    saveCalls: 0,
    selectionReads: 0,
  };
  const currentView = {
    state: 'ready',
    principal: { subject: 'u-1' },
    accessExpiresAt: Date.now() + 60_000,
    gatewayCredential: { state: 'configured', matchesAccount: true },
  };

  const runtime = createManagedModelRuntime({
    config: { defaultProvider: 'enterprise', defaultModel: '' },
    host: {
      emit() {},
      on: () => () => {},
      llm: { registerAdapter: () => () => {} },
      loader: {
        async import(spec) {
          if (spec === '@deepseek-ai/dsh-llm-pi-ai') {
            return {
              PiAiAdapter: class {
                constructor() {
                  state.adapterBuilds += 1;
                }
                async resolveModel(route, id) {
                  return { provider: route, id, name: id };
                }
              },
            };
          }
          if (spec === '@earendil-works/pi-ai/api/openai-completions.lazy') {
            return { openAICompletionsApi: () => ({ stream: () => {}, streamSimple: () => {} }) };
          }
          throw new Error(`unexpected import ${spec}`);
        },
      },
    },
    iam: injectedIam ?? {
      getView: () => currentView,
      async *watch() {},
      async resolveGatewayConnection() {
        return { baseURL: 'https://gw.corp.example/v1', key: 'k-1', subject: 'u-1' };
      },
      async readModelSelection() {
        state.selectionReads += 1;
        if (readThrows) throw Object.assign(new Error('synthetic read failure'), { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
        return state.savedRecord;
      },
      async saveModelSelection(next) {
        state.saveCalls += 1;
        if (state.failWrites) throw new Error('synthetic write failure');
        state.savedRecord = {
          subject: 'u-1',
          saved: true,
          models: next.models,
          defaultModelId: next.defaultModelId,
          manual: next.manual,
          manualTruncated: 0,
        };
      },
    },
    // 注意参数名是 `fetch`：写 `fetcher` 会被忽略，发现请求就走真网络并静默失败。
    fetch: async () => (catalogStatus === 200
      ? {
        ok: true,
        status: 200,
        // discover() 先读 text 再按字节上限解析，不接受 response.json()。
        async text() { return JSON.stringify({ data: state.gatewayModels.map(id => ({ id })) }); },
      }
      // 失败响应不读 body：discover() 只按状态码映射错误码。
      : { ok: false, status: catalogStatus, async text() { return 'gateway rejected'; } }),
    // 目录发现走宿主归因头；夹具不装宿主 llm 包，直接给空头。
    requestHeaders: async () => ({}),
  });
  return { runtime, state };
}

test('managed-models: adding a manual model records it without enabling it', async () => {
  const { runtime, state } = makeRuntime();
  await runtime.ready;
  assert.equal(runtime.getView().models.length, 0);

  // 空目录首次添加手动模型：登记进目录，但不启用、不抢 Host 默认（Gate B §9.1 第 4 项）。
  const added = await runtime.updateManualModel({ action: 'add', id: 'custom-deepseek-r1' });
  assert.equal(added.ok, true);
  assert.equal(added.defaultModelId, null, '添加手动模型不得自动启用或抢占 Host 默认');
  assert.deepEqual(added.enabled, []);
  assert.equal(added.models[0].source, 'manual');
  assert.ok(state.adapterBuilds >= 1, '空目录首次添加手动模型也必须构建 adapter');
  assert.equal(runtime.getView().stale, false);
  // 启用集没有被写入：持久化的 models 里没有这条记录。
  assert.deepEqual(state.savedRecord.models, {});
  assert.equal(state.savedRecord.defaultModelId, null);

  // 重复添加拒绝
  await assert.rejects(
    () => runtime.updateManualModel({ action: 'add', id: 'custom-deepseek-r1' }),
    (err) => err.code === 'IAM_MANUAL_MODEL_CONFLICT',
  );

  // 启用是独立动作：只有在显式提交启用集之后才进入默认与可选列表。
  const enabled = await runtime.updateModelOptions({ 'custom-deepseek-r1': {} });
  assert.equal(enabled.defaultModelId, 'custom-deepseek-r1');
  assert.deepEqual(enabled.enabled, ['custom-deepseek-r1']);

  // 删除手动模型
  const removed = await runtime.updateManualModel({ action: 'remove', id: 'custom-deepseek-r1' });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.manual, []);
  assert.equal(removed.models.length, 0);
  assert.equal(removed.defaultModelId, null);

  await runtime.dispose();
});

test('managed-models: a manual record shadowed by the catalogue stays removable', async () => {
  const { runtime, state } = makeRuntime({
    gatewayModels: ['custom-deepseek-r1'],
    savedRecord: {
      subject: 'u-1',
      saved: true,
      models: { 'custom-deepseek-r1': {} },
      defaultModelId: 'custom-deepseek-r1',
      manual: [{ id: 'custom-deepseek-r1' }],
      manualTruncated: 0,
    },
  });
  await runtime.ready;
  // 网关优先：同 id 的目录条目赢过手动记录，但手动记录仍要在选择集里可清理。
  const before = runtime.getView().models.find(model => model.id === 'custom-deepseek-r1');
  assert.equal(before.source, 'gateway');
  assert.equal(before.hasManualEntry, true, '视图应暴露可删除的手动声明');

  const removed = await runtime.updateManualModel({ action: 'remove', id: 'custom-deepseek-r1' });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.manual, []);
  assert.equal(removed.models.filter(model => model.id === 'custom-deepseek-r1').length, 1, '网关条目仍在');
  assert.equal(runtime.getView().models.find(model => model.id === 'custom-deepseek-r1').hasManualEntry, undefined);
  assert.equal(removed.defaultModelId, null, '移除最后一个启用项后不应留下悬空默认');
  assert.ok(state.adapterBuilds >= 1);

  await runtime.dispose();
});

test('managed-models: a later catalogue refresh keeps a saved manual declaration removable', async (t) => {
  const { runtime, state } = makeRuntime();
  t.after(() => runtime.dispose());
  await runtime.ready;
  await runtime.updateManualModel({ action: 'add', id: 'custom-deepseek-r1' });
  await runtime.updateModelOptions({ 'custom-deepseek-r1': { maxTokens: 4096 } });
  assert.equal(runtime.getView().models[0].source, 'manual');

  state.gatewayModels.push('custom-deepseek-r1');
  await runtime.refresh();
  const matches = runtime.getView().models.filter(model => model.id === 'custom-deepseek-r1');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source, 'gateway');
  assert.equal(matches[0].hasManualEntry, true);
  assert.equal(matches[0].maxTokens, 4096, '用户覆盖在目录更新后仍生效');

  const removed = await runtime.updateManualModel({ action: 'remove', id: 'custom-deepseek-r1' });
  assert.equal(removed.removed, true);
  assert.deepEqual(state.savedRecord.manual, []);
  assert.deepEqual(state.savedRecord.models, {});
  await runtime.refresh();
  const remaining = runtime.getView().models;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].source, 'gateway');
  assert.equal(remaining[0].hasManualEntry, undefined);
  assert.equal(remaining[0].enabled, false);
});

test('managed-models: catalogue refresh can restore saved state after manual write failure', async (t) => {
  const { runtime, state } = makeRuntime({
    savedRecord: {
      subject: 'u-1', saved: true,
      models: { 'saved-manual': {} }, defaultModelId: 'saved-manual',
      manual: [{ id: 'saved-manual' }], manualTruncated: 0,
    },
  });
  t.after(() => runtime.dispose());
  await runtime.ready;
  state.failWrites = true;

  const added = await runtime.updateManualModel({ action: 'add', id: 'new-manual' });
  assert.equal(added.persisted, false);
  assert.ok(runtime.getView().models.some(model => model.id === 'new-manual'));
  await runtime.refresh();
  assert.ok(!runtime.getView().models.some(model => model.id === 'new-manual'));

  const removed = await runtime.updateManualModel({ action: 'remove', id: 'saved-manual' });
  assert.equal(removed.persisted, false);
  assert.equal(removed.removed, true);
  assert.ok(!runtime.getView().models.some(model => model.id === 'saved-manual'));
  await runtime.refresh();
  const restored = runtime.getView().models.find(model => model.id === 'saved-manual');
  assert.equal(restored?.source, 'manual');
  assert.equal(restored?.enabled, true);
});

test('managed-models: removing an absent manual model is an idempotent success', async () => {
  const { runtime, state } = makeRuntime();
  await runtime.ready;
  const before = runtime.getView();
  state.savedRecord = null;
  // 计划 §U3/§6.1：重复删除幂等成功——不写库、不重建、不换默认值。
  const first = await runtime.updateManualModel({ action: 'remove', id: 'never-added' });
  assert.equal(first.ok, true);
  assert.equal(first.removed, false);
  assert.equal(first.persisted, false);
  assert.deepEqual(first.manual, []);
  assert.equal(state.savedRecord, null, '幂等删除不得写库');
  assert.deepEqual(runtime.getView().models, before.models);
  assert.equal(runtime.getView().defaultModelId, before.defaultModelId);

  // 添加后再删两次：第一次真删，第二次仍成功但不写库。
  await runtime.updateManualModel({ action: 'add', id: 'custom-deepseek-r1' });
  state.savedRecord = null;
  const removed = await runtime.updateManualModel({ action: 'remove', id: 'custom-deepseek-r1' });
  assert.equal(removed.removed, true);
  assert.ok(state.savedRecord !== null);
  state.savedRecord = null;
  const again = await runtime.updateManualModel({ action: 'remove', id: 'custom-deepseek-r1' });
  assert.equal(again.ok, true);
  assert.equal(again.removed, false);
  assert.equal(state.savedRecord, null);
  await runtime.dispose();
});

// 目录同步被网关拒绝 / 不可达时，已保存的选择仍必须被采用。Windows 用户报障
// 「手动添加的模型无法保存」的现场即：网关拒了 /models，面板从空选择起步，
// 手动条目既不显示，下一次增删又会用这份空快照覆盖本机已保存的记录。
const savedManualRecord = {
  subject: 'u-1',
  saved: true,
  models: { 'saved-manual': {} },
  defaultModelId: 'saved-manual',
  manual: [{ id: 'saved-manual', addedAt: '2026-11-16T00:00:00.000Z' }],
  manualTruncated: 0,
};

test('managed-models: 目录同步失败时仍采用已保存的手动模型与启用集', async () => {
  const { runtime } = makeRuntime({ savedRecord: savedManualRecord, catalogStatus: 400 });
  await runtime.ready;
  const view = runtime.getView();
  assert.equal(view.error, 'ENTERPRISE_GATEWAY_REQUEST_REJECTED');
  assert.equal(view.stale, false);
  assert.deepEqual(view.models.map(model => model.id), ['saved-manual']);
  assert.equal(view.models[0].source, 'manual');
  assert.equal(view.models[0].enabled, true);
  assert.deepEqual(view.enabled, ['saved-manual']);
  await runtime.dispose();
});

test('managed-models: 目录同步失败时新增手动模型不覆盖已保存的条目与启用集', async () => {
  const kept = {
    ...savedManualRecord,
    models: { 'kept-catalog': { maxTokens: 4096 }, 'saved-manual': {} },
    defaultModelId: 'saved-manual',
  };
  const { runtime, state } = makeRuntime({ savedRecord: kept, catalogStatus: 400 });
  await runtime.ready;

  const added = await runtime.updateManualModel({ action: 'add', id: 'new-manual' });
  assert.equal(added.ok, true);
  assert.equal(added.persisted, true);
  const stored = state.savedRecord;
  assert.deepEqual(stored.manual.map(entry => entry.id).sort(), ['new-manual', 'saved-manual']);
  // 目录当前不可见不等于网关已撤下：已启用条目的参数必须原样保留。
  assert.ok(Object.hasOwn(stored.models, 'kept-catalog'));
  assert.deepEqual(stored.models['kept-catalog'], { maxTokens: 4096 });
  assert.ok(Object.hasOwn(stored.models, 'saved-manual'));
  await runtime.dispose();
});

test('managed-models: 目录同步失败且只有手动条目时仍可保存启用集并落库', async () => {
  const { runtime, state } = makeRuntime({ savedRecord: savedManualRecord, catalogStatus: 400 });
  await runtime.ready;

  const saved = await runtime.updateModelOptions({ 'saved-manual': {} });
  assert.equal(saved.ok, true);
  assert.equal(saved.persisted, true);
  assert.deepEqual(saved.enabled, ['saved-manual']);
  assert.deepEqual(state.savedRecord.models, { 'saved-manual': {} });
  assert.ok(state.adapterBuilds >= 1, '目录不可用时重建适配器不依赖既有 backend');
  assert.deepEqual(runtime.getView().enabled, ['saved-manual']);
  await runtime.dispose();
});

test('managed-models: 保存启用集时目录不可用不会删除当前不可见的已启用条目', async () => {
  const kept = {
    ...savedManualRecord,
    models: { 'kept-catalog': { maxTokens: 4096 }, 'saved-manual': {} },
  };
  const { runtime, state } = makeRuntime({ savedRecord: kept, catalogStatus: 400 });
  await runtime.ready;

  const saved = await runtime.updateModelOptions({ 'kept-catalog': { maxTokens: 4096 }, 'saved-manual': {} });
  assert.equal(saved.persisted, true);
  assert.ok(Object.hasOwn(state.savedRecord.models, 'kept-catalog'), '不可见的已启用条目不得被静默删除');
  assert.ok(Object.hasOwn(state.savedRecord.models, 'saved-manual'));
  await runtime.dispose();
});

test('managed-models: 读取模型设置失败时不写入，避免用空状态覆盖真实记录', async () => {
  const { runtime, state } = makeRuntime({ savedRecord: savedManualRecord, readThrows: true });
  await runtime.ready;

  await assert.rejects(
    () => runtime.updateManualModel({ action: 'add', id: 'new-manual' }),
    (err) => err.code === 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  );
  assert.equal(state.saveCalls, 0, '读取失败时不得落库');
  await assert.rejects(
    () => runtime.updateModelOptions({ 'saved-manual': {} }),
    (err) => err.code === 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  );
  assert.equal(state.saveCalls, 0);
  await runtime.dispose();
});

// 真实服务链路（store + service + 运行时）上的读取失败语义。合成 iam 直接抛错只能
// 证明运行时那段 if，不能证明存储层失败会被识别——而现场正是后者。
function makeModelSelectionService({ creds, store = createModelSelectionStore(creds) }) {
  const ctx = {
    disposed: false,
    state: 'ready',
    exclusive: { ok: true },
    lastGrant: { subject: 'u-1', accessExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    knownIssuer: () => 'https://iam.corp.example',
    assertExclusive() {},
  };
  const sessionTarget = { async read() { return { ok: true, grant: ctx.lastGrant }; } };
  const provider = {
    storeCredentials: creds,
    gatewayEpoch: 1,
    ensure: () => sessionTarget,
    get modelSelectionStore() { return store; },
  };
  const ms = createModelSelection({
    config: { defaultModel: '', defaultProvider: 'enterprise' },
    options: {},
    ctx,
    provider,
    grants: { assertGrantContext() {}, ownerOf: () => sessionTarget },
    now: () => Date.now(),
    getAuthEpoch: () => 1,
    isSigningOut: () => false,
    getLoadGateway: async () => ({ state: 'configured', matchesAccount: true }),
  });
  return { ms, ctx, store };
}

function storedSelectionRecord() {
  return {
    [MODEL_SELECTION_KEY]: {
      kind: 'grant',
      payload: {
        version: 1,
        type: 'heluo-iam-model-selection',
        subject: 'u-1',
        models: { 'gw-model': {} },
        defaultModelId: 'gw-model',
        manual: [{ id: 'saved-manual', addedAt: '2026-11-16T00:00:00.000Z' }],
      },
    },
  };
}

function throwingReadCredentials(initial) {
  const creds = makeMemoryCredentials(initial);
  const write = creds.modifyRecord.bind(creds);
  creds.writes = 0;
  creds.readRecord = async () => {
    const error = new Error('synthetic keyring read failure');
    error.code = 'KEYCHAIN_UNAVAILABLE';
    throw error;
  };
  creds.modifyRecord = async (key, fn) => {
    creds.writes += 1;
    return write(key, fn);
  };
  return creds;
}

test('service-model-selection: 存储读取失败报读取失败，只有「记录不可用」才按未保存处理', async () => {
  const creds = makeMemoryCredentials(storedSelectionRecord());
  const { ms } = makeModelSelectionService({ creds });
  assert.equal((await ms.readSelection()).saved, true);

  const readRecord = creds.readRecord.bind(creds);
  creds.readRecord = async () => {
    const error = new Error('synthetic keyring read failure');
    error.code = 'KEYCHAIN_UNAVAILABLE';
    throw error;
  };
  await assert.rejects(() => ms.readSelection(), (err) => err.code === 'IAM_MODEL_SELECTION_UNREADABLE');

  // 他人记录与损坏载荷是「这份记录不可用」，不是存储故障：仍按未保存处理。
  creds.readRecord = async () => ({ kind: 'session', payload: {} });
  assert.equal((await ms.readSelection()).saved, false, 'FOREIGN 记录按未保存处理');
  creds.readRecord = async () => ({ kind: 'grant', payload: { version: 1, type: 'something-else' } });
  assert.equal((await ms.readSelection()).saved, false, 'INVALID 载荷按未保存处理');
  creds.readRecord = async () => readRecord(MODEL_SELECTION_KEY);
  assert.equal((await ms.readSelection()).saved, true);
});

test('managed-models: 存储读取失败时新增与保存都被拒绝，已存记录原样保留', async () => {
  // 对照组：同一条记录在读取正常时被正常采用。
  const healthy = makeMemoryCredentials(storedSelectionRecord());
  const { runtime: control } = makeRuntime({ gatewayModels: ['gw-model'], iam: (() => {
    const { ms } = makeModelSelectionService({ creds: healthy });
    const view = {
      state: 'ready',
      principal: { subject: 'u-1' },
      accessExpiresAt: Date.now() + 60_000,
      gatewayCredential: { state: 'configured', matchesAccount: true },
    };
    return {
      getView: () => view,
      async *watch() {},
      async resolveGatewayConnection() { return { baseURL: 'https://gw.corp.example/v1', key: 'k-1', subject: 'u-1' }; },
      readModelSelection: () => ms.readSelection(),
      saveModelSelection: next => ms.saveSelection(next),
    };
  })() });
  await control.ready;
  assert.deepEqual(control.getView().models.map(model => model.id).sort(), ['gw-model', 'saved-manual']);
  assert.deepEqual(control.getView().enabled, ['gw-model']);
  await control.dispose();

  // 重启后密钥环读不出来：任何写入都必须被拒绝，且不得改动存储。
  const broken = throwingReadCredentials(storedSelectionRecord());
  const { ms } = makeModelSelectionService({ creds: broken });
  const view = {
    state: 'ready',
    principal: { subject: 'u-1' },
    accessExpiresAt: Date.now() + 60_000,
    gatewayCredential: { state: 'configured', matchesAccount: true },
  };
  const { runtime } = makeRuntime({
    gatewayModels: ['gw-model'],
    iam: {
      getView: () => view,
      async *watch() {},
      async resolveGatewayConnection() { return { baseURL: 'https://gw.corp.example/v1', key: 'k-1', subject: 'u-1' }; },
      readModelSelection: () => ms.readSelection(),
      saveModelSelection: next => ms.saveSelection(next),
    },
  });
  await runtime.ready;

  await assert.rejects(
    () => runtime.updateManualModel({ action: 'add', id: 'new-manual' }),
    (err) => err.code === 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  );
  await assert.rejects(
    () => runtime.updateModelOptions({ 'saved-manual': {} }),
    (err) => err.code === 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  );
  assert.equal(broken.writes, 0, '读取失败时不得落库');

  // 存储恢复后读到的仍是原记录：没有只留下新条目的半覆盖。
  const restored = makeMemoryCredentials(storedSelectionRecord());
  const { ms: after } = makeModelSelectionService({ creds: restored });
  const loaded = await after.readSelection();
  assert.deepEqual(loaded.manual.map(entry => entry.id), ['saved-manual']);
  assert.deepEqual(loaded.models, { 'gw-model': {} });
  await runtime.dispose();
});

test('managed-models: 目录成功但为空时保存会移除网关已撤下的条目', async () => {
  // 网关成功返回空目录（模型被撤下）与目录请求失败必须分开处理：
  // 前者是「网关不再提供」，后者只是「这次看不到」。
  const saved = {
    subject: 'u-1',
    saved: true,
    models: { 'gw-model': { maxTokens: 4096 }, 'saved-manual': {} },
    defaultModelId: 'gw-model',
    manual: [{ id: 'saved-manual', addedAt: '2026-11-16T00:00:00.000Z' }],
    manualTruncated: 0,
  };
  const { runtime, state } = makeRuntime({ savedRecord: saved, gatewayModels: [] });
  await runtime.ready;
  assert.deepEqual(runtime.getView().models.map(model => model.id), ['saved-manual']);

  const result = await runtime.updateModelOptions({ 'saved-manual': {}, 'gw-model': { maxTokens: 4096 } });
  assert.equal(result.persisted, true);
  assert.deepEqual(state.savedRecord.models, { 'saved-manual': {} }, '网关已撤下的条目不得随保存复活');
  assert.deepEqual(result.enabled, ['saved-manual']);
  await runtime.dispose();
});
