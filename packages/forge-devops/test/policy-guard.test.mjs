/**
 * policy-guard：把策略门禁收敛成 done/denied/failed 的薄适配（设计 §4.2 / §7.7，AC-16 / AC-19）。
 *
 * 这一层只回答两个问题：**门禁怎么判**、**下游跑没跑**。因此断言四件事：
 * 1) 拒绝路径**零下游调用**——门禁是唯一真源，本包不提供任何绕过通道；
 * 2) 放行路径**透明返回**下游结果——守卫不下场做事，也不改写下游的结论；
 * 3) 前置裁决在"只有 catalog + executeAction"的桩策略上也成立（不假设 `decide` 一定存在，
 *    否则离线装配与真实门禁会走两条不同的判定路径）；
 * 4) 与真实 `@heluo/forge-policy` 门禁装配后行为一致：写动作按分类放行、内容闸拒绝时零下游、
 *    推送走逐次确认且没有确认通道时拒绝（AC-16「写动作前必须显示目标并走确认」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileCatalog, compileContentRules, createGate, createScopeLedger, decideAction } from '@heluo/forge-policy';

import { GUARD_DECISIONS, GUARD_REASONS, GUARD_STATUSES, createPolicyGuard } from '../src/policy-guard.mjs';

/** 只有目录与执行通道的桩策略：模拟"没有 decide"的最小策略服务（离线装配的常见形态）。 */
function stubPolicy({ entries = [], executeAction } = {}) {
  const catalog = new Map(entries.map((entry) => [entry.action, entry]));
  return {
    catalog,
    executeAction: executeAction ?? (async (ctx, action, exec, operation) => operation()),
  };
}

/** 记录下游是否被调用，返回固定结果。 */
function spyOperation(result = { status: 'done' }) {
  const calls = [];
  return {
    calls,
    operation: async () => {
      calls.push(Date.now());
      return result;
    },
  };
}

const IDENTITY = () => 'dev-1';
const CONTENT_RULES = compileContentRules([]).rules;
const AGENT = Object.freeze({ id: 'agent-1' });
const approvalCtx = (approval) => ({ get: (name) => (name === 'approval' ? approval : undefined) });
const audit = {
  begin: async () => ({ id: 'r1' }),
  settle: async () => ({}),
  isDegraded: () => false,
};

/**
 * 真实门禁 + 生产服务面：`createGate` 只暴露执行通道，而生产装配里的策略服务
 * （`@heluo/forge-policy` 的 `apply`）另带 `catalog` 与 `decide`。这里按同一形状补齐，
 * 让守卫走**真实的**判定、内容规则与审计，而不是桩判定。
 */
function gateService(entries, { approval, recordingAudit = audit, now = () => Date.now() } = {}) {
  const catalog = compileCatalog(entries);
  const gate = createGate({
    catalog,
    audit: recordingAudit,
    approval,
    contentRules: CONTENT_RULES,
    getActor: IDENTITY,
    scope: createScopeLedger({ now }),
    now,
  });
  return Object.assign(gate, { catalog, decide: (request) => decideAction({ catalog, ...request }) });
}

const entry = (action, target, extra = {}) => ({ action, target, enabled: true, ...extra });

test('GUARD_STATUSES 只有 done/denied/failed，不含动作层的 unknown', () => {
  assert.deepEqual(Array.from(GUARD_STATUSES), ['done', 'denied', 'failed']);
  assert.deepEqual(Array.from(GUARD_DECISIONS), ['allowed', 'confirm', 'denied']);
  assert.equal(GUARD_STATUSES.includes('unknown'), false, 'unknown 属于平台动作词表，守卫不借用');
});

test('前置裁决：缺动作名或目标对象直接拒绝，适配器零调用', () => {
  const guard = createPolicyGuard({ policy: stubPolicy() });
  const noAction = guard.admit({ target: 'acme/demo' });
  assert.equal(noAction.status, 'denied');
  assert.equal(noAction.code, GUARD_REASONS.ACTION_REQUIRED);

  const noTarget = guard.admit({ action: 'gitee.issue.write', target: '   ' });
  assert.equal(noTarget.status, 'denied');
  assert.equal(noTarget.code, GUARD_REASONS.TARGET_REQUIRED);
  assert.match(noTarget.reason, /目标对象/u);
});

