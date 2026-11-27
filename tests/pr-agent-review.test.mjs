import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const workflow = await readFile(new URL('../.github/workflows/pr-agent.yml', import.meta.url), 'utf8');
const signalWorkflow = await readFile(new URL('../.github/workflows/pr-agent-signal.yml', import.meta.url), 'utf8');
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const longCommentText = '中'.repeat(44_000);

test('the automatic trigger has read-only permissions and the publisher uses the default-branch workflow', async () => {
  assert.match(workflow, /^  workflow_run:\n    workflows: \[pr-agent-signal\]\n    types: \[completed\]$/mu);
  assert.doesNotMatch(workflow, /^  pull_request:/mu);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}\n\s+persist-credentials: false/u);
  assert.match(workflow, /^ {6}ARTIFACTS__ENABLE: "false"$/mu);
  assert.match(workflow, /^ {6}ARTIFACTS__TARGET_TOOLS: '\[\]'$/mu);
  const signal = await readFile(new URL('../.github/workflows/pr-agent-signal.yml', import.meta.url), 'utf8');
  assert.match(signal, /^  pull_request:/mu);
  assert.match(signal, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(signal, /secrets\.|\bwrite\b|actions\/checkout/u);
});

function stepDefinition(name) {
  return workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0] ?? '';
}

const script = fileURLToPath(new URL('../scripts/pr-agent-workflow.mjs', import.meta.url));
const repository = 'corp/example';
const maintainer = { id: 774, login: 'maintainer', type: 'User' };

function freshComment(marker) {
  return { user: { login: 'github-actions[bot]' }, updated_at: new Date(Date.now() + 1000).toISOString(),
    body: '<!-- ' + marker + ' -->' };
}

