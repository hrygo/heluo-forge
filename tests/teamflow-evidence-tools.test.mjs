import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyJournalRoots } from '../scripts/probe/check-teamflow-journal-roots.mjs';
import { SCENARIOS, runFixtures, validateReport } from '../scripts/probe/run-teamflow-scenario-matrix.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const journalProbe = join(repo, 'scripts', 'probe', 'check-teamflow-journal-roots.mjs');
const matrixProbe = join(repo, 'scripts', 'probe', 'run-teamflow-scenario-matrix.mjs');

function run(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'teamflow-journal-'));
  const authorized = join(root, 'wt_authorized');
  const other = join(root, 'main-working-directory');
  mkdirSync(authorized, { recursive: true });
  mkdirSync(other, { recursive: true });
  return { root, authorized, other };
}

function writeJournal(root, name, payload) {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

// 正例：宿主只写 workspacePath，且该路径是授权根下尚未创建的子目录。
// 判据收窄后 stateRoot/commitRoot 缺失只记 unknown，不得把「宿主不提供」读成失败。
test('journal roots: aligned when workspacePath sits inside the authorized worktree', () => {
  const { root, authorized } = workspace();
  const declared = join(authorized, 'worktrees', 'run-1');
  const verdict = classifyJournalRoots({ authorizedRoot: authorized, journal: { workspacePath: declared } });
  assert.equal(verdict.status, 'aligned');
  assert.deepEqual(verdict.reasons, []);
  assert.ok(verdict.fields.workspacePath.endsWith(join('worktrees', 'run-1')), verdict.fields.workspacePath);
  assert.deepEqual(verdict.optional, { stateRoot: 'missing', commitRoot: 'missing' });

  const journalPath = writeJournal(root, 'aligned.json', { workspacePath: declared });
  const result = run([journalProbe, '--journal', journalPath, '--root', authorized]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'journal-roots: aligned');
  assert.match(result.stderr, /journal-roots: stateRoot unknown \(host does not provide\)/u);
  assert.match(result.stderr, /journal-roots: commitRoot unknown \(host does not provide\)/u);
  assert.doesNotMatch(result.stdout, /unknown|outside|missing/u);
});

// 观测例：workspacePath 在授权根内，但 stateRoot/commitRoot 指向主工作树。
// 观测字段只披露、不翻判定、不改退出码。
test('journal roots: aligned and exit 0 when only observational roots are outside', () => {
  const { root, authorized, other } = workspace();
  const journal = {
    workspacePath: authorized,
    stateRoot: join(other, 'logs/state'),
    commitRoot: join(other, '.git'),
  };
  const verdict = classifyJournalRoots({ authorizedRoot: authorized, journal });
  assert.equal(verdict.status, 'aligned');
  assert.deepEqual(verdict.reasons, []);
  assert.deepEqual(verdict.optional, { stateRoot: 'outside', commitRoot: 'outside' });

  const journalPath = writeJournal(root, 'observed.json', journal);
  const result = run([journalProbe, '--journal', journalPath, '--root', authorized]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'journal-roots: aligned');
  assert.match(result.stderr, /journal-roots: stateRoot outside authorized root \(observational, not a failure\)/u);
  assert.match(result.stderr, /journal-roots: commitRoot outside authorized root \(observational, not a failure\)/u);
  assert.doesNotMatch(result.stdout, /outside/u);
});

// 负例 A：workspacePath 指向主工作目录 → mismatch，原因必须点名是哪个字段。
test('journal roots: mismatch when workspacePath points at the main working directory', () => {
  const { root, authorized, other } = workspace();
  const verdict = classifyJournalRoots({
    authorizedRoot: authorized,
    journal: { workspacePath: other, stateRoot: join(authorized, 'logs/state'), commitRoot: authorized },
  });
  assert.equal(verdict.status, 'mismatch');
  assert.match(verdict.reasons.join('\n'), /workspacePath outside authorized root/u);
  // 另两个字段都在根内，也不能把越界的 workspacePath 救回来。
  assert.deepEqual(verdict.optional, { stateRoot: 'within', commitRoot: 'within' });

  const journalPath = writeJournal(root, 'outside.json', {
    workspacePath: other,
    stateRoot: join(authorized, 'logs/state'),
    commitRoot: authorized,
  });
  const result = run([journalProbe, '--journal', journalPath, '--root', authorized]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim(), 'journal-roots: mismatch');
  assert.match(result.stderr, /journal-roots: workspacePath outside authorized root: .*main-working-directory/u);
});

// 负例 B：journal 里没有 workspacePath（只有别的字段）→ mismatch / 1，不再是 unknown / 2。
test('journal roots: mismatch and exit 1 when workspacePath is missing', () => {
  const { root, authorized } = workspace();
  const verdict = classifyJournalRoots({ authorizedRoot: authorized, journal: { stateRoot: authorized, commitRoot: authorized } });
  assert.equal(verdict.status, 'mismatch');
  assert.deepEqual(verdict.fields, {});
  assert.match(verdict.reasons.join('\n'), /workspacePath missing/u);

  const journalPath = writeJournal(root, 'missing.json', { stateRoot: authorized, commitRoot: authorized });
  const result = run([journalProbe, '--journal', journalPath, '--root', authorized]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim(), 'journal-roots: mismatch');
  assert.match(result.stderr, /journal-roots: workspacePath missing/u);
  assert.doesNotMatch(result.stdout, /unknown/u);
});

// 缺证：没有 journal 时命令行只报 NOT RUN，不猜归属，也不让 CI 变红。
test('journal roots CLI: NOT RUN without a journal', () => {
  const result = run([journalProbe]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NOT RUN \(no journal\)/u);
});

// 用法与 IO：有 --journal 无 --root、文件不存在、内容不可解析都落退出码 2。
test('journal roots CLI: exit 2 on usage and IO errors', () => {
  const { root, authorized } = workspace();
  const journalPath = writeJournal(root, 'valid.json', { workspacePath: authorized });

  const noRoot = run([journalProbe, '--journal', journalPath]);
  assert.equal(noRoot.status, 2, noRoot.stderr);
  assert.match(noRoot.stderr, /--root is required/u);

  const absent = run([journalProbe, '--journal', join(root, 'no-such-journal.json'), '--root', authorized]);
  assert.equal(absent.status, 2, absent.stderr);
  assert.match(absent.stderr, /journal not found/u);

  const brokenPath = join(root, 'broken.json');
  writeFileSync(brokenPath, '{ not a journal', 'utf8');
  const broken = run([journalProbe, '--journal', brokenPath, '--root', authorized]);
  assert.equal(broken.status, 2, broken.stderr);
  assert.match(broken.stderr, /unreadable journal/u);
});

test('scenario matrix: every fixture assertion passes and the host column is NOT RUN', () => {
  const output = run([matrixProbe, '--fixtures']);
  assert.equal(output.status, 0, output.stderr);
  const fixtures = runFixtures({ root: repo });
  assert.equal(fixtures.length, 9);
  assert.ok(fixtures.every((entry) => entry.ok), JSON.stringify(fixtures.filter((entry) => !entry.ok)));
  assert.equal((output.stdout.match(/\| NOT RUN \|/gu) ?? []).length, SCENARIOS.length);
});

test('scenario matrix: a report claiming host evidence must carry a command and a date', () => {
  const { root } = workspace();
  const header = '| 场景 | 守则 | 夹具结论 | 来源类型 | 真实宿主 | 命令 | 时间 |\n|---|---|---|---|---|---|---|';
  const rows = SCENARIOS.map((scenario, index) => {
    const host = index === 0 ? '通过' : 'NOT RUN';
    const command = index === 0 ? '—' : '—';
    return `| ${scenario.title} | ${scenario.rule} | 满足 | ${index === 0 ? 'host-execution' : 'fixture'} | ${host} | ${command} | — |`;
  });
  const report = `${header}\n${rows.join('\n')}\n`;
  const verdict = validateReport(report);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((error) => error.includes('真实宿主有结论但没有命令')), verdict.errors.join('\n'));

  const fixed = report.replace('| 通过 | — | — |', '| 通过 | node scripts/probe/run-teamflow-scenario-matrix.mjs | 2026-11-05 |');
  const second = validateReport(fixed);
  assert.equal(second.ok, true, second.errors.join('\n'));

  const reportPath = join(root, 'qa-report.md');
  writeFileSync(reportPath, fixed, 'utf8');
  const result = run([matrixProbe, '--report', reportPath]);
  assert.equal(result.status, 0, result.stderr);
});
