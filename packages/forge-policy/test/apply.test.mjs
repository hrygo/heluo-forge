import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, createDecisionCache, installPolicy } from '../src/index.mjs';

// P0 迁移说明（policy-minimal-gates）：申请通道、范围票据、内容闸、流程规则与路径规则
// 在 P0 已删除，全关时既不再拦截也不再产生确认；目录行只写 action/target/category。
// 旧用例里"请求审批""范围票据复用""内容命中拒绝""流程事实拒绝"等断言因此被替换为
// 反向断言与挂载期 fail-closed 断言（见各用例内的一行取代说明）。

const ISSUE = { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' };
const PUSH = { action: 'gitee.git.push', target: 'repository', category: 'remote-write' };
const HUMAN = { action: 'gitee.review.record', target: 'pull-request', category: 'human-record' };
const PR_WRITE = { action: 'gitee.pr.write', target: 'pull-request', category: 'dev-write' };

const IDENTITY = Object.freeze({
  getView() {
    return { state: 'ready', signedIn: true, principal: 'user-a', accessExpiresAt: null };
  },
});

function fakeHost({ iam = IDENTITY, facts, logger, userQuestions } = {}) {
  const provided = new Map();
  if (facts !== undefined) provided.set('processFacts', facts);
  if (userQuestions !== undefined) provided.set('userQuestions', userQuestions);
  const guards = [];
  const listeners = new Map();
  const warnings = [];
  const ctx = {
    tools: {
      guard(fn) {
        guards.push(fn);
        return () => guards.splice(guards.indexOf(fn), 1);
      },
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    get(name) {
      if (name === 'iam') return iam;
      return provided.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    effect(callback) {
      const dispose = callback();
      return dispose;
    },
    logger: logger ?? { warn: (message) => warnings.push(message) },
  };
  return { ctx, guards, listeners, provided, warnings };
}

const baseConfig = {
  catalog: [ISSUE, PUSH, HUMAN, PR_WRITE],
  tools: {
    forge_issue_write: 'gitee.issue.write',
    forge_push: 'gitee.git.push',
    forge_review_record: 'gitee.review.record',
    forge_pr_write: 'gitee.pr.write',
  },
};

const native = () => ({ guard: () => () => {}, pre: () => () => {} });

/** Capture the host hook seams so a directly-installed policy can be driven. */
function nativeHooks() {
  const hooks = {};
  const hooksNative = {
    guard(fn) {
      hooks.guard = fn;
      return () => { delete hooks.guard; };
    },
    pre(fn) {
      hooks.pre = fn;
      return () => { delete hooks.pre; };
    },
  };
  return { hooks, native: hooksNative };
}

function execution(name, args, extra = {}) {
  return {
    name,
    arguments: args,
    callId: extra.callId ?? 'c1',
    agent: extra.agent ?? { kind: 'agent' },
    signal: extra.signal ?? new AbortController().signal,
    ...extra,
  };
}

function mount(config = baseConfig, options = {}) {
  const host = fakeHost(options);
  apply(host.ctx, config);
  const preExecute = host.listeners.get('tools/pre-execute');
  const guard = host.guards[0];
  /** Run the full admission and report the refusal reason, or `undefined`. */
  const stage = async (name, args, extra = {}) => {
    const exec = execution(name, args, extra);
    const decision = await preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
    if (decision.kind === 'deny') return { reason: decision.reason, exec };
    return { reason: guard(exec), exec };
  };
  return { ...host, policy: host.ctx.get('policy'), stage, preExecute, guard };
}

test('apply installs the guard, both stages and the policy service, with one observe-only warning', () => {
  const host = mount();
  assert.equal(host.guards.length, 1);
  assert.equal(typeof host.listeners.get('tools/pre-execute'), 'function');
  assert.equal(typeof host.listeners.get('tools/post-execute'), 'function');
  assert.equal(typeof host.listeners.get('tools/result'), 'function');
  assert.deepEqual(host.policy.actions(), [
    'gitee.issue.write',
    'gitee.git.push',
    'gitee.review.record',
    'gitee.pr.write',
  ]);
  assert.equal(host.policy.mode(), 'personal');
  assert.equal(host.policy.policyVersion(), 'builtin');
  assert.equal(host.warnings.length, 1, 'all-off is announced exactly once');
  assert.match(host.warnings[0], /observe-only/u);
});

test('unregistered actions and unregistered host tools are out of scope: no gate, no audit', async () => {
  // 取代事实：旧实现把未登记动作 deny 成 unregistered-action；P0 全关时按 out-of-scope 放行。
  const host = mount();
  assert.equal((await host.stage('forge_typo_tool', { target: 'acme/demo!1' })).reason, undefined);
  assert.equal(host.policy.auditRecords().length, 0);
  assert.equal(host.guard(execution('read', {})), undefined);
  assert.equal(host.guard(execution('web_fetch', { url: 'https://example.invalid' })), undefined);
  assert.equal(host.policy.catalog.has('change.read'), false);
});

test('read actions are not registered and pass without an audit trail', async () => {
  // 取代事实：旧目录是 12 条并集并要求只读动作 enabled；P0 只登记 6 条写动作。
  const host = mount();
  for (const read of ['gitee.repository.read', 'gitee.issue.read', 'gitee.pr.read', 'change.read', 'change.list']) {
    assert.equal(host.policy.catalog.has(read), false, `${read} must not be registered`);
  }
  assert.equal((await host.stage('forge_repository_read', { target: 'acme/demo' })).reason, undefined);
  assert.equal(host.policy.auditRecords().length, 0, 'out-of-scope reads leave no audit');
});

test('a write without an IAM identity is denied before anything runs', async () => {
  const host = mount(baseConfig, { iam: { getView: () => ({ state: 'signed-out', signedIn: false, principal: null }) } });
  const denied = await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' });
  assert.match(String(denied.reason), /IAM 身份/u);
  assert.match(String(denied.reason), /设置 → 账号/u);
  assert.match(String(denied.reason), /gitee\.issue\.write/u);
  assert.equal(host.policy.auditRecords().length, 0, 'a denied call is not a controlled call');
});

test('the identity is read per call, not cached', async () => {
  let signedIn = true;
  const host = mount(baseConfig, {
    iam: { getView: () => (signedIn ? { state: 'ready', signedIn: true, principal: 'user-a' } : { state: 'signed-out', signedIn: false }) },
  });
  assert.equal((await host.stage('forge_issue_write', { target: 'acme/demo!1' }, { callId: 'c1' })).reason, undefined);
  signedIn = false;
  const denied = await host.stage('forge_issue_write', { target: 'acme/demo!1' }, { callId: 'c2' });
  assert.match(String(denied.reason), /IAM 身份/u);
});

test('an all-off write records exactly one begin before the body, then one settle', async () => {
  const host = mount();
  const exec = execution('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' }, { callId: 'c10' });
  const decision = await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'allow');
  const begin = host.policy.auditRecords()[0];
  assert.equal(host.policy.auditRecords().length, 1, 'a controlled call has exactly one begin record');
  assert.equal(begin.phase, 'begin');
  assert.equal(begin.actor, 'user-a');
  assert.equal(begin.action, 'gitee.issue.write');
  assert.match(begin.summary, /gitee\.issue\.write/u);
  assert.equal(JSON.stringify(begin).includes('plain text'), false, 'business content is never recorded');
  assert.equal(JSON.stringify(begin).includes('arguments'), false);

  const settled = await host.listeners.get('tools/post-execute')(exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }));
  assert.equal(settled.kind, 'accept');
  const records = host.policy.auditRecords();
  assert.deepEqual(records.map((item) => item.phase), ['begin', 'settle']);
  assert.equal(typeof records[1].durationMs, 'number');
  assert.equal(records[1].decision, 'executed');
});

