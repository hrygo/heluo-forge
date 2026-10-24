import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  DevopsReadError,
  normalizeReadResult,
  READ_ACTIONS,
  READ_REASONS,
  SERVICE_KEY,
  validateConfig,
} from '../src/index.mjs';
import { READER_KEY } from '../src/index.mjs';

/** 最小宿主替身：只提供本包用到的 get/provide/effect。 */
function host({ policy = { value: {} }, reader } = {}) {
  const provided = new Map();
  const ctx = {
    get: (key) => (key === 'policy' ? policy.value : key === READER_KEY ? reader : undefined),
    provide: (key, value) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
  };
  return { ctx, provided };
}

/** 挂载插件并从已提供服务里取服务本体：`apply()` 的返回值是卸载函数（与 forge-policy 一致）。 */
function mount(options = {}) {
  const { ctx, provided } = host(options);
  const teardown = apply(ctx, options.config ?? {});
  return { ctx, provided, teardown, service: provided.get(SERVICE_KEY) };
}

test('未登记的写动作被拒绝，且不触碰适配器', async () => {
  let calls = 0;
  const reader = { read: async () => ((calls += 1), { status: 'succeeded', source_revision: 'r1' }) };
  assert.throws(
    () => normalizeReadResult({ action: 'issue.close', target: 'issue-1', result: null }),
    (error) => error instanceof DevopsReadError && error.code === READ_REASONS.UNKNOWN_ACTION,
  );
  const { service } = mount({ reader });
  await assert.rejects(() => service.read({ action: 'pr.create_or_update', target: 'pr-1' }), {
    code: READ_REASONS.UNKNOWN_ACTION,
  });
  assert.equal(calls, 0, '未登记动作不得产生任何适配器调用');
});

test('缺目标被拒绝，且不触碰适配器', async () => {
  let calls = 0;
  const reader = { read: async () => ((calls += 1), {}) };
  const { service } = mount({ reader });
  await assert.rejects(() => service.read({ action: 'issue.read', target: '  ' }), {
    code: READ_REASONS.MISSING_TARGET,
  });
  assert.equal(calls, 0);
});

test('没有适配器时 fail closed：可见状态为 no-reader，读取拒绝而不是返回空结果', async () => {
  const { service } = mount();
  assert.equal(service.status(), 'no-reader');
  await assert.rejects(() => service.read({ action: 'change.read', target: 'C-1' }), { code: READ_REASONS.NO_READER });
});

test('只给退出码的适配器不算成功：降级为 unknown 并给出 NO_STRUCTURED_STATUS', () => {
  const normalized = normalizeReadResult({
    action: 'change.read',
    target: 'C-1',
    result: { exitCode: 0, stdout: 'ok' },
  });
  assert.equal(normalized.status, 'unknown');
  assert.equal(normalized.error_code, READ_REASONS.NO_STRUCTURED_STATUS);
  assert.equal(normalized.source_revision, null);
  assert.equal(normalized.retry_policy, 'read_recheck');
});

test('缺来源版本的事实降级为 unknown，不伪造冻结依据', () => {
  const normalized = normalizeReadResult({ action: 'pr.read', target: 'pr-9', result: { status: 'succeeded' } });
  assert.equal(normalized.status, 'unknown');
  assert.equal(normalized.error_code, READ_REASONS.MISSING_SOURCE_REVISION);
});

test('非对象结果降级为 unknown，不抛错也不报成功', () => {
  for (const result of [undefined, 'ok', 42, ['a']]) {
    const normalized = normalizeReadResult({ action: 'repository.read', target: 'repo-1', result });
    assert.equal(normalized.status, 'unknown');
    assert.equal(normalized.error_code, READ_REASONS.MALFORMED_RESULT);
  }
});

test('事实齐全时规整为契约结果，并把请求原样交给适配器', async () => {
  const seen = [];
  const reader = {
    read: async (request) => {
      seen.push(request);
      return {
        status: 'succeeded',
        target_ref: 'issue-42',
        source_revision: 'rev-7',
        result_refs: ['issue-42@rev-7'],
        observed_at: '2026-10-24T12:00:00Z',
      };
    },
  };
  const { service } = mount({ reader });
  assert.equal(service.status(), 'ready');
  const result = await service.read({ action: 'issue.read', target: 'issue-42' });
  assert.deepEqual(seen, [{ action: 'issue.read', target: 'issue-42' }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.target_ref, 'issue-42');
  assert.equal(result.source_revision, 'rev-7');
  assert.deepEqual(result.result_refs, ['issue-42@rev-7']);
  assert.equal(result.retry_policy, 'read_recheck');
});

test('只读面只含四个读动作，不含任何写动作', () => {
  assert.deepEqual([...READ_ACTIONS], ['change.read', 'repository.read', 'issue.read', 'pr.read']);
  const { service } = mount();
  for (const action of service.readActions()) {
    assert.ok(action.endsWith('.read'), `${action} 不应出现在只读面`);
  }
});

test('策略服务缺失时不挂载：入口关闭，不提供"无策略只读"降级', () => {
  const { provided } = host();
  const bare = { get: () => undefined, provide: () => () => {}, effect: () => {} };
  assert.throws(() => apply(bare, {}), (error) => error.code === READ_REASONS.POLICY_REQUIRED);
  assert.equal(provided.has(SERVICE_KEY), false, '未挂载时不得留下服务残留');
});

test('卸载后服务被移除（无残留）', () => {
  const { provided, teardown } = mount();
  assert.ok(provided.has(SERVICE_KEY));
  teardown();
  assert.equal(provided.has(SERVICE_KEY), false);
});

test('配置校验拒绝未知项与非法形状', () => {
  assert.deepEqual(validateConfig(), {});
  assert.throws(() => validateConfig({ writes: true }), (error) => error.code === READ_REASONS.MALFORMED_RESULT);
  assert.throws(() => validateConfig([]), (error) => error.code === READ_REASONS.MALFORMED_RESULT);
});
