import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA_VERSION,
  createBoundedBuffer,
  createBoundedExporter,
  createLossReporter,
  createProjection,
  foldByOperation,
} from '../src/observe.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

const enums = {
  status: ['success', 'failure', 'partial', 'unknown'],
  action: ['review.ai.publish', 'review.human.record', 'repo.read'],
  errorCode: ['POLICY_DENIED', 'TOOL_TIMEOUT'],
  decisionKind: ['scope_change', 'access_grant'],
  lossReason: ['buffer_full', 'ttl_expired', 'export_rejected'],
};

const projection = createProjection({ enums });

const base = {
  schema_version: SCHEMA_VERSION,
  event_id: 'evt-1',
  event_name: 'forge.tool.completed',
  source_version: '0.1.0',
  emitted_at: '2026-10-24T10:00:00.000Z',
  occurred_at: '2026-10-24T09:59:58.000Z',
  operation_id: 'op-1',
  action: 'repo.read',
  access_kind: 'read',
  status: 'success',
  duration_ms: 1200,
};

const project = (patch) => projection.project({ ...base, ...patch });

test('AC1: content-bearing fields are rejected whole and never echoed', () => {
  for (const field of ['prompt', 'code', 'diff', 'description', 'stdout', 'token', 'ai_summary']) {
    const secret = 'SECRET-EXAMPLE-CONTENT';
    const result = project({ [field]: secret });
    assert.equal(result.ok, false, `${field} must be rejected`);
    assert.equal(result.reason, 'UNKNOWN_FIELD');
    assert.equal(JSON.stringify(result).includes(secret), false, `${field} must not be echoed back`);
  }
});

test('AC1: a hash of free text cannot pass as a reference', () => {
  const digest = 'a'.repeat(64);
  for (const field of ['operation_id', 'change_ref', 'project_ref']) {
    const result = project({ [field]: digest });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INVALID_REF');
  }
});

test('AC1: free text with spaces or punctuation in a reference is rejected', () => {
  for (const value of ['add login page', 'src/index.mjs', '', 'a'.repeat(129)]) {
    const result = project({ operation_id: value });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INVALID_REF');
  }
});

test('AC1: an oversize event is rejected as a whole, not truncated', () => {
  const result = project({ duration_ms: 1, change_ref: `c-${'x'.repeat(9000)}` });
  // The reference fails its length limit first; make the payload big with a legal field instead.
  assert.equal(result.ok, false);
  const wide = createProjection({ enums, maxEventBytes: 64 });
  const small = wide.project(base);
  assert.equal(small.ok, false);
  assert.equal(small.reason, 'OVERSIZE');
});

test('AC1: unknown event, unknown version, wrong type and unregistered enum are rejected', () => {
  assert.equal(project({ event_name: 'forge.custom.event' }).reason, 'UNKNOWN_EVENT');
  assert.equal(project({ schema_version: 'forge.observation.v2' }).reason, 'UNKNOWN_VERSION');
  assert.equal(project({ duration_ms: '1200' }).reason, 'INVALID_TYPE');
  assert.equal(project({ status: 'better-than-expected' }).reason, 'INVALID_ENUM');
  assert.equal(project({ occurred_at: '2026-10-24 09:59:58' }).reason, 'INVALID_TIME');
});

test('AC1: a known field that does not apply to the event is rejected separately', () => {
  const result = projection.project({
    schema_version: SCHEMA_VERSION,
    event_id: 'evt-change',
    event_name: 'forge.change.accepted',
    source_version: '0.1.0',
    emitted_at: '2026-10-24T10:00:00.000Z',
    change_ref: 'change-1',
    repository_ref: 'repo-1',
    operation_id: 'op-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NOT_APPLICABLE_FIELD');
});

test('AC2: a re-sent event keeps its id and the fold keeps one logical action', () => {
  const completed = project({ event_id: 'evt-a', result_version: 1, status: 'unknown' });
  const resent = project({ event_id: 'evt-a', result_version: 1, status: 'unknown' });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.event, resent.event, 'the same input must project to the same event');
  const folded = foldByOperation([completed.event, resent.event]);
  assert.equal(folded.operationCount, 1);
  assert.equal(folded.events.length, 1);
});

