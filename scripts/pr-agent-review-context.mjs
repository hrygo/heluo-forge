import { verifyReviewFileModes } from './pr-agent-coverage.mjs';
import { isSha, pages, validId } from './pr-agent-github.mjs';
import { getReviewCommentBase, getReviewCommentMarker, reviewPriority } from './pr-agent-review-comments.mjs';

export const reviewFindingLimit = 10;
export const reviewMarker = '<!-- pr-agent:review:full -->';
const receiptPattern = /^<!-- heluo-forge-pr-agent-review-run:v1 ([1-9]\d*) ([1-9]\d*) ([1-9]\d*) ([a-f0-9]{40}) ([a-f0-9]{40}) (\S+) (initial|retry) -->$/u;
const reviewJobName = '洛神 (ubuntu-x64)';
const threadQuery = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number headRefOid author { login }
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path line startLine originalLine diffSide startDiffSide isResolved isOutdated
          root: comments(first: 1) {
            nodes { databaseId body originalCommit { oid } author { __typename login ... on Bot { databaseId } } }
          }
          recent: comments(last: 20) {
            nodes { databaseId author { login } bodyText }
          }
        }
      }
    }
  }
}`;

export function baselineKey({ head, base, baseRef, invocation }) {
  return `${head} ${base} ${encodeURIComponent(baseRef)} ${invocation}`;
}

export function reviewReceipt(revision) {
  const { prNumber, runId, runAttempt } = revision;
  return `<!-- heluo-forge-pr-agent-review-run:v1 ${prNumber} ${runId} ${runAttempt} ${baselineKey(revision)} -->`;
}

export function hasReviewIdentity(body) {
  return typeof body === 'string' && body.split('\n\n', 2)[1] === reviewMarker;
}

async function reviewJob(github, runId, runAttempt) {
  const { jobs } = await github.get(`/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    'Cannot verify a review attempt');
  if (!Array.isArray(jobs)) throw new Error('Invalid review attempt jobs');
  return jobs.find((job) => job?.name === reviewJobName && job.run_id === Number(runId) && job.run_attempt === Number(runAttempt));
}

function beganNativeReview(job) {
  return job?.steps?.some((step) => step.name === 'Begin native review' && step.conclusion === 'success');
}

function failedEarlierAttemptSince(job, updated) {
  if (job?.status !== 'completed' || typeof job.conclusion !== 'string' || !Array.isArray(job.steps)) return true;
  if (job.conclusion === 'success' || !beganNativeReview(job)) return false;
  const completed = Date.parse(job.completed_at);
  return !Number.isFinite(completed) || completed >= updated;
}

async function failedReviewSince(github, revision, previousRunId, previousAttempt, updated) {
  const { workflow_runs: runs } = await github.get('/actions/workflows/pr-agent.yml/runs?per_page=100',
    'Cannot check for newer unsuccessful reviews');
  if (!Array.isArray(runs) || (runs.length === 100 && !runs.some((run) => String(run.id) === previousRunId))) return true;
  const title = new RegExp(`^洛神 · PR #${revision.prNumber}(?: [a-f0-9]{40})?$`, 'u');
  const candidates = runs.filter((run) => validId(run.id) && String(run.id) !== revision.runId &&
    !(String(run.id) === previousRunId && String(run.run_attempt) === previousAttempt) &&
    ['workflow_run', 'issue_comment'].includes(run.event) && title.test(run.display_title) &&
    run.status === 'completed' && run.conclusion !== 'success' && Date.parse(run.updated_at) >= updated);
  // The workflow list exposes only the latest attempt of a run, which is active during capture.
  const runAttempt = Number(revision.runAttempt);
  const firstEarlierAttempt = previousRunId === revision.runId ? Number(previousAttempt) + 1 : 1;
  const earlierCount = runAttempt - firstEarlierAttempt;
  if (!validId(runAttempt) || earlierCount < 0 || candidates.length + earlierCount > 10 ||
      candidates.some((run) => !validId(run.run_attempt))) return true;
  const [jobs, earlierJobs] = await Promise.all([
    Promise.all(candidates.map((run) => reviewJob(github, run.id, run.run_attempt))),
    Promise.all(Array.from({ length: earlierCount }, (_, index) =>
      reviewJob(github, revision.runId, firstEarlierAttempt + index))),
  ]);
  return jobs.some(beganNativeReview) || earlierJobs.some((job) => failedEarlierAttemptSince(job, updated));
}

