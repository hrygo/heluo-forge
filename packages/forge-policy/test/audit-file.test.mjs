import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PolicyAuditError, createAuditBarrier, createFileSink } from '../src/audit.mjs';

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
