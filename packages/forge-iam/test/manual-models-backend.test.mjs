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
    lastGrant: { subject: 'u-1', accessExpiresAt: new Date(Date.now() + 60_000).toISOString() },
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
    get modelSelectionStore() { return store; },
  };
  const grants = { assertGrantContext() {}, ownerOf: () => sessionTarget };
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
    resolveToken: async () => 'tok',
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
  await ms.saveSelection({ models: { 'm-a': {} }, defaultModelId: 'm-a', manual: [{ id: 'm-a' }] });
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

function makeRuntime({ gatewayModels = [], savedRecord: initialRecord } = {}) {
  const state = {
    adapterBuilds: 0,
    savedRecord: initialRecord ?? { subject: 'u-1', saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 },
    gatewayModels: [...gatewayModels],
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
    iam: {
      getView: () => currentView,
      async *watch() {},
      async resolveGatewayConnection() {
        return { baseURL: 'https://gw.corp.example/v1', key: 'k-1', subject: 'u-1' };
      },
      async readModelSelection() { return state.savedRecord; },
      async saveModelSelection(next) {
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
    fetch: async () => ({
      ok: true,
      status: 200,
      // discover() 先读 text 再按字节上限解析，不接受 response.json()。
      async text() { return JSON.stringify({ data: state.gatewayModels.map(id => ({ id })) }); },
    }),
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
  assert.equal(runtime.getView().models.find(model => model.id === 'custom-deepseek-r1').source, 'gateway');

  const removed = await runtime.updateManualModel({ action: 'remove', id: 'custom-deepseek-r1' });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.manual, []);
  assert.equal(removed.models.filter(model => model.id === 'custom-deepseek-r1').length, 1, '网关条目仍在');
  assert.equal(removed.defaultModelId, null, '移除最后一个启用项后不应留下悬空默认');
  assert.ok(state.adapterBuilds >= 1);

  await runtime.dispose();
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