test('AC2: unknown then reconciled revises one action; order does not matter', () => {
  const first = project({ event_id: 'evt-1', result_version: 1, status: 'unknown' }).event;
  const reconciled = project({
    event_id: 'evt-2',
    event_name: 'forge.tool.reconciled',
    result_version: 2,
    status: 'success',
  }).event;
  for (const input of [[first, reconciled], [reconciled, first]]) {
    const folded = foldByOperation(input);
    assert.equal(folded.operationCount, 1, 'a revision is not a second action');
    assert.equal(folded.versions.get('op-1'), 2);
    assert.equal(folded.events.length, 1);
  }
});

test('AC2: AI review and human review stay distinct actions under one access kind', () => {
  const ai = project({ event_id: 'evt-ai', operation_id: 'op-ai', action: 'review.ai.publish', access_kind: 'review_write' });
  const human = project({ event_id: 'evt-human', operation_id: 'op-human', action: 'review.human.record', access_kind: 'review_write' });
  assert.equal(ai.ok, true);
  assert.equal(human.ok, true);
  assert.equal(ai.event.access_kind, human.event.access_kind);
  assert.notEqual(ai.event.action, human.event.action);
  const folded = foldByOperation([ai.event, human.event]);
  assert.equal(folded.operationCount, 2, 'two reviews are two logical actions, not one');
});

test('AC3: export is off by default and a disabled exporter sends nothing', async () => {
  const buffer = createBoundedBuffer();
  buffer.add(project({}).event);
  let calls = 0;
  const exporter = createBoundedExporter({ buffer, send: async () => ((calls += 1), { status: 200, ack: ['evt-1'] }) });
  assert.equal(exporter.enabled, false);
  assert.deepEqual(await exporter.exportOnce(), { status: 'skipped', reason: 'DISABLED' });
  assert.equal(calls, 0);
  assert.equal(buffer.stats().events, 1, 'a disabled export must not drain the buffer');
});

test('AC3: a partial acknowledgement removes only the confirmed items', async () => {
  const buffer = createBoundedBuffer();
  for (const id of ['evt-1', 'evt-2', 'evt-3']) buffer.add(project({ event_id: id }).event);
  const exporter = createBoundedExporter({
    buffer,
    enabled: true,
    send: async (batch) => ({ status: 200, ack: batch.slice(0, 2).map((event) => event.event_id) }),
  });
  const result = await exporter.exportOnce();
  assert.equal(result.status, 'sent');
  assert.equal(result.accepted, 2);
  assert.equal(result.pending, 1);
  assert.deepEqual(buffer.peek().map((event) => event.event_id), ['evt-3']);
});

test('AC3: 401 and 403 stop the export instead of retrying with another identity', async () => {
  for (const code of [401, 403]) {
    const buffer = createBoundedBuffer();
    buffer.add(project({}).event);
    let calls = 0;
    const exporter = createBoundedExporter({ buffer, enabled: true, send: async () => ((calls += 1), { status: code }) });
    assert.deepEqual(await exporter.exportOnce(), { status: 'stopped', code });
    assert.deepEqual(await exporter.exportOnce(), { status: 'skipped', reason: 'AUTH_STOPPED' });
    assert.equal(calls, 1, 'nothing may be retried after an authorization stop');
    assert.equal(buffer.stats().events, 1);
  }
});

test('AC3: 429 backs off within the cap and pauses after the configured failures', async () => {
  const buffer = createBoundedBuffer();
  buffer.add(project({}).event);
  let clock = 0;
  const exporter = createBoundedExporter({
    buffer,
    enabled: true,
    now: () => clock,
    random: () => 0,
    baseBackoffMs: 1000,
    maxBackoffMs: 300_000,
    send: async () => ({ status: 429, retryAfterMs: 60_000 }),
  });
  const first = await exporter.exportOnce();
  assert.equal(first.status, 'backoff');
  assert.ok(first.delayMs <= 300_000, 'the backoff must stay under the cap');
  assert.equal((await exporter.exportOnce()).reason, 'BACKOFF', 'no send before the backoff expires');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    clock += 600_000;
    await exporter.exportOnce();
  }
  assert.equal(exporter.state.status, 'paused', 'consecutive rate limits must pause the export');
  assert.equal(exporter.resume(), true);
  assert.equal((await exporter.exportOnce()).status, 'backoff');
});