test('content rules no longer block: a hard-rule body passes without a human decision', async () => {
  // 取代事实：旧实现由内容闸的 BUILTIN-CLOUD-ACCESS-KEY 拒绝并省略请求审批；P0 全关不做内容判定。
  const host = mount();
  const result = await host.stage('forge_issue_write', {
    target: 'acme/demo!1',
    changeId: 'CHG-1',
    // 拼接，避免本文件本身命中仓库的敏感信息扫描。
    body: ['access_key_id', ['AKIA', 'EXAMPLE', '1234567890'].join('')].join(' = '),
  });
  assert.equal(result.reason, undefined);
  assert.equal(host.policy.auditRecords().length, 1);
});

test('process facts are not consulted: a closed change and an unconfirmed plan still pass', async () => {
  // 取代事实：旧实现的流程规则会按事实源拒绝已关闭变更/未确认计划；P0 不读取事实源。
  const facts = { read: () => ({ change: { available: true, status: 'closed' }, plan: { available: true, confirmed: false } }) };
  const host = mount(baseConfig, { facts });
  assert.equal((await host.stage('forge_push', { target: 'acme/demo', branch: 'feature/x', changeId: 'CHG-1' })).reason, undefined);
  assert.equal(host.policy.auditRecords().length, 1);
});

