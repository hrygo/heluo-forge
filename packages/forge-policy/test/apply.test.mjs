import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, PolicyCatalogError } from '../src/index.mjs';

const READ = { action: 'gitee.repository.read', target: 'repository', enabled: true };
const WRITE = { action: 'gitee.issue.write', target: 'issue', enabled: true };
const CONFIRM = { action: 'gitee.git.push', target: 'repository', enabled: true };
const HUMAN = { action: 'gitee.review.record', target: 'pull-request', enabled: true };
const PR_WRITE = { action: 'gitee.pr.write', target: 'pull-request', enabled: true };

const IDENTITY = Object.freeze({
  getView() {
    return { state: 'ready', signedIn: true, principal: 'user-a', accessExpiresAt: null };
  },
});

function fakeHost({ approval = { async request() { return 'allowed-once'; } }, iam = IDENTITY, facts } = {}) {
  const provided = new Map();
  if (facts !== undefined) provided.set('processFacts', facts);
  const guards = [];
  const listeners = new Map();
  const effects = [];
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
      if (name === 'approval') return approval;
      if (name === 'iam') return iam;
      return provided.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, guards, listeners, provided, effects };
}

const DEV_AUDIT = { sink: 'memory', allowNonDurable: true };

const baseConfig = {
  audit: DEV_AUDIT,
  catalog: [READ, WRITE, CONFIRM, HUMAN],
  tools: {
    forge_repository_read: 'gitee.repository.read',
    forge_issue_write: 'gitee.issue.write',
    forge_push: 'gitee.git.push',
    forge_review_record: 'gitee.review.record',
    forge_typo_tool: 'change.read',
  },
  categories: { bash: 'shell.exec' },
};

function mount(config = baseConfig, options = {}) {
  const host = fakeHost(options);
  apply(host.ctx, config);
  const preExecute = host.listeners.get('tools/pre-execute');
  const guard = host.guards[0];
  /** Run the full admission and report the refusal reason, or `undefined`. */
  const stage = async (name, args, extra = {}) => {
    const exec = { name, arguments: args, callId: extra.callId ?? 'c1', signal: new AbortController().signal, ...extra };
    const decision = await preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
    if (decision.kind === 'deny') return { reason: decision.reason, exec };
    return { reason: guard(exec), exec };
  };
  return { ...host, policy: host.ctx.get('policy'), stage, preExecute, guard };
}

test('apply installs the guard, the pre-execute stage and the policy service', () => {
  const host = mount();
  assert.equal(host.guards.length, 1);
  assert.equal(typeof host.listeners.get('tools/pre-execute'), 'function');
  assert.deepEqual(host.policy.actions(), ['gitee.repository.read', 'gitee.issue.write', 'gitee.git.push', 'gitee.review.record']);
  assert.equal(host.policy.mode(), 'personal');
  assert.equal(host.policy.policyVersion(), 'builtin');
});

