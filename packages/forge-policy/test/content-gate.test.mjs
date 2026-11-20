import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRM_CODES, CONFIRM_LABELS } from '../src/confirm.mjs';
import { apply } from '../src/index.mjs';

const CATALOG = [
  { action: 'gitee.git.push', target: 'repository', category: 'remote-write' },
  { action: 'change.clarification.write', target: 'change', category: 'dev-write' },
  { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' },
  { action: 'gitee.pr.write', target: 'pull-request', category: 'dev-write' },
  { action: 'gitee.review.publish', target: 'pull-request', category: 'review-write' },
];

const PEM = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const TOKEN = ['ghp', 'A'.repeat(24)].join('_');

const answering = (selected = CONFIRM_LABELS.allow) => ({
  calls: [],
  ask(request) {
    this.calls.push(request);
    return Promise.resolve({ answers: request.questions.map((question) => ({ id: question.id, selected: [selected] })) });
  },
});

function mount({ rules = {}, confirmation, content, userQuestions } = {}) {
  const services = new Map(), listeners = new Map(), guards = [];
  services.set('iam', { getView: () => ({ signedIn: true, principal: { subject: 'svc-policy-test' } }) });
  if (userQuestions !== undefined) services.set('userQuestions', userQuestions);
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
    logger: { warn() {} },
  };
  const dispose = apply(ctx, {
    audit: { sink: 'memory' },
    rules,
    catalog: CATALOG,
    tools: { forge_gitee_write: 'gitee.issue.write' },
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(content === undefined ? {} : { content }),
  });
  return { policy: services.get('policy'), ctx, dispose, guards, listeners };
}

const issueExec = (body, callId = 'call-issue') => ({
  name: 'forge_gitee_write',
  arguments: { target: 'corp.example/repo', title: '标题', body },
  callId,
  agent: { kind: 'agent' },
});

const pushExec = (message, callId = 'call-push') => ({
  name: 'forge_gitee_write',
  arguments: { target: 'corp.example/repo', branch: 'feat/x', commits: [{ message }] },
  callId,
  agent: { kind: 'agent' },
});

test('规则关闭时不扫内容：同样的私钥照样放行（默认全关）', async () => {
  const h = mount({ rules: {} });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', issueExec(`见\n${PEM}`), async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  assert.equal(h.policy.auditRecords().some((record) => record.ruleIds !== undefined), false);
  h.dispose();
});

test('hard 命中直接拒绝，不弹卡、不执行、留 residue 证据', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true, confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', issueExec(`见\n${PEM}`), async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(channel.calls.length, 0, 'hard 不可确认：连卡片都不弹');
  assert.equal(result.code, 'POLICY_CONTENT_HARD');
  assert.doesNotMatch(result.text, /PRIVATE KEY/u, '拒绝文案不复述命中的内容');
  const records = h.policy.auditRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'deny');
  assert.equal(records[0].rule, 'content-hard-block');
  assert.deepEqual(records[0].ruleIds, ['BUILTIN-PRIVATE-KEY']);
  h.dispose();
});

test('内容风险与动作确认合并成一张分步卡：两题、一次提交', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true, confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', pushExec(`提交里带了 ${TOKEN}`), async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  assert.equal(channel.calls.length, 1);
  assert.deepEqual(channel.calls[0].questions.map((question) => question.id), [
    'forge-policy-action',
    'forge-policy-content',
  ]);
  const records = h.policy.auditRecords();
  assert.deepEqual(records.map((record) => record.phase), ['asked', 'answered', 'begin', 'settle']);
  assert.deepEqual(records[0].ruleIds, ['BUILTIN-TOKEN']);
  assert.equal(records[2].decision, 'allow');
  h.dispose();
});

test('只有内容确认、没有通道时拒绝，而不是静默放行', async () => {
  const h = mount({ rules: { contentGate: true } });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', issueExec(`token: ${TOKEN}`), async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(result.code, CONFIRM_CODES.UNAVAILABLE);
  h.dispose();
});

test('内容确认被拒绝时零执行', async () => {
  const channel = answering(CONFIRM_LABELS.deny);
  const h = mount({ rules: { contentGate: true }, userQuestions: channel });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', issueExec(`token: ${TOKEN}`), async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(result.code, CONFIRM_CODES.DENIED);
  assert.equal(channel.calls.length, 1);
  h.dispose();
});

test('软命中在确认开关关闭时只记账放行（D36）', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true }, userQuestions: channel });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', issueExec('见 .env.production 的配置'), async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  assert.equal(channel.calls.length, 0, '没有确认动作时，软命中不打扰人');
  assert.deepEqual(h.policy.auditRecords()[0].ruleIds, ['BUILTIN-ENV-FILE']);
  h.dispose();
});

test('软命中在本来就要确认时升级成分步卡', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true, confirmPush: true }, userQuestions: channel });
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', pushExec('见 .env.production 的配置'), async () => ({ ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(channel.calls.length, 1);
  assert.deepEqual(channel.calls[0].questions.map((question) => question.id), [
    'forge-policy-action',
    'forge-policy-content',
  ]);
  h.dispose();
});

test('正文超出预算时按已扫部分判定，并在审计里标出截断', async () => {
  const h = mount({ rules: { contentGate: true }, content: { maxBytes: 512 } });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', issueExec('x'.repeat(2_000)), async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  const begin = h.policy.auditRecords()[0];
  assert.deepEqual(begin.contentSkipped, ['body:truncated']);
  assert.equal(begin.truncated, true);
  h.dispose();
});

