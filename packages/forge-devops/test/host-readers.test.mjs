import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhReader, createHostReader, HostReaderError, parseGhTarget } from '../src/host-readers.mjs';

const HOST = 'gitee.corp.example';
const REPO = `${HOST}/demo/repo`;

const repoRaw = {
  nameWithOwner: 'demo/repo', url: `https://${REPO}`, isPrivate: true,
  defaultBranchRef: { name: 'main' },
};
const issueRaw = {
  number: 2, title: '[ARD123456] t', body: 'text', state: 'CLOSED',
  url: `https://${REPO}/issues/2`,
  closedByPullRequestsReferences: [{ number: 3, url: `https://${REPO}/pull/3` }],
};
const prRaw = {
  number: 3, title: 't', state: 'MERGED', url: `https://${REPO}/pull/3`,
  headRefOid: 'a'.repeat(40), baseRefName: 'main', mergedAt: '2026-06-20T00:00:00Z',
};

const runnerFor = (raw, seen = []) => async (options) => {
  seen.push(options);
  return structuredClone(raw);
};

test('parseGhTarget accepts only explicit hosted shapes', () => {
  assert.deepEqual(parseGhTarget('repository.read', REPO, HOST), { kind: 'repo', repo: REPO });
  assert.deepEqual(parseGhTarget('issue.read', `${REPO}#2`, HOST), { kind: 'issue', repo: REPO, number: 2 });
  assert.deepEqual(parseGhTarget('pr.read', `${REPO}#3`, HOST), { kind: 'pr', repo: REPO, number: 3 });
  for (const [action, target, host] of [
    ['repository.read', 'demo/repo', HOST], ['repository.read', `${REPO}#2`, HOST],
    ['issue.read', REPO, HOST], ['pr.read', REPO, HOST],
    ['repository.read', 'github.com/demo/repo', HOST], ['issue.read', 'github.com/demo/repo#2', HOST],
    ['issue.read', `${REPO}#0`, HOST], ['unknown.read', REPO, HOST],
    ['repository.read', REPO, ''], ['repository.read', REPO, 'a/b'],
  ]) {
    assert.throws(() => parseGhTarget(action, target, host), HostReaderError);
  }
});

test('gh reader runs only the fixed --json shape and keeps unknown status with facts', async () => {
  const seen = [];
  const reader = createGhReader({ executable: '/bin/gh', allowedHost: HOST, runner: runnerFor(repoRaw, seen) });
  const result = await reader.read({ action: 'repository.read', target: REPO });
  assert.equal(result.status, 'unknown');
  assert.equal(result.source_revision, null);
  assert.equal(result.error_code, 'MISSING_SOURCE_REVISION');
  assert.equal(result.facts.url, `https://${REPO}`);
  assert.deepEqual(seen[0].args, ['repo', 'view', REPO, '--json', 'nameWithOwner,url,isPrivate,defaultBranchRef']);
});

test('issue reader validates same-repo closing refs and refuses cross-repo refs', async () => {
  const reader = createGhReader({ executable: '/bin/gh', allowedHost: HOST, runner: runnerFor(issueRaw) });
  const result = await reader.read({ action: 'issue.read', target: `${REPO}#2` });
  assert.deepEqual(result.facts.closingPullRequests, [{ number: 3, url: `https://${REPO}/pull/3` }]);
  const cross = createGhReader({
    executable: '/bin/gh', allowedHost: HOST,
    runner: runnerFor({ ...issueRaw, closedByPullRequestsReferences: [{ number: 3, url: 'https://github.com/other/repo/pull/3' }] }),
  });
  await assert.rejects(cross.read({ action: 'issue.read', target: `${REPO}#2` }), { name: 'HostReaderError' });
});

test('pr reader requires a real revision and reports fixture provenance when present', async () => {
  const seen = [];
  const reader = createGhReader({
    executable: '/bin/gh', allowedHost: HOST,
    runner: runnerFor({ ...prRaw, _heluo_fixture: { kind: 'fixture', synthetic: true, network: false } }, seen),
  });
  const result = await reader.read({ action: 'pr.read', target: `${REPO}#3` });
  assert.equal(result.facts.headRefOid, 'a'.repeat(40));
  assert.deepEqual(result.facts.provenance, { kind: 'fixture', synthetic: true, network: false });
  const badRevision = createGhReader({
    executable: '/bin/gh', allowedHost: HOST, runner: runnerFor({ ...prRaw, headRefOid: 'short' }),
  });
  await assert.rejects(badRevision.read({ action: 'pr.read', target: `${REPO}#3` }), { name: 'HostReaderError' });
  const foreign = createGhReader({
    executable: '/bin/gh', allowedHost: HOST,
    runner: runnerFor({ ...prRaw, _heluo_fixture: { kind: 'real' } }),
  });
  await assert.rejects(foreign.read({ action: 'pr.read', target: `${REPO}#3` }), { name: 'HostReaderError' });
});

test('runner failures surface as safe reader codes without raw output', async () => {
  const reader = createGhReader({
    executable: '/bin/gh', allowedHost: HOST,
    runner: async () => { const error = new Error('x'); error.code = 'AUTH_FAILED'; throw error; },
  });
  await assert.rejects(reader.read({ action: 'repository.read', target: REPO }), { name: 'HostReaderError', code: 'AUTH_FAILED' });
  const untrusted = createGhReader({
    executable: '/bin/gh', allowedHost: HOST,
    runner: async () => { const error = new Error('untrusted'); error.code = 'CANARY_CUSTOM_CODE'; throw error; },
  });
  await assert.rejects(untrusted.read({ action: 'repository.read', target: REPO }), { name: 'HostReaderError', code: 'CLI_FAILED' });
});

test('host reader routes change.read to DOP and repo reads to gh', async () => {
  const calls = [];
  const reader = createHostReader({
    dopReader: { read: async ({ action, target }) => (calls.push([action, target]), { action, target }) },
    ghReader: { read: async ({ action, target }) => (calls.push([action, target]), { action, target }) },
  });
  assert.equal((await reader.read({ action: 'change.read', target: 'ARD123456' })).action, 'change.read');
  assert.equal((await reader.read({ action: 'issue.read', target: `${REPO}#2` })).action, 'issue.read');
  await assert.rejects(reader.read({ action: 'issue.create_or_update', target: `${REPO}#2` }), { name: 'HostReaderError' });
  assert.deepEqual(calls, [['change.read', 'ARD123456'], ['issue.read', `${REPO}#2`]]);
});
