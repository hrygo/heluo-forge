/**
 * Release-resource audit for the staged `@napi-rs/keyring` addons.
 *
 * The addons never enter Git (`.gitignore` ignores
 * `packages/forge-credentials-keychain/vendor/<triple>/`), so "which native
 * files must ship" is recorded only in
 * `vendor/CHECKSUMS.json`. Issue #216 is the consequence of nobody reading that
 * record at build or verification time: a clean checkout produced a tarball with
 * the manifest but no addons, all gates stayed green, and the enterprise profile
 * failed closed at mount on the target machine.
 *
 * This module is the one place that turns that record into a verdict. It is pure
 * over a `read(relative)` callback so the same rule runs against a staging
 * directory (build preflight), an archive (artifact verification) and a fixture
 * tree (tests) without a second copy of the logic.
 *
 * A verdict is a list of findings, not prose: callers decide how to report them.
 * A record that is not part of the release file set is itself a finding, because
 * "the record exists on disk" and "the record ships" are different facts, and
 * only the second one lets the artifact gate see anything at all.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Archive-relative position of the record inside the shipping package. */
export const NATIVE_CHECKSUMS = 'vendor/CHECKSUMS.json';

/** This package requires a record even when the entire vendor directory is absent. */
export const NATIVE_KEYCHAIN_PACKAGE = '@heluo/forge-credentials-keychain';

/** Third-party license that must travel with every staged addon. */
export const NATIVE_LICENSE = 'LICENSE.third-party.md';

const SHA256 = /^[0-9a-f]{64}$/u;

/** A recorded key is one directory plus one file name; nothing else. */
const RECORDED = /^[^/\\]+\/[^/\\]+$/u;

/** Findings that a `fetch-native-keyring.mjs` run can resolve. */
const FETCHABLE = new Set(['missing', 'size', 'sha256', 'license', 'license-size', 'license-sha256']);

const fail = (message) => {
  throw new Error(`native resources: ${message}`);
};

/** A recorded path may not walk out of `vendor/`; `..` would read the package. */
const isUnsafePath = (relative) => !RECORDED.test(relative) || relative.split('/').some((part) => part === '.' || part === '..');

/**
 * Parse one `CHECKSUMS.json` document.
 *
 * A malformed record is an error rather than a skip: silently ignoring an entry
 * would let a typo turn a required addon into an unshipped one.
 *
 * @param {string} text
 * @param {{ label?: string }} [options]
 */
