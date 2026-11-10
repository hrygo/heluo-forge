import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    dismissStatus: 200,
    reviews: [],
    comments: [],
    runs: {},
    jobs: {},
    logs: {},
    headAfterPost: undefined,
    headAfterReviewList: undefined,
    headAfterCommentList: undefined,
    headAfterDismiss: undefined,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    state.requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined });
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const page = Number(url.searchParams.get('page') ?? '1');
    if (request.method === 'GET' && path === '/repos/corp/example/pulls/42') {
      response.end(JSON.stringify(state.pr));
    } else if (request.method === 'GET' && path === '/repos/corp/example/pulls/42/reviews') {
      response.end(JSON.stringify(state.reviews.slice((page - 1) * 100, page * 100)));
      if (state.headAfterReviewList) state.pr.head.sha = state.headAfterReviewList;
    } else if (request.method === 'GET' && path === '/repos/corp/example/issues/42/comments') {
      response.end(JSON.stringify(state.comments.slice((page - 1) * 100, page * 100)));
      if (state.headAfterCommentList) state.pr.head.sha = state.headAfterCommentList;
    } else if (request.method === 'GET' && /^\/repos\/corp\/example\/actions\/runs\/\d+\/jobs$/u.test(path)) {
      const runId = path.split('/').at(-2);
      const jobs = state.jobs[runId] ?? [];
      response.end(JSON.stringify({ total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) }));
    } else if (request.method === 'GET' && /^\/repos\/corp\/example\/actions\/jobs\/\d+\/logs$/u.test(path)) {
      const log = state.logs[path.split('/').at(-2)];
      response.statusCode = typeof log === 'string' ? 200 : 404;
      response.setHeader('content-type', 'text/plain');
      response.end(log ?? '');
    } else if (request.method === 'GET' && /^\/repos\/corp\/example\/actions\/runs\/\d+$/u.test(path)) {
      const run = state.runs[path.split('/').at(-1)];
      response.statusCode = run ? 200 : 404;
      response.end(JSON.stringify(run ?? {}));
    } else if (request.method === 'PUT' && /^\/repos\/corp\/example\/pulls\/42\/reviews\/\d+\/dismissals$/u.test(path)) {
      response.statusCode = state.dismissStatus;
      const id = Number(path.split('/').at(-2));
      const review = state.reviews.find((candidate) => candidate.id === id);
      if (review && state.dismissStatus === 200) review.state = 'DISMISSED';
      response.end(JSON.stringify(review ?? {}));
      if (state.headAfterDismiss) state.pr.head.sha = state.headAfterDismiss;
    } else if (request.method === 'POST' && path === '/repos/corp/example/pulls/42/reviews') {
      response.statusCode = state.postStatus;
      response.end(JSON.stringify({ id: 101, state: 'CHANGES_REQUESTED', commit_id: head }));
      if (state.headAfterPost) state.pr.head.sha = state.headAfterPost;
    } else {
      response.statusCode = 404;
      response.end('{}');
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
    GITHUB_RUN_ID: '12345',
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
  return execute('Validate PR-Agent review', {
    ...env,
    REVIEW_RESULT: review,
    REVIEWED_HEAD: revision.head,
    REVIEWED_BASE: revision.base,
    REVIEW_STARTED_AT: revision.started,
  });
}

async function seedResolvedReview({ state, env }) {
  const findingId = createHash('sha256').update('src/example.js|**bug** the result is wrong.').digest('hex').slice(0, 12);
  const metadata = { version: 1, run_id: '12345', head, base, security_tracked: true, finding_ids: [findingId] };
  const prior = {
    id: 101,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    commit_id: head,
    body: `<!-- heluo-forge-pr-agent-review:v1\n${JSON.stringify(metadata)}\n-->`,
  };
  state.reviews.push(prior);
  state.runs[metadata.run_id] = {
    id: 12345, event: 'pull_request', path: '.github/workflows/pr-agent.yml',
    status: 'completed', conclusion: 'success', head_sha: head,
    repository: { full_name: 'corp/example' }, head_repository: { full_name: 'corp/example' },
    pull_requests: [{ number: 42 }],
  };
  state.jobs[metadata.run_id] = [{ id: 999, run_id: 12345, name: '洛神 (ubuntu-x64)', status: 'completed', conclusion: 'success' }];
  state.logs['999'] = `2026-11-10T00:00:00Z HELUO_PR_AGENT_REVIEW_V1 12345 42 101 ${head} ${base}\n`;
  state.pr.head.sha = 'c'.repeat(40);
  const fixed = await capture(env);
  const findingState = {
    schema_version: 1,
    findings: [{ finding_id: findingId, state: 'RESOLVED', path: 'src/example.js', body: 'fixed' }],
    last_run: { kind: 'full', complete: true, excluded_files: [], head_sha: fixed.head },
  };
  state.comments.push({
    user: { login: 'github-actions[bot]' },
    updated_at: new Date(Date.now() + 1000).toISOString(),
    body: `<!-- pr-agent:review:full -->\n<!-- pr-agent-review-state:v1\n${JSON.stringify(findingState)}\n-->`,
  });
  state.comments.push({
    user: { login: 'github-actions[bot]' },
    updated_at: new Date(Date.now() + 1000).toISOString(),
    body: '<!-- pr-agent:describe:persistent -->',
  });
  state.requests.length = 0;
  const clean = JSON.stringify({ merge_recommendation: 'no_concerns_found', key_issues_to_review: [], security_concerns: 'No' });
  return { fixed, prior, clean };
}

test('the workflow and check display the 洛神 name', () => {
  assert.match(workflow, /^name: 洛神 \(PR-Agent\)$/mu);
  assert.match(workflow, /^    name: 洛神 \(ubuntu-x64\)$/mu);
});

