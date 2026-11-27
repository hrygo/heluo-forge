import { isSha } from './pr-agent-github.mjs';

const codeOwnersPath = '.github/CODEOWNERS';
const individualOwner = /^@[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu;

function hasRequiredCodeOwner(protection) {
  const reviews = protection?.required_pull_request_reviews;
  const bypass = reviews?.bypass_pull_request_allowances;
  return protection?.enforce_admins?.enabled === true &&
    reviews?.require_code_owner_reviews === true && reviews.dismiss_stale_reviews === true &&
    Number.isSafeInteger(reviews.required_approving_review_count) && reviews.required_approving_review_count >= 1 &&
    (bypass === undefined || (bypass !== null && ['users', 'teams', 'apps'].every((kind) =>
      Array.isArray(bypass[kind]) && bypass[kind].length === 0)));
}

function assignsEveryPathToIndividuals(file, directory) {
  const entry = Array.isArray(directory) && directory.find((item) => item?.path === codeOwnersPath);
  // The Contents API follows symlinks to files. Verify the path's own directory entry.
  if (entry?.type !== 'file' || !isSha(entry.sha) || file?.sha !== entry.sha ||
      file.path !== codeOwnersPath || file.type !== 'file' || file.encoding !== 'base64' ||
      typeof file.content !== 'string') return false;

  const encoded = file.content.replaceAll('\n', '');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length !== file.size || buffer.toString('base64') !== encoded) return false;

  const lines = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer).split(/\r?\n/u);
  const rules = lines.filter((line) => !/^[\t ]*(?:#|$)/u.test(line));
  // This repository uses one catch-all. Every account must be specified by its individual login.
  if (rules.length !== 1) return false;
  const [pattern, ...owners] = rules[0].replace(/^[\t ]+|[\t ]+$/gu, '').split(/[\t ]+/u);
  return pattern === '*' && owners.length > 0 && owners.every((owner) => individualOwner.test(owner));
}

export async function hasIndependentApprovalGate(github, approver, revision) {
  if (revision?.baseRef !== 'main' || !isSha(revision.base)) return false;

  try {
    const protection = await approver.get('/branches/main/protection', 'Read native approval protection');
    if (!hasRequiredCodeOwner(protection)) return false;

    const query = `?ref=${revision.base}`;
    const [directory, file, parser] = await Promise.all([
      github.get(`/contents/.github${query}`, 'Read CODEOWNERS directory'),
      github.get(`/contents/${codeOwnersPath}${query}`, 'Read CODEOWNERS'),
      github.get(`/codeowners/errors${query}`, 'Validate GitHub CODEOWNERS ownership'),
    ]);
    return Array.isArray(parser?.errors) && parser.errors.length === 0 && assignsEveryPathToIndividuals(file, directory);
  } catch {
    return false;
  }
}
