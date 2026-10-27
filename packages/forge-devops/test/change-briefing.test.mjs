import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeChangeBriefing, createDopReader, renderBriefingHtml, renderBriefingText } from '../src/change-briefing.mjs';
import { cliEnvironment, main, readChangeReport } from '../src/change-cli.mjs';
import { normalizeReadResult } from '../src/read.mjs';

const cli = fileURLToPath(new URL('../src/change-cli.mjs', import.meta.url));
const demo = fileURLToPath(new URL('../src/demo-dop.mjs', import.meta.url));
const raw = () => ({ id: 'DEMO100001', title: '演示标题', status: 'open', description: '需求正文', acceptance_criteria: ['独立验收一项'] });
const reader = () => createDopReader({ executable: process.execPath, prefixArgs: [demo], env: cliEnvironment() });
const io = () => { let stdout = '', stderr = ''; return { stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } }, result: () => ({ stdout, stderr }) }; };

test('selected change projects only verified fields and never fabricates a revision/repository', () => {
  const facts = normalizeChangeBriefing({ ...raw(), approved: true, principal: 'forged', repository: 'wrong', requirement_revision: 'guessed', secret: 'CANARY' }, 'DEMO100001');
  assert.equal(facts.sourceRevision, null); assert.equal(facts.repository, null); assert.equal(facts.engineeringReady, false);
  assert.equal(facts.fieldStates.sub_systems, 'missing'); assert.equal(facts.release, null);
  assert.doesNotMatch(JSON.stringify(facts), /CANARY|forged|guessed|wrong/);
});

test('newline is not a valid explicit change ID even at the pure normalizer boundary', () => {
  assert.throws(() => normalizeChangeBriefing({ ...raw(), id: 'DEMO100001\n' }, 'DEMO100001\n'), { code: 'BAD_CHANGE_ID' });
});

for (const [label, value, code] of [
  ['nonobject', [], 'INVALID_CHANGE'], ['wrong target', { ...raw(), id: 'DEMO100002' }, 'CHANGE_ID_MISMATCH'],
  ['title', { ...raw(), title: '' }, 'MISSING_TITLE'], ['status', { ...raw(), status: null }, 'MISSING_STATUS'],
  ['description', { ...raw(), description: {} }, 'MISSING_DESCRIPTION'], ['acceptance empty', { ...raw(), acceptance_criteria: [] }, 'MISSING_ACCEPTANCE'],
  ['acceptance type', { ...raw(), acceptance_criteria: [42] }, 'MISSING_ACCEPTANCE'],
  ['subsystems type', { ...raw(), sub_systems: {} }, 'INVALID_SUBSYSTEMS'], ['subsystem item', { ...raw(), sub_systems: [{}] }, 'INVALID_SUBSYSTEMS'],
  ['stories type', { ...raw(), user_stories: false }, 'INVALID_STORIES'], ['story item', { ...raw(), user_stories: [{}] }, 'INVALID_STORIES'],
  ['release type', { ...raw(), user_stories: [{ code: 'US-1', title: '故事', release_info: [] }] }, 'INVALID_RELEASE'],
]) test(`invalid ${label} refuses a misleading briefing`, () => assert.throws(() => normalizeChangeBriefing(value, 'DEMO100001'), { code }));

test('release comes from first nonempty nested story; null/empty/missing remain explicit', () => {
  const facts = normalizeChangeBriefing({ ...raw(), sub_systems: null, user_stories: [
    { code: 'US-0', title: '未挂排期', release_info: null },
    { code: 'US-1', title: '空排期', release_info: { release_num: '' } },
    { code: 'US-2', title: '真实排期', release_info: { release_num: 'REL-2' } },
    { code: 'US-3', title: '另一个排期', release_info: { release_num: 'REL-3', release_name: '不取此项' } },
  ] }, 'DEMO100001');
  assert.deepEqual(facts.release, { number: 'REL-2', name: null }); assert.equal(facts.fieldStates.sub_systems, 'null');
  const empty = normalizeChangeBriefing({ ...raw(), sub_systems: [], user_stories: [] }, 'DEMO100001');
  assert.equal(empty.fieldStates.user_stories, 'empty'); assert.equal(empty.release, null);
});

test('only supported read action reaches process; real child data survives shared unknown normalizer', async () => {
  await assert.rejects(() => reader().read({ action: 'change.done', target: 'DEMO100001' }), { code: 'UNSUPPORTED_DOP_ACTION' });
  const result = await reader().read({ action: 'change.read', target: 'DEMO100001' });
  const normalized = normalizeReadResult({ action: 'change.read', target: 'DEMO100001', result });
  assert.equal(normalized.status, 'unknown'); assert.equal(normalized.source_revision, null);
  assert.equal(normalized.facts.acceptance.length, 4); assert.equal(normalized.facts.release.number, 'REL-DEMO-1');
  assert.equal(normalizeReadResult({ action: 'change.read', target: 'DEMO100001', result: { ...result, source_revision: 'R-1', status: 'succeeded' } }).facts.id, 'DEMO100001');
});

test('shared policy denies missing/failing necessary audit with zero reader calls', async () => {
  let calls = 0;
  const read = { read() { calls++; throw new Error('must not execute'); } };
  for (const sink of [undefined, { durable: false, append() {} }, { durable: true, append() { throw new Error('failure'); } }]) {
    await assert.rejects(() => readChangeReport({ changeId: 'DEMO100001', reader: read, sink }), { code: 'POLICY_DENIED' });
  }
  assert.equal(calls, 0);
});