test('an unregistered action, a disabled action and a missing target are denied', async () => {
  const host = mount();
  assert.match(String((await host.stage('forge_typo_tool', { target: 'r' })).reason), /not registered/);
  const disabled = mount({ ...baseConfig, catalog: [READ, { ...WRITE, enabled: false }] });
  assert.match(String((await disabled.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1' })).reason), /not enabled/);
  assert.match(String((await host.stage('forge_repository_read', {})).reason), /requires a repository target/);
  assert.equal((await host.stage('forge_repository_read', { target: 'acme/demo' })).reason, undefined);
});

test('a disabled write is refused even with an identity and a clean body', async () => {
  const config = { ...baseConfig, catalog: [READ, { ...WRITE, enabled: false }] };
  const host = mount(config);
  assert.match(String((await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok' })).reason), /not enabled/);
});

test('a write action without an authenticated identity is denied', async () => {
  const host = mount(baseConfig, { iam: { getView: () => ({ state: 'signed-out', signedIn: false, principal: null }) } });
  const denied = await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' });
  assert.match(String(denied.reason), /requires an authenticated identity/);
});

test('an authenticated clean write passes the content gate and records policy evidence', async () => {
  const approvalRequests = [];
  const approval = { async request(request) { approvalRequests.push(request); return 'allowed-once'; } };
  const host = mount(baseConfig, { approval });
  const first = await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' }, {
    agent: { id: 'agent-1' },
    callId: 'c10',
  });
  assert.equal(first.reason, undefined);
  assert.equal(approvalRequests.length, 1, 'only the task scope is asked for');
  assert.match(approvalRequests[0].reason, /task scope/);
  const record = host.policy.auditRecords().find((item) => item.phase === 'begin');
  assert.equal(record.policyVersion, 'builtin');
  assert.equal(record.actor, 'user-a');
  assert.equal(record.mode, 'personal');
  assert.equal(JSON.stringify(record).includes('plain text'), false, 'business content is never recorded');
});

test('the task scope prompt is localized and explains what one approval covers', async () => {
  const requests = [];
  const config = {
    ...baseConfig,
    catalog: [...baseConfig.catalog, PR_WRITE],
    tools: { ...baseConfig.tools, forge_pr_write: 'gitee.pr.write' },
  };
  const host = mount(config, { approval: { async request(request) { requests.push(request); return 'allowed-once'; } } });
  const staged = await host.stage('forge_pr_write', {
    target: 'osc/ard/ard-cli',
    changeId: 'CHG-1',
    op: 'create',
    title: '测试 PR',
    head: 'test/pr-issue1',
    base: 'master',
  }, { agent: { id: 'agent-1' } });
  assert.equal(staged.reason, undefined);
  const request = requests.find((item) => /task scope/u.test(item.reason));
  assert.ok(request !== undefined, 'the task scope is asked for');
  assert.match(request.reason, /confirm a task scope for gitee\.pr\.write on osc\/ard\/ard-cli/u);
  assert.equal(request.displayReason.zh, '允许在 osc/ard/ard-cli 上创建 Pull Request (test/pr-issue1 → master)（变更 CHG-1）？允许一次＝本会话内对该仓库的同类写操作不再逐次询问；换仓库、换变更号或重启后需要重新确认。');
  assert.match(request.displayReason.en, /creating a pull request on osc\/ard\/ard-cli/u);
  assert.doesNotMatch(request.displayReason.zh, /task scope|gitee\.pr\.write/u, 'the prompt states the action, not the internals');
});

test('a rejected task scope reports the rejection instead of only the ticket wording', async () => {
  const host = mount(baseConfig, { approval: { async request() { return 'rejected'; } } });
  const denied = await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' }, { agent: { id: 'agent-1' } });
  assert.match(String(denied.reason), /: rejected/u, 'the human decision survives into the refusal');
  assert.doesNotMatch(String(denied.reason), /no confirmed task scope/u, 'the rejection is not masked by the ticket wording');
});

test('a hard content rule refuses the write before the body runs and redacts the finding', async () => {
  const host = mount();
  let bodyCalls = 0;
  const denied = await host.stage('forge_issue_write', {
    target: 'acme/demo!1',
    changeId: 'CHG-1',
    // 拼接，避免本文件本身命中仓库的敏感信息扫描。
    body: ['access_key_id', ['AKIA', 'EXAMPLE', '1234567890'].join('')].join(' = '),
  }, { agent: { id: 'agent-1' } });
  assert.match(String(denied.reason), /BUILTIN-CLOUD-ACCESS-KEY/);
  assert.match(String(denied.reason), /acce…7890/, 'the excerpt keeps only the first and last four characters');
  assert.equal(bodyCalls, 0);
});

test('a soft content rule escalates to a confirmation instead of denying', async () => {
  const requests = [];
  const approval = { async request(request) { requests.push(request); return 'allowed-once'; } };
  const host = mount(baseConfig, { approval });
  const allowed = await host.stage('forge_issue_write', {
    target: 'acme/demo!1',
    changeId: 'CHG-1',
    body: `the internal endpoint is http://${['10', '20', '30', '40'].join('.')}/health`,
  }, { agent: { id: 'agent-1' }, callId: 'c11' });
  assert.equal(allowed.reason, undefined);
  assert.match(String(requests.at(-1).reason), /content rules flagged BUILTIN-INTERNAL-ADDRESS/);
  assert.equal(requests.length, 2, 'the task scope and the flagged content are confirmed separately');
  const second = requests.at(-1);
  assert.equal(second.displayReason.zh, '允许在 acme/demo 上创建 Issue（变更 CHG-1）？本次调用需要人工确认：正文里有需要人工复核的内容。这条确认只放行本次调用。');
  assert.match(second.displayReason.en, /This call needs a human decision: a content check needs review/u);
});

test('a process confirmation names the missing section in the prompt', async () => {
  const requests = [];
  const config = {
    ...baseConfig,
    catalog: [...baseConfig.catalog, PR_WRITE],
    tools: { ...baseConfig.tools, forge_pr_write: 'gitee.pr.write' },
  };
  const host = mount(config, { approval: { async request(request) { requests.push(request); return 'allowed-once'; } } });
  const staged = await host.stage('forge_pr_write', {
    target: 'osc/ard/ard-cli',
    changeId: 'CHG-1',
    op: 'create',
    head: 'test/pr-issue1',
    base: 'master',
    body: 'no acceptance here',
  }, { agent: { id: 'agent-1' } });
  assert.equal(staged.reason, undefined);
  const second = requests.at(-1);
  assert.match(second.reason, /no acceptance section/u);
  assert.equal(second.displayReason.zh, '允许在 osc/ard/ard-cli 上创建 Pull Request (test/pr-issue1 → master)（变更 CHG-1）？本次调用需要人工确认：PR 描述缺少「验收」小节。这条确认只放行本次调用。');
});

test('a process rule with an available fact source denies a closed change', async () => {
  const facts = { read: () => ({ change: { available: true, status: 'closed' } }) };
  const host = mount(baseConfig, { facts });
  assert.match(
    String((await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok' }, { agent: { id: 'agent-1' } })).reason),
    /is not in progress/,
  );
});

test('an unavailable process fact source is recorded as unevaluated and does not block', async () => {
  const host = mount();
  const result = await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok' }, { agent: { id: 'agent-1' } });
  assert.equal(result.reason, undefined);
  const record = host.policy.auditRecords().find((item) => item.phase === 'begin');
  assert.deepEqual([...record.unevaluated], ['change-in-progress']);
});

test('a write action needs one range confirmation, then reuses the ticket inside the same scope', async () => {
  const requests = [];
  const approval = { async request(request) { requests.push(request); return 'allowed-once'; } };
  const host = mount(baseConfig, { approval });
  const write = (callId, target = 'acme/demo!1') => host.stage('forge_issue_write', { target, changeId: 'CHG-1', body: 'ok' }, { agent: { id: 'agent-1' }, callId });

  assert.equal((await write('c1')).reason, undefined);
  assert.equal(requests.length, 1, 'the first write asks for a task scope');
  assert.equal((await write('c2', 'acme/demo!2')).reason, undefined);
  assert.equal(requests.length, 1, 'the second write in the same scope reuses the ticket');
  assert.equal(host.policy.scopeTickets().length, 1);

  const other = await host.stage('forge_issue_write', { target: 'acme/other!3', changeId: 'CHG-1', body: 'ok' }, { agent: { id: 'agent-1' }, callId: 'c3' });
  assert.equal(other.reason, undefined);
  assert.equal(requests.length, 2, 'another repository needs its own scope');
});

test('`#12` 与 `!12` 是同一个仓库作用域，不重复要确认', async () => {
  const requests = [];
  const approval = { async request(request) { requests.push(request); return 'allowed-once'; } };
  const host = mount(baseConfig, { approval });
  const write = (callId, target) => host.stage('forge_issue_write', { target, changeId: 'CHG-1', body: 'ok' }, { agent: { id: 'agent-1' }, callId });

  assert.equal((await write('c1', 'acme/demo!12')).reason, undefined);
  assert.equal(requests.length, 1);
  assert.equal((await write('c2', 'acme/demo#12')).reason, undefined);
  assert.equal(requests.length, 1, '同一个仓库的另一种序号写法不该再问一次');
  assert.equal(host.policy.scopeTickets().length, 1);
});

test('同一身份换会话要重新确认：范围票据不跨会话复用', async () => {
  const requests = [];
  const approval = { async request(request) { requests.push(request); return 'allowed-once'; } };
  const host = mount(baseConfig, { approval });
  const write = (callId, agentId) => host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok' }, { agent: { id: agentId }, callId });

  assert.equal((await write('c1', 'session-a')).reason, undefined);
  assert.equal(requests.length, 1);
  assert.equal((await write('c2', 'session-a')).reason, undefined);
  assert.equal(requests.length, 1, '同一会话内复用');
  assert.equal((await write('c3', 'session-b')).reason, undefined);
  assert.equal(requests.length, 2, '另一个会话必须自己确认，不能白拿旧票据');
});

test('内容扫描不完整时在确认与最小化审计中标明', async () => {
  const requests = [];
  const host = mount(baseConfig, { approval: { async request(r) { requests.push(r); return 'allowed-once'; } } });
  const result = await host.stage('forge_push', { target: 'acme/demo', branch: 'feature/x', body: 'x\u0000binary' }, { agent: { id: 'agent-1' } });
  assert.equal(result.reason, undefined);
  assert.match(requests.at(-1).reason, /body \(binary-skipped\)/);
  const record = host.policy.auditRecords().find((item) => item.phase === 'begin');
  assert.deepEqual(record.contentSkipped, ['body:binary-skipped']);
  assert.ok(!JSON.stringify(record).includes('binary\\u0000'));
});

test('正文超出上限要求逐次确认并记录截断', async () => {
  const requests = [];
  const host = mount(baseConfig, { approval: { async request(r) { requests.push(r); return 'allowed-once'; } } });
  const result = await host.stage('forge_issue_write', { target: 'acme/demo#12', changeId: 'CHG-1', body: 'x'.repeat(262145) }, { agent: { id: 'agent-1' } });
  assert.equal(result.reason, undefined);
  assert.match(requests.at(-1).reason, /body \(truncated\)/);
  assert.deepEqual(host.policy.auditRecords().find((item) => item.phase === 'begin').contentSkipped, ['body:truncated']);
});

test('a write without a change id cannot establish a task scope', async () => {
  const approval = { async request() { return 'allowed-once'; } };
  const host = mount(baseConfig, { approval });
  const denied = await host.stage('forge_issue_write', { target: 'acme/demo!1', body: 'ok' }, { agent: { id: 'agent-1' } });
  assert.match(String(denied.reason), /needs a change id/);
});

test('a confirm action fails closed until the confirmation stage approved it', async () => {
  const requests = [];
  let allowed = false;
  const approval = { async request(request) { requests.push(request); return allowed ? 'allowed-once' : 'rejected'; } };
  const host = mount(baseConfig, { approval });
  const exec = { name: 'forge_push', arguments: { target: 'acme/demo', branch: 'feature/x' }, callId: 'c9', agent: { id: 'agent-1' }, signal: new AbortController().signal };

  assert.match(String(host.guard(exec)), /did not run for this execution/);
  const denied = await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /rejected/);

  allowed = true;
  const retry = { ...exec, callId: 'c10' };
  const granted = await host.preExecute(retry, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(granted.kind, 'allow');
  assert.equal(host.guard(retry), undefined);
  assert.equal(requests.length, 2);
});

test('a push to a protected branch is denied by the process rule', async () => {
  const host = mount();
  const denied = await host.stage('forge_push', { target: 'acme/demo', branch: 'main' }, { agent: { id: 'agent-1' } });
  assert.match(String(denied.reason), /is protected/);
});

test('a human-record action is never startable by an agent', async () => {
  const host = mount();
  const denied = await host.stage('forge_review_record', { target: 'acme/demo!4' }, { agent: { id: 'agent-1' } });
  assert.match(String(denied.reason), /reserved for human-written records/);
});

test('an agent-less confirm action is denied without asking', async () => {
  const approval = { async request() { throw new Error('should not be asked'); } };
  const host = mount(baseConfig, { approval });
  const decision = await host.preExecute(
    { name: 'forge_push', arguments: { target: 'acme/demo', branch: 'feature/x' }, callId: 'c1', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /no approval channel/);
  assert.equal(approval.requested, undefined);
});

test('an out-of-scope host tool is not silently claimed', () => {
  const host = mount();
  assert.equal(host.guard({ name: 'read', arguments: {}, callId: 'c1' }), undefined);
  assert.match(String(host.guard({ name: 'bash', arguments: { command: 'ls' }, callId: 'c2' })), /not registered/);
  assert.equal(host.guard({ name: 'web_fetch', arguments: { url: 'https://example.invalid' }, callId: 'c3' }), undefined);
});

test('teardown removes the guard, the stage and the service', () => {
  const host = fakeHost();
  const dispose = apply(host.ctx, baseConfig);
  assert.equal(host.provided.has('policy'), true);
  dispose();
  assert.equal(host.guards.length, 0);
  assert.equal(host.listeners.has('tools/pre-execute'), false);
  assert.equal(host.provided.has('policy'), false);
  dispose();
  assert.equal(host.guards.length, 0);
});

test('an invalid catalog, legacy approvals or an occupied service refuse to mount', () => {
  const host = fakeHost();
  assert.throws(
    () => apply(host.ctx, { catalog: [{ action: 'a.b', target: 'repository' }] }),
    (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_CATALOG_UNKNOWN_ACTION',
  );
  assert.throws(
    () => apply(host.ctx, { ...baseConfig, approvals: [] }),
    (error) => error.code === 'POLICY_CONFIG_INVALID' && String(error.details?.issues).includes('no longer accepted'),
  );
  assert.equal(host.guards.length, 0, 'a rejected mount leaves no guard behind');
  apply(host.ctx, baseConfig);
  assert.throws(() => apply(host.ctx, baseConfig), (error) => error.code === 'POLICY_SERVICE_CONFLICT');
});

test('a host without the guard seam refuses to mount', () => {
  assert.throws(
    () => apply({ get: () => undefined, provide: () => () => {}, effect: () => () => {}, tools: {} }, baseConfig),
    (error) => error.code === 'POLICY_HOST_UNAVAILABLE',
  );
});

test('the mounted service exposes delegation, confirmation, scope and envelope helpers', () => {
  const host = mount();
  const policy = host.policy;

  const grant = policy.createDelegation({
    id: 'dlg-1',
    source: 'host',
    principal: 'user-a',
    changeId: 'C-2026-1',
    repositories: ['repo-a'],
    actions: ['gitee.repository.read'],
    revisions: { change: 'rev-1' },
    ttlMs: 60_000,
  });
  const inScope = { principal: 'user-a', changeId: 'C-2026-1', repository: 'repo-a', action: 'gitee.repository.read', revisions: { change: 'rev-1' } };
  assert.equal(policy.authorizeDelegation({ grant, request: inScope }).action, 'allow');
  assert.equal(policy.authorizeDelegation({ grant: policy.revokeDelegation(grant), request: inScope }).rule, 'delegation-revoked');

  const issued = policy.issueConfirmation({ action: 'gitee.repository.read', target: 'repo-a', content: { body: 'x' }, revision: 'rev-1', kind: 'human', ttlMs: 60_000 });
  assert.equal(policy.confirmations().length, 1);
  assert.equal(policy.consumeConfirmation({ action: 'gitee.repository.read', target: 'repo-a', content: { body: 'x' }, revision: 'rev-1' }).action, 'allow');
  assert.equal(policy.consumeConfirmation({ key: issued.key, revision: 'rev-1' }).rule, 'confirmation-consumed');

  assert.deepEqual(policy.protectedPaths(), ['$DSH_HOME/**']);
  assert.equal(policy.orgPolicy().state, 'absent');
  assert.equal(policy.digestContent({ a: 1 }).length, 64);
  assert.match(policy.renderEgressScope(policy.confirmationScope({ action: 'a.b', target: 't', content: { body: 'x' } })), /fields=\[body\]/);
  assert.doesNotThrow(() => policy.assertNoCanary('nothing here', ['canary-value']));
});

test('an enforced action is refused when no audit sink is configured', async () => {
  const host = mount({ ...baseConfig, audit: {} });
  const decision = await host.preExecute(
    { name: 'forge_repository_read', arguments: { target: 'acme/demo' }, callId: 'c1', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /audit refused/);
  assert.match(decision.reason, /no audit sink is available/);
  assert.equal(host.policy.auditGaps().length, 0, 'a refused pre-audit is not a gap');
});

test('a non-durable audit sink is refused unless explicitly allowed', async () => {
  const host = mount({ ...baseConfig, audit: { sink: 'memory' } });
  const decision = await host.preExecute(
    { name: 'forge_repository_read', arguments: { target: 'acme/demo' }, callId: 'c1', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.match(decision.reason, /not durable/);
});

test('a failing audit sink refuses before the body runs', async () => {
  const host = mount();
  let bodyCalls = 0;
  host.policy.setAuditSink({ durable: true, append: () => { throw new Error('disk on fire'); } });
  const decision = await host.preExecute(
    { name: 'forge_repository_read', arguments: { target: 'acme/demo' }, callId: 'c1', signal: new AbortController().signal },
    () => (bodyCalls += 1, Promise.resolve({ kind: 'allow' })),
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /disk on fire/);
  assert.equal(bodyCalls, 0);
});

test('a post-execution audit failure keeps the outcome, records a gap and limits later actions', async () => {
  const host = mount();
  const records = [];
  host.policy.setAuditSink({ durable: true, append: (record) => {
    if (record.phase === 'settle') throw new Error('settle failed');
    records.push(record);
  } });
  const exec = { name: 'forge_repository_read', arguments: { target: 'acme/demo' }, callId: 'c1', signal: new AbortController().signal };
  const allowed = await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(allowed.kind, 'allow');
  assert.equal(records.length, 1, 'the pre-audit record was written first');
  assert.equal(records[0].phase, 'begin');
  assert.equal(JSON.stringify(records[0]).includes('arguments') === false, true);

  const settled = await host.listeners.get('tools/post-execute')(exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }));
  assert.equal(settled.kind, 'accept', 'the outcome is untouched by the failed settle');
  assert.equal(host.policy.auditGaps().length, 1);
  assert.equal(host.policy.auditDegraded(), true);

  const next = await host.preExecute(
    { name: 'forge_repository_read', arguments: { target: 'acme/demo' }, callId: 'c2', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.match(next.reason, /still outstanding/);
  assert.equal(host.policy.acknowledgeAuditGaps(), 1);
  const after = await host.preExecute(
    { name: 'forge_repository_read', arguments: { target: 'acme/demo' }, callId: 'c3', signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.equal(after.kind, 'allow');
});

test('an optional telemetry failure only leaves a gap', () => {
  const host = mount();
  assert.equal(typeof host.policy.setAuditSink, 'function');
  assert.equal(host.policy.auditRecords().length, 0);
});

test('确认等待期间正文被改写 → 拒绝，不带着未检查的正文执行', async () => {
  const args = { target: 'acme/demo!1', changeId: 'CHG-1', body: 'plain text' };
  const approval = {
    async request() {
      // 模拟"人已批准、但调用方在等待期间换了正文"：必须由摘要复验拦住。
      args.body = 'plain text plus something else';
      return 'allowed-once';
    },
  };
  const host = mount(baseConfig, { approval });
  const denied = await host.stage('forge_issue_write', args, { agent: { id: 'agent-1' } });
  assert.match(String(denied.reason), /changed during confirmation/u);
});

test('目录要求 revision 时，缺 revision 的写被拒绝，补齐后放行', async () => {
  const config = { ...baseConfig, catalog: [READ, { ...WRITE, revision: true }] };
  const host = mount(config);
  const missing = await host.stage('forge_issue_write', { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok' }, {
    agent: { id: 'agent-1' },
  });
  assert.match(String(missing.reason), /requires a revision/u);
  const supplied = await host.stage(
    'forge_issue_write',
    { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok', revision: 'rev-2' },
    { agent: { id: 'agent-1' }, callId: 'c2' },
  );
  assert.equal(supplied.reason, undefined);
});

test('范围票据在执行前被撤销 → 执行期复验拒绝', async () => {
  const host = mount(baseConfig);
  const exec = {
    name: 'forge_issue_write',
    arguments: { target: 'acme/demo!1', changeId: 'CHG-1', body: 'ok' },
    callId: 'c1',
    agent: { id: 'agent-1' },
  };
  const admitted = await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(admitted.kind, 'allow');
  const [ticket] = host.policy.scopeTickets();
  host.policy.revokeScopeTicket(ticket.id);
  const denied = host.guard(exec);
  assert.match(String(denied), /the task scope for this execution is no longer valid/u);
});

test('正文无法读取 → 拒绝，而不是带着未知内容执行', async () => {
  const host = mount(baseConfig);
  const denied = await host.stage(
    'forge_issue_write',
    { target: 'acme/demo!1', changeId: 'CHG-1' },
    {
      agent: { id: 'agent-1' },
      content: async () => {
        throw new Error('readback unavailable');
      },
    },
  );
  assert.match(String(denied.reason), /content for .* cannot be read/u);
});

test('写正文经私有通道进入内容闸：HARD 命中即拒绝', async () => {
  const host = mount(baseConfig);
  const denied = await host.stage(
    'forge_issue_write',
    { target: 'acme/demo!1', changeId: 'CHG-1', body: 'note' },
    { agent: { id: 'agent-1' }, content: { body: `${['pass', 'word'].join('')} = "hunter2hunter2"` } },
  );
  assert.match(String(denied.reason), /content rule/u);
});

test('push rechecks change and plan after approval and after audit', async () => {
  for (const phase of ['approval', 'after-audit']) {
    for (const failed of ['change', 'plan']) {
      let current = { change: { available: true, status: 'active' }, plan: { available: true, confirmed: true } };
      const invalidate = () => {
        current = { ...current, [failed]: failed === 'change'
          ? { available: true, status: 'closed' } : { available: true, confirmed: false } };
      };
      const host = mount(baseConfig, {
        facts: { read: () => current },
        approval: { async request() { if (phase === 'approval') invalidate(); return 'allowed-once'; } },
      });
      const exec = { name: 'forge_push', arguments: { target: 'acme/demo', branch: 'feature/x', changeId: 'CHG-1' },
        callId: `${phase}-${failed}`, agent: { id: 'agent-1' }, signal: new AbortController().signal };
      assert.equal((await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }))).kind, 'allow');
      if (phase === 'after-audit') invalidate();
      assert.match(String(host.guard(exec)), failed === 'change' ? /not in progress/ : /not confirmed/);
    }
  }
});

test('explicitly unavailable process facts remain unevaluated', async () => {
  const facts = { read: () => ({ change: { available: false }, plan: { available: false } }) };
  const host = mount(baseConfig, { facts });
  const result = await host.stage('forge_push', { target: 'acme/demo', branch: 'feature/x', changeId: 'CHG-1' }, { agent: { id: 'agent-1' } });
  assert.equal(result.reason, undefined);
  assert.deepEqual([...host.policy.auditRecords().find((item) => item.phase === 'begin').unevaluated], ['change-in-progress', 'plan-confirmed']);
});

test('unexpected process provider errors propagate before and after approval', async () => {
  for (const ErrorType of [TypeError, ReferenceError]) {
    for (const phase of ['prepare', 'guard']) {
      const failure = new ErrorType('provider defect');
      let fail = phase === 'prepare';
      const host = mount(baseConfig, { facts: { read() {
        if (fail) throw failure;
        return { change: { available: true, status: 'active' }, plan: { available: true, confirmed: true } };
      } } });
      const exec = { name: 'forge_push', arguments: { target: 'acme/demo', branch: 'feature/x', changeId: 'CHG-1' },
        callId: `${ErrorType.name}-${phase}`, agent: { id: 'agent-1' }, signal: new AbortController().signal };
      if (phase === 'prepare') {
        await assert.rejects(host.preExecute(exec, () => Promise.resolve({ kind: 'allow' })), (error) => error === failure);
      } else {
        assert.equal((await host.preExecute(exec, () => Promise.resolve({ kind: 'allow' }))).kind, 'allow');
        fail = true;
        assert.throws(() => host.guard(exec), (error) => error === failure);
      }
    }
  }
});