test('protected branches are not enforced in P0', async () => {
  // 取代事实：旧实现由流程规则拒绝受保护分支推送；P0 全关不拦。
  const host = mount();
  assert.equal((await host.stage('forge_push', { target: 'acme/demo', branch: 'main' })).reason, undefined);
});

test('a human-record write is not blocked at the tool gate', async () => {
  // 取代事实：旧实现把 gitee.review.record 恒拒；P0 全关时它是 out-of-scope 的放行。
  // 命令面仍不注册（人工留痕不由 Agent 发起），由 command.test.mjs 守住。
  const host = mount();
  assert.equal(host.policy.catalog.get('gitee.review.record').category, 'human-record');
  assert.equal((await host.stage('forge_review_record', { target: 'acme/demo!4' })).reason, undefined);
});

test('a push executes without any approval channel', async () => {
  // 取代事实：旧实现每次 push 都要请求审批、没有审批通道即失败；P0 不再调用审批。
  const host = mount();
  let runs = 0;
  const exec = execution('forge_push', { target: 'acme/demo', branch: 'feature/x' }, { callId: 'c20' });
  const result = await host.policy.executeAction(host.ctx, 'gitee.git.push', exec, async () => {
    runs += 1;
    return { kind: 'ok' };
  });
  assert.deepEqual(result, { kind: 'ok' });
  assert.equal(runs, 1);
  assert.equal(host.policy.auditGaps().length, 0);
  assert.equal(host.policy.auditRecords().filter((item) => item.phase === 'begin').length, 1);
});

test('the mounted service exposes only the P1 members', () => {
  // 取代事实：旧服务还暴露 delegation/confirmation/scope/egress/canary 助手；P0 删除这些模块，P1 只补两个只读探针。
  const host = mount();
  const policy = host.policy;
  for (const member of [
    'catalog', 'actions', 'decide', 'authorize', 'protectedPaths', 'checkPath', 'judgePath', 'orgPolicy',
    'policyVersion', 'mode', 'contentRuleIds', 'setAuditSink', 'auditRecords', 'auditGaps',
    'acknowledgeAuditGaps', 'auditDegraded', 'executeAction', 'registerCommand', 'observations',
    'confirmationAvailable', 'decisionCacheSize',
  ]) {
    assert.equal(member in policy, true, `${member} must stay exposed`);
  }
  for (const removed of [
    'createDelegation', 'revokeDelegation', 'resumeDelegation', 'authorizeDelegation',
    'issueConfirmation', 'consumeConfirmation', 'confirmations', 'scopeTickets', 'revokeScopeTicket',
    'digestContent', 'decideEgress', 'confirmationScope', 'renderEgressScope', 'assertNoCanary',
  ]) {
    assert.equal(removed in policy, false, `${removed} must be gone`);
  }
  assert.deepEqual(policy.protectedPaths(), [], 'no append root is configured by default');
  // checkPath 保持布尔契约（true = 已判定且受保护），judgePath 给明细：
  // 工作区内的九类按名称判，工作区外且不在追加根内不判。
  const workspace = mkdtempSync(join(tmpdir(), 'forge-policy-apply-'));
  try {
    assert.equal(policy.checkPath(join(workspace, '.env'), workspace), true);
    assert.equal(policy.checkPath(join(workspace, 'notes.txt'), workspace), false);
    assert.equal(policy.checkPath('/etc/passwd'), false);
    assert.deepEqual(policy.judgePath(join(workspace, '.env'), workspace), { judged: true, protected: true, category: 'name:.env' });
    assert.deepEqual(policy.judgePath(join(workspace, 'notes.txt'), workspace), { judged: true, protected: false });
    assert.deepEqual(policy.judgePath('/etc/passwd'), { judged: false, protected: false });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  assert.equal(policy.orgPolicy().state, 'absent');
  assert.deepEqual(policy.decide({ action: 'gitee.issue.write', target: 'acme/demo!1' }).action, 'allow');
  assert.deepEqual(policy.decide({ action: 'unknown.action', target: 'x' }).rule, 'out-of-scope');
});

test('a call whose arguments change after admission is refused', async () => {
  // 取代事实：旧用例模拟"审批期间正文被改写"；P0 无审批，但准入后的摘要复验仍必须拦截。
  const host = mount();
  const exec = execution('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' });
  assert.equal((await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }))).kind, 'allow');
  exec.arguments.body = 'plain text plus something else';
  assert.match(String(host.guard(exec)), /arguments changed/u);
});

