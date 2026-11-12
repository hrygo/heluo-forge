import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIssueReference } from '../scripts/check-pr-issue.mjs';

const issue = async (number) => ({ ok: number === '12', isPullRequest: false });

test('accepts closing and partial references to an existing issue', async () => {
  for (const body of ['Closes #12', 'Part of #12', '- fixes: #12', 'PART OF #12']) {
    assert.equal(await validateIssueReference(body, issue), true, body);
  }
});

test('rejects missing, placeholder, commented, code and unrelated references', async () => {
  for (const body of ['', 'Closes #0', 'Closes #123', 'Related to #12', '<!-- Closes #12 -->', '```\nCloses #12\n```', '`Closes #12`', 'Part of #12 and more', 'Closes owner/repo#12', '    Closes #12', '```\nCloses #12', '~~~text\nCloses #12\n~~~~', '> Closes #12']) {
    assert.equal(await validateIssueReference(body, issue), false, body);
  }
  assert.equal(await validateIssueReference('Closes #12', async () => ({ ok: true, isPullRequest: true })), false);
  await assert.rejects(validateIssueReference('Closes #12', async () => { throw new Error('API unavailable'); }));
});

test('workflow rechecks edited descriptions in the existing required job', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened, edited\]/u);
  assert.match(workflow, /issues: read/u);
  assert.match(workflow, /pull-requests: read/u);
  assert.match(workflow, /merge_group:\n\s+types: \[checks_requested\]/u);
  assert.match(workflow, /verify:[\s\S]*?if: github\.event_name == 'pull_request'[\s\S]*?node scripts\/check-pr-issue\.mjs/u);
});

test('fetches current PR body with read-only API for fork and Dependabot events', async () => {
  const { checkPullRequest } = await import('../scripts/check-pr-issue.mjs');
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/pulls/42')) return { ok: true, json: async () => ({ body: 'Part of #12' }) };
    if (url.endsWith('/issues/12')) return { ok: true, json: async () => ({ number: 12 }) };
    throw new Error(`unexpected ${url}`);
  };
  for (const event of [{ number: 42, pull_request: { body: 'old body' } }, {}]) {
    assert.equal(await checkPullRequest({ event, ref: 'refs/pull/42/merge', repository: 'owner/repo', apiUrl: 'https://api.github.com', token: 'test', fetcher }), true);
  }
  assert.equal(calls.length, 4);
  await assert.rejects(checkPullRequest({ event: {}, ref: 'refs/heads/main', repository: 'owner/repo', apiUrl: 'https://api.github.com', token: 'test', fetcher }));
  await assert.rejects(checkPullRequest({ event: { number: 42 }, ref: 'refs/pull/43/merge', repository: 'owner/repo', apiUrl: 'https://api.github.com', token: 'test', fetcher }));
  await assert.rejects(checkPullRequest({ event: { number: 42 }, ref: 'refs/pull/42/merge', repository: 'owner/repo', apiUrl: 'https://api.github.com', token: 'test', fetcher: async () => ({ ok: false, status: 403 }) }));
});

