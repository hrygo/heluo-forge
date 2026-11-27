import { appendFile, readFile } from 'node:fs/promises';
import { publishApproval, readApprovalReceipt, reconcileMainApprovals } from './pr-agent-approval.mjs';
import { verifyReviewCoverage, verifyReviewFileModes } from './pr-agent-coverage.mjs';
import { buildReviewComments, getReviewCommentMarker } from './pr-agent-review-comments.mjs';
import { handleChangeRequests, parseChangeRequest } from './pr-agent-change-request.mjs';
import { isBranch, isSha, listReviews, pages, targetTip, validId } from './pr-agent-github.mjs';

const allowedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const signalPath = '.github/workflows/pr-agent-signal.yml';
const summaryMarker = '<!-- pr-agent:describe:persistent -->';
const reviewMarker = '<!-- pr-agent:review:full -->';
const reviewFindingLimit = 4; // PR_REVIEWER__NUM_MAX_FINDINGS in the workflow.
const diffMediaType = 'application/vnd.github.diff';
const diffResponseTypes = new Set([diffMediaType, 'application/vnd.github.v3.diff']);

function githubClient(env, token = env.GH_TOKEN, scopeSignal) {
  const repository = env.GITHUB_REPOSITORY;
  const api = `${env.GITHUB_API_URL}/repos/${repository}`;
  const usersApi = `${env.GITHUB_API_URL}/users`;
  async function request(method, path, body, label, { base = api, accept = 'application/vnd.github+json' } = {}) {
    const requestTimeout = AbortSignal.timeout(15_000);
    const response = await fetch(base + path, {
      method,
      headers: { Accept: accept, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: scopeSignal ? AbortSignal.any([scopeSignal, requestTimeout]) : requestTimeout,
    });
    if (!response.ok) {
      const error = new Error(`${label ?? `${method} ${path} failed`} (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (accept === diffMediaType) {
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (response.status !== 200 || !diffResponseTypes.has(mediaType)) {
        throw new Error('Invalid GitHub PR diff response');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer());
    }
    return response.json();
  }
  return {
    api, repository, serverUrl: env.GITHUB_SERVER_URL,
    withSignal: (signal) => githubClient(env, token, signal),
    get: (path, label) => request('GET', path, undefined, label),
    getDiff: (path) => request('GET', path, undefined, 'Cannot read raw PR diff', { accept: diffMediaType }),
    getAccount: (login) => request('GET', `/${encodeURIComponent(login)}`, undefined,
      'Cannot verify the GitHub approval identity', { base: usersApi }),
    getInstallationRepositories: () => request('GET', '/installation/repositories?per_page=2', undefined,
      'Cannot verify the approval App installation scope', { base: env.GITHUB_API_URL }),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
  };
}

function eventScope(event, eventName, github) {
  if (event.repository?.full_name !== github.repository) return undefined;
  if (eventName === 'workflow_run') {
    const run = event.workflow_run;
    if (event.action !== 'completed' || run?.path !== signalPath || !Number.isSafeInteger(run.id) || run.id < 1 ||
        run.event !== 'pull_request' ||
        run.repository?.full_name !== github.repository || run.head_repository?.full_name !== github.repository ||
        run.conclusion !== 'success' || !isSha(run.head_sha) || run.pull_requests?.length !== 1) return undefined;
    const pr = run.pull_requests[0];
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.url !== `${github.api}/pulls/${pr.number}`) return undefined;
    return { prNumber: pr.number, head: run.head_sha, signalId: run.id, automatic: true };
  }
  if (eventName === 'issue_comment' && event.action === 'created' && event.issue?.pull_request &&
      Number.isSafeInteger(event.issue.number) && event.issue.number > 0 && event.sender?.type === 'User' &&
      allowedAssociations.has(event.comment?.author_association)) {
    const body = typeof event.comment.body === 'string' ? event.comment.body : '';
    return { prNumber: event.issue.number, body, automatic: false };
  }
}

function revisionKey(base, ref) {
  return `${base} ${encodeURIComponent(ref)}`;
}

function manualCommand(body) {
  // Match the pinned runner's leading slashes, command quoting and whitespace.
  const trimmed = body.replace(/[\u001c-\u001f\u0085]/gu, ' ').trim();
  const word = trimmed.split(/[ \t\r\n]/u, 1)[0];
  if (!trimmed.startsWith('/')) return { name: '', args: '' };
  return {
    name: word.replace(/["\\]/gu, '').replace(/^\/+/u, '').toLowerCase(),
    args: trimmed.slice(word.length).trim(),
  };
}

function usesNativeReview(scope) {
  const { name, args } = manualCommand(scope.body ?? '');
  return scope.automatic || (name === 'review' && !args);
}

function reviewCanBeApproved(review) {
  const issues = review.key_issues_to_review;
  if (review.merge_recommendation.trim() !== 'no_concerns_found' ||
      typeof review.security_concerns !== 'string' || review.security_concerns.trim() !== 'No' ||
      !Array.isArray(issues) || issues.length >= reviewFindingLimit) return false;
  return issues.every((issue) => {
    if (typeof issue?.issue_header !== 'string' || typeof issue.issue_content !== 'string' || !issue.issue_content.trim()) {
      return false;
    }
    const heading = /^\[P3\][ \t]+([^\r\n]+)$/u.exec(issue.issue_header.trim());
    return heading && !/\[P[0-9]+\]/iu.test(heading[1]);
  });
}

async function readReviewCoverage(path) {
  if (!path) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function publishReviewComments(github, prPath, head, comments, currentRevision) {
  const seen = new Set();
  try {
    for await (const comment of pages(github, `${prPath}/comments`, 'Cannot read PR review comments')) {
      if (comment?.user?.login === 'github-actions[bot]' && comment.commit_id === head) {
        seen.add(getReviewCommentMarker(comment.body));
      }
    }
  } catch {
    console.log('::warning::Unable to read existing inline comments. Findings are available in the review summary.');
    return 'incomplete';
  }
  const unpublished = comments.filter((comment) => !seen.has(getReviewCommentMarker(comment.body)));
  if (!unpublished.length) return 'complete';
  if (!await currentRevision()) return 'revision-changed';
  try {
    const posted = await github.post(`${prPath}/reviews`, {
      event: 'COMMENT', commit_id: head, body: '洛神审查意见', comments: unpublished,
    });
    if (posted?.state !== 'COMMENTED' || posted.commit_id !== head) throw new Error('Invalid GitHub COMMENT response');
  } catch {
    console.log('::warning::Unable to confirm inline comments. Findings are available in the review summary.');
    return 'incomplete';
  }
  return 'complete';
}

async function alreadyReviewed(github, env, scope, base, ref) {
  const query = new URLSearchParams({ event: 'workflow_run', status: 'success', per_page: '100' });
  const title = `洛神 · PR #${scope.prNumber} ${scope.head}`;
  const completed = `Confirm completed automatic review ${revisionKey(base, ref)}`;
  for (let page = 1; page <= 10; page++) {
    query.set('page', String(page));
    const { workflow_runs: runs } = await github.get(`/actions/workflows/pr-agent.yml/runs?${query}`, 'Cannot read prior automatic reviews');
    if (!Array.isArray(runs)) throw new Error('Invalid automatic review history');
    for (const run of runs) {
      if (String(run.id) === env.GITHUB_RUN_ID || run.display_title !== title || run.event !== 'workflow_run') continue;
      const { jobs } = await github.get(`/actions/runs/${run.id}/jobs?per_page=100`, 'Cannot verify prior automatic review');
      if (!Array.isArray(jobs)) throw new Error('Invalid automatic review jobs');
      if (jobs.some((job) => job.conclusion === 'success' && job.steps?.some((step) =>
        step.name === completed && step.conclusion === 'success'))) {
        console.log(`Skipping automatic review already completed by run ${run.id}.`);
        return true;
      }
    }
    if (runs.length < 100) return false;
  }
  return false;
}

async function capture(github, env, scope, event) {
  const { prNumber, automatic, body = '' } = scope;
  if (/^\s*\/request-changes(?:\s|$)/iu.test(body)) {
    const command = parseChangeRequest(body);
    if (!command) throw new Error('Use /request-changes P0|P1 <head SHA> <base SHA> <target branch>.');
    // A rerun may recover a prior accepted publication even if its POST response was lost.
    const result = await handleChangeRequests({
      github, prNumber, command: Number(env.GITHUB_RUN_ATTEMPT ?? '1') === 1 ? command : undefined, event,
    });
    if (result?.status === 'rejected') throw new Error('This account or PR revision cannot request changes.');
    return;
  }

  const request = manualCommand(body);
  // Recover pending publications even if this event is stale or the PR is now ineligible.
  if (!env.EXPECTED_HEAD && (automatic || (request.name === 'review' && !request.args))) {
    await handleChangeRequests({ github, prNumber });
  }
  if (automatic && !env.EXPECTED_HEAD) {
    const { jobs } = await github.get(`/actions/runs/${scope.signalId}/jobs?per_page=100`, 'Cannot read PR review signal');
    if (!Array.isArray(jobs)) throw new Error('Invalid PR review signal jobs');
    // A workflow with only skipped jobs can still have a successful conclusion.
    if (!jobs.some((job) => job.name === 'signal' && job.conclusion === 'success')) return;
  }
  const pr = await github.get(`/pulls/${prNumber}`, 'Cannot read PR revision');
  if (pr.head?.repo?.full_name !== github.repository) {
    console.log('Skipping a fork or deleted head repository before running PR-Agent.');
    return;
  }
  const head = pr.head?.sha;
  const baseRef = pr.base?.ref;
  if (!isSha(head) || !isBranch(baseRef) ||
      pr.base?.repo?.full_name !== github.repository) throw new Error('Invalid PR revision');
  if ((env.EXPECTED_HEAD && head !== env.EXPECTED_HEAD) || (env.EXPECTED_BASE_REF && baseRef !== env.EXPECTED_BASE_REF)) {
    throw new Error('PR revision changed before retry');
  }
  if (pr.state !== 'open' || (automatic && (head !== scope.head || pr.draft))) {
    console.log('Skipping an outdated or ineligible review event.');
    return;
  }
  const base = await targetTip(github, baseRef, 'Cannot read target branch');
  if (automatic && !env.EXPECTED_HEAD && await alreadyReviewed(github, env, scope, base, baseRef)) return;

  const manualSummary = request.name === 'describe' || request.name === 'describe_pr';
  if (manualSummary && request.args) {
    throw new Error('Use /describe or /describe_pr without arguments. Manual summary budgets are fixed.');
  }
  const upstreamInline = request.name === 'review' && Boolean(request.args);
  await appendFile(env.GITHUB_OUTPUT, [
    `head=${head}`, `base=${base}`, `base_ref=${baseRef}`, `started=${new Date().toISOString()}`,
    `manual_summary=${manualSummary}`, `upstream_inline=${upstreamInline}`, '',
  ].join('\n'));
}

async function validateReview(github, env, scope) {
  const { prNumber, automatic, body = '' } = scope;
  const { REVIEW_RESULT, REVIEWED_HEAD: head, REVIEWED_BASE: base, REVIEWED_BASE_REF: ref } = env;
  const prPath = `/pulls/${prNumber}`;
  const request = manualCommand(body);
  const incremental = request.name === 'review' && /^-i(?:\s|$)/iu.test(request.args);
  const expectReview = (title) => !/^\[Auto\]/u.test(title ?? '') &&
    (automatic || (request.name === 'review' && !incremental));
  if (!REVIEW_RESULT && !expectReview(env.PR_TITLE) && !automatic) {
    if (incremental) {
      console.log('::warning::Incremental review produced no structured output; check whether PR-Agent skipped unchanged files.');
    }
    return;
  }
  if (!isSha(head) || !isSha(base) || !isBranch(ref)) {
    throw new Error('Invalid reviewed PR revision');
  }

  async function currentRevision() {
    const pr = await github.get(prPath, 'Cannot verify PR revision');
    if (pr.head?.repo?.full_name !== github.repository) {
      console.log('Skipping a fork or deleted head repository');
      return undefined;
    }
    if (pr.state !== 'open' || pr.head?.sha !== head || pr.base?.ref !== ref ||
        pr.base?.repo?.full_name !== github.repository) {
      throw new Error('PR revision changed during review; summary and review may need to be refreshed');
    }
    const currentBase = await targetTip(github, ref, 'Cannot verify target branch');
    if (currentBase !== base) {
      if (env.PR_AGENT_ALLOW_RETRY === 'true' && automatic) {
        await appendFile(env.GITHUB_OUTPUT, 'retry=true\n');
        console.log('::warning::Target branch advanced during review; retrying the PR-Agent run.');
        return undefined;
      }
      throw new Error('PR revision changed during review; summary and review may need to be refreshed');
    }
    return pr;
  }

  let review;
  if (REVIEW_RESULT) {
    try {
      review = JSON.parse(REVIEW_RESULT);
    } catch {
      throw new Error('PR-Agent review output is not valid JSON');
    }
    if (typeof review?.merge_recommendation !== 'string' ||
        !['changes_required', 'needs_review', 'no_concerns_found'].includes(review.merge_recommendation.trim())) {
      throw new Error('PR-Agent review recommendation is missing or unknown');
    }
  }
  const pr = await currentRevision();
  if (!pr) return;
  if (!review) {
    if (!expectReview(pr.title ?? env.PR_TITLE)) return;
    if (pr.changed_files === 0) {
      const comparison = await github.get(`/compare/${base}...${head}?per_page=1`, 'Cannot verify PR comparison');
      if (comparison.base_commit?.sha !== base || !Array.isArray(comparison.files) ||
          !['ahead', 'behind', 'diverged', 'identical'].includes(comparison.status)) {
        throw new Error('Invalid PR comparison');
      }
      if (!comparison.files.length) {
        if (await currentRevision()) console.log('Skipping structured review: the pull request has no changed files.');
        return;
      }
    }
    throw new Error('PR-Agent did not produce structured review output');
  }

  const nativeReview = usesNativeReview(scope);
  const checkApprovals = nativeReview && env.PR_AGENT_APPROVAL_CONFIGURED === 'true' &&
    validId(pr.user?.id) && pr.user.type === 'User';
  const canCreateApproval = env.PR_AGENT_AUTO_APPROVE === 'true' && !pr.draft;
  const favorable = ref === 'main' && reviewCanBeApproved(review);
  const eligible = checkApprovals && canCreateApproval && favorable && validId(pr.changed_files);

  async function emitApprovalRevision(allowApproval) {
    if (!checkApprovals || (!canCreateApproval && favorable)) return 'no-work';
    let hasApprovalWork = allowApproval;
    if (!hasApprovalWork) {
      try {
        hasApprovalWork = (await listReviews(github, prPath)).some((previous) =>
          previous?.state === 'APPROVED' && previous.user?.type === 'Bot' && readApprovalReceipt(previous, prNumber));
      } catch {
        hasApprovalWork = true;
        console.log('::warning::Unable to list older automatic approvals; the approval job will retry reconciliation.');
      }
    }
    if (!hasApprovalWork) return 'no-work';
    if (!await currentRevision()) return 'revision-changed';
    const revision = {
      prNumber, head, base, baseRef: ref, allowApproval,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    };
    await appendFile(env.GITHUB_OUTPUT, `approval_revision=${JSON.stringify(revision)}\n`);
    return 'emitted';
  }

  if (automatic) {
    const started = Date.parse(env.REVIEW_STARTED_AT ?? '');
    if (!Number.isFinite(started)) throw new Error('Invalid PR-Agent run start time');
    const markers = new Set([summaryMarker, reviewMarker]);
    const earliest = Math.floor(started / 1000) * 1000;
    try {
      for await (const comment of pages(github, `/issues/${prNumber}/comments`, 'Cannot verify PR-Agent comments')) {
        if (comment?.user?.login !== 'github-actions[bot]' || typeof comment.body !== 'string' ||
            !(Date.parse(comment.updated_at) >= earliest)) continue;
        for (const marker of markers) if (comment.body.includes(marker)) markers.delete(marker);
        if (!markers.size) break;
      }
      if (markers.size) throw new Error('PR-Agent summary and review were not both refreshed for this run');
    } catch (error) {
      if (favorable) throw error;
      const withdrawal = await emitApprovalRevision(false);
      if (withdrawal === 'no-work') throw error;
      if (withdrawal === 'emitted') {
        console.log('::warning::Unable to verify refreshed PR-Agent comments; continuing with automatic approval withdrawal.');
        await appendFile(env.GITHUB_OUTPUT, 'publication_failed=true\n');
      }
      return;
    }
    if (!await currentRevision()) return;
  }

  // Options on a manual review are handled by the pinned upstream runner.
  let allowApproval = false;
  let inlineCommentStatus = 'complete';
  if (nativeReview) {
    const issues = Array.isArray(review.key_issues_to_review) ? review.key_issues_to_review : [];
    const coverage = eligible && await readReviewCoverage(env.PR_AGENT_COVERAGE_PATH);
    if (issues.length || coverage) {
      const files = [];
      try {
        for await (const file of pages(github, `${prPath}/files`, 'Cannot read PR files')) files.push(file);
      } catch {
        files.length = 0;
        if (issues.length) inlineCommentStatus = 'incomplete';
        console.log('::warning::Unable to read complete PR files for inline comments or approval coverage.');
      }
      const textCovered = Boolean(coverage) && verifyReviewCoverage(coverage, {
        repository: github.repository, prNumber, head, base, baseRef: ref, review, files,
        changedFileCount: pr.changed_files, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
        invocation: env.PR_AGENT_COVERAGE_INVOCATION,
      });
      const comments = buildReviewComments({ issues, files, head });
      if (comments.length) {
        inlineCommentStatus = await publishReviewComments(github, prPath, head, comments, currentRevision);
        if (inlineCommentStatus === 'revision-changed') return;
      }
      if (textCovered) {
        try {
          allowApproval = verifyReviewFileModes(await github.getDiff(prPath), files);
        } catch {
          console.log('::warning::Unable to verify file modes for automatic approval.');
        }
      }
    }
  }
  const publicationFailed = inlineCommentStatus === 'incomplete';
  if ((!publicationFailed || !allowApproval) && await emitApprovalRevision(allowApproval) === 'revision-changed') return;
  if (publicationFailed) {
    await appendFile(env.GITHUB_OUTPUT, 'publication_failed=true\n');
  } else if (automatic) {
    await appendFile(env.GITHUB_OUTPUT, `review_key=${revisionKey(base, ref)}\n`);
  }
}

function approvalCredential(env) {
  const appSlug = env.PR_AGENT_APPROVAL_EXPECTED_APP_SLUG;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(appSlug ?? '') || appSlug === 'github-actions') {
    throw new Error('Invalid expected approval GitHub App slug');
  }
  if (env.PR_AGENT_APPROVAL_APP_SLUG !== appSlug) {
    throw new Error('Approval GitHub App does not match the expected App');
  }
  if (!env.PR_AGENT_APPROVAL_TOKEN) throw new Error('Missing approval GitHub App installation token');
  return { approver: githubClient(env, env.PR_AGENT_APPROVAL_TOKEN), appSlug };
}

async function approve(github, env, scope) {
  if (env.GITHUB_REF !== 'refs/heads/main' || !usesNativeReview(scope) || !env.APPROVAL_REVISION) return;
  const revision = JSON.parse(env.APPROVAL_REVISION);
  if (revision?.prNumber !== scope.prNumber || (scope.automatic && revision.head !== scope.head) ||
      !isSha(revision.head) || !isSha(revision.base) || !isBranch(revision.baseRef) ||
      typeof revision.allowApproval !== 'boolean') {
    throw new Error('Invalid PR revision for approval');
  }
  if (revision.allowApproval && env.PR_AGENT_AUTO_APPROVE !== 'true') return;
  // GitHub can rerun this job using successful dependencies from a previous attempt.
  if (revision.runId !== env.GITHUB_RUN_ID || revision.runAttempt !== env.GITHUB_RUN_ATTEMPT ||
      !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    if (!revision.allowApproval) throw new Error('An automatic approval withdrawal needs a fresh review. Re-run all jobs to complete it.');
    console.log('Skipping automatic approval without a review from this workflow attempt.');
    return;
  }
  const status = await publishApproval({
    github, ...approvalCredential(env), revision, humanOwners: env.PR_AGENT_HUMAN_CODEOWNERS,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, allowApproval: revision.allowApproval,
  });
  console.log(`GitHub approval for PR #${scope.prNumber}: ${status}`);
}

const env = process.env;
const github = githubClient(env);
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
const scope = eventScope(event, env.GITHUB_EVENT_NAME, github);
const action = process.argv[2];
const cleanup = env.GITHUB_EVENT_NAME === 'schedule' ||
  (event.repository?.full_name === github.repository &&
   ((env.GITHUB_EVENT_NAME === 'push' && event.ref === env.GITHUB_REF && event.deleted === false) ||
    (env.GITHUB_EVENT_NAME === 'branch_protection_rule' && ['created', 'edited', 'deleted'].includes(event.action))));
if (scope) {
  if (action === 'capture') await capture(github, env, scope, event);
  else if (action === 'validate') await validateReview(github, env, scope);
  else if (action === 'approve') await approve(github, env, scope);
  else throw new Error('Unknown PR-Agent workflow command');
} else if (action === 'approve' && env.GITHUB_REF === 'refs/heads/main' && cleanup) {
  const dismissed = await reconcileMainApprovals({
    github, ...approvalCredential(env), humanOwners: env.PR_AGENT_HUMAN_CODEOWNERS,
  });
  const trigger = { push: 'main changed', branch_protection_rule: 'branch protection changed', schedule: 'a scheduled check' };
  console.log(`Dismissed ${dismissed} stale Luoshen approval(s) after ${trigger[env.GITHUB_EVENT_NAME]}.`);
}