async function withGitHub(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-agent-review-'));
  const eventPath = join(directory, 'event.json');
  const state = {
    pr: { number: 42, state: 'open', draft: false, title: 'Example pull request', changed_files: 1,
      head: { sha: head, repo: { full_name: repository } }, base: { sha: base, ref: 'main', repo: { full_name: repository } } },
    refs: { main: base },
    refStatus: 200,
    compareStatus: 200,
    requests: [],
    postStatus: 200,
    permission: 'write',
    files: [{ filename: 'src/example.js', status: 'modified', patch: '@@ -1,2 +1,2 @@\n function count() {\n-  return 1;\n+  return 0;' }],
    reviews: [],
    inlineComments: [],
    comments: [freshComment('pr-agent:describe:persistent'), freshComment('pr-agent:review:full')],
    runs: {},
    runListStatus: 200,
    jobs: { 9001: [{ name: 'signal', conclusion: 'success' }] },
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    state.requests.push({ method: request.method, url: request.url, body });
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/^\/repos\/corp\/example/u, '');
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageOf = (items) => items.slice((page - 1) * 100, page * 100);
    if (request.method === 'GET' && path === '/pulls/42') {
      response.end(JSON.stringify(state.pr));
    } else if (request.method === 'GET' && path.startsWith('/git/ref/heads/')) {
      const ref = decodeURIComponent(path.slice('/git/ref/heads/'.length));
      response.statusCode = state.refStatus === 200 && !(ref in state.refs) ? 404 : state.refStatus;
      response.end(JSON.stringify(state.refResponse ?? { ref: 'refs/heads/' + ref, object: { type: 'commit', sha: state.refs[ref] } }));
    } else if (request.method === 'GET' && /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/u.test(path)) {
      response.statusCode = state.compareStatus;
      response.end(JSON.stringify(state.compareResponse ?? { status: 'ahead', base_commit: { sha: path.split('/').at(-1).split('...')[0] }, files: [] }));
    } else if (request.method === 'GET' && path === '/pulls/42/files') {
      response.end(JSON.stringify(pageOf(state.files)));
    } else if (request.method === 'GET' && path === '/pulls/42/comments') {
      response.end(JSON.stringify(pageOf(state.inlineComments)));
      if (state.headAfterInlineList) state.pr.head.sha = state.headAfterInlineList;
    } else if (request.method === 'GET' && path === '/pulls/42/reviews') {
      response.end(JSON.stringify(pageOf(state.reviews)));
    } else if (request.method === 'GET' && path === '/issues/42/comments') {
      response.end(JSON.stringify(pageOf(state.comments)));
      if (state.headAfterCommentList) state.pr.head.sha = state.headAfterCommentList;
      if (state.baseAfterCommentList) state.refs.main = state.baseAfterCommentList;
    } else if (request.method === 'GET' && path === '/issues/comments/340') {
      const event = JSON.parse(await readFile(eventPath, 'utf8'));
      response.end(JSON.stringify({ ...event.comment, issue_url: 'https://api.github.com/repos/corp/example/issues/42' }));
    } else if (request.method === 'GET' && path === '/collaborators/maintainer/permission') {
      response.end(JSON.stringify({ user: maintainer, permission: state.permission }));
    } else if (request.method === 'GET' && path === '/actions/workflows/pr-agent.yml/runs') {
      response.statusCode = state.runListStatus;
      const runs = Object.values(state.runs).filter((run) => run.event === url.searchParams.get('event') &&
        run.conclusion === url.searchParams.get('status'));
      response.end(JSON.stringify({ workflow_runs: pageOf(runs) }));
    } else if (request.method === 'GET' && /^\/actions\/runs\/\d+\/jobs$/u.test(path)) {
      const jobs = state.jobs[path.split('/').at(-2)] ?? [];
      response.end(JSON.stringify({ total_count: jobs.length, jobs: pageOf(jobs) }));
    } else if (request.method === 'POST' && path === '/pulls/42/reviews') {
      response.statusCode = state.postStatus;
      const review = {
        id: 101 + state.reviews.length, state: body.event === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED',
        commit_id: body.commit_id, user: { login: 'github-actions[bot]' }, body: body.body,
      };
      if (state.postStatus < 300) {
        state.reviews.push(review);
        state.inlineComments.push(...(body.comments ?? []).map((comment) =>
          ({ ...comment, user: review.user, commit_id: body.commit_id })));
      }
      response.end(JSON.stringify(review));
    } else if (request.method === 'PUT' && /^\/pulls\/42\/reviews\/\d+$/u.test(path)) {
      const id = Number(path.split('/').at(-1));
      const review = state.reviews.find((candidate) => candidate.id === id);
      if (review) review.body = body.body;
      response.end(JSON.stringify(review ?? {}));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    GITHUB_API_URL: 'http://127.0.0.1:' + server.address().port,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: repository,
    GITHUB_OUTPUT: join(directory, 'output'),
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_RUN_ATTEMPT: '1',
    GH_TOKEN: 'test-token',
    GITHUB_RUN_ID: '12345',
  };
  try {
    await run({ state, env });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

function signalEvent(env) {
  const repo = { full_name: repository };
  const pull = { number: 42, url: env.GITHUB_API_URL + '/repos/corp/example/pulls/42' };
  return {
    action: 'completed', repository: repo,
    workflow_run: {
      id: 9001, event: 'pull_request', conclusion: 'success', path: '.github/workflows/pr-agent-signal.yml',
      repository: repo, head_repository: repo, head_sha: env.EVENT_HEAD ?? head,
      pull_requests: [pull],
    },
  };
}

async function execute(action, env) {
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = signalEvent(env);
    Object.assign(event.workflow_run, env.SIGNAL_OVERRIDE ? JSON.parse(env.SIGNAL_OVERRIDE) : {});
    await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  }
  return runFile(process.execPath, [script, action], { env });
}

async function commentEvent(env, body) {
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({
    action: 'created', repository: { full_name: repository }, sender: maintainer,
    issue: { number: 42, pull_request: {} },
    comment: { id: 340, user: maintainer, author_association: 'COLLABORATOR', body },
  }));
  return { ...env, GITHUB_EVENT_NAME: 'issue_comment' };
}

