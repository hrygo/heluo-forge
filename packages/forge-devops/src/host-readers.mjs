/** #25/#26: target-host read-only adapters over fixed DOP/gh CLI argv. */
import { createDopReader } from './change-briefing.mjs';
import { GH_JSON_FIELDS, runGh } from './gh-process.mjs';

export class HostReaderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HostReaderError';
    this.code = code;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Fixed runner codes allowed to surface; anything else collapses to CLI_FAILED. */
const RUNNER_CODES = new Set(['BAD_TARGET', 'CLI_NOT_FOUND', 'CLI_FAILED', 'AUTH_FAILED', 'CLI_TIMEOUT', 'CLI_CANCELLED', 'OUTPUT_LIMIT', 'INVALID_JSON', 'INVALID_OPTIONS']);

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const HOSTED_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const REF_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#([1-9]\d*)$/u;
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/u;

function assertHostRepo(repo, allowedHost) {
  if (!HOSTED_REPO_PATTERN.test(repo)) throw new HostReaderError('BAD_REPOSITORY');
  const host = repo.split('/')[0];
  if (host.toLowerCase() !== allowedHost.toLowerCase()) throw new HostReaderError('HOST_MISMATCH');
}

/** Bounded commit list for `[变更号]` prefix checks; null = not returned. */
function normalizeCommits(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 100) throw new HostReaderError('PR_MISMATCH');
  return raw.map((commit) => {
    if (!isRecord(commit) || typeof commit.messageHeadline !== 'string' || commit.messageHeadline.includes('\0')
      || (commit.oid !== undefined && (typeof commit.oid !== 'string' || !REVISION_PATTERN.test(commit.oid)))) {
      throw new HostReaderError('PR_MISMATCH');
    }
    return { oid: commit.oid ?? null, messageHeadline: commit.messageHeadline };
  });
}

function checkFixtureProvenance(raw) {
  const marker = raw?._heluo_fixture;
  if (marker === undefined) return null;
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)
    || marker.kind !== 'fixture' || marker.synthetic !== true) {
    throw new HostReaderError('FOREIGN_PROVENANCE');
  }
  return { kind: 'fixture', synthetic: true, network: false };
}

/**
 * Parse a repository-scoped read target. repository.read takes
 * `HOST/OWNER/REPO`; issue.read and pr.read take `HOST/OWNER/REPO#NUMBER`.
 */
export function parseGhTarget(action, target, allowedHost) {
  if (typeof allowedHost !== 'string' || allowedHost.length === 0 || allowedHost.includes('/')) {
    throw new HostReaderError('BAD_HOST');
  }
  if (typeof target !== 'string' || target.length === 0) throw new HostReaderError('BAD_TARGET');
  if (action === 'repository.read') {
    assertHostRepo(target, allowedHost);
    return { kind: 'repo', repo: target };
  }
  const match = REF_PATTERN.exec(target);
  if ((action !== 'issue.read' && action !== 'pr.read') || !match) throw new HostReaderError('BAD_TARGET');
  assertHostRepo(match[1], allowedHost);
  return { kind: action === 'issue.read' ? 'issue' : 'pr', repo: match[1], number: Number(match[2]) };
}

/**
 * gh read adapter behind the existing `devopsReader` port. Only the three
 * fixed `view --json` shapes are executed; every result is returned as
 * `unknown` with validated facts (never a frozen success claim).
 */
