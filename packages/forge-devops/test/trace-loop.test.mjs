import test from 'node:test';
import assert from 'node:assert/strict';
import { assessIssueClosure, buildWriteSteps, commitPrefixPattern, isMerged, issueReferencesChange, LOOP_CHECKS, LOOP_REASONS, renderLoopHtml } from '../src/trace-loop.mjs';

const CHANGE = 'ARD123456';
const REPO_URL = 'https://gitee.corp.example/demo/repo';
const merged = (overrides = {}) => ({
  number: 3, url: `${REPO_URL}/pull/3`, state: 'MERGED', headRefOid: 'a'.repeat(40),
  mergedAt: '2026-06-20T00:00:00Z',
  commits: [{ oid: 'b'.repeat(40), messageHeadline: `[${CHANGE}] deliver synthetic change` }],
  ...overrides,
});
const issue = { number: 2, state: 'OPEN', url: `${REPO_URL}/issues/2`, body: `- DOP change: ${CHANGE}` };
const acceptance = { verified: true, by: 'svc-pmo', at: '2026-06-21T00:00:00Z', evidence: 'acceptance-record-1' };
const assess = (overrides = {}) => assessIssueClosure({
  changeId: CHANGE, issue, pullRequests: [merged()], acceptance, repositoryUrl: REPO_URL, ...overrides,
});
const check = (result, id) => result.checks.find((item) => item.id === id);

test('commit prefix matches the exact change id only', () => {
  const pattern = commitPrefixPattern(CHANGE);
  assert.equal(pattern.test(`[${CHANGE}] do work`), true);
  assert.equal(pattern.test(`[${CHANGE}]`), true);
  assert.equal(pattern.test(`[ARD1234567] other change`), false);
  assert.equal(pattern.test(`feat: [${CHANGE}] late prefix`), false);
  assert.throws(() => commitPrefixPattern('lowercase'), /BAD_CHANGE_ID/u);
});

test('issue linkage requires the explicit DOP change line', () => {
  assert.equal(issueReferencesChange(CHANGE, `## Reference\n- DOP change: ${CHANGE}\n`), true);
  assert.equal(issueReferencesChange(CHANGE, `DOP change: ARD999999`), false);
  assert.equal(issueReferencesChange(CHANGE, 'no reference at all'), false);
  assert.equal(issueReferencesChange('bad id', 'anything'), false);
  assert.equal(issueReferencesChange(CHANGE, null), false);
});

test('merged requires state and a parsed merge time', () => {
  assert.equal(isMerged(merged()), true);
  assert.equal(isMerged(merged({ mergedAt: null })), false);
  assert.equal(isMerged(merged({ mergedAt: 'not-a-date' })), false);
  assert.equal(isMerged(merged({ state: 'OPEN' })), false);
  assert.equal(isMerged(null), false);
});

test('complete evidence makes the issue closable and reports every check', () => {
  const result = assess();
  assert.equal(result.closable, true);
  assert.equal(result.state, 'closable');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.checks.map((c) => c.id), [LOOP_CHECKS.CHANGE_LINKED, 'same-repository', LOOP_CHECKS.PR_MERGED, LOOP_CHECKS.COMMIT_PREFIX, LOOP_CHECKS.ACCEPTANCE_EVIDENCE]);
  assert.equal(result.mergedPullRequests[0].commits.length, 1);
});

test('missing linkage, merge, prefix or acceptance each block closure', () => {
  const cases = [
    [{ issue: { ...issue, body: 'unrelated' } }, LOOP_CHECKS.CHANGE_LINKED, LOOP_REASONS.CHANGE_LINK_MISSING],
    [{ pullRequests: [] }, LOOP_CHECKS.PR_MERGED, LOOP_REASONS.PR_NOT_MERGED],
    [{ pullRequests: [merged({ commits: null })] }, LOOP_CHECKS.COMMIT_PREFIX, LOOP_REASONS.COMMITS_NOT_RETURNED],
    [{ pullRequests: [merged({ commits: [{ oid: 'c'.repeat(40), messageHeadline: 'no prefix' }] })] }, LOOP_CHECKS.COMMIT_PREFIX, LOOP_REASONS.COMMIT_PREFIX_MISSING],
    [{ acceptance: null }, LOOP_CHECKS.ACCEPTANCE_EVIDENCE, LOOP_REASONS.ACCEPTANCE_MISSING],
    [{ acceptance: { verified: false, by: 'x', at: '2026-06-21T00:00:00Z' } }, LOOP_CHECKS.ACCEPTANCE_EVIDENCE, LOOP_REASONS.ACCEPTANCE_MISSING],
  ];
  for (const [override, id, detail] of cases) {
    const result = assess(override);
    assert.equal(result.closable, false, id);
    assert.equal(check(result, id).ok, false, id);
    assert.equal(check(result, id).detail, detail, id);
    assert.ok(result.blockers.includes(id), id);
  }
});

test('a merged state without merge time does not count as merged', () => {
  const result = assess({ pullRequests: [merged({ mergedAt: null })] });
  assert.equal(check(result, LOOP_CHECKS.PR_MERGED).ok, false);
  assert.equal(result.closable, false);
});

test('cross-repository closing references are rejected', () => {
  const result = assess({ pullRequests: [merged({ url: 'https://gitee.corp.example/other/repo/pull/3' })] });
  assert.equal(check(result, 'same-repository').ok, false);
  assert.equal(result.closable, false);
});

test('offending headlines are reported but bounded', () => {
  const commits = Array.from({ length: 12 }, (_, i) => ({ oid: 'd'.repeat(40), messageHeadline: `bad ${i}` }));
  const result = assess({ pullRequests: [merged({ commits })] });
  assert.equal(check(result, LOOP_CHECKS.COMMIT_PREFIX).offendingHeadlines.length, 10);
});

test('write plan never claims execution and carries the change id', () => {
  const plan = buildWriteSteps({ changeId: CHANGE, repository: 'gitee.corp.example/demo/repo' });
  assert.equal(plan.mode, 'plan-only');
  assert.equal(plan.executed, false);
  assert.ok(plan.steps.every((step) => step.executed === false && step.approval === 'required'));
  assert.deepEqual(plan.steps.map((s) => s.name), ['create-issue', 'create-branch', 'commit', 'push', 'open-pr']);
  assert.ok(plan.steps[2].argv.includes(`[${CHANGE}] <message>`));
  assert.throws(() => buildWriteSteps({ changeId: CHANGE, repository: 'demo/repo' }), /BAD_REPOSITORY/u);
  assert.throws(() => buildWriteSteps({ changeId: 'bad', repository: 'a/b/c' }), /BAD_CHANGE_ID/u);
});

test('html report escapes untrusted text and stays offline', () => {
  const html = renderLoopHtml(assess({ pullRequests: [merged({ commits: [{ oid: 'e'.repeat(40), messageHeadline: '<script>alert(1)</script>' }] })] }), buildWriteSteps({ changeId: CHANGE, repository: 'gitee.corp.example/demo/repo' }));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('不可关闭'));
  assert.ok(html.includes('写动作计划（未执行）'));
});