async function capture(env) {
  await writeFile(env.GITHUB_OUTPUT, '');
  await execute('capture', env);
  const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
  if (!output) return {};
  return Object.fromEntries(output.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function submit(env, revision, review) {
  return execute('validate', {
    ...env,
    REVIEW_RESULT: review,
    REVIEWED_HEAD: revision.head,
    REVIEWED_BASE: revision.base,
    REVIEWED_BASE_REF: revision.base_ref,
    REVIEW_STARTED_AT: revision.started,
  });
}

function prioritizedReview(priority, issue = {}) {
  return JSON.stringify({
    merge_recommendation: 'changes_required',
    key_issues_to_review: [{
      relevant_file: 'src/example.js',
      issue_header: '[' + priority + '] [RIGHT] Count regression',
      issue_content: 'The default call now returns zero for a completed check.',
      start_line: 2,
      end_line: 2,
      ...issue,
    }],
  });
}

function reviewWrites(state) {
  return state.requests.filter(({ method, url }) => method !== 'GET' && url.startsWith('/repos/corp/example/pulls/42/reviews'));
}

function recordAutomaticRun(state, { number = 42, sha = head, runId = 12, ranReview = true, baseSha = base, ref = 'main' } = {}) {
  state.runs[runId] = {
    id: runId, event: 'workflow_run', conclusion: 'success', head_sha: 'f'.repeat(40),
    display_title: '洛神 · PR #' + number + ' ' + sha, pull_requests: [],
  };
  state.jobs[runId] = [{
    name: '洛神 (ubuntu-x64)', conclusion: 'success',
    steps: [{ name: 'Confirm completed automatic review ' + baseSha + ' ' + encodeURIComponent(ref),
      conclusion: ranReview ? 'success' : 'skipped' }],
  }];
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
    name: 'workflow_run',
    payload: { workflow_run: {
      event: 'pull_request', conclusion: 'success',
      head_repository: { full_name: 'corp/example' }, pull_requests: [{ number: 42 }],
    } },
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
  for (const invalid of [
    { conclusion: 'failure' },
    { event: 'workflow_dispatch' },
    { head_repository: { full_name: 'other/example' } },
    { pull_requests: [{}] },
  ]) {
    assert.equal(decide(enabled, {
      ...openedPullRequest,
      payload: { workflow_run: { ...openedPullRequest.payload.workflow_run, ...invalid } },
    }), false);
  }
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
  assert.match(signalWorkflow, /github\.event\.sender\.type != 'Bot' \|\| github\.event\.action == 'synchronize'/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__HANDLE_PUSH_TRIGGER: "true"/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_TRIGGER_IGNORE_BOT_COMMITS: "false"/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__PUSH_TRIGGER_IGNORE_MERGE_COMMITS: "false"/u);
  assert.match(settings, /handle_push_trigger = true/u);
  assert.match(settings, /push_commands = \["\/describe", "\/review"\]/u);
  assert.match(settings, /push_trigger_ignore_bot_commits = false/u);
  assert.match(settings, /push_trigger_ignore_merge_commits = false/u);
});

test('the pinned runner uses GPT-6.2 Sol directly with no model fallback', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(workflow, /^ {6}CONFIG__MODEL: "openai\/gpt-6\.2-sol"$/mu);
  assert.match(workflow, /^ {6}CONFIG__FALLBACK_MODELS: '\[\]'$/mu);
  assert.match(workflow, /^ {6}CONFIG__ADDITIONAL_REASONING_EFFORT_MODELS: "gpt-6\.2-sol"$/mu);
  assert.match(workflow, /^ {6}CONFIG__NO_TEMPERATURE_MODELS: "gpt-6\.2-sol"$/mu);
  for (const name of ['Run PR-Agent summary', 'Run PR-Agent']) {
    assert.match(stepDefinition(name), /^ {10}OPENAI__KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}$/mu);
  }
  assert.doesNotMatch(workflow, /OPENAI__API_BASE|OPENCODE_GO_API_KEY|x-opencode-session/u);
  assert.match(settings, /^model = "openai\/gpt-6\.2-sol"$/mu);
  assert.match(settings, /^fallback_models = \[\]$/mu);
  assert.match(settings, /^additional_reasoning_effort_models = \["gpt-6\.2-sol"\]$/mu);
  assert.match(settings, /^no_temperature_models = \["gpt-6\.2-sol"\]$/mu);
});

test('reviews use medium effort and cap input and generated tokens', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(workflow, /^ {6}CONFIG__CUSTOM_MODEL_MAX_TOKENS: "922000"$/mu);
  assert.match(workflow, /^ {6}CONFIG__MAX_MODEL_TOKENS: "64000"$/mu);
  assert.match(workflow, /^ {6}CONFIG__MAX_OUTPUT_TOKENS: "12000"$/mu);
  assert.match(workflow, /^ {6}CONFIG__REASONING_EFFORT: "medium"$/mu);
  assert.match(settings, /^custom_model_max_tokens = 922000$/mu);
  assert.match(settings, /^max_model_tokens = 64000$/mu);
  assert.match(settings, /^max_output_tokens = 12000$/mu);
  assert.match(settings, /^reasoning_effort = "medium"$/mu);
});

