import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isBranch, isSha, validId } from './pr-agent-github.mjs';
import { parseReviewPatch } from './pr-agent-review-comments.mjs';

const repositoryName = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/u;
const positiveDecimal = /^[1-9][0-9]*$/u;
const recommendations = new Set(['changes_required', 'needs_review', 'no_concerns_found']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesInvocation(proof, options) {
  const { repository, prNumber, head, base, baseRef, runId, runAttempt, invocation, review } = options;
  return isObject(proof) && proof.version === 1 &&
    typeof runId === 'string' && positiveDecimal.test(runId) && proof.runId === runId &&
    typeof runAttempt === 'string' && positiveDecimal.test(runAttempt) && proof.runAttempt === runAttempt &&
    ['initial', 'retry'].includes(invocation) && proof.invocation === invocation &&
    typeof repository === 'string' && repositoryName.test(repository) && validId(prNumber) &&
    isSha(head) && isSha(base) && isBranch(baseRef) &&
    isObject(proof.pr) && proof.pr.provider === 'github' && proof.pr.repo === repository &&
    proof.pr.number === prNumber && proof.pr.head === head && proof.pr.base === base && proof.pr.baseRef === baseRef &&
    isObject(review) && typeof review.merge_recommendation === 'string' &&
    recommendations.has(review.merge_recommendation.trim()) && isDeepStrictEqual(proof.review, review);
}

function patchMatches(file, manifest) {
  // The pinned renderer omits previous paths and EOF markers from its review prompt.
  if (file.status === 'renamed' || typeof file.patch !== 'string' || !file.patch.isWellFormed()) return false;
  const { hunks, complete, hasNoNewlineMarker } = parseReviewPatch(file.patch);
  if (!complete || !hunks.length || hasNoNewlineMarker) return false;
  const leftHash = createHash('sha256');
  const rightHash = createHash('sha256');
  let deletions = 0;
  let additions = 0;
  let previousLeftEnd = 1;
  let previousRightEnd = 1;
  for (const { LEFT: left, RIGHT: right } of hunks) {
    if (!left.lines.length && !right.lines.length) return false;
    // A zero-length range names the previous line. Shift it to the insertion/deletion position.
    const leftOffset = left.start === left.end ? 1 : 0;
    const rightOffset = right.start === right.end ? 1 : 0;
    const leftGap = left.start + leftOffset - previousLeftEnd;
    const rightGap = right.start + rightOffset - previousRightEnd;
    if (leftGap < 0 || leftGap !== rightGap) return false;
    previousLeftEnd = left.end + leftOffset;
    previousRightEnd = right.end + rightOffset;
    deletions += left.lines.length;
    additions += right.lines.length;
    for (const { number, text } of left.lines) leftHash.update(`${number}\t${text}\n`);
    for (const { number, text } of right.lines) rightHash.update(`${number}\t${text}\n`);
  }
  return deletions === file.deletions && additions === file.additions &&
    leftHash.digest('hex') === manifest.left && rightHash.digest('hex') === manifest.right;
}

export function verifyReviewCoverage(proof, options) {
  if (!isObject(options) || !matchesInvocation(proof, options)) return false;
  const { files, changedFileCount } = options;
  if (!validId(changedFileCount) || !Array.isArray(files) || files.length !== changedFileCount ||
      !Array.isArray(proof.files) || proof.files.length !== changedFileCount) return false;

  const manifest = new Map();
  for (const entry of proof.files) {
    if (!isObject(entry) || typeof entry.path !== 'string' || !entry.path || manifest.has(entry.path)) return false;
    manifest.set(entry.path, entry);
  }
  for (const file of files) {
    if (!isObject(file) || !manifest.has(file.filename) || !patchMatches(file, manifest.get(file.filename))) return false;
    manifest.delete(file.filename);
  }
  return manifest.size === 0;
}
