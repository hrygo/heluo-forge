import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const examplePatch = '@@ -1,2 +1,2 @@\n function count() {\n-  return 1;\n+  return 0;';
const exampleDiff = 'diff --git a/src/example.js b/src/example.js\nindex e652251..1843a8d 100644\n' +
  '--- a/src/example.js\n+++ b/src/example.js\n' + examplePatch + '\n';

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
const approver = { id: 789, login: 'luoshen[bot]', type: 'Bot' };
const actionsBot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const usersPath = '/users';
const ownerFile = '.github/CODEOWNERS';
const ownerBlob = 'd'.repeat(40);
const owners = Buffer.from('* @maintainer\n');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const approvalEnv = {
  PR_AGENT_AUTO_APPROVE: 'true',
  PR_AGENT_APPROVAL_CONFIGURED: 'true',
  PR_AGENT_APPROVAL_APP_SLUG: 'luoshen',
  PR_AGENT_APPROVAL_EXPECTED_APP_SLUG: 'luoshen',
  PR_AGENT_HUMAN_CODEOWNERS: 'maintainer',
};

function freshComment(marker) {
  return { user: { login: 'github-actions[bot]' }, updated_at: new Date(Date.now() + 1000).toISOString(),
    body: '<!-- ' + marker + ' -->' };
}

async function withGitHub(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-agent-review-'));
  const eventPath = join(directory, 'event.json');
  const state = {
    pr: { number: 42, state: 'open', draft: false, title: 'Example pull request', changed_files: 1,
      user: { id: 775, login: 'contributor', type: 'User' },
      head: { sha: head, repo: { full_name: repository } }, base: { sha: base, ref: 'main', repo: { full_name: repository } } },
    refs: { main: base },
    refStatus: 200,
    filesStatus: 200,
    diffStatus: 200,
    diffType: 'application/vnd.github.diff; charset=utf-8',
    diff: exampleDiff,
    diffReads: 0,
    codeOwners: owners,
    reviewHistoryStatus: 200,
    approvalIdentityStatus: 200,
    installationStatus: 200,
    transientReviewHistoryFailures: 0,
    disconnectReviewHistory: false,
    inlineCommentsStatus: 200,
    persistentCommentsStatus: 200,
    approvalProtection: { enforce_admins: { enabled: true }, required_pull_request_reviews: {
      require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1,
      require_last_push_approval: false,
    } },
    approvalRules: [],
    compareStatus: 200,
    threads: [],
    threadStatus: 200,
    checkRuns: [],
    requests: [],
    approvalBot: approver,
    postStatus: 200,
    permission: 'write',
    files: [{ filename: 'src/example.js', status: 'modified', additions: 1, deletions: 1, patch: examplePatch }],
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
    if (request.headers.authorization === 'Bearer approval-test-token') {
      (state.approverRequests ??= []).push({ method: request.method, url: request.url });
    }
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/^\/repos\/corp\/example/u, '');
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageOf = (items) => items.slice((page - 1) * 100, page * 100);
    if (request.method === 'POST' && path === '/graphql') {
      response.statusCode = state.threadStatus;
      const threads = state.threadPages?.[body.variables.after ?? 'first'] ??
        { nodes: state.threads, pageInfo: { hasNextPage: false, endCursor: null } };
      response.end(JSON.stringify({ data: { repository: { pullRequest: {
        number: 42, headRefOid: state.pr.head.sha, author: { login: state.pr.user.login },
        reviewThreads: threads,
      } } }, errors: state.threadErrors }));
    } else if (request.method === 'GET' && path === `${usersPath}/${encodeURIComponent(state.approvalBot.login)}`) {
      response.statusCode = state.approvalIdentityStatus;
      response.end(JSON.stringify(state.approvalBot));
    } else if (request.method === 'GET' && path === '/installation/repositories') {
      response.statusCode = state.installationStatus;
      response.end(JSON.stringify({ total_count: 1, repositories: [{ full_name: repository }] }));
    } else if (request.method === 'GET' && path === '/branches/main/protection') {
      response.end(JSON.stringify(state.approvalProtection));
    } else if (request.method === 'GET' && path === '/rules/branches/main') {
      response.end(JSON.stringify(pageOf(state.approvalRules)));
    } else if (request.method === 'GET' && path === '/contents/.github') {
      response.end(JSON.stringify([{ path: ownerFile, type: 'file', sha: ownerBlob }]));
    } else if (request.method === 'GET' && path === '/contents/.github/CODEOWNERS') {
      response.end(JSON.stringify({ path: ownerFile, type: 'file', sha: ownerBlob, encoding: 'base64',
        size: state.codeOwners.length, content: state.codeOwners.toString('base64') }));
    } else if (request.method === 'GET' && path === '/codeowners/errors') {
      response.end(JSON.stringify({ errors: [] }));
    } else if (request.method === 'GET' && path === '/pulls' && url.searchParams.get('state') === 'open') {
      const target = url.searchParams.get('base');
      response.end(JSON.stringify(pageOf(!target || state.pr.base.ref === target ? [state.pr] : [])));
    } else if (request.method === 'GET' && path === '/pulls/42') {
      if (request.headers.accept === 'application/vnd.github.diff') {
        state.diffReads++;
        response.statusCode = state.diffStatus;
        response.setHeader('content-type', state.diffType);
        response.end(state.diff);
        if (state.baseAfterDiff) state.refs.main = state.baseAfterDiff;
      } else {
        response.end(JSON.stringify(state.pr));
      }
    } else if (request.method === 'GET' && path.startsWith('/git/ref/heads/')) {
      const ref = decodeURIComponent(path.slice('/git/ref/heads/'.length));
      response.statusCode = state.refStatus === 200 && !(ref in state.refs) ? 404 : state.refStatus;
      response.end(JSON.stringify(state.refResponse ?? { ref: 'refs/heads/' + ref, object: { type: 'commit', sha: state.refs[ref] } }));
    } else if (request.method === 'GET' && /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/u.test(path)) {
      response.statusCode = state.compareStatus;
      if (request.headers.accept === 'application/vnd.github.diff' && state.compareDiff) {
        response.setHeader('content-type', state.diffType);
        response.end(state.compareDiff);
      } else {
        response.end(JSON.stringify(state.compareResponse ?? { status: 'ahead', base_commit: { sha: path.split('/').at(-1).split('...')[0] }, files: [] }));
      }
    } else if (request.method === 'GET' && /^\/commits\/[a-f0-9]{40}\/check-runs$/u.test(path)) {
      response.end(JSON.stringify({ total_count: state.checkRuns.length, check_runs: pageOf(state.checkRuns) }));
    } else if (request.method === 'GET' && path === '/pulls/42/files') {
      response.statusCode = state.filesStatus;
      response.end(JSON.stringify(pageOf(state.files)));
    } else if (request.method === 'GET' && path === '/pulls/42/comments') {
      response.statusCode = state.inlineCommentsStatus;
      response.end(JSON.stringify(pageOf(state.inlineComments)));
      if (state.headAfterInlineList) state.pr.head.sha = state.headAfterInlineList;
    } else if (request.method === 'GET' && path === '/pulls/42/reviews') {
      if (state.disconnectReviewHistory) {
        state.disconnectReviewHistory = false;
        request.socket.destroy();
        return;
      }
      response.statusCode = state.transientReviewHistoryFailures > 0 ? 503 : state.reviewHistoryStatus;
      if (state.transientReviewHistoryFailures > 0) state.transientReviewHistoryFailures--;
      response.end(JSON.stringify(pageOf(state.reviews)));
    } else if (request.method === 'GET' && /^\/pulls\/42\/reviews\/\d+$/u.test(path)) {
      const review = state.reviews.find(({ id }) => id === Number(path.split('/').at(-1)));
      response.end(JSON.stringify(review ?? {}));
    } else if (request.method === 'GET' && path === '/issues/42/comments') {
      response.statusCode = state.persistentCommentsStatus;
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
      const event = url.searchParams.get('event');
      const status = url.searchParams.get('status');
      const runs = Object.values(state.runs).filter((run) => (!event || run.event === event) && (!status || run.conclusion === status));
      response.end(JSON.stringify({ workflow_runs: pageOf(runs), total_count: runs.length }));
    } else if (request.method === 'GET' && /^\/actions\/runs\/\d+\/jobs$/u.test(path)) {
      const jobs = state.jobs[path.split('/').at(-2)] ?? [];
      response.end(JSON.stringify({ total_count: jobs.length, jobs: pageOf(jobs) }));
    } else if (request.method === 'GET' && /^\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/u.test(path)) {
      const [, , , runId, , runAttempt] = path.split('/');
      const jobs = state.attemptJobs?.[`${runId}/${runAttempt}`] ?? [{ name: '洛神自动批准 (ubuntu-x64)', run_id: Number(runId), run_attempt: Number(runAttempt),
        status: 'completed', steps: [{ name: 'Reconcile or approve the reviewed PR revision',
          status: 'completed', conclusion: 'success' }] }];
      response.end(JSON.stringify({ total_count: jobs.length, jobs: pageOf(jobs) }));
    } else if (request.method === 'POST' && path === '/pulls/42/reviews') {
      response.statusCode = state.postStatus;
      const review = {
        id: 101 + state.reviews.length,
        state: { APPROVE: 'APPROVED', COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[body.event],
        commit_id: body.commit_id,
        user: request.headers.authorization === 'Bearer approval-test-token' ? state.approvalBot : actionsBot,
        body: body.body,
      };
      if (state.postStatus < 300) {
        state.reviews.push(review);
        state.inlineComments.push(...(body.comments ?? []).map((comment) =>
          ({ ...comment, user: review.user, commit_id: body.commit_id })));
        if (state.disconnectWithdrawalPost && body.body?.includes('approval-withdrawal:v2')) {
          state.disconnectWithdrawalPost = false;
          request.socket.destroy();
          return;
        }
      }
      response.end(JSON.stringify(review));
    } else if (request.method === 'PUT' && /^\/pulls\/42\/reviews\/\d+$/u.test(path)) {
      const id = Number(path.split('/').at(-1));
      const review = state.reviews.find((candidate) => candidate.id === id);
      if (review) review.body = body.body;
      response.end(JSON.stringify(review ?? {}));
    } else if (request.method === 'PUT' && /^\/pulls\/42\/reviews\/\d+\/dismissals$/u.test(path)) {
      const id = Number(path.split('/').at(-2));
      const review = state.reviews.find((candidate) => candidate.id === id);
      if (review && body.event === 'DISMISS') review.state = 'DISMISSED';
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
    GITHUB_GRAPHQL_URL: 'http://127.0.0.1:' + server.address().port + '/graphql',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: repository,
    GITHUB_OUTPUT: join(directory, 'output'),
    GITHUB_EVENT_PATH: eventPath,
    PR_AGENT_COVERAGE_PATH: join(directory, 'review-coverage.json'),
    PR_AGENT_COVERAGE_INVOCATION: 'initial',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_REF: 'refs/heads/main',
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
  } else if (env.GITHUB_EVENT_NAME === 'push') {
    await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({
      ref: env.PUSH_EVENT_REF ?? 'refs/heads/main', deleted: false, repository: { full_name: repository },
    }));
  } else if (env.GITHUB_EVENT_NAME === 'branch_protection_rule') {
    await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({
      action: env.PROTECTION_EVENT_ACTION ?? 'edited',
      repository: { full_name: env.PROTECTION_EVENT_REPO ?? repository },
    }));
  } else if (env.GITHUB_EVENT_NAME === 'schedule') {
    await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({ schedule: '17 * * * *' }));
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

