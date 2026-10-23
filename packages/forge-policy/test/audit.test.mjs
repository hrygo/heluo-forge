import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuditRecord, createAuditBarrier, PolicyAuditError } from '../src/audit.mjs';

const durable = () => {
  const records = [];
  return { durable: true, records, append: (record) => void records.push(record) };
};

test('an audit record keeps only the allowed fields', () => {
  const record = buildAuditRecord({
    action: 'repository.read',
    target: 'repo-a',
    tool: 'forge_repository_read',
    decision: 'allow',
    rule: 'registered-action',
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

test('a missing or non-durable sink refuses the pre-audit', async () => {
  const missing = createAuditBarrier();
  await assert.rejects(() => missing.begin({ action: 'a.b' }), (error) => error.code === 'POLICY_AUDIT_UNAVAILABLE');

  const ephemeral = createAuditBarrier({ sink: { durable: false, append: () => {} } });
  await assert.rejects(() => ephemeral.begin({ action: 'a.b' }), (error) => error.code === 'POLICY_AUDIT_NOT_DURABLE');

  const allowed = createAuditBarrier({ sink: { durable: false, append: () => {} }, allowNonDurable: true });
  assert.ok((await allowed.begin({ action: 'a.b' })).receipt.action === 'a.b');
  await assert.rejects(
    () => createAuditBarrier({ sink: {}, allowNonDurable: true }).begin({ action: 'a.b' }),
    (error) => error.code === 'POLICY_AUDIT_UNAVAILABLE',
  );
});

test('a sink error or timeout refuses the pre-audit', async () => {
  const failing = createAuditBarrier({ sink: { durable: true, append: () => { throw new Error('disk on fire'); } } });
  await assert.rejects(() => failing.begin({ action: 'a.b' }), (error) => error.code === 'POLICY_AUDIT_UNAVAILABLE');

  const hanging = createAuditBarrier({ sink: { durable: true, append: () => new Promise(() => {}) }, timeoutMs: 20 });
  await assert.rejects(() => hanging.begin({ action: 'a.b' }), (error) => error.code === 'POLICY_AUDIT_TIMEOUT');
});

test('a failed settle keeps the outcome, records a gap and limits later actions', async () => {
  const sink = durable();
  const barrier = createAuditBarrier({ sink });
  const receipt = await barrier.begin({ action: 'issue.create_or_update', target: 'I-1' });
  sink.append = () => { throw new Error('settle failed'); };
  const settled = await barrier.settle(receipt, { decision: 'executed' });
  assert.equal(settled.action, 'gap');
  assert.equal(barrier.isDegraded(), true);
  assert.equal(barrier.gaps().length, 1);
  assert.equal(barrier.gaps()[0].kind, 'settle-failed');
  await assert.rejects(() => barrier.begin({ action: 'issue.create_or_update' }), (error) => error.code === 'POLICY_AUDIT_GAP_OUTSTANDING');
  assert.equal(barrier.acknowledgeGaps(), 1);
  assert.equal(barrier.isDegraded(), false);
  assert.equal(barrier.gaps().length, 0);
});

test('a successful settle records the outcome with the duration', async () => {
  const sink = durable();
  const barrier = createAuditBarrier({ sink });
  const receipt = await barrier.begin({ action: 'repository.read', target: 'repo-a' });
  const settled = await barrier.settle(receipt, { decision: 'executed' });
  assert.equal(settled.action, 'settled');
  assert.equal(settled.record.phase, 'settle');
  assert.equal(settled.record.decision, 'executed');
  assert.equal(typeof settled.record.durationMs, 'number');
  assert.equal(barrier.isDegraded(), false);

  const noSink = createAuditBarrier({ sink: durable() });
  const orphan = await noSink.begin({ action: 'repository.read' });
  noSink.setSink(undefined);
  const gapped = await noSink.settle(orphan, { decision: 'executed' });
  assert.equal(gapped.action, 'gap');
});

test('optional telemetry never blocks and only leaves a gap', async () => {
  const barrier = createAuditBarrier({ sink: durable() });
  assert.deepEqual(await barrier.optional('metrics', async () => 42), { action: 'ok', value: 42 });
  const failed = await barrier.optional('metrics', async () => { throw new Error('collector down'); });
  assert.equal(failed.action, 'gap');
  assert.equal(failed.gap.kind, 'optional-failed');
  assert.equal(barrier.isDegraded(), false, 'an optional failure does not degrade the barrier');
});

test('a broken gap observer or time source cannot break the barrier', async () => {
  const sink = durable();
  const barrier = createAuditBarrier({
    sink,
    now: () => 7,
    onGap: () => { throw new Error('observer down'); },
  });
  const receipt = await barrier.begin({ action: 'repository.read' });
  sink.append = () => { throw new Error('nope'); };
  const settled = await barrier.settle(receipt, {});
  assert.equal(settled.action, 'gap');
  assert.equal(settled.gap.at, 7);

  const restored = { durable: true, append: () => {} };
  const dispose = barrier.setSink(restored);
  assert.equal(barrier.acknowledgeGaps(), 1);
  assert.ok((await barrier.begin({ action: 'repository.read' })).receipt.action === 'repository.read');
  dispose();
  assert.equal(barrier.acknowledgeGaps(), 0);
});
