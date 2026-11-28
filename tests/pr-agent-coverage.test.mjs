import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyReviewCoverage, verifyReviewFileModes } from '../scripts/pr-agent-coverage.mjs';
import { buildReviewComments } from '../scripts/pr-agent-review-comments.mjs';

function digest(rows) {
  return createHash('sha256').update(rows).digest('hex');
}

const review = { merge_recommendation: 'no_concerns_found', security_concerns: 'No', key_issues_to_review: [] };
const modified = {
  filename: 'src/新 文件.js',
  status: 'modified',
  patch: '@@ -1,3 +1,3 @@ function f()\n context\n-before \t\r\n+之后 \t\r\n tail\n@@ -10 +10 @@\n-old end\n+',
  additions: 2,
  deletions: 2,
};
const added = { filename: 'added.js', status: 'added', patch: '@@ -0,0 +1,2 @@\n+first\n+second\n', additions: 2, deletions: 0 };
const removed = { filename: 'removed.js', status: 'removed', patch: '@@ -1 +0,0 @@\n-deleted', additions: 0, deletions: 1 };
const identity = {
  repository: 'corp-example/project', prNumber: 510, head: 'a'.repeat(40), base: 'b'.repeat(40), baseRef: 'main',
  runId: '12345678', runAttempt: '2', invocation: 'initial',
};
const input = { ...identity, review, files: [modified, added, removed], changedFileCount: 3 };
const proof = {
  version: 1,
  runId: identity.runId,
  runAttempt: identity.runAttempt,
  invocation: identity.invocation,
  pr: {
    provider: 'github', repo: identity.repository, number: identity.prNumber, head: identity.head,
    base: identity.base, baseRef: identity.baseRef,
  },
  review: structuredClone(review),
  files: [
    { path: removed.filename, left: digest('1\tdeleted\n'), right: digest('') },
    { path: modified.filename, left: digest('2\tbefore \t\r\n10\told end\n'), right: digest('2\t之后 \t\r\n10\t\n') },
    { path: added.filename, left: digest(''), right: digest('1\tfirst\n2\tsecond\n') },
  ],
};

test('full and incremental coverage cannot substitute for each other', () => {
  const previousHead = 'c'.repeat(40);
  for (const extra of [{ previousHead }, { mode: 'incremental' }]) {
    assert.equal(verifyReviewCoverage({ ...proof, ...extra }, input), false);
  }
  const delta = { ...proof, version: 2, mode: 'incremental', previousHead };
  assert.equal(verifyReviewCoverage(delta, { ...input, previousHead }), true);
  assert.equal(verifyReviewCoverage(delta, input), false);
  assert.equal(verifyReviewCoverage(delta, { ...input, previousHead: 'e'.repeat(40) }), false);
  assert.equal(verifyReviewCoverage(proof, { ...input, previousHead }), false);
});

const leftPath = String.raw`"a/src/\346\226\260 \346\226\207\344\273\266.js"`;
const rightPath = String.raw`"b/src/\346\226\260 \346\226\207\344\273\266.js"`;
const modifiedDiff = [
  `diff --git ${leftPath} ${rightPath}`, 'index e652251..1843a8d 100644',
  '--- ' + leftPath, '+++ ' + rightPath, modified.patch, '',
].join('\n');
const addedDiff = [
  'diff --git a/added.js b/added.js', 'new file mode 100644', 'index 0000000..1843a8d',
  '--- /dev/null', '+++ b/added.js', added.patch,
].join('\n');
const removedDiff = [
  'diff --git a/removed.js b/removed.js', 'deleted file mode 100644', 'index e652251..0000000',
  '--- a/removed.js', '+++ /dev/null', removed.patch, '',
].join('\n');

test('matches raw Git sections for unchanged regular modes and default-mode additions or removals', () => {
  assert.equal(verifyReviewFileModes(removedDiff + addedDiff + modifiedDiff, input.files), true);
  assert.equal(verifyReviewFileModes(modifiedDiff.replace('100644', '100755'), [modified]), true);
});