function cleanReview(overrides = {}) {
  return JSON.stringify({
    merge_recommendation: 'no_concerns_found',
    security_concerns: 'No\n',
    key_issues_to_review: [],
    ...overrides,
  });
}

async function approvalRevision(env, revision, review, evidence = {}) {
  await writeFile(env.GITHUB_OUTPUT, '');
  if (evidence === null) {
    await rm(env.PR_AGENT_COVERAGE_PATH, { force: true });
  } else {
    await writeFile(env.PR_AGENT_COVERAGE_PATH, JSON.stringify({
      version: 1, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, invocation: env.PR_AGENT_COVERAGE_INVOCATION,
      pr: { provider: 'github', number: 42, repo: repository, head: revision.head, base: revision.base, baseRef: revision.base_ref },
      review: JSON.parse(review),
      files: [{ path: 'src/example.js', left: digest('2\t  return 1;\n'), right: digest('2\t  return 0;\n') }],
      ...evidence,
    }) + '\n');
  }
  await submit(env, revision, review);
  const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
  const line = output.split('\n').find((item) => item.startsWith('approval_revision='));
  return line ? JSON.parse(line.slice('approval_revision='.length)) : undefined;
}

test('the approval credential is available only in the trusted, protected approval job', () => {
  const approvalJob = workflow.split('\n  approve:\n')[1] ?? '';
  assert.match(workflow, /^  push:\n    branches: \[main\]$/mu);
  assert.match(workflow, /^  branch_protection_rule:\n    types: \[created, edited, deleted\]$/mu);
  assert.match(workflow, /^  schedule:\n    - cron: '17 \* \* \* \*'$/mu);
  assert.match(approvalJob, /^    needs: review$/mu);
  assert.match(approvalJob, /vars\.PR_AGENT_AUTO_APPROVE == 'true'/u);
  assert.match(approvalJob, /vars\.PR_AGENT_APPROVAL_APP_CLIENT_ID != ''/u);
  assert.match(approvalJob, /github\.event_name == 'schedule' \|\|\s+\(needs\.review\.outputs\.approval_revision != ''/u);
  assert.match(approvalJob, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(approvalJob, /needs\.review\.outputs\.approval_revision != ''/u);
  assert.match(approvalJob, /^    environment: luoshen-approval$/mu);
  assert.match(approvalJob, /^    permissions:\n      actions: read\n      contents: read\n      pull-requests: read$/mu);
  assert.match(approvalJob, /ref: \$\{\{ github\.sha \}\}\n\s+persist-credentials: false/u);
  assert.doesNotMatch(approvalJob, /docker:|OPENAI|download-artifact/u);
  assert.equal((workflow.match(/secrets\.PR_AGENT_APPROVAL_APP_PRIVATE_KEY/gu) ?? []).length, 1);
  assert.doesNotMatch(workflow, /secrets\.PR_AGENT_APPROVAL_TOKEN/u);
  assert.match(approvalJob, /actions\/create-github-app-token@[a-f0-9]{40}/u);
  assert.match(approvalJob, /permission-pull-requests: write\n\s+permission-administration: read/u);
  assert.match(approvalJob, /PR_AGENT_HUMAN_CODEOWNERS: \$\{\{ vars\.PR_AGENT_HUMAN_CODEOWNERS \}\}/u);
  const approvalStep = stepDefinition('Reconcile or approve the reviewed PR revision');
  assert.match(approvalStep, /PR_AGENT_APPROVAL_TOKEN: \$\{\{ steps\.approval_app\.outputs\.token \}\}/u);
  assert.match(approvalStep, /PR_AGENT_APPROVAL_APP_SLUG: \$\{\{ steps\.approval_app\.outputs\.app-slug \}\}/u);
  assert.match(approvalStep, /PR_AGENT_APPROVAL_EXPECTED_APP_SLUG: \$\{\{ vars\.PR_AGENT_APPROVAL_EXPECTED_APP_SLUG \}\}/u);
  assert.match(stepDefinition('Run PR-Agent'), /args: \/github\/workspace\/scripts\/pr-agent-coverage\.py/u);
  assert.match(stepDefinition('Run PR-Agent'), /PR_AGENT_COVERAGE_PATH: [^\n]+\.pr-agent-coverage-/u);
  assert.match(stepDefinition('Validate PR-Agent review'), /PR_AGENT_COVERAGE_PATH: [^\n]+-initial\.json/u);
  assert.match(stepDefinition('Validate refreshed PR-Agent review'), /PR_AGENT_COVERAGE_PATH: [^\n]+-retry\.json/u);
});

test('the review job fails only for publication failure from the effective validation step', () => {
  const output = /^ {6}publication_failed: \$\{\{ (.*) \}\}$/mu.exec(workflow)?.[1];
  const report = stepDefinition('Report incomplete review publication');
  const condition = /^ {8}if: \$\{\{ (.*) \}\}$/mu.exec(report)?.[1];
  assert.ok(output);
  assert.ok(condition);
  assert.match(report, /^ {10}exit 1$/mu);
  const jobOutput = new Function('steps', `return (${output});`);
  const failJob = new Function('steps', 'cancelled', `return (${condition});`);
  for (const [retry, first, second, failed] of [
    ['', '', '', false], ['', '', 'true', false], ['', 'true', '', true],
    ['true', 'true', '', false], ['true', '', 'true', true],
  ]) {
    const steps = {
      validation: { outputs: { retry, publication_failed: first } },
      retry_validation: { outputs: { publication_failed: second } },
    };
    assert.equal(jobOutput(steps) === 'true', failed);
    assert.equal(failJob(steps, () => false), failed);
    assert.equal(failJob(steps, () => true), false);
  }
});

test('a failed review job only forwards an explicit publication failure for withdrawal', () => {
  const approvalJob = workflow.split('\n  approve:\n')[1] ?? '';
  const condition = /^ {4}if: >-\n((?: {6}.*\n)+)/mu.exec(approvalJob)?.[1];
  const mint = stepDefinition('Mint the dedicated Luoshen approval token');
  const mintCondition = /^ {8}if: \$\{\{ (.*) \}\}$/mu.exec(mint)?.[1];
  assert.ok(condition);
  assert.ok(mintCondition);
  const approves = new Function('github', 'needs', 'vars', 'cancelled', 'fromJSON', `return (${condition});`);
  const mints = new Function('github', 'needs', 'fromJSON', `return (${mintCondition});`);
  const github = { ref: 'refs/heads/main', event_name: 'issue_comment', run_attempt: '2' };
  const needs = (result, publication_failed, allowApproval, runAttempt = '2') => ({ review: { result, outputs: {
    publication_failed, approval_revision: allowApproval === undefined ? '' : JSON.stringify({ allowApproval, runAttempt }),
  } } });
  const runs = (input, enabled = true, cancelled = false) => approves(github, input, {
    PR_AGENT_APPROVAL_APP_CLIENT_ID: 'app-id', PR_AGENT_AUTO_APPROVE: String(enabled),
  }, () => cancelled, JSON.parse);

  assert.equal(runs(needs('failure', 'true', false), false), true);
  assert.equal(runs(needs('failure', 'true', true)), false);
  assert.equal(runs(needs('failure', '', false)), false);
  assert.equal(runs(needs('failure', 'true')), false);
  assert.equal(runs(needs('failure', 'true', false), true, true), false);
  assert.equal(runs(needs('success', '', false), false), true);
  assert.equal(runs(needs('success', '', true)), true);
  assert.equal(runs(needs('success', 'true', true)), false);
  assert.equal(runs(needs('success', '', true), false), false);
  assert.equal(runs(needs('success', '', true, '1')), false);
  const staleWithdrawal = needs('failure', 'true', false, '1');
  assert.equal(runs(staleWithdrawal), true);
  assert.equal(mints(github, staleWithdrawal, JSON.parse), false);
  assert.equal(mints(github, needs('failure', 'true', false), JSON.parse), true);
});

test('a complete automatic or bare review with zero findings or P3 only emits an approval for that revision', async () => {
  await withGitHub(async ({ state, env }) => {
    const automatic = { ...env, ...approvalEnv };
    const expected = { prNumber: 42, head, base, baseRef: 'main', allowApproval: true,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
    assert.deepEqual(await approvalRevision(automatic, await capture(automatic), cleanReview()), expected);
    const manual = await commentEvent(automatic, '/review');
    const issue = JSON.parse(prioritizedReview('P3')).key_issues_to_review[0];
    assert.deepEqual(await approvalRevision(manual, await capture(manual),
      cleanReview({ key_issues_to_review: [issue] })), expected);
    assert.deepEqual(reviewWrites(state), []);
    assert.equal(state.approverRequests, undefined);
  });
});

test('a severe, ambiguous, or capped finding list does not emit an approval', async () => {
  await withGitHub(async ({ env }) => {
    const mode = { ...env, ...approvalEnv };
    const revision = await capture(mode);
    const finding = (priority) => JSON.parse(prioritizedReview(priority)).key_issues_to_review[0];
    for (const overrides of [
      ...['P0', 'P1', 'P2', 'P4'].map((priority) => ({ key_issues_to_review: [finding(priority)] })),
      { key_issues_to_review: undefined },
      { key_issues_to_review: 'No issues' },
      { key_issues_to_review: [null] },
      { key_issues_to_review: [{ ...finding('P3'), issue_header: '[P3] [P1] Ambiguous priority' }] },
      { key_issues_to_review: Array.from({ length: 10 }, () => finding('P3')) },
      { merge_recommendation: 'needs_review' },
      { security_concerns: 'A concern needs verification' },
      { security_concerns: undefined },
    ]) {
      assert.equal(await approvalRevision(mode, revision, cleanReview(overrides)), undefined, JSON.stringify(overrides));
    }
  });
});

test('only a fresh complete review can emit an approval, independently of comment publication', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv };
    const manual = await commentEvent(mode, '/review');
    const revision = await capture(manual);
    // A refreshed public comment cannot substitute for this invocation's missing or mismatched file output.
    for (const evidence of [
      null,
      { version: undefined, markdown: 'No coverage warnings' },
      { review: JSON.parse(prioritizedReview('P1')) },
      { pr: { provider: 'github', number: 42, repo: repository, head: 'c'.repeat(40), base, baseRef: 'main' } },
      { pr: { provider: 'github', number: 43, repo: repository, head, base, baseRef: 'main' } },
      { invocation: 'retry' },
      { runAttempt: '2' },
      { files: [] },
    ]) {
      assert.equal(await approvalRevision(manual, revision, cleanReview(), evidence), undefined);
    }
    assert.equal(await approvalRevision({ ...manual, PR_AGENT_AUTO_APPROVE: '' }, revision, cleanReview()), undefined);
    const configuredReview = await commentEvent(mode, '/review --pr_reviewer.num_max_findings=1');
    assert.equal(await approvalRevision(configuredReview, revision, cleanReview()), undefined);
    await commentEvent(mode, '/review');
    state.pr.draft = true;
    assert.equal(await approvalRevision(manual, revision, cleanReview()), undefined);
    state.pr.draft = false;
    state.pr.user = approver;
    assert.equal(await approvalRevision(manual, revision, cleanReview()), undefined);
  });
});