test('teardown removes the guard, the stages and the service', () => {
  const host = fakeHost();
  const dispose = apply(host.ctx, baseConfig);
  assert.equal(host.provided.has('policy'), true);
  dispose();
  assert.equal(host.guards.length, 0);
  assert.equal(host.listeners.has('tools/pre-execute'), false);
  assert.equal(host.listeners.has('tools/post-execute'), false);
  assert.equal(host.listeners.has('tools/result'), false);
  assert.equal(host.provided.has('policy'), false);
  dispose();
  assert.equal(host.guards.length, 0);
});

test('invalid catalogs and legacy keys refuse to mount in one shot', () => {
  const host = fakeHost();
  // 取代事实：目录行不再接受 enabled/revision；读动作不登记；审批开关已从配置面移除。
  assert.throws(
    () => apply(host.ctx, { catalog: [{ action: 'gitee.repository.read', target: 'repository', category: 'read' }] }),
    (error) => error.code === 'POLICY_CONFIG_INVALID' && /catalog\[0\]/u.test(error.message) && /read action/u.test(error.message),
  );
  assert.throws(
    () => apply(host.ctx, { catalog: [{ ...ISSUE, enabled: true }] }),
    (error) => error.code === 'POLICY_CONFIG_INVALID' && /catalog\[0\]/u.test(error.message) && /enabled/u.test(error.message),
  );
  assert.throws(
    () => apply(host.ctx, { ...baseConfig, approvals: [] }),
    (error) => error.code === 'POLICY_CONFIG_INVALID' && /approvals/u.test(error.message),
  );
  assert.throws(
    () => apply(host.ctx, { ...baseConfig, audit: { sink: 'memory', allowNonDurable: true } }),
    (error) => error.code === 'POLICY_CONFIG_INVALID' && /audit\.allowNonDurable/u.test(error.message),
  );
  assert.throws(
    () => apply(host.ctx, { ...baseConfig, protectedPaths: 'x' }),
    (error) => error.code === 'POLICY_CONFIG_INVALID' && /protectedPaths/u.test(error.message),
  );
  assert.equal(host.guards.length, 0, 'a rejected mount leaves no guard behind');
});

test('validation reports every issue at once with key paths', () => {
  const host = fakeHost();
  assert.throws(
    () => apply(host.ctx, {
      catalog: [ISSUE, { ...ISSUE }, { ...PUSH, target: 'wrong' }],
      rules: { confirmPush: 'yes' },
      audit: { sink: 'cpu' },
    }),
    (error) => {
      assert.equal(error.code, 'POLICY_CONFIG_INVALID');
      const issues = String(error.issues ?? error.message);
      assert.match(issues, /catalog\[1\]/u);
      assert.match(issues, /catalog\[2\]/u);
      assert.match(issues, /rules\.confirmPush/u);
      assert.match(issues, /audit\.sink/u);
      return true;
    },
  );
  assert.equal(host.guards.length, 0);
});

test('an occupied policy service refuses to mount a second one', () => {
  const host = fakeHost();
  apply(host.ctx, baseConfig);
  assert.throws(() => apply(host.ctx, baseConfig), (error) => error.code === 'POLICY_SERVICE_CONFLICT');
});

test('a host without the guard seam refuses to mount', () => {
  assert.throws(
    () => apply({ get: () => undefined, provide: () => () => {}, effect: () => () => {}, tools: {} }, baseConfig),
    (error) => error.code === 'POLICY_HOST_UNAVAILABLE',
  );
});

test('no audit sink means no controlled call, and the copy never says 审计', async () => {
  // 取代事实：旧实现内存 sink 需要 allowNonDurable；P0 允许 memory sink，但"没有 sink"仍是 fail closed。
  const host = mount();
  host.policy.setAuditSink(null);
  const decision = await host.preExecute(execution('forge_issue_write', { target: 'acme/demo!1' }), () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /记录|存储|重试/u);
  assert.equal(decision.reason.includes('审计'), false, 'the word 审计 must not reach the user');
});

test('a failed settlement degrades the gate until the gap is acknowledged', async () => {
  const host = mount();
  const records = [];
  const exec = execution('forge_issue_write', { target: 'acme/demo!1' }, { callId: 'c30' });
  assert.equal((await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }))).kind, 'allow');
  host.policy.setAuditSink({
    kind: 'file',
    durable: true,
    append: (record) => {
      if (record.phase === 'settle') throw new Error('settle failed');
      records.push(record);
    },
  });
  await host.listeners.get('tools/result')(exec, { isError: false });
  assert.equal(host.policy.auditDegraded(), true);
  assert.equal(host.policy.auditGaps().length, 1);
  const refused = await host.preExecute(execution('forge_issue_write', { target: 'acme/demo!2' }, { callId: 'c31' }), () => Promise.resolve({ kind: 'allow' }));
  assert.match(String(refused.reason), /尚未回写|outstanding/u);
  assert.equal(host.policy.acknowledgeAuditGaps(), 1);
  assert.equal(host.policy.auditDegraded(), false);
});

