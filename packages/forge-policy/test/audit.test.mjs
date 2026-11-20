import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuditRecord, createAuditBarrier, createMemorySink, PolicyAuditError } from '../src/audit.mjs';

const durable = (overrides = {}) => {
  const records = [];
  return { durable: true, records, append: (record) => void records.push(record), ...overrides };
};

test('an audit record keeps only the allowed fields', () => {
  const record = buildAuditRecord({
    action: 'gitee.issue.write',
    target: 'repo-a',
    tool: 'forge_issue_write',
    decision: 'allow',
    rule: 'registered-write',
    operationId: 'call-1',
    durationMs: 12,
    unknownField: 'dropped',
    note: 'dropped too',
  });
  assert.deepEqual(Object.keys(record).sort(), ['action', 'decision', 'durationMs', 'operationId', 'rule', 'target', 'tool']);
  assert.equal(JSON.stringify(record).includes('unknownField'), false);
  assert.equal(JSON.stringify(record).includes('note'), false);
  assert.equal(buildAuditRecord({ action: 'a.b', target: 'x'.repeat(600) }).target.length, 512, 'long values are truncated');
  assert.equal(buildAuditRecord({ action: 'a.b', target: undefined }).target, undefined, 'undefined fields are dropped');
});

test('forbidden and incomplete records are refused outright', () => {
  for (const field of ['arguments', 'stdout', 'stderr', 'content', 'token', 'secret']) {
    assert.throws(
      () => buildAuditRecord({ action: 'a.b', [field]: 'value' }),
      (error) => error instanceof PolicyAuditError && error.code === 'POLICY_AUDIT_FIELD_FORBIDDEN',
    );
  }
  assert.throws(() => buildAuditRecord({ target: 'x' }), (error) => error.code === 'POLICY_AUDIT_RECORD_INVALID');
});

test('the audit keeps summaries instead of arguments and agent kinds', () => {
  const record = buildAuditRecord({
    action: 'gitee.git.push',
    target: 'acme/demo',
    agent: { kind: 'subagent', id: 'agent-secret', token: 'secret' },
    summary: 'push the current branch',
    params: {
      owner: 'acme',
      repo: 'demo',
      nested: { path: ['', 'home', 'private', 'project', 'secret.txt'].join('/'), body: 'x'.repeat(400) },
      flags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      token: 'should-be-dropped',
    },
  });
  assert.deepEqual(record.agent, { kind: 'subagent' });
  assert.equal(record.summary, 'push the current branch');
  assert.equal(record.params.nested.body.length, 128);
  assert.equal(record.params.nested.path, 'home/private/project/secret.txt');
  assert.equal(record.params.flags.length, 8);
  assert.equal(Object.hasOwn(record.params, 'token'), false);
  assert.equal(JSON.stringify(record).includes('agent-secret'), false);
  assert.equal(JSON.stringify(record).includes('should-be-dropped'), false);
});

test('the memory sink is an in-process ring buffer that overwrites the oldest entry', () => {
  const sink = createMemorySink({ buffer: 2 });
  assert.equal(sink.durable, false);
  sink.append({ action: 'a', phase: 'begin' });
  sink.append({ action: 'b', phase: 'begin' });
  sink.append({ action: 'c', phase: 'settle' });
  assert.equal(sink.size(), 2);
  assert.deepEqual(sink.records().map((record) => record.action), ['b', 'c']);
});

test('a missing sink refuses the pre-audit; a memory sink is accepted', async () => {
  const missing = createAuditBarrier();
  await assert.rejects(() => missing.begin({ action: 'a.b' }), (error) => error.code === 'POLICY_AUDIT_UNAVAILABLE');

  const memory = createAuditBarrier({ sink: createMemorySink({ buffer: 4 }) });
  const receipt = await memory.begin({ action: 'gitee.issue.write', target: 'I-1' });
  assert.equal(receipt.receipt.action, 'gitee.issue.write');
  assert.equal(memory.sinks().kind, 'memory');
});

test('a sink error or timeout refuses the pre-audit', async () => {
  const failing = createAuditBarrier({ sink: durable({ append: () => { throw new Error('disk on fire'); } }) });
  await assert.rejects(() => failing.begin({ action: 'a.b' }), (error) => error.code === 'POLICY_AUDIT_WRITE_FAILED');

  const hanging = createAuditBarrier({ sink: durable({ append: () => new Promise(() => {}) }), timeoutMs: 20 });
  await assert.rejects(() => hanging.begin({ action: 'a.b' }), (error) => error.code === 'POLICY_AUDIT_TIMEOUT');
});

test('a failed settle keeps the outcome, records a gap and limits later actions', async () => {
  const sink = durable();
  const barrier = createAuditBarrier({ sink });
  const receipt = await barrier.begin({ action: 'gitee.issue.write', target: 'I-1' });
  sink.append = () => { throw new Error('settle failed'); };
  const settled = await barrier.settle(receipt, { decision: 'executed' });
  assert.equal(settled.action, 'gap');
  assert.equal(barrier.isDegraded(), true);
  assert.equal(barrier.gaps().length, 1);
  assert.equal(barrier.gaps()[0].kind, 'settle-failed');
  await assert.rejects(() => barrier.begin({ action: 'gitee.issue.write' }), (error) => error.code === 'POLICY_AUDIT_GAP_OUTSTANDING');
  assert.equal(barrier.acknowledgeGaps(), 1);
  assert.equal(barrier.isDegraded(), false);
  assert.equal(barrier.gaps().length, 0);
});

test('a successful settle records the outcome with the duration', async () => {
  const sink = durable();
  const barrier = createAuditBarrier({ sink });
  const receipt = await barrier.begin({ action: 'gitee.issue.write', target: 'repo-a' });
  const settled = await barrier.settle(receipt, { decision: 'executed' });
  assert.equal(settled.action, 'settled');
  assert.equal(settled.record.phase, 'settle');
  assert.equal(settled.record.decision, 'executed');
  assert.equal(typeof settled.record.durationMs, 'number');
  assert.equal(barrier.isDegraded(), false);

  const noSink = createAuditBarrier({ sink: durable() });
  const orphan = await noSink.begin({ action: 'gitee.issue.write' });
  noSink.setSink(undefined);
  const gapped = await noSink.settle(orphan, { decision: 'executed' });
  assert.equal(gapped.action, 'gap');
});

test('a broken gap observer or time source cannot break the barrier', async () => {
  const sink = durable();
  const barrier = createAuditBarrier({
    sink,
    now: () => 7,
    onGap: () => { throw new Error('observer down'); },
  });
  const receipt = await barrier.begin({ action: 'gitee.issue.write' });
  sink.append = () => { throw new Error('nope'); };
  const settled = await barrier.settle(receipt, {});
  assert.equal(settled.action, 'gap');
  assert.equal(settled.gap.at, 7);

  const restored = durable();
  const dispose = barrier.setSink(restored);
  assert.equal(barrier.acknowledgeGaps(), 1);
  assert.ok((await barrier.begin({ action: 'gitee.issue.write' })).receipt.action === 'gitee.issue.write');
  dispose();
  assert.equal(barrier.acknowledgeGaps(), 0);
});