async function previousReviewedHead(github, revision) {
  let latest;
  for await (const comment of pages(github, `/issues/${revision.prNumber}/comments`, 'Cannot read reviewed head')) {
    if (comment?.user?.login !== 'github-actions[bot]' || !hasReviewIdentity(comment.body)) continue;
    const updated = Date.parse(comment.updated_at);
    if (Number.isFinite(updated) && (!latest || updated >= latest.updated)) latest = { updated, body: comment.body };
  }
  const match = receiptPattern.exec(latest?.body.trimEnd().split('\n').at(-1) ?? '');
  if (!match) return;
  const [, prNumber, runId, runAttempt, head, base, ref, invocation] = match;
  if (Number(prNumber) !== revision.prNumber || base !== revision.base || ref !== encodeURIComponent(revision.baseRef) ||
      head === revision.head || !validId(Number(runId)) || !validId(Number(runAttempt))) return;
  const job = await reviewJob(github, runId, runAttempt);
  const name = `Confirm incremental baseline ${baselineKey({ head, base, baseRef: revision.baseRef, invocation })}`;
  if (job?.conclusion === 'success' && job.steps?.some((step) => step.name === name && step.conclusion === 'success') &&
      !await failedReviewSince(github, revision, runId, runAttempt, latest.updated)) return head;
}

async function readDelta(github, previousHead, head) {
  const path = `/compare/${previousHead}...${head}`;
  const comparison = await github.get(`${path}?per_page=1`, 'Cannot read review delta');
  const { files } = comparison;
  // A complete regular-file patch is required to preserve both coordinates and changed rows.
  if (comparison.status !== 'ahead' || comparison.base_commit?.sha !== previousHead ||
      comparison.merge_base_commit?.sha !== previousHead || !Array.isArray(files) ||
      !files.length || files.length >= 300 || files.some((file) =>
        !['added', 'modified'].includes(file?.status) || typeof file.filename !== 'string' ||
        !file.filename || /[\r\n']/u.test(file.filename) || file.filename !== file.filename.trim())) return;
  if (!verifyReviewFileModes(await github.getDiff(path), files)) return;
  return files.map(({ filename, status, additions, deletions, patch }) => ({ filename, status, additions, deletions, patch }));
}

function excerpt(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, 400).toWellFormed() : '';
}

function readThread(thread, author) {
  const root = thread?.root?.nodes?.[0];
  if (root?.author?.__typename !== 'Bot' || root.author.login !== 'github-actions' ||
      root.author.databaseId !== 41898282 || !getReviewCommentMarker(root.body)) return;
  if (typeof thread.isResolved !== 'boolean' || typeof thread.isOutdated !== 'boolean' ||
      typeof thread.path !== 'string' || !thread.path || !validId(root.databaseId) ||
      !Array.isArray(thread.recent?.nodes)) throw new Error('Invalid Luoshen review thread');
  const heading = root.body.split('\n', 1)[0].replace(/^\*\*|\*\*$/gu, '');
  const priority = reviewPriority({ issue_header: heading });
  if (!priority) return;
  const originalBase = getReviewCommentBase(root.body);
  const reply = thread.recent.nodes.findLast((comment) => comment?.databaseId !== root.databaseId &&
    author && comment?.author?.login === author);
  const end = validId(thread.line) ? thread.line : null;
  const start = validId(thread.startLine) ? thread.startLine : end;
  const side = ['LEFT', 'RIGHT'].includes(thread.diffSide) && end && start <= end &&
    (start === end || thread.startDiffSide === thread.diffSide) ? thread.diffSide : null;
  return {
    id: root.databaseId, path: thread.path, side, start, end,
    originalLine: validId(thread.originalLine) ? thread.originalLine : null,
    originalHead: isSha(root.originalCommit?.oid) ? root.originalCommit.oid : null, originalBase: originalBase ?? null,
    resolved: thread.isResolved, outdated: thread.isOutdated, priority,
    finding: excerpt(root.body.split('\n\n').slice(0, originalBase ? -2 : -1).join(' ')), lastReply: excerpt(reply?.bodyText),
  };
}

export async function readReviewThreads(github, { prNumber, head }) {
  const [owner, name] = github.repository.split('/');
  const threads = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const response = await github.graphql(threadQuery, { owner, name, number: prNumber, after });
    const pr = response.data?.repository?.pullRequest;
    const connection = pr?.reviewThreads;
    if (response.errors?.length || pr?.number !== prNumber || pr.headRefOid !== head ||
        !Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('Cannot verify current PR review threads');
    }
    for (const row of connection.nodes) {
      const thread = readThread(row, pr.author?.login);
      if (thread) threads.push(thread);
    }
    if (!connection.pageInfo.hasNextPage) return threads;
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursor === after) break;
    after = cursor;
  }
  throw new Error('Review thread history exceeds the pagination limit');
}