test('a complete scoped review with approval disabled or a draft still cannot authorize approval', async (t) => {
  for (const scenario of ['approval disabled', 'draft']) await t.test(scenario, async () => {
    await withGitHub(async ({ state, env }) => {
      const scoped = { ...env, ...approvalEnv, PR_AGENT_REVIEW_CONTEXT_PATH: env.GITHUB_OUTPUT + '.context' };
      if (scenario === 'approval disabled') scoped.PR_AGENT_AUTO_APPROVE = 'false';
      if (scenario === 'draft') state.pr.draft = true;
      const manual = await commentEvent(scoped, '/review');
      const revision = await capture(manual);
      state.comments.push(persistentReview(head, base));
      assert.equal(await approvalRevision(manual, revision, cleanReview()), undefined);
      assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^baseline_key=/mu);
      assert.deepEqual(reviewWrites(state), []);
    });
  });
});

test('an independently incomplete GitHub diff cannot authorize an approval', async () => {
  await withGitHub(async ({ state, env }) => {
    const manual = await commentEvent({ ...env, ...approvalEnv }, '/review');
    const revision = await capture(manual);
    const [original] = state.files;
    for (const files of [
      [],
      [{ ...original, patch: undefined }],
      [{ ...original, patch: '@@ -1,2 +1,2 @@\n function count() {\n-  return 1;' }],
      [{ ...original, additions: 2 }],
    ]) {
      state.files = files;
      assert.equal(await approvalRevision(manual, revision, cleanReview()), undefined);
    }
    assert.equal(state.diffReads, 0);
  });
});

test('matching review text requires evidence that the file mode was unchanged', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv };
    const revision = await capture(mode);
    state.diff = exampleDiff.replace('index e652251..1843a8d 100644', 'old mode 100644\nnew mode 100755\nindex e652251..1843a8d');
    assert.equal(await approvalRevision(mode, revision, cleanReview()), undefined);
    assert.equal(state.diffReads, 1);
    assert.match(await readFile(mode.GITHUB_OUTPUT, 'utf8'), /^review_key=[a-f0-9]{40} main$/mu);

    state.diff = exampleDiff;
    assert.equal((await approvalRevision(mode, revision, cleanReview()))?.allowApproval, true);
    assert.equal(state.diffReads, 2);
  });
});

test('GitHub versioned diff responses can authorize an otherwise complete approval', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    state.diffType = 'application/vnd.github.v3.diff; charset=utf-8';
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    assert.equal(eligible?.allowApproval, true);
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['APPROVE']);
  });
});

test('an unlisted code owner blocks automatic approval for an otherwise eligible P3 review', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token', PR_AGENT_HUMAN_CODEOWNERS: 'another-owner' };
    const issue = JSON.parse(prioritizedReview('P3')).key_issues_to_review[0];
    const candidate = await approvalRevision(mode, await capture(mode), cleanReview({ key_issues_to_review: [issue] }));
    assert.equal(candidate?.allowApproval, true);
    const { stdout } = await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(candidate) });
    assert.match(stdout, /skipped-protection/u);
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('code owners limited to unrelated paths cannot authorize an APPROVE', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    state.codeOwners = Buffer.from('/docs/ @maintainer\n');
    const issue = JSON.parse(prioritizedReview('P3')).key_issues_to_review[0];
    const candidate = await approvalRevision(mode, await capture(mode), cleanReview({ key_issues_to_review: [issue] }));
    assert.equal(candidate?.allowApproval, true);
    const { stdout } = await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(candidate) });
    assert.match(stdout, /skipped-protection/u);
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('an effective ruleset requiring an additional approval prevents automatic approval', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    state.approvalRules = [{ type: 'pull_request', parameters: {
      required_approving_review_count: 2, require_last_push_approval: false,
    } }];
    const issue = JSON.parse(prioritizedReview('P3')).key_issues_to_review[0];
    const candidate = await approvalRevision(mode, await capture(mode), cleanReview({ key_issues_to_review: [issue] }));
    assert.equal(candidate?.allowApproval, true);
    const { stdout } = await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(candidate) });
    assert.match(stdout, /skipped-protection/u);
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('unavailable file-mode evidence preserves the completed review key without producing an approval', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv };
    const revision = await capture(mode);
    const issue = JSON.parse(prioritizedReview('P3')).key_issues_to_review[0];
    state.diffStatus = 503;
    assert.equal(await approvalRevision(mode, revision, cleanReview({ key_issues_to_review: [issue] })), undefined);
    assert.equal(state.diffReads, 1);
    assert.deepEqual(reviewWrites(state), []);
    assert.match(await readFile(mode.GITHUB_OUTPUT, 'utf8'), /^review_key=[a-f0-9]{40} main$/mu);

    state.diffStatus = 206;
    assert.equal(await approvalRevision(mode, revision, cleanReview()), undefined);
    state.diffStatus = 200;
    state.diffType = 'application/json';
    assert.equal(await approvalRevision(mode, revision, cleanReview()), undefined);
    assert.equal(state.diffReads, 3);
    assert.match(await readFile(mode.GITHUB_OUTPUT, 'utf8'), /^review_key=[a-f0-9]{40} main$/mu);
  });
});

test('a target branch change while obtaining file-mode evidence causes a retry', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_ALLOW_RETRY: 'true' };
    for (const status of [200, 503]) {
      state.refs.main = base;
      const revision = await capture(mode);
      state.baseAfterDiff = 'c'.repeat(40);
      state.diffStatus = status;
      assert.equal(await approvalRevision(mode, revision, cleanReview()), undefined);
      assert.equal(await readFile(mode.GITHUB_OUTPUT, 'utf8'), 'retry=true\n');
    }
    assert.equal(state.diffReads, 2);
  });
});

test('a favorable review without coverage proof preserves an existing approval while P1 still withdraws it', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const revision = await capture(mode);
    const approved = await approvalRevision(mode, revision, cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(approved) });
    state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });

    const next = { ...mode, GITHUB_RUN_ID: '12346' };
    const captured = await capture(next);
    for (const [endpoint, coverage] of [['diffStatus', {}], ['filesStatus', {}], [undefined, null]]) {
      if (endpoint) state[endpoint] = 503;
      const requestStart = state.requests.length;
      assert.equal(await approvalRevision(next, captured, cleanReview(), coverage), undefined, endpoint);
      assert.match(await readFile(next.GITHUB_OUTPUT, 'utf8'), /^review_key=[a-f0-9]{40} main$/mu);
      assert.ok(!state.requests.slice(requestStart).some(({ url }) => url.includes('/pulls/42/reviews')));
      if (endpoint) state[endpoint] = 200;
    }
    assert.deepEqual(state.reviews.map(({ state }) => state), ['APPROVED', 'APPROVED']);

    state.filesStatus = 503;
    const pending = await approvalRevision(next, captured, prioritizedReview('P1'));
    assert.equal(pending?.allowApproval, false);
    assert.match(await readFile(next.GITHUB_OUTPUT, 'utf8'), /^publication_failed=true$/mu);
    await execute('approve', { ...next, APPROVAL_REVISION: JSON.stringify(pending) });
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED', 'COMMENTED']);
  });
});

test('inline comment failures preserve a P1 review conclusion and withdraw only the Luoshen approval', async (t) => {
  for (const endpoint of ['filesStatus', 'inlineCommentsStatus', 'postStatus']) {
    await t.test(endpoint, () => withGitHub(async ({ state, env }) => {
      const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
      const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
      await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
      state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });

      const next = { ...mode, GITHUB_RUN_ID: '12346' };
      const captured = await capture(next);
      state[endpoint] = 503;
      const pending = await approvalRevision(next, captured, prioritizedReview('P1'));
      assert.equal(pending?.allowApproval, false);
      const output = await readFile(next.GITHUB_OUTPUT, 'utf8');
      assert.match(output, /^publication_failed=true$/mu);
      assert.doesNotMatch(output, /^(?:review_key|retry)=/mu);

      const { stdout } = await execute('approve', { ...next, APPROVAL_REVISION: JSON.stringify(pending) });
      assert.match(stdout, /dismissed-ineligible/u);
      const expected = ['DISMISSED', 'APPROVED'];
      if (endpoint !== 'postStatus') expected.push('COMMENTED');
      assert.deepEqual(state.reviews.map(({ state }) => state), expected);
    }));
  }
});

