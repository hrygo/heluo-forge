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

// 取代事实（TECH-CHANGE §3.4）：P0 起只读动作不登记，devops 挂载只要求策略提供
// `executeAction` admission 入口。旧实现要求两条读动作"已登记且 enabled"才允许挂载，
// 空目录 / 缺条目 / 未开放动作都会以 POLICY_ACTION_UNREGISTERED 拒绝——该事实已删除。
test('空目录可以挂载：只读动作不登记，读面按 out-of-scope 透传', async () => {
  const mounted = mount({ policy: stubPolicy({ catalog: new Map() }).service, reader: goodReader() });
  assert.ok(mounted.service, '空目录仍必须提供 devops 服务');
  const read = await mounted.service.read({ action: 'change.read', target: 'CHG-1' });
  assert.equal(read.status, 'succeeded');
});

test('缺读动作条目也可以挂载：目录只登记受控写', async () => {
  for (const missing of ['change.read', 'change.list']) {
    const catalog = fullCatalog();
    catalog.delete(missing);
    const mounted = mount({ policy: stubPolicy({ catalog }).service });
    assert.ok(mounted.service, `${missing} 未登记时仍可挂载`);
  }
});

test('目录条目没有 enabled 键也不影响挂载（登记只决定可见）', () => {
  const stub = stubPolicy();
  stub.service.catalog.set('change.read', { action: 'change.read', target: 'change', category: 'dev-write' });
  const mounted = mount({ policy: stub.service });
  assert.ok(mounted.service, '旧 enabled 字段不再参与挂载判定');
});

test('策略服务没有目录但有 admission 入口时可以挂载', () => {
  const mounted = mount({ policy: { executeAction: async (ctx, action, exec, operation) => operation() } });
  assert.ok(mounted.service, 'P0 挂载前置只有 executeAction');
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
      // 登记只决定可见（登记 ≠ 批准）：分发层已登记；fixture 目录只放读动作，这里校验映射与
      // "若有条目必须 enabled"，绝不代表写动作被默认批准。
      assert.equal(flowTool.action, 'change.clarification.write', `${toolName} 的写动作必须是澄清回写`);
      if (entry !== undefined) assert.equal(entry.enabled, true, `${toolName} 的登记条目必须 enabled`);
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
