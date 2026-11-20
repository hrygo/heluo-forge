import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILTIN_RULE_SUMMARY,
  CONTENT_FIELDS,
  MAX_PAYLOAD_BYTES,
  MAX_RULES,
  compileContentRules,
  payloadsForAction,
  payloadsFromArguments,
  redactExcerpt,
  scanPayloads,
} from '../src/content-rules.mjs';

const orgRule = (extra = {}) => ({
  id: 'ORG-G-SECRET',
  severity: 'hard',
  pattern: 'SECRET',
  paths: ['.*'],
  ...extra,
});

const PEM = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

test('内置规则集是 9 条：H1/H2 拒绝、H3/H4 可确认、S1–S5 只记账', () => {
  assert.deepEqual(BUILTIN_RULE_SUMMARY.map((rule) => rule.id), [
    'BUILTIN-PRIVATE-KEY',
    'BUILTIN-CLOUD-ACCESS-KEY',
    'BUILTIN-CREDENTIAL-URL',
    'BUILTIN-TOKEN',
    'BUILTIN-ENV-COMMIT',
    'BUILTIN-INTERNAL-ADDRESS',
    'BUILTIN-ABSOLUTE-HOME',
    'BUILTIN-LONG-BASE64',
    'BUILTIN-ENV-FILE',
  ]);
  assert.deepEqual(BUILTIN_RULE_SUMMARY.map((rule) => rule.severity), [
    'hard', 'hard', 'confirm', 'confirm', 'soft', 'soft', 'soft', 'soft', 'soft',
  ]);
});

test('口令赋值与强制推送不再是内容规则（D43/D46）', () => {
  const { rules } = compileContentRules([]);
  const password = scanPayloads(rules, [{ field: 'body', text: 'password = "hunter2secret"' }]);
  assert.deepEqual(password.findings, []);
  const force = scanPayloads(rules, [{ field: 'body', text: 'git push --force origin main' }]);
  assert.deepEqual(force.findings, []);
});

test('私钥与云长期密钥进 hard 桶，令牌与连接串进 confirm 桶', () => {
  const { rules } = compileContentRules([]);
  const pem = scanPayloads(rules, [{ field: 'body', text: PEM }]);
  assert.equal(pem.hard.length, 1);
  assert.equal(pem.confirm.length, 0);
  const token = scanPayloads(rules, [{ field: 'body', text: ['ghp', 'A'.repeat(24)].join('_') }]);
  assert.equal(token.hard.length, 0);
  assert.equal(token.confirm.length, 1);
  assert.equal(token.confirm[0].rule, 'BUILTIN-TOKEN');
  // 拆分拼接：仓库的敏感扫描会把"协议://用户:口令@主机"当凭据，测试夹具不写这种完整字面量。
  const credential = ['postgres', '://svc', ':', 'Pa55', 'w0rd', '@db', '.internal/app'].join('');
  const url = scanPayloads(rules, [{ field: 'body', text: credential }]);
  assert.equal(url.confirm.length, 1);
  assert.equal(url.confirm[0].rule, 'BUILTIN-CREDENTIAL-URL');
});

test('S5 只认 .env 文件路径引用，不认 process.env 代码标识（D45）', () => {
  const { rules } = compileContentRules([]);
  const fileRef = scanPayloads(rules, [{ field: 'body', text: '见 .env.production 的配置' }]);
  assert.deepEqual(fileRef.soft.map((finding) => finding.rule), ['BUILTIN-ENV-FILE']);
  const code = scanPayloads(rules, [{ field: 'body', text: 'const key = process.env.OPENAI_API_KEY' }]);
  assert.deepEqual(code.soft.filter((finding) => finding.rule === 'BUILTIN-ENV-FILE'), []);
});

test('字节预算由一次调用的所有字段共享，超出的字段标截断（D50）', () => {
  const { rules } = compileContentRules([]);
  const half = 'a'.repeat(MAX_PAYLOAD_BYTES - 16);
  const outcome = scanPayloads(rules, [
    { field: 'body', text: half },
    { field: 'body', text: `${PEM} ${'b'.repeat(64)}` },
    { field: 'comment', text: 'tail' },
  ]);
  assert.equal(outcome.truncated, true);
  assert.deepEqual(outcome.skipped.map((item) => item.field), ['body', 'comment']);
  assert.equal(outcome.skipped.every((item) => item.reason === 'truncated'), true);
  // 截断点之后的内容不扫：私钥出现在被切掉的部分里就不再命中。
  assert.equal(outcome.hard.length, 0);
});

test('内容字段按动作声明，未知动作退回全局白名单（D47）', () => {
  assert.deepEqual(payloadsForAction('gitee.issue.write', { title: 't', body: 'b', comment: 'c' }).map((item) => item.field), ['title', 'body']);
  assert.deepEqual(payloadsForAction('gitee.review.record', { body: 'b' }), []);
  assert.deepEqual(
    payloadsForAction('gitee.git.push', { commits: [{ message: 'm1' }, { diff: 'd2' }] }).map((item) => item.field),
    ['commits[0].message', 'commits[1].diff'],
  );
  assert.deepEqual(
    payloadsForAction('change.clarification.write', { summary: 's', description: 'd', aiAc: 'a', body: 'ignore' }).map((item) => item.field),
    ['summary', 'description', 'aiAc'],
  );
  assert.deepEqual(payloadsForAction('unknown.action', { body: 'x', unrelated: 'nope' }).map((item) => item.field), ['body']);
  assert.equal(Object.keys(CONTENT_FIELDS).length, 6);
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

test('评审正文（review）里的私钥进 hard 桶，不依赖流程规则', () => {
  const { rules } = compileContentRules([]);
  const payloads = payloadsFromArguments({ review: `## 结论\n${PEM}` });
  assert.deepEqual(payloads.map((payload) => payload.field), ['review']);
  const outcome = scanPayloads(rules, payloads);
  assert.equal(outcome.hard.length, 1);
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

test('脱敏摘录只保留首尾 4 个字符', () => {
  const pattern = `${['AK', 'IA'].join('')}[0-9A-Z]{16}`;
  const { rules } = compileContentRules([orgRule({ pattern, severity: 'confirm' })]);
  const secret = ['AKIA', '1234567890ABCDEF'].join('');
  const outcome = scanPayloads(rules, [{ field: 'body', text: `prefix ${secret} end` }]);
  assert.equal(outcome.confirm.length, 1);
  assert.equal(outcome.confirm[0].excerpt, 'AKIA…CDEF');
});

test('超过 30 条组织规则在编译期拒绝（不做静默截断）', () => {
  const rules = Array.from({ length: MAX_RULES + 1 }, (_unused, index) => orgRule({ id: `ORG-${index}` }));
  assert.throws(() => compileContentRules(rules), (error) => error.code === 'POLICY_CONTENT_RULE_LIMIT');
});

test('redactExcerpt 对短串整体打码，不泄露任何字符', () => {
  assert.equal(redactExcerpt('short'), '***');
});
