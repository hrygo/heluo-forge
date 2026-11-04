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
import { READ_ROUTES, projectFacts } from '../src/read.mjs';

/** 最小宿主替身：只提供本包用到的 get/provide/effect。 */
function host({ policy = { value: admitAllPolicy() }, reader } = {}) {
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

/** FIX-02 挂载合约替身：目录覆盖本包的读动作且已开放，admission 直接承认并执行。 */
function admitAllPolicy() {
  return {
    catalog: new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }])),
    executeAction: async (ctx, action, exec, operation) => operation(),
  };
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
  await assert.rejects(() => service.read({ action: 'change.read', target: '  ' }), {
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
  const normalized = normalizeReadResult({ action: 'change.read', target: 'CHG-2026-0042', result: { status: 'succeeded' } });
  assert.equal(normalized.status, 'unknown');
  assert.equal(normalized.error_code, READ_REASONS.MISSING_SOURCE_REVISION);
});

test('非对象结果降级为 unknown，不抛错也不报成功', () => {
  for (const result of [undefined, 'ok', 42, ['a']]) {
    const normalized = normalizeReadResult({ action: 'change.read', target: 'CHG-2026-0042', result });
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
        target_ref: 'CHG-2026-0042',
        source_revision: 'rev-7',
        result_refs: ['CHG-2026-0042@rev-7'],
        observed_at: '2026-10-24T12:00:00Z',
        command: 'dop change view CHG-2026-0042 --json',
        raw: { id: 'CHG-2026-0042', title: '示例变更', status: 'in_progress' },
        truncated: false,
      };
    },
  };
  const { service } = mount({ reader });
  assert.equal(service.status(), 'ready');
  const result = await service.read({ action: 'change.read', target: 'CHG-2026-0042' });
  assert.deepEqual(seen, [{ action: 'change.read', target: 'CHG-2026-0042', status: undefined }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.target_ref, 'CHG-2026-0042');
  assert.equal(result.source_revision, 'rev-7');
  assert.deepEqual(result.result_refs, ['CHG-2026-0042@rev-7']);
  assert.equal(result.retry_policy, 'read_recheck');
  assert.equal(result.command, 'dop change view CHG-2026-0042 --json', '命令标签必须透传，事实才可核对');
  assert.equal(result.truncated, false, '截断标记必须可见（不把截断当完整事实）');
});

test('只读 runner 两个动作、两条路由：change.read 走 readChange，change.list 走 listChanges 并透传 status', async () => {
  assert.deepEqual([...READ_ACTIONS], ['change.read', 'change.list']);
  assert.deepEqual(Object.keys(READ_ROUTES).sort(), ['change.list', 'change.read']);

  const ports = {
    dop: {
      readChange: async (input) => ({ kind: 'readChange', input }),
      listChanges: async (input) => ({ kind: 'listChanges', input }),
    },
  };
  assert.deepEqual(await READ_ROUTES['change.read'](ports, { target: 'CHG-1' }), {
    kind: 'readChange',
    input: { changeId: 'CHG-1' },
  });
  assert.deepEqual(await READ_ROUTES['change.list'](ports, { target: '@me', status: 'open' }), {
    kind: 'listChanges',
    input: { status: 'open' },
  });

  // 服务层把请求原样交给 reader（status 由路由决定用不用），再归一成契约结果。
  const seen = [];
  const reader = {
    read: async (request) => {
      seen.push(request);
      return {
        status: 'succeeded',
        target_ref: 'changes',
        source_revision: 'rev-8',
        command: 'dop change list --json --status open',
        user: 'alice',
        total: 2,
        count: 1,
        filter: { status: 'open' },
        items: [{ id: 'CHG-1' }],
        raw: { user: 'alice', total: 2, changes: [{ id: 'CHG-1' }] },
      };
    },
  };
  const { service } = mount({ reader });
  const listed = await service.read({ action: 'change.list', target: '@me', status: 'open' });
  assert.deepEqual(seen, [{ action: 'change.list', target: '@me', status: 'open' }]);
  assert.equal(listed.status, 'succeeded');
  assert.equal(listed.command, 'dop change list --json --status open');
  assert.deepEqual(listed.facts, {
    user: 'alice',
    total: 2,
    count: 1,
    filter: { status: 'open' },
    items: [{ id: 'CHG-1' }],
    raw: { user: 'alice', total: 2, changes: [{ id: 'CHG-1' }] },
  });
});

test('normalizeReadResult 透传 command 与 facts；没有命令与事实时不伪造', () => {
  const normalized = normalizeReadResult({
    action: 'change.read',
    target: 'CHG-1',
    result: {
      status: 'succeeded',
      source_revision: 'rev-1',
      command: 'dop change view CHG-1 --json',
      raw: { id: 'CHG-1' },
      truncated: true,
    },
  });
  assert.equal(normalized.command, 'dop change view CHG-1 --json');
  assert.deepEqual(normalized.facts, { raw: { id: 'CHG-1' } });
  assert.equal(normalized.truncated, true);

  const bare = normalizeReadResult({
    action: 'change.read',
    target: 'CHG-1',
    result: { status: 'succeeded', source_revision: 'rev-1' },
  });
  assert.equal(bare.command, null, '没有命令可核对时必须显式 null');
  assert.equal(bare.facts, undefined, '没有可投影的记录时不返回空 facts');
});

test('projectFacts 按动作单点投影：change.read 只要 raw，change.list 给清单摘要', () => {
  const record = { id: 'CHG-1', title: '示例' };
  assert.deepEqual(projectFacts('change.read', { raw: record, command: 'x' }), { raw: record });
  assert.equal(projectFacts('change.read', {}), undefined, 'raw 不是普通对象时不给 facts');
  assert.equal(projectFacts('change.read', null), undefined);
  assert.deepEqual(projectFacts('change.list', { user: 'alice', total: 3, count: 1, filter: null, items: [{ id: 'CHG-1' }], raw: { total: 3 } }), {
    user: 'alice',
    total: 3,
    count: 1,
    filter: null,
    items: [{ id: 'CHG-1' }],
    raw: { total: 3 },
  });
  assert.deepEqual(
    projectFacts('change.list', {}),
    { user: null, total: null, count: null, filter: null, items: [], raw: null },
    '平台没给的可选位显式 null，不伪造数字',
  );
  assert.equal(projectFacts('change.clarification.write', { raw: {} }), undefined, '未登记动作没有投影');
});

test('只读面只含 dop 变更的两条读动作，不含任何写动作（r10：仓库/Issue/PR 读在 forge-gitee）', () => {
  assert.deepEqual([...READ_ACTIONS], ['change.read', 'change.list']);
  const { service } = mount();
  for (const action of service.readActions()) {
    assert.ok(READ_ACTIONS.includes(action), `${action} 不在只读动作词表里`);
    assert.ok(
      !/\.(write|create|update|delete|close|merge|done)$/u.test(action),
      `${action} 是写动作，不得出现在只读面`,
    );
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
