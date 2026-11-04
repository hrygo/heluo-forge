import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  DevopsReadError,
  FLOW_TOOLS,
  QUERY_ACTIONS,
  QUERY_TOOL,
  READ_ACTIONS,
  READ_REASONS,
  SERVICE_KEY,
} from '../src/index.mjs';
import { READER_KEY } from '../src/index.mjs';

/**
 * FIX-02（#21）：已知企业入口的目录绑定必须可验证。
 * 空目录、缺目录项、未开放动作都拒绝挂载；运行时拒绝走同一策略 admission，
 * 拒绝时适配器零调用。普通非企业工具不在此列（门禁 out-of-scope 语义保留）。
 *
 * r10 / D 方案：只读面收敛为 dop 变更两条（`change.read` / `change.list`；仓库 / Issue / PR
 * 读归 `@heluo/forge-gitee`），因此"目录绑定"要校验的条目是两条——校验逻辑本身不变。
 */

const fullCatalog = () =>
  new Map(READ_ACTIONS.map((action) => [action, { action, kind: 'read', enabled: true }]));

/** 策略服务替身：目录 + 可脚本化的 executeAction（记录调用，不伪装真实门禁语义）。 */
function stubPolicy({ catalog = fullCatalog(), admit = true } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      catalog,
      executeAction: async (ctx, action, exec, operation) => {
        calls.push({ action, exec });
        if (admit === true) return operation();
        return { kind: 'error', text: 'denied by policy (test intransigent)' };
      },
    },
  };
}

function mount({ policy = stubPolicy().service, reader } = {}) {
  const provided = new Map();
  const registered = new Map();
  const ctx = {
    get: (key) => (key === 'policy' ? policy : key === READER_KEY ? reader : undefined),
    provide: (key, value) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
    effect: () => {},
    tools: {
      register: (definition) => {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
  };
  const teardown = apply(ctx, {});
  return { ctx, provided, registered, teardown, service: provided.get(SERVICE_KEY) };
}

const goodReader = () => ({
  read: async ({ action, target }) => ({ status: 'succeeded', target_ref: target, source_revision: 'rev-1', action }),
});

test('空目录拒绝挂载：读动作一个都不能少', () => {
  assert.throws(
    () => mount({ policy: stubPolicy({ catalog: new Map() }).service }),
    (error) =>
      error instanceof DevopsReadError && error.code === READ_REASONS.POLICY_ACTION_UNREGISTERED,
  );
});

test('漏一项映射拒绝挂载，并列出缺失动作', () => {
  for (const missing of ['change.read', 'change.list']) {
    const catalog = fullCatalog();
    catalog.delete(missing);
    assert.throws(
      () => mount({ policy: stubPolicy({ catalog }).service }),
      (error) =>
        error instanceof DevopsReadError &&
        error.code === READ_REASONS.POLICY_ACTION_UNREGISTERED &&
        new RegExp(missing.replace('.', '\\.'), 'u').test(error.message),
      `${missing} 未登记时不得挂载`,
    );
  }
});

test('目录中有未开放动作拒绝挂载（登记 ≠ 批准）', () => {
  const stub = stubPolicy();
  stub.service.catalog.set('change.read', { action: 'change.read', kind: 'read', enabled: false });
  assert.throws(() => mount({ policy: stub.service }), {
    code: READ_REASONS.POLICY_ACTION_UNREGISTERED,
  });
});

test('策略服务没有目录时拒绝挂载，不提供无目录只读', () => {
  assert.throws(() => mount({ policy: { executeAction: async () => ({}) } }), {
    code: READ_REASONS.POLICY_ACTION_UNREGISTERED,
  });
});

test('FIX-08：策略服务没有 admission 入口时拒绝挂载，不以 TypeError 泄漏', () => {
  assert.throws(
    () => mount({ policy: { catalog: fullCatalog() } }),
    (error) =>
      error instanceof DevopsReadError &&
      error.code === READ_REASONS.POLICY_REQUIRED &&
      /admission/u.test(error.message),
  );
});

test('FIX-08：调用方自带 role 等参数不进入 admission 身份，不扩权', async () => {
  const stub = stubPolicy();
  const { service } = mount({ policy: stub.service, reader: goodReader() });
  await service.read({ action: 'change.read', target: 'CHG-2026-0042', role: 'admin' });
  assert.deepEqual(stub.calls[0].exec.arguments, { target: 'CHG-2026-0042' });
  assert.equal(stub.calls[0].exec.agent, undefined);
});

test('工具→动作绑定可验证：只读 runner 的每个动作与流程工具动作都在目录中有已开放条目', () => {
  const catalog = fullCatalog();
  assert.equal(QUERY_TOOL, 'forge_devops_query');
  assert.deepEqual([...QUERY_ACTIONS], ['change.read', 'change.list'], 'runner 的枚举只有这两条读动作');
  assert.deepEqual([...QUERY_ACTIONS], [...READ_ACTIONS], 'runner 的动作词表与只读动作同源');
  for (const action of QUERY_ACTIONS) {
    assert.ok(READ_ACTIONS.includes(action), `${action} 映射到未知动作`);
    const entry = catalog.get(action);
    assert.ok(entry !== undefined && entry.enabled === true, `${action} 缺少已开放目录条目`);
  }
  for (const [toolName, flowTool] of Object.entries(FLOW_TOOLS)) {
    if (flowTool.action === null) continue; // 落盘没有平台动作
    const entry = catalog.get(flowTool.action);
    if (flowTool.kind === 'write') {
      // 写动作默认不登记（登记 ≠ 批准）：目录里没有它才是默认关闭。
      assert.equal(entry, undefined, `${toolName} 的写动作不得默认登记`);
      continue;
    }
    assert.ok(entry !== undefined && entry.enabled === true, `${toolName} 的动作缺少已开放目录条目`);
  }
});

test('策略承认时恰好一次适配器调用，结果按契约规整', async () => {
  let calls = 0;
  const reader = {
    read: async (request) => {
      calls += 1;
      return { status: 'succeeded', target_ref: request.target, source_revision: 'rev-9', action: request.action };
    },
  };
  const { service } = mount({ reader });
  const result = await service.read({ action: 'change.read', target: 'CHG-1' });
  assert.equal(calls, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.source_revision, 'rev-9');
});

test('策略拒绝时适配器零调用，拒绝可见（POLICY_DENIED + 网关原文）', async () => {
  let calls = 0;
  const reader = { read: async () => ((calls += 1), { status: 'succeeded', source_revision: 'r' }) };
  const denying = stubPolicy({ admit: false });
  const { service } = mount({ policy: denying.service, reader });
  await assert.rejects(() => service.read({ action: 'change.read', target: 'CHG-2026-0042' }), {
    code: READ_REASONS.POLICY_DENIED,
  });
  assert.equal(calls, 0, '策略拒绝不得触碰适配器');
  assert.equal(denying.calls.length, 1, '拒绝同样经过同一 admission');
});

test('工具面同样经过 admission：拒绝时 ok:false + next_action，不调用适配器', async () => {
  let calls = 0;
  const reader = { read: async () => ((calls += 1), { status: 'succeeded', source_revision: 'r' }) };
  const { registered } = mount({ policy: stubPolicy({ admit: false }).service, reader });
  const payload = JSON.parse(
    (await registered.get(QUERY_TOOL).execute({ action: 'change.read', target: 'CHG-2026-0042' })).content[0].text,
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, READ_REASONS.POLICY_DENIED);
  assert.equal(payload.next_action, 'report-to-admin');
  assert.equal(calls, 0);
});