test('a bare /review reports an inline POST failure while preserving the summary and withdrawal', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });
    const summary = structuredClone(state.comments);

    const manual = await commentEvent({ ...mode, GITHUB_RUN_ID: '12346' }, '/review');
    const captured = await capture(manual);
    state.postStatus = 503;
    const withdrawal = await approvalRevision(manual, captured, prioritizedReview('P1'));
    assert.deepEqual(withdrawal, { prNumber: 42, head, base, baseRef: 'main', allowApproval: false,
      runId: manual.GITHUB_RUN_ID, runAttempt: manual.GITHUB_RUN_ATTEMPT });
    const output = await readFile(manual.GITHUB_OUTPUT, 'utf8');
    assert.match(output, /^publication_failed=true$/mu);
    assert.doesNotMatch(output, /^(?:review_key|retry)=/mu);
    assert.deepEqual(state.comments, summary);
    assert.deepEqual(state.inlineComments, []);

    const result = await execute('approve', { ...manual, APPROVAL_REVISION: JSON.stringify(withdrawal) });
    assert.match(result.stdout, /dismissed-ineligible/u);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED']);
    const writes = reviewWrites(state);
    assert.deepEqual(writes.map(({ body }) => body.event ?? 'pending'), ['APPROVE', 'COMMENT', 'COMMENT', 'pending', 'DISMISS']);
    assert.match(writes[2].body.body, /approval-withdrawal:v2/u);
    assert.match(writes[3].body.body, /approval-dismissal-pending:v1/u);
  });
});

test('an optional finding does not try an inline POST or disrupt an existing approval', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });

    const next = { ...mode, GITHUB_RUN_ID: '12346' };
    const captured = await capture(next);
    const issue = JSON.parse(prioritizedReview('P3')).key_issues_to_review[0];
    state.postStatus = 503;
    assert.equal((await approvalRevision(next, captured, cleanReview({ key_issues_to_review: [issue] })))?.allowApproval, true);
    assert.doesNotMatch(await readFile(next.GITHUB_OUTPUT, 'utf8'), /publication_failed=/u);
    assert.deepEqual(state.inlineComments, []);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['APPROVED']);
  });
});

test('a current unfavorable verdict can withdraw an approval when summary verification fails', async (t) => {
  for (const scenario of ['HTTP 503', 'missing review marker', 'HTTP 503 with unavailable approval history']) {
    await t.test(scenario, () => withGitHub(async ({ state, env }) => {
      const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
      const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
      await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
      state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });

      const next = { ...mode, GITHUB_RUN_ID: '12346', PR_AGENT_AUTO_APPROVE: '' };
      const captured = await capture(next);
      if (scenario === 'missing review marker') state.comments = [freshComment('pr-agent:describe:persistent')];
      else state.persistentCommentsStatus = 503;
      if (scenario === 'HTTP 503 with unavailable approval history') state.transientReviewHistoryFailures = 1;

      await writeFile(next.GITHUB_OUTPUT, '');
      const { stdout } = await submit(next, captured, prioritizedReview('P1'));
      assert.match(stdout, /::warning::Unable to verify refreshed PR-Agent comments/u);
      const [output, failure, ...rest] = (await readFile(next.GITHUB_OUTPUT, 'utf8')).trim().split('\n');
      assert.match(output, /^approval_revision=[^\n]+$/u);
      assert.equal(failure, 'publication_failed=true');
      assert.deepEqual(rest, []);
      const withdrawal = JSON.parse(output.slice('approval_revision='.length));
      assert.deepEqual(withdrawal, { prNumber: 42, head, base, baseRef: 'main', allowApproval: false,
        runId: next.GITHUB_RUN_ID, runAttempt: next.GITHUB_RUN_ATTEMPT });

      const approved = await execute('approve', { ...next, APPROVAL_REVISION: JSON.stringify(withdrawal) });
      assert.match(approved.stdout, /dismissed-ineligible/u);
      assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED', 'COMMENTED']);
      assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['APPROVE', 'COMMENT', 'DISMISS']);
    }));
  }
});

test('summary verification failure still fails when only an approval or no withdrawal could be emitted', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv };
    const revision = await capture(mode);
    state.persistentCommentsStatus = 503;
    for (const review of [cleanReview(), prioritizedReview('P1')]) {
      await assert.rejects(approvalRevision(mode, revision, review), /Cannot verify PR-Agent comments \(HTTP 503\)/u);
      assert.equal(await readFile(mode.GITHUB_OUTPUT, 'utf8'), '');
    }
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('a target advance during failed summary verification keeps withdrawal bound to the reviewed revision', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });

    const next = { ...mode, GITHUB_RUN_ID: '12346', PR_AGENT_ALLOW_RETRY: 'true' };
    const captured = await capture(next);
    state.persistentCommentsStatus = 503;
    state.baseAfterCommentList = 'c'.repeat(40);
    assert.equal(await approvalRevision(next, captured, prioritizedReview('P1')), undefined);
    assert.equal(await readFile(next.GITHUB_OUTPUT, 'utf8'), 'retry=true\n');
    assert.deepEqual(state.reviews.map(({ state }) => state), ['APPROVED']);
  });
});

test('a GitHub connection reset reading review history is retried before withdrawal', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    state.reviews.push({ id: 102, user: maintainer, state: 'CHANGES_REQUESTED', commit_id: head, body: 'Please fix this' });

    const next = { ...mode, GITHUB_RUN_ID: '12346' };
    const fresh = await approvalRevision(next, await capture(next), cleanReview());
    state.disconnectReviewHistory = true;
    const { stdout } = await execute('approve', { ...next, APPROVAL_REVISION: JSON.stringify(fresh) });
    assert.match(stdout, /dismissed-changes-requested/u);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'CHANGES_REQUESTED']);
  });
});

test('a P1 review retains approval cleanup through transient GitHub review-history failures', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });

    const next = { ...mode, GITHUB_RUN_ID: '12346' };
    const captured = await capture(next);
    state.transientReviewHistoryFailures = 2;
    const ineligible = await approvalRevision(next, captured, prioritizedReview('P1'));
    assert.match(await readFile(next.GITHUB_OUTPUT, 'utf8'), /^review_key=[a-f0-9]{40} main$/mu);
    assert.deepEqual(ineligible, { prNumber: 42, head, base, baseRef: 'main', allowApproval: false,
      runId: next.GITHUB_RUN_ID, runAttempt: next.GITHUB_RUN_ATTEMPT });

    const priorRequests = state.requests.length;
    await assert.rejects(execute('approve', { ...next, PR_AGENT_APPROVAL_TOKEN: '', APPROVAL_REVISION: JSON.stringify(ineligible) }),
      { stderr: /Missing approval GitHub App installation token/u });
    await assert.rejects(execute('approve', { ...next, GITHUB_RUN_ATTEMPT: '2', APPROVAL_REVISION: JSON.stringify(ineligible) }),
      { stderr: /Withdrawal.*re-run all jobs/iu });
    assert.equal(state.requests.length, priorRequests);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['APPROVED', 'APPROVED', 'COMMENTED', 'COMMENTED']);
    const { stdout } = await execute('approve', {
      ...next, PR_AGENT_AUTO_APPROVE: '', APPROVAL_REVISION: JSON.stringify(ineligible),
    });
    assert.match(stdout, /dismissed-ineligible/u);
    assert.equal(state.requests.slice(priorRequests).filter(({ method, url }) =>
      method === 'GET' && url.startsWith('/repos/corp/example/pulls/42/reviews?')).length, 2);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED', 'COMMENTED', 'COMMENTED']);
    const writes = reviewWrites(state);
    assert.deepEqual(writes.map(({ body }) => body.event), ['APPROVE', 'COMMENT', 'COMMENT', 'DISMISS']);
    assert.match(writes[2].body.body, /approval-withdrawal:v2/u);
  });
});

test('the approval entry point uses the dedicated credential for identity and one exact APPROVE only', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv };
    const revision = await capture(mode);
    const eligible = await approvalRevision(mode, revision, cleanReview());
    await execute('approve', {
      ...mode,
      PR_AGENT_APPROVAL_TOKEN: 'approval-test-token',
      APPROVAL_REVISION: JSON.stringify(eligible),
    });
    assert.deepEqual(state.approverRequests, [
      { method: 'GET', url: '/installation/repositories?per_page=2' },
      { method: 'GET', url: '/repos/corp/example/branches/main/protection' },
      { method: 'GET', url: '/repos/corp/example/rules/branches/main?per_page=100&page=1' },
      { method: 'POST', url: '/repos/corp/example/pulls/42/reviews' },
      { method: 'GET', url: '/repos/corp/example/branches/main/protection' },
      { method: 'GET', url: '/repos/corp/example/rules/branches/main?per_page=100&page=1' },
    ]);
    const [write] = reviewWrites(state);
    assert.equal(write.body.event, 'APPROVE');
    assert.equal(write.body.commit_id, head);
    assert.deepEqual(await approvalRevision(mode, revision, prioritizedReview('P2')), {
      prNumber: 42, head, base, baseRef: 'main', allowApproval: false,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    });
  });
});