test('trusted PR-target check validates the current body using the event number', async () => {
  const { checkPullRequest } = await import('../scripts/check-pr-issue.mjs');
  const calls = [];
  let body = 'Part of #12';
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/pulls/42')) return { ok: true, json: async () => ({ body }) };
    if (url.endsWith('/issues/12')) return { ok: true, json: async () => ({ number: 12 }) };
    throw new Error(`unexpected ${url}`);
  };
  const context = { eventName: 'pull_request_target', ref: 'refs/heads/main', repository: 'owner/repo', apiUrl: 'https://api.github.com', token: 'test', fetcher };
  for (const event of [{ number: 42, pull_request: { number: 42, body: 'stale body' } }, { number: 42 }, { pull_request: { number: 42 } }]) {
    assert.equal(await checkPullRequest({ ...context, event }), true);
  }
  assert.deepEqual(calls, Array(3).fill(['https://api.github.com/repos/owner/repo/pulls/42', 'https://api.github.com/repos/owner/repo/issues/12']).flat());
  body = 'No issue linked';
  assert.equal(await checkPullRequest({ ...context, event: { number: 42 } }), false);
  for (const [event, ref, eventName] of [
    [{}, 'refs/heads/main', 'pull_request_target'],
    [{ number: 42, pull_request: { number: 43 } }, 'refs/heads/main', 'pull_request_target'],
    [{ number: 0 }, 'refs/heads/main', 'pull_request_target'],
    [{ number: 42 }, 'refs/pull/42/merge', 'pull_request_target'],
    [{ number: 42 }, 'refs/heads/main', 'push'],
  ]) {
    await assert.rejects(checkPullRequest({ ...context, event, ref, eventName }), /context/u);
  }
});

test('required trusted workflow checks issue references using only base code', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/sensitive-attestation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request_target:\n\s+types: \[[^\]]*edited[^\]]*\]/u);
  assert.match(workflow, /issues: read/u);
  assert.match(workflow, /pull-requests: read/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}[\s\S]*node scripts\/check-pr-issue\.mjs/u);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.(?:sha|ref) \}\}/u);
  assert.equal((workflow.match(/uses: actions\/checkout@/gu) ?? []).length, 1);
  assert.match(workflow, /node scripts\/check-pr-issue\.mjs[\s\S]*node scripts\/sensitive-scan\/verify\.mjs/u);
});

test('trusted check rejects missing issues, PR numbers and API errors', async () => {
  const { checkPullRequest } = await import('../scripts/check-pr-issue.mjs');
  const context = { eventName: 'pull_request_target', event: { number: 42 }, ref: 'refs/heads/main', repository: 'owner/repo', apiUrl: 'https://api.github.com', token: 'test' };
  const check = (response) => checkPullRequest({ ...context, fetcher: async (url) => url.endsWith('/pulls/42')
    ? { ok: true, json: async () => ({ body: 'Closes #12' }) }
    : response });
  assert.equal(await check({ ok: false, status: 404 }), false);
  assert.equal(await check({ ok: true, json: async () => ({ pull_request: {} }) }), false);
  await assert.rejects(check({ ok: false, status: 403 }), /HTTP 403/u);
});

test('ignores list-fenced examples and respects comment and fence order', async () => {
  assert.equal(await validateIssueReference('- ```markdown\n  Closes #12\n  ```', issue), false);
  assert.equal(await validateIssueReference('1. ~~~html\n   <!-- unfinished\n   ~~~\n\nPart of #12', issue), true);
  assert.equal(await validateIssueReference('<!--\n```\n-->\nCloses #12', issue), true);
  assert.equal(await validateIssueReference('~~~ <!--\nexample\n~~~\nPart of #12', issue), true);
  assert.equal(await validateIssueReference('- ```\n  Closes #12\n  ```\nPart of #12', issue), true);
});

test('keeps over-indented closing fences inside their code block', async () => {
  assert.equal(await validateIssueReference('```markdown\n    ```\n```\n\nPart of #12', issue), true);
  assert.equal(await validateIssueReference('```markdown\n    ```\nCloses #12\n```', issue), false);
  assert.equal(await validateIssueReference('- ```markdown\n      ```\n  Closes #12\n  ```', issue), false);
  assert.equal(await validateIssueReference('- ```markdown\n     ```\nPart of #12', issue), true);
  assert.equal(await validateIssueReference('1. ~~~markdown\n      ~~~\nPart of #12', issue), true);
});

test('continues after a list code block ends when the next paragraph leaves the list', async () => {
  assert.equal(await validateIssueReference('- ```\n  example\n\nPart of #12', issue), true);
  assert.equal(await validateIssueReference('1. ~~~\n   example\n\nPart of #12', issue), true);
});
