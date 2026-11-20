import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRM_LABELS } from '../src/confirm.mjs';
import { apply } from '../src/index.mjs';

const CATALOG = [{ action: 'gitee.git.push', target: 'repository', category: 'remote-write' }];

const answering = () => ({
  calls: 0,
  ask(request) {
    this.calls += 1;
    return Promise.resolve({ answers: request.questions.map((question) => ({ id: question.id, selected: [CONFIRM_LABELS.allow] })) });
  },
});

const SIGNED_IN = { signedIn: true, principal: { subject: 'svc-a' } };
const OTHER = { signedIn: true, principal: { subject: 'svc-b' } };

/**
 * @param {() => object | undefined} view the IAM view for every read
 */
function mount(view) {
  const services = new Map(), listeners = new Map(), guards = [];
  services.set('iam', { getView: () => view() });
  services.set('userQuestions', answering());
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
  };
  const dispose = apply(ctx, {
    audit: { sink: 'memory' },
    rules: { confirmPush: true },
    catalog: CATALOG,
    tools: { forge_gitee_write: 'gitee.git.push' },
  });
  return { policy: services.get('policy'), ctx, services, listeners, guards, dispose };
}

const exec = (callId = 'call-ident') => ({
  name: 'forge_gitee_write',
  arguments: { target: 'corp.example/repo' },
  callId,
  agent: { kind: 'agent' },
  signal: new AbortController().signal,
});
const allow = async () => ({ kind: 'allow' });

test('no identity means a refusal that names the action and points at the account settings', async () => {
  for (const view of [{ signedIn: false }, {}, undefined, { signedIn: true, principal: {} }]) {
    const h = mount(() => view);
    let ran = 0;
    const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => (ran++, { ok: true }));
    assert.equal(ran, 0, 'an unidentified caller executes nothing');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /gitee\.git\.push/u);
    assert.match(result.text, /设置 → 账号/u);
    assert.equal(h.policy.auditRecords().length, 0, 'no identity, no audit receipt');
    assert.equal(h.services.get('userQuestions').calls, 0, 'no human is asked on behalf of an unknown caller');
    h.dispose();
  }
});

test('an identity that changes after the confirmation is caught before the write lands', async () => {
  let calls = 0;
  const h = mount(() => (calls++ === 0 ? SIGNED_IN : OTHER));
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => (ran++, { ok: true }));
  assert.equal(ran, 0, 'the write never runs once the identity moved');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /身份/u);
  const records = h.policy.auditRecords();
  assert.deepEqual(records.map((record) => record.phase), ['asked', 'answered', 'begin', 'settle']);
  assert.equal(records.at(-1).decision, 'cancelled');
  assert.equal(records.at(-1).rule, 'identity-changed');
  h.dispose();
});

test('an identity that disappears mid-flight is a failure as well', async () => {
  let calls = 0;
  const h = mount(() => (calls++ === 0 ? SIGNED_IN : undefined));
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => ({ ok: true }));
  assert.equal(result.kind, 'error');
  assert.equal(h.policy.auditRecords().at(-1).rule, 'identity-changed');
  h.dispose();
});

test('a reused decision is not a reused identity', async () => {
  let signedIn = true;
  const h = mount(() => (signedIn ? SIGNED_IN : undefined));
  const first = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => ({ ok: true }));
  assert.deepEqual(first, { ok: true });
  assert.equal(h.policy.decisionCacheSize(), 1);

  signedIn = false;
  const retry = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => ({ ok: true }));
  assert.equal(retry.kind, 'error', 'the cached decision must not carry a cached identity');
  assert.match(retry.text, /设置 → 账号/u);
  assert.equal(h.policy.auditRecords().filter((record) => record.phase === 'begin').length, 1, 'the retry never began');
  h.dispose();
});

test('the pre-execute path refuses a call whose identity changed before the tool ran', async () => {
  let calls = 0;
  const h = mount(() => (calls++ === 0 ? SIGNED_IN : OTHER));
  const pre = h.listeners.get('tools/pre-execute');
  const record = exec();
  const admission = await pre(record, allow);
  assert.equal(admission.kind, 'deny');
  assert.match(admission.reason, /identity changed/u);
  const settle = h.policy.auditRecords().at(-1);
  assert.equal(settle.decision, 'cancelled');
  h.dispose();
});

test('the receipt check refuses an identity change between admission and use', async () => {
  let calls = 0;
  const h = mount(() => (calls++ === 0 ? SIGNED_IN : OTHER));
  const pre = h.listeners.get('tools/pre-execute');
  const record = exec();
  // next() 之后立即复验：让身份在准入与工具执行之间变化。
  const next = async () => {
    calls = 1;
    return { kind: 'allow' };
  };
  const admission = await pre(record, next);
  assert.equal(admission.kind, 'deny');
  assert.match(admission.reason, /identity changed/u);
  h.dispose();
});

test('the guard refuses when the identity moved after admission', async () => {
  const h = mount(() => SIGNED_IN);
  const pre = h.listeners.get('tools/pre-execute');
  const record = exec();
  assert.equal((await pre(record, allow)).kind, 'allow');
  // 准入之后身份换成另一个人：收据作废。
  h.services.set('iam', { getView: () => OTHER });
  const verdict = h.guards[0](record);
  assert.match(verdict, /IAM identity changed/u);
  h.dispose();
});