test('repository reviews publish findings inline by default', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  const reviewerSettings = settings.split(/^\[pr_reviewer\]$/mu)[1]?.split(/^\[/mu)[0] ?? '';
  assert.match(reviewerSettings, /^inline_key_issues = true$/mu);
  assert.match(stepDefinition('Run PR-Agent'), /PR_REVIEWER__INLINE_KEY_ISSUES: \$\{\{ steps\.revision\.outputs\.upstream_inline == 'true' \}\}/u);
});

test('automatic summaries use low effort, smaller budgets and skip review-only context', () => {
  const summary = stepDefinition('Run PR-Agent summary');
  assert.match(summary, /^ {10}CONFIG__REASONING_EFFORT: "low"$/mu);
  assert.match(summary, /^ {10}CONFIG__MAX_MODEL_TOKENS: "32000"$/mu);
  assert.match(summary, /^ {10}CONFIG__MAX_OUTPUT_TOKENS: "6000"$/mu);
  assert.match(summary, /^ {10}CONFIG__MAX_COMMITS_TOKENS: "-1"$/mu);
  assert.match(summary, /^ {10}CONFIG__REPO_CONTEXT_FILES: '\[\]'$/mu);
  assert.match(workflow, /^ {6}PR_DESCRIPTION__MAX_AI_CALLS: "2"$/mu);
});

test('manual describe commands select only the summary action', async () => {
  const actions = ['Run PR-Agent summary', 'Run PR-Agent'];
  const canRun = actions.map((name) => {
    const condition = /^ {8}if: \$\{\{ (.+) \}\}$/mu.exec(stepDefinition(name))?.[1];
    assert.ok(condition, `missing workflow condition for ${name}`);
    return new Function('github', 'steps', 'cancelled', `return Boolean(${condition});`);
  });
  const cases = [
    ['workflow_run', '', [true, true]],
    ['issue_comment', '/describe', [true, false]],
    ['issue_comment', '/describe\u00a0', [true, false]],
    ['issue_comment', '  /DESCRIBE_PR\n', [true, false]],
    ['issue_comment', '/review', [false, true]],
    ['issue_comment', '/review --pr_reviewer.inline_key_issues=true', [false, true]],
    ['issue_comment', '/ask what does /describe do?', [false, true]],
    ['issue_comment', `/ask ${longCommentText}`, [false, true]],
    ['issue_comment', '/describe_extra', [false, true]],
  ];
  await withGitHub(async ({ env }) => {
    for (const [event, body, expected] of cases) {
      const eventEnv = event === 'issue_comment' ? await commentEvent(env, body) : { ...env, EVENT_HEAD: head };
      const revision = await capture(eventEnv);
      const github = { event_name: event, event: { comment: { body } } };
      const steps = { revision: { outcome: 'success', outputs: revision } };
      assert.deepEqual(canRun.map((matches) => matches(github, steps, () => false)), expected, body.slice(0, 60) || event);
    }
  });
});

test('manual summary arguments are rejected before either model step can run', async () => {
  const commands = [
    '/describe --config.reasoning_effort=medium --config.max_output_tokens=12000',
    '/describe_pr --config.max_model_tokens=64000',
    '/describe --pr_description.max_ai_calls=5',
    '/describe --pr_description.enable_help_text=true',
    '/de"scribe" --config={max_output_tokens: 12000}',
    '/de\\scribe --config__max_output_tokens=12000',
    '\u0085/describe --config.reasoning_effort=medium',
  ];
  await withGitHub(async ({ env }) => {
    for (const command of commands) {
      const manual = await commentEvent(env, command);
      await assert.rejects(capture(manual), { stderr: /Error: Use \/describe or \/describe_pr without arguments/u });
      assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), '');
    }
  });
});

test('long comment bodies do not enter the runner environment and review validation still reads the command', async () => {
  const review = `/review ${longCommentText}`;
  assert.ok(Buffer.byteLength(review) > 128 * 1024);
  await withGitHub(async ({ env }) => {
    const manual = await commentEvent(env, review);
    const revision = await capture(manual);
    assert.equal(revision.head, head);
    await assert.rejects(submit(manual, revision, ''), /did not produce structured review output/u);
  });
  assert.doesNotMatch(workflow, /^ +[A-Z_]+: \$\{\{ github\.event\.comment\.body \}\}/mu);
});