test('a file audit sink writes one JSONL file under $DSH_HOME/logs and keeps memory empty', async () => {
  // 取代事实：旧实现拒绝非持久 sink；P0 明确支持 file sink（按天一个文件、保留 keepDays）。
  const dir = mkdtempSync(join(tmpdir(), 'forge-policy-apply-'));
  try {
    const host = fakeHost();
    const { hooks, native: seams } = nativeHooks();
    installPolicy(host.ctx, {
      catalog: [ISSUE],
      tools: { forge_issue_write: 'gitee.issue.write' },
      audit: { sink: 'file' },
      env: { DSH_HOME: dir },
    }, seams);
    const policy = host.ctx.get('policy');
    const exec = execution('forge_issue_write', { target: 'acme/demo!1' }, { callId: 'f1' });
    const decision = await hooks.pre(exec, () => Promise.resolve({ kind: 'allow' }));
    assert.equal(decision.kind, 'allow');
    assert.deepEqual(policy.auditRecords(), [], 'the file sink does not keep the memory ring');
    const day = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(join(dir, 'logs', `forge-policy-${day}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.phase, 'begin');
    assert.equal(record.action, 'gitee.issue.write');
    assert.equal(record.actor, 'user-a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an organization envelope may require a durable sink', () => {
  // 组织信封只能收紧：require_durable_audit 为真时内存 sink 直接拒绝挂载。
  const host = fakeHost();
  const org = { state: 'verified', policyVersion: 'org-1', processRules: { require_durable_audit: true } };
  assert.throws(
    () => installPolicy(host.ctx, { catalog: [ISSUE] }, native(), undefined, { orgPolicy: org }),
    (error) => error.code === 'POLICY_AUDIT_NOT_DURABLE',
  );
  assert.equal(host.guards.length, 0);
});

test('an enabled confirmation switch mounts without a channel, warns once and reports it', () => {
  const host = mount({ ...baseConfig, rules: { confirmPush: true } });
  assert.equal(host.policy.mode(), 'personal');
  assert.equal(host.policy.confirmationAvailable(), false);
  assert.equal(host.policy.decisionCacheSize(), 0, 'a fresh mount starts with an empty cache');
  assert.equal(host.warnings.length, 1, 'the missing channel is the only warning');
  assert.match(host.warnings[0], /userQuestions/u);
  assert.match(host.warnings[0], /POLICY_CONFIRM_UNAVAILABLE/u);
});

test('a mounted channel is reported as available and silences the warning', () => {
  const channel = { ask: () => Promise.resolve({ answers: [] }) };
  const host = mount(
    { ...baseConfig, rules: { confirmPush: true, confirmDopWrite: true } },
    { userQuestions: channel },
  );
  assert.equal(host.policy.confirmationAvailable(), true);
  assert.equal(host.warnings.length, 0);
});

test('an injected gateway and cache are used instead of the built-ins', async () => {
  const host = fakeHost();
  const cache = createDecisionCache({ limit: 4 });
  const calls = [];
  const confirmations = {
    ask: (request) => (calls.push(request), Promise.resolve({ decision: 'deny', code: 'POLICY_CONFIRM_DENIED' })),
    dispose: () => calls.push('dispose'),
    pending: () => 0,
  };
  const dispose = installPolicy(
    host.ctx,
    { ...baseConfig, rules: { confirmPush: true } },
    native(),
    undefined,
    { confirmations, decisionCache: cache },
  );
  const policy = host.ctx.get('policy');
  assert.equal(policy.confirmationAvailable(), true, 'an injected gateway is a real channel');
  assert.equal(host.warnings.length, 0, 'the missing host service is not a problem when a gateway is injected');
  const result = await policy.executeAction(
    host.ctx,
    'gitee.git.push',
    { name: 'forge_push', arguments: { target: 'acme/demo' }, callId: 'c1', agent: { kind: 'agent' } },
    async () => ({ ok: true }),
  );
  assert.equal(result.code, 'POLICY_CONFIRM_DENIED');
  assert.equal(calls.length, 1);
  assert.equal(policy.decisionCacheSize(), 0, 'the injected cache is the one being reported');
  dispose();
  assert.deepEqual(calls.at(-1), 'dispose');
});
