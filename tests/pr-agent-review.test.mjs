import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const workflow = await readFile(new URL('../.github/workflows/pr-agent.yml', import.meta.url), 'utf8');
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

function stepDefinition(name) {
  return workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0] ?? '';
}

function stepScript(name) {
  const script = /\n          node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE(?:\n|$)/u.exec(stepDefinition(name))?.[1];
  assert.ok(script, `missing executable Node script for ${name}`);
  return script.replace(/^ {10}/gmu, '');
}

async function withGitHub(run) {
  const state = {
    pr: { state: 'open', changed_files: 1, head: { sha: head, repo: { full_name: 'corp/example' } }, base: { sha: base, ref: 'main', repo: { full_name: 'corp/example' } } },
    refs: { main: base },
    refStatus: 200,
    refResponse: undefined,
    compareStatus: 200,
    compareResponse: undefined,
    requests: [],
    postStatus: 200,
    dismissStatus: 200,
    reviews: [],
    comments: [],
    runs: {},
    runListStatus: 200,
    jobs: {},
    logs: {},
    headAfterPost: undefined,
    headAfterReviewList: undefined,
    headAfterCommentList: undefined,
    baseAfterCommentList: undefined,
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
    } else if (request.method === 'GET' && path.startsWith('/repos/corp/example/git/ref/heads/')) {
      const ref = decodeURIComponent(path.slice('/repos/corp/example/git/ref/heads/'.length));
      response.statusCode = state.refStatus === 200 && !(ref in state.refs) ? 404 : state.refStatus;
      response.end(JSON.stringify(state.refResponse ?? { ref: `refs/heads/${ref}`, object: { type: 'commit', sha: state.refs[ref] } }));
    } else if (request.method === 'GET' && /^\/repos\/corp\/example\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/u.test(path)) {
      response.statusCode = state.compareStatus;
      response.end(JSON.stringify(state.compareResponse ?? { status: 'ahead', base_commit: { sha: path.split('/').at(-1).split('...')[0] }, files: [] }));
    } else if (request.method === 'GET' && path === '/repos/corp/example/pulls/42/reviews') {
      response.end(JSON.stringify(state.reviews.slice((page - 1) * 100, page * 100)));
      if (state.headAfterReviewList) state.pr.head.sha = state.headAfterReviewList;
    } else if (request.method === 'GET' && path === '/repos/corp/example/issues/42/comments') {
      response.end(JSON.stringify(state.comments.slice((page - 1) * 100, page * 100)));
      if (state.headAfterCommentList) state.pr.head.sha = state.headAfterCommentList;
      if (state.baseAfterCommentList) state.refs.main = state.baseAfterCommentList;
    } else if (request.method === 'GET' && path === '/repos/corp/example/actions/workflows/pr-agent.yml/runs') {
      response.statusCode = state.runListStatus;
      const runs = Object.values(state.runs).filter((run) => run.event === url.searchParams.get('event') &&
        run.conclusion === url.searchParams.get('status') && run.head_sha === url.searchParams.get('head_sha'));
      response.end(JSON.stringify({ workflow_runs: runs.slice((page - 1) * 100, page * 100) }));
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
  await writeFile(env.GITHUB_OUTPUT, '');
  await execute('Capture PR revision', env);
  const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
  if (!output) return {};
  return Object.fromEntries(output.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function submit(env, revision, review) {
  return execute('Validate PR-Agent review', {
    ...env,
    REVIEW_RESULT: review,
    REVIEWED_HEAD: revision.head,
    REVIEWED_BASE: revision.base,
    REVIEWED_BASE_REF: revision.base_ref,
    REVIEW_STARTED_AT: revision.started,
  });
}

function recordAutomaticRun(state, { number = 42, sha = head, runId = 12, ranReview = true } = {}) {
  state.runs[runId] = {
    id: runId, event: 'pull_request', conclusion: 'success', head_sha: sha,
    display_title: `洛神 · PR #${number}`, pull_requests: [],
  };
  state.jobs[runId] = [{
    name: '洛神 (ubuntu-x64)',
    conclusion: 'success',
    steps: [
      { name: 'Confirm completed automatic review', conclusion: ranReview ? 'success' : 'skipped' },
    ],
  }];
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

test('the review job stays off until the repository variable enables it', () => {
  const folded = /\n    if: >-\n((?: {6}[^\n]*\n)+)/u.exec(workflow)?.[1] ?? '';
  const condition = folded.replace(/\s+/gu, ' ').trim();
  const decide = (vars, event) => {
    const github = { event_name: event.name, repository: 'corp/example', event: event.payload };
    const contains = (haystack, needle) => Array.isArray(haystack)
      ? haystack.includes(needle)
      : String(haystack).toLowerCase().includes(String(needle).toLowerCase());
    return new Function('vars', 'github', 'fromJSON', 'contains', `return (${condition});`)(
      vars, github, JSON.parse, contains,
    );
  };
  const openedPullRequest = {
    name: 'pull_request',
    payload: {
      sender: { type: 'User' },
      action: 'opened',
      pull_request: { draft: false, head: { repo: { full_name: 'corp/example' } } },
    },
  };
  const reviewComment = {
    name: 'issue_comment',
    payload: {
      sender: { type: 'User' },
      issue: { pull_request: {} },
      comment: { author_association: 'OWNER' },
    },
  };
  // An absent or falsy variable must skip both event types at the top level;
  // a switch moved inside only one event branch would still run the other.
  for (const vars of [{}, { PR_AGENT_ENABLED: '' }, { PR_AGENT_ENABLED: 'false' }, { PR_AGENT_ENABLED: 'no' }]) {
    assert.equal(decide(vars, openedPullRequest), false);
    assert.equal(decide(vars, reviewComment), false);
  }
  const enabled = { PR_AGENT_ENABLED: 'true' };
  assert.equal(decide(enabled, openedPullRequest), true);
  assert.equal(decide(enabled, reviewComment), true);
  const push = { ...openedPullRequest.payload, action: 'synchronize', sender: { type: 'Bot' }, before: base, after: head };
  assert.equal(decide(enabled, { ...openedPullRequest, payload: push }), true);
  assert.equal(decide(enabled, { ...openedPullRequest, payload: { ...push, before: head } }), false);
  assert.equal(decide(enabled, { ...openedPullRequest, payload: { ...push, before: undefined } }), true);
  // The existing event filters still apply once the switch is on.
  assert.equal(decide(enabled, {
    ...openedPullRequest,
    payload: { ...openedPullRequest.payload, sender: { type: 'Bot' } },
  }), false);
  assert.equal(decide(enabled, {
    ...openedPullRequest,
    payload: { ...openedPullRequest.payload, pull_request: { draft: true, head: { repo: { full_name: 'corp/example' } } } },
  }), false);
  assert.equal(decide(enabled, {
    ...reviewComment,
    payload: { ...reviewComment.payload, comment: { author_association: 'CONTRIBUTOR' } },
  }), false);
});

test('the header documents how to turn the review back on and off', () => {
  assert.match(workflow, /gh variable set PR_AGENT_ENABLED --body true/u);
  assert.match(workflow, /gh variable delete PR_AGENT_ENABLED/u);
  // GitHub compares strings ignoring case, and a skipped job still shows a check.
  assert.match(workflow, /compares strings ignoring case/u);
  assert.match(workflow, /A skipped job still appears as a/u);
  assert.match(workflow, /status `skipped`/u);
});

test('pushes refresh the summary and review, including bot and merge commits', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
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

test('only PR lifecycle and commit changes trigger automatic review', () => {
  const types = /^  pull_request:\n    types: \[([^\n]+)\]/mu.exec(workflow)?.[1].split(', ');
  assert.deepEqual(types, ['opened', 'reopened', 'ready_for_review', 'synchronize']);
  assert.match(workflow, /^  issue_comment:\n    types: \[created\]$/mu);
});

test('runs record the PR number for exact review history lookup', () => {
  assert.match(workflow, /^run-name: '洛神 · PR #\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \}\}'$/mu);
});

test('subsequent automatic events skip a review already completed for the same PR and head', async () => {
  await withGitHub(async ({ state, env }) => {
    recordAutomaticRun(state);
    for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize']) {
      assert.deepEqual(await capture({ ...env, EVENT_ACTION: action, EVENT_HEAD: head }), {});
    }
  });
});

test('a new head is reviewed even when the previous commit was already reviewed', async () => {
  await withGitHub(async ({ state, env }) => {
    recordAutomaticRun(state);
    const newHead = 'c'.repeat(40);
    state.pr.head.sha = newHead;
    const revision = await capture({ ...env, EVENT_ACTION: 'synchronize', EVENT_HEAD: newHead });
    assert.equal(revision.head, newHead);
  });
});

test('reviews for other PRs, manual runs and skipped automatic runs do not satisfy deduplication', async () => {
  await withGitHub(async ({ state, env }) => {
    recordAutomaticRun(state, { number: 43 });
    recordAutomaticRun(state, { runId: 13 });
    state.runs[13].event = 'issue_comment';
    recordAutomaticRun(state, { runId: 14, ranReview: false });
    const revision = await capture({ ...env, EVENT_ACTION: 'ready_for_review', EVENT_HEAD: head });
    assert.equal(revision.head, head);
  });
});

test('an outdated queued event cannot review the new head on behalf of an older commit', async () => {
  await withGitHub(async ({ state, env }) => {
    state.pr.head.sha = 'c'.repeat(40);
    assert.deepEqual(await capture({ ...env, EVENT_ACTION: 'synchronize', EVENT_HEAD: head }), {});
  });
});

test('an explicit manual /review still runs for a previously reviewed head', async () => {
  await withGitHub(async ({ state, env }) => {
    recordAutomaticRun(state);
    const manual = { ...env, EVENT_NAME: 'issue_comment', EVENT_ACTION: 'created', COMMENT_BODY: '  /review' };
    const revision = await capture(manual);
    assert.equal(revision.head, head);
    await submit(manual, revision, '{"merge_recommendation":"no_concerns_found"}');
    assert.equal(state.requests.some(({ url }) => url.includes('/actions/workflows/')), false);
  });
});

test('unreadable review history fails before starting another automatic review', async () => {
  await withGitHub(async ({ state, env }) => {
    state.runListStatus = 403;
    await assert.rejects(capture({ ...env, EVENT_HEAD: head }), /Cannot read prior automatic reviews \(HTTP 403\)/u);
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
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('an empty pull request may finish without structured review output', async () => {
  await withGitHub(async ({ state, env }) => {
    state.pr.changed_files = 0;
    const revision = await capture(env);
    const result = await submit(env, revision, '');
    assert.match(result.stdout, /no changed files/iu);
    assert.equal(state.requests.some((request) => request.method !== 'GET'), false);
  });
});

test('empty-review output requires a verified empty diff and an unchanged target', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    for (const count of [1, null, undefined, '0']) {
      state.pr.changed_files = count;
      await assert.rejects(submit(env, revision, ''), /did not produce structured review output/u);
    }
    state.pr.changed_files = 0;
    state.refStatus = 403;
    await assert.rejects(submit(env, revision, ''), /Cannot verify target branch \(HTTP 403\)/u);
  });
});

test('an empty PR file count must agree with an exact commit comparison', async () => {
  await withGitHub(async ({ state, env }) => {
    state.pr.changed_files = 0;
    const revision = await capture(env);
    state.compareResponse = { status: 'ahead', base_commit: { sha: base }, files: [{ filename: 'src/changed.js' }] };
    await assert.rejects(submit(env, revision, ''), /did not produce structured review output/u);
    state.compareResponse = { status: 'ahead', base_commit: { sha: base } };
    await assert.rejects(submit(env, revision, ''), /Invalid PR comparison/u);
    state.compareResponse = undefined;
    state.compareStatus = 403;
    await assert.rejects(submit(env, revision, ''), /Cannot verify PR comparison \(HTTP 403\)/u);
  });
});

test('automated and manual reviews for a PR share a queue without canceling pending runs', () => {
  const concurrency = /^concurrency:\n((?: {2}[^\n]*\n)+)/mu.exec(workflow)?.[1] ?? '';
  assert.match(concurrency, /^  queue: max$/mu);
  assert.doesNotMatch(concurrency, /^  cancel-in-progress: (?!false$)/mu);
  const group = /^  group: ([^\n]+)$/mu.exec(concurrency)?.[1];
  assert.ok(group);
  const groupFor = (github) => group.replace(/\$\{\{ (.*?) \}\}/gu, (_, expression) =>
    new Function('github', 'fromJSON', 'contains', `return (${expression});`)(
      github, JSON.parse, (text, term) => text.includes(term),
    ));
  const automatic = (number) => groupFor({ event_name: 'pull_request', event: { pull_request: { number } } });
  const comment = (body, authorAssociation = 'MEMBER', senderType = 'User') => groupFor({
    event_name: 'issue_comment',
    event: {
      pull_request: {},
      issue: { number: 42 },
      sender: { type: senderType },
      comment: { body, author_association: authorAssociation },
    },
  });
  assert.equal(comment('  /review'), automatic(42));
  assert.notEqual(automatic(43), automatic(42));
  assert.notEqual(comment('Thanks'), automatic(42));
  assert.notEqual(comment('/review', 'CONTRIBUTOR'), automatic(42));
  assert.notEqual(comment('/review', 'MEMBER', 'Bot'), automatic(42));
});

test('the workflow runs result handling even when the action produced no output', () => {
  const gate = /^        if: \$\{\{ steps\.revision\.outputs\.head != '' \}\}$/mu;
  assert.match(stepDefinition('Run PR-Agent'), gate);
  assert.match(stepDefinition('Validate PR-Agent review'), gate);
  assert.match(stepDefinition('Validate PR-Agent review'), /REVIEW_RESULT: \$\{\{ steps\.pr_agent\.outputs\.review \}\}/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__ENABLE_OUTPUT: "true"/u);
});

test('only a completed automatic review is recorded in the job steps', () => {
  const condition = /^        if: \$\{\{ (.*) \}\}$/mu.exec(stepDefinition('Confirm completed automatic review'))?.[1];
  assert.ok(condition);
  const records = (eventName, review, retry = '', refreshedReview = '') => new Function('github', 'steps', `return (${condition});`)(
    { event_name: eventName }, {
      pr_agent: { outputs: { review } },
      validation: { outputs: { retry } },
      pr_agent_retry: { outputs: { review: refreshedReview } },
    },
  );
  assert.equal(records('pull_request', 'review output'), true);
  assert.equal(records('pull_request', 'review output', 'true', 'refreshed output'), true);
  assert.equal(records('pull_request', 'review output', 'true'), false);
  assert.equal(records('pull_request', ''), false);
  assert.equal(records('issue_comment', 'review output'), false);
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
    state.refs.main = 'd'.repeat(40);
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"changes_required"}'));
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('capture uses the current branch tip when the PR base SHA is stale', async () => {
  await withGitHub(async ({ state, env }) => {
    state.pr.base.sha = 'c'.repeat(40);
    const revision = await capture(env);
    assert.equal(revision.base, base);
    assert.equal(revision.base_ref, 'main');
    state.pr.base.sha = 'd'.repeat(40);
    await submit(env, revision, '{"merge_recommendation":"no_concerns_found"}');
  });
});

test('a target branch advance is detected even when the PR base SHA is unchanged', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.refs.main = 'd'.repeat(40);
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"no_concerns_found"}'), /PR revision changed during review/u);
    assert.equal(state.pr.base.sha, base);
  });
});

test('an advancing target causes a bounded automatic refresh of the review', async () => {
  await withGitHub(async ({ state, env }) => {
    const oldRevision = await capture(env);
    const newBase = 'd'.repeat(40);
    state.refs.main = newBase;
    const output = '{"merge_recommendation":"no_concerns_found"}';
    await submit({ ...env, PR_AGENT_ALLOW_RETRY: 'true' }, oldRevision, output);
    assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^retry=true$/mu);
    const newRevision = await capture(env);
    assert.equal(newRevision.base, newBase);
    await submit(env, newRevision, output);
    state.refs.main = 'e'.repeat(40);
    await assert.rejects(submit(env, newRevision, output), /PR revision changed during review/u);
  });
});

test('the workflow retries once with the same pinned PR-Agent and validates the new revision', () => {
  const retry = workflow.split('      - name: Retry PR-Agent\n')[1]?.split('\n      - name: ')[0] ?? '';
  assert.match(retry, /if: \$\{\{ steps\.validation\.outputs\.retry == 'true' \}\}/u);
  assert.match(retry, /uses: the-pr-agent\/pr-agent@e673a02076ce09a4726c3d0c3cc85780e59ca52b/u);
  const recheck = workflow.split('      - name: Validate refreshed PR-Agent review\n')[1]?.split('\n      - name: ')[0] ?? '';
  assert.match(recheck, /steps\.retry_revision\.outputs\.base/u);
  assert.match(recheck, /steps\.pr_agent_retry\.outputs\.review/u);
});

test('retry never follows a changed head or retargeted PR', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    const expected = { ...env, EXPECTED_HEAD: revision.head, EXPECTED_BASE_REF: revision.base_ref };
    state.pr.head.sha = 'c'.repeat(40);
    await assert.rejects(capture(expected), /PR revision changed before retry/u);
    state.pr.head.sha = head;
    state.pr.base.ref = 'release';
    state.refs.release = base;
    await assert.rejects(capture(expected), /PR revision changed before retry/u);
  });
});

