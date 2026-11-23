import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRM_LABELS } from '../src/confirm.mjs';
import { apply } from '../src/index.mjs';
import { WIRED_PROCESS_RULES, evaluateProcessRules } from '../src/process-rules.mjs';

const CATALOG = [
  { action: 'gitee.git.push', target: 'repository', category: 'remote-write' },
  { action: 'gitee.pr.write', target: 'pull-request', category: 'dev-write' },
  { action: 'gitee.review.publish', target: 'pull-request', category: 'review-write' },
];

const answering = (selected = CONFIRM_LABELS.allow) => ({
  calls: [],
  ask(request) {
    this.calls.push(request);
    return Promise.resolve({ answers: request.questions.map((question) => ({ id: question.id, selected: [selected] })) });
  },
});

function mount({ rules = {}, userQuestions } = {}) {
  const services = new Map();
  services.set('iam', { getView: () => ({ signedIn: true, principal: { subject: 'svc-policy-test' } }) });
  if (userQuestions !== undefined) services.set('userQuestions', userQuestions);
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: () => () => {},
    tools: { guard: () => () => {} },
    logger: { warn: () => {} },
  };
  const dispose = apply(ctx, { audit: { sink: 'memory' }, rules, catalog: CATALOG });
  return { policy: services.get('policy'), ctx, dispose };
}

const pushExec = (args = {}, callId = 'call-push') => ({
  name: 'forge_gitee_write',
  arguments: { target: 'corp.example/repo', branch: 'feat/x', ...args },
  callId,
  agent: { kind: 'agent' },
});

// 生产入参形状：正文在 `exec.content`，参数只带操作与定位字段（Gitee 工具的真实形状）。
const prExec = ({ args = {}, content = undefined } = {}, callId = 'call-pr') => ({
  name: 'forge_gitee_pr_write',
  arguments: { target: 'corp.example/repo', ...args },
  ...(content === undefined ? {} : { content }),
  callId,
  agent: { kind: 'agent' },
});

const createExec = (body, extra = {}) => prExec({ args: { op: 'create', title: 'x', ...extra }, content: { title: 'x', body } });

const reviewExec = (review, callId = 'call-review') => ({
  name: 'forge_gitee_review_publish',
  arguments: { target: 'corp.example/repo', commit: 'abc1234', changeId: 'CHG-1' },
  content: { review },
  callId,
  agent: { kind: 'agent' },
});

// `forge_gitee_review_publish` 自己追加的页脚（见 packages/forge-gitee/src/gitee-actions.mjs）。
const REVIEW_FOOTER = '\n\n---\n> AI 生成：provider=gitee · PR 版本：abc1234 · 变更 CHG-1 · 人工结论不在此处代写';

const denial = async (policy, ctx, action, exec) => {
  let ran = 0;
  const result = await policy.executeAction(ctx, action, exec, async () => (ran += 1, { ok: true }));
  return { result, ran };
};

test('开关关闭时推 main 照常走：流程闸不改变默认行为', async () => {
  const h = mount();
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.git.push', pushExec({ branch: 'main' }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  const records = h.policy.auditRecords();
  assert.equal(records[0].rule, 'registered-write');
  assert.equal(records[0].ruleIds, undefined, '没有命中就不该编造规则名');
  h.dispose();
});

test('开启后推保护分支被拒，并说明是哪条流程规则', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.git.push', pushExec({ branch: 'main' }));
  assert.equal(ran, 0, '拒绝不做任何写入');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /流程前置条件/u);
  assert.match(result.text, /push-protected-branch/u);
  assert.doesNotMatch(result.text, /POLICY_/u, '对外文案不出现内部错误码');
  const record = h.policy.auditRecords().at(-1);
  assert.equal(record.decision, 'deny');
  assert.equal(record.rule, 'process-rule-denied');
  assert.deepEqual(record.ruleIds, ['push-protected-branch']);
  h.dispose();
});

test('开启后强制推送被拒', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.git.push', pushExec({ force: true }));
  assert.equal(ran, 0);
  assert.match(result.text, /push-force/u);
  h.dispose();
});

test('开启后普通分支推送照常放行', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.git.push', pushExec({ branch: 'feat/y' }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  h.dispose();
});

