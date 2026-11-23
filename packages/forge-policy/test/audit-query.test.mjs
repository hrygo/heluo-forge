import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_COLUMNS,
  AUDIT_EMPTY_COPY,
  AUDIT_MISSING_COPY,
  AUDIT_UNREADABLE_COPY,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  formatAuditReport,
  formatAuditRow,
  formatAuditTime,
  parseAuditCount,
} from '../src/audit-query.mjs';

// P3 · /policy-audit 的纯展示层：条数解析、八列格式化、空态/不可读/坏行文案。
// 这里只锁格式化，不依赖真实 sink。
test('the default and maximum limits are documented values', () => {
  assert.equal(DEFAULT_AUDIT_LIMIT, 20);
  assert.equal(MAX_AUDIT_LIMIT, 200);
  assert.equal(AUDIT_COLUMNS, '时间 | 阶段 | 动作 | 目标 | 决策 | 规则 | 耗时 | agent.kind');
});

test('count parsing: default, requested, clamped and invalid fallback', () => {
  assert.deepEqual(parseAuditCount(undefined), { limit: 20 });
  assert.deepEqual(parseAuditCount(''), { limit: 20 });
  assert.deepEqual(parseAuditCount('  '), { limit: 20 });
  assert.deepEqual(parseAuditCount('7'), { limit: 7 });
  assert.deepEqual(parseAuditCount('200'), { limit: 200 });
  assert.deepEqual(parseAuditCount(3), { limit: 3 });

  assert.deepEqual(parseAuditCount('201'), { limit: 200, note: '超过上限，只显示最近 200 条。' });
  for (const invalid of ['0', '-1', 'abc', '3.5', '10a']) {
    assert.deepEqual(parseAuditCount(invalid), { limit: 20, note: '条数需为 1–200 的整数，已回退为 20。' }, invalid);
  }
});

test('time column is UTC with a trailing Z and never throws', () => {
  assert.equal(formatAuditTime(Date.UTC(2026, 10, 23, 8, 5, 9)), '2026-11-23 08:05:09Z');
  assert.equal(formatAuditTime(0), '1970-01-01 00:00:00Z');
  assert.equal(formatAuditTime(undefined), '-');
  assert.equal(formatAuditTime('not-a-time'), '-');
});

test('a row has exactly eight columns and hides directory structure', () => {
  const row = formatAuditRow({
    observedAt: Date.UTC(2026, 10, 23, 1, 2, 3),
    phase: 'begin',
    action: 'gitee.issue.write',
    target: ['', 'home', 'user', 'work', 'secret', '.env'].join('/'),
    decision: 'deny',
    rule: 'protectPaths',
    durationMs: 12,
    agent: { kind: 'agent' },
  });
  const columns = row.split(' | ');
  assert.equal(columns.length, 8);
  assert.deepEqual(columns, [
    '2026-11-23 01:02:03Z', 'begin', 'gitee.issue.write', '.env', 'deny', 'protectPaths', '12ms', 'agent',
  ]);
});

test('long fields are truncated and missing fields fall back', () => {
  const row = formatAuditRow({
    action: 'a'.repeat(60),
    rule: 'r'.repeat(40),
    target: 'x'.repeat(60),
  });
  const columns = row.split(' | ');
  assert.equal(columns[0], '-');
  assert.equal(columns[2].length, 48);
  assert.equal(columns[2].endsWith('…'), true);
  assert.equal(columns[3].length, 48);
  assert.equal(columns[5].length, 32);
  assert.equal(columns[6], '-');
  assert.equal(columns[7], 'unknown', 'a missing agent kind is spelled out, never omitted');
  assert.deepEqual(formatAuditRow({}).split(' | '), ['-', '-', '-', '-', '-', '-', '-', 'unknown']);
});

test('an empty or unreadable sink gets an actionable error, not a success header', () => {
  // 未配置审计（missing）与"配置了但确实没有记录"是两件事，文案不能混。
  assert.deepEqual(formatAuditReport({ records: [], missing: true }), { kind: 'error', text: AUDIT_MISSING_COPY });
  assert.deepEqual(formatAuditReport({ records: [] }), { kind: 'error', text: AUDIT_EMPTY_COPY });
  assert.match(AUDIT_MISSING_COPY, /没有启用审计/u);
  assert.deepEqual(formatAuditReport({ unreadable: true }), { kind: 'error', text: AUDIT_UNREADABLE_COPY });
  assert.match(AUDIT_EMPTY_COPY, /暂无审计记录/u);
  assert.match(AUDIT_UNREADABLE_COPY, /审计源不可读/u);
  assert.equal(AUDIT_UNREADABLE_COPY.includes('/'), false, 'the copy names no path');
});

test('a report lists newest-first rows and mentions skipped corrupt lines', () => {
  const records = [
    { observedAt: Date.UTC(2026, 10, 23, 2), action: 'gitee.issue.write', decision: 'allow' },
    { observedAt: Date.UTC(2026, 10, 23, 1), action: 'gitee.issue.write', decision: 'allow' },
  ];
  const report = formatAuditReport({ records, corrupt: 3 });
  assert.equal(report.kind, 'success');
  const lines = report.text.split('\n');
  assert.equal(lines[0], '最近 2 条审计记录（新 → 旧）');
  assert.equal(lines[1], AUDIT_COLUMNS);
  assert.equal(lines.length, 2 + records.length + 1);
  assert.equal(lines.at(-1), '另有 3 行无法解析，已跳过。');

  const clean = formatAuditReport({ records });
  assert.equal(clean.text.includes('无法解析'), false);
});

test('control characters in a field cannot forge rows or move the cursor', () => {
  const report = formatAuditReport({
    records: [{ observedAt: 0, action: 'gitee.issue.write\n伪造行\u001b[2K', decision: 'allow' }],
  });
  assert.equal(report.kind, 'success');
  // 换行与控制符被换成空格：既不会多出一行，也不会留下终端控制序列。
  assert.equal(report.text.includes('\n伪造行'), false);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(report.text), false);
  assert.equal(report.text.includes('伪造行'), true, 'the text itself is kept, only the layout characters are neutralized');
});

test('the count parser only accepts canonical decimals', () => {
  for (const raw of ['+5', '-0', '007', '1e3', '5 5']) {
    const parsed = parseAuditCount(raw);
    assert.equal(parsed.limit, DEFAULT_AUDIT_LIMIT, `${raw} must fall back to the default`);
    assert.equal(typeof parsed.note, 'string');
  }
  assert.deepEqual(parseAuditCount('7'), { limit: 7 });
  assert.equal(parseAuditCount(` ${DEFAULT_AUDIT_LIMIT} `).limit, DEFAULT_AUDIT_LIMIT);
});
