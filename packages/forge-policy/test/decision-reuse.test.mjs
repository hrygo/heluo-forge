import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRM_LABELS } from '../src/confirm.mjs';
import { DECISION_CACHE_LIMIT, createDecisionCache, reuseKeyOf } from '../src/reuse.mjs';
import { apply } from '../src/index.mjs';

const CATALOG = [
  { action: 'gitee.git.push', target: 'repository', category: 'remote-write' },
  { action: 'change.clarification.write', target: 'change', category: 'dev-write' },
];

const answering = (selected = CONFIRM_LABELS.allow) => ({
  calls: [],
  ask(request) {
    this.calls.push(request);
    return Promise.resolve({ answers: request.questions.map((question) => ({ id: question.id, selected: [selected] })) });
  },
});

function mount({ rules = { confirmPush: true }, userQuestions } = {}) {
  const services = new Map();
  services.set('iam', { getView: () => ({ signedIn: true, principal: { subject: 'svc-policy-test' } }) });
  if (userQuestions !== undefined) services.set('userQuestions', userQuestions);
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: () => () => {},
    tools: { guard: () => () => {} },
  };
  const dispose = apply(ctx, { audit: { sink: 'memory' }, rules, catalog: CATALOG });
  return { policy: services.get('policy'), ctx, dispose };
}

const exec = (callId = 'call-1', arguments_ = { target: 'corp.example/repo', branch: 'feat/x' }) => ({
  name: 'forge_gitee_write', arguments: arguments_, callId, agent: { kind: 'agent' },
});

test('the key is tool, call id, action and argument digest, and needs all four', () => {
  const key = reuseKeyOf({ tool: 'forge_gitee_write', callId: 'call-1', action: 'gitee.git.push', digest: 'sha-1' });
  assert.equal(typeof key, 'string');
  assert.equal(key.includes('forge_gitee_write'), true);
  assert.equal(key.includes('call-1'), true);
  assert.equal(key.includes('gitee.git.push'), true);
  assert.equal(key.includes('sha-1'), true);
  assert.notEqual(key, reuseKeyOf({ tool: 'forge_gitee_write', callId: 'call-1', action: 'gitee.git.push', digest: 'sha-2' }));
  for (const missing of ['tool', 'callId', 'action', 'digest']) {
    const parts = { tool: 'forge_gitee_write', callId: 'call-1', action: 'gitee.git.push', digest: 'sha-1' };
    delete parts[missing];
    assert.equal(reuseKeyOf(parts), undefined, `a missing ${missing} means no reuse at all`);
    assert.equal(reuseKeyOf({ ...parts, [missing]: '  ' }), undefined, `a blank ${missing} means no reuse at all`);
  }
  assert.equal(reuseKeyOf(), undefined);
});

test('the cache holds at most 32 decisions and evicts the least recently used', () => {
  assert.equal(DECISION_CACHE_LIMIT, 32);
  const cache = createDecisionCache();
  for (let index = 0; index < 32; index += 1) cache.set({ key: `k${index}`, digest: 'd' });
  assert.equal(cache.size(), 32);
  assert.equal(cache.has('k0'), true);
  cache.touch('k0');
  cache.set({ key: 'k32', digest: 'd' });
  assert.equal(cache.size(), 32, 'the 33rd key does not grow the cache');
  assert.equal(cache.has('k0'), true, 'the touched key survived');
  assert.equal(cache.has('k1'), false, 'the least recently used key was evicted');
  assert.equal(Object.isFrozen(cache.peek('k0')), true, 'peek hands out a frozen copy');
  const hits = cache.peek('k0').hits;
  cache.touch('k0');
  assert.equal(cache.peek('k0').hits, hits + 1, 'a reuse is counted');
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(createDecisionCache({ limit: 2 }).limit(), 2);
});

test('an allowed call is reused on retry without asking the human again', async () => {
  const channel = answering();
  const h = mount({ userQuestions: channel });
  let ran = 0;
  const first = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => (ran++, { ok: true }));
  assert.deepEqual(first, { ok: true });
  assert.equal(channel.calls.length, 1);
  assert.equal(h.policy.decisionCacheSize(), 1);

  const again = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => (ran++, { ok: true }));
  assert.deepEqual(again, { ok: true });
  assert.equal(ran, 2, 'a reused decision still runs the operation exactly once');
  assert.equal(channel.calls.length, 1, 'the retry does not disturb the human');
  const reused = h.policy.auditRecords().filter((record) => record.phase === 'begin').at(-1);
  assert.equal(reused.rule, 'reused-decision');
  assert.equal(reused.operationId, 'call-1');
  h.dispose();
});

test('changed arguments, a changed action or a changed call id ask again', async () => {
  const channel = answering();
  const h = mount({ userQuestions: channel });
  const run = (record) => h.policy.executeAction(h.ctx, 'gitee.git.push', record, async () => ({ ok: true }));
  await run(exec('call-1'));
  assert.equal(channel.calls.length, 1);
  await run(exec('call-1', { target: 'corp.example/repo', branch: 'feat/y' }));
  assert.equal(channel.calls.length, 2, 'a different branch is a different decision');
  await run(exec('call-2'));
  assert.equal(channel.calls.length, 3, 'a different call id asks again');
  await run(exec('call-1', { target: 'corp.example/other', branch: 'feat/x' }));
  assert.equal(channel.calls.length, 4, 'a different target asks again');
  h.dispose();
});

