import { setTimeout as delay } from 'node:timers/promises';
import { parseReceipt as readChangeRequestReceipt } from './pr-agent-change-request.mjs';
import { hasIndependentApprovalGate, hasLiveApprovalProtection } from './pr-agent-approval-policy.mjs';
import { isBranch, isCurrent, isSha, listReviews, pages, readPull, sameUser, validId } from './pr-agent-github.mjs';

const approvalPrefix = '<!-- heluo-forge-pr-agent-approval:v1';
const executionPrefix = '<!-- heluo-forge-pr-agent-approval-run:v1';
const pendingDismissalMarker = '<!-- heluo-forge-pr-agent-approval-dismissal-pending:v1 -->';
const approvalSummary = '洛神自动审批。完整审查未发现 P0、P1 或 P2 问题。';
const verificationDismissal = '洛神未能核对发布后的状态，撤销本次自动审批。';
const protectionDismissal = '洛神未能核对人工审批要求，撤销自动审批。';
const ineligibleDismissal = '当前审查结论不满足自动审批条件，撤销此前的洛神自动审批。';
const changeRequestDismissal = '维护者已请求修改，撤销洛神自动审批。';
const staleDismissal = 'PR 或目标分支版本已变化，洛神自动审批已过期。';
const recoverableDismissals = new Set([
  verificationDismissal, protectionDismissal, ineligibleDismissal, changeRequestDismissal, staleDismissal,
]);
const transientHistoryCodes = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN']);
const cleanupBatchSize = 4;
const receiptPattern = new RegExp(`^${approvalPrefix} ([1-9][0-9]*) (\\S+) (\\S+) ([A-Za-z0-9_-]+) -->$`, 'u');
const executionPattern = new RegExp(`^${executionPrefix} ([1-9][0-9]*) ([1-9][0-9]*) -->$`, 'u');

function sameBot(left, right) {
  return validId(left?.id) && left.id === right?.id && left.type === 'Bot' && right.type === 'Bot' &&
    left.login === right.login && /^[a-z0-9-]+\[bot\]$/u.test(left.login ?? '');
}

async function readApprovalBot(github, approver, appSlug) {
  if (typeof appSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(appSlug) || appSlug === 'github-actions') {
    throw new Error('Invalid dedicated approval GitHub App');
  }
  const login = `${appSlug}[bot]`;
  const [account, access] = await Promise.all([github.getAccount(login), approver.getInstallationRepositories()]);
  if (!sameBot(account, { id: account?.id, login, type: 'Bot' })) {
    throw new Error('Unexpected automatic approval approver identity');
  }
  if (access?.total_count !== 1 || access.repositories?.length !== 1 ||
      access.repositories[0]?.full_name !== github.repository) {
    throw new Error('Approval GitHub App token is not scoped to this repository');
  }
  return account;
}

export function readApprovalReceipt(review, prNumber) {
  if (!validId(review?.id) || !validId(prNumber) || typeof review.body !== 'string' ||
      !review.body.startsWith(`${approvalSummary}\n\n`)) return;
  const match = receiptPattern.exec(review.body.slice(review.body.lastIndexOf('\n') + 1));
  if (!match) return;
  const [, recordedNumber, head, base, encodedRef] = match;
  if (recordedNumber !== String(prNumber) || head !== review.commit_id || !isSha(head) || !isSha(base)) return;
  const baseRef = Buffer.from(encodedRef, 'base64url').toString('utf8');
  if (!isBranch(baseRef) || Buffer.from(baseRef).toString('base64url') !== encodedRef) return;
  return { prNumber, head, base, baseRef };
}

function readActiveApproval(review, owner, prNumber) {
  if (review?.state === 'APPROVED' && sameBot(review.user, owner)) return readApprovalReceipt(review, prNumber);
}

function matchesRevision(receipt, revision) {
  return receipt.prNumber === revision.prNumber && receipt.head === revision.head &&
    receipt.base === revision.base && receipt.baseRef === revision.baseRef;
}

function formatRevision({ prNumber, head, base, baseRef }) {
  return `${prNumber} ${head} ${base} ${Buffer.from(baseRef).toString('base64url')}`;
}

