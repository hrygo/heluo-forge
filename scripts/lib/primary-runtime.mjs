/**
 * The primary runtime ledger and what the staging script derives from it
 * (CORP-DSH-PLAN-026 §4.3 P2-4).
 *
 * The payload the desktop app ships is upstream's: a relocatable directory of
 * standalone Node.js, pnpm and CPython with the Office authoring libraries,
 * described by a `runtime.json` that upstream's own tool reads. Upstream pins
 * every archive in `scripts/primary-runtime/lock.json`; this repository keeps a
 * byte-identical copy of that lock, derives the download list for one target
 * the way upstream's builder does, and holds the small decisions the staging
 * script needs while assembling the payload. Nothing here reaches the network.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** The schema `services/forge-desktop/primary-runtime-lock.json` declares. */
export const LEDGER_SCHEMA = 'heluo-primary-runtime-lock/1';

/** Upstream tags each release `dsh-v<version>`; the version is `.dsh-version`. */
export const UPSTREAM_TAG_PREFIX = 'dsh-v';

/** The targets upstream's lock covers, as the platform and architecture the payload declares. */
export const TARGETS = Object.freeze({
  'win-x64': Object.freeze({ platform: 'win32', arch: 'x64' }),
  'mac-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64' }),
  'mac-x64': Object.freeze({ platform: 'darwin', arch: 'x64' }),
  'linux-x64': Object.freeze({ platform: 'linux', arch: 'x64' }),
  'linux-arm64': Object.freeze({ platform: 'linux', arch: 'arm64' }),
});

const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u;
const isVersion = (value) => typeof value === 'string' && VERSION.test(value);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Ledger and assembly failures carry a stable category so callers can diagnose them. */
export class PrimaryRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrimaryRuntimeError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new PrimaryRuntimeError(code, message);
};

/** Why a list of locked wheels cannot be downloaded and verified, or an empty list. */
function wheelProblems(wheels, label) {
  if (!Array.isArray(wheels)) return [`${label} wheels are not a list`];
  return wheels.flatMap((wheel, index) => {
    if (!isRecord(wheel) || typeof wheel.url !== 'string' || !/^https:\/\/[^/]+\//u.test(wheel.url)) return [`${label} wheel ${index + 1} has no https URL`];
    if (!SHA256.test(wheel.sha256 ?? '')) return [`${label} wheel ${basename(wheel.url)} has no SHA-256`];
    return [];
  });
}

/** Why the upstream lock cannot build a payload for every target, or an empty list. */
export function lockProblems(lock) {
  if (!isRecord(lock)) return ['the lock is not an object'];
  const problems = [];
  if (!isVersion(lock.nodeVersion)) problems.push('nodeVersion is not a version');
  if (!isVersion(lock.pythonVersion)) problems.push('pythonVersion is not a version');
  if (typeof lock.pythonRelease !== 'string' || !/^\d+$/u.test(lock.pythonRelease)) problems.push('pythonRelease is not a release id');
  if (!isRecord(lock.pythonPackages) || Object.keys(lock.pythonPackages).length === 0) problems.push('pythonPackages is empty');
  for (const [name, version] of Object.entries(isRecord(lock.pythonPackages) ? lock.pythonPackages : {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || typeof version !== 'string' || !/^\d[\w.!+-]*$/u.test(version)) problems.push(`pythonPackages.${name} is not a distribution version`);
  }
  for (const target of Object.keys(TARGETS)) {
    const artifact = isRecord(lock.targets) ? lock.targets[target] : undefined;
    if (!isRecord(artifact)) {
      problems.push(`target ${target} is missing`);
      continue;
    }
    if (typeof artifact.nodeArchive !== 'string' || artifact.nodeArchive === '') problems.push(`target ${target} names no Node.js archive`);
    if (!SHA256.test(artifact.nodeSha256 ?? '')) problems.push(`target ${target} locks no Node.js digest`);
    if (typeof artifact.pythonTarget !== 'string' || artifact.pythonTarget === '') problems.push(`target ${target} names no CPython target`);
    if (!SHA256.test(artifact.pythonSha256 ?? '')) problems.push(`target ${target} locks no CPython digest`);
    problems.push(...wheelProblems(artifact.wheels, `target ${target}`));
  }
  problems.push(...wheelProblems(lock.wheels, 'shared'));
  return problems;
}

/**
 * The upstream lock as this repository pinned it. The copy inside the ledger
 * must hash to the file the ledger names, so an edited copy cannot pass for
 * upstream's lock; `verifyPinnedLock` is what compares that file with upstream.
 */
export function readPinnedLock(ledger) {
  if (!isRecord(ledger) || ledger.schema !== LEDGER_SCHEMA) fail('LOCK_INVALID', 'the primary runtime ledger does not declare its schema');
  const { upstream, lock } = ledger;
  if (!isRecord(upstream) || typeof upstream.repository !== 'string' || typeof upstream.path !== 'string' || !SHA256.test(upstream.sha256 ?? '')) {
    fail('LOCK_INVALID', 'the primary runtime ledger names no upstream file and digest');
  }
  if (!isRecord(lock)) fail('LOCK_INVALID', 'the primary runtime ledger carries no upstream lock');
  if (sha256(`${JSON.stringify(lock, undefined, 2)}\n`) !== upstream.sha256) {
    fail('LOCK_TAMPERED', 'the lock inside the ledger is not the upstream file the ledger names');
  }
  const problems = lockProblems(lock);
  if (problems.length > 0) fail('LOCK_INVALID', `the upstream lock cannot build a payload: ${problems.join('; ')}`);
  return lock;
}

/**
 * Every archive one target's payload is made of, with the URL and the SHA-256
 * upstream's lock gives it. Derived the way upstream's builder derives them.
 */
export function lockedArchives(lock, target) {
  if (TARGETS[target] === undefined) fail('BAD_TARGET', `unknown target ${String(target)}; expected one of ${Object.keys(TARGETS).join(', ')}`);
  const artifact = lock.targets[target];
  const node = `node-v${lock.nodeVersion}-${artifact.nodeArchive}`;
  const python = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`;
  return [
    {
      kind: 'node',
      name: node,
      url: `https://nodejs.org/dist/v${lock.nodeVersion}/${node}`,
      sha256: artifact.nodeSha256,
    },
    {
      kind: 'python',
      name: python,
      url: `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(python)}`,
      sha256: artifact.pythonSha256,
    },
    ...[...artifact.wheels, ...lock.wheels].map((wheel) => ({ kind: 'wheel', name: basename(wheel.url), url: wheel.url, sha256: wheel.sha256 })),
  ];
}

