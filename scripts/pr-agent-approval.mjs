import { parseReceipt as readChangeRequestReceipt } from './pr-agent-change-request.mjs';
import { hasIndependentApprovalGate } from './pr-agent-approval-policy.mjs';
import { isBranch, isCurrent, isSha, listReviews, pages, readPull, sameUser, validId } from './pr-agent-github.mjs';

const approvalPrefix = '<!-- heluo-forge-pr-agent-approval:v1';
const approvalSummary = '洛神自动审批。完整审查未发现 P0、P1 或 P2 问题。';
const verificationDismissal = '洛神未能核对发布后的状态，撤销本次自动审批。';
const protectionDismissal = '洛神未能核对人工审批要求，撤销自动审批。';
const ineligibleDismissal = '当前审查结论不满足自动审批条件，撤销此前的洛神自动审批。';
const changeRequestDismissal = '维护者已请求修改，撤销洛神自动审批。';
const staleDismissal = 'PR 或目标分支版本已变化，洛神自动审批已过期。';
const receiptPattern = new RegExp(`^${approvalPrefix} ([1-9][0-9]*) (\\S+) (\\S+) ([A-Za-z0-9_-]+) -->$`, 'u');

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
        ![verificationDismissal, protectionDismissal, ineligibleDismissal].includes(dismissal.dismissal_message)) return true;
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

function matchesApproval(review, owner, head, body) {
  return validId(review?.id) && sameBot(review.user, owner) && review.commit_id === head && review.body === body;
}

async function postApproval(github, approver, pull, reviews, owner, head, body) {
  const newApproval = (review) => matchesApproval(review, owner, head, body) &&
    !reviews.some((prior) => prior?.id === review.id);
  try {
    const review = await approver.post(`${pull}/reviews`, { event: 'APPROVE', commit_id: head, body });
    if (newApproval(review) && review.state === 'APPROVED') return review;
  } catch {
    // A lost response can follow a committed write. Recover only from the review history.
  }

  const recovered = (await listReviews(github, pull)).filter((review) => newApproval(review) &&
    ['APPROVED', 'DISMISSED'].includes(review.state));
  if (recovered.length === 1) return recovered[0];
  throw new Error('Could not confirm the automatic approval after submitting it to GitHub');
}

async function dismissApproval(github, approver, pull, review, message) {
  const url = `${pull}/reviews/${review.id}`;
  const matches = (item) => matchesApproval(item, review.user, review.commit_id, review.body) && item.id === review.id;
  const current = await github.get(url);
  if (!matches(current) || !['APPROVED', 'DISMISSED'].includes(current.state)) {
    throw new Error(`Could not verify automatic approval ${review.id} before dismissal`);
  }
  if (current.state === 'DISMISSED') return;

  try {
    const dismissed = await approver.put(`${url}/dismissals`, { event: 'DISMISS', message });
    if (matches(dismissed) && dismissed.state === 'DISMISSED') return;
  } catch {
    // Confirm an already applied dismissal by reading the exact review.
  }
  const observed = await github.get(url);
  if (!matches(observed) || observed.state !== 'DISMISSED') {
    throw new Error(`Could not confirm dismissal of automatic approval ${review.id}`);
  }
}