test('a refused or failed call is never cached', async () => {
  const denyChannel = answering(CONFIRM_LABELS.deny);
  const denying = mount({ userQuestions: denyChannel });
  await denying.policy.executeAction(denying.ctx, 'gitee.git.push', exec(), async () => ({ ok: true }));
  assert.equal(denying.policy.decisionCacheSize(), 0, 'a refusal never becomes a reusable decision');
  await denying.policy.executeAction(denying.ctx, 'gitee.git.push', exec(), async () => ({ ok: true }));
  assert.equal(denyChannel.calls.length, 2, 'the second attempt asks again');
  denying.dispose();

  const channel = answering();
  const failing = mount({ userQuestions: channel });
  const first = await failing.policy.executeAction(failing.ctx, 'gitee.git.push', exec(), async () => ({ kind: 'error' }));
  assert.equal(first.kind, 'error');
  assert.equal(failing.policy.decisionCacheSize(), 0, 'a failed execution invalidates the decision');
  await failing.policy.executeAction(failing.ctx, 'gitee.git.push', exec(), async () => ({ ok: true }));
  assert.equal(channel.calls.length, 2, 'the retry after a failure asks again');
  failing.dispose();
});

test('unmounting empties the cache: nothing survives the session', async () => {
  const channel = answering();
  const h = mount({ userQuestions: channel });
  await h.policy.executeAction(h.ctx, 'gitee.git.push', exec(), async () => ({ ok: true }));
  assert.equal(h.policy.decisionCacheSize(), 1);
  h.dispose();
  assert.equal(h.policy.decisionCacheSize(), 0);
});

test('a changed content snapshot is a different decision', async () => {
  const channel = answering();
  const h = mount({ userQuestions: channel });
  const body = (text) => () => ({ title: 't', body: text });
  const run = (record) => h.policy.executeAction(h.ctx, 'gitee.git.push', record, async () => ({ ok: true }));
  await run({ ...exec('call-1'), content: body('正文一') });
  assert.equal(channel.calls.length, 1);
  await run({ ...exec('call-1'), content: body('正文二') });
  assert.equal(channel.calls.length, 2, 'a changed body must be confirmed again even when arguments match');
  h.dispose();
});

test('a cached decision belongs to one actor and one session', async () => {
  const channel = answering();
  const h = mount({ userQuestions: channel });
  const session = (id) => ({ kind: 'agent', session: { header: { id } } });
  await h.policy.executeAction(h.ctx, 'gitee.git.push', { ...exec('call-1'), agent: session('s-1') }, async () => ({ ok: true }));
  assert.equal(channel.calls.length, 1);
  await h.policy.executeAction(h.ctx, 'gitee.git.push', { ...exec('call-1'), agent: session('s-2') }, async () => ({ ok: true }));
  assert.equal(channel.calls.length, 2, 'another session must not inherit the confirmation');
  h.dispose();
});

test('a subagent never reuses a decision even when the switch is off', async () => {
  const channel = answering();
  const h = mount({ rules: { confirmPush: true, denyDelegatedWrites: false }, userQuestions: channel });
  const root = { ...exec('call-1'), agent: { session: { header: { id: 's-1' } } } };
  await h.policy.executeAction(h.ctx, 'gitee.git.push', root, async () => ({ ok: true }));
  assert.equal(channel.calls.length, 1);
  // 同会话、同 callId、同参数：若先查缓存就会直接命中；来源判定必须排在缓存之前。
  const child = { ...exec('call-1'), agent: { session: { header: { origin: 'subagent', id: 's-1' } } } };
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', child, async () => ({ ok: true }));
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'POLICY_CONFIRM_DELEGATED');
  assert.equal(channel.calls.length, 1, 'the child never got a card and never reused the parent decision');
  h.dispose();
});

test('a failed or unknown business result is not reusable', async () => {
  const channel = answering();
  const h = mount({ userQuestions: channel });
  const run = (result) => h.policy.executeAction(h.ctx, 'gitee.git.push', exec('call-1'), async () => result);
  await run({ status: 'failed' });
  assert.equal(h.policy.decisionCacheSize(), 0, 'a failed write is not a reusable allow');
  await run({ status: 'unknown' });
  assert.equal(h.policy.decisionCacheSize(), 0, 'an unknown outcome is not a reusable allow');
  assert.equal(channel.calls.length, 2, 'both retries asked the human again');
  await run({ status: 'succeeded' });
  assert.equal(h.policy.decisionCacheSize(), 1, 'only a completed write becomes reusable');
  h.dispose();
});

test('a body that changes between admission and execution is refused', async () => {
  const channel = answering();
  const h = mount({ userQuestions: channel });
  let reads = 0;
  const content = () => ({ title: 't', body: reads++ === 0 ? '正文一' : '正文二' });
  let ran = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', { ...exec('call-1'), content }, async () => {
    ran += 1;
    return { ok: true };
  });
  assert.equal(ran, 0, '正文在执行前变了，就不能再执行');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /正文/u);
  h.dispose();
});
