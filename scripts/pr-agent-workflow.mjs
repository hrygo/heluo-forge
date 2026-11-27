import { appendFile, readFile } from 'node:fs/promises';
import { buildReviewComments, getReviewCommentMarker } from './pr-agent-review-comments.mjs';
import { handleChangeRequests, parseChangeRequest } from './pr-agent-change-request.mjs';

const sha = /^[a-f0-9]{40}$/u;
const allowedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const signalPath = '.github/workflows/pr-agent-signal.yml';

function githubClient(env) {
  const repository = env.GITHUB_REPOSITORY;
  const api = `${env.GITHUB_API_URL}/repos/${repository}`;
  async function request(method, path, body, label) {
    const response = await fetch(api + path, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = new Error(`${label ?? `${method} ${path} failed`} (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  return {
    api, repository, serverUrl: env.GITHUB_SERVER_URL,
    get: (path, label) => request('GET', path, undefined, label),
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
        run.conclusion !== 'success' || !sha.test(run.head_sha ?? '') || run.pull_requests?.length !== 1) return undefined;
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

async function* pages(github, path, label) {
  for (let page = 1; page <= 100; page++) {
    const rows = await github.get(`${path}?per_page=100&page=${page}`, label);
    if (!Array.isArray(rows)) throw new Error(`Invalid ${label.toLowerCase()} response`);
    yield* rows;
    if (rows.length < 100) return;
  }
  throw new Error(`${label} exceeds the pagination limit`);
}

async function targetTip(github, ref, label) {
  const reference = await github.get(`/git/ref/heads/${encodeURIComponent(ref)}`, label);
  if (reference.ref !== `refs/heads/${ref}` || reference.object?.type !== 'commit' ||
      !sha.test(reference.object.sha ?? '')) throw new Error('Invalid target branch revision');
  return reference.object.sha;
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
  if (!sha.test(head ?? '') || typeof baseRef !== 'string' || !baseRef || /[\u0000-\u0020\u007f]/u.test(baseRef) ||
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
  if (!sha.test(head ?? '') || !sha.test(base ?? '') || !ref || /[\u0000-\u0020\u007f]/u.test(ref)) {
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

  if (automatic) {
    const started = Date.parse(env.REVIEW_STARTED_AT ?? '');
    if (!Number.isFinite(started)) throw new Error('Invalid PR-Agent run start time');
    const markers = new Set(['<!-- pr-agent:describe:persistent -->', '<!-- pr-agent:review:full -->']);
    const earliest = Math.floor(started / 1000) * 1000;
    for await (const comment of pages(github, `/issues/${prNumber}/comments`, 'Cannot verify PR-Agent comments')) {
      if (comment?.user?.login !== 'github-actions[bot]' || typeof comment.body !== 'string' ||
          !(Date.parse(comment.updated_at) >= earliest)) continue;
      for (const marker of markers) if (comment.body.includes(marker)) markers.delete(marker);
      if (!markers.size) break;
    }
    if (markers.size) throw new Error('PR-Agent summary and review were not both refreshed for this run');
    if (!await currentRevision()) return;
  }

  // Options on a manual review are handled by the pinned upstream runner.
  if (automatic || (request.name === 'review' && !request.args)) {
    const issues = Array.isArray(review.key_issues_to_review) ? review.key_issues_to_review : [];
    if (issues.length) {
      const files = [];
      for await (const file of pages(github, `${prPath}/files`, 'Cannot read PR files')) files.push(file);
      const comments = buildReviewComments({ issues, files, head });
      if (comments.length) {
        const seen = new Set();
        for await (const comment of pages(github, `${prPath}/comments`, 'Cannot read PR review comments')) {
          if (comment?.user?.login === 'github-actions[bot]' && comment.commit_id === head) {
            seen.add(getReviewCommentMarker(comment.body));
          }
        }
        const unpublished = comments.filter((comment) => !seen.has(getReviewCommentMarker(comment.body)));
        if (unpublished.length) {
          if (!await currentRevision()) return;
          const posted = await github.post(`${prPath}/reviews`, {
            event: 'COMMENT', commit_id: head, body: '洛神审查意见', comments: unpublished,
          });
          if (posted?.state !== 'COMMENTED' || posted.commit_id !== head) throw new Error('Invalid GitHub COMMENT response');
        }
      }
    }
  }
  if (automatic) await appendFile(env.GITHUB_OUTPUT, `review_key=${revisionKey(base, ref)}\n`);
}

const env = process.env;
const github = githubClient(env);
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
const scope = eventScope(event, env.GITHUB_EVENT_NAME, github);
if (scope) {
  const action = process.argv[2];
  if (action === 'capture') await capture(github, env, scope, event);
  else if (action === 'validate') await validateReview(github, env, scope);
  else throw new Error('Unknown PR-Agent workflow command');
}
