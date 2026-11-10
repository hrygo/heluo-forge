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
    dismissStatus: 200,
    reviews: [],
    comments: [],
    runs: {},
    jobs: {},
    logs: {},
    headAfterPost: undefined,
    headAfterReviewList: undefined,
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
  return execute('Update requested changes', {
    ...env,
    REVIEW_RESULT: review,
    REVIEWED_HEAD: revision.head,
    REVIEWED_BASE: revision.base,
    REVIEW_STARTED_AT: revision.started,
  });
}

async function seedResolvedReview({ state, env }) {
  const first = await capture(env);
  await submit(env, first, JSON.stringify({
    merge_recommendation: 'changes_required',
    security_concerns: 'No',
    key_issues_to_review: [{ relevant_file: 'src/example.js', start_line: 12, issue_header: 'Bug', issue_content: 'The result is wrong.' }],
  }));
  const posted = state.requests.find((request) => request.method === 'POST');
  const marker = /<!-- heluo-forge-pr-agent-review:v1\n([^\n]+)\n-->/u.exec(posted?.body?.body ?? '');
  assert.ok(marker, 'formal review must include its finding identities');
  const metadata = JSON.parse(marker[1]);
  assert.ok(Array.isArray(metadata.finding_ids) && metadata.finding_ids.length > 0);
  const prior = { id: 101, user: { login: 'github-actions[bot]' }, state: 'CHANGES_REQUESTED', commit_id: head, body: posted.body.body };
  state.reviews.push(prior);
  state.runs[metadata.run_id] = {
    id: Number(metadata.run_id), event: 'pull_request', path: '.github/workflows/pr-agent.yml',
    status: 'completed', conclusion: 'success', head_sha: head,
    repository: { full_name: 'corp/example' }, head_repository: { full_name: 'corp/example' },
    pull_requests: [{ number: 42 }],
  };
  state.jobs[metadata.run_id] = [{ id: 999, run_id: Number(metadata.run_id), name: '洛神 (ubuntu-x64)', status: 'completed', conclusion: 'success' }];
  state.logs['999'] = `2026-11-10T00:00:00Z HELUO_PR_AGENT_REVIEW_V1 ${metadata.run_id} 42 101 ${head} ${base}\n`;
  state.pr.head.sha = 'c'.repeat(40);
  const fixed = await capture(env);
  const findingState = {
    schema_version: 1,
    findings: metadata.finding_ids.map((finding_id) => ({ finding_id, state: 'RESOLVED', path: 'src/example.js', body: 'fixed' })),
    last_run: { kind: 'full', complete: true, excluded_files: [], head_sha: fixed.head },
  };
  const comment = {
    user: { login: 'github-actions[bot]' },
    updated_at: new Date(Date.now() + 1000).toISOString(),
    body: `<!-- pr-agent:review:full -->\n<!-- pr-agent-review-state:v1\n${JSON.stringify(findingState)}\n-->`,
  };
  state.comments.push(comment);
  state.requests.length = 0;
  const clean = JSON.stringify({ merge_recommendation: 'no_concerns_found', key_issues_to_review: [], security_concerns: 'No' });
  return { fixed, prior, metadata, findingState, comment, clean };
}

test('a blocking recommendation requests changes on the reviewed commit', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    assert.equal(revision.head, head);
    assert.equal(revision.base, base);
    assert.ok(revision.started);
    await submit(env, revision, JSON.stringify({
      merge_recommendation: 'changes_required\n',
      key_issues_to_review: [{ relevant_file: 'src/example.js', start_line: 12, issue_header: 'Bug', issue_content: 'The result is wrong. @someone' }],
    }));
    const post = state.requests.find((request) => request.method === 'POST');
    assert.equal(post?.url, '/repos/corp/example/pulls/42/reviews');
    assert.equal(post.body.event, 'REQUEST_CHANGES');
    assert.equal(post.body.commit_id, head);
    assert.match(post.body.body, /洛神（PR-Agent）/u);
    assert.match(post.body.body, /PR-Agent/u);
    assert.match(post.body.body, /src\/example\.js/u);
    assert.match(post.body.body, /The result is wrong\./u);
    assert.doesNotMatch(post.body.body, /@someone/u);
    assert.match(post.body.body, /\/review/u);
  });
});

test('the workflow and check display the 洛神 name', () => {
  assert.match(workflow, /^name: 洛神 \(PR-Agent\)$/mu);
  assert.match(workflow, /^    name: 洛神 \(ubuntu-x64\)$/mu);
});