function withdrawalBody(revision) {
  return [
    '本次审查不满足自动批准条件。审查历史恢复后，洛神会撤销该版本已有的自动批准。',
    `<!-- heluo-forge-pr-agent-approval-withdrawal:v1 ${formatRevision(revision)} -->`,
  ].join('\n\n');
}

function hasLaterWithdrawal(history, approval, receipt) {
  const index = history.findIndex((review) => review?.id === approval.id);
  if (index === -1) return false;
  const body = withdrawalBody(receipt);
  // GitHub returns the reviews in chronological order.
  return history.slice(index + 1).some((review) => review?.state === 'COMMENTED' &&
    matchesReview(review, approval.user, receipt.head, body));
}

async function hasPriorApproval(github, reviews, owner, revision) {
  const dismissed = new Set();
  for (const review of reviews) {
    if (!sameBot(review?.user, owner) || review.commit_id !== revision.head) continue;
    if (review.state === 'APPROVED') return true;
    const receipt = review.state === 'DISMISSED' && readApprovalReceipt(review, revision.prNumber);
    if (receipt && matchesRevision(receipt, revision)) dismissed.add(review.id);
  }
  if (!dismissed.size) return false;

  // Only an exact compensation dismissal permits another approval of the same revision.
  for await (const event of pages(github, `/issues/${revision.prNumber}/timeline`, 'Pull request timeline')) {
    const dismissal = event?.dismissed_review;
    if (event?.event !== 'review_dismissed' || !dismissed.has(dismissal?.review_id)) continue;
    if (!sameBot(event.actor, owner) || dismissal.state !== 'approved' ||
        !recoverableDismissals.has(dismissal.dismissal_message)) return true;
    dismissed.delete(dismissal.review_id);
    if (!dismissed.size) return false;
  }
  return true;
}