export async function reconcileMainApprovals({ github, approver, appSlug }) {
  const owner = await readApprovalBot(github, approver, appSlug);
  let dismissed = 0;
  const errors = [];
  for await (const pr of pages(github, '/pulls?state=open&base=main', 'Open main pull requests')) {
    const prNumber = pr?.number;
    if (!validId(prNumber)) throw new Error('Invalid open pull request');
    const pull = `/pulls/${prNumber}`;
    try {
      for (const review of await listReviews(github, pull)) {
        const receipt = readActiveApproval(review, owner, prNumber);
        if (!receipt || await isCurrent(github, github.repository, pull, prNumber, receipt)) continue;
        await dismissApproval(github, approver, pull, review, staleDismissal);
        dismissed++;
      }
    } catch (cause) {
      errors.push(new Error(`Could not reconcile Luoshen approvals for PR #${prNumber}`, { cause }));
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Could not reconcile all Luoshen approvals');
  return dismissed;
}

export async function publishApproval({ github, approver, revision, appSlug, runId, allowApproval = true }) {
  const { repository, serverUrl } = github;
  const { prNumber, head, base, baseRef } = revision;
  if (typeof allowApproval !== 'boolean') throw new Error('Invalid automatic approval verdict');
  if (!validId(prNumber) || !isSha(head) || !isSha(base) || !isBranch(baseRef)) {
    throw new Error('Invalid automatic approval revision');
  }
  if (typeof runId !== 'string' || !/^[1-9][0-9]*$/u.test(runId)) throw new Error('Invalid automatic approval run ID');
  if (typeof repository !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(repository)) {
    throw new Error('Invalid automatic approval repository');
  }
  const server = new URL(serverUrl);
  if (server.protocol !== 'https:' || server.username || server.password || server.href !== `${server.origin}/`) {
    throw new Error('Invalid automatic approval server URL');
  }

  const owner = await readApprovalBot(github, approver, appSlug);

  const pull = `/pulls/${prNumber}`;
  const pr = await readPull(github, pull, prNumber);
  if (!validId(pr.user?.id)) throw new Error('Invalid pull request author');
  if (pr.user.id === owner.id) return 'skipped-self';

  const reviewUrl = `${server.origin}/${repository}/actions/runs/${runId}`;
  const marker = `${approvalPrefix} ${prNumber} ${head} ${base} ${Buffer.from(baseRef).toString('base64url')} -->`;
  const body = [
    approvalSummary,
    `[查看 GitHub Actions 审查运行](${reviewUrl})`,
    marker,
  ].join('\n\n');
  const previousReviews = await listReviews(github, pull);
  if (!await isCurrent(github, repository, pull, prNumber, revision)) return 'skipped-stale';

  const withdrawn = new Set();
  for (const review of previousReviews) {
    const receipt = readActiveApproval(review, owner, prNumber);
    if (!receipt || (allowApproval && matchesRevision(receipt, revision))) continue;
    const message = allowApproval ? staleDismissal : ineligibleDismissal;
    await dismissApproval(github, approver, pull, review, message);
    withdrawn.add(review.id);
  }
  if (!allowApproval) return withdrawn.size ? 'dismissed-ineligible' : 'skipped-ineligible';

  const reviews = await listReviews(github, pull);
  const remaining = reviews.filter((review) => !withdrawn.has(review?.id));
  let rejection;
  if (await hasBlockingChangeRequest(github, remaining)) rejection = 'changes-requested';
  else if (!await hasIndependentApprovalGate(github, approver, revision)) rejection = 'protection';
  if (rejection) {
    const activeApprovals = remaining.filter((review) => readActiveApproval(review, owner, prNumber));
    if (!activeApprovals.length) return `skipped-${rejection}`;
    if (!await isCurrent(github, repository, pull, prNumber, revision)) return 'skipped-stale';
    const message = rejection === 'changes-requested' ? changeRequestDismissal : protectionDismissal;
    for (const review of activeApprovals) await dismissApproval(github, approver, pull, review, message);
    return `dismissed-${rejection}`;
  }
  if (await hasPriorApproval(github, remaining, owner, revision)) return 'skipped-existing';

  if (!await isCurrent(github, repository, pull, prNumber, revision)) return 'skipped-stale';
  const approval = await postApproval(github, approver, pull, reviews, owner, head, body);
  if (approval.state === 'DISMISSED') return 'skipped-existing';

  // The review REST API binds the head commit only. Check the base and PR again after the write.
  let current;
  let blocked;
  try {
    blocked = await hasBlockingChangeRequest(github, await listReviews(github, pull));
    current = await isCurrent(github, repository, pull, prNumber, revision);
  } catch (cause) {
    try {
      await dismissApproval(github, approver, pull, approval, verificationDismissal);
    } catch (dismissalError) {
      throw new AggregateError([cause, dismissalError], `Could not verify or dismiss automatic approval ${approval.id}`);
    }
    throw new Error(`Could not verify automatic approval ${approval.id}; the approval was dismissed`, { cause });
  }
  if (!current) {
    await dismissApproval(github, approver, pull, approval, staleDismissal);
    return 'dismissed-stale';
  }
  if (blocked) {
    await dismissApproval(github, approver, pull, approval, changeRequestDismissal);
    return 'dismissed-changes-requested';
  }
  return 'approved';
}