test('pushes trigger a full review, including bot and merge commits', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(workflow, /types: \[opened, reopened, ready_for_review, review_requested, synchronize\]/u);
  assert.match(workflow, /github\.event\.sender\.type != 'Bot' \|\| github\.event\.action == 'synchronize'/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__HANDLE_PUSH_TRIGGER: "true"/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_COMMANDS: '\["\/review"\]'/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_TRIGGER_IGNORE_BOT_COMMITS: "false"/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_TRIGGER_IGNORE_MERGE_COMMITS: "false"/u);
  assert.match(settings, /handle_push_trigger = true/u);
  assert.match(settings, /push_commands = \["\/review"\]/u);
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

test('a complete clean push review dismisses only matching tracked bot requests across pages', async () => {
  await withGitHub(async (context) => {
    const { state, env } = context;
    const { fixed, prior, clean } = await seedResolvedReview(context);
    const human = { id: 202, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: prior.body };
    const unrelated = { id: 203, user: { login: 'github-actions[bot]' }, state: 'CHANGES_REQUESTED', body: prior.body, commit_id: head };
    state.reviews.unshift(...Array.from({ length: 100 }, (_, id) => ({ id: id + 1000, user: { login: 'other' }, state: 'COMMENTED' })));
    state.reviews.push(human, unrelated);
    state.comments.unshift(...Array.from({ length: 100 }, () => ({ user: { login: 'other' }, body: 'unrelated' })));
    await submit({ ...env, EVENT_ACTION: 'synchronize' }, fixed, clean);
    const dismissals = state.requests.filter((request) => request.method === 'PUT');
    assert.deepEqual(dismissals.map((request) => request.url), ['/repos/corp/example/pulls/42/reviews/101/dismissals']);
    assert.match(dismissals[0].body.message, /复审/u);
    assert.equal(prior.state, 'DISMISSED');
    assert.equal(human.state, 'CHANGES_REQUESTED');
    assert.equal(unrelated.state, 'CHANGES_REQUESTED');
  });
});

test('finding identities match PR-Agent version-1 fingerprints', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    await submit(env, revision, JSON.stringify({
      merge_recommendation: 'changes_required',
      security_concerns: 'No',
      key_issues_to_review: [{
        relevant_file: 'scripts/sensitive-scan/verify.mjs',
        issue_header: 'Attestation Bypass',
        issue_content: 'The new early return when `BYPASS_SENSITIVE_ATTESTATION` is `1` exits with success without verifying signatures, so anyone who can control the process environment can skip attestation entirely by setting that variable.',
      }],
    }));
    const posted = state.requests.find((request) => request.method === 'POST');
    const marker = /<!-- heluo-forge-pr-agent-review:v1\n([^\n]+)\n-->/u.exec(posted.body.body);
    assert.deepEqual(JSON.parse(marker[1]).finding_ids, ['654259fee4ab']);
  });
});

test('a separate security concern is not marked for automatic dismissal', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    await submit(env, revision, JSON.stringify({
      merge_recommendation: 'changes_required',
      security_concerns: 'A separate credential is exposed.',
      key_issues_to_review: [{ relevant_file: 'src/example.js', issue_header: 'Bug', issue_content: 'The result is wrong.' }],
    }));
    const posted = state.requests.find((request) => request.method === 'POST');
    assert.doesNotMatch(posted.body.body, /heluo-forge-pr-agent-review:v1/u);
  });
});

test('a security concern captured verbatim in a tracked finding can be rechecked', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    await submit(env, revision, JSON.stringify({
      merge_recommendation: 'changes_required',
      security_concerns: 'Credentials leak into logs.',
      key_issues_to_review: [{ relevant_file: 'src/example.js', issue_header: 'Bug', issue_content: 'Credentials leak into logs. Remove the debug line.' }],
    }));
    const posted = state.requests.find((request) => request.method === 'POST');
    assert.match(posted.body.body, /heluo-forge-pr-agent-review:v1/u);
  });
});

for (const [label, mutate] of [
  ['a still-active finding', ({ findingState }) => { findingState.findings[0].state = 'ACTIVE'; }],
  ['an unknown finding', ({ findingState }) => { findingState.findings[0].finding_id = 'not-the-original'; }],
  ['an incomplete review', ({ findingState }) => { findingState.last_run.complete = false; }],
  ['a partial review', ({ findingState }) => { findingState.last_run.kind = 'partial'; }],
  ['excluded files', ({ findingState }) => { findingState.last_run.excluded_files = ['src/example.js']; }],
  ['an old reviewed head', ({ findingState }) => { findingState.last_run.head_sha = head; }],
  ['a state older than the current review', ({ comment }) => { comment.updated_at = '2020-01-01T00:00:00Z'; }],
  ['a missing state marker', ({ comment }) => { comment.body = '<!-- pr-agent:review:full -->'; }],
  ['a legacy untracked request', ({ prior }) => { prior.body = '洛神（PR-Agent）发现合并前必须修复的问题。'; }],
  ['a request from another workflow', ({ run }) => { run.path = '.github/workflows/other.yml'; }],
  ['a request from a different commit', ({ run }) => { run.head_sha = 'd'.repeat(40); }],
  ['a request from another PR', ({ run }) => { run.pull_requests = [{ number: 99 }]; }],
]) {
  test(`${label} leaves the existing request in place`, async () => {
    await withGitHub(async (context) => {
      const evidence = await seedResolvedReview(context);
      mutate({ ...evidence, run: context.state.runs[evidence.metadata.run_id] });
      if (evidence.comment.body.includes('pr-agent-review-state:v1')) {
        evidence.comment.body = `<!-- pr-agent:review:full -->\n<!-- pr-agent-review-state:v1\n${JSON.stringify(evidence.findingState)}\n-->`;
      }
      await submit({ ...context.env, EVENT_ACTION: 'synchronize' }, evidence.fixed, evidence.clean);
      assert.equal(context.state.requests.filter((request) => request.method === 'PUT').length, 0);
      assert.equal(evidence.prior.state, 'CHANGES_REQUESTED');
    });
  });
}