test('AC3: an unknown response pauses unless the provider guarantees idempotency', async () => {
  const buffer = createBoundedBuffer();
  buffer.add(project({}).event);
  const strict = createBoundedExporter({ buffer, enabled: true, send: async () => { throw new Error('timeout'); } });
  assert.equal((await strict.exportOnce()).status, 'paused');
  assert.equal(buffer.stats().events, 1, 'an unknown response must keep the events for review');

  let clock = 0;
  const idempotent = createBoundedExporter({
    buffer,
    enabled: true,
    idempotentProvider: true,
    maxUnknownRetries: 2,
    now: () => clock,
    send: async () => { throw new Error('timeout'); },
  });
  assert.equal((await idempotent.exportOnce()).status, 'retry');
  clock += 600_000;
  assert.equal((await idempotent.exportOnce()).status, 'retry');
  clock += 600_000;
  assert.equal((await idempotent.exportOnce()).status, 'paused', 'retries are finite');
});

test('AC3: capacity, byte cap and TTL reject new events and are visible in stats', () => {
  let clock = 0;
  const small = createBoundedBuffer({ maxEvents: 2, now: () => clock });
  assert.equal(small.add(project({ event_id: 'evt-1' }).event).ok, true);
  assert.equal(small.add(project({ event_id: 'evt-2' }).event).ok, true);
  assert.deepEqual(small.add(project({ event_id: 'evt-3' }).event), { ok: false, reason: 'CAPACITY' });
  assert.equal(small.stats().dropped.capacity, 1);
  assert.equal(small.add(project({ event_id: 'evt-1' }).event).duplicate, true, 'a duplicate is not a new event');

  const tiny = createBoundedBuffer({ maxBytes: 16 });
  assert.deepEqual(tiny.add(project({}).event), { ok: false, reason: 'BYTES' });
  assert.equal(tiny.stats().dropped.bytes, 1);

  const expiring = createBoundedBuffer({ ttlMs: 1000, now: () => clock });
  expiring.add(project({}).event);
  clock = 2000;
  assert.equal(expiring.stats().events, 0, 'expired events must not be sent as fresh data');
  assert.equal(expiring.stats().dropped.ttl, 1);
});

test('AC4: an export failure never throws and never blocks the caller', async () => {
  const buffer = createBoundedBuffer();
  buffer.add(project({}).event);
  const exporter = createBoundedExporter({ buffer, enabled: true, send: async () => { throw new Error('boom'); } });
  await assert.doesNotReject(() => exporter.exportOnce());
  assert.equal(buffer.stats().events, 1);
});

test('AC4: a rejected loss report is counted, not re-emitted recursively', () => {
  const reporter = createLossReporter({ project: projection, sourceVersion: '0.1.0', now: () => '2026-10-24T10:00:00.000Z' });
  const good = reporter.report({
    reason: 'buffer_full',
    count: 3,
    windowStart: '2026-10-24T09:00:00.000Z',
    windowEnd: '2026-10-24T10:00:00.000Z',
  });
  assert.ok(good);
  assert.equal(good.event_name, 'forge.observation.loss');
  const bad = reporter.report({
    reason: 'not-a-reason',
    count: 0,
    windowStart: '2026-10-24T09:00:00.000Z',
    windowEnd: '2026-10-24T10:00:00.000Z',
  });
  assert.equal(bad, null);
  assert.deepEqual(reporter.counters, { emitted: 1, suppressed: 1 });
});

test('AC3: the export path has no disk queue', async () => {
  const source = await readFile(join(here, 'src', 'observe.mjs'), 'utf8');
  assert.doesNotMatch(source, /from 'node:fs|require\('node:fs\)/u, 'an unapproved persistent queue must not be added');
});

// ---- 接线（#36 交付物里的"投影/验证/有界导出接线"）----

