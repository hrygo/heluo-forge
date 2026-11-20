import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRM_CODES, CONFIRM_LABELS, createConfirmationGateway } from '../src/confirm.mjs';

const questions = Object.freeze([{
  id: 'forge-policy-action',
  header: '动作确认',
  question: '允许推送分支 feat/x？',
  detail: '确认后立即执行；不选择视为取消。',
  options: [{ label: CONFIRM_LABELS.allow }, { label: CONFIRM_LABELS.deny }],
}]);

const askFor = (gateway, extra = {}) => gateway.ask({
  ctx: {}, agent: { kind: 'agent' }, action: 'gitee.git.push', questions, ...extra,
});

const answering = (selected = CONFIRM_LABELS.allow) => ({
  calls: 0,
  ask(request) {
    this.calls += 1;
    return Promise.resolve({ answers: request.questions.map((question) => ({ id: question.id, selected: [selected] })) });
  },
});

const failing = (code) => ({ ask: () => Promise.reject(Object.assign(new Error('synthetic host failure'), { code })) });

test('a complete answer resolves to allow and releases the pending slot', async () => {
  const service = answering();
  const gateway = createConfirmationGateway({ resolveService: () => service });
  const verdict = await askFor(gateway);
  assert.deepEqual(verdict, { decision: 'allow' });
  assert.equal(service.calls, 1);
  assert.equal(gateway.pending(), 0);
  assert.equal(service.ask.length, 1);
});

test('the deny label wins and never reaches the caller as an allow', async () => {
  const gateway = createConfirmationGateway({ resolveService: () => answering(CONFIRM_LABELS.deny) });
  assert.deepEqual(await askFor(gateway), { decision: 'deny', code: CONFIRM_CODES.DENIED });
});

test('a silent client times out instead of hanging the gate', async () => {
  const gateway = createConfirmationGateway({ resolveService: () => ({ ask: () => new Promise(() => {}) }), timeoutMs: 25 });
  const verdict = await askFor(gateway);
  assert.deepEqual(verdict, { decision: 'deny', code: CONFIRM_CODES.TIMEOUT });
  assert.equal(gateway.pending(), 0);
});

test('the timeout is enforced by our own timer, and that timer is cleared', async () => {
  const scheduled = [], cleared = [];
  const gateway = createConfirmationGateway({
    resolveService: () => ({ ask: () => new Promise(() => {}) }),
    timeoutMs: 5_000,
    setTimer: (callback, ms) => (scheduled.push({ callback, ms }), scheduled.length - 1),
    clearTimer: (id) => cleared.push(id),
  });
  const pending = askFor(gateway);
  await Promise.resolve();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 5_000);
  assert.equal(gateway.pending(), 1, 'the pending ask is observable while it waits');
  scheduled[0].callback();
  assert.deepEqual(await pending, { decision: 'deny', code: CONFIRM_CODES.TIMEOUT });
  assert.deepEqual(cleared, [0]);
});

test('a channel that cannot be resolved refuses without ever asking', async () => {
  const missing = createConfirmationGateway({ resolveService: () => undefined });
  assert.deepEqual(await askFor(missing), { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE });

  const broken = createConfirmationGateway({ resolveService: () => { throw new Error('synthetic'); } });
  assert.deepEqual(await askFor(broken), { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE });

  const noAsk = createConfirmationGateway({ resolveService: () => ({ ask: 'nope' }) });
  assert.deepEqual(await askFor(noAsk), { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE });

  const counting = answering();
  const noAgent = createConfirmationGateway({ resolveService: () => counting });
  assert.deepEqual(await askFor(noAgent, { agent: undefined }), { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE });
  assert.deepEqual(await askFor(noAgent, { agent: null }), { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE });
  assert.equal(counting.calls, 0, 'no live session means no card at all');
});

test('a subagent never gets a confirmation card', async () => {
  const counting = answering();
  const gateway = createConfirmationGateway({ resolveService: () => counting });
  const verdict = await askFor(gateway, { agent: { session: { header: { origin: 'subagent' } } } });
  assert.deepEqual(verdict, { decision: 'deny', code: CONFIRM_CODES.DELEGATED });
  assert.equal(counting.calls, 0);
});

test('host error codes map onto exactly one of our codes each', async () => {
  const cases = new Map([
    ['NO_PROVIDER', CONFIRM_CODES.UNAVAILABLE],
    ['DELEGATED_CALLER', CONFIRM_CODES.DELEGATED],
    ['CALLER_NOT_LIVE', CONFIRM_CODES.DELEGATED],
    ['ASK_ABORTED', CONFIRM_CODES.TIMEOUT],
    ['BAD_INTENT', CONFIRM_CODES.ERROR],
    [undefined, CONFIRM_CODES.ERROR],
  ]);
  for (const [hostCode, expected] of cases) {
    const gateway = createConfirmationGateway({ resolveService: () => failing(hostCode) });
    const verdict = await askFor(gateway);
    assert.deepEqual(verdict, { decision: 'deny', code: expected }, `host code ${hostCode}`);
  }
});

test('an invalid answer from the host is a refusal, not a crash', async () => {
  for (const answer of [undefined, {}, { answers: [] }, { answers: [{ id: 'forge-policy-action', selected: ['yes'] }] }]) {
    const gateway = createConfirmationGateway({ resolveService: () => ({ ask: () => Promise.resolve(answer) }) });
    const verdict = await askFor(gateway);
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.code, CONFIRM_CODES.INVALID_ANSWER);
  }
});

test('dispose releases in-flight asks and refuses later ones', async () => {
  const abortable = {
    ask: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })));
    }),
  };
  const gateway = createConfirmationGateway({ resolveService: () => abortable, timeoutMs: 5_000 });
  const pending = askFor(gateway);
  await Promise.resolve();
  assert.equal(gateway.pending(), 1);
  gateway.dispose();
  assert.equal(gateway.pending(), 0);
  assert.deepEqual(await pending, { decision: 'deny', code: CONFIRM_CODES.TIMEOUT });
  assert.deepEqual(await askFor(gateway), { decision: 'deny', code: CONFIRM_CODES.ERROR });
});

test('concurrent asks each keep their own slot', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = {
    calls: 0,
    ask(request) {
      this.calls += 1;
      return gate.then(() => ({ answers: request.questions.map((question) => ({ id: question.id, selected: [CONFIRM_LABELS.allow] })) }));
    },
  };
  const gateway = createConfirmationGateway({ resolveService: () => service, timeoutMs: 5_000 });
  const first = askFor(gateway), second = askFor(gateway);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gateway.pending(), 2);
  assert.equal(service.calls, 2);
  release();
  assert.deepEqual(await first, { decision: 'allow' });
  assert.deepEqual(await second, { decision: 'allow' });
  assert.equal(gateway.pending(), 0);
});