test('an empty GitHub pull_requests array does not prevent verification of an origin log', async () => {
  await withGitHub(async (context) => {
    const { fixed, prior, metadata, clean } = await seedResolvedReview(context);
    context.state.runs[metadata.run_id].pull_requests = [];
    await submit({ ...context.env, EVENT_ACTION: 'synchronize' }, fixed, clean);
    assert.equal(prior.state, 'DISMISSED');
  });
});

test('a full manual review can clear a tracked request if it supersedes a pending push', async () => {
  await withGitHub(async (context) => {
    const { fixed, prior, clean } = await seedResolvedReview(context);
    await submit({ ...context.env, EVENT_NAME: 'issue_comment', COMMENT_BODY: '  /review  ' }, fixed, clean);
    assert.equal(prior.state, 'DISMISSED');
  });
});

test('a tracked request from an exact manual full review can be traced and cleared', async () => {
  await withGitHub(async (context) => {
    const { fixed, prior, metadata, clean } = await seedResolvedReview(context);
    const run = context.state.runs[metadata.run_id];
    run.event = 'issue_comment';
    run.head_sha = base;
    run.pull_requests = [];
    await submit({ ...context.env, EVENT_ACTION: 'synchronize' }, fixed, clean);
    assert.equal(prior.state, 'DISMISSED');
  });
});

test('uncertain, incomplete or incremental outputs never dismiss a request', async () => {
  await withGitHub(async (context) => {
    const { fixed, prior, clean } = await seedResolvedReview(context);
    for (const [env, output] of [
      [{ ...context.env, EVENT_ACTION: 'synchronize' }, '{"merge_recommendation":"needs_review"}'],
      [{ ...context.env, EVENT_ACTION: 'synchronize' }, '{"merge_recommendation":"no_concerns_found","key_issues_to_review":[],"security_concerns":"Security issue remains"}'],
      [{ ...context.env, EVENT_ACTION: 'synchronize' }, '{"merge_recommendation":"no_concerns_found","key_issues_to_review":[{"issue_header":"Bug"}],"security_concerns":"No"}'],
      [{ ...context.env, EVENT_NAME: 'issue_comment', COMMENT_BODY: '/review -i' }, clean],
    ]) await submit(env, fixed, output);
    assert.equal(context.state.requests.filter((request) => request.method === 'PUT').length, 0);
    assert.equal(prior.state, 'CHANGES_REQUESTED');
  });
});

test('a changed revision or a rejected dismissal is reported', async () => {
  await withGitHub(async (context) => {
    const { fixed, prior, clean } = await seedResolvedReview(context);
    context.state.headAfterReviewList = 'd'.repeat(40);
    await assert.rejects(submit({ ...context.env, EVENT_ACTION: 'synchronize' }, fixed, clean));
    assert.equal(context.state.requests.filter((request) => request.method === 'PUT').length, 0);
    context.state.headAfterReviewList = undefined;
    context.state.pr.head.sha = fixed.head;
    context.state.dismissStatus = 403;
    await assert.rejects(submit({ ...context.env, EVENT_ACTION: 'synchronize' }, fixed, clean));
    assert.equal(prior.state, 'CHANGES_REQUESTED');
  });
});

test('a revision change after dismissal is reported for manual follow-up', async () => {
  await withGitHub(async (context) => {
    const { fixed, prior, clean } = await seedResolvedReview(context);
    context.state.headAfterDismiss = 'd'.repeat(40);
    await assert.rejects(submit({ ...context.env, EVENT_ACTION: 'synchronize' }, fixed, clean));
    assert.equal(prior.state, 'DISMISSED');
  });
});

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
  const step = workflow.split('      - name: Update requested changes\n')[1]?.split('\n      - name: ')[0] ?? '';
  assert.doesNotMatch(step, /^        if:/mu);
  assert.match(step, /REVIEW_RESULT: \$\{\{ steps\.pr_agent\.outputs\.review \}\}/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__ENABLE_OUTPUT: "true"/u);
});

test('the workflow preserves the PR description before base settings are available', () => {
  const action = workflow.split('      - name: Run PR-Agent\n')[1]?.split('\n      - name: ')[0] ?? '';
  assert.match(action, /PR_DESCRIPTION__PUBLISH_DESCRIPTION_AS_COMMENT: "true"/u);
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