test('a retried pull request must refresh both persistent comments', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    const output = '{"merge_recommendation":"no_concerns_found"}';
    await assert.rejects(submit({ ...env, PR_AGENT_CHECK_REFRESH: 'true' }, revision, output), /summary and review were not both refreshed/u);
    const updated = new Date(Date.now() + 1000).toISOString();
    state.comments.push(...['pr-agent:describe:persistent', 'pr-agent:review:full'].map((marker) => ({
      user: { login: 'github-actions[bot]' }, updated_at: updated, body: `<!-- ${marker} -->`,
    })));
    await submit({ ...env, PR_AGENT_CHECK_REFRESH: 'true' }, revision, output);
  });
});

test('retargeting to another branch with the same SHA invalidates a review', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.pr.base.ref = 'release';
    state.refs.release = base;
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"no_concerns_found"}'), /PR revision changed during review/u);
  });
});

test('target branch names with slashes and equals signs are captured safely', async () => {
  await withGitHub(async ({ state, env }) => {
    state.pr.base.ref = 'release/candidate=1';
    state.refs[state.pr.base.ref] = base;
    const revision = await capture(env);
    assert.equal(revision.base_ref, state.pr.base.ref);
    assert.equal(revision.base, base);
    await submit(env, revision, '{"merge_recommendation":"no_concerns_found"}');
  });
});

