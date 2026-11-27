import { parseReceipt as readChangeRequestReceipt } from './pr-agent-change-request.mjs';
import { isBranch, isCurrent, isSha, listReviews, readPull, sameUser, validId } from './pr-agent-github.mjs';

const approvalPrefix = '<!-- heluo-forge-pr-agent-approval:v1';
const approvalSummary = '洛神自动审批。完整审查未发现 P0、P1 或 P2 问题。';
const receiptPattern = new RegExp(`^${approvalPrefix} ([1-9][0-9]*) (\\S+) (\\S+) ([A-Za-z0-9_-]+) -->$`, 'u');

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

function matchesRevision(receipt, revision) {
  return receipt.prNumber === revision.prNumber && receipt.head === revision.head &&
    receipt.base === revision.base && receipt.baseRef === revision.baseRef;
}

async function hasBlockingChangeRequest(github, reviews, owner, excludedId) {
  const latestByReviewer = new Map();
  // GitHub returns reviews in chronological order. Comments and dismissed reviews do not decide.
  for (const review of reviews) {
    if (!validId(review?.id) || review.id === excludedId) continue;
    const { state, user } = review;
    if (state === 'CHANGES_REQUESTED' && user?.id === 41898282 &&
        user.login === 'github-actions[bot]' && user.type === 'Bot' && readChangeRequestReceipt(review)) return true;
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(state) && sameUser(user, user)) latestByReviewer.set(user.id, review);
  }

  for (const { state, user } of latestByReviewer.values()) {
    if (state !== 'CHANGES_REQUESTED') continue;
    if (sameUser(user, owner)) return true;
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
  return validId(review?.id) && sameUser(review.user, owner) && review.commit_id === head && review.body === body;
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

export async function publishApproval({ github, approver, revision, approverLogin, runId, allowApproval = true }) {
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

  const owner = await approver.getUser();
  if (!sameUser(owner, { id: owner?.id, login: approverLogin, type: 'User' })) {
    throw new Error('Unexpected automatic approval approver identity');
  }

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
  let reviews = await listReviews(github, pull);
  if (!await isCurrent(github, repository, pull, prNumber, revision)) return 'skipped-stale';

  const withdrawn = new Set();
  for (const review of reviews) {
    if (review?.state !== 'APPROVED' || !sameUser(review.user, owner)) continue;
    const receipt = readApprovalReceipt(review, prNumber);
    if (!receipt || (allowApproval && matchesRevision(receipt, revision))) continue;
    const message = allowApproval
      ? 'PR 或目标分支版本已变化，洛神自动审批已过期。'
      : '当前审查结论不满足自动审批条件，撤销此前的洛神自动审批。';
    await dismissApproval(github, approver, pull, review, message);
    withdrawn.add(review.id);
  }
  if (!allowApproval) return withdrawn.size ? 'dismissed-ineligible' : 'skipped-ineligible';
  if (withdrawn.size) reviews = await listReviews(github, pull);

  const remaining = reviews.filter((review) => !withdrawn.has(review?.id));
  if (await hasBlockingChangeRequest(github, remaining, owner)) return 'skipped-changes-requested';
  const alreadyReviewed = remaining.some((review) => {
    if (!sameUser(review?.user, owner) || review.commit_id !== head) return false;
    if (review.state === 'APPROVED') return true;
    const receipt = review.state === 'DISMISSED' && readApprovalReceipt(review, prNumber);
    return receipt && matchesRevision(receipt, revision);
  });
  if (alreadyReviewed) return 'skipped-existing';

  if (!await isCurrent(github, repository, pull, prNumber, revision)) return 'skipped-stale';
  const approval = await postApproval(github, approver, pull, reviews, owner, head, body);
  if (approval.state === 'DISMISSED') return 'skipped-existing';

  // The review REST API binds the head commit only. Check the base and PR again after the write.
  let current;
  let blocked;
  try {
    blocked = await hasBlockingChangeRequest(github, await listReviews(github, pull), owner, approval.id);
    current = await isCurrent(github, repository, pull, prNumber, revision);
  } catch (cause) {
    try {
      await dismissApproval(github, approver, pull, approval, '洛神未能核对发布后的状态，撤销本次自动审批。');
    } catch (dismissalError) {
      throw new AggregateError([cause, dismissalError], `Could not verify or dismiss automatic approval ${approval.id}`);
    }
    throw new Error(`Could not verify automatic approval ${approval.id}; the approval was dismissed`, { cause });
  }
  if (!current) {
    await dismissApproval(github, approver, pull, approval, 'PR 或目标分支版本已变化，洛神自动审批已过期。');
    return 'dismissed-stale';
  }
  if (blocked) {
    await dismissApproval(github, approver, pull, approval, '维护者已请求修改，撤销本次洛神自动审批。');
    return 'dismissed-changes-requested';
  }
  return 'approved';
}