test('前置裁决：策略服务没有可用目录时按未登记拒绝（fail closed）', () => {
  const guard = createPolicyGuard({ policy: {} });
  const verdict = guard.admit({ action: 'gitee.issue.write', target: 'acme/demo' });
  assert.equal(verdict.status, 'denied');
  assert.equal(verdict.code, GUARD_REASONS.POLICY_UNAVAILABLE);
  assert.equal(verdict.rule, 'policy-unavailable');
});

test('前置裁决：未登记动作 / 未启用动作都拒绝，并带上策略给的规则名', () => {
  const guard = createPolicyGuard({ policy: stubPolicy() });
  const unregistered = guard.admit({ action: 'gitee.pr.write', target: 'acme/demo' });
  assert.equal(unregistered.status, 'denied');
  assert.equal(unregistered.code, GUARD_REASONS.POLICY_ACTION_UNREGISTERED);
  assert.equal(unregistered.rule, 'unregistered-action');

  const disabled = createPolicyGuard({
    policy: stubPolicy({ entries: [{ action: 'gitee.pr.write', enabled: false }] }),
  }).admit({ action: 'gitee.pr.write', target: 'acme/demo' });
  assert.equal(disabled.status, 'denied');
  assert.equal(disabled.code, GUARD_REASONS.POLICY_DENIED);
  assert.equal(disabled.rule, 'action-disabled');
});

test('前置裁决：已登记且启用才放行', () => {
  const guard = createPolicyGuard({
    policy: stubPolicy({ entries: [{ action: 'gitee.issue.write', enabled: true }] }),
  });
  const verdict = guard.admit({ action: 'gitee.issue.write', target: 'acme/demo' });
  assert.equal(verdict.status, 'allowed');
  assert.equal(verdict.rule, 'registered-action');
});

test('前置裁决：有 decide 时交给策略判定，deny/confirm/allow 三态如实映射', () => {
  const make = (decision) =>
    createPolicyGuard({
      policy: {
        catalog: new Map(),
        decide: () => decision,
        executeAction: async (ctx, action, exec, operation) => operation(),
      },
    });

  const denied = make({ action: 'deny', reason: '未登记', rule: 'unregistered-action' }).admit({
    action: 'gitee.pr.write',
    target: 'acme/demo',
  });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.code, GUARD_REASONS.POLICY_ACTION_UNREGISTERED);

  const confirm = make({ action: 'confirm', reason: '需要确认', rule: 'confirm-required' }).admit({
    action: 'gitee.git.push',
    target: 'acme/demo',
  });
  assert.equal(confirm.status, 'confirm');
  assert.equal(confirm.code, GUARD_REASONS.CONFIRMATION_REQUIRED);

  const allowed = make({ action: 'allow', reason: '已登记', rule: 'registered-action' }).admit({
    action: 'gitee.issue.write',
    target: 'acme/demo',
  });
  assert.equal(allowed.status, 'allowed');
});

test('前置裁决：策略判定抛错或返回怪形状时按拒绝处理（不放行）', () => {
  const throwing = createPolicyGuard({
    policy: {
      catalog: new Map(),
      decide: () => {
        throw new Error('策略内部故障');
      },
      executeAction: async (ctx, action, exec, operation) => operation(),
    },
  }).admit({ action: 'gitee.issue.write', target: 'acme/demo' });
  assert.equal(throwing.status, 'denied');
  assert.equal(throwing.code, GUARD_REASONS.POLICY_FAILED);

  const odd = createPolicyGuard({
    policy: { catalog: new Map(), decide: () => ({ verdict: 'maybe' }), executeAction: async () => ({}) },
  }).admit({ action: 'gitee.issue.write', target: 'acme/demo' });
  assert.equal(odd.status, 'denied');
  assert.equal(odd.code, GUARD_REASONS.POLICY_FAILED);
  assert.match(odd.reason, /无法识别/u);
});

test('拒绝路径：前置裁决拒绝时 operation 一次都不调用', async () => {
  const guard = createPolicyGuard({ policy: stubPolicy() });
  const spy = spyOperation();
  const outcome = await guard.execute({ ctx: {}, action: 'gitee.pr.write', target: 'acme/demo' }, spy.operation);
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.reason, GUARD_REASONS.POLICY_ACTION_UNREGISTERED);
  assert.equal(spy.calls.length, 0, '门禁拒绝后不得触达适配器');
});

