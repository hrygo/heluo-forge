import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewComments, getReviewCommentMarker } from '../scripts/pr-agent-review-comments.mjs';

const head = 'a'.repeat(40);
const modified = {
  filename: 'src/modified.js',
  status: 'modified',
  patch: '@@ -10,4 +10,4 @@ function check()\n context before\n-old behavior\n+new behavior\n context after\n final context',
};

function finding(header, overrides = {}) {
  return {
    issue_header: header,
    issue_content: 'The input changes the behavior of the check.',
    relevant_file: modified.filename,
    start_line: 11,
    end_line: 11,
    ...overrides,
  };
}

function locations(comments) {
  return comments.map(({ path, line, side }) => ({ path, line, side }));
}

test('anchors explicitly sided findings to different diff sides at the same line number', () => {
  const issues = [finding('[P1] [LEFT] Keep the previous behavior'), finding('[P2] [RIGHT] Check the new behavior')];

  assert.deepEqual(locations(buildReviewComments({ issues, files: [modified], head })), [
    { path: modified.filename, line: 11, side: 'LEFT' },
    { path: modified.filename, line: 11, side: 'RIGHT' },
  ]);
});

test('anchors a deletion in an ordinary modified file with no added lines', () => {
  const file = { ...modified, patch: '@@ -10,2 +10 @@\n context\n-deleted guard\n\\ No newline at end of file\n' };
  const issues = [finding('[P0] [LEFT] Keep the guard'), finding('[P0] [RIGHT] Wrong side')];

  assert.deepEqual(locations(buildReviewComments({ issues, files: [file], head })), [
    { path: modified.filename, line: 11, side: 'LEFT' },
  ]);
});

test('does not guess a side for an untagged modified-file finding even with only one changed side', () => {
  const deletionOnly = { ...modified, patch: '@@ -10,2 +10 @@\n context\n-deleted guard' };
  const issues = [finding('[P1] The side is missing')];

  for (const file of [modified, deletionOnly]) {
    assert.deepEqual(buildReviewComments({ issues, files: [file], head }), []);
  }
});

test('requires the same-side range to be present in one hunk and picks its first changed row', () => {
  const file = {
    ...modified,
    patch: '@@ -10,5 +10,5 @@\n context\n-old one\n+new one\n same\n-old two\n+new two\n tail\n@@ -17 +17 @@\n-before\n+after',
  };
  const issues = [
    finding('[P2] [RIGHT] Range includes context', { start_line: 10, end_line: 14 }),
    finding('[P2] [RIGHT] Context only', { start_line: 14, end_line: 14 }),
    finding('[P2] [RIGHT] Cross-hunk range', { end_line: 17 }),
    finding('[P2] [LEFT] Starts outside the hunk', { start_line: 9 }),
  ];

  assert.deepEqual(locations(buildReviewComments({ issues, files: [file], head })), [
    { path: modified.filename, line: 11, side: 'RIGHT' },
  ]);
});

test('counts only same-side rows and accepts long changed lines and blank additions', () => {
  const file = {
    ...modified,
    patch: `@@ -10,4 +10,3 @@\n context\n-one\n-two\n+${'x'.repeat(16_000)}\n\\ No newline at end of file\n-previous tail\n+`,
  };
  const issues = [
    finding('[P3] [RIGHT] Long line'),
    finding('[P3] [RIGHT] Blank line', { start_line: 12, end_line: 12 }),
    finding('[P3] [RIGHT] Old-side endpoint', { end_line: 13 }),
  ];

  assert.deepEqual(locations(buildReviewComments({ issues, files: [file], head })), [
    { path: modified.filename, line: 11, side: 'RIGHT' },
    { path: modified.filename, line: 12, side: 'RIGHT' },
  ]);
});

