import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { normalizeChangeBriefing } from '../packages/forge-devops/src/change-briefing.mjs';
import { parseRehearsalArgs, renderTraceHtml, runRehearsal } from '../scripts/probe/run-dop-mock-rehearsal.mjs';

function fixture(t, fault) {
  const root = mkdtempSync(join(tmpdir(), 'forge-trace-test-'));
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'forge-trace-test-'))); rmSync(root, { recursive: true, force: true }); });
  const options = { cliDir: root, repo: 'example/repo', targets: [{ changeId: 'DEMO123', issueNumber: 2 }, { changeId: 'DEMO456', issueNumber: 4 }], output: join(root, 'output') };
  const commands = [];
  const url = fault === 'repo-path' ? 'https://github.com/unrelated/other' : fault === 'repo-host' ? 'https://corp.example/example/repo' : 'https://github.com/example/repo';
  const dependencies = {
    readDop: (extra = {}) => ({ async read({ target }) {
      if (extra.OMS_MOCK_DOP_FAIL_GET === '1' || target === 'ZZZZZZ999999') throw Object.assign(new Error('synthetic CLI failure'), { code: 'CLI_FAILED' });
      const facts = normalizeChangeBriefing({ id: target, title: '<script>untrusted</script>', description: 'Requirement', status: 'open', acceptance_criteria: ['DOP acceptance'], sub_systems: [{ code: 'OTHER.demo', name: 'Other prefix subsystem' }], user_stories: [
        { code: 'US-1', title: 'Unscheduled', release_info: null },
        { code: 'US-2', title: 'Scheduled', release_info: { release_num: 'REL-2', release_name: 'Next' } },
      ] }, target);
      return { facts, status: 'unknown', observed_at: '2026-10-27T00:00:00Z' };
    } }),
    gh: (args) => {
      commands.push(args);
      if (args[0] === 'repo') return { nameWithOwner: fault === 'repo-name' ? 'wrong/repo' : options.repo, url: fault === 'repo-url' ? 'javascript:alert(1)' : url, defaultBranchRef: fault === 'branch' ? null : { name: 'main' } };
      if (args[0] === 'issue') {
        const number = Number(args[2]);
        const id = number === 2 ? 'DEMO123' : 'DEMO456';
        return { number: fault === 'issue-number' ? 999 : number, title: `[${id}] Test`, body: fault === 'body' ? 'No authoritative change declaration' : `## Reference\n- DOP change: ${id}\n## Acceptance\n- [ ] Issue acceptance`, state: number === 2 ? 'CLOSED' : 'OPEN', url: fault === 'issue-url' ? 'https://corp.example/wrong/issues/2' : `${url}/issues/${number}`, closedByPullRequestsReferences: fault === 'refs-type' ? null : number === 2 ? [{ number: fault === 'pr-number' ? 0 : 3, url: fault === 'cross-repo' ? 'https://corp.example/other/pull/3' : `${url}/pull/3` }] : [] };
      }
      if (args[0] === 'pr') return { number: fault === 'pr-mismatch' ? 7 : 3, state: 'MERGED', url: fault === 'pr-url' ? 'https://corp.example/other/pull/3' : `${url}/pull/3`, headRefOid: fault === 'pr-revision' ? null : 'a'.repeat(40) };
      throw new Error('unexpected command');
    },
  };
  return { options, dependencies, commands };
}

const args = () => ['--cli-dir', '/mock-cli', '--repo', 'example/repo', '--targets', 'DEMO123:2,DEMO456:4', '--out', '/tmp/new-run'];

test('parser requires explicit repo, issue mapping and a new output destination', () => {
  const result = parseRehearsalArgs(args());
  assert.equal(result.repo, 'example/repo'); assert.equal(result.targets[1].issueNumber, 4);
  for (const invalid of [[], ['--unknown', 'x'], [...args(), '--repo', 'again/repo'], ['--cli-dir'], ['--out', '--repo'],
    args().map((v) => v === 'example/repo' ? 'https://corp.example/repo' : v),
    args().map((v) => v === 'DEMO123:2,DEMO456:4' ? 'DEMO123:2,DEMO123:4' : v),
    args().map((v) => v === 'DEMO123:2,DEMO456:4' ? 'DEMO123:2,DEMO456:2' : v),
    args().map((v) => v === 'DEMO123:2,DEMO456:4' ? 'DEMO123:2;touch-file' : v),
    args().map((v) => v === 'DEMO123:2,DEMO456:4' ? 'DEMO123:9007199254740992' : v),
  ]) assert.throws(() => parseRehearsalArgs(invalid));
});