test('large reviews use bounded chunking and show coverage gaps', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  const action = stepDefinition('Run PR-Agent');
  assert.match(action, /^ {10}PR_REVIEWER__ENABLE_LARGE_PR_CHUNKING: "true"$/mu);
  assert.match(action, /^ {10}PR_REVIEWER__MAX_NUMBER_OF_CALLS: "5"$/mu);
  assert.match(action, /^ {10}PR_REVIEWER__ENABLE_REVIEW_COVERAGE_FOOTER: "true"$/mu);
  assert.match(action, /^ {10}PR_REVIEWER__REQUIRE_PRIORITY_FILES: "true"$/mu);
  assert.match(workflow, /^ {6}CONFIG__OUTPUT_RUN_DETAILS: "true"$/mu);
  assert.match(settings, /^enable_large_pr_chunking = true$/mu);
  assert.match(settings, /^max_number_of_calls = 5$/mu);
  assert.match(settings, /^enable_review_coverage_footer = true$/mu);
  assert.match(settings, /^require_priority_files = true$/mu);
  assert.match(settings, /^output_run_details = true$/mu);
});

test('provider retries are bounded and exhausted attempts fail the action', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(workflow, /^ {6}CONFIG__AI_TIMEOUT: "180"$/mu);
  assert.match(workflow, /^ {6}CONFIG__NUM_RETRIES: "1"$/mu);
  assert.match(workflow, /^ {6}CONFIG__RETRY_SAME_MODEL_ON_TIMEOUT: "false"$/mu);
  assert.match(workflow, /^ {6}CONFIG__PROPAGATE_TOOL_ERRORS: "true"$/mu);
  assert.match(workflow, /^ {6}GITHUB_ACTION_CONFIG__FAIL_ON_TOOL_ERRORS: "true"$/mu);
  assert.match(settings, /^ai_timeout = 180$/mu);
  assert.match(settings, /^retry_same_model_on_timeout = false$/mu);
  assert.match(settings, /^propagate_tool_errors = true$/mu);
});

test('a failing automatic summary still allows review and keeps the attempt failed', () => {
  for (const { summary, review, revision } of [
    { summary: 'Run PR-Agent summary', review: 'Run PR-Agent', revision: 'revision' },
    { summary: 'Retry PR-Agent summary', review: 'Retry PR-Agent', revision: 'retry_revision' },
  ]) {
    const summaryStep = stepDefinition(summary);
    const reviewStep = stepDefinition(review);
    assert.ok(summaryStep, `${summary} must run independently of ${review}`);
    assert.ok(workflow.indexOf(`- name: ${summary}\n`) < workflow.indexOf(`- name: ${review}\n`));
    assert.match(summaryStep, /github\.event_name == 'workflow_run'/u);
    assert.doesNotMatch(summaryStep, /continue-on-error:/u);
    const condition = /^ {8}if: \$\{\{ (.+) \}\}$/mu.exec(reviewStep)?.[1];
    assert.match(condition ?? '', /!cancelled\(\)/u);
    const canReview = new Function('cancelled', 'steps', `return (${condition});`);
    assert.equal(canReview(() => false, {
      [revision]: { outcome: 'success', outputs: { head } },
    }), true);
    assert.equal(canReview(() => false, {
      [revision]: { outcome: 'failure', outputs: { head } },
    }), false);
    assert.equal(canReview(() => false, {
      [revision]: { outcome: 'success', outputs: { head: '' } },
    }), false);
    assert.equal(canReview(() => true, {
      [revision]: { outcome: 'success', outputs: { head } },
    }), false);
  }
});

test('only PR lifecycle, target branch and commit changes signal automatic review', () => {
  const types = /^  pull_request:\n    types: \[([^\n]+)\]/mu.exec(signalWorkflow)?.[1].split(', ');
  assert.deepEqual(types, ['opened', 'reopened', 'ready_for_review', 'synchronize', 'edited']);
  assert.match(signalWorkflow, /github\.event\.action != 'edited' \|\| github\.event\.changes\.base != null/u);
  assert.match(signalWorkflow, /github\.event\.before != github\.event\.after/u);
  assert.match(workflow, /^  issue_comment:\n    types: \[created\]$/mu);
});