test('正文读不到时放行并如实告警（D48）', async () => {
  const h = mount({ rules: { contentGate: true } });
  let ran = 0;
  const exec = {
    ...issueExec('正文不在参数里'),
    content: async () => { throw new Error('synthetic readRange failure'); },
  };
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', exec, async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  assert.deepEqual(h.policy.auditRecords()[0].contentSkipped, ['content:unreadable']);
  h.dispose();
});

test('受控扫描接口的分类进入内容闸：被脱敏的令牌仍形成内容确认（D86）', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true, confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const sha = 'a'.repeat(40);
  const exec = {
    ...pushExec('提交正文已在出口脱敏'),
    content: async () => ({ sha, commits: [], redactions: [{ sha, field: 'commits[0]', kind: 'token' }] }),
  };
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec, async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  assert.deepEqual(channel.calls[0].questions.map((question) => question.id), [
    'forge-policy-action',
    'forge-policy-content',
  ]);
  const records = h.policy.auditRecords();
  assert.deepEqual(records[0].ruleIds, ['BUILTIN-TOKEN']);
  assert.deepEqual(records[2].ruleIds, ['BUILTIN-TOKEN']);
  assert.equal(records[2].contentSkipped, undefined, '已分类的脱敏不记为未扫全');
  h.dispose();
});

test('无法分类的脱敏按未完整扫描记账，asked/answered/begin 三处一致', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true, confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const exec = {
    ...pushExec('提交正文已在出口脱敏'),
    content: async () => ({ sha: 'b'.repeat(40), commits: [], redactions: [{ field: 'commits[0]', kind: 'fingerprint' }] }),
  };
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec, async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  const records = h.policy.auditRecords();
  assert.deepEqual(records.map((record) => record.phase), ['asked', 'answered', 'begin', 'settle']);
  for (const record of records.slice(0, 3)) {
    assert.deepEqual(record.contentSkipped, ['commits[0]:redaction-unknown']);
  }
  h.dispose();
});

test('普通对象正文在确认期间被改写：复验拒绝且零执行', async () => {
  const exec = { ...issueExec('标题'), content: { body: `token ${TOKEN}` } };
  const channel = {
    calls: [],
    ask(request) {
      this.calls.push(request);
      exec.content.body = '改写后的正文';
      return Promise.resolve({
        answers: request.questions.map((question) => ({ id: question.id, selected: [CONFIRM_LABELS.allow] })),
      });
    },
  };
  const h = mount({ rules: { contentGate: true }, userQuestions: channel });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', exec, async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /正文内容发生变化/u);
  assert.ok(h.policy.auditRecords().some((record) => record.rule === 'content-changed'));
  h.dispose();
});

test('宿主同步守卫拒绝被改写的普通对象正文', async () => {
  const h = mount({ rules: { contentGate: true } });
  const exec = { ...issueExec('标题'), content: { body: '没有风险' } };
  const preExecute = h.listeners.get('tools/pre-execute');
  assert.equal((await preExecute(exec, async () => ({ kind: 'allow' }))).kind, 'allow');
  exec.content.body = '改写后的正文';
  assert.match(String(h.guards[0](exec)), /content changed after the call was admitted/u);
  h.dispose();
});

test('扫描器异常按不可确认拒绝：不弹卡、不执行、证据可追（fail-closed）', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true, confirmPush: true }, userQuestions: channel });
  // 非枚举的取正文属性：摘要不受影响，扫描字段展开时才抛错（模拟扫描器自身失败）。
  const args = { target: 'corp.example/repo', title: '标题' };
  Object.defineProperty(args, 'body', {
    enumerable: false,
    configurable: true,
    get() { throw new Error('scan boom'); },
  });
  const exec = { name: 'forge_gitee_write', arguments: args, callId: 'call-scan-fail', agent: { kind: 'agent' } };
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', exec, async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(channel.calls.length, 0, '扫描失败不可确认：连卡片都不弹');
  assert.equal(result.code, 'POLICY_CONTENT_SCAN_FAILED');
  const records = h.policy.auditRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'deny');
  assert.equal(records[0].rule, 'content-scan-failed');
  assert.deepEqual(records[0].contentSkipped, ['content:scan-failed']);
  h.dispose();
});

test('正文读不到时确认结论不进入复用缓存：重试仍要重新确认（D89）', async () => {
  const channel = answering();
  const h = mount({ rules: { contentGate: true, confirmPush: true }, userQuestions: channel });
  const unreadable = () => ({
    ...pushExec('提交正文', 'call-unreadable'),
    content: async () => { throw new Error('readback unavailable'); },
  });
  const first = await h.policy.executeAction(h.ctx, 'gitee.git.push', unreadable(), async () => ({ ok: true }));
  assert.deepEqual(first, { ok: true });
  assert.equal(channel.calls.length, 1);
  const second = await h.policy.executeAction(h.ctx, 'gitee.git.push', unreadable(), async () => ({ ok: true }));
  assert.deepEqual(second, { ok: true });
  assert.equal(channel.calls.length, 2, '看不见的正文不能被当作同一份内容复用');
  assert.equal(h.policy.auditRecords().some((record) => record.rule === 'reused-decision'), false);
  h.dispose();
});