test('rehearsal makes fixed read calls, preserves provenance, and produces minimized paired audit', async (t) => {
  const { options, dependencies, commands } = fixture(t);
  const summary = await runRehearsal(options, dependencies);
  assert.equal(summary.changes.length, 2); assert.equal(summary.negativeChecks.length, 3); assert.equal(summary.remoteWrites, 0);
  assert.equal(summary.changes[0].facts.repository.basis, 'explicit current-user mapping');
  assert.equal(summary.changes[0].facts.sourceRevision, null); assert.equal(summary.changes[0].facts.engineeringReady, false);
  assert.equal(summary.changes[1].facts.release.number, 'REL-2'); assert.equal(summary.changes[1].closingPullRequests.length, 0);
  assert.equal(summary.changes[0].facts.fieldStates.repository, 'user-confirmed');
  assert.equal(summary.changes[0].facts.limitations.length, 1);
  assert.deepEqual(commands.map((a) => a.slice(0, 2)), [['repo', 'view'], ['issue', 'view'], ['pr', 'view'], ['issue', 'view']]);
  assert.equal(summary.auditRecords, 16);
  const records = readFileSync(join(options.output, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter((r) => r.phase === 'begin').length, records.filter((r) => r.phase === 'settle').length);
  assert.doesNotMatch(JSON.stringify(records), /Requirement|DOP acceptance|Issue acceptance|stdout|stderr/);
  const html = readFileSync(join(options.output, 'index.html'), 'utf8');
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /已有关闭\/合并是历史状态/); assert.match(html, /真实 GitHub/);
  assert.match(html, /DOP acceptance/); assert.match(html, /Issue acceptance/);
  assert.match(html, /OTHER.demo/); assert.match(html, /REL-2/);
  assert.equal(JSON.parse(readFileSync(join(options.output, 'trace.json'))).remoteWrites, 0);
  await assert.rejects(() => runRehearsal(options, dependencies), { code: 'EEXIST' });
});

for (const fault of ['repo-name', 'repo-url', 'repo-path', 'repo-host', 'branch', 'issue-number', 'body', 'issue-url', 'refs-type', 'pr-number', 'cross-repo', 'pr-mismatch', 'pr-url', 'pr-revision']) test(`unverified ${fault} cannot produce a completed trace`, async (t) => {
  const { options, dependencies } = fixture(t, fault);
  await assert.rejects(() => runRehearsal(options, dependencies));
  assert.equal(existsSync(join(options.output, 'index.html')), false);
});

test('a missing supplied CLI never falls through to an ambient dop', async (t) => {
  const { options, dependencies } = fixture(t);
  const sentinel = join(options.cliDir, 'unexpected-call');
  const ambient = join(options.cliDir, 'dop');
  writeFileSync(ambient, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'called'); process.exit(9);\n`, { mode: 0o700 });
  chmodSync(ambient, 0o700);
  delete dependencies.readDop;
  const previous = process.env.PATH;
  process.env.PATH = `${options.cliDir}${delimiter}${previous ?? ''}`;
  options.cliDir = join(options.cliDir, 'misspelled-directory');
  try { await assert.rejects(() => runRehearsal(options, dependencies), { code: 'CLI_NOT_FOUND' }); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  assert.equal(existsSync(sentinel), false);
});

test('HTML handles missing optional subsystem/release and preserves no-closing-PR qualifier', async (t) => {
  const { options, dependencies } = fixture(t);
  const summary = await runRehearsal(options, dependencies);
  summary.changes[1].facts.subsystems = []; summary.changes[1].facts.release = null;
  const html = renderTraceHtml(summary);
  assert.match(html, /未提供/); assert.match(html, /不等于仓库没有其他相关 PR/);
  assert.match(html, /default-src 'none'/);
});
