import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../src/index.mjs';

function host() {
  const services = new Map(), listeners = new Map(), guards = [];
  services.set('iam', { getView: () => ({ signedIn: true, principal: { subject: 'svc-policy-test' } }) });
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
  };
  const dispose = apply(ctx, {
    audit: { sink: 'memory' },
    catalog: [{ action: 'gitee.issue.write', target: 'issue', category: 'dev-write' }],
    tools: { synthetic: 'gitee.issue.write' },
  });
  return { policy: services.get('policy'), listeners, guards, dispose };
}
const execution = (id) => ({ name: 'synthetic', arguments: { target: 'repo-A' }, callId: id, agent: { kind: 'agent' }, signal: new AbortController().signal });
const allow = async () => ({ kind: 'allow' });
const accept = async () => ({ kind: 'accept' });

test('the final result settles a short-circuited post waterfall exactly once', async () => {
  const h = host(), first = execution('first'), second = execution('second');
  const pre = h.listeners.get('tools/pre-execute'), final = h.listeners.get('tools/result');
  assert.equal((await pre(first, allow)).kind, 'allow');
  assert.equal(h.guards[0](first), undefined);
  assert.equal(final(first, { isError: false }), undefined, 'final observer is synchronous');
  final(first, { isError: false });
  assert.equal((await pre(second, allow)).kind, 'allow');
  assert.deepEqual(h.policy.auditRecords().map((r) => r.phase), ['begin', 'settle', 'begin']);
  assert.equal(h.guards[0](second), undefined);
  await h.listeners.get('tools/post-execute')(second, { isError: false }, accept);
  final(second, { isError: false });
  assert.equal(h.policy.auditRecords().length, 4);
  h.dispose();
});

test('the next prepare awaits a pending settlement and refuses its failure', async () => {
  const h = host(), first = execution('first'), second = execution('second');
  let rejectSettle, begins = 0;
  h.policy.setAuditSink({ durable: true, append(record) {
    if (record.phase === 'begin') { begins++; return; }
    return new Promise((_resolve, reject) => { rejectSettle = reject; });
  } });
  const pre = h.listeners.get('tools/pre-execute');
  await pre(first, allow);
  assert.equal(h.guards[0](first), undefined);
  h.listeners.get('tools/result')(first, { isError: false });
  let returned = false;
  const next = pre(second, allow).then((value) => { returned = true; return value; });
  await Promise.resolve();
  assert.equal(returned, false);
  assert.equal(begins, 1);
  rejectSettle(new Error('synthetic settle failure'));
  const decision = await next;
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /outstanding|记录/u);
  assert.equal(begins, 1, 'no next begin or body slips through the unawaited observer window');
  assert.equal(h.policy.auditDegraded(), true);
  h.dispose();
});

test('the guard rejects an already-prepared call while a prior settlement is pending', async () => {
  const h = host(), first = execution('first'), second = execution('second');
  let release;
  h.policy.setAuditSink({ durable: true, append(record) {
    if (record.phase === 'settle') return new Promise((resolve) => { release = resolve; });
  } });
  const pre = h.listeners.get('tools/pre-execute');
  await pre(first, allow); await pre(second, allow);
  assert.equal(h.guards[0](first), undefined);
  h.listeners.get('tools/result')(first, { isError: false });
  assert.match(String(h.guards[0](second)), /settlement.*pending/);
  await Promise.resolve(); release();
  h.policy.setAuditSink({ durable: true, append() {} });
  h.dispose();
});

for (const scenario of ['dispose', 'cancel', 'change-target']) {
  test(`${scenario} while begin awaits cannot resurrect a tool execution`, async () => {
    const h = host(), exec = execution(scenario), records = [];
    let release;
    h.policy.setAuditSink({ durable: true, append(record) {
      records.push(record);
      if (record.phase === 'begin') return new Promise((resolve) => { release = resolve; });
    } });
    const controller = new AbortController(); exec.signal = controller.signal;
    const pre = h.listeners.get('tools/pre-execute');
    const pending = pre(exec, allow);
    await Promise.resolve();
    if (scenario === 'dispose') h.dispose();
    else if (scenario === 'cancel') controller.abort();
    else exec.arguments.target = 'repo-B';
    release();
    const result = await pending;
    assert.equal(result.kind, 'deny');
    assert.deepEqual(records.map((r) => r.phase), ['begin', 'settle']);
    assert.equal(records[1].decision, 'cancelled');
    assert.equal(records[0].target, 'repo-A');
    h.dispose();
  });
}

test('dispose during a downstream pre listener cannot allow after guards were removed', async () => {
  const h = host(), exec = execution('downstream');
  let release, entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const pre = h.listeners.get('tools/pre-execute');
  const pending = pre(exec, () => new Promise((resolve) => { release = resolve; entered(); }));
  await reached;
  h.dispose();
  assert.equal(h.guards.length, 0);
  release({ kind: 'allow' });
  assert.equal((await pending).kind, 'deny', 'captured pre callback, not a removed guard, refuses the call');
});

