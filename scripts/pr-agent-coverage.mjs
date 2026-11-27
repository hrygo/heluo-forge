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
  if (!['modified', 'added', 'removed'].includes(file.status) ||
      typeof file.patch !== 'string' || !file.patch.isWellFormed()) return false;
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

const gitPathEscapes = {
  '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r',
  '"': '\\"', '\\': '\\\\',
};

function gitDiffPath(path) {
  const bytes = Buffer.from(path).toString('latin1');
  const escaped = bytes.replace(/[\u0000-\u001f"\\\u007f-\u00ff]/gu, (character) =>
    gitPathEscapes[character] ?? '\\' + character.charCodeAt(0).toString(8).padStart(3, '0'));
  return bytes === escaped ? path : '"' + escaped + '"';
}

function comparablePatch(patch) {
  // GitHub can shorten the optional hunk heading differently in the two representations.
  return patch.replace(/(^|\n)(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(?: [^\n]*)?\r?(?=\n|$)/gu, '$1$2');
}

function matchesDiffFile(lines, { file, left, right }) {
  // A modified regular file has its unchanged mode on the index line. Additions and deletions
  // can introduce or remove a default regular file, whose content is covered from/to /dev/null.
  const added = file.status === 'added';
  const removed = file.status === 'removed';
  if (added && lines.shift() !== 'new file mode 100644') return false;
  if (removed && lines.shift() !== 'deleted file mode 100644') return false;
  if (!added && !removed && file.status !== 'modified') return false;
  const index = /^index ([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})(?: (100644|100755))?$/u.exec(lines.shift());
  if (!index) return false;
  const [, oldBlob, newBlob, mode] = index;
  if (Boolean(mode) !== (file.status === 'modified') || oldBlob === newBlob ||
      /^0+$/u.test(oldBlob) !== added || /^0+$/u.test(newBlob) !== removed) return false;
  const from = '--- ' + (added ? '/dev/null' : left);
  const to = '+++ ' + (removed ? '/dev/null' : right);
  const fromLine = lines.shift();
  const toLine = lines.shift();
  if ((fromLine !== from && fromLine !== from + '\t') || (toLine !== to && toLine !== to + '\t')) return false;
  return comparablePatch(lines.join('\n')) === comparablePatch(file.patch.replace(/\n$/u, '') + '\n');
}

// The REST files patches contain only hunks. Bind each raw Git header to the same file and hunks
// already checked against the review proof, so absent or truncated metadata cannot authorize approval.
export function verifyReviewFileModes(diff, files) {
  if (typeof diff !== 'string' || !diff.endsWith('\n')) return false;
  const sections = diff.split(/(?<=\n)(?=diff --git )/u);
  if (sections.length !== files.length) return false;
  const expected = new Map(files.map((file) => {
    const left = gitDiffPath('a/' + file.filename);
    const right = gitDiffPath('b/' + file.filename);
    return ['diff --git ' + left + ' ' + right, { file, left, right }];
  }));
  for (const section of sections) {
    const [header, ...lines] = section.split('\n');
    const candidate = expected.get(header);
    if (!candidate || !matchesDiffFile(lines, candidate)) return false;
    expected.delete(header);
  }
  return expected.size === 0;
}