/** Where upstream publishes the lock for one dsh version. */
export function upstreamLockUrl(ledger, dshVersion) {
  const { repository, path } = ledger.upstream;
  return `https://raw.githubusercontent.com/${repository}/${UPSTREAM_TAG_PREFIX}${dshVersion}/${path}`;
}

/**
 * What one payload is made of, as one digest: the target, the versions and the
 * digest of every archive. Two payloads with the same digest carry the same
 * bytes whatever machine built them or when.
 */
export function payloadDigest({ target, lock, pnpmVersion, archives }) {
  return sha256(JSON.stringify({
    format: 1,
    target,
    node: lock.nodeVersion,
    python: lock.pythonVersion,
    pythonRelease: lock.pythonRelease,
    pnpm: pnpmVersion,
    pythonPackages: lock.pythonPackages,
    archives: archives.map(({ kind, name, sha256: digest }) => [kind, name, digest]),
  }));
}

/** The `runtime.json` upstream's tool validates, in the field order upstream writes it. */
export function buildManifest({ lock, target, version, pnpmVersion, digest }) {
  const { platform, arch } = TARGETS[target];
  return {
    desktopVersion: version,
    platform,
    arch,
    payloadDigest: digest,
    python: lock.pythonVersion,
    node: lock.nodeVersion,
    pnpm: pnpmVersion,
    pythonPackages: lock.pythonPackages,
  };
}

/**
 * Whether an npm `os` or `cpu` field admits a value, the way npm's install
 * checks read it; a field that is absent admits every value. This is what
 * decides which of the native packages bundled in the pnpm archive a target keeps.
 */
export function acceptsNpmPlatform(value, current) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) fail('PNPM_MANIFEST_INVALID', 'npm platform constraints must be arrays of strings');
  let accepted = value.every((tag) => tag.startsWith('!'));
  for (const tag of value) {
    if (tag === `!${current}`) return false;
    if (tag === current || (tag === 'any' && value.length === 1)) accepted = true;
  }
  return accepted;
}

/**
 * Why a wheel member cannot be unpacked where it lies, or an empty string.
 * A wheel may carry console scripts; any other installation scheme would have
 * to be redirected by an installer, and there is none here. The `.data`
 * directory of a wheel on its own names no scheme and is fine.
 */
export function wheelEntryProblem(path) {
  const [directory, scheme] = path.split('/');
  return directory !== undefined && directory.endsWith('.data') && scheme !== undefined && scheme !== '' && scheme !== 'scripts'
    ? `the wheel requires an installation path this payload cannot provide: ${path}`
    : '';
}

/**
 * The rows of a wheel RECORD: `path,hash,size` for every file the wheel
 * installed. A row is read only in that plain form; a quoted or ragged row is
 * refused, because pruning on a misread path would leave the record wrong.
 * Wheels built on Windows end their rows with CRLF; the row is the same row.
 */
export function parseRecord(text) {
  if (typeof text !== 'string') fail('RECORD_INVALID', 'RECORD must be text');
  return text.split('\n').filter((line) => line !== '' && line !== '\r').map((raw, index) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const fields = line.split(',');
    if (fields.length !== 3 || fields[0] === undefined || fields[0] === '' || line.startsWith('"')) {
      fail('RECORD_INVALID', `RECORD row ${index + 1} is not a plain path,hash,size row`);
    }
    return [fields[0], fields[1], fields[2]];
  });
}

/** The RECORD rows that name a file outside the removed directories. */
export function retainRecordRows(rows, removed) {
  return rows.filter(([path]) => !removed.some((directory) => path.startsWith(`${directory}/`)));
}

/** The RECORD as wheels write it: one row per line, LF, a final newline. */
export function formatRecord(rows) {
  return `${rows.map((row) => row.join(',')).join('\n')}\n`;
}