test('a later cleanup can withdraw an earlier approval when App identity was unavailable', async (t) => {
  for (const endpoint of ['approvalIdentityStatus', 'installationStatus']) {
    await t.test(endpoint, () => withGitHub(async ({ state, env }) => {
      const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
      const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
      await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
      state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });

      const next = { ...mode, GITHUB_RUN_ID: '12346', GITHUB_RUN_ATTEMPT: '2' };
      state[endpoint] = 503;
      state.disconnectWithdrawalPost = true;
      const captured = await capture(next);
      const withdrawal = await approvalRevision(next, captured, prioritizedReview('P1'));
      assert.equal(withdrawal?.allowApproval, false);
      assert.match(await readFile(next.GITHUB_OUTPUT, 'utf8'), /^review_key=/mu);
      assert.deepEqual(await approvalRevision(next, captured, prioritizedReview('P1')), withdrawal);
      const decisions = state.reviews.filter(({ body }) => body.includes('approval-withdrawal:v2'));
      assert.equal(decisions.length, 1);
      const [decision] = decisions;
      assert.equal(decision.user.id, actionsBot.id);
      assert.match(decision.body, / 12346 2 -->$/u);
      await assert.rejects(execute('approve', { ...next, APPROVAL_REVISION: JSON.stringify(withdrawal) }),
        { stderr: /HTTP 503/u });
      assert.deepEqual(state.reviews.slice(0, 2).map(({ state }) => state), ['APPROVED', 'APPROVED']);

      state[endpoint] = 200;
      const schedule = { ...mode, GITHUB_EVENT_NAME: 'schedule' };
      decision.user = maintainer;
      assert.match((await execute('approve', schedule)).stdout, /Dismissed 0 stale Luoshen approval/u);
      decision.user = actionsBot;
      const correctBody = decision.body;
      decision.body = correctBody.replace(base, 'c'.repeat(40));
      assert.match((await execute('approve', schedule)).stdout, /Dismissed 0 stale Luoshen approval/u);
      decision.body = correctBody;
      const cleanup = await execute('approve', schedule);
      assert.match(cleanup.stdout, /Dismissed 1 stale Luoshen approval/u);
      assert.deepEqual(state.reviews.slice(0, 2).map(({ state }) => state), ['DISMISSED', 'APPROVED']);
    }));
  }
});

test('a different GitHub App scoped to the same repository cannot publish an APPROVE', async () => {
  await withGitHub(async ({ state, env }) => {
    state.approvalBot = { id: 790, login: 'other-automation[bot]', type: 'Bot' };
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token',
      PR_AGENT_APPROVAL_APP_SLUG: 'other-automation' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    assert.equal(eligible?.allowApproval, true);

    const priorRequests = state.requests.length;
    const result = await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) }).catch((error) => error);
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), []);
    assert.match(result.stderr, /Approval GitHub App does not match the expected App/u);
    assert.equal(state.requests.length, priorRequests);
  });
});

test('a different GitHub App scoped to the same repository cannot reconcile approvals', async () => {
  await withGitHub(async ({ state, env }) => {
    state.approvalBot = { id: 790, login: 'other-automation[bot]', type: 'Bot' };
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token',
      PR_AGENT_APPROVAL_APP_SLUG: 'other-automation' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, PR_AGENT_APPROVAL_EXPECTED_APP_SLUG: 'other-automation',
      APPROVAL_REVISION: JSON.stringify(eligible) });
    assert.equal(state.reviews[0]?.state, 'APPROVED');
    state.refs.main = 'c'.repeat(40);

    const priorRequests = state.requests.length;
    const result = await execute('approve', { ...mode, GITHUB_EVENT_NAME: 'push' }).catch((error) => error);
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['APPROVE']);
    assert.match(result.stderr, /Approval GitHub App does not match the expected App/u);
    assert.equal(state.requests.length, priorRequests);
    assert.equal(state.reviews[0].state, 'APPROVED');
  });
});

test('the approval entry point rejects missing or invalid App slugs before any GitHub requests', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    const approveEnv = { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) };
    const priorRequests = state.requests.length;
    for (const slug of ['', 'luoshen[bot]', 'luoshen\n', 'github-actions']) {
      await assert.rejects(execute('approve', { ...approveEnv, PR_AGENT_APPROVAL_EXPECTED_APP_SLUG: slug }),
        { stderr: /Invalid expected approval GitHub App slug/u });
    }
    for (const slug of ['', 'luoshen[bot]']) {
      await assert.rejects(execute('approve', { ...approveEnv, PR_AGENT_APPROVAL_APP_SLUG: slug }),
        { stderr: /Approval GitHub App does not match the expected App/u });
    }
    assert.equal(state.requests.length, priorRequests);
  });
});

test('a newer P1 review cannot be overridden by rerunning the old approval job', async () => {
  await withGitHub(async ({ state, env }) => {
    const first = { ...env, ...approvalEnv };
    const oldVerdict = await approvalRevision(first, await capture(first), cleanReview());
    assert.ok(oldVerdict?.allowApproval);
    const newer = await commentEvent({ ...first, GITHUB_RUN_ID: '12346' }, '/review');
    assert.equal(await approvalRevision(newer, await capture(newer), prioritizedReview('P1')), undefined);

    await execute('approve', {
      ...first, GITHUB_RUN_ATTEMPT: '2', PR_AGENT_APPROVAL_TOKEN: 'approval-test-token',
      APPROVAL_REVISION: JSON.stringify(oldVerdict),
    });

    assert.equal(state.approverRequests, undefined);
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['COMMENT']);

    const freshAttempt = { ...first, GITHUB_RUN_ATTEMPT: '2' };
    const freshVerdict = await approvalRevision(freshAttempt, await capture(freshAttempt), cleanReview());
    await execute('approve', {
      ...freshAttempt, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token',
      APPROVAL_REVISION: JSON.stringify(freshVerdict),
    });
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['COMMENT', 'APPROVE']);
  });
});

test('a trusted main push still dismisses an older automatic approval when new approvals are switched off', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    const automatic = state.reviews[0];
    state.reviews.push({ ...automatic, id: 102, user: maintainer });
    state.refs.main = 'c'.repeat(40);

    const credentialReads = state.approverRequests.length;
    await execute('approve', { ...mode, PR_AGENT_AUTO_APPROVE: '', APPROVAL_REVISION: JSON.stringify(eligible) });
    assert.equal(state.approverRequests.length, credentialReads);

    const push = { ...mode, GITHUB_EVENT_NAME: 'push', PR_AGENT_AUTO_APPROVE: '' };
    await execute('approve', { ...push, GITHUB_REF: 'refs/heads/other', PUSH_EVENT_REF: 'refs/heads/other' });
    assert.equal(automatic.state, 'APPROVED');

    const { stdout } = await execute('approve', push);
    assert.match(stdout, /Dismissed 1 stale Luoshen approval/u);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED']);
    assert.deepEqual(reviewWrites(state).map(({ method, url }) => [method, url]), [
      ['POST', '/repos/corp/example/pulls/42/reviews'],
      ['PUT', '/repos/corp/example/pulls/42/reviews/101/dismissals'],
    ]);
  });
});

test('a trusted main push clears a retargeted PR’s Luoshen approval with new approvals switched off', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });
    state.pr.base.ref = 'release';
    state.refs.release = base;

    const { stdout } = await execute('approve', { ...mode, GITHUB_EVENT_NAME: 'push', PR_AGENT_AUTO_APPROVE: '' });
    assert.match(stdout, /Dismissed 1 stale Luoshen approval/u);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED']);
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['APPROVE', 'DISMISS']);
  });
});

test('only trusted branch protection changes reconcile approvals without running a review', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });
    state.refs.main = 'c'.repeat(40);

    const protectionChange = { ...mode, GITHUB_EVENT_NAME: 'branch_protection_rule', PR_AGENT_AUTO_APPROVE: '' };
    const before = state.requests.length;
    for (const override of [{ GITHUB_REF: 'refs/heads/other' }, { PROTECTION_EVENT_REPO: 'other/example' },
      { PROTECTION_EVENT_ACTION: 'unknown' }]) {
      await execute('approve', { ...protectionChange, ...override });
    }
    await execute('capture', protectionChange);
    await execute('validate', protectionChange);
    assert.equal(state.requests.length, before);

    const { stdout } = await execute('approve', protectionChange);
    assert.match(stdout, /Dismissed 1 stale Luoshen approval/u);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED']);
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['APPROVE', 'DISMISS']);
  });
});

test('scheduled reconciliation clears only the App approval after a ruleset-only change', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const eligible = await approvalRevision(mode, await capture(mode), cleanReview());
    await execute('approve', { ...mode, APPROVAL_REVISION: JSON.stringify(eligible) });
    state.reviews.push({ ...state.reviews[0], id: 102, user: maintainer });
    state.approvalRules = [{ type: 'pull_request', parameters: {
      required_approving_review_count: 2, require_last_push_approval: false,
    } }];

    const scheduled = { ...mode, GITHUB_EVENT_NAME: 'schedule', PR_AGENT_AUTO_APPROVE: '', PR_AGENT_ENABLED: '' };
    const before = state.requests.length;
    await execute('approve', { ...scheduled, GITHUB_REF: 'refs/heads/other' });
    await execute('capture', scheduled);
    await execute('validate', scheduled);
    assert.equal(state.requests.length, before);

    const { stdout } = await execute('approve', scheduled);
    assert.match(stdout, /Dismissed 1 stale Luoshen approval/u);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED']);
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['APPROVE', 'DISMISS']);
  });
});

test('the approval entry point refuses a different event revision or branch before using the credential', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, ...approvalEnv, PR_AGENT_APPROVAL_TOKEN: 'approval-test-token' };
    const revision = { prNumber: 42, head, base, baseRef: 'main', allowApproval: true };
    for (const mismatch of [{ prNumber: 43 }, { head: 'c'.repeat(40) }]) {
      await assert.rejects(execute('approve', {
        ...mode, APPROVAL_REVISION: JSON.stringify({ ...revision, ...mismatch }),
      }), /Invalid PR revision for approval/u);
    }
    await execute('approve', {
      ...mode, GITHUB_REF: 'refs/heads/other', APPROVAL_REVISION: JSON.stringify(revision),
    });
    const otherCommand = await commentEvent(mode, '/review -i');
    await execute('approve', { ...otherCommand, APPROVAL_REVISION: JSON.stringify(revision) });
    assert.equal(state.approverRequests, undefined);
    assert.deepEqual(reviewWrites(state), []);
  });
});