test('unloading an admitted call records an unknown outcome, not a fake success', async () => {
  const h = host(), exec = execution('admitted');
  await h.listeners.get('tools/pre-execute')(exec, allow);
  assert.equal(h.guards[0](exec), undefined);
  h.dispose();
  await Promise.resolve();
  assert.equal(h.policy.auditDegraded(), false);
  assert.equal(h.policy.auditGaps().length, 0);
  assert.equal(h.policy.auditRecords().at(-1).decision, 'unknown');
});

test('a downstream pre failure settles the audit without replacing the original error', async () => {
  const h = host(), exec = execution('throwing');
  await assert.rejects(() => h.listeners.get('tools/pre-execute')(exec, async () => { throw new Error('synthetic downstream error'); }), /synthetic downstream error/);
  assert.deepEqual(h.policy.auditRecords().map((r) => r.phase), ['begin', 'settle']);
  assert.equal(h.policy.auditRecords()[1].decision, 'error');
  h.dispose();
});

test('an admitted call whose audit record is missing is refused by the guard', async () => {
  const h = host(), exec = execution('no-receipt');
  const guard = h.guards[0];
  assert.match(String(guard(exec)), /not admitted/u);
  h.dispose();
});

test('a call that was never admitted cannot be executed by stealing another call id', async () => {
  const h = host(), first = execution('first'), impostor = execution('first');
  await h.listeners.get('tools/pre-execute')(first, allow);
  assert.match(String(h.guards[0](impostor)), /already admitted/u);
  h.dispose();
});

// The source of these lifecycle cases is a read-only independent reproduction
// against actual supported-floor DSH components, not a claim about target rc.3.

/**
 * `executeAction` 的独立入口（Gitee/DevOps 工具直接调它）：放行与落地之间还有窗口，
 * 取消、身份切换、参数改写发生在窗口里都不能让写入落地。评审 P1 的回归位。
 */
function windowHost({ onBegin } = {}) {
  const services = new Map(), listeners = new Map(), guards = [];
  const view = { signedIn: true, principal: { subject: 'svc-policy-test' } };
  services.set('iam', { getView: () => view });
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
  };
  const dispose = apply(ctx, {
    catalog: [{ action: 'gitee.issue.write', target: 'issue', category: 'dev-write' }],
    tools: { synthetic: 'gitee.issue.write' },
  });
  const policy = services.get('policy');
  if (typeof onBegin === 'function') {
    policy.setAuditSink({ durable: true, append(record) {
      if (record.phase === 'begin') onBegin({ view, record });
    } });
  }
  return { policy, ctx, dispose, view, listeners };
}

const EXECUTE_COPY = /等待期间|已取消|已卸载/u;

test('executeAction refuses a call whose identity changed between admission and execution', async () => {
  let seen;
  const h = windowHost({ onBegin: ({ view }) => { view.signedIn = false; } });
  const exec = { name: 'synthetic', arguments: { target: 'repo-A' }, callId: 'flip', agent: { kind: 'agent' }, signal: new AbortController().signal };
  let runs = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', exec, async () => { runs += 1; return { kind: 'ok' }; });
  seen = result;
  assert.equal(runs, 0, '身份在等待窗口里失效后不得执行');
  assert.equal(seen.kind, 'error');
  assert.match(seen.text, /身份发生变化/u);
  assert.equal(h.policy.auditGaps().length, 0);
  h.dispose();
});

test('executeAction refuses a call whose arguments were rewritten during admission', async () => {
  const h = windowHost();
  const exec = { name: 'synthetic', arguments: { target: 'repo-A' }, callId: 'rewrite', agent: { kind: 'agent' }, signal: new AbortController().signal };
  h.policy.setAuditSink({ durable: true, append(record) {
    if (record.phase === 'begin') exec.arguments.target = 'repo-B';
  } });
  let runs = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', exec, async () => { runs += 1; return { kind: 'ok' }; });
  assert.equal(runs, 0, '参数在等待窗口里被改写后不得执行');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /参数发生变化/u);
  h.dispose();
});

test('executeAction refuses a call that was cancelled while it waited', async () => {
  const h = windowHost();
  const controller = new AbortController();
  const exec = { name: 'synthetic', arguments: { target: 'repo-A' }, callId: 'cancel', agent: { kind: 'agent' }, signal: controller.signal };
  controller.abort();
  let runs = 0;
  const result = await h.policy.executeAction(h.ctx, 'gitee.issue.write', exec, async () => { runs += 1; return { kind: 'ok' }; });
  assert.equal(runs, 0, '取消后不得执行');
  assert.equal(result.kind, 'error');
  assert.match(result.text, EXECUTE_COPY);
  assert.equal(h.policy.auditGaps().length, 0);
  h.dispose();
});
