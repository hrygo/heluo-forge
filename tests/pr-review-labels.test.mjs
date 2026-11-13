import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desiredLabel, reconcile, syncAll } from '../scripts/pr-review-labels.mjs';

const labels = ['review: awaiting review', 'review: changes requested', 'review: awaiting re-review', 'review: approved'];

test('maps GitHub aggregate decisions and removes review labels from drafts and closed PRs', () => {
  for (const [decision, expected] of [[null, labels[0]], ['REVIEW_REQUIRED', labels[0]], ['CHANGES_REQUESTED', labels[1]], ['APPROVED', labels[3]]]) {
    assert.equal(desiredLabel({ state: 'OPEN', isDraft: false, reviewDecision: decision }), expected);
  }
  assert.equal(desiredLabel({ state: 'OPEN', isDraft: true, reviewDecision: 'APPROVED' }), null);
  assert.equal(desiredLabel({ state: 'CLOSED', isDraft: false, reviewDecision: 'APPROVED' }), null);
  assert.throws(() => desiredLabel({ state: 'OPEN', isDraft: false, reviewDecision: 'UNKNOWN' }));
});

test('reconciles only owned labels and preserves unrelated labels', async () => {
  const changes = [];
  const api = { add: async (number, label) => changes.push(['add', number, label]), remove: async (number, label) => changes.push(['remove', number, label]) };
  await reconcile(api, { number: 7, state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', labels: [{ name: 'iam' }, { name: labels[0] }, { name: labels[2] }] });
  assert.deepEqual(changes, [['remove', 7, labels[0]], ['remove', 7, labels[2]], ['add', 7, labels[1]]]);
  changes.length = 0;
  await reconcile(api, { number: 7, state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', labels: [{ name: labels[3] }] });
  assert.deepEqual(changes, []);
});

test('visits all pages, rejects partial data and propagates failures', async () => {
  const visited = [];
  const api = { list: async cursor => cursor === null ? { prs: [1], next: 'page2' } : { prs: [2], next: null }, read: async n => ({ number: n, state: 'OPEN', isDraft: false, reviewDecision: null, labels: visited.includes(n) ? [{ name: labels[0] }] : [] }), add: async n => visited.push(n), remove: async () => {} };
  await syncAll(api);
  assert.deepEqual(visited, [1, 2]);
  await assert.rejects(syncAll({ ...api, read: async () => { throw Error('read failed'); } }), /2 PR/);
  await assert.rejects(syncAll({ ...api, list: async () => ({ prs: [], next: '' }) }), /cursor/);
});

test('GitHub API uses GraphQL data, rejects incomplete labels and propagates HTTP errors', async () => {
  const { githubApi } = await import('../scripts/pr-review-labels.mjs');
  const calls = [];
  const replies = [
    { data: { repository: { pullRequests: { nodes: [{ number: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } } } },
    { data: { repository: { pullRequest: { number: 9, state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', labels: { nodes: [], pageInfo: { hasNextPage: true } } } } } },
  ];
  const api = githubApi({ token: 'test', repository: 'example/repo', fetchImpl: async (url, options) => { calls.push([url, options]); return { ok: true, status: 200, json: async () => replies.shift() }; } });
  assert.deepEqual(await api.list(null), { prs: [9], next: null });
  await assert.rejects(api.read(9), /incomplete/);
  assert.match(calls[0][0], /\/graphql$/);
  const failing = githubApi({ token: 'test', repository: 'example/repo', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(failing.add(9, labels[0]), /HTTP 403/);
  const missingCursor = githubApi({ token: 'test', repository: 'example/repo', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }) }) });
  await assert.rejects(missingCursor.list(null), /cursor/);
});

test('workflow runs trusted main only, serializes runs and grants minimal write scope', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/pr-review-labels.yml', import.meta.url), 'utf8');
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /pull_request_target|pull_request_review:|issues: write|secrets\./);
  assert.match(workflow, /persist-credentials: false/);
});

test('continues to later PRs after one API error and reports failure', async () => {
  const updated = [];
  const api = { list: async () => ({ prs: [1, 2], next: null }), read: async n => { if (n === 1) throw Error('unavailable'); return { number: n, state: 'OPEN', isDraft: false, reviewDecision: null, labels: updated.includes(n) ? [{ name: labels[0] }] : [] }; }, add: async n => updated.push(n), remove: async () => {} };
  await assert.rejects(syncAll(api), /1 PR/);
  assert.deepEqual(updated, [2]);
});

test('rechecks state after changes and corrects a concurrent review', async () => {
  const changed = [];
  let count = 0;
  const api = { list: async () => ({ prs: [7], next: null }), read: async () => {
    count++;
    if (count === 1) return { number: 7, state: 'OPEN', isDraft: false, reviewDecision: null, labels: [] };
    if (count === 2) return { number: 7, state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', labels: [{ name: labels[0] }] };
    return { number: 7, state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', labels: [{ name: labels[1] }] };
  }, add: async (_, label) => changed.push(['add', label]), remove: async (_, label) => changed.push(['remove', label]) };
  await syncAll(api);
  assert.deepEqual(changed, [['add', labels[0]], ['remove', labels[0]], ['add', labels[1]]]);
});