test('runs record the PR number and original head for exact review history lookup', () => {
  assert.match(workflow, /洛神 · PR #\$\{\{ github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| github\.event\.issue\.number \}\}/u);
  assert.match(workflow, /format\(' \{0\}', github\.event\.workflow_run\.head_sha\)/u);
});

test('signal scope checks canonical workflow, repository, PR and immutable head before any publication', async () => {
  await withGitHub(async ({ state, env }) => {
    const run = signalEvent(env).workflow_run;
    for (const override of [
      { path: '.github/workflows/other.yml' },
      { repository: { full_name: 'elsewhere/example' } },
      { pull_requests: [run.pull_requests[0], run.pull_requests[0]] },
      { pull_requests: [{ number: 42, url: 'https://example.net/untrusted' }] },
    ]) assert.deepEqual(await capture({ ...env, SIGNAL_OVERRIDE: JSON.stringify(override) }), {});
    assert.deepEqual(state.requests, []);

    state.pr.head.sha = 'c'.repeat(40);
    const stale = { pull_requests: [{ ...run.pull_requests[0], head: { sha: state.pr.head.sha } }] };
    assert.deepEqual(await capture({ ...env, SIGNAL_OVERRIDE: JSON.stringify(stale) }), {});
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('a completed workflow with a skipped signal never starts a model review', async () => {
  await withGitHub(async ({ state, env }) => {
    state.jobs[9001][0].conclusion = 'skipped';
    assert.deepEqual(await capture(env), {});
    assert.deepEqual(reviewWrites(state), []);
  });
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
    const manual = await commentEvent(env, '  /review');
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
    await assert.rejects(submit(await commentEvent(env, '  /review --some-option'), revision, ''));
    const incremental = await submit(await commentEvent(env, '/review -i'), revision, '');
    assert.match(incremental.stdout, /warning.*Incremental review.*output/iu);
    await submit(await commentEvent(env, '/ask a question'), revision, '');
    state.pr.title = '[Auto] ignored';
    await submit(env, revision, '');
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

test('automatic reviews and authorized review or RC comments share a queue', () => {
  const concurrency = /^concurrency:\n((?: {2}[^\n]*\n)+)/mu.exec(workflow)?.[1] ?? '';
  assert.match(concurrency, /^  queue: max$/mu);
  assert.doesNotMatch(concurrency, /cancel-in-progress:/u);
  const group = /^  group: (.+)$/mu.exec(concurrency)?.[1];
  assert.ok(group);
  const groupFor = (github) => group.replace(/\$\{\{ (.*?) \}\}/gu, (_, expression) =>
    new Function('github', 'contains', 'fromJSON', 'return (' + expression + ');')(
      github, (haystack, needle) => haystack.includes(needle), JSON.parse,
    ));
  const automatic = (number) => groupFor({
    event_name: 'workflow_run',
    event: { workflow_run: { pull_requests: [{ number }] }, issue: {} },
  });
  const comment = (body, association = 'OWNER', type = 'User') => groupFor({
    event_name: 'issue_comment',
    event: { workflow_run: { pull_requests: [{}] }, issue: { number: 42 },
      sender: { type }, comment: { body, author_association: association } },
  });
  assert.equal(comment('  /review'), automatic(42));
  assert.equal(comment('/request-changes P1 ' + head + ' ' + base + ' main'), automatic(42));
  assert.notEqual(automatic(43), automatic(42));
  assert.notEqual(comment('/review', 'CONTRIBUTOR'), automatic(42));
  assert.notEqual(comment('/review', 'MEMBER', 'Bot'), automatic(42));
});

test('the workflow validates empty output and only marks a verified revision complete', () => {
  const validator = stepDefinition('Validate PR-Agent review');
  assert.match(validator, /if: \$\{\{ !cancelled\(\) && steps\.revision\.outputs\.head != '' \}\}/u);
  assert.match(validator, /REVIEW_RESULT: \$\{\{ steps\.pr_agent\.outputs\.review \}\}/u);
  assert.match(workflow, /GITHUB_ACTION_CONFIG__ENABLE_OUTPUT: "true"/u);
  const completion = workflow.split('      - name: Confirm completed automatic review ')[1];
  const condition = /^        if: \$\{\{ (.*) \}\}$/mu.exec(completion)?.[1];
  assert.ok(condition);
  const records = (eventName, reviewKey, retry = '', refreshedKey = '') =>
    new Function('github', 'steps', 'return (' + condition + ');')({ event_name: eventName }, {
      validation: { outputs: { retry, review_key: reviewKey } },
      retry_validation: { outputs: { review_key: refreshedKey } },
    });
  assert.equal(records('workflow_run', 'review key'), true);
  assert.equal(records('workflow_run', '', 'true', 'refreshed key'), true);
  assert.equal(records('workflow_run', 'review key', 'true'), false);
  assert.equal(records('workflow_run', ''), false);
  assert.equal(records('issue_comment', 'review key'), false);
});

test('the workflow posts a persistent PR summary with a diagram before base settings are available', async () => {
  assert.match(workflow, /^ {6}PR_DESCRIPTION__PUBLISH_DESCRIPTION_AS_COMMENT: "true"$/mu);
  assert.match(workflow, /^ {6}PR_DESCRIPTION__PUBLISH_DESCRIPTION_AS_COMMENT_PERSISTENT: "true"$/mu);
  assert.match(workflow, /^ {6}PR_DESCRIPTION__ENABLE_PR_DIAGRAM: "true"$/mu);
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  const description = settings.split('[pr_description]\n')[1]?.split('\n[')[0] ?? '';
  assert.match(description, /^enable_pr_diagram = true$/mu);
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

test('the workflow retries both tools once with the same pinned image and validates the new revision', () => {
  const uses = /^ {8}uses: (\S+)/mu;
  const image = uses.exec(stepDefinition('Run PR-Agent'))?.[1] ?? '';
  assert.match(image, /^docker:\/\/pragent\/pr-agent@sha256:[0-9a-f]{64}$/u);
  const summary = stepDefinition('Run PR-Agent summary');
  const retrySummary = stepDefinition('Retry PR-Agent summary');
  const retry = stepDefinition('Retry PR-Agent');
  assert.match(stepDefinition('Capture refreshed PR revision'), /if: \$\{\{ steps\.validation\.outputs\.retry == 'true' \}\}/u);
  assert.equal(uses.exec(summary)?.[1], image);
  assert.equal(uses.exec(retrySummary)?.[1], image);
  assert.equal(uses.exec(retry)?.[1], image);
  assert.match(retrySummary, /env: \*pr_agent_summary_env/u);
  assert.match(retry, /env: \*pr_agent_env/u);
  const recheck = stepDefinition('Validate refreshed PR-Agent review');
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
    state.comments.length = 0;
    await assert.rejects(submit(env, revision, output), /summary and review were not both refreshed/u);
    const updated = new Date(Date.now() + 1000).toISOString();
    state.comments.push(...['pr-agent:describe:persistent', 'pr-agent:review:full'].map((marker) => ({
      user: { login: 'github-actions[bot]' }, updated_at: updated, body: `<!-- ${marker} -->`,
    })));
    await submit(env, revision, output);
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

test('manual review of a fork or deleted head repository skips both model steps', async () => {
  await withGitHub(async ({ state, env }) => {
    const manualReview = await commentEvent(env, '/review');
    for (const repo of [{ full_name: 'outside/fork' }, null]) {
      state.pr.head.repo = repo;
      assert.deepEqual(await capture(manualReview), {});
    }
    assert.ok(state.requests.every(({ method }) => method === 'GET'));
  });
});

test('a head repository that changes during a run does not change formal reviews', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.pr.head.repo.full_name = 'outside/fork';
    await submit(env, revision, prioritizedReview('P1'));
    assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  });
});

test('all four model priorities publish native COMMENT and never request changes', async () => {
  for (const [index, priority] of ['P0', 'P1', 'P2', 'P3'].entries()) {
    await withGitHub(async ({ state, env }) => {
      const reviewEnv = index % 2 ? await commentEvent(env, '/review') : env;
      const revision = await capture(reviewEnv);
      const output = JSON.parse(prioritizedReview(priority));
      Object.assign(output, { priority: 'P0', matches_claim: true, event: 'REQUEST_CHANGES' });
      await submit(reviewEnv, revision, JSON.stringify(output));
      const [write, ...other] = reviewWrites(state);
      assert.deepEqual(other, []);
      assert.equal(write?.body.event, 'COMMENT');
      assert.equal(write.body.commit_id, revision.head);
      assert.equal(write.body.comments[0].side, 'RIGHT');
      assert.match(write.body.comments[0].body, /Count regression/u);
    });
  }
});

test('a modified-file deletion publishes an explicitly scoped LEFT comment', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.files[0].patch = '@@ -1,2 +1 @@\n function count() {\n-  runRequiredCheck();';
    const output = prioritizedReview('P2', {
      issue_header: '[P2] [LEFT 2-2] Required check removed', start_line: 0, end_line: 0,
    });
    await submit(env, revision, output);
    const [write] = reviewWrites(state);
    assert.equal(write?.body.event, 'COMMENT');
    assert.deepEqual(write.body.comments.map(({ path, line, side }) => ({ path, line, side })),
      [{ path: 'src/example.js', line: 2, side: 'LEFT' }]);
  });
});

test('ambiguous findings stay in the already published summary', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    for (const issue of [
      { issue_header: '[P1] Unspecified side' },
      { end_line: 4 },
      { relevant_file: 'src/absent.js' },
      { issue_content: '' },
    ]) await submit(env, revision, prioritizedReview('P1', issue));
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('a manual review with arguments stays on the upstream command path', async () => {
  await withGitHub(async ({ state, env }) => {
    for (const command of ['/review -i', '/review --pr_reviewer.extra_instructions=override']) {
      const manual = await commentEvent(env, command);
      const revision = await capture(manual);
      assert.equal(revision.upstream_inline, 'true');
      await submit(manual, revision, prioritizedReview('P1'));
    }
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('a quoted or uppercase review command without options uses the same side-aware publisher', async () => {
  await withGitHub(async ({ state, env }) => {
    const manual = await commentEvent(env, '/"ReVIEW"');
    const revision = await capture(manual);
    assert.equal(revision.upstream_inline, 'false');
    await submit(manual, revision, prioritizedReview('P3'));
    assert.equal(reviewWrites(state)[0]?.body.event, 'COMMENT');
  });
});

test('retries reuse exactly matching comments already posted by the bot to this head', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    const output = prioritizedReview('P1');
    await submit(env, revision, output);
    state.inlineComments.unshift(...Array.from({ length: 100 }, () =>
      ({ ...state.inlineComments[0], user: { login: 'other-person' } })));
    await submit(env, revision, output);
    assert.equal(reviewWrites(state).length, 1);
    assert.ok(state.requests.some(({ url }) => url.endsWith('/comments?per_page=100&page=2')));
  });
});

test('a head push while reading comment history prevents publication to the old revision', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.headAfterInlineList = 'c'.repeat(40);
    await assert.rejects(submit(env, revision, prioritizedReview('P1')), /PR revision changed during review/u);
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('only an authenticated standalone maintainer command can post a native change request', async () => {
  await withGitHub(async ({ state, env }) => {
    const manual = await commentEvent(env, '/request-changes P1 ' + head + ' ' + base + ' main');
    state.permission = 'read';
    await assert.rejects(capture(manual), /cannot request changes/u);
    assert.deepEqual(reviewWrites(state), []);
    state.permission = 'write';
    assert.deepEqual(await capture(manual), {});
    assert.equal(state.reviews[0].state, 'CHANGES_REQUESTED');
    assert.doesNotMatch(state.reviews[0].body, /尚待确认/u);
    assert.match(state.reviews[0].body, /仓库维护者/u);
    await capture({ ...manual, GITHUB_RUN_ATTEMPT: '2' });
    assert.equal(reviewWrites(state).filter(({ method }) => method === 'POST').length, 1);
  });
});

test('a clean model review does not dismiss an earlier formal review', async () => {
  await withGitHub(async ({ state, env }) => {
    const earlier = { id: 100, state: 'CHANGES_REQUESTED', user: { login: 'github-actions[bot]' },
      commit_id: head, body: '<!-- heluo-forge-pr-agent-priority-rc:v1 ' + head + ' ' + base + ' -->' };
    state.reviews.push(earlier);
    await submit(env, await capture(env), '{"merge_recommendation":"no_concerns_found"}');
    assert.deepEqual(reviewWrites(state), []);
    assert.equal(earlier.state, 'CHANGES_REQUESTED');
  });
});

test('PR lifecycle events and pushes run the summary and review in separate steps', async () => {
  const settings = await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8');
  assert.match(settings, /push_commands = \["\/describe", "\/review"\]/u);
  assert.match(settings, /publish_description_as_comment_persistent = true/u);
  const summary = stepDefinition('Run PR-Agent summary');
  const review = stepDefinition('Run PR-Agent');
  assert.match(summary, /GITHUB_ACTION_CONFIG__AUTO_DESCRIBE: "true"/u);
  assert.match(summary, /GITHUB_ACTION_CONFIG__AUTO_REVIEW: "false"/u);
  assert.match(summary, /GITHUB_ACTION_CONFIG__PUSH_COMMANDS: "\/describe"/u);
  assert.match(review, /GITHUB_ACTION_CONFIG__AUTO_DESCRIBE: "false"/u);
  assert.match(review, /GITHUB_ACTION_CONFIG__AUTO_REVIEW: "true"/u);
  assert.match(review, /GITHUB_ACTION_CONFIG__PUSH_COMMANDS: "\/review"/u);
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
    state.comments = [...Array.from({ length: 100 }, () => fresh('unrelated')), summary, review];
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
