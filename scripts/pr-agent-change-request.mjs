import { randomUUID } from 'node:crypto';
import { isBranch, isCurrent, listReviews, readPull, sameUser, validId } from './pr-agent-github.mjs';

const bot = 'github-actions[bot]';
const shaPattern = '[a-f0-9]{40}';
const commandPattern = new RegExp(`^/request-changes (P[01]) (${shaPattern}) (${shaPattern}) (\\S+)$`, 'u');
const publicationPattern = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const receiptPrefix = '<!-- heluo-forge-pr-agent-request-changes:v2';
const receiptPattern = new RegExp(
  `^${receiptPrefix} (pending|confirmed|stale) (${publicationPattern}) (P[01]) (${shaPattern}) (${shaPattern}) ([A-Za-z0-9_-]+) ([1-9][0-9]*) -->$`,
  'u',
);
const legacyReceiptPattern = new RegExp(`<!-- heluo-forge-pr-agent-priority-rc:v1 (${shaPattern}) (${shaPattern}) -->$`, 'u');
const pendingBanner = '**本次修改请求的 PR 版本尚待确认。**';
const staleBanner = '**此修改请求已过期。请仓库维护者解除此 GitHub 修改请求。**';

export function parseChangeRequest(body) {
  const match = typeof body === 'string' && commandPattern.exec(body.trim());
  if (match && isBranch(match[4])) return { priority: match[1], head: match[2], base: match[3], baseRef: match[4] };
}

function commentIsOnPull(comment, repository, prNumber) {
  if (typeof comment?.issue_url !== 'string') return false;
  try {
    const url = new URL(comment.issue_url);
    return url.pathname.endsWith(`/repos/${repository}/issues/${prNumber}`);
  } catch {
    return false;
  }
}

async function authorize(github, repository, prNumber, command, event) {
  const comment = event?.comment;
  const actual = parseChangeRequest(comment?.body);
  if (event?.action !== 'created' || event.repository?.full_name !== repository ||
      event.issue?.number !== prNumber || !event.issue?.pull_request ||
      !validId(comment?.id) || !sameUser(event.sender, comment.user) ||
      !actual || actual.priority !== command.priority || actual.head !== command.head ||
      actual.base !== command.base || actual.baseRef !== command.baseRef) {
    return false;
  }
  const current = await github.get(`/issues/comments/${comment.id}`);
  if (current?.id !== comment.id || current.body !== comment.body ||
      !sameUser(current.user, event.sender) || !commentIsOnPull(current, repository, prNumber)) return false;
  const access = await github.get(`/collaborators/${encodeURIComponent(event.sender.login)}/permission`);
  return sameUser(access?.user, event.sender) && ['write', 'maintain', 'admin'].includes(access.permission);
}

function isBotReview(review) {
  return validId(review?.id) && review.user?.login === bot && typeof review.body === 'string' &&
    ['CHANGES_REQUESTED', 'DISMISSED'].includes(review.state);
}

export function parseReceipt(review) {
  if (!isBotReview(review)) return;
  const body = review.body.trimEnd();
  const match = receiptPattern.exec(body.split('\n').at(-1));
  if (!match) return;
  const [, state, publication, priority, head, base, encodedRef, sourceComment] = match;
  const baseRef = Buffer.from(encodedRef, 'base64url').toString('utf8');
  const commentId = Number(sourceComment);
  if (review.commit_id !== head || !isBranch(baseRef) || !validId(commentId) ||
      Buffer.from(baseRef).toString('base64url') !== encodedRef ||
      (state === 'pending' && !body.startsWith(`${pendingBanner}\n\n`)) ||
      (state === 'stale' && !body.startsWith(`${staleBanner}\n\n`))) return;
  return { state, publication, priority, head, base, baseRef, commentId };
}

function parseLegacyReceipt(review) {
  if (!isBotReview(review)) return;
  const match = legacyReceiptPattern.exec(review.body.trimEnd());
  if (match && review.commit_id === match[1]) return { head: match[1], base: match[2] };
}

export function isActiveLuoshenChangeRequest(review) {
  return review?.state === 'CHANGES_REQUESTED' && review.user?.id === 41898282 && review.user.type === 'Bot' &&
    Boolean(parseReceipt(review) || parseLegacyReceipt(review));
}

function renderReceipt(receipt, state) {
  const { publication, priority, head, base, baseRef, commentId } = receipt;
  const encodedRef = Buffer.from(baseRef).toString('base64url');
  return `${receiptPrefix} ${state} ${publication} ${priority} ${head} ${base} ${encodedRef} ${commentId} -->`;
}

function matchesReview(review, expected, body) {
  return isBotReview(review) && review.id === expected.id && review.commit_id === expected.commit_id &&
    review.body.trimEnd() === body;
}

