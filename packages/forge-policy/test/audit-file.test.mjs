import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PolicyAuditError, createAuditBarrier, createFileSink, createMemorySink } from '../src/audit.mjs';

const RECORD = { action: 'gitee.issue.write', actor: 'user-a', phase: 'begin' };

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-policy-audit-'));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the file sink writes one JSONL file per day under the directory', async () => {
  const { dir, clean } = tempDir();
  try {
    const sink = createFileSink({ dir });
    assert.equal(sink.durable, true);
    assert.equal(sink.kind, 'file');
    await sink.append(RECORD);
    await sink.append({ ...RECORD, phase: 'settle' });
    const names = readdirSync(dir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^forge-policy-\d{4}-\d{2}-\d{2}\.jsonl$/u);
    const lines = readFileSync(join(dir, names[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), RECORD);
    assert.deepEqual(sink.records(), [], 'a file sink keeps no in-process ring');
    assert.equal(sink.size(), 0);
  } finally {
    clean();
  }
});

test('the file sink creates a missing directory on demand', async () => {
  const { dir, clean } = tempDir();
  try {
    const sink = createFileSink({ dir: join(dir, 'nested', 'logs') });
    await sink.append(RECORD);
    assert.equal(readdirSync(join(dir, 'nested', 'logs')).length, 1);
  } finally {
    clean();
  }
});

test('the file sink prunes same-prefix files outside keepDays before writing', async () => {
  const { dir, clean } = tempDir();
  try {
    const now = Date.parse('2026-11-19T12:00:00.000Z');
    for (const stamp of ['2026-11-01', '2026-11-12', '2026-11-13', '2026-11-18']) {
      writeFileSync(join(dir, `forge-policy-${stamp}.jsonl`), '');
    }
    writeFileSync(join(dir, 'unrelated.jsonl'), '');
    const sink = createFileSink({ dir, keepDays: 7, now: () => now });
    await sink.append(RECORD);
    const names = readdirSync(dir).sort();
    // keepDays=7 → 保留 11-13 起（含当天）的 7 天窗口。
    assert.deepEqual(names, [
      'forge-policy-2026-11-13.jsonl',
      'forge-policy-2026-11-18.jsonl',
      'forge-policy-2026-11-19.jsonl',
      'unrelated.jsonl',
    ]);
  } finally {
    clean();
  }
});

test('a write failure raises POLICY_AUDIT_WRITE_FAILED with sink and file details', async () => {
  const sink = createFileSink({
    dir: '/nonexistent-path',
    fs: {
      mkdir: async () => {},
      readdir: async () => [],
      unlink: async () => {},
      appendFile: async () => {
        const error = new Error('disk on fire');
        error.code = 'ENOSPC';
        throw error;
      },
    },
  });
  await assert.rejects(sink.append(RECORD), (error) => {
    assert.equal(error instanceof PolicyAuditError, true);
    assert.equal(error.code, 'POLICY_AUDIT_WRITE_FAILED');
    assert.equal(error.details.sink, 'file');
    assert.match(error.details.file, /forge-policy-\d{4}-\d{2}-\d{2}\.jsonl$/u);
    assert.match(error.details.cause, /disk on fire/u);
    return true;
  });
});

test('a directory that cannot be created also fails closed', async () => {
  const sink = createFileSink({
    dir: '/forbidden',
    fs: {
      mkdir: async () => {
        throw new Error('EACCES');
      },
      readdir: async () => [],
      unlink: async () => {},
      appendFile: async () => {},
    },
  });
  await assert.rejects(sink.append(RECORD), (error) => error.code === 'POLICY_AUDIT_WRITE_FAILED');
});

test('a failed begin aborts the controlled call and leaves no memory fallback', async () => {
  const sink = createFileSink({
    dir: '/forbidden',
    fs: {
      mkdir: async () => {
        throw new Error('EACCES');
      },
      readdir: async () => [],
      unlink: async () => {},
      appendFile: async () => {},
    },
  });
  const audit = createAuditBarrier({ sink });
  await assert.rejects(audit.begin(RECORD), (error) => error.code === 'POLICY_AUDIT_WRITE_FAILED');
  assert.equal(audit.gaps().length, 0, 'a refused begin is not a gap');
  assert.equal(audit.isDegraded(), false);
});