function recordAutomaticRun(state, { number = 42, sha = head, runId = 12, ranReview = true, baseSha = base, ref = 'main',
  conclusion = 'success' } = {}) {
  state.runs[runId] = {
    id: runId, event: 'workflow_run', conclusion, head_sha: 'f'.repeat(40),
    display_title: '洛神 · PR #' + number + ' ' + sha, pull_requests: [],
  };
  state.jobs[runId] = [{
    name: '洛神 (ubuntu-x64)', conclusion,
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
  assert.match(workflow, /format\('洛神 · PR #\{0\}\{1\}', github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| github\.event\.issue\.number,/u);
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

test('a failed inline review POST allows the same revision to publish once on a later run', async () => {
  await withGitHub(async ({ state, env }) => {
    const review = prioritizedReview('P1');
    const revision = await capture(env);
    state.postStatus = 503;
    await submit(env, revision, review);
    assert.equal(state.inlineComments.length, 0);
    assert.equal(reviewWrites(state).length, 1);
    const failedOutput = await readFile(env.GITHUB_OUTPUT, 'utf8');
    assert.match(failedOutput, /^publication_failed=true$/mu);
    assert.doesNotMatch(failedOutput, /^(?:review_key|retry)=/mu);
    recordAutomaticRun(state, { runId: Number(env.GITHUB_RUN_ID), ranReview: false, conclusion: 'failure' });

    state.postStatus = 200;
    state.comments = [freshComment('pr-agent:describe:persistent'), freshComment('pr-agent:review:full')];
    const next = { ...env, GITHUB_RUN_ID: '12346' };
    const retried = await capture(next);
    assert.equal(retried.head, revision.head, 'a failed COMMENT did not complete the revision');
    assert.equal(retried.base, revision.base);
    await submit(next, retried, review);
    const successfulOutput = await readFile(next.GITHUB_OUTPUT, 'utf8');
    assert.match(successfulOutput, new RegExp(`^review_key=${base} main$`, 'mu'));
    assert.doesNotMatch(successfulOutput, /^publication_failed=/mu);
    await submit(next, retried, review);
    assert.deepEqual(reviewWrites(state).map(({ body }) => body.event), ['COMMENT', 'COMMENT']);
    assert.equal(state.inlineComments.length, 1);
    assert.equal(state.inlineComments[0].commit_id, head);
    assert.match(state.inlineComments[0].body, /Count regression/u);

    recordAutomaticRun(state, { runId: Number(next.GITHUB_RUN_ID), ranReview: /^review_key=/mu.test(successfulOutput) });
    assert.deepEqual(await capture({ ...env, GITHUB_RUN_ID: '12347' }), {});
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
  assert.equal(comment('/"ReVIEW"'), automatic(42));
  assert.equal(comment('/"review" -i'), automatic(42));
  assert.equal(comment('/request-changes P1 ' + head + ' ' + base + ' main'), automatic(42));
  assert.notEqual(automatic(43), automatic(42));
  assert.notEqual(comment('已更新'), automatic(42));
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
  assert.match(stepDefinition('Capture refreshed PR revision'), /!cancelled\(\) && steps\.validation\.outputs\.retry == 'true'/u);
  assert.equal(uses.exec(summary)?.[1], image);
  assert.equal(uses.exec(retrySummary)?.[1], image);
  assert.equal(uses.exec(retry)?.[1], image);
  assert.match(retrySummary, /env: \*pr_agent_summary_env/u);
  assert.match(retry, /env: \*pr_agent_env/u);
  const recheck = stepDefinition('Validate refreshed PR-Agent review');
  assert.match(recheck, /!cancelled\(\) && steps\.validation\.outputs\.retry == 'true'/u);
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

test('only P0 and P1 publish native COMMENT and model results never request changes', async () => {
  for (const [index, priority] of ['P0', 'P1', 'P2', 'P3'].entries()) {
    await withGitHub(async ({ state, env }) => {
      const reviewEnv = index % 2 ? await commentEvent(env, '/review') : env;
      const revision = await capture(reviewEnv);
      const output = JSON.parse(prioritizedReview(priority));
      Object.assign(output, { priority: 'P0', matches_claim: true, event: 'REQUEST_CHANGES' });
      await submit(reviewEnv, revision, JSON.stringify(output));
      const [write, ...other] = reviewWrites(state);
      assert.deepEqual(other, []);
      if (priority === 'P2' || priority === 'P3') {
        assert.equal(write, undefined);
        return;
      }
      assert.equal(write?.body.event, 'COMMENT');
      assert.equal(write.body.commit_id, revision.head);
      assert.equal(write.body.comments[0].side, 'RIGHT');
      assert.match(write.body.comments[0].body, /Count regression/u);
    });
  }
});

function receipt(sha, target, { runId = '12345', attempt = '1', invocation = 'initial' } = {}) {
  return `<!-- heluo-forge-pr-agent-review-run:v1 42 ${runId} ${attempt} ${sha} ${target} main ${invocation} -->`;
}

function persistentReview(sha, target, run) {
  return { ...freshComment('pr-agent:review:full'),
    body: `## 洛神评审\n\n<!-- pr-agent:review:full -->\n\n${receipt(sha, target, run)}` };
}

function historicalThread({ path = 'src/example.js', line = 2, sha = head, priority = 'P1', id = 4725035838,
  resolved = true, outdated = false, authorReplied = true } = {}) {
  const root = { body: `**[${priority}] Existing finding**\n\nEvidence\n\n<!-- heluo-forge-pr-agent-comment:v1 ${digest(path + line)} -->`,
    author: { __typename: 'Bot', login: 'github-actions', databaseId: 41898282 }, originalCommit: { oid: sha },
    databaseId: id };
  return { path, line, originalLine: line, startLine: line, diffSide: 'RIGHT', startDiffSide: null,
    isResolved: resolved, isOutdated: outdated, root: { nodes: [root] },
    recent: { nodes: [root, ...(authorReplied ? [{ databaseId: id + 1, author: { login: 'contributor' },
      bodyText: 'The caller contract already covers this branch.' }] : [])], pageInfo: { hasPreviousPage: false } } };
}

const replayBase = 'f1673d325e51ad4bb2645a25b8ecbfdc2e844974';
const replayFirst = 'c2cffa560e5f8184b386117957253a10b2046061';
const replayPrevious = 'f29abe97a0f24812c00b190fc74bf6fdb7b901a9';
const replayHead = 'a71c3ab83cb23327d82d83b43b7b741eb8d5d9c8';
const replayResolvedPath = 'tests/forge-experts-enterprise-e2e.test.mjs';
const replayDeltaPaths = ['packages/forge-experts/client.js', 'packages/forge-experts/src/dispatch.mjs',
  'packages/forge-experts/test/client.test.mjs', 'packages/forge-experts/test/dispatch.test.mjs'];
const replayFullPaths = [...replayDeltaPaths, replayResolvedPath, 'docs/design/verification/forge-experts.md',
  ...['delegra-client', 'index', 'prestep', 'routes', 'scope', 'selection', 'tool'].map((name) => `packages/forge-experts/src/${name}.mjs`),
  ...['prestep', 'structure', 'tool'].map((name) => `packages/forge-experts/test/${name}.test.mjs`)];

function fixtureFile(filename, line) {
  return { filename, status: 'modified', additions: 1, deletions: 1, patch: `@@ -${line} +${line} @@\n-old row\n+new row` };
}

function rawDiff(files) {
  return files.map(({ filename, patch }) => [
    `diff --git a/${filename} b/${filename}`, 'index e652251..1843a8d 100644',
    `--- a/${filename}`, `+++ b/${filename}`, patch, '',
  ].join('\n')).join('');
}

function configureIncrementalReplay(state, env) {
  const last = { runId: '12101', attempt: '2' };
  const mode = { ...env, EVENT_HEAD: replayHead, PR_AGENT_REVIEW_CONTEXT_PATH: env.GITHUB_OUTPUT + '.context' };
  state.pr.head.sha = replayHead;
  state.pr.base.sha = state.refs.main = replayBase;
  state.comments.push(persistentReview(replayPrevious, replayBase, last));
  state.attemptJobs = { '12101/2': [{ name: '洛神 (ubuntu-x64)', run_id: 12101, run_attempt: 2, conclusion: 'success',
    steps: [{ name: `Confirm incremental baseline ${replayPrevious} ${replayBase} main initial`, conclusion: 'success' }] }] };
  const files = replayDeltaPaths.map((filename, index) => fixtureFile(filename, index + 11));
  state.files = [...files, fixtureFile(replayResolvedPath, 519)];
  state.pr.changed_files = state.files.length;
  state.compareResponse = { status: 'ahead', base_commit: { sha: replayPrevious }, merge_base_commit: { sha: replayPrevious }, files };
  state.compareDiff = rawDiff(files);
  state.checkRuns = Array.from({ length: 20 }, (_, index) => ({ head_sha: replayHead, status: 'completed',
    conclusion: index < 18 ? 'success' : 'skipped' }));
  state.threads = [historicalThread({ path: replayResolvedPath, line: 519, sha: replayPrevious, priority: 'P2' })];
  return { mode, files };
}

test('a new wording for an author-answered resolved P1 does not add an inline thread on the same revision', async () => {
  await withGitHub(async ({ state, env }) => {
    const scoped = { ...env, PR_AGENT_REVIEW_CONTEXT_PATH: env.GITHUB_OUTPUT + '.context' };
    state.threads = [historicalThread()];
    const revision = await capture(scoped);
    state.comments.push(persistentReview(head, base));
    await submit(scoped, revision, prioritizedReview('P1', { issue_header: '[P1] [RIGHT] Reworded old problem' }));
    assert.deepEqual(reviewWrites(state), []);
    assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^review_key=/mu);
  });
});

test('a resolved lower-priority discussion does not suppress a stronger blocker on the same line', async (t) => {
  for (const [oldPriority, newPriority] of [['P2', 'P1'], ['P1', 'P0']]) {
    await t.test(oldPriority + ' to ' + newPriority, async () => {
      await withGitHub(async ({ state, env }) => {
        const scoped = { ...env, PR_AGENT_REVIEW_CONTEXT_PATH: env.GITHUB_OUTPUT + '.context' };
        state.threads = [historicalThread({ priority: oldPriority })];
        const manual = await commentEvent(scoped, '/review');
        const revision = await capture(manual);
        state.comments.push(persistentReview(head, base));
        await submit(manual, revision, prioritizedReview(newPriority));
        assert.deepEqual(reviewWrites(state).map(({ body }) => body.comments[0].line), [2]);
      });
    });
  }
});

test('a first full review can publish seven distinct blockers in one batch and skip optional inline findings', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, EVENT_HEAD: replayFirst, PR_AGENT_REVIEW_CONTEXT_PATH: env.GITHUB_OUTPUT + '.context' };
    state.pr.head.sha = replayFirst;
    state.pr.base.sha = state.refs.main = replayBase;
    state.files = replayFullPaths.map((filename, index) => fixtureFile(filename, index + 2));
    state.pr.changed_files = state.files.length;
    state.diff = rawDiff(state.files);
    const revision = await capture(mode);
    assert.equal(revision.finding_limit, '10');
    assert.equal(JSON.parse(await readFile(revision.review_context, 'utf8')).mode, 'full');
    assert.match(await readFile(new URL('../.pr_agent.toml', import.meta.url), 'utf8'), /^num_max_findings = 10$/mu);
    state.comments.push(persistentReview(replayFirst, replayBase));
    const p1 = JSON.parse(prioritizedReview('P1')).key_issues_to_review[0];
    const findings = replayFullPaths.slice(0, 9).map((filename, index) => ({ ...p1, relevant_file: filename,
      start_line: index + 2, end_line: index + 2, issue_header: `[${index < 7 ? 'P1' : `P${index - 5}`}] [RIGHT] Replayed defect ${index + 1}` }));
    const result = JSON.stringify({ merge_recommendation: 'changes_required', security_concerns: 'No', key_issues_to_review: findings });
    const proof = { files: state.files.map(({ filename }, index) => ({ path: filename,
      left: digest(`${index + 2}\told row\n`), right: digest(`${index + 2}\tnew row\n`) })) };
    assert.equal(await approvalRevision(mode, revision, result, proof), undefined);
    assert.deepEqual(reviewWrites(state).map(({ body }) => [body.event, body.comments?.length]), [['COMMENT', 7]]);
    assert.deepEqual(reviewWrites(state)[0].body.comments.map(({ path }) => path), replayFullPaths.slice(0, 7));
    assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^baseline_key=/mu);
  });
});

test('the #484 replay selects the last reviewed head and only publishes comments anchored in the delta', async () => {
  await withGitHub(async ({ state, env }) => {
    const { mode, files } = configureIncrementalReplay(state, env);
    const revision = await capture(mode);
    const context = JSON.parse(await readFile(revision.review_context, 'utf8'));
    assert.equal(context.previousHead, replayPrevious);
    assert.equal(context.mode, 'incremental');
    assert.deepEqual(context.files, files);
    assert.deepEqual(context.checks, { total: 20, inspected: 20, success: 18, skipped: 2, pending: 0, other: 0 });
    assert.equal(context.threads[0].lastReply, 'The caller contract already covers this branch.');
    assert.equal(context.threads[0].originalHead, replayPrevious);
    state.comments.push(persistentReview(replayHead, replayBase));
    const previous = { issue_header: '[P1] [RIGHT] Reworded history', issue_content: 'Rephrased evidence.',
      relevant_file: replayResolvedPath, start_line: 519, end_line: 519 };
    const current = { ...previous, issue_header: '[P1] [RIGHT] New issue', relevant_file: files[0].filename, start_line: 11, end_line: 11 };
    const oldSide = { ...current, issue_header: '[P1] [LEFT 11-11] Old-side evidence', start_line: 0, end_line: 0 };
    const review = JSON.stringify({ merge_recommendation: 'changes_required', key_issues_to_review: [previous, current, oldSide] });
    await submit(mode, revision, review);
    assert.deepEqual(state.inlineComments.map(({ path, side, line }) => ({ path, side, line })), [{ path: files[0].filename, side: 'RIGHT', line: 11 }]);
    assert.doesNotMatch(await readFile(env.GITHUB_OUTPUT, 'utf8'), /baseline_key=/u);
  });
});

test('resolved delta positions suppress a reworded range but permit evidence on changed lines', async (t) => {
  const cases = [
    { name: 'range overlaps an unchanged resolved line', start: 519, threadLineChanged: false, expected: [] },
    { name: 'independent evidence is on the next changed line', start: 520, threadLineChanged: false, expected: [520] },
    { name: 'the previously resolved line actually changed', start: 519, threadLineChanged: true, expected: [519] },
  ];
  for (const { name, start, threadLineChanged, expected } of cases) await t.test(name, async () => {
    await withGitHub(async ({ state, env }) => {
      const { mode, files } = configureIncrementalReplay(state, env);
      const full = { ...fixtureFile(replayResolvedPath, 519), additions: 2, deletions: 2,
        patch: '@@ -519,2 +519,2 @@\n-old row\n-old row\n+first row\n+new row' };
      files.push(threadLineChanged ? full : fixtureFile(replayResolvedPath, 520));
      state.files.splice(-1, 1, full);
      state.compareDiff = rawDiff(files);
      state.threads = [historicalThread({ path: replayResolvedPath, line: 519, sha: replayPrevious })];
      const revision = await capture(mode);
      const context = JSON.parse(await readFile(revision.review_context, 'utf8'));
      assert.equal(context.mode, 'incremental');
      state.comments.push(persistentReview(replayHead, replayBase));
      await submit(mode, revision, prioritizedReview('P1', {
        relevant_file: replayResolvedPath, start_line: start, end_line: 520,
        issue_header: '[P1] [RIGHT] New wording on the affected range',
      }));
      assert.deepEqual(state.inlineComments.map(({ line }) => line), expected);
    });
  });
});

test('an entirely filtered delta can refresh scope without generating review or approval evidence', async () => {
  await withGitHub(async ({ state, env }) => {
    const { mode } = configureIncrementalReplay(state, env);
    const revision = await capture(mode);
    const context = JSON.parse(await readFile(revision.review_context, 'utf8'));
    assert.equal(context.mode, 'incremental');
    const scopeOnly = '<!-- heluo-forge-pr-agent-review-scope-only:v1 -->';
    const normal = persistentReview(replayHead, replayBase);
    const markScopeOnly = (comment) => ({ ...comment,
      body: comment.body.replace('\n\n<!-- heluo-forge-pr-agent-review-run:', '\n\n' + scopeOnly + '\n\n<!-- heluo-forge-pr-agent-review-run:'),
    });
    state.comments.push(markScopeOnly(persistentReview(replayHead, replayBase, { attempt: '7' })));
    await assert.rejects(submit(mode, revision, ''), /did not produce structured review output/u);
    state.comments.push(markScopeOnly(normal));
    await submit({ ...mode, ...approvalEnv }, revision, '');
    assert.doesNotMatch(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^(approval_revision|baseline_key|review_key)=/mu);
    assert.deepEqual(reviewWrites(state), []);
    await assert.rejects(submit(mode, revision, cleanReview()), /summary and review were not both refreshed/u);
  });
});

function incrementalProof(files) {
  return { version: 2, mode: 'incremental', previousHead: replayPrevious, files: files.map(({ filename }, index) => ({
    path: filename, left: digest(`${index + 11}\told row\n`), right: digest(`${index + 11}\tnew row\n`),
  })) };
}

test('a clean delta advances the baseline without inline writes or automatic approval', async (t) => {
  for (const withHistory of [false, true]) await t.test(withHistory ? 'with evidence for both historical blockers' : 'without historical blockers', async () => {
    await withGitHub(async ({ state, env }) => {
      const { mode, files } = configureIncrementalReplay(state, env);
      const history = withHistory ? [
        { thread_id: 4725011058, status: 'fix_evidence_found', evidence: 'The changed guard now handles the missing entry.' },
        { thread_id: 4725149579, status: 'still_present', evidence: 'The changed branch still skips the required verification.' },
      ] : [];
      for (const item of history) {
        state.threads.push(historicalThread({ id: item.thread_id, sha: replayPrevious, resolved: false }));
      }
      const revision = await capture(mode);
      state.comments.push(persistentReview(replayHead, replayBase));
      const review = cleanReview(withHistory ? { history_recheck: history } : {});
      assert.equal(await approvalRevision({ ...mode, ...approvalEnv }, revision, review, incrementalProof(files)), undefined);
      assert.deepEqual(reviewWrites(state), []);
      assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), new RegExp(`^baseline_key=${replayHead} ${replayBase} main initial$`, 'mu'));
    });
  });
});

