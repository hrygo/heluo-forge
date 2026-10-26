import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../src/index.mjs';

function host() {
  const services = new Map(), listeners = new Map(), guards = [];
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
  };
  const dispose = apply(ctx, { audit: { sink: 'memory', allowNonDurable: true },
    catalog: [{ action: 'synthetic.read', kind: 'read', target: 'repository', enabled: true }], tools: { synthetic: 'synthetic.read' } });
  return { policy: services.get('policy'), listeners, guards, dispose };
}
const execution = (id) => ({ name: 'synthetic', arguments: { target: 'repo-A' }, callId: id, signal: new AbortController().signal });
const allow = async () => ({ kind: 'allow' });
const accept = async () => ({ kind: 'accept' });

test('the final result settles a short-circuited post waterfall exactly once', async () => {
  const h = host(), first = execution('first'), second = execution('second');
  const pre = h.listeners.get('tools/pre-execute'), final = h.listeners.get('tools/result');
  assert.equal((await pre(first, allow)).kind, 'allow');
  assert.equal(h.guards[0](first), undefined);
  // Emulate another post listener returning accept without calling next.
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

test('the next prepare awaits a final-result settle and refuses its failure', async () => {
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
  assert.match(decision.reason, /audit|outstanding/);
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
  // Replace the test sink before cleanup so cancellation has a writable sink.
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
  assert.equal(h.policy.auditDegraded(), true);
  assert.equal(h.policy.auditGaps()[0].kind, 'outcome-unavailable');
  assert.equal(h.policy.auditGaps()[0].outcome, 'unknown');
  await Promise.resolve();
  assert.equal(h.policy.auditRecords().at(-1).decision, 'unknown');
});

test('a downstream pre failure settles the audit without replacing the original error', async () => {
  const h = host(), exec = execution('throwing');
  await assert.rejects(() => h.listeners.get('tools/pre-execute')(exec, async () => { throw new Error('synthetic downstream error'); }), /synthetic downstream error/);
  assert.deepEqual(h.policy.auditRecords().map((r) => r.phase), ['begin', 'settle']);
  assert.equal(h.policy.auditRecords()[1].decision, 'error');
  h.dispose();
});

// The source of these lifecycle cases is a read-only independent reproduction
// against actual supported-floor DSH components, not a claim about target rc.3.
