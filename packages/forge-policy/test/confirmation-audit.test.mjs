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

const answering = (selected = CONFIRM_LABELS.allow) => ({
  calls: [],
  ask(request) {
    this.calls.push(request);
    return Promise.resolve({ answers: request.questions.map((question) => ({ id: question.id, selected: [selected] })) });
  },
});

function mount({ rules = {}, confirmation, userQuestions, getView, sink } = {}) {
  const services = new Map(), listeners = new Map(), guards = [], warnings = [];
  services.set('iam', {
    getView: getView ?? (() => ({ signedIn: true, principal: { subject: 'svc-policy-test' } })),
  });
  if (userQuestions !== undefined) services.set('userQuestions', userQuestions);
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
    logger: { warn: (message) => warnings.push(message) },
  };
  const dispose = apply(ctx, {
    audit: { sink: 'memory' },
    rules,
    ...(confirmation === undefined ? {} : { confirmation }),
    catalog: CATALOG,
  });
  const policy = services.get('policy');
  if (sink !== undefined) policy.setAuditSink(sink);
  return { policy, ctx, listeners, guards, dispose, warnings, services };
}

const pushExec = (callId = 'call-push') => ({
  name: 'forge_gitee_write',
  arguments: { target: 'corp.example/repo', branch: 'feat/x' },
  callId,
  agent: { kind: 'agent' },
});