test('shared audit settles real read and prevents a settled gap being shown as complete', async () => {
  const records = [];
  const report = await readChangeReport({ changeId: 'DEMO100001', reader: reader(), sink: { durable: true, append(record) { records.push(record); } } });
  assert.deepEqual(records.map((r) => r.phase), ['begin', 'settle']);
  assert.doesNotMatch(JSON.stringify(records), /图书|acceptance_criteria/);
  assert.match(renderBriefingText(report), /独立验收项/);
  let writes = 0;
  await assert.rejects(() => readChangeReport({ changeId: 'DEMO100001', reader: reader(), sink: { durable: true, append() { if (++writes > 1) throw new Error('fail settle'); } } }), { code: 'AUDIT_SETTLEMENT_FAILED' });
});

test('HTML is offline, escaped, and separates requirement items from an acceptance verdict', () => {
  const facts = normalizeChangeBriefing({ ...raw(), title: '<script>alert(1)</script>', description: '& \"quoted\"', acceptance_criteria: ["<img src='https://evil.example'>"] }, 'DEMO100001');
  const report = { facts, mode: 'demo', auditMode: 'test', observedAt: 'now' };
  const html = renderBriefingHtml(report);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&amp;/); assert.match(html, /&#39;/);
  assert.doesNotMatch(html, /<script|<img|<link|<iframe/);
  assert.match(html, /default-src 'none'/); assert.match(html, /不是本报告宣称业务验收通过/);
  assert.match(renderBriefingText(report), /未提供/);
});

test('terminal report strips OSC/ANSI/C1 and bidi controls from platform strings', () => {
  const facts = normalizeChangeBriefing({ ...raw(), title: '\u001b]52;c;CANARY\u0007\u202e', description: '\u009b31m正文\r伪装' }, 'DEMO100001');
  const text = renderBriefingText({ facts, mode: 'live' });
  assert.doesNotMatch(text, /[\u001b\u0007\u009b\r\u202e]/u);
  assert.match(text, /正文/);
});

test('CLI environment keeps ambient directories but strips unrelated credentials and NODE_OPTIONS', () => {
  assert.deepEqual(cliEnvironment({ PATH: '/path', HOME: '/home', SystemRoot: 'root', OPENAI_API_KEY: 'CANARY', NODE_OPTIONS: 'CANARY', DOP_TOKEN: 'CANARY' }), { PATH: '/path', HOME: '/home', SystemRoot: 'root' });
});

test('one-command demo emits readable text/JSON and a private offline HTML file without overwriting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-briefing-'));
  const out = join(dir, 'report.html');
  const output = execFileSync(process.execPath, [cli, 'demo', '--out', out], { encoding: 'utf8' });
  assert.match(output, /图书借阅/); assert.match(readFileSync(out, 'utf8'), /REL-DEMO-1/);
  if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
  const before = readFileSync(out, 'utf8');
  const repeat = spawnSync(process.execPath, [cli, 'demo', '--out', out], { encoding: 'utf8' });
  assert.equal(repeat.status, 1); assert.match(repeat.stderr, /OUTPUT_EXISTS/); assert.equal(readFileSync(out, 'utf8'), before);
  const parsed = JSON.parse(execFileSync(process.execPath, [cli, 'demo', '--json'], { encoding: 'utf8' }));
  assert.equal(parsed.mode, 'demo'); assert.equal(parsed.facts.engineeringReady, false);
  const badDir = io(); assert.equal(await main(['demo', '--out', join(dir, 'absent', 'x.html')], badDir), 1);
  assert.match(badDir.result().stderr, /LOCAL_IO_FAILED/);
});

for (const [scenario, code] of [['denied', 'AUTH_FAILED'], ['malformed', 'INVALID_JSON'], ['timeout', 'CLI_TIMEOUT']]) test(`demo real subprocess ${scenario} is visibly failed without business write`, () => {
  const result = spawnSync(process.execPath, [cli, 'demo', '--scenario', scenario], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, new RegExp(code)); assert.equal(result.stdout, '');
});

test('bad CLI options and absent audit cannot reach real enterprise executable', async () => {
  for (const args of [
    ['unknown'], ['demo', '--unknown'], ['demo', '--json', '--json'], ['demo', '--cli', '/any'],
    ['demo', '--scenario', 'bogus'], ['view', 'DEMO100001'],
    ['view', 'DEMO100001', '--cli', 'relative', '--audit-file', 'new'],
    ['view', 'DEMO100001', '--cli', '/unsafe.cmd', '--audit-file', 'new'],
    ['view', 'DEMO100001', '--cli', '/any', '--audit-file', 'same', '--out', 'same'],
  ]) { const capture = io(); assert.equal(await main(args, capture), 1); assert.equal(capture.result().stdout, ''); }
  const capture = io(); assert.equal(await main(['--help'], capture), 0); assert.match(capture.result().stdout, /heluo-change demo/);
});

test('live diagnostic refuses missing CLI, keeps private minimal audit without report body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-live-read-'));
  const audit = join(dir, 'audit.jsonl'); const capture = io();
  assert.equal(await main(['view', 'DEMO100001', '--cli', join(dir, 'no-such-dop'), '--audit-file', audit], capture), 1);
  assert.match(capture.result().stderr, /CLI_NOT_FOUND/);
  const records = readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((r) => r.phase), ['begin', 'settle']);
  assert.doesNotMatch(JSON.stringify(records), /description|acceptance_criteria|stderr|stdout/);
  if (process.platform !== 'win32') assert.equal(statSync(audit).mode & 0o777, 0o600);
});