export function parseNativeChecksums(text, options = {}) {
  const label = options.label ?? NATIVE_CHECKSUMS;
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`${label}: not valid JSON (${String(error.message).split('\n')[0]})`);
  }
  const files = document?.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) fail(`${label}: files must be an object`);
  const records = {};
  for (const [relative, entry] of Object.entries(files)) {
    if (isUnsafePath(relative)) fail(`${label}: unsafe recorded path ${relative}`);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label}: ${relative} must be an object`);
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) fail(`${label}: ${relative} needs a lowercase sha256`);
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) fail(`${label}: ${relative} needs a positive byte count`);
    if (typeof entry.licenseSha256 !== 'string' || !SHA256.test(entry.licenseSha256)) fail(`${label}: ${relative} needs a lowercase license sha256`);
    if (!Number.isInteger(entry.licenseBytes) || entry.licenseBytes <= 0) fail(`${label}: ${relative} needs a positive license byte count`);
    if (entry.relative !== undefined && entry.relative !== relative) fail(`${label}: ${relative} records a different relative path`);
    const sameTriple = Object.keys(records).find((path) => path.split('/')[0] === relative.split('/')[0]);
    if (sameTriple !== undefined && (records[sameTriple].licenseSha256 !== entry.licenseSha256 || records[sameTriple].licenseBytes !== entry.licenseBytes)) {
      fail(`${label}: ${relative} has inconsistent license metadata`);
    }
    records[relative] = entry;
  }
  return { records, triples: triplesOf(records) };
}

/** Delivery triples claimed by a record set, in stable order. */
function triplesOf(records) {
  return [...new Set(Object.keys(records).map((relative) => relative.split('/')[0]))].sort();
}

/**
 * Audit a record set against a byte source.
 *
 * @param {{
 *   records: Record<string, { sha256: string, bytes: number, licenseSha256: string, licenseBytes: number }>,
 *   read: (relative: string) => Buffer | undefined,
 *   list?: () => string[],
 *   requireLicense?: boolean,
 * }} options
 * @returns {Array<{ kind: string, relative?: string, triple?: string, expected?: number, actual?: number }>}
 *   findings; empty means the record set is satisfied
 */
export function auditNativeRecords({ records, read, list = () => [], requireLicense = true }) {
  const findings = [];
  const relatives = Object.keys(records).sort();
  if (relatives.length === 0) return [{ kind: 'empty' }];
  for (const relative of relatives) {
    const expected = records[relative];
    const bytes = read(relative);
    if (bytes === undefined) {
      findings.push({ kind: 'missing', relative });
      continue;
    }
    if (bytes.length !== expected.bytes) findings.push({ kind: 'size', relative, expected: expected.bytes, actual: bytes.length });
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected.sha256) findings.push({ kind: 'sha256', relative, expected: expected.sha256, actual });
  }
  for (const relative of list().sort()) {
    if (relative.endsWith('.node') && !Object.hasOwn(records, relative)) findings.push({ kind: 'unrecorded', relative });
  }
  if (requireLicense) {
    for (const triple of triplesOf(records)) {
      const relative = `${triple}/${NATIVE_LICENSE}`;
      const bytes = read(relative);
      if (bytes === undefined) {
        findings.push({ kind: 'license', triple });
        continue;
      }
      const expected = records[relatives.find((path) => path.startsWith(`${triple}/`))];
      if (bytes.length !== expected.licenseBytes) findings.push({ kind: 'license-size', relative, expected: expected.licenseBytes, actual: bytes.length });
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected.licenseSha256) findings.push({ kind: 'license-sha256', relative, expected: expected.licenseSha256, actual });
    }
  }
  return findings;
}

/**
 * One-line report of a finding list, grouped by cause.
 *
 * Grouping keeps a clean checkout to one readable line instead of repeating the
 * record path once per missing file, which is what a per-finding `join('; ')`
 * produced in CI logs.
 */
export function describeNativeFindings(findings) {
  const parts = [];
  const of = (kind) => findings.filter((finding) => finding.kind === kind);
  if (of('empty').length > 0) parts.push('CHECKSUMS.json declares no native resource, so an empty vendor directory would look satisfied');
  if (of('undeclared').length > 0) parts.push('vendor/ is not part of the release files, so neither the record nor its addons ship; add "vendor" to files');
  if (of('vendor-only').length > 0) parts.push('vendor/ ships without CHECKSUMS.json; it cannot be audited');
  if (of('record-missing').length > 0) parts.push('vendor/CHECKSUMS.json is missing from the keychain package');
  const missing = of('missing').map((finding) => finding.relative);
  if (missing.length > 0) parts.push(`${missing.length} recorded file(s) missing: ${missing.join(', ')}`);
  const licenses = of('license').map((finding) => finding.triple);
  if (licenses.length > 0) parts.push(`${licenses.length} addon license(s) missing: ${licenses.join(', ')}`);
  const unrecorded = of('unrecorded').map((finding) => finding.relative);
  if (unrecorded.length > 0) parts.push(`${unrecorded.length} unrecorded native file(s): ${unrecorded.join(', ')}`);
  for (const finding of [...of('size'), ...of('license-size')]) parts.push(`${finding.relative}: ${finding.actual} bytes, recorded ${finding.expected}`);
  for (const finding of [...of('sha256'), ...of('license-sha256')]) parts.push(`${finding.relative}: sha256 ${finding.actual} does not match the recorded ${finding.expected}`);
  return parts.join('; ');
}

/** The staging command only helps when bytes or licenses are what is missing. */
export function nativeFetchHint(findings) {
  return findings.some((finding) => FETCHABLE.has(finding.kind)) ? ' Run node scripts/fetch-native-keyring.mjs, then build again.' : '';
}

/**
 * Build preflight: audit a package's own staging directory.
 *
 * A package that ships no `vendor/CHECKSUMS.json` has nothing to declare and is
 * not this rule's business. A package that has one must both ship it
 * (`releaseFiles` covers `vendor/`) and satisfy every line of it.
 *
 * @param {{ dir: string, label: string, releaseFiles: string[] }} options
 * @returns {ReturnType<typeof auditNativeRecords>}
 */
export function auditStagedNativeResources({ dir, label, releaseFiles }) {
  if (!Array.isArray(releaseFiles)) throw new Error('native resources: releaseFiles must be an array');
  const checksums = join(dir, NATIVE_CHECKSUMS);
  if (!existsSync(checksums)) {
    // A `vendor/` directory without the record cannot be audited, and shipping it
    // would hand the terminal an unverifiable directory. Refuse instead of guessing.
    if (existsSync(join(dir, 'vendor'))) return [{ kind: 'vendor-only' }];
    return label === NATIVE_KEYCHAIN_PACKAGE ? [{ kind: 'record-missing' }] : [];
  }
  // The record and the addons are only worth auditing when the build would
  // actually copy them: a record left out of `files` is invisible to the
  // artifact gate, which is the exact blind spot issue #216 exposed.
  const ships = releaseFiles.some((entry) => entry === 'vendor' || entry === 'vendor/');
  const { records } = parseNativeChecksums(readFileSync(checksums, 'utf8'), { label: `${label} ${NATIVE_CHECKSUMS}` });
  const list = (relative = '') => readdirSync(join(dir, 'vendor', relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    return entry.isDirectory() ? list(path) : entry.isFile() ? [path] : [];
  });
  const findings = auditNativeRecords({
    records,
    list,
    read: (relative) => {
      const path = join(dir, 'vendor', relative);
      return existsSync(path) ? readFileSync(path) : undefined;
    },
  });
  return ships ? findings : [{ kind: 'undeclared' }, ...findings];
}

/**
 * Artifact verification: audit records already packed inside a tarball.
 *
 * `read` receives a path relative to the record's own directory.
 *
 * @param {{ label: string, content: Buffer, read: (relative: string) => Buffer | undefined }} options
 * @returns {ReturnType<typeof auditNativeRecords>}
 */
export function auditPackagedNativeResources({ label, content, read, list }) {
  const { records } = parseNativeChecksums(content.toString('utf8'), { label });
  return auditNativeRecords({ records, read, list });
}

/**
 * Cross-check a committed record against the pinned lock file.
 *
 * This needs no addon bytes, so it runs in the offline CI. It catches what only
 * the release machine used to catch: a hand-edited record, a lock bump that
 * forgot the record, and a triple one document knows and the other does not.
 * Byte-level truth still belongs to `fetch-native-keyring.mjs --check`, which
 * hashes the staged files; this only proves the two documents describe the same
 * release.
 *
 * @param {{ record: unknown, lock: unknown, label?: string }} options
 * @returns {string[]} problems; empty means the documents agree
 */
export function auditRecordAgainstLock({ record, lock, label = NATIVE_CHECKSUMS }) {
  const problems = [];
  const note = (message) => problems.push(`${label}: ${message}`);
  if (record === null || typeof record !== 'object') return [`${label}: the record is not an object`];
  if (lock === null || typeof lock !== 'object') return [`${label}: the lock file is not an object`];
  if (!Array.isArray(lock.targets)) return [`${label}: the lock file has no targets array`];
  const files = record.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return [`${label}: files must be an object`];
  if (record.package !== lock.package) note(`package ${String(record.package)} does not match the lock file ${String(lock.package)}`);
  if (record.version !== lock.version) note(`version ${String(record.version)} does not match the lock file ${String(lock.version)}`);
  const expected = new Map(lock.targets.map((target) => [`${target.triple}/keyring.node`, target]));
  for (const [relative, entry] of Object.entries(files)) {
    const target = expected.get(relative);
    if (target === undefined) {
      note(`${relative} is not pinned by the lock file`);
      continue;
    }
    expected.delete(relative);
    if (entry === null || typeof entry !== 'object') {
      note(`${relative} must be an object`);
      continue;
    }
    for (const field of ['source', 'version', 'integrity', 'license']) {
      if (entry[field] !== target[field]) note(`${relative} records ${field} ${String(entry[field])} but the lock file pins ${String(target[field])}`);
    }
    if (entry.relative !== undefined && entry.relative !== relative) note(`${relative} records a different relative path`);
  }
  for (const relative of expected.keys()) note(`${relative} is pinned by the lock file but missing from the record`);
  return problems;
}