test('拒绝路径：策略执行通道抛错拒绝时同样零下游调用', async () => {
  const guard = createPolicyGuard({
    policy: {
      catalog: new Map([['gitee.pr.write', { action: 'gitee.pr.write', enabled: true }]]),
      executeAction: async () => {
        throw new Error('未登记动作不得进入策略执行');
      },
    },
  });
  const spy = spyOperation();
  const outcome = await guard.execute({ ctx: {}, action: 'gitee.pr.write', target: 'acme/demo' }, spy.operation);
  assert.equal(outcome.status, 'denied');
  assert.equal(spy.calls.length, 0);
});

test('拒绝路径：门禁返回 {kind:error} 时判 denied，下游零调用', async () => {
  let touched = 0;
  const guard = createPolicyGuard({
    policy: {
      catalog: new Map([['gitee.issue.write', { action: 'gitee.issue.write', enabled: true }]]),
      executeAction: async () => {
        touched += 1;
        return { kind: 'error', text: 'audit refused the action: 审计未就绪' };
      },
    },
  });
  const spy = spyOperation();
  const outcome = await guard.execute({ ctx: {}, action: 'gitee.issue.write', target: 'acme/demo' }, spy.operation);
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.reason, GUARD_REASONS.POLICY_DENIED);
  assert.match(outcome.detail, /audit refused/u);
  assert.equal(touched, 1);
  assert.equal(spy.calls.length, 0);
});

test('缺少 executeAction 的策略服务不能放行（拒绝绕过门禁）', async () => {
  const guard = createPolicyGuard({
    policy: { catalog: new Map([['gitee.issue.write', { action: 'gitee.issue.write', enabled: true }]]) },
  });
  const spy = spyOperation();
  const outcome = await guard.execute({ ctx: {}, action: 'gitee.issue.write', target: 'acme/demo' }, spy.operation);
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.reason, GUARD_REASONS.POLICY_REQUIRED);
  assert.equal(spy.calls.length, 0);
});

test('放行路径：透明返回下游结果，守卫自己不改写结论', async () => {
  const guard = createPolicyGuard({
    policy: stubPolicy({ entries: [{ action: 'gitee.issue.write', enabled: true }] }),
  });
  const downstream = { status: 'done', objectRef: 'https://gh.test/acme/demo/issues/7', reused: false };
  const spy = spyOperation(downstream);
  const outcome = await guard.execute(
    { ctx: {}, action: 'gitee.issue.write', target: 'acme/demo', arguments: { changeId: 'CHG-1' } },
    spy.operation,
  );
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.value, downstream);
  assert.equal(spy.calls.length, 1);
});

test('传给门禁的 exec 带 target，且调用方无法覆盖 target', async () => {
  const seen = [];
  const guard = createPolicyGuard({
    policy: {
      catalog: new Map([['gitee.issue.write', { action: 'gitee.issue.write', enabled: true }]]),
      executeAction: async (ctx, action, exec, operation) => {
        seen.push({ ctx, action, exec });
        return operation();
      },
    },
  });
  await guard.execute(
    {
      ctx: { session: 'S-1' },
      action: 'gitee.issue.write',
      target: 'acme/demo',
      arguments: { target: 'evil/other', repo: 'acme/demo' },
      callId: 'c1',
    },
    async () => ({ status: 'done' }),
  );
  assert.equal(seen.length, 1);
  const [{ ctx, action, exec }] = seen;
  assert.equal(action, 'gitee.issue.write');
  assert.equal(exec.name, 'gitee.issue.write');
  assert.equal(exec.arguments.target, 'acme/demo', '目标对象由守卫写入，调用方不能覆盖');
  assert.equal(exec.arguments.repo, 'acme/demo', '其余实参原样透传');
  assert.equal(exec.callId, 'c1');
  assert.equal(ctx.session, 'S-1');
});

