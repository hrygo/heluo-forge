#!/usr/bin/env node
/**
 * Stage the pinned @napi-rs/keyring prebuilt addons into
 * `packages/forge-credentials-keychain/native/<triple>/`.
 *
 * Why this exists instead of an `optionalDependencies` entry:
 * `scripts/build-enterprise-bundle.mjs` refuses any member that declares
 * peer/optional dependencies, and `scripts/lib/bundle-rules.mjs` refuses to
 * bundle non-`@heluo/forge-*` packages. A prebuilt addon carried as a release
 * resource sidesteps both without weakening either rule: the terminal still
 * never compiles, never fetches a platform package, and the artifact stays
 * self-contained.
 *
 * Every download is checked against the tarball integrity pinned in
 * `scripts/native-keyring.json`; a mismatch aborts before anything is written.
 *
 * Usage:
 *   node scripts/fetch-native-keyring.mjs [--check] [--registry <url>]
 *
 * `--check` writes nothing and verifies the staged files against
 * `native/CHECKSUMS.json` (used by the release checks).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repo, 'scripts/native-keyring.json');
const nativeRoot = join(repo, 'packages/forge-credentials-keychain/vendor');
const checksumPath = join(nativeRoot, 'CHECKSUMS.json');
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const registry = option('--registry', process.env.HELUO_NATIVE_REGISTRY ?? DEFAULT_REGISTRY);
const checkOnly = flag('--check');

const sha512 = (buffer) => `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const fail = (message) => {
  throw new Error(`native keyring: ${message}`);
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function selectedTargets() {
  const manifest = readJson(manifestPath);
  if (manifest.package !== '@napi-rs/keyring') fail('unexpected package in manifest');
  return manifest.targets;
}

function verifyStaged(targets) {
  if (!existsSync(checksumPath)) fail('CHECKSUMS.json is missing; run without --check to stage the addons');
  const recorded = readJson(checksumPath);
  const problems = [];
  for (const target of targets) {
    const relative = `${target.triple}/keyring.node`;
    const expected = recorded.files?.[relative];
    if (expected === undefined) {
      problems.push(`${relative}: not recorded in CHECKSUMS.json`);
      continue;
    }
    const absolute = join(nativeRoot, relative);
    if (!existsSync(absolute)) {
      problems.push(`${relative}: staged file is missing`);
      continue;
    }
    const bytes = readFileSync(absolute);
    if (sha256(bytes) !== expected.sha256) problems.push(`${relative}: sha256 mismatch`);
    if (bytes.length !== expected.bytes) problems.push(`${relative}: size mismatch`);
  }
  if (problems.length > 0) fail(problems.join('; '));
  return `verified ${targets.length} staged addon(s)`;
}

function packSignedSource(target, workDir) {
  const spec = `${target.source}@${target.version}`;
  const stdout = execFileSync('npm', ['pack', spec, '--json', '--pack-destination', workDir, `--registry=${registry}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // npm 10 returns an array; npm 11 returns an object keyed by package name.
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const filename = first?.filename;
  if (typeof filename !== 'string') fail(`npm pack returned no filename for ${spec}`);
  const tarball = join(workDir, filename);
  const bytes = readFileSync(tarball);
  const actual = sha512(bytes);
  if (actual !== target.integrity) {
    fail(`${spec}: integrity mismatch\n  expected ${target.integrity}\n  actual   ${actual}`);
  }
  return { tarball, bytes };
}

function stageTarget(target) {
  const work = mkdtempSync(join(tmpdir(), 'forge-native-keyring-'));
  try {
    const { tarball } = packSignedSource(target, work);
    const extracted = join(work, 'unpack');
    mkdirSync(extracted, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
    const addonSource = join(extracted, 'package', target.addon);
    if (!existsSync(addonSource)) fail(`${target.source}: tarball does not contain ${target.addon}`);
    const addonTarget = join(nativeRoot, target.triple, 'keyring.node');
    mkdirSync(dirname(addonTarget), { recursive: true });
    copyFileSync(addonSource, addonTarget);
    const licenseSource = join(extracted, 'package', 'LICENSE.third-party.md');
    if (existsSync(licenseSource)) copyFileSync(licenseSource, join(nativeRoot, target.triple, 'LICENSE.third-party.md'));
    const bytes = readFileSync(addonTarget);
    return { relative: `${target.triple}/keyring.node`, sha256: sha256(bytes), bytes: bytes.length, source: target.source, version: target.version, license: target.license, integrity: target.integrity };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeChecksums(entries) {
  const files = Object.fromEntries(entries.map((entry) => [entry.relative, entry]).sort(([a], [b]) => (a < b ? -1 : 1)));
  const document = {
    package: '@napi-rs/keyring',
    version: readJson(manifestPath).version,
    generatedBy: 'scripts/fetch-native-keyring.mjs',
    note: 'sha256 of the staged addons; re-run the fetch script instead of editing this file',
    files,
  };
  writeFileSync(checksumPath, `${JSON.stringify(document, null, 2)}\n`);
}

function main() {
  const targets = selectedTargets();
  if (checkOnly) {
    console.log(`native keyring: ${verifyStaged(targets)}`);
    return;
  }
  const entries = [];
  for (const target of targets) {
    const entry = stageTarget(target);
    entries.push(entry);
    console.log(`native keyring: staged ${entry.relative} (${entry.bytes} bytes)`);
  }
  writeChecksums(entries);
  console.log(`native keyring: ${entries.length} addon(s) under ${nativeRoot.slice(repo.length + 1)}; registry ${registry}`);
  if (readdirSync(nativeRoot).length === 0) fail('nothing staged');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}