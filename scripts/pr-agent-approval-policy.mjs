import { isSha, pages, validId } from './pr-agent-github.mjs';

const codeOwnersPath = '.github/CODEOWNERS';
const githubLogin = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

function parseHumanLogins(configuredHumanLogins) {
  if (typeof configuredHumanLogins !== 'string') return null;
  const logins = configuredHumanLogins.split(',').map((login) => login.replace(/^[\t ]+|[\t ]+$/gu, ''));
  if (!logins.every((login) => githubLogin.test(login))) return null;
  return new Set(logins.map((login) => login.toLowerCase()));
}

function hasNoCustomActors(rule) {
  return rule === undefined || (rule !== null && ['users', 'teams', 'apps'].every((kind) =>
    Array.isArray(rule[kind]) && rule[kind].length === 0));
}

function hasRequiredCodeOwner(protection) {
  const reviews = protection?.required_pull_request_reviews;
  return protection?.enforce_admins?.enabled === true &&
    reviews?.require_code_owner_reviews === true && reviews.dismiss_stale_reviews === true &&
    // A higher review count can let the App's approval occupy an additional review slot.
    reviews.required_approving_review_count === 1 && reviews.require_last_push_approval === false &&
    hasNoCustomActors(reviews.bypass_pull_request_allowances) &&
    // With standard dismissal permissions, the approval App can withdraw its stale approvals.
    hasNoCustomActors(reviews.dismissal_restrictions);
}

function permitsIndependentApproval(rule) {
  if (typeof rule?.type !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(rule.type)) return false;
  if (rule.type !== 'pull_request') return true;
  const parameters = rule.parameters;
  if (!parameters || ![0, 1].includes(parameters.required_approving_review_count) ||
      parameters.require_last_push_approval !== false) return false;

  const extraApproval = parameters.require_extra_approval_for_unattributed_changes;
  const reviewers = parameters.required_reviewers;
  const dismissal = parameters.dismissal_restriction;
  return (extraApproval === undefined || extraApproval === false) &&
    (reviewers === undefined || (Array.isArray(reviewers) && reviewers.every((reviewer) => reviewer?.minimum_approvals === 0))) &&
    (dismissal === undefined || dismissal?.enabled === false);
}

function catchAllHumanOwners(file, directory, humanLogins) {
  const entry = Array.isArray(directory) && directory.find((item) => item?.path === codeOwnersPath);
  // The Contents API follows symlinks to files. Verify the path's own directory entry.
  if (entry?.type !== 'file' || !isSha(entry.sha) || file?.sha !== entry.sha ||
      file.path !== codeOwnersPath || file.type !== 'file' || file.encoding !== 'base64' ||
      typeof file.content !== 'string') return null;

  const encoded = file.content.replaceAll('\n', '');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length !== file.size || buffer.toString('base64') !== encoded) return null;

  const lines = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer).split(/\r?\n/u);
  const rules = lines.filter((line) => !/^[\t ]*(?:#|$)/u.test(line));
  // The allowlist attests to human ownership. A GitHub user account can also be a machine account.
  if (rules.length !== 1) return null;
  const [pattern, ...owners] = rules[0].replace(/^[\t ]+|[\t ]+$/gu, '').split(/[\t ]+/u);
  if (pattern !== '*' || owners.length === 0) return null;

  const logins = new Set();
  for (const owner of owners) {
    const login = owner.slice(1);
    if (!owner.startsWith('@') || !githubLogin.test(login)) return null;
    const normalizedLogin = login.toLowerCase();
    if (!humanLogins.has(normalizedLogin)) return null;
    logins.add(normalizedLogin);
  }
  return logins;
}

async function hasCodeOwnerWriteAccess(github, login) {
  const access = await github.get(`/collaborators/${encodeURIComponent(login)}/permission`, 'Read code owner repository permission');
  const user = access?.user;
  return user?.type === 'User' && validId(user.id) && typeof user.login === 'string' && githubLogin.test(user.login) &&
    user.login.toLowerCase() === login && ['write', 'maintain', 'admin'].includes(access.permission);
}

export async function hasLiveApprovalProtection(approver) {
  try {
    if (!hasRequiredCodeOwner(await approver.get('/branches/main/protection', 'Read native approval protection'))) return false;
    // Active rulesets layer with classic branch protection, including organization-level rulesets.
    for await (const rule of pages(approver, '/rules/branches/main', 'Active main branch rules')) {
      if (!permitsIndependentApproval(rule)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function hasIndependentApprovalGate(github, approver, revision, configuredHumanLogins) {
  const humanLogins = parseHumanLogins(configuredHumanLogins);
  if (!humanLogins || revision?.baseRef !== 'main' || !isSha(revision.base) ||
      !await hasLiveApprovalProtection(approver)) return false;
  try {
    const query = `?ref=${revision.base}`;
    const [directory, file, parser] = await Promise.all([
      github.get(`/contents/.github${query}`, 'Read CODEOWNERS directory'),
      github.get(`/contents/${codeOwnersPath}${query}`, 'Read CODEOWNERS'),
      github.get(`/codeowners/errors${query}`, 'Validate GitHub CODEOWNERS ownership'),
    ]);
    if (!Array.isArray(parser?.errors) || parser.errors.length !== 0) return false;
    const owners = catchAllHumanOwners(file, directory, humanLogins);
    if (!owners) return false;
    const access = await Promise.all(Array.from(owners, (login) => hasCodeOwnerWriteAccess(github, login)));
    return access.every((allowed) => allowed);
  } catch {
    return false;
  }
}
