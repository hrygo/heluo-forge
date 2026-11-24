import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { fail } from './errors.mjs';

// Same names as the unified build writes (`scripts/build-employee-package.mjs`
// and `scripts/release-delivery.mjs`). The contract test beside the repository
// tests keeps them from drifting.
export const EMPLOYEE_PACKAGE_SCHEMA = 'heluo-employee-package/1';
export const MANIFEST_FILE = 'employee-manifest.json';
export const SUMS_FILE = 'SHA256SUMS';
export const INSTALLER_PATH = 'installer/init-enterprise-plugin.mjs';
/** The one file of the package that may be gone: the installer removes it once the secret is in the store. */
export const CLIENT_SECRET_PATH = 'enterprise-plugin/iam-client-secret.txt';
const RELEASE_SIDECAR = 'enterprise-plugin/private-release.json';
const MARKER_SCHEMA = 'heluo-first-run/1';

const SUM_LINE = /^([0-9a-f]{64})  (.+)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
// Inside the package only: no absolute path, no `..` segment, no empty segment.
const WITHIN_PACKAGE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[^\0\r\n]+$/u;

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** True when nothing, not even a link, sits at `path`. */
function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether `relative` names a regular file reached without following a link.
 * Every component inside the package is checked: a listed path that is, or
 * passes through, a symbolic link would be read, verified and then used from
 * wherever the link points, outside the package.
 */
function regularFileWithin(root, relative) {
  let info;
  let current = root;
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    try {
      info = lstatSync(current);
    } catch {
      return false;
    }
    if (info.isSymbolicLink()) return false;
  }
  return info.isFile();
}

/**
 * Read an employee package and prove it is intact: the manifest names the
 * enterprise plugin, the digest list covers every file the shell will rely on,
 * and every listed file is a regular file of the package with its digest. Any
 * doubt is reported; the caller refuses the directory.
 *
 * Trust model: the digests prove the package is as it was written, nothing
 * more. The manifest and the digest list carry no signature, so whoever can
 * rewrite the package can rewrite both; the shell's own code sits in the same
 * install directory and relies on the same protection. Integrity here is
 * guarded by the distribution channel and the install location, not by this
 * check (design §6).
 *
 * @returns {{ok: true, manifest: object, manifestDigest: string, installerPath: string,
 *   pluginDirectory: string} | {ok: false, problems: string[]}}
 */
export function inspectEmployeePackage(directory) {
  const root = resolve(directory);
  const problems = [];
  const required = [MANIFEST_FILE, SUMS_FILE, INSTALLER_PATH, RELEASE_SIDECAR];
  for (const relative of required) {
    if (!regularFileWithin(root, relative)) problems.push(`${relative} is missing or not a regular file of the package`);
  }
  if (problems.length > 0) return { ok: false, problems };

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
  } catch {
    return { ok: false, problems: [`${MANIFEST_FILE} is not valid JSON`] };
  }
  if (manifest?.schema !== EMPLOYEE_PACKAGE_SCHEMA) return { ok: false, problems: [`${MANIFEST_FILE} is not an employee package manifest`] };
  const enterprise = Array.isArray(manifest.packages) ? manifest.packages.find((pkg) => pkg?.role === 'enterprise') : undefined;
  if (enterprise === undefined || typeof enterprise.file !== 'string' || !SHA256.test(enterprise.sha256 ?? '')) {
    return { ok: false, problems: [`${MANIFEST_FILE} names no enterprise plugin`] };
  }

  const listed = new Map();
  for (const line of readFileSync(join(root, SUMS_FILE), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const match = SUM_LINE.exec(line);
    if (match === null) {
      problems.push(`${SUMS_FILE} has a malformed line`);
      continue;
    }
    if (!WITHIN_PACKAGE.test(match[2]) || isAbsolute(match[2])) {
      problems.push(`${SUMS_FILE} names a path outside the package`);
      continue;
    }
    if (listed.has(match[2])) problems.push(`${match[2]} is listed twice in ${SUMS_FILE}`);
    listed.set(match[2], match[1]);
  }
  // The digest list cannot list itself; everything else the shell relies on must be in it.
  for (const relative of [...required, enterprise.file]) {
    if (relative !== SUMS_FILE && !listed.has(relative)) problems.push(`${relative} is not covered by ${SUMS_FILE}`);
  }
  for (const [relative, digest] of listed) {
    if (!regularFileWithin(root, relative)) {
      // The client secret is gone once the installer has stored it. Anything
      // else must be a regular file of the package: missing is not accepted,
      // and neither is a link that leads out of it.
      if (relative === CLIENT_SECRET_PATH && absent(join(root, relative))) continue;
      problems.push(`${relative} is missing, or reached through a symbolic link`);
    } else if (digestOf(readFileSync(join(root, relative))) !== digest) problems.push(`${relative} does not match its digest`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    manifest,
    manifestDigest: digestOf(readFileSync(join(root, MANIFEST_FILE))),
    installerPath: join(root, INSTALLER_PATH),
    pluginDirectory: join(root, 'enterprise-plugin'),
  };
}

/**
 * The digest of the package manifest, or null when there is no manifest. Read
 * alone, it is not proof of anything: it identifies a package that was already
 * verified and installed, so that a package whose first run is done is not
 * inspected again. (The installer removes the client secret file it consumed.)
 */
export function manifestDigestOf(directory) {
  try {
    return digestOf(readFileSync(join(resolve(directory), MANIFEST_FILE)));
  } catch {
    return null;
  }
}

/**
 * The package the shell works from: the first candidate that carries an
 * employee package manifest, with the digest of that manifest. Identification
 * only; it proves nothing about the rest of the package.
 *
 * One candidate, one identity. The digest returned here is the one the record
 * of the first run is compared with and written from, so a package that is
 * identified and then found broken is reported as such and never swapped for
 * a later candidate.
 */
export function identifyEmployeePackage({ candidates = [] } = {}) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const manifestDigest = manifestDigestOf(candidate);
    if (manifestDigest !== null) return { directory: resolve(candidate), manifestDigest };
  }
  return null;
}