test('下游抛错：判 failed，原因码与副作用标记来自适配器', async () => {
  const guard = createPolicyGuard({
    policy: stubPolicy({ entries: [{ action: 'gitee.issue.write', enabled: true }] }),
  });
  const error = new Error('gh 超时');
  error.code = 'COMMAND_TIMEOUT';
  error.detail = { timedOut: true, mayHaveSideEffect: true };
  const outcome = await guard.execute({ ctx: {}, action: 'gitee.issue.write', target: 'acme/demo' }, async () => {
    throw error;
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'COMMAND_TIMEOUT');
  assert.equal(outcome.mayHaveSideEffect, true, '有副作用痕迹必须让上层能降级为 unknown');
  assert.match(outcome.detail, /gh 超时/u);
});

test('没拿到 operation 时判 failed 而不是静默放行', async () => {
  const guard = createPolicyGuard({
    policy: stubPolicy({ entries: [{ action: 'gitee.issue.write', enabled: true }] }),
  });
  const outcome = await guard.execute({ ctx: {}, action: 'gitee.issue.write', target: 'acme/demo' });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, GUARD_REASONS.NO_OPERATION);
});

test('装配真实门禁：干净的写动作经一次范围确认后放行，审计收到动作', async () => {
  const audited = [];
  const service = gateService([entry('gitee.issue.write', 'issue')], {
    approval: { async request() { return 'allowed-once'; } },
    recordingAudit: {
      begin: async (record) => {
        audited.push(record);
        return { id: 'r1' };
      },
      settle: async () => ({ action: 'settled' }),
      isDegraded: () => false,
    },
  });
  const guard = createPolicyGuard({ policy: service });
  const outcome = await guard.execute(
    { ctx: approvalCtx({ async request() { return 'allowed-once'; } }), agent: AGENT, action: 'gitee.issue.write', target: 'acme/demo!7', arguments: { changeId: 'CHG-1', body: 'plain text' } },
    async () => ({ status: 'done', objectRef: 'acme/demo#7' }),
  );
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.value.objectRef, 'acme/demo#7');
  assert.equal(audited.length, 1);
  assert.equal(audited[0].action, 'gitee.issue.write');
  assert.equal(audited[0].target, 'acme/demo!7');
  assert.equal(audited[0].actor, 'dev-1');
});

test('装配真实门禁：内容闸命中时拒绝且下游零调用', async () => {
  const service = gateService([entry('gitee.issue.write', 'issue')], {
    approval: { async request() { return 'allowed-once'; } },
  });
  const guard = createPolicyGuard({ policy: service });
  const spy = spyOperation();
  const outcome = await guard.execute(
    {
      ctx: approvalCtx({ async request() { return 'allowed-once'; } }),
      agent: AGENT,
      action: 'gitee.issue.write',
      target: 'acme/demo!7',
      arguments: { changeId: 'CHG-1', body: 'password = "hunter2hunter2"' },
    },
    spy.operation,
  );
  assert.equal(outcome.status, 'denied');
  assert.match(String(outcome.detail), /BUILTIN-/u);
  assert.equal(spy.calls.length, 0, '内容闸拒绝后不得写平台');
});

test('装配真实门禁：推送没有确认通道时拒绝且下游零调用', async () => {
  const service = gateService([entry('gitee.git.push', 'repository')]);
  const guard = createPolicyGuard({ policy: service });
  const spy = spyOperation();
  const outcome = await guard.execute(
    { ctx: approvalCtx(undefined), agent: AGENT, action: 'gitee.git.push', target: 'acme/demo', arguments: { branch: 'feature/x' } },
    spy.operation,
  );
  assert.equal(outcome.status, 'denied');
  assert.match(String(outcome.detail), /approval channel/u);
  assert.equal(spy.calls.length, 0, '确认未完成前不得推送');
});

test('装配真实门禁：未登记动作被拒，适配器与审计都零调用', async () => {
  let auditCalls = 0;
  const service = gateService([entry('gitee.issue.write', 'issue')], {
    approval: { async request() { return 'allowed-once'; } },
    recordingAudit: {
      begin: async () => {
        auditCalls += 1;
        return { id: 'r1' };
      },
      settle: async () => ({}),
      isDegraded: () => false,
    },
  });
  const guard = createPolicyGuard({ policy: service });
  const spy = spyOperation();
  const outcome = await guard.execute(
    { ctx: approvalCtx({ async request() { return 'allowed-once'; } }), agent: AGENT, action: 'gitee.pr.write', target: 'acme/demo!7', arguments: { changeId: 'CHG-1' } },
    spy.operation,
  );
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.rule, 'unregistered-action');
  assert.equal(spy.calls.length, 0);
  assert.equal(auditCalls, 0);
});