test('wiring: observation is off unless explicitly enabled, and looks up no sink', async () => {
  const { apply } = await import('../src/index.mjs');
  let sinkLookups = 0;
  const provided = new Map();
  const ctx = {
    get(name) {
      if (name === 'observationSink') sinkLookups += 1;
      return undefined;
    },
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
    tools: { guard: () => () => {} },
  };
  apply(ctx, {});
  const service = provided.get('policy');
  const runtime = service.observations();
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.status, 'disabled');
  assert.equal(runtime.buffer, null, 'a disabled projection must not allocate a buffer');
  assert.equal(sinkLookups, 0, 'a disabled projection must not look for a sender');
  assert.deepEqual(await runtime.exportOnce(), { status: 'skipped', reason: 'DISABLED' });
  assert.deepEqual(runtime.record({ event_name: 'forge.tool.completed' }), { ok: false, reason: 'DISABLED' });
});

test('wiring: enabled without a sender fails closed with no-provider', async () => {
  const { apply } = await import('../src/index.mjs');
  const provided = new Map();
  const ctx = {
    get: () => undefined,
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
    tools: { guard: () => () => {} },
  };
  apply(ctx, { observation: { export: { enabled: true }, enums: { status: ['success'], action: ['repo.read'] } } });
  const service = provided.get('policy');
  const runtime = service.observations();
  assert.equal(runtime.enabled, true);
  assert.equal(runtime.status, 'no-provider');
  assert.deepEqual(await runtime.exportOnce(), { status: 'skipped', reason: 'NO_PROVIDER' });
});

test('wiring: enabled without registered enums stops visibly instead of dropping events', async () => {
  const { apply } = await import('../src/index.mjs');
  const provided = new Map();
  const ctx = {
    get: (name) => (name === 'observationSink' ? { send: async () => ({ status: 200, ack: [] }) } : undefined),
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
    tools: { guard: () => () => {} },
  };
  apply(ctx, { observation: { export: { enabled: true } } });
  const runtime = provided.get('policy').observations();
  assert.equal(runtime.status, 'unregistered-enums');
  assert.deepEqual(await runtime.exportOnce(), { status: 'skipped', reason: 'UNREGISTERED_ENUMS' });
});

test('wiring: an invalid observation config is refused at load time', async () => {
  const { apply } = await import('../src/index.mjs');
  const ctx = {
    get: () => undefined,
    provide: () => () => {},
    effect: (callback) => callback(),
    tools: { guard: () => () => {} },
  };
  for (const observation of [{ export: { enabled: 'yes' } }, { export: { batchSize: 0 } }, { export: 3 }]) {
    assert.throws(() => apply(ctx, { observation }), (error) => error.code === 'POLICY_CONFIG_INVALID');
  }
});

test('wiring: an enabled projection records through the sender and keeps bounds', async () => {
  const { apply } = await import('../src/index.mjs');
  const sent = [];
  const provided = new Map();
  const ctx = {
    get: (name) => (name === 'observationSink' ? { send: async (batch) => (sent.push(...batch.map((event) => event.event_id)), { status: 200, ack: [batch[0].event_id] }) } : undefined),
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
    tools: { guard: () => () => {} },
  };
  apply(ctx, {
    observation: {
      export: { enabled: true },
      enums: { status: ['success'], action: ['repo.read'] },
    },
  });
  const runtime = provided.get('policy').observations();
  assert.equal(runtime.status, 'ready');
  assert.equal(runtime.exportState, 'idle');
  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: 'evt-wire-1',
    event_name: 'forge.tool.completed',
    source_version: '0.1.0',
    emitted_at: '2026-10-24T10:00:00.000Z',
    operation_id: 'op-wire',
    action: 'repo.read',
    access_kind: 'read',
    status: 'success',
  };
  assert.equal(runtime.record(event).ok, true);
  assert.deepEqual(runtime.record({ ...event, event_id: 'evt-wire-2', prompt: 'secret' }), { ok: false, reason: 'UNKNOWN_FIELD' });
  const result = await runtime.exportOnce();
  assert.equal(result.status, 'sent');
  assert.equal(result.accepted, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(sent, ['evt-wire-1']);
});