test('pushes refresh the summary and review, including bot and merge commits', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(workflow, /types: \[opened, reopened, ready_for_review, review_requested, synchronize\]/u);
  assert.match(workflow, /github\.event\.sender\.type != 'Bot' \|\| github\.event\.action == 'synchronize'/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__HANDLE_PUSH_TRIGGER: "true"/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_COMMANDS: '\["\/describe", "\/review"\]'/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_TRIGGER_IGNORE_BOT_COMMITS: "false"/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_TRIGGER_IGNORE_MERGE_COMMITS: "false"/u);
  assert.match(settings, /handle_push_trigger = true/u);
  assert.match(settings, /push_commands = \["\/describe", "\/review"\]/u);
  assert.match(settings, /push_trigger_ignore_bot_commits = false/u);
  assert.match(settings, /push_trigger_ignore_merge_commits = false/u);
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
  assert.match(concurrency, /!contains\(github\.event\.comment\.body, '\/review'\)\) && 'other-comment'/u);
  assert.match(concurrency, /cancel-in-progress: \$\{\{ github\.event_name != 'issue_comment' \}\}/u);
});

test('the workflow runs result handling even when the action produced no output', () => {
  const step = workflow.split('      - name: Validate PR-Agent review\n')[1]?.split('\n      - name: ')[0] ?? '';
  assert.doesNotMatch(step, /^        if:/mu);
  assert.match(step, /REVIEW_RESULT: \$\{\{ steps\.pr_agent\.outputs\.review \}\}/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__ENABLE_OUTPUT: "true"/u);
});

test('the workflow preserves the PR description before base settings are available', () => {
  const action = workflow.split('      - name: Run PR-Agent\n')[1]?.split('\n      - name: ')[0] ?? '';
  assert.match(action, /PR_DESCRIPTION__PUBLISH_DESCRIPTION_AS_COMMENT: "true"/u);
  assert.match(action, /PR_DESCRIPTION__PUBLISH_DESCRIPTION_AS_COMMENT_PERSISTENT: "true"/u);
});

test('a changed head or base reports an out-of-date review', async () => {
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

test('a fork pull request does not change formal reviews', async () => {
  await withGitHub(async ({ state, env }) => {
    state.pr.head.repo.full_name = 'outside/fork';
    const revision = await capture(env);
    await submit(env, revision, '{"merge_recommendation":"changes_required"}');
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('a model-only blocking recommendation never creates a formal changes request', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.requests.length = 0;
    await submit(env, revision, JSON.stringify({
      merge_recommendation: 'changes_required',
      key_issues_to_review: [{ relevant_file: 'src/archive.js', issue_header: '可能的问题', issue_content: '若前缀未剥离则失败，需要核实。' }],
      security_concerns: 'No',
    }));
    assert.equal(state.requests.some((request) => request.method === 'POST'), false);
  });
});

test('a clean model review does not automatically dismiss an earlier formal request', async () => {
  await withGitHub(async (context) => {
    const { fixed, prior, clean } = await seedResolvedReview(context);
    await submit({ ...context.env, EVENT_ACTION: 'synchronize' }, fixed, clean);
    assert.equal(context.state.requests.some((request) => request.method === 'PUT'), false);
    assert.equal(prior.state, 'CHANGES_REQUESTED');
  });
});

test('pushes refresh the description before reviewing the current change', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(settings, /push_commands = \["\/describe", "\/review"\]/u);
  assert.match(settings, /publish_description_as_comment_persistent = true/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_COMMANDS: '\["\/describe", "\/review"\]'/u);
});

test('a push fails when either persistent summary or review was not refreshed', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    const fresh = (marker) => ({
      user: { login: 'github-actions[bot]' },
      updated_at: new Date(Date.now() + 1000).toISOString(),
      body: `<!-- ${marker} -->`,
    });
    const summary = fresh('pr-agent:describe:persistent');
    const review = fresh('pr-agent:review:full');
    const output = JSON.stringify({ merge_recommendation: 'no_concerns_found' });
    state.comments.push(...Array.from({ length: 100 }, () => fresh('unrelated')), summary, review);
    await submit({ ...env, EVENT_ACTION: 'synchronize' }, revision, output);
    summary.updated_at = '2020-01-01T00:00:00Z';
    await assert.rejects(submit({ ...env, EVENT_ACTION: 'synchronize' }, revision, output));
    summary.updated_at = review.updated_at;
    review.body = '<!-- an unrelated comment -->';
    await assert.rejects(submit({ ...env, EVENT_ACTION: 'synchronize' }, revision, output));
    review.body = '<!-- pr-agent:review:full -->';
    review.user.login = 'other';
    await assert.rejects(submit({ ...env, EVENT_ACTION: 'synchronize' }, revision, output));
    review.user.login = 'github-actions[bot]';
    state.headAfterCommentList = 'd'.repeat(40);
    await assert.rejects(submit({ ...env, EVENT_ACTION: 'synchronize' }, revision, output));
  });
});

test('incidental issue references do not become whole-ticket compliance requirements', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(settings, /require_ticket_analysis_review = false/u);
  assert.match(workflow, /PR_REVIEWER__REQUIRE_TICKET_ANALYSIS_REVIEW: "false"/u);
});

test('a finding absent from a later AI review is not labeled automatically resolved', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(settings, /persistent_finding_state = false/u);
  assert.match(workflow, /PR_REVIEWER__PERSISTENT_FINDING_STATE: "false"/u);
});

test('updating the persistent review does not add a redundant notification', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(settings, /final_update_message = false/u);
  assert.match(workflow, /PR_REVIEWER__FINAL_UPDATE_MESSAGE: "false"/u);
});