test('infers sides only for added, removed and previous rename paths', () => {
  const added = { filename: 'src/added.js', status: 'added', patch: '@@ -0,0 +1 @@\n+created' };
  const removed = { filename: 'src/removed.js', status: 'removed', patch: '@@ -1 +0,0 @@\n-deleted' };
  const renamed = { ...modified, filename: 'src/current.js', status: 'renamed', previous_filename: 'src/old.js' };
  const issues = [
    finding('[P3] Added file', { relevant_file: added.filename, start_line: 1, end_line: 1 }),
    finding('[P3] Removed file', { relevant_file: removed.filename, start_line: 1, end_line: 1 }),
    finding('[P1] Previous name', { relevant_file: renamed.previous_filename }),
    finding('[P2] Current name without side', { relevant_file: renamed.filename }),
    finding('[P2] [LEFT] Old line with current name', { relevant_file: renamed.filename }),
    finding('[P2] [RIGHT] New line with current name', { relevant_file: renamed.filename }),
    finding('[P2] [RIGHT] New line with previous name', { relevant_file: renamed.previous_filename }),
    finding('[P2] [LEFT] Added with wrong side', { relevant_file: added.filename, start_line: 1, end_line: 1 }),
    finding('[P2] [RIGHT] Removed with wrong side', { relevant_file: removed.filename, start_line: 1, end_line: 1 }),
  ];

  assert.deepEqual(locations(buildReviewComments({ issues, files: [added, removed, renamed], head })), [
    { path: added.filename, line: 1, side: 'RIGHT' },
    { path: removed.filename, line: 1, side: 'LEFT' },
    { path: renamed.filename, line: 11, side: 'LEFT' },
    { path: renamed.filename, line: 11, side: 'LEFT' },
    { path: renamed.filename, line: 11, side: 'RIGHT' },
  ]);
});

test('leaves reused rename paths without an explicit side in the summary', () => {
  const renamed = { ...modified, filename: 'src/current.js', status: 'renamed', previous_filename: 'src/old.js' };
  const added = {
    filename: 'src/old.js',
    status: 'added',
    patch: `@@ -0,0 +1,11 @@\n${Array(11).fill('+new').join('\n')}`,
  };
  const issues = [
    finding('[P2] Ambiguous reused name', { relevant_file: added.filename }),
    finding('[P2] [RIGHT] Explicit new file', { relevant_file: added.filename }),
    finding('[P2] [LEFT] Explicit previous name', { relevant_file: added.filename }),
  ];

  assert.deepEqual(locations(buildReviewComments({ issues, files: [added, renamed], head })), [
    { path: added.filename, line: 11, side: 'RIGHT' },
    { path: renamed.filename, line: 11, side: 'LEFT' },
  ]);
});

test('rejects unusable patches and malformed locations', () => {
  const issue = finding('[P1] [RIGHT] Check the new behavior');
  for (const patch of [undefined, 'Binary files differ', '@@ -10,4 +10,4 @@\n context\n-old\n+new']) {
    assert.deepEqual(buildReviewComments({ issues: [issue], files: [{ ...modified, patch }], head }), []);
  }

  const issues = [
    null,
    { ...issue, relevant_file: 'src/unmodified.js' },
    { ...issue, start_line: 0 },
    { ...issue, start_line: '11' },
    { ...issue, end_line: 10 },
    { ...issue, issue_header: '[P1] [LEFT] [RIGHT] Conflicting sides' },
    { ...issue, issue_header: '[P1] [RIGHT]' },
    { ...issue, issue_content: ' ' },
  ];
  assert.deepEqual(buildReviewComments({ issues, files: [modified], head }), []);
});

test('deduplicates exact comment markers and includes revision, location, heading and content', () => {
  const issue = finding('[P1] [RIGHT] Check the new behavior');
  const options = { issues: [issue, { ...issue }], files: [modified], head };
  const comments = buildReviewComments(options);
  assert.equal(comments.length, 1);
  const [{ body }] = comments;
  const marker = getReviewCommentMarker(body);
  assert.match(marker, /^<!-- heluo-forge-pr-agent-comment:v1 [a-f0-9]{64} -->$/u);
  assert.match(body, /\[P1\] Check the new behavior\*\*\n\nThe input changes the behavior of the check\./u);
  assert.equal(getReviewCommentMarker(`${body}\n`), marker);
  assert.equal(getReviewCommentMarker(`${body}\nnot an end marker`), undefined);
  assert.equal(getReviewCommentMarker(`same line ${marker}`), undefined);
  assert.deepEqual(buildReviewComments(options), comments);

  const moved = { ...modified, filename: 'src/moved.js' };
  for (const variation of [
    { head: 'b'.repeat(40) },
    { issues: [{ ...issue, issue_header: '[P1] [LEFT] Check the new behavior' }] },
    { issues: [{ ...issue, issue_header: '[P1] [RIGHT] Different heading' }] },
    { issues: [{ ...issue, issue_content: 'Different content' }] },
    { issues: [{ ...issue, relevant_file: moved.filename }], files: [moved] },
    {
      issues: [{ ...issue, start_line: 21, end_line: 21 }],
      files: [{ ...modified, patch: modified.patch.replace('-10,4 +10,4', '-20,4 +20,4') }],
    },
  ]) {
    const [comment] = buildReviewComments({ ...options, ...variation });
    assert.notEqual(getReviewCommentMarker(comment.body), marker);
  }
});