async function hasBlockingChangeRequest(github, reviews) {
  const latestByReviewer = new Map();
  // Evaluate human decisions without letting a prior Luoshen approval supersede one.
  for (const review of reviews) {
    if (!validId(review?.id)) continue;
    const { state, user } = review;
    if (state === 'CHANGES_REQUESTED' && user?.id === 41898282 &&
        user.login === 'github-actions[bot]' && user.type === 'Bot' && readChangeRequestReceipt(review)) return true;
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(state) && sameUser(user, user)) latestByReviewer.set(user.id, review);
  }

  for (const { state, user } of latestByReviewer.values()) {
    if (state !== 'CHANGES_REQUESTED') continue;
    try {
      const access = await github.get(`/collaborators/${encodeURIComponent(user.login)}/permission`,
        'Cannot verify a change request reviewer’s repository permission');
      if (sameUser(access?.user, user) && ['write', 'maintain', 'admin'].includes(access.permission)) return true;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return false;
}

function matchesReview(review, owner, head, body) {
  return validId(review?.id) && sameBot(review.user, owner) && review.commit_id === head && review.body === body;
}

function matchesStoredApproval(candidate, review, body = review.body) {
  return matchesReview(candidate, review.user, review.commit_id, body) && candidate.id === review.id &&
    ['APPROVED', 'DISMISSED'].includes(candidate.state);
}

function hasPendingDismissal(review) {
  return review.body.split('\n').at(-2) === pendingDismissalMarker;
}

async function approvalVerificationFailed(github, review) {
  const execution = executionPattern.exec(review.body.split('\n').at(-2) ?? '');
  if (!execution) return false;
  const [, runId, runAttempt] = execution;
  // A restarted job cannot confirm the earlier attempt that posted this review.
  const { jobs } = await github.get(`/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    'Cannot read the originating automatic approval attempt');
  const job = jobs?.find((entry) => entry.name === '洛神自动批准 (ubuntu-x64)' &&
    entry.run_id === Number(runId) && entry.run_attempt === Number(runAttempt));
  if (!job) throw new Error(`Cannot verify the job that published automatic approval ${review.id}`);
  if (job.status !== 'completed') return false;
  const step = job.steps?.find(({ name }) => name === 'Reconcile or approve the reviewed PR revision');
  return step?.status !== 'completed' || step.conclusion !== 'success';
}

async function recordPendingDismissal(github, approver, pull, review, canRecord) {
  if (hasPendingDismissal(review)) return review;
  const url = `${pull}/reviews/${review.id}`;
  const receiptStart = review.body.lastIndexOf('\n') + 1;
  const body = `${review.body.slice(0, receiptStart)}${pendingDismissalMarker}\n${review.body.slice(receiptStart)}`;
  const current = await github.get(url);
  if (matchesStoredApproval(current, review, body)) return current;
  if (!matchesStoredApproval(current, review)) {
    throw new Error(`Could not verify automatic approval ${review.id} before recording withdrawal`);
  }
  if (current.state === 'DISMISSED') return current;
  if (canRecord && !await canRecord()) return;
  try {
    const updated = await approver.put(url, { body });
    if (matchesStoredApproval(updated, review, body)) return updated;
  } catch {
    // An accepted review edit can lose its response. Read the exact marker before proceeding.
  }
  const observed = await github.get(url);
  if (matchesStoredApproval(observed, review, body)) return observed;
  throw new Error(`Could not record pending withdrawal for automatic approval ${review.id}`);
}

async function postApproval(github, approver, pull, reviews, owner, head, body) {
  const newApproval = (review) => matchesReview(review, owner, head, body) &&
    !reviews.some((prior) => prior?.id === review.id);
  try {
    const review = await approver.post(`${pull}/reviews`, { event: 'APPROVE', commit_id: head, body });
    if (newApproval(review) && review.state === 'APPROVED') return review;
  } catch {
    // A lost response can follow a committed write. Recover only from the review history.
  }

  const recovered = (await readReviewHistory(github, pull)).filter((review) => newApproval(review) &&
    ['APPROVED', 'DISMISSED'].includes(review.state));
  if (recovered.length === 1) return recovered[0];
  throw new Error('Could not confirm the automatic approval after submitting it to GitHub');
}

async function dismissApproval(github, approver, pull, review, reason) {
  const url = `${pull}/reviews/${review.id}`;
  const current = await github.get(url);
  if (!matchesStoredApproval(current, review)) {
    throw new Error(`Could not verify automatic approval ${review.id} before dismissal`);
  }
  if (current.state === 'DISMISSED') return false;
  const message = typeof reason === 'function' ? await reason() : reason;
  if (!message) return false;

  try {
    const dismissed = await approver.put(`${url}/dismissals`, { event: 'DISMISS', message });
    if (matchesStoredApproval(dismissed, review) && dismissed.state === 'DISMISSED') return true;
  } catch {
    // Confirm an already applied dismissal by reading the exact review.
  }
  const observed = await github.get(url);
  if (!matchesStoredApproval(observed, review) || observed.state !== 'DISMISSED') {
    throw new Error(`Could not confirm dismissal of automatic approval ${review.id}`);
  }
  return true;
}

async function readReviewHistory(github, pull, signal) {
  // Retry history reads in the same workflow attempt, including recovery after a lost write response.
  for (const delayMs of [1000, 4000, 12000]) {
    try {
      return await listReviews(github, pull);
    } catch (error) {
      const networkFailure = error instanceof TypeError && transientHistoryCodes.has(error.cause?.code);
      if (!networkFailure && error.name !== 'TimeoutError' && !(error.status >= 500 && error.status < 600)) throw error;
      await delay(delayMs, undefined, { signal });
    }
  }
  return listReviews(github, pull);
}

export async function reconcileMainApprovals({ github, approver, appSlug, humanOwners, pullTimeoutMs = 10_000 }) {
  const owner = await readApprovalBot(github, approver, appSlug);
  let dismissed = 0;
  const errors = [];
  async function reconcilePull(pr) {
    const prNumber = pr?.number;
    try {
      if (!validId(prNumber)) throw new Error('Invalid open pull request');
      const pull = `/pulls/${prNumber}`;
      const signal = AbortSignal.timeout(pullTimeoutMs);
      const scopedGitHub = github.withSignal(signal);
      const scopedApprover = approver.withSignal(signal);
      const reviews = await readReviewHistory(scopedGitHub, pull, signal);
      for (const review of reviews) {
        const receipt = readActiveApproval(review, owner, prNumber);
        if (!receipt) continue;
        const reason = async (history) => {
          if (hasPendingDismissal(review)) return ineligibleDismissal;
          if (!await isCurrent(scopedGitHub, github.repository, pull, prNumber, receipt, { allowDraft: true })) return staleDismissal;
          if (!await hasIndependentApprovalGate(scopedGitHub, scopedApprover, receipt, humanOwners)) return protectionDismissal;
          const latest = history ?? await readReviewHistory(scopedGitHub, pull, signal);
          if (hasLaterWithdrawal(latest, review, receipt)) return ineligibleDismissal;
          if (await hasBlockingChangeRequest(scopedGitHub, latest)) return changeRequestDismissal;
          if (await approvalVerificationFailed(scopedGitHub, review)) return verificationDismissal;
        };
        if (await reason(reviews) && await dismissApproval(scopedGitHub, scopedApprover, pull, review, reason)) dismissed++;
      }
    } catch (cause) {
      errors.push(new Error(`Could not reconcile Luoshen approvals for PR #${prNumber}`, { cause }));
    }
  }
  let batch = [];
  try {
    // Include PRs that may have retained a main approval after being retargeted.
    for await (const pr of pages(github, '/pulls?state=open', 'Open pull requests')) {
      batch.push(reconcilePull(pr));
      if (batch.length < cleanupBatchSize) continue;
      await Promise.all(batch);
      batch = [];
    }
  } finally {
    await Promise.all(batch);
  }
  if (errors.length) throw new AggregateError(errors, 'Could not reconcile all Luoshen approvals');
  return dismissed;
}