async function recoverReview(github, pull, repository, prNumber, review, receipt) {
  if (review.state === 'DISMISSED') return 'dismissed';
  const url = `${pull}/reviews/${review.id}`;
  let current;
  try {
    current = await isCurrent(github, repository, pull, prNumber, receipt);
  } catch (cause) {
    throw new Error(`Could not verify the PR revision for pending change request ${review.id}`, { cause });
  }

  if (!current) {
    try {
      const dismissed = await github.put(`${url}/dismissals`, {
        event: 'DISMISS',
        message: 'PR 或目标分支版本已变化，本次修改请求已过期。',
      });
      if (dismissed?.id === review.id && dismissed.state === 'DISMISSED') return 'dismissed';
    } catch {
      // Check the exact review before falling back after an uncertain or denied dismissal.
    }
    const observed = await github.get(url);
    if (matchesReview(observed, review, review.body.trimEnd()) && observed.state === 'DISMISSED') return 'dismissed';
    if (!matchesReview(observed, review, review.body.trimEnd())) {
      throw new Error(`Could not establish the state of stale change request ${review.id}`);
    }
  }

  const [, , ...lines] = review.body.trimEnd().split('\n');
  const nextState = current ? 'confirmed' : 'stale';
  lines[lines.length - 1] = renderReceipt(receipt, nextState);
  const body = current ? lines.join('\n') : [staleBanner, '', ...lines].join('\n');
  let updated;
  try {
    updated = await github.put(url, { body });
    if (!matchesReview(updated, review, body)) throw new Error('Unexpected review update response');
  } catch (cause) {
    throw new Error(`Could not settle ${nextState} change request ${review.id}`, { cause });
  }
  if (updated.state === 'DISMISSED') return 'dismissed';
  if (!current) throw new Error(`Stale change request ${review.id} requires maintainer dismissal`);
  return 'confirmed';
}

export async function handleChangeRequests({ github, prNumber, command, event }) {
  const repository = github.repository ?? event?.repository?.full_name;
  const number = Number(prNumber);
  if (!validId(number) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository ?? '')) {
    throw new Error('Invalid pull request location');
  }
  const pull = `/pulls/${number}`;
  const reviews = await listReviews(github, pull);

  const receipts = reviews.flatMap((review) => {
    const receipt = parseReceipt(review);
    return receipt ? [{ review, receipt }] : [];
  });
  const errors = [];
  for (const { review, receipt } of receipts) {
    if (receipt.state !== 'pending' || review.state !== 'CHANGES_REQUESTED') continue;
    try {
      await recoverReview(github, pull, repository, number, review, receipt);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Could not recover pending change requests');
  if (!command) return { status: 'reconciled' };
  if (!await authorize(github, repository, number, command, event)) return { status: 'rejected' };

  const pr = await readPull(github, pull, number);
  const { priority, head, base, baseRef } = command;
  const revision = { head, base, baseRef };
  if (!await isCurrent(github, repository, pull, number, revision, { observed: pr })) return { status: 'rejected' };
  const commentId = event.comment.id;
  if (reviews.some((review) => {
    const legacy = parseLegacyReceipt(review);
    return legacy?.head === head && legacy.base === base;
  }) ||
      receipts.some(({ receipt }) => receipt.commentId === commentId ||
        (receipt.state !== 'stale' && receipt.head === head && receipt.base === base && receipt.baseRef === revision.baseRef))) {
    return { status: 'duplicate' };
  }
  const receipt = { ...revision, publication: randomUUID(), priority, commentId };
  const server = github.serverUrl ?? 'https://github.com';
  const source = `${server}/${repository}/pull/${number}#issuecomment-${commentId}`;
  const body = [
    pendingBanner,
    '',
    `仓库维护者为本次 PR 修订发起 **${priority}** 修改请求。请查看[指令评论](${source})，修复后重新审查。`,
    '',
    renderReceipt(receipt, 'pending'),
  ].join('\n');
  const matchesPublication = (review) => isBotReview(review) && review.commit_id === head && review.body.trimEnd() === body;
  let review;
  try {
    review = await github.post(`${pull}/reviews`, { event: 'REQUEST_CHANGES', commit_id: head, body });
    if (!matchesPublication(review)) throw new Error('Unexpected change request response');
  } catch (cause) {
    let matching;
    try {
      matching = (await listReviews(github, pull)).filter(matchesPublication);
    } catch (readError) {
      throw new Error(`Could not establish change request publication ${receipt.publication}`, { cause: readError });
    }
    // A lost response may follow an accepted write. Never repeat the POST here.
    if (matching.length !== 1) throw new Error(`Could not establish change request publication ${receipt.publication}`, { cause });
    [review] = matching;
  }
  const status = await recoverReview(github, pull, repository, number, review, receipt);
  return { status, reviewId: review.id };
}