test('missing, unreadable or invalid target branch references fail closed', async () => {
  await withGitHub(async ({ state, env }) => {
    for (const status of [403, 404, 500]) {
      state.refStatus = status;
      await assert.rejects(capture(env));
    }
    state.refStatus = 200;
    state.refs.main = 'invalid-sha';
    await assert.rejects(capture(env));
    state.refs.main = base;
    for (const reference of [
      { ref: 'refs/heads/other', object: { type: 'commit', sha: base } },
      { ref: 'refs/heads/main', object: { type: 'tag', sha: base } },
      { ref: 'refs/heads/main', object: {} },
    ]) {
      state.refResponse = reference;
      await assert.rejects(capture(env));
    }
    state.refResponse = undefined;
    state.pr.base.ref = 'main\ninvalid';
    await assert.rejects(capture(env));
    state.pr.base.ref = 'main';
    state.pr.base.repo.full_name = 'other/repository';
    await assert.rejects(capture(env));
  });
});

test('an unreadable target branch during review fails closed', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.refStatus = 403;
    await assert.rejects(submit(env, revision, '{"merge_recommendation":"no_concerns_found"}'), /Cannot verify target branch \(HTTP 403\)/u);
  });
});

test('a target branch advance while checking synchronized comments invalidates the review', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    const updatedAt = new Date(Date.now() + 1000).toISOString();
    for (const marker of ['pr-agent:describe:persistent', 'pr-agent:review:full']) {
      state.comments.push({ user: { login: 'github-actions[bot]' }, updated_at: updatedAt, body: `<!-- ${marker} -->` });
    }
    state.baseAfterCommentList = 'd'.repeat(40);
    await assert.rejects(submit({ ...env, EVENT_ACTION: 'synchronize' }, revision, '{"merge_recommendation":"no_concerns_found"}'), /PR revision changed during review/u);
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