export async function publishApproval({ github, approver, revision, appSlug, humanOwners, runId, runAttempt, allowApproval = true }) {
  const { repository, serverUrl } = github;
  const { prNumber, head, base, baseRef } = revision;
  if (typeof allowApproval !== 'boolean') throw new Error('Invalid automatic approval verdict');
  if (!validId(prNumber) || !isSha(head) || !isSha(base) || !isBranch(baseRef)) {
    throw new Error('Invalid automatic approval revision');
  }
  if (typeof runId !== 'string' || !/^[1-9][0-9]*$/u.test(runId)) throw new Error('Invalid automatic approval run ID');
  if (typeof runAttempt !== 'string' || !/^[1-9][0-9]*$/u.test(runAttempt)) {
    throw new Error('Invalid automatic approval run attempt');
  }
  if (typeof repository !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(repository)) {
    throw new Error('Invalid automatic approval repository');
  }
  const server = new URL(serverUrl);
  if (server.protocol !== 'https:' || server.username || server.password || server.href !== `${server.origin}/`) {
    throw new Error('Invalid automatic approval server URL');
  }

  const owner = await readApprovalBot(github, approver, appSlug);

  const pull = `/pulls/${prNumber}`;
  const changeRequestReason = async () => {
    if (await hasBlockingChangeRequest(github, await readReviewHistory(github, pull))) return changeRequestDismissal;
  };
  const staleReason = async (receipt) => {
    if (!await isCurrent(github, repository, pull, prNumber, receipt, { allowDraft: true })) return staleDismissal;
  };
  const reviewedRevisionIsCurrent = () => isCurrent(github, repository, pull, prNumber, revision, { allowDraft: true });
  const ineligibleReason = async () => {
    if (await reviewedRevisionIsCurrent()) return ineligibleDismissal;
  };
  const liveProtectionReason = async () => {
    if (!await hasLiveApprovalProtection(approver)) return protectionDismissal;
  };
  const pr = await readPull(github, pull, prNumber);
  if (!validId(pr.user?.id)) throw new Error('Invalid pull request author');
  if (pr.user.id === owner.id) return 'skipped-self';

  const reviewUrl = `${server.origin}/${repository}/actions/runs/${runId}`;
  const marker = `${approvalPrefix} ${formatRevision(revision)} -->`;
  const execution = `${executionPrefix} ${runId} ${runAttempt} -->`;
  const body = [
    approvalSummary,
    `[查看 GitHub Actions 审查运行](${reviewUrl})`,
    `${execution}\n${marker}`,
  ].join('\n\n');
  const preserveWithdrawal = async (cause) => {
    if (allowApproval || baseRef !== 'main') throw cause;
    try {
      if (await reviewedRevisionIsCurrent()) {
        const decision = withdrawalBody(revision);
        const record = await approver.post(`${pull}/reviews`, { event: 'COMMENT', commit_id: head, body: decision });
        if (record?.state !== 'COMMENTED' || !matchesReview(record, owner, head, decision)) {
          throw new Error('Unexpected withdrawal record after publication');
        }
      }
    } catch (recordError) {
      throw new AggregateError([cause, recordError], 'Could not reconcile or record the automatic approval withdrawal');
    }
    throw cause;
  };
  const previousReviews = await readReviewHistory(github, pull).catch(preserveWithdrawal);
  if (!await isCurrent(github, repository, pull, prNumber, revision, { allowDraft: !allowApproval })) return 'skipped-stale';

  const withdrawn = new Set();
  for (const review of previousReviews) {
    const receipt = readActiveApproval(review, owner, prNumber);
    if (!receipt) continue;
    const pending = hasPendingDismissal(review) || hasLaterWithdrawal(previousReviews, review, receipt);
    let reviewToDismiss = review;
    let reason = ineligibleDismissal;
    if (!pending) {
      if (!matchesRevision(receipt, revision)) {
        reason = () => staleReason(receipt);
      } else {
        if (allowApproval) continue;
        reviewToDismiss = await recordPendingDismissal(github, approver, pull, review, reviewedRevisionIsCurrent)
          .catch(preserveWithdrawal);
        if (!reviewToDismiss) continue;
        reason = ineligibleReason;
      }
    }
    if (await dismissApproval(github, approver, pull, reviewToDismiss, reason)) withdrawn.add(review.id);
  }
  if (!allowApproval) return withdrawn.size ? 'dismissed-ineligible' : 'skipped-ineligible';

  const reviews = await readReviewHistory(github, pull);
  const remaining = reviews.filter((review) => !withdrawn.has(review?.id));
  let rejection;
  if (await hasBlockingChangeRequest(github, remaining)) rejection = 'changes-requested';
  else if (!await hasIndependentApprovalGate(github, approver, revision, humanOwners)) rejection = 'protection';
  if (rejection) {
    const activeApprovals = remaining.filter((review) => readActiveApproval(review, owner, prNumber));
    if (!activeApprovals.length) return `skipped-${rejection}`;
    if (!await isCurrent(github, repository, pull, prNumber, revision)) return 'skipped-stale';
    const reason = rejection === 'changes-requested' ? changeRequestReason : async () => {
      if (!await hasIndependentApprovalGate(github, approver, revision, humanOwners)) return protectionDismissal;
    };
    let dismissed = false;
    for (const review of activeApprovals) {
      if (await dismissApproval(github, approver, pull, review, reason)) dismissed = true;
    }
    return dismissed ? `dismissed-${rejection}` : 'skipped-existing';
  }
  for (const review of remaining) {
    if (readActiveApproval(review, owner, prNumber) && await approvalVerificationFailed(github, review) &&
        await dismissApproval(github, approver, pull, review, verificationDismissal)) withdrawn.add(review.id);
  }
  if (await hasPriorApproval(github, remaining.filter((review) => !withdrawn.has(review?.id)), owner, revision)) {
    return 'skipped-existing';
  }

  if (!await isCurrent(github, repository, pull, prNumber, revision)) return 'skipped-stale';
  const approval = await postApproval(github, approver, pull, reviews, owner, head, body);
  if (approval.state === 'DISMISSED') return 'skipped-existing';

  // The review REST API binds the head commit only. Check the base and PR again after the write.
  let current;
  let blocked;
  try {
    blocked = Boolean(await changeRequestReason());
    current = await isCurrent(github, repository, pull, prNumber, revision, { allowDraft: true });
  } catch (cause) {
    try {
      const pending = await recordPendingDismissal(github, approver, pull, approval);
      await dismissApproval(github, approver, pull, pending, verificationDismissal);
    } catch (dismissalError) {
      throw new AggregateError([cause, dismissalError], `Could not verify or dismiss automatic approval ${approval.id}`);
    }
    throw new Error(`Could not verify automatic approval ${approval.id}; the approval was dismissed`, { cause });
  }
  if (!current && await dismissApproval(github, approver, pull, approval, () => staleReason(revision))) {
    return 'dismissed-stale';
  }
  if (blocked && await dismissApproval(github, approver, pull, approval, changeRequestReason)) {
    return 'dismissed-changes-requested';
  }
  if (await liveProtectionReason() && await dismissApproval(github, approver, pull, approval, liveProtectionReason)) {
    return 'dismissed-protection';
  }
  return 'approved';
}
