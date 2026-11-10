#!/usr/bin/env node
/**
 * #37 / ADR-12: offline verification of a built enterprise bundle.
 *
 * Verification is deliberately separate from the build: the same command has to
 * work on an archived artifact copied to the target machine, where the staging
 * directory and `npm pack` output no longer exist. Bytes are the only input.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundleEntries, summarizeBundle } from './lib/bundle-archive.mjs';
import { createBundleManifest, diffBundleManifest, parseBundleManifest } from './lib/bundle-manifest.mjs';
import { auditPackagedNativeResources, describeNativeFindings, NATIVE_CHECKSUMS, NATIVE_KEYCHAIN_PACKAGE } from './lib/native-resources.mjs';

const MANIFEST_FILE = 'bundle-manifest.json';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const USAGE = 'usage: node scripts/verify-enterprise-bundle.mjs <tarball> [--manifest <json>] [--json]';

const shown = (path) => `package/${path}`;
const stripPrefix = (message, prefix) => String(message).replace(new RegExp(`^${prefix}`, 'u'), '');

/** Structural rules that must hold with or without a manifest. */
function inspectBundle(entries) {
  const errors = [];
  const files = new Map(entries.map((entry) => [entry.path, entry]));
  const readManifest = (path) => {
    try {
      return JSON.parse(files.get(path).content.toString('utf8'));
    } catch {
      errors.push(`${shown(path)}: not valid JSON`);
      return null;
    }
  };
  const rootEntry = files.get('package.json');
  const root = rootEntry === undefined ? null : readManifest('package.json');
  if (rootEntry === undefined) errors.push(`${shown('package.json')}: missing`);
  if (root !== null) {
    if (typeof root.name !== 'string' || root.name === '') errors.push(`${shown('package.json')}: missing name`);
    if (typeof root.version !== 'string' || root.version === '') errors.push(`${shown('package.json')}: missing version`);
  }
  // Every shipped package manifest, with the directory its bin targets resolve against.
  const manifests = [{ dir: '', label: shown('package.json'), pkg: root }];
  const members = new Map();
  if (root !== null && typeof root.name === 'string' && typeof root.version === 'string') members.set(root.name, root.version);
  for (const entry of entries) {
    if (entry.path === 'package.json' || !/(?:^|\/)package\.json$/u.test(entry.path)) continue;
    const label = shown(entry.path);
    const pkg = readManifest(entry.path);
    if (pkg === null) continue;
    manifests.push({ dir: entry.path.slice(0, entry.path.length - 'package.json'.length), label, pkg });
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string') members.set(pkg.name, pkg.version);
  }
  // Regression cover for the #37 defect: a `workspace:` spec never reaches a terminal.
  for (const { label, pkg } of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) {
        if (typeof spec === 'string' && spec.includes('workspace:')) errors.push(`${label}: unclosed ${field} ${name} (${spec})`);
      }
    }
  }
  for (const entry of entries) {
    if (/(?:^|\/)(?:test|tests)\//u.test(entry.path) || /\.test\.[cm]?js$/u.test(entry.path)) errors.push(`${shown(entry.path)}: must not ship tests`);
  }
  // Issue #216: a package that records native resources must ship them. This is
  // the only check that can reject an artifact built elsewhere, because it reads
  // nothing but the archive bytes.
  for (const entry of entries) {
    if (entry.path !== NATIVE_CHECKSUMS && !entry.path.endsWith(`/${NATIVE_CHECKSUMS}`)) continue;
    const vendorPrefix = entry.path.slice(0, entry.path.length - 'CHECKSUMS.json'.length);
    const label = shown(entry.path);
    try {
      const findings = auditPackagedNativeResources({
        label,
        content: entry.content,
        read: (relative) => files.get(`${vendorPrefix}${relative}`)?.content,
        list: () => [...files.keys()].filter((path) => path.startsWith(vendorPrefix)).map((path) => path.slice(vendorPrefix.length)),
      });
      if (findings.length > 0) errors.push(`${label}: ${describeNativeFindings(findings)}`);
    } catch (error) {
      // A defective record is an artifact verdict, not a usage error: keep the
      // "inspectBundle returns error lines" invariant so the CLI exits 1.
      errors.push(`${label}: ${String(error.message).replace(/^native resources: /u, '').replace(`${label}: `, '')}`);
    }
  }
  for (const { dir, pkg } of manifests) {
    if (pkg?.name === NATIVE_KEYCHAIN_PACKAGE && !files.has(`${dir}${NATIVE_CHECKSUMS}`)) {
      errors.push(`${shown(`${dir}${NATIVE_CHECKSUMS}`)}: required native resource record missing`);
    }
  }
  for (const { dir, label, pkg } of manifests) {
    if (pkg === null) continue;
    const declared = typeof pkg.bin === 'string' ? { [pkg.name ?? 'bin']: pkg.bin } : (pkg.bin ?? {});
    for (const [name, target] of Object.entries(declared)) {
      if (typeof target !== 'string') continue;
      const resolved = posix.normalize(posix.join(dir, target.replace(/^\.\//u, '')));
      if (resolved.startsWith('..') || posix.isAbsolute(resolved)) {
        errors.push(`${label}: unsafe bin ${name} ${target}`);
        continue;
      }
      const entry = files.get(resolved);
      if (entry === undefined) {
        errors.push(`${shown(resolved)}: bin ${name} target missing`);
      } else if ((Number.parseInt(entry.mode, 8) & 0o111) === 0) {
        errors.push(`${shown(resolved)}: bin ${name} is not executable (mode ${entry.mode})`);
      }
    }
  }
  return { errors, root, members };
}

/**
 * @param {string} tarballPath
 * @param {{ manifestPath?: string }} [options] explicit manifest; a sibling
 *   `bundle-manifest.json` is used automatically when present.
 */
export function verifyBundle(tarballPath, { manifestPath } = {}) {
  const tarball = resolve(tarballPath);
  const bytes = readFileSync(tarball);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const errors = [];
  let entries = [];
  try {
    entries = readBundleEntries(bytes, { withContent: true });
  } catch (error) {
    errors.push(`tarball: ${stripPrefix(error.message, 'bundle archive: ')}`);
  }
  let root = null;
  const members = new Map();
  if (entries.length === 0) {
    if (errors.length === 0) errors.push('tarball: contains no files');
  } else {
    const inspected = inspectBundle(entries);
    errors.push(...inspected.errors);
    root = inspected.root;
    for (const [name, version] of inspected.members) members.set(name, version);
  }
  const manifestFile = manifestPath === undefined ? join(dirname(tarball), MANIFEST_FILE) : resolve(manifestPath);
  const manifestText = manifestPath === undefined && !existsSync(manifestFile) ? null : readFileSync(manifestFile, 'utf8');
  let manifest = null;
  if (manifestText !== null) {
    try {
      manifest = parseBundleManifest(manifestText);
    } catch (error) {
      errors.push(`${MANIFEST_FILE}: ${stripPrefix(error.message, 'bundle manifest: ')}`);
    }
  }
  // Compare only when both sides exist: a broken root manifest already failed
  // above, and inventing an entry name here would bury the real cause.
  if (manifest !== null && root !== null && entries.length > 0) {
    const actual = createBundleManifest({
      entry: { name: root.name, version: root.version },
      members: Object.fromEntries(members),
      tarball: { name: basename(tarball), sha256, bytes: bytes.length },
      entries,
      toolchain: manifest.toolchain,
    });
    errors.push(...diffBundleManifest(manifest, actual));
  }
  const summary = summarizeBundle(entries);
  return {
    ok: errors.length === 0,
    errors,
    manifest,
    entries,
    summary: {
      fileCount: summary.fileCount,
      totalBytes: summary.totalBytes,
      memberCount: manifest === null ? members.size : Object.keys(manifest.members).length,
      entryName: manifest?.entry.name ?? root?.name ?? '',
      entryVersion: manifest?.entry.version ?? root?.version ?? '',
      sha256,
    },
  };
}

function parseArguments(argv) {
  const args = [...argv];
  let tarball;
  let manifestPath;
  let json = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--manifest') {
      manifestPath = args.shift();
      if (manifestPath === undefined || manifestPath === '') return null;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--') || tarball !== undefined) {
      return null;
    } else {
      tarball = arg;
    }
  }
  return tarball === undefined || tarball === '' ? null : { tarball, manifestPath, json };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === null) {
    console.log(`bundle: ${USAGE}`);
    process.exitCode = 2;
  } else {
    try {
      const result = verifyBundle(parsed.tarball, parsed.manifestPath === undefined ? {} : { manifestPath: parsed.manifestPath });
      const { summary } = result;
      if (parsed.json) {
        // One machine-readable verdict for release scripts and evidence capture;
        // the exit code keeps the same 0/1/2 meaning as the text surface.
        console.log(JSON.stringify({
          ok: result.ok,
          tarball: basename(resolve(parsed.tarball)),
          files: summary.fileCount,
          bytes: summary.totalBytes,
          sha256: summary.sha256,
          entry: { name: summary.entryName, version: summary.entryVersion },
          members: result.manifest === null ? null : result.manifest.members,
          toolchain: result.manifest === null ? null : result.manifest.toolchain,
          errors: result.errors,
        }, null, 2));
        if (!result.ok) process.exitCode = 1;
      } else {
        console.log(`bundle: ${basename(resolve(parsed.tarball))} | ${summary.fileCount} files | ${summary.totalBytes} bytes | sha256 ${summary.sha256}`);
        if (result.manifest !== null) console.log(`bundle: manifest ok (formatVersion ${result.manifest.formatVersion}, ${Object.keys(result.manifest.members).length} packages)`);
        else if (result.errors.some((error) => error.startsWith(`${MANIFEST_FILE}:`))) console.log('bundle: manifest invalid');
        else console.log('bundle: manifest not provided; structure rules only');
        if (result.ok) {
          console.log('bundle: ok');
        } else {
          for (const error of result.errors) console.log(`bundle: ${error}`);
          console.log(`bundle: failed with ${result.errors.length} error(s); first: ${result.errors[0]}`);
          process.exitCode = 1;
        }
      }
    } catch (error) {
      // Unreadable tarball / manifest is a usage problem (exit 2), not a verdict.
      console.log(`bundle: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