export function createGhReader({ executable, prefixArgs, allowedHost, cwd, env, timeoutMs, maxOutputBytes, signal, runner = runGh } = {}) {
  if (typeof allowedHost !== 'string' || allowedHost.length === 0) throw new HostReaderError('BAD_HOST');
  return Object.freeze({
    async read({ action, target } = {}) {
      const parsed = parseGhTarget(action, target, allowedHost);
      const args = parsed.kind === 'repo'
        ? ['repo', 'view', parsed.repo, '--json', GH_JSON_FIELDS.repo]
        : parsed.kind === 'issue'
          ? ['issue', 'view', String(parsed.number), '--repo', parsed.repo, '--json', GH_JSON_FIELDS.issue]
          : ['pr', 'view', String(parsed.number), '--repo', parsed.repo, '--json', GH_JSON_FIELDS.pr];
      let raw;
      try {
        raw = await runner({ executable, prefixArgs, allowedHost, args, cwd, env, timeoutMs, maxOutputBytes, signal });
      } catch (error) {
        // The message IS the code, so only fixed runner codes may pass through;
        // an untrusted custom runner cannot reflect caller text here.
        throw new HostReaderError(RUNNER_CODES.has(error?.code) ? error.code : 'CLI_FAILED');
      }
      const provenance = checkFixtureProvenance(raw);
      const base = `https://${parsed.repo}`;
      if (parsed.kind === 'repo') {
        if (typeof raw.nameWithOwner !== 'string' || !REPO_PATTERN.test(raw.nameWithOwner)
          || typeof raw.url !== 'string' || raw.url.toLowerCase() !== base.toLowerCase()
          || typeof raw.defaultBranchRef?.name !== 'string' || raw.defaultBranchRef.name.length === 0) {
          throw new HostReaderError('REPOSITORY_MISMATCH');
        }
        return {
          status: 'unknown', source_revision: null, target_ref: target, result_refs: [],
          observed_at: new Date().toISOString(), error_code: 'MISSING_SOURCE_REVISION',
          facts: {
            kind: 'repository', repository: parsed.repo, nameWithOwner: raw.nameWithOwner,
            url: raw.url, isPrivate: raw.isPrivate ?? null,
            defaultBranch: raw.defaultBranchRef.name, ...(provenance ? { provenance } : {}),
          },
        };
      }
      if (parsed.kind === 'issue') {
        if (raw.number !== parsed.number || typeof raw.url !== 'string'
          || raw.url.toLowerCase() !== `${base}/issues/${parsed.number}`.toLowerCase()
          || typeof raw.state !== 'string' || typeof raw.title !== 'string'
          || typeof raw.body !== 'string' || !Array.isArray(raw.closedByPullRequestsReferences)) {
          throw new HostReaderError('ISSUE_MISMATCH');
        }
        for (const ref of raw.closedByPullRequestsReferences) {
          if (!Number.isSafeInteger(ref?.number) || ref.number <= 0
            || typeof ref?.url !== 'string' || ref.url.toLowerCase() !== `${base}/pull/${ref.number}`.toLowerCase()) {
            throw new HostReaderError('CROSS_REPOSITORY_PR');
          }
        }
        return {
          status: 'unknown', source_revision: null, target_ref: target, result_refs: [],
          observed_at: new Date().toISOString(), error_code: 'MISSING_SOURCE_REVISION',
          facts: {
            kind: 'issue', repository: parsed.repo, number: raw.number, state: raw.state,
            title: raw.title, body: raw.body, url: raw.url,
            closingPullRequests: raw.closedByPullRequestsReferences.map((ref) => ({ number: ref.number, url: ref.url })),
            ...(provenance ? { provenance } : {}),
          },
        };
      }
      if (typeof raw.url !== 'string' || raw.url.toLowerCase() !== `${base}/pull/${parsed.number}`.toLowerCase()
        || raw.number !== parsed.number || typeof raw.state !== 'string'
        || typeof raw.headRefOid !== 'string' || !REVISION_PATTERN.test(raw.headRefOid)) {
        throw new HostReaderError('PR_MISMATCH');
      }
      // `commits` is optional on the read: absent means "not returned", never
      // "no commits". Present-but-malformed is a mismatch, not partial trust.
      const commits = normalizeCommits(raw.commits);
      return {
        status: 'unknown', source_revision: null, target_ref: target, result_refs: [],
        observed_at: new Date().toISOString(), error_code: 'MISSING_SOURCE_REVISION',
        facts: {
          kind: 'pr', repository: parsed.repo, number: raw.number, state: raw.state,
          title: typeof raw.title === 'string' ? raw.title : null, url: raw.url,
          headRefOid: raw.headRefOid, baseRefName: typeof raw.baseRefName === 'string' ? raw.baseRefName : null,
          mergedAt: typeof raw.mergedAt === 'string' ? raw.mergedAt : null,
          commits,
          ...(provenance ? { provenance } : {}),
        },
      };
    },
  });
}

/**
 * One `devopsReader` port implementation routing change.read to DOP and the
 * three repository reads to gh. Policy ownership stays with the caller.
 */
export function createHostReader({ dopOptions = {}, ghOptions = {}, dopReader, ghReader } = {}) {
  const dop = dopReader ?? createDopReader(dopOptions);
  const gh = ghReader ?? createGhReader(ghOptions);
  return Object.freeze({
    async read({ action, target } = {}) {
      if (action === 'change.read') return dop.read({ action, target });
      if (action === 'repository.read' || action === 'issue.read' || action === 'pr.read') {
        return gh.read({ action, target });
      }
      throw new HostReaderError('UNSUPPORTED_ACTION');
    },
  });
}