test('缺验收小节是软命中：没有卡片通道时放行，但审计留下规则名', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.pr.write', createExec('只说改了什么'));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  const record = h.policy.auditRecords()[0];
  assert.deepEqual(record.ruleIds, ['pr-acceptance-section']);
  h.dispose();
});

test('缺验收小节 + 有卡片通道时弹一张「流程条件」卡', async () => {
  const channel = answering();
  const h = mount({ rules: { enforceProcessRules: true }, userQuestions: channel });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.pr.write', createExec('只说改了什么'));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  assert.equal(channel.calls.length, 1, '通道可用就该问，不必等某个确认开关打开');
  assert.equal(channel.calls[0].questions.length, 1);
  assert.equal(channel.calls[0].questions[0].header, '流程条件');
  h.dispose();
});

test('软命中但确认开关打开、宿主没有应答端时按放行处理，不报确认不可用', async () => {
  const h = mount({ rules: { enforceProcessRules: true, confirmPush: true, confirmDopWrite: true } });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.pr.write', createExec('只说改了什么'));
  assert.deepEqual(result, { ok: true }, '没有应答端不等于流程不满足，也不该拒绝');
  assert.equal(ran, 1);
  const record = h.policy.auditRecords()[0];
  assert.deepEqual(record.ruleIds, ['pr-acceptance-section']);
  h.dispose();
});

test('带验收小节就放行，不写规则名（正文来自 content 快照）', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { ran } = await denial(h.policy, h.ctx, 'gitee.pr.write', createExec('## 验收\n- 用例全绿'));
  assert.equal(ran, 1);
  assert.equal(h.policy.auditRecords()[0].ruleIds, undefined);
  h.dispose();
});

test('正文读不到时软硬流程规则都不判，按放行并留审计', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const exec = prExec({ args: { op: 'create', title: 'x' }, content: () => Promise.reject(new Error('unreadable')) });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.pr.write', exec);
  assert.deepEqual(result, { ok: true }, '看不见正文不等于没有正文');
  assert.equal(ran, 1);
  h.dispose();
});

test('评审正文缺 AI 来源与目标版本时被拒', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.review.publish', reviewExec('这段实现有问题'));
  assert.equal(ran, 0);
  assert.match(result.text, /review-ai-source/u);
  h.dispose();
});

test('评审正文自带工具页脚时放行（生产形状）', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { ran } = await denial(h.policy, h.ctx, 'gitee.review.publish', reviewExec(`- 结论…${REVIEW_FOOTER}`));
  assert.equal(ran, 1);
  h.dispose();
});

test('评审正文缺失（正文形状变化）时不判，按放行处理', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.review.publish', reviewExec(''));
  assert.deepEqual(result, { ok: true }, '正文快照里没有评审正文时不能硬拒');
  assert.equal(ran, 1);
  h.dispose();
});

test('普通 PR 评论不受评审门禁约束', async () => {
  const h = mount({ rules: { enforceProcessRules: true } });
  const comment = prExec({ args: { op: 'comment' }, content: { body: '这段实现有问题' } }, 'call-comment');
  const { result, ran } = await denial(h.policy, h.ctx, 'gitee.pr.write', comment);
  assert.deepEqual(result, { ok: true }, '同步状态、回应讨论的评论不该被当成评审拒掉');
  assert.equal(ran, 1);
  h.dispose();
});

test('流程规则只在自己声明的动作上生效', () => {
  const skipped = evaluateProcessRules({
    rules: WIRED_PROCESS_RULES,
    facts: { branch: 'main' },
    action: 'gitee.pr.write',
  });
  assert.deepEqual(skipped.deny, [], '推送规则不该管建 PR');
  const push = evaluateProcessRules({
    rules: WIRED_PROCESS_RULES,
    facts: { branch: 'main' },
    action: 'gitee.git.push',
  });
  assert.deepEqual(push.deny.map((item) => item.rule), ['push-protected-branch']);
});

test('依赖事实源的两条规则不参与当前判定', () => {
  assert.deepEqual([...WIRED_PROCESS_RULES], [
    'push-protected-branch', 'push-force', 'pr-acceptance-section', 'review-ai-source',
  ]);
  const evaluated = evaluateProcessRules({ rules: WIRED_PROCESS_RULES, facts: {}, action: 'gitee.git.push' });
  assert.deepEqual(evaluated.unevaluated, [], '"查不到事实"不该出现在已接线的规则里');
});
