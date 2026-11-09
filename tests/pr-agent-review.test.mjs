import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const workflow = await readFile(new URL('../.github/workflows/pr-agent.yml', import.meta.url), 'utf8');
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

function stepScript(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  const script = /\n          node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE(?:\n|$)/u.exec(step ?? '')?.[1];
  assert.ok(script, `missing executable Node script for ${name}`);
  return script.replace(/^ {10}/gmu, '');
}

async function withGitHub(run) {
  const state = {
    pr: { state: 'open', head: { sha: head, repo: { full_name: 'corp/example' } }, base: { sha: base } },
    requests: [],
    postStatus: 200,
    headAfterPost: undefined,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    state.requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify(state.pr));
    } else {
      response.statusCode = state.postStatus;
      response.end(JSON.stringify({ state: 'CHANGES_REQUESTED', commit_id: head }));
      if (state.headAfterPost) state.pr.head.sha = state.headAfterPost;
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'pr-agent-review-'));
  const env = {
    ...process.env,
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    GITHUB_REPOSITORY: 'corp/example',
    GITHUB_OUTPUT: join(directory, 'output'),
    GH_TOKEN: 'test-token',
    PR_NUMBER: '42',
    EVENT_NAME: 'pull_request',
    EVENT_ACTION: 'opened',
    PR_TITLE: 'Example pull request',
  };
  try {
    await run({ state, env });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function execute(name, env) {
  return runFile(process.execPath, ['--input-type=module', '--eval', stepScript(name)], { env });
}

async function capture(env) {
  await execute('Capture PR revision', env);
  const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
  return Object.fromEntries(output.trim().split('\n').map((line) => line.split('=')));
}

async function submit(env, revision, review) {
  return execute('Submit requested changes', {
    ...env,
    REVIEW_RESULT: review,
    REVIEWED_HEAD: revision.head,
    REVIEWED_BASE: revision.base,
  });
}

test('a blocking recommendation requests changes on the reviewed commit', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    assert.deepEqual(revision, { head, base });
    await submit(env, revision, JSON.stringify({
      merge_recommendation: 'changes_required\n',
      key_issues_to_review: [{ relevant_file: 'src/example.js', start_line: 12, issue_header: 'Bug', issue_content: 'The result is wrong. @someone' }],
    }));
    const post = state.requests.find((request) => request.method === 'POST');
    assert.equal(post?.url, '/repos/corp/example/pulls/42/reviews');
    assert.equal(post.body.event, 'REQUEST_CHANGES');
    assert.equal(post.body.commit_id, head);
    assert.match(post.body.body, /PR-Agent/u);
    assert.match(post.body.body, /src\/example\.js/u);
    assert.match(post.body.body, /The result is wrong\./u);
    assert.doesNotMatch(post.body.body, /@someone/u);
    assert.match(post.body.body, /\/review/u);
  });
});

for (const recommendation of ['no_concerns_found', 'needs_review']) {
  test(`${recommendation} does not request changes`, async () => {
    await withGitHub(async ({ state, env }) => {
      const revision = await capture(env);
      await submit(env, revision, JSON.stringify({ merge_recommendation: recommendation }));
      assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
    });
  });
}

test('malformed or unknown recommendations fail without changing the review', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    for (const result of ['{', '{}', '{"merge_recommendation":"unknown"}']) {
      await assert.rejects(submit(env, revision, result));
    }
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('missing output fails only when a review was expected', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    await assert.rejects(submit(env, revision, ''));
    await assert.rejects(submit({ ...env, EVENT_NAME: 'issue_comment', COMMENT_BODY: '  /review --some-option' }, revision, ''));
    const incremental = await submit({ ...env, EVENT_NAME: 'issue_comment', COMMENT_BODY: '/review -i' }, revision, '');
    assert.match(incremental.stdout, /warning.*Incremental review.*output/iu);
    await submit({ ...env, EVENT_NAME: 'issue_comment', COMMENT_BODY: '/ask a question' }, revision, '');
    await submit({ ...env, PR_TITLE: '[Auto] ignored' }, revision, '');
    await submit({ ...env, EVENT_ACTION: 'review_requested', PR_CREATED_AT: 'same', PR_UPDATED_AT: 'same' }, revision, '');
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('initial duplicate requests and unrelated comments cannot cancel an active review', () => {
  assert.doesNotMatch(workflow, /^concurrency:/mu);
  const concurrency = /\n    concurrency:\n([\s\S]*?)(?=\n    [a-z-]+:)/u.exec(workflow)?.[1] ?? '';
  assert.match(concurrency, /created_at == github\.event\.pull_request\.updated_at && 'initial-request'/u);
  assert.match(concurrency, /!contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.comment\.author_association\)/u);
  assert.match(concurrency, /github\.event\.sender\.type == 'Bot'/u);
  assert.match(concurrency, /!startsWith\(github\.event\.comment\.body, '\/review'\)\) && 'other-comment'/u);
  assert.match(concurrency, /cancel-in-progress: true/u);
});

test('the workflow runs result handling even when the action produced no output', () => {
  const step = workflow.split('      - name: Submit requested changes\n')[1]?.split('\n      - name: ')[0] ?? '';
  assert.doesNotMatch(step, /^        if:/mu);
  assert.match(step, /REVIEW_RESULT: \$\{\{ steps\.pr_agent\.outputs\.review \}\}/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__ENABLE_OUTPUT: "true"/u);
});

test('a changed head or base prevents a stale request for changes', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.pr.head.sha = 'c'.repeat(40);
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"changes_required"}'));
    state.pr.head.sha = head;
    state.pr.base.sha = 'd'.repeat(40);
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"changes_required"}'));
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('a fork pull request never receives a request for changes', async () => {
  await withGitHub(async ({ state, env }) => {
    state.pr.head.repo.full_name = 'outside/fork';
    const revision = await capture(env);
    await submit(env, revision, '{"merge_recommendation":"changes_required"}');
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('a revision change during submission is reported even though the old review was posted', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.headAfterPost = 'c'.repeat(40);
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"changes_required"}'));
    const post = state.requests.find((request) => request.method === 'POST');
    assert.equal(post?.body.commit_id, head);
  });
});

test('a rejected review submission fails the workflow step', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.postStatus = 403;
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"changes_required"}'));
  });
});
