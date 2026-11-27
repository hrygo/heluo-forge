const sha = /^[a-f0-9]{40}$/u;

export function validId(id) {
  return Number.isSafeInteger(id) && id > 0;
}

export function isSha(value) {
  return typeof value === 'string' && sha.test(value);
}

export function isBranch(ref) {
  return typeof ref === 'string' && ref.length > 0 &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]|\.\.|@\{/u.test(ref) && !ref.endsWith('.') &&
    ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

export function sameUser(left, right) {
  return validId(left?.id) && left.id === right?.id && left.login === right.login &&
    left.type === 'User' && right.type === 'User' && /^[a-zA-Z0-9_-]+$/u.test(left.login ?? '');
}

export async function* pages(github, path, label) {
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= 100; page++) {
    const rows = await github.get(`${path}${separator}per_page=100&page=${page}`, label);
    if (!Array.isArray(rows)) throw new Error(`Invalid ${label.toLowerCase()} response`);
    yield* rows;
    if (rows.length < 100) return;
  }
  throw new Error(`${label} exceeds the pagination limit`);
}

export async function listReviews(github, pull) {
  const reviews = [];
  for await (const review of pages(github, `${pull}/reviews`, 'Pull request review list')) reviews.push(review);
  return reviews;
}

export async function readPull(github, pull, prNumber) {
  const pr = await github.get(pull);
  if (pr?.number !== prNumber || !['open', 'closed'].includes(pr.state) || typeof pr.draft !== 'boolean' ||
      !isSha(pr.head?.sha) || !isBranch(pr.base?.ref) ||
      ![pr.head.repo, pr.base.repo].every((repo) => repo === null || typeof repo?.full_name === 'string')) {
    throw new Error('Invalid pull request revision response');
  }
  return pr;
}

function matchesPull(pr, repository, revision) {
  return pr.state === 'open' && !pr.draft &&
    pr.head.repo?.full_name === repository && pr.base.repo?.full_name === repository &&
    pr.head.sha === revision.head && pr.base.ref === revision.baseRef;
}

export async function targetTip(github, ref, label) {
  const reference = await github.get(`/git/ref/heads/${encodeURIComponent(ref)}`, label);
  if (reference?.ref !== `refs/heads/${ref}` || reference.object?.type !== 'commit' ||
      !isSha(reference.object.sha)) throw new Error('Invalid target branch revision');
  return reference.object.sha;
}

export async function isCurrent(github, repository, pull, prNumber, revision, observed) {
  const first = observed ?? await readPull(github, pull, prNumber);
  if (!matchesPull(first, repository, revision)) return false;
  let base;
  let readError;
  try {
    base = await targetTip(github, revision.baseRef);
  } catch (error) {
    readError = error;
  }
  // A retarget can remove the first ref. The second PR read distinguishes it from a ref API failure.
  const latest = await readPull(github, pull, prNumber);
  if (!matchesPull(latest, repository, revision)) return false;
  if (readError) throw readError;
  return base === revision.base && await targetTip(github, revision.baseRef) === revision.base;
}