test('allows GitHub to shorten hunk context labels while matching their coordinates and rows', () => {
  const diff = modifiedDiff.replace('@@ function f()', '@@ function');
  assert.equal(verifyReviewFileModes(diff, [modified]), true);
  assert.equal(verifyReviewFileModes(diff.replace('@@ -10 +10 @@', '@@ -11 +11 @@'), [modified]), false);
});

test('accepts different GitHub hunk grouping only when the exact changed rows match', () => {
  const file = { ...modified, patch: '@@ -1,4 +1,4 @@\n-old\n+new\n context\n context\n-before\n+after' };
  const header = modifiedDiff.split('\n').slice(0, 4).join('\n');
  const diff = `${header}\n@@ -1 +1 @@\n-old\n+new\n@@ -4 +4 @@\n-before\n+after\n`;
  assert.equal(verifyReviewFileModes(diff, [file]), true);
  assert.equal(verifyReviewFileModes(diff.replace('@@ -4 +4 @@', '@@ -5 +5 @@'), [file]), false);
  assert.equal(verifyReviewFileModes(diff.replace('+after', '+different'), [file]), false);
  assert.equal(verifyReviewFileModes(diff.slice(0, diff.lastIndexOf('@@ -4')), [file]), false);
});

test('requires a complete and corresponding raw Git section with explicit regular-file mode evidence', () => {
  const diff = modifiedDiff + addedDiff + removedDiff;
  for (const raw of [
    undefined, '', 'preamble\n' + diff, modifiedDiff + addedDiff, modifiedDiff + modifiedDiff + removedDiff,
    diff.slice(0, -1), diff.replace('+first', '+wrong'), diff.replace('+++ b/added.js', '+++ b/wrong.js'),
    diff.replace('index e652251..1843a8d 100644', 'old mode 100644\nnew mode 100755\nindex e652251..1843a8d'),
    diff.replace('index e652251..1843a8d 100644', 'index e652251..1843a8d'),
    diff.replace('index e652251..1843a8d 100644', 'index e652251..1843a8d 120000'),
    diff.replace('new file mode 100644', 'new file mode 100755'),
    diff.replace('deleted file mode 100644', 'deleted file mode 100755'),
    diff.replace('index 0000000..1843a8d', 'index e652251..1843a8d'),
  ]) {
    assert.equal(verifyReviewFileModes(raw, input.files), false, raw);
  }
});

function verifiesPatch(patch, additions, deletions, left, right) {
  const files = [{ ...modified, patch, additions, deletions }];
  const manifest = [{ path: modified.filename, left: digest(left), right: digest(right) }];
  return verifyReviewCoverage({ ...proof, files: manifest }, { ...input, files, changedFileCount: files.length });
}

test('matches full changed rows and both empty sides by current API path in either invocation', () => {
  assert.equal(verifyReviewCoverage(proof, input), true);
  assert.equal(verifyReviewCoverage({ ...proof, invocation: 'retry' }, { ...input, invocation: 'retry' }), true);
  assert.equal(verifiesPatch('@@ -1,0 +2 @@\n+inserted\n@@ -4 +4,0 @@\n-deleted', 1, 1,
    '4\tdeleted\n', '2\tinserted\n'), true);
});

test('rejects a standalone no-final-newline marker while retaining the comment anchor', () => {
  const text = '\\ No newline at end of file';
  const patch = `@@ -1 +1 @@\n-value\n+value\n${text}`;
  assert.equal(verifiesPatch(patch, 1, 1, '1\tvalue\n', '1\tvalue\n'), false);
  assert.equal(verifiesPatch(`@@ -1 +1 @@\n-value\n+${text}`, 1, 1, '1\tvalue\n', `1\t${text}\n`), true);
  const issues = [{ issue_header: '[P1] [RIGHT] Inspect EOF', issue_content: 'Inspect the ending.',
    relevant_file: modified.filename, start_line: 1, end_line: 1 }];
  const comments = buildReviewComments({ issues, files: [{ ...modified, patch }], head: identity.head });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].line, 1);
});

test('rejects content-matching proof for a rename when the previous path is outside the manifest', () => {
  const file = { ...modified, status: 'renamed', previous_filename: 'src/旧文件.js' };
  assert.equal(verifyReviewCoverage(proof, { ...input, files: [file, added, removed] }), false);
});