export function openBlockers(threads) {
  return threads.filter(({ resolved, priority }) => !resolved && (priority === 'P0' || priority === 'P1'));
}

export function hasHistoricalReviewEvidence(rechecks, blockers) {
  if (!blockers.length) return true;
  if (!Array.isArray(rechecks)) return false;
  return blockers.every(({ id }) => {
    const matches = rechecks.filter((item) => item?.thread_id === id);
    if (matches.length !== 1) return false;
    const [{ status, evidence }] = matches;
    return (status === 'fix_evidence_found' || status === 'still_present') &&
      typeof evidence === 'string' && Boolean(evidence.trim());
  });
}

async function readChecks(github, head) {
  const checks = { total: 0, inspected: 0, success: 0, skipped: 0, pending: 0, other: 0 };
  for (let page = 1; page <= 3; page++) {
    const response = await github.get(`/commits/${head}/check-runs?filter=latest&per_page=100&page=${page}`,
      'Cannot read checks for the reviewed head');
    const { total_count: total, check_runs: runs } = response;
    if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(runs) || runs.length > 100 ||
        runs.some((run) => run?.head_sha !== head || typeof run.status !== 'string')) return null;
    checks.total = total;
    checks.inspected += runs.length;
    for (const { status, conclusion } of runs) {
      if (status !== 'completed') checks.pending++;
      else if (conclusion === 'success') checks.success++;
      else if (conclusion === 'skipped') checks.skipped++;
      else checks.other++;
    }
    if (runs.length < 100 || checks.inspected >= total) break;
  }
  return checks.inspected <= checks.total ? checks : null;
}

export async function captureReviewContext(github, revision, { automatic }) {
  const reader = github.withSignal(AbortSignal.timeout(12_000));
  const [threads, checks, previousHead] = await Promise.all([
    readReviewThreads(reader, revision).catch(() => null),
    readChecks(reader, revision.head).catch(() => null),
    automatic ? previousReviewedHead(reader, revision).catch(() => undefined) : undefined,
  ]);
  const context = { version: 1, ...revision, receipt: reviewReceipt(revision), mode: 'full', threads, checks };
  if (previousHead && threads && openBlockers(threads).length <= 20) {
    const files = await readDelta(reader, previousHead, revision.head).catch(() => undefined);
    if (files) return { ...context, mode: 'incremental', previousHead, files };
  }
  return context;
}