test('a failed settle records a gap and degrades the barrier', async () => {
  const gaps = [];
  let calls = 0;
  const sink = {
    kind: 'file',
    durable: true,
    append: async () => {
      calls += 1;
      if (calls === 2) throw new PolicyAuditError('settle failed', 'POLICY_AUDIT_WRITE_FAILED');
    },
    records: () => [],
  };
  const audit = createAuditBarrier({ sink, onGap: (gap) => gaps.push(gap) });
  const receipt = await audit.begin(RECORD);
  const settled = await audit.settle(receipt, { decision: 'executed' });
  assert.equal(settled.action, 'gap');
  assert.equal(audit.isDegraded(), true);
  assert.equal(gaps[0].kind, 'settle-failed');
  await assert.rejects(audit.begin(RECORD), (error) => error.code === 'POLICY_AUDIT_GAP_OUTSTANDING');
  assert.equal(audit.acknowledgeGaps(), 1);
  assert.equal(audit.isDegraded(), false);
  await audit.begin(RECORD);
});

test('the barrier honours its timeout when a sink hangs', async () => {
  const audit = createAuditBarrier({
    sink: { kind: 'file', durable: true, append: () => new Promise(() => {}) },
    timeoutMs: 10,
  });
  await assert.rejects(audit.begin(RECORD), (error) => error.code === 'POLICY_AUDIT_TIMEOUT');
});

test('the memory sink reads newest first without mutating its ring', () => {
  const sink = createMemorySink({ buffer: 3 });
  for (const observedAt of [1, 2, 3, 4]) sink.append({ ...RECORD, observedAt });
  assert.deepEqual(sink.read({ limit: 2 }), {
    records: [{ ...RECORD, observedAt: 4 }, { ...RECORD, observedAt: 3 }],
    corrupt: 0,
    missing: false,
    unreadable: false,
  });
  assert.equal(sink.read().records.length, 3, 'the ring keeps the newest three');
  assert.deepEqual(sink.records().map((record) => record.observedAt), [2, 3, 4]);
  assert.equal(sink.size(), 3);
});

test('the file sink merges days newest-first, counts corrupt lines and never writes on read', async () => {
  const { dir, clean } = tempDir();
  try {
    const older = join(dir, 'forge-policy-2026-11-22.jsonl');
    const newer = join(dir, 'forge-policy-2026-11-23.jsonl');
    writeFileSync(older, `${JSON.stringify({ ...RECORD, observedAt: 1000 })}\n\n`);
    writeFileSync(newer, `${JSON.stringify({ ...RECORD, observedAt: 3000 })}\nnot-json\n${JSON.stringify({ ...RECORD, observedAt: 2000 })}\n`);
    const before = [readFileSync(older, 'utf8'), readFileSync(newer, 'utf8')];

    const sink = createFileSink({ dir });
    const snapshot = await sink.read({ limit: 10 });
    assert.equal(snapshot.corrupt, 1);
    assert.equal(snapshot.missing, false);
    assert.equal(snapshot.unreadable, false);
    assert.deepEqual(snapshot.records.map((record) => record.observedAt), [3000, 2000, 1000]);
    assert.deepEqual((await sink.read({ limit: 2 })).records.map((record) => record.observedAt), [3000, 2000]);
    assert.deepEqual([readFileSync(older, 'utf8'), readFileSync(newer, 'utf8')], before, 'reading does not rewrite');
    assert.deepEqual(readdirSync(dir).sort(), ['forge-policy-2026-11-22.jsonl', 'forge-policy-2026-11-23.jsonl']);
  } finally {
    clean();
  }
});

test('reading a missing audit directory reports missing and creates nothing', async () => {
  const { dir, clean } = tempDir();
  try {
    const missing = join(dir, 'does-not-exist');
    const sink = createFileSink({ dir: missing });
    assert.deepEqual(await sink.read({ limit: 5 }), { records: [], corrupt: 0, missing: true, unreadable: false });
    assert.equal(existsSync(missing), false, 'read must not create the audit directory');
  } finally {
    clean();
  }
});