test('rejects a mismatched run, invocation, PR revision, or native review result', () => {
  for (const [key, value] of Object.entries({ version: 2, runId: '12345679', runAttempt: '3', invocation: 'retry' })) {
    assert.equal(verifyReviewCoverage({ ...proof, [key]: value }, input), false, key);
  }
  for (const [key, value] of Object.entries({ provider: 'gitlab', repo: 'corp-example/other', number: '510',
    head: 'c'.repeat(40), base: 'c'.repeat(40), baseRef: 'develop' })) {
    assert.equal(verifyReviewCoverage({ ...proof, pr: { ...proof.pr, [key]: value } }, input), false, key);
  }
  assert.equal(verifyReviewCoverage({ ...proof, review: { ...review, security_concerns: 'Yes' } }, input), false);
  assert.equal(verifyReviewCoverage({ ...proof, review: {} }, { ...input, review: {} }), false);
  assert.equal(verifyReviewCoverage({ ...proof, runId: '' }, { ...input, runId: '' }), false);
  assert.equal(verifyReviewCoverage(null, input), false);
});

test('rejects missing, extra, duplicate, unrecognized, and malformed manifest entries', () => {
  const [first, second, third] = proof.files;
  for (const files of [[], [first, second], [first, second, third, first], [first, first, third],
    [first, { ...second, path: 'src/旧文件.js' }, third], [first, null, third],
    [first, { ...second, left: second.left.toUpperCase() }, third],
    [first, { ...second, right: digest('2\t之后 \t\n10\t\n') }, third],
    [first, { ...second, right: digest('3\t之后 \t\r\n10\t\n') }, third]]) {
    assert.equal(verifyReviewCoverage({ ...proof, files }, input), false);
  }
});

test('rejects unavailable patches, incomplete API pagination, duplicate API paths, and count mismatches', () => {
  assert.equal(verifyReviewCoverage(proof, { ...input, changedFileCount: 4 }), false);
  assert.equal(verifyReviewCoverage(proof, { ...input, files: [modified, modified, removed] }), false);
  for (const changes of [{ patch: null }, { patch: 'Binary files differ' }, { additions: 3 }, { deletions: '2' },
    { patch: modified.patch.replace(' tail', 'unexpected row') }, { patch: modified.patch.replace(' tail\n', '\n') }]) {
    assert.equal(verifyReviewCoverage(proof, { ...input, files: [{ ...modified, ...changes }, added, removed] }), false);
  }
});

test('rejects invalid or overlapping hunks even when changed rows and total counts match', () => {
  const exactFirstHunk = '@@ -1,2 +1,2 @@\n-old\n+new\n context';
  for (const patch of [
    `header noise\n${exactFirstHunk}`,
    `${exactFirstHunk}\n@@ -5,2 +5,2 @@\n context with truncated tail`,
    `@@ -1,2 +1,2 @@\n\\ No newline at end of file\n-old\n+new\n context`,
    `@@ -1,2 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n context`,
    `${exactFirstHunk}\n@@ -5 +5 @@\n context with no changes`,
  ]) assert.equal(verifiesPatch(patch, 1, 1, '1\told\n', '1\tnew\n'), false, patch);

  assert.equal(verifiesPatch(`${exactFirstHunk}\n@@ -2 +2 @@\n-second old\n+second new`, 2, 2,
    '1\told\n2\tsecond old\n', '1\tnew\n2\tsecond new\n'), false);
  assert.equal(verifiesPatch(`${exactFirstHunk}\n${exactFirstHunk}`, 2, 2,
    '1\told\n1\told\n', '1\tnew\n1\tnew\n'), false);
});

test('keeps comment anchors from a complete hunk before a truncated hunk', () => {
  const file = { ...modified, patch: '@@ -1 +1 @@\n-old\n+new\n@@ -4,2 +4,2 @@\n incomplete' };
  const issues = [{ issue_header: '[P1] [RIGHT] Inspect change', issue_content: 'Inspect this line.',
    relevant_file: file.filename, start_line: 1, end_line: 1 }];
  const comments = buildReviewComments({ issues, files: [file], head: identity.head });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].line, 1);
});