test('an allowed confirmation is one asked record, one answered record, then the receipt', async () => {
  const channel = answering();
  const h = mount({ rules: { confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', pushExec(), async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1);
  assert.equal(channel.calls.length, 1);
  assert.equal(channel.calls[0].questions.length, 1, 'the card carries exactly the merged reasons');
  assert.equal(channel.calls[0].agent?.kind, 'agent', 'the live session agent is forwarded to the host');
  assert.equal(channel.calls[0].signal instanceof AbortSignal, true, 'the host gets an abort signal for its pending question');

  const records = h.policy.auditRecords();
  assert.deepEqual(records.map((record) => record.phase), ['asked', 'answered', 'begin', 'settle']);
  assert.equal(records[0].decision, 'pending');
  assert.equal(records[0].rule, 'confirm-required');
  assert.equal(records[0].operationId, 'call-push');
  assert.equal(records[0].agent.kind, 'agent');
  assert.match(records[0].summary, /需要人工确认/u);
  assert.equal(records[1].decision, 'allow');
  assert.equal(records[1].code, undefined, 'an allow never writes a code');
  assert.equal(typeof records[1].durationMs, 'number');
  assert.equal(records[2].rule, 'confirm-allowed');
  h.dispose();
});

test('a refusal is recorded with its code and never begins a receipt', async () => {
  const channel = answering(CONFIRM_LABELS.deny);
  const h = mount({ rules: { confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', pushExec(), async () => (ran++, { ok: true }));
  assert.equal(ran, 0, 'a refusal executes nothing');
  assert.equal(result.kind, 'error');
  assert.equal(result.code, CONFIRM_CODES.DENIED);
  assert.doesNotMatch(result.text, /POLICY_/u, 'the user copy never spells out the code');
  const records = h.policy.auditRecords();
  assert.deepEqual(records.map((record) => record.phase), ['asked', 'answered']);
  assert.equal(records[1].decision, 'deny');
  assert.equal(records[1].code, CONFIRM_CODES.DENIED);
  assert.match(records[1].summary, /取消本次写入/u);
  h.dispose();
});

test('a timeout says so and is never written as a refusal by the human', async () => {
  const short = mount({
    rules: { confirmPush: true },
    confirmation: { timeoutMs: 20 },
    userQuestions: { ask: () => new Promise(() => {}) },
  });
  let ran = 0;
  const result = await short.policy.executeAction(short.ctx, 'gitee.git.push', pushExec(), async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(result.code, CONFIRM_CODES.TIMEOUT);
  assert.match(result.text, /超时/u);
  assert.doesNotMatch(result.text, /取消本次写入|拒绝本次写入/u, 'a timeout must not be dressed up as a human refusal');
  const answered = short.policy.auditRecords().at(-1);
  assert.equal(answered.phase, 'answered');
  assert.equal(answered.code, CONFIRM_CODES.TIMEOUT);
  assert.match(answered.summary, /等待超时/u);
  short.dispose();
});

test('a missing channel refuses, warns at mount, and asks nobody', async () => {
  const h = mount({ rules: { confirmPush: true } });
  assert.equal(h.policy.confirmationAvailable(), false);
  assert.equal(h.warnings.some((message) => /userQuestions/u.test(message)), true, 'the missing channel is announced at mount time');
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', pushExec(), async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(result.code, CONFIRM_CODES.UNAVAILABLE);
  assert.doesNotMatch(result.text, /超时/u, 'a missing channel is not a timeout');
  assert.deepEqual(h.policy.auditRecords().map((record) => record.phase), ['asked', 'answered']);
  h.dispose();
});

test('only push and DOP clarification ask, the other writes go straight through', async () => {
  const channel = answering();
  const h = mount({ rules: { confirmPush: true, confirmDopWrite: true }, userQuestions: channel });
  const calls = [];
  const execFor = (name, callId, action) => ({ name, arguments: { target: 'corp.example/repo' }, callId, agent: { kind: 'agent' }, action });
  for (const [action, callId] of [
    ['gitee.issue.write', 'c1'], ['gitee.pr.write', 'c2'], ['gitee.review.publish', 'c3'],
  ]) {
    const result = await h.policy.executeAction(h.ctx, action, execFor('forge_gitee_write', callId), async () => (calls.push(action), { ok: true }));
    assert.equal(result.ok, true, `${action} runs without a card`);
  }
  assert.equal(channel.calls.length, 0, 'the two switches only cover their own actions');

  const dop = await h.policy.executeAction(h.ctx, 'change.clarification.write', {
    name: 'devops.change.update', arguments: { target: 'change-1' }, callId: 'c4', agent: { kind: 'agent' },
  }, async () => (calls.push('dop'), { ok: true }));
  assert.deepEqual(dop, { ok: true });
  assert.equal(channel.calls.length, 1, 'the DOP clarification asks once');
  assert.deepEqual(calls, ['gitee.issue.write', 'gitee.pr.write', 'gitee.review.publish', 'dop']);
  h.dispose();
});

test('a subagent write is refused with one record and no card', async () => {
  const channel = answering();
  const h = mount({ rules: { denyDelegatedWrites: true, confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const exec = { ...pushExec(), agent: { kind: 'agent', session: { header: { origin: 'subagent' } } } };
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec, async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(result.code, CONFIRM_CODES.DELEGATED);
  assert.match(result.text, /主会话/u);
  assert.doesNotMatch(result.text, /换一个工具|拆成|绕过/u);
  assert.equal(channel.calls.length, 0, 'a subagent never sees a card');
  const records = h.policy.auditRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'deny');
  assert.equal(records[0].phase, undefined, 'a delegation refusal is a single decision record');
  assert.equal(records[0].code, CONFIRM_CODES.DELEGATED);
  assert.equal(records[0].agent.kind, 'child');
  assert.match(records[0].summary, /子代理/u);
  h.dispose();
});

test('with the delegation rule off, a subagent needing a card is refused by the card path', async () => {
  const channel = answering();
  const h = mount({ rules: { confirmPush: true }, userQuestions: channel });
  let ran = 0;
  const exec = { ...pushExec(), agent: { kind: 'agent', session: { header: { origin: 'subagent' } } } };
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec, async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(result.code, CONFIRM_CODES.DELEGATED);
  assert.equal(channel.calls.length, 0);
  const records = h.policy.auditRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].rule, 'confirm-delegated-refused');
  h.dispose();
});

test('when the asked record cannot be written the card is never shown', async () => {
  const channel = answering();
  const h = mount({ rules: { confirmPush: true }, userQuestions: channel });
  h.policy.setAuditSink({
    durable: true,
    append(record) {
      if (record.phase === 'asked') throw new Error('synthetic sink failure');
    },
  });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', pushExec(), async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(channel.calls.length, 0, 'no record means no question');
  assert.equal(result.code, CONFIRM_CODES.ERROR);
  assert.match(result.text, /没有留下可用记录/u);
  assert.doesNotMatch(result.text, /审计/u, 'the user copy does not talk about the audit trail');
  h.dispose();
});

test('the answered record carries the elapsed time of the human decision', async () => {
  const channel = {
    askedAt: undefined,
    async ask(request) {
      const started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 15));
      this.askedAt = Date.now() - started;
      return { answers: request.questions.map((question) => ({ id: question.id, selected: [CONFIRM_LABELS.allow] })) };
    },
  };
  const h = mount({ rules: { confirmPush: true }, userQuestions: channel });
  await h.policy.executeAction(h.ctx, 'gitee.git.push', pushExec(), async () => ({ ok: true }));
  const answered = h.policy.auditRecords().find((record) => record.phase === 'answered');
  assert.equal(typeof answered.durationMs, 'number');
  assert.equal(answered.durationMs >= channel.askedAt, true, 'the recorded duration covers the wait for the human');
  assert.equal(answered.decision, 'allow');
  h.dispose();
});