test('permission failures read as unreadable, never as an empty history', async () => {
  const unreadableDir = createFileSink({
    dir: '/forbidden',
    fs: {
      readdir: async () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      },
    },
  });
  assert.deepEqual(await unreadableDir.read({ limit: 5 }), { records: [], corrupt: 0, missing: false, unreadable: true });

  const unreadableFile = createFileSink({
    dir: '/forbidden',
    fs: {
      readdir: async () => ['forge-policy-2026-11-23.jsonl'],
      readFile: async () => {
        const error = new Error('is a directory');
        error.code = 'EISDIR';
        throw error;
      },
    },
  });
  assert.deepEqual(await unreadableFile.read({ limit: 5 }), { records: [], corrupt: 0, missing: false, unreadable: true });
});

test('the barrier reads through the current sink and falls back to its ring', async () => {
  const legacy = createMemorySink({ buffer: 10 });
  for (const observedAt of [1, 2]) legacy.append({ ...RECORD, observedAt });
  const noRead = {
    kind: 'memory',
    durable: false,
    append: () => {},
    records: () => [{ ...RECORD, observedAt: 8 }, { ...RECORD, observedAt: 9 }],
  };
  const audit = createAuditBarrier({ sink: noRead });
  assert.deepEqual((await audit.read({ limit: 1 })).records.map((record) => record.observedAt), [9]);

  const fallback = createAuditBarrier({
    sink: {
      kind: 'memory',
      durable: false,
      append: () => {},
      records: () => [{ ...RECORD, observedAt: 5 }, { ...RECORD, observedAt: 6 }],
    },
  });
  assert.deepEqual((await fallback.read({ limit: 2 })).records.map((record) => record.observedAt), [6, 5]);

  const throwing = createAuditBarrier({
    sink: { kind: 'file', durable: true, append: () => {}, read: async () => { throw new Error('boom'); } },
  });
  assert.deepEqual(await throwing.read({ limit: 5 }), { records: [], corrupt: 0, missing: false, unreadable: true });

  const combined = createAuditBarrier({ sink: { kind: 'memory', durable: false, append: () => {}, read: () => ({ records: [], corrupt: 0, missing: false, unreadable: false }) } });
  combined.setSink(legacy);
  assert.deepEqual((await combined.read({ limit: 1 })).records.map((record) => record.observedAt), [2], 'setAuditSink affects later reads');
});

test('a read stops once it has enough records instead of parsing the whole history', async () => {
  const { dir, clean } = tempDir();
  try {
    const file = join(dir, 'forge-policy-2026-11-23.jsonl');
    writeFileSync(file, `not-json\n${JSON.stringify({ ...RECORD, observedAt: 5 })}\n${JSON.stringify({ ...RECORD, observedAt: 6 })}\n`);
    const sink = createFileSink({ dir });
    const snapshot = await sink.read({ limit: 1 });
    assert.deepEqual(snapshot.records.map((record) => record.observedAt), [6]);
    assert.equal(snapshot.corrupt, 0, 'lines older than the requested window are never parsed');
  } finally {
    clean();
  }
});

test('one unreadable day is skipped instead of losing the readable history', async () => {
  const sink = createFileSink({
    dir: '/mixed',
    fs: {
      readdir: async () => ['forge-policy-2026-11-23.jsonl', 'forge-policy-2026-11-22.jsonl'],
      readFile: async (file) => {
        if (String(file).includes('2026-11-23')) {
          const error = new Error('permission denied');
          error.code = 'EACCES';
          throw error;
        }
        return `${JSON.stringify({ ...RECORD, observedAt: 1000 })}\n`;
      },
    },
  });
  const snapshot = await sink.read({ limit: 5 });
  assert.deepEqual(snapshot.records.map((record) => record.observedAt), [1000]);
  assert.equal(snapshot.unreadable, false, 'a partially readable history is still a history');
  assert.equal(snapshot.missing, false);
});

test('an audit directory with no matching files is empty history, not unreadable', async () => {
  const sink = createFileSink({
    dir: '/empty',
    fs: {
      readdir: async () => ['other.log'],
      readFile: async () => '',
    },
  });
  assert.deepEqual(await sink.read({ limit: 5 }), { records: [], corrupt: 0, missing: false, unreadable: false });
});
