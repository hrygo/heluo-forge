import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_RULES, compileContentRules, payloadsFromArguments, redactExcerpt, scanPayloads } from '../src/content-rules.mjs';

const orgRule = (extra = {}) => ({
  id: 'ORG-G-SECRET',
  severity: 'hard',
  pattern: 'SECRET',
  paths: ['.*'],
  ...extra,
});

test('组织规则带 g 标志时逐次复扫，不因 lastIndex 残留漏检', () => {
  const { rules } = compileContentRules([orgRule({ flags: 'g' })]);
  const first = scanPayloads(rules, [{ field: 'body', text: 'SECRET once' }]);
  const second = scanPayloads(rules, [{ field: 'body', text: 'SECRET once' }]);
  assert.equal(first.hard.length, 1);
  assert.equal(second.hard.length, 1, '第二次相同内容也必须命中');
  const repeated = scanPayloads(rules, [
    { field: 'body', text: 'SECRET' },
    { field: 'title', text: 'SECRET' },
  ]);
  assert.equal(repeated.hard.length, 2, '同一规则在多个字段上都要命中');
});

test('脱敏摘录只保留首尾 4 个字符', () => {
  const pattern = `${['AK', 'IA'].join('')}[0-9A-Z]{16}`;
  const { rules } = compileContentRules([orgRule({ pattern })]);
  const secret = ['AKIA', '1234567890ABCDEF'].join('');
  const outcome = scanPayloads(rules, [{ field: 'body', text: `prefix ${secret} end` }]);
  assert.equal(outcome.hard.length, 1);
  assert.equal(outcome.hard[0].excerpt, 'AKIA…CDEF');
});

test('超过 30 条组织规则在编译期拒绝（不做静默截断）', () => {
  const rules = Array.from({ length: MAX_RULES + 1 }, (_unused, index) => orgRule({ id: `ORG-${index}` }));
  assert.throws(() => compileContentRules(rules), (error) => error.code === 'POLICY_CONTENT_RULE_LIMIT');
});

test('评审正文（review）进入关键字扫描，不是只给流程规则看', () => {
  const { rules } = compileContentRules([]);
  const payloads = payloadsFromArguments({ review: '## 结论\n通过\n> AI 生成：provider=gitee · PR 版本：abc1234' });
  assert.deepEqual(payloads.map((payload) => payload.field), ['review']);
  const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const outcome = scanPayloads(rules, payloadsFromArguments({ review: `## 结论\n${pem}` }));
  assert.equal(outcome.hard.length > 0, true, '评审正文里的 HARD 命中必须被拒');
  assert.equal(outcome.hard[0].field, 'review');
});

test('正文载荷只取已知文本键，提交集合逐条展开', () => {
  const payloads = payloadsFromArguments({
    body: 'x',
    title: 'y',
    commits: [{ message: 'm1' }, { diff: 'd2' }],
    unrelated: 'nope',
  });
  assert.deepEqual(payloads.map((item) => item.field).sort(), [
    'body', 'commits[0].message', 'commits[1].diff', 'title',
  ]);
});

test('二进制载荷跳过并记原因，不尝试解码', () => {
  const { rules } = compileContentRules([]);
  const outcome = scanPayloads(rules, [{ field: 'diff', text: 'bin\u0000ary' }]);
  assert.equal(outcome.findings.length, 0);
  assert.deepEqual(outcome.skipped.map((item) => item.reason), ['binary-skipped']);
});

test('redactExcerpt 对短串整体打码，不泄露任何字符', () => {
  assert.equal(redactExcerpt('short'), '***');
});