test('incomplete historical rechecks preserve the ordinary review and make the next push use the full diff', async (t) => {
  const known = { thread_id: 4725011058, status: 'fix_evidence_found', evidence: 'The changed guard now handles the missing entry.' };
  const other = 4725149579;
  const cases = {
    'missing history field': {},
    'unrelated thread': { history: [{ ...known, thread_id: other }] },
    'only one of two blockers is rechecked': { history: [known], extraBlocker: other },
    'insufficient evidence': { history: [{ ...known, status: 'insufficient_evidence' }] },
    'blank evidence': { history: [{ ...known, evidence: ' \t ' }] },
    'conflicting results': { history: [known, { ...known, status: 'still_present' }] },
    'duplicate results': { history: [known, known] },
  };
  for (const [name, { history, extraBlocker }] of Object.entries(cases)) await t.test(name, async () => {
    await withGitHub(async ({ state, env }) => {
      const { mode, files } = configureIncrementalReplay(state, env);
      state.threads.push(historicalThread({ id: known.thread_id, sha: replayPrevious, resolved: false }));
      if (extraBlocker) state.threads.push(historicalThread({ id: extraBlocker, sha: replayPrevious, resolved: false }));
      const revision = await capture(mode);
      assert.equal(JSON.parse(await readFile(revision.review_context, 'utf8')).mode, 'incremental');
      state.comments.push(persistentReview(replayHead, replayBase));
      const review = cleanReview({ history_recheck: history });
      assert.equal(await approvalRevision({ ...mode, ...approvalEnv }, revision, review, incrementalProof(files)), undefined);
      const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
      assert.match(output, /^review_key=/mu);

      const laterHead = '7'.repeat(40);
      state.pr.head.sha = laterHead;
      state.compareResponse.base_commit.sha = replayHead;
      state.compareResponse.merge_base_commit.sha = replayHead;
      const priorKey = /^baseline_key=(.+)$/mu.exec(output)?.[1];
      state.attemptJobs['12345/1'] = [{ name: '洛神 (ubuntu-x64)', run_id: 12345, run_attempt: 1, conclusion: 'success',
        steps: priorKey ? [{ name: `Confirm incremental baseline ${priorKey}`, conclusion: 'success' }] : [] }];
      const next = { ...mode, GITHUB_RUN_ID: '12346', EVENT_HEAD: laterHead,
        PR_AGENT_REVIEW_CONTEXT_PATH: mode.PR_AGENT_REVIEW_CONTEXT_PATH + '.next' };
      const refreshed = await capture(next);
      assert.equal(JSON.parse(await readFile(refreshed.review_context, 'utf8')).mode, 'full');
      assert.equal(priorKey, undefined);
      assert.deepEqual(reviewWrites(state), []);
    });
  });
});