/**
 * The identified package, verified whole. Without a package there is nothing
 * to initialize the profile from (`ASSETS_NOT_FOUND`); a package that is not
 * intact is refused (`ASSETS_INVALID`).
 */
export function locateEnterpriseAssets({ candidates = [] } = {}) {
  const identified = identifyEmployeePackage({ candidates });
  if (identified === null) fail('ASSETS_NOT_FOUND', 'no employee package was found');
  const inspected = inspectEmployeePackage(identified.directory);
  if (!inspected.ok) fail('ASSETS_INVALID', 'the employee package is not intact', { problems: inspected.problems });
  return { ...identified, ...inspected };
}

/** The record of a completed first run, or null when there is none that can be trusted. */
export function readFirstRunMarker(path) {
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    if (marker?.schema === MARKER_SCHEMA && typeof marker.manifestDigest === 'string' && typeof marker.profile === 'string') return marker;
  } catch {
    // No marker, or not a file: the first run has not happened.
  }
  return null;
}

/**
 * Whether the profile must be initialized from scratch: never done, or last
 * done from a different package or for a different profile. A package that
 * cannot even be identified counts as not done.
 */
export function firstRunNeeded({ markerPath, manifestDigest, profile }) {
  const marker = readFirstRunMarker(markerPath);
  return marker === null || marker.manifestDigest !== manifestDigest || marker.profile !== profile;
}

/** Write the record of a completed first run and read it back; null if it did not land. */
export function writeFirstRunMarker(path, { manifestDigest, profile }) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ schema: MARKER_SCHEMA, manifestDigest, profile }, null, 2)}\n`, { mode: 0o600 });
  return readFirstRunMarker(path);
}

/**
 * Initialize the profile from the employee package, through the installer that
 * ships inside it. The installer owns every write: the plugin install, the
 * client secret, the artifact record. The shell only decides that it runs, and
 * refuses to continue unless its verdict is success.
 *
 * @param {{assets: object, runInit: Function, env: object, exec: Function, profile: string, dsh: string}} input
 *   `dsh` is the executable the installer is allowed to run; `exec` starts it.
 */
export async function initializeProfile({ assets, runInit, env, exec, profile, dsh }) {
  if (typeof runInit !== 'function' || typeof dsh !== 'string' || dsh === '') {
    fail('BAD_ARGUMENT', 'initializing the profile needs the installer and the embedded runtime');
  }
  const outcome = await runInit({
    argv: ['--release', assets.pluginDirectory, '--profile', profile, '--dsh', dsh, '--json'],
    env,
    exec,
  });
  const code = typeof outcome?.result?.error?.code === 'string' ? outcome.result.error.code : 'UNKNOWN';
  if (outcome?.code !== 0 || outcome?.result?.ok !== true) {
    // Only the installer's code is repeated: its text carries paths and host output.
    fail('FIRST_RUN_FAILED', `the enterprise profile could not be initialized (${code})`, { code });
  }
  return outcome.result;
}