test('a settled full review can still confirm a baseline with historical threads', async () => {
  await withGitHub(async ({ state, env }) => {
    const scoped = { ...env, PR_AGENT_REVIEW_CONTEXT_PATH: env.GITHUB_OUTPUT + '.context' };
    const manual = await commentEvent(scoped, '/review');
    state.threads = [historicalThread({ resolved: false })];
    const revision = await capture(manual);
    state.comments.push(persistentReview(head, base));
    assert.equal(await approvalRevision(manual, revision, cleanReview()), undefined);
    assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^baseline_key=/mu);
  });
});

test('reruns inspect earlier attempts of the same run before reusing a baseline', async (t) => {
  const cases = [
    { name: 'a failed native attempt since the baseline', jobs: ['failure'], expected: 'full', firstUsedFull: true },
    { name: 'a later skipped attempt does not hide an earlier failure', jobs: ['failure', 'skipped'], expected: 'full' },
    { name: 'a missing previous review job', jobs: [null], expected: 'full' },
    { name: 'a known skipped prior review job', jobs: ['skipped'], expected: 'incremental' },
    { name: 'failure predates the latest confirmed summary', jobs: ['failure'], expected: 'incremental', older: true },
  ];
  for (const { name, jobs, expected, firstUsedFull, older } of cases) await t.test(name, async () => {
    await withGitHub(async ({ state, env }) => {
      const { mode } = configureIncrementalReplay(state, env);
      if (firstUsedFull) {
        state.threadStatus = 503;
        const first = await capture(mode);
        assert.equal(JSON.parse(await readFile(first.review_context, 'utf8')).mode, 'full');
        state.threadStatus = 200;
      }
      const completed = new Date(Date.now() + (older ? -30_000 : 30_000)).toISOString();
      const runAttempt = jobs.length + 1;
      state.runs[12345] = { id: 12345, run_attempt: runAttempt, event: 'workflow_run', status: 'in_progress', conclusion: null,
        display_title: `洛神 · PR #42 ${replayHead}`, updated_at: completed };
      for (const [index, conclusion] of jobs.entries()) {
        if (conclusion === null) continue;
        const attempt = index + 1;
        state.attemptJobs[`12345/${attempt}`] = [{ name: '洛神 (ubuntu-x64)', run_id: 12345, run_attempt: attempt, status: 'completed',
          completed_at: completed, conclusion, steps: conclusion === 'skipped' ? [] : [{ name: 'Begin native review', conclusion: 'success' }] }];
      }
      const rerun = { ...mode, GITHUB_RUN_ATTEMPT: String(runAttempt), PR_AGENT_REVIEW_CONTEXT_PATH: mode.PR_AGENT_REVIEW_CONTEXT_PATH + '.rerun' };
      const revision = await capture(rerun);
      assert.equal(JSON.parse(await readFile(revision.review_context, 'utf8')).mode, expected);
      assert.ok(state.requests.some(({ url }) => url.includes('/actions/runs/12345/attempts/1/jobs')));
    });
  });
});

test('a later push checks previous runs whose latest attempt can hide a native review failure', async (t) => {
  const cases = [
    { name: 'stale rerun ends successfully after skipping review', status: 'completed', conclusion: 'success', simulateStaleRetry: true },
    { name: 'a rerun that failed without starting review', status: 'completed', conclusion: 'failure' },
    { name: 'a queued rerun', status: 'queued', conclusion: null },
    { name: 'a missing earlier job', status: 'completed', conclusion: 'success', prior: null },
    { name: 'the earlier job skipped review too', status: 'completed', conclusion: 'success', prior: 'skipped', expected: 'incremental' },
    { name: 'the earlier failure predates the confirmed summary', status: 'completed', conclusion: 'success', older: true, expected: 'incremental' },
  ];
  for (const { name, status, conclusion, simulateStaleRetry, prior = 'failure', older, expected = 'full' } of cases) {
    await t.test(name, async () => {
      await withGitHub(async ({ state, env }) => {
        const { mode } = configureIncrementalReplay(state, env);
        const failedHead = '8'.repeat(40);
        if (simulateStaleRetry) {
          const previous = { ...mode, GITHUB_RUN_ID: '13000', EVENT_HEAD: failedHead,
            PR_AGENT_REVIEW_CONTEXT_PATH: mode.PR_AGENT_REVIEW_CONTEXT_PATH + '.previous' };
          state.pr.head.sha = failedHead;
          state.threadStatus = 503;
          const first = await capture(previous);
          assert.equal(JSON.parse(await readFile(first.review_context, 'utf8')).mode, 'full');
          await assert.rejects(submit(previous, first, cleanReview()), /summary and review were not both refreshed/u);
          state.pr.head.sha = replayHead;
          state.threadStatus = 200;
          assert.deepEqual(await capture({ ...previous, GITHUB_RUN_ATTEMPT: '2' }), {});
        }
        const updated = new Date(Date.now() + 60_000).toISOString();
        state.runs[13000] = { id: 13000, run_attempt: 2, event: 'workflow_run', status, conclusion,
          display_title: `洛神 · PR #42 ${failedHead}`, updated_at: updated };
        if (prior) {
          const completed = new Date(Date.now() + (older ? -30_000 : 30_000)).toISOString();
          state.attemptJobs['13000/1'] = [{ name: '洛神 (ubuntu-x64)', run_id: 13000, run_attempt: 1,
            status: 'completed', conclusion: prior, completed_at: completed,
            steps: prior === 'skipped' ? [] : [{ name: 'Begin native review', conclusion: 'success' }] }];
        }
        if (status === 'completed') {
          state.attemptJobs['13000/2'] = [{ name: '洛神 (ubuntu-x64)', run_id: 13000, run_attempt: 2,
            status: 'completed', conclusion, completed_at: updated, steps: [] }];
        }
        const next = await capture(mode);
        assert.equal(JSON.parse(await readFile(next.review_context, 'utf8')).mode, expected);
        assert.ok(state.requests.some(({ url }) => url.includes('/actions/runs/13000/attempts/1/jobs')));
      });
    });
  }
});

test('an unconfirmed newest review, invalid delta or missing thread state falls back to full review', async (t) => {
  const cases = {
    'latest attempt has no successful marker': (state) => state.comments.push({
      ...persistentReview('c'.repeat(40), replayBase, { runId: '13000' }), updated_at: new Date(Date.now() + 3000).toISOString(),
    }),
    'newer native attempt failed before updating the old summary': (state) => {
      const completed = new Date(Date.now() + 3000).toISOString();
      state.runs[13000] = { id: 13000, run_attempt: 1, event: 'workflow_run', status: 'completed', conclusion: 'failure',
        display_title: `洛神 · PR #42 ${'d'.repeat(40)}`, updated_at: completed };
      state.attemptJobs['13000/1'] = [{ name: '洛神 (ubuntu-x64)', run_id: 13000, run_attempt: 1, status: 'completed',
        conclusion: 'failure', completed_at: completed,
        steps: [{ name: 'Begin native review', conclusion: 'success' }] }];
    },
    'rebase or force push': (state) => { state.compareResponse.merge_base_commit.sha = base; },
    'raw diff lacks compared rows': (state) => { state.compareDiff = state.compareDiff.replace('+new row', '+different'); },
    'GraphQL temporarily unavailable': (state) => { state.threadStatus = 503; },
    'GraphQL partial data with errors': (state) => { state.threadErrors = [{ type: 'FORBIDDEN' }]; },
    'twenty-one open blockers cannot fit': (state) => {
      state.threads = Array.from({ length: 21 }, (_, index) => historicalThread({ id: 1000 + index, resolved: false }));
    },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    await withGitHub(async ({ state, env }) => {
      const { mode } = configureIncrementalReplay(state, env);
      change(state);
      const revision = await capture(mode);
      const context = JSON.parse(await readFile(revision.review_context, 'utf8'));
      assert.equal(context.mode, 'full');
      assert.equal(context.previousHead, undefined);
    });
  });
});

test('the native publisher checks subsequent GraphQL pages and the current attempt marker', async () => {
  await withGitHub(async ({ state, env }) => {
    const mode = { ...env, PR_AGENT_REVIEW_CONTEXT_PATH: env.GITHUB_OUTPUT + '.context' };
    state.threadPages = {
      first: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } },
      next: { nodes: [historicalThread()], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    const revision = await capture(mode);
    const reviewContext = JSON.parse(await readFile(revision.review_context, 'utf8'));
    assert.equal(reviewContext.threads.length, 1);
    state.comments.push(persistentReview(head, base, { attempt: '7' }));
    await assert.rejects(submit(mode, revision, cleanReview()), /summary and review were not both refreshed/u);
    assert.deepEqual(reviewWrites(state), []);
  });
});

test('a modified-file deletion publishes an explicitly scoped LEFT comment', async () => {
  await withGitHub(async ({ state, env }) => {
    const revision = await capture(env);
    state.files[0].patch = '@@ -1,2 +1 @@\n function count() {\n-  runRequiredCheck();';
    const output = prioritizedReview('P1', {
      issue_header: '[P1] [LEFT 2-2] Required check removed', start_line: 0, end_line: 0,
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
    ]) {
      await writeFile(env.GITHUB_OUTPUT, '');
      await submit(env, revision, prioritizedReview('P1', issue));
      assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^review_key=[a-f0-9]{40} main$/mu);
    }
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
    await submit(manual, revision, prioritizedReview('P1'));
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
