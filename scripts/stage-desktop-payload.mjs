#!/usr/bin/env node
/**
 * Stage the packaged shell's resource payload (CORP-DSH-PLAN-026 §4.3-2).
 *
 * One output directory, filled exactly the way `services/forge-desktop/src/
 * layout.mjs` describes it, so a packaged app finds what `main.mjs` expects:
 *
 *   <output>/resources/dsh/node_modules/@deepseek-ai/dsh/...   locked artifact, unpacked verbatim
 *   <output>/resources/pnpm/bin/pnpm.mjs                       locked pnpm, unpacked from its own bytes
 *   <output>/resources/brand/tray.png                           manifest-verified brand icon
 *   <output>/resources/enterprise-assets/                       optional employee package
 *
 * Fail-closed rules:
 *   - the dsh and pnpm tarballs must match `runtime-lock.json` by bytes and SHA-256;
 *   - the dsh dependency closure is deduplicated, checked for identity/lock
 *     agreement when pinned, and bounded by staged file/byte budgets;
 *   - the tray icon must match the brand manifest ledger;
 *   - the staged layout is re-checked against layout.mjs and swapped into place
 *     atomically only after every gate passes.
 *
 * 用法：
 *   node scripts/stage-desktop-payload.mjs --output <dir> --dsh-tgz <path.tgz> --pnpm-tgz <path.tgz> \
 *     [--brand-dir <dir>] [--employee-assets <dir>] [--lock <runtime-lock.json>] \
 *     [--max-dsh-bytes <bytes>] [--max-dsh-files <count>] [--json]
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArchiveError, readBundleEntries } from './lib/bundle-archive.mjs';
import { execNpm } from './lib/bundle-rules.mjs';
import { ASSETS_DIR, DSH_ENTRY_PARTS, PNPM_ENTRY_PARTS, STATUS_PAGE_PARTS, TITLE_BAR_PARTS, TRAY_ICON_PARTS } from '../services/forge-desktop/src/layout.mjs';
import { readManifest, verifyAsset } from './derive-brand-icons.mjs';

const TRAY_ICON_SOURCE = 'sizes/app-icon-256.png';
const DEFAULT_BRAND_DIR = join('docs', 'assets', 'branding', 'cyber-long');
const DEFAULT_LOCK = join('services', 'forge-desktop', 'runtime-lock.json');
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';

/** Default upper bounds on the staged dsh closure (raw files before packaging exclusions). */
export const DEFAULT_MAX_DSH_BYTES = 900 * 1024 * 1024;
export const DEFAULT_MAX_DSH_FILES = 100_000;

export class StageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StageError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new StageError(code, message);
};

function parsePositiveInt(raw, flag) {
  if (!/^\d+$/u.test(raw ?? '')) fail('BAD_ARGUMENT', `${flag} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('BAD_ARGUMENT', `${flag} must be a positive integer`);
  return parsed;
}

export function parseArguments(argv) {
  const options = {
    output: undefined,
    dshTgz: undefined,
    pnpmTgz: undefined,
    brandDir: undefined,
    employeeAssets: undefined,
    lock: undefined,
    maxDshBytes: undefined,
    maxDshFiles: undefined,
    json: false,
  };
  const valued = new Map([
    ['--output', 'output'],
    ['--dsh-tgz', 'dshTgz'],
    ['--pnpm-tgz', 'pnpmTgz'],
    ['--brand-dir', 'brandDir'],
    ['--employee-assets', 'employeeAssets'],
    ['--lock', 'lock'],
    ['--max-dsh-bytes', 'maxDshBytes'],
    ['--max-dsh-files', 'maxDshFiles'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('BAD_ARGUMENT', `${argument} requires a value`);
      const field = valued.get(argument);
      options[field] = argument.startsWith('--max-dsh-') ? parsePositiveInt(value, argument) : value;
      index += 1;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    fail('BAD_ARGUMENT', `unknown argument ${argument}`);
  }
  for (const flag of ['--output', '--dsh-tgz', '--pnpm-tgz']) {
    if (typeof options[valued.get(flag)] !== 'string' || options[valued.get(flag)].trim() === '') fail('BAD_ARGUMENT', `${flag} is required`);
  }
  return options;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPackageManifest(pkgDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (typeof manifest?.name === 'string' && typeof manifest?.version === 'string') return manifest;
  } catch {
    // Missing or unreadable manifest: not an identifiable package directory.
  }
  return null;
}

/**
 * List every package installed inside a `node_modules` tree, together with its
 * parent `node_modules` chain so hoisting and deduplication preserve Node's
 * upward lookup order.
 */
function collectInstalledPackages(rootNodeModules) {
  const entries = [];
  const walk = (nmDir, ancestors) => {
    if (!existsSync(nmDir)) return;
    for (const dirent of readdirSync(nmDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      if (dirent.name.startsWith('@')) {
        const scopeDir = join(nmDir, dirent.name);
        for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
          if (!scoped.isDirectory() || scoped.name.startsWith('.')) continue;
          const pkgDir = join(scopeDir, scoped.name);
          const pkg = readPackageManifest(pkgDir);
          if (pkg !== null) entries.push({ dir: pkgDir, name: pkg.name, version: pkg.version, ancestors });
          walk(join(pkgDir, 'node_modules'), [nmDir, ...ancestors]);
        }
        continue;
      }
      const pkgDir = join(nmDir, dirent.name);
      const pkg = readPackageManifest(pkgDir);
      if (pkg !== null) entries.push({ dir: pkgDir, name: pkg.name, version: pkg.version, ancestors });
      walk(join(pkgDir, 'node_modules'), [nmDir, ...ancestors]);
    }
  };
  walk(rootNodeModules, []);
  return entries;
}

function hasSubPackages(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) return false;
  for (const dirent of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (dirent.name === '.bin') continue;
    if (dirent.isDirectory()) return true;
  }
  return false;
}

function pruneEmptyModulesTree(pkgDir, parentNm, root) {
  const scopeDir = dirname(pkgDir);
  if (scopeDir !== parentNm && existsSync(scopeDir) && readdirSync(scopeDir).length === 0) {
    rmSync(scopeDir, { recursive: true, force: true });
  }
  if (parentNm !== root && !hasSubPackages(parentNm)) {
    rmSync(parentNm, { recursive: true, force: true });
  }
}

/**
 * Deduplicate identical transitive packages in `dsh/node_modules`:
 *   1. If a nested package has no root copy at `rootNodeModules` and no closer
 *      ancestor shadows it, hoist its first leaf copy to `rootNodeModules`.
 *   2. Remove any leaf nested copy whose nearest shadowing ancestor in Node's
 *      upward `node_modules` resolution carries the exact same `name@version`.
 *
 * `@deepseek-ai/dsh` at the root stays verbatim and is never moved or pruned.
 */
export function dedupeDshClosure(rootNodeModules) {
  const root = resolve(rootNodeModules);
  if (!existsSync(root)) return { removedPackages: 0, hoistedPackages: 0 };
  let removedPackages = 0;
  let hoistedPackages = 0;

  // Pass 1: hoist the most common nested leaf version when missing from root.
  const all = collectInstalledPackages(root);
  const counts = new Map();
  for (const item of all) {
    const key = `${item.name}@${item.version}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hoistCandidates = all
    .filter((item) => item.ancestors.length > 0 && item.name !== DSH_PACKAGE_NAME)
    .sort((a, b) => (counts.get(`${b.name}@${b.version}`) ?? 0) - (counts.get(`${a.name}@${a.version}`) ?? 0));

  for (const item of hoistCandidates) {
    if (!existsSync(item.dir)) continue;
    const nestedNm = join(item.dir, 'node_modules');
    if (hasSubPackages(nestedNm)) continue;
    const rootTarget = join(root, ...item.name.split('/'));
    if (existsSync(rootTarget)) continue;
    const shadowed = item.ancestors.some((nm) => existsSync(join(nm, ...item.name.split('/'), 'package.json')));
    if (shadowed) continue;
    mkdirSync(dirname(rootTarget), { recursive: true });
    if (existsSync(nestedNm)) rmSync(nestedNm, { recursive: true, force: true });
    renameSync(item.dir, rootTarget);
    pruneEmptyModulesTree(item.dir, item.ancestors[0], root);
    hoistedPackages += 1;
  }

  // Pass 2: bottom-up prune leaf nested copies matched by their nearest ancestor.
  const nested = collectInstalledPackages(root)
    .filter((item) => item.ancestors.length > 0 && item.name !== DSH_PACKAGE_NAME)
    .sort((a, b) => b.ancestors.length - a.ancestors.length);

  for (const item of nested) {
    if (!existsSync(item.dir)) continue;
    const nestedNm = join(item.dir, 'node_modules');
    if (hasSubPackages(nestedNm)) continue;
    let nearest = null;
    for (const nm of item.ancestors) {
      const candidate = readPackageManifest(join(nm, ...item.name.split('/')));
      if (candidate !== null) {
        nearest = candidate;
        break;
      }
    }
    if (nearest === null || nearest.name !== item.name || nearest.version !== item.version) continue;
    rmSync(item.dir, { recursive: true, force: true });
    pruneEmptyModulesTree(item.dir, item.ancestors[0], root);
    removedPackages += 1;
  }

  return { removedPackages, hoistedPackages };
}

/**
 * Deterministic inventory and size summary of `dsh/node_modules`.
 */
export function inspectDshClosure(rootNodeModules) {
  const root = resolve(rootNodeModules);
  const packages = collectInstalledPackages(root)
    .map((item) => ({
      path: relative(root, item.dir).split(sep).join('/'),
      name: item.name,
      version: item.version,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const unique = new Set(packages.map((pkg) => `${pkg.name}@${pkg.version}`));
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += statSync(join(entry.parentPath, entry.name)).size;
  }
  const canonical = packages.map((pkg) => `${pkg.path}\t${pkg.name}@${pkg.version}\n`).join('');
  return {
    packages,
    uniquePackages: unique.size,
    duplicates: packages.length - unique.size,
    files,
    bytes,
    digest: sha256Hex(Buffer.from(canonical, 'utf8')),
  };
}

function verifyDshIdentity(rootNodeModules, expectedVersion) {
  const pkg = readPackageManifest(join(rootNodeModules, ...DSH_PACKAGE_NAME.split('/')));
  if (pkg === null || pkg.name !== DSH_PACKAGE_NAME || pkg.version !== expectedVersion) {
    fail(
      'STAGE_DSH_IDENTITY_MISMATCH',
      `staged dsh is ${pkg?.name}@${pkg?.version}, the lock names ${DSH_PACKAGE_NAME}@${expectedVersion}`,
    );
  }
}

function verifyDshClosureLock(closure, lock) {
  const closureLock = lock?.dshClosure;
  if (closureLock === undefined || closureLock === null) return;
  const platformKey = `${process.platform}-${process.arch}`;
  const target = typeof closureLock.digest === 'string' ? closureLock : closureLock[platformKey];
  if (target === undefined) return;
  if (closure.digest !== target.digest) {
    fail('STAGE_CLOSURE_MISMATCH', `dsh closure digest ${closure.digest} does not match lock ${target.digest}`);
  }
  if (Number.isSafeInteger(target.packages) && closure.packages.length !== target.packages) {
    fail('STAGE_CLOSURE_MISMATCH', `dsh closure has ${closure.packages.length} packages, lock expects ${target.packages}`);
  }
}

function resolveBudget(lock, overrides = {}) {
  const maxBytes = overrides.maxDshBytes ?? lock?.dshBudget?.maxBytes ?? DEFAULT_MAX_DSH_BYTES;
  const maxFiles = overrides.maxDshFiles ?? lock?.dshBudget?.maxFiles ?? DEFAULT_MAX_DSH_FILES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    fail('LOCK_INVALID', 'runtime lock dshBudget must specify positive integers maxBytes and maxFiles');
  }
  return { maxBytes, maxFiles };
}

function enforceDshBudget(closure, budget) {
  if (closure.bytes > budget.maxBytes) {
    fail('STAGE_BUDGET_EXCEEDED', `staged dsh closure is ${closure.bytes} bytes, exceeding budget ${budget.maxBytes}`);
  }
  if (closure.files > budget.maxFiles) {
    fail('STAGE_BUDGET_EXCEEDED', `staged dsh closure has ${closure.files} files, exceeding budget ${budget.maxFiles}`);
  }
}

/**
 * The artifact the ledger locked, or nothing: the file must exist and be the
 * bytes the ledger names. Checked before anything is unpacked.
 *
 * @param {string} tgz the tarball the build was handed
 * @param {{version: string, sha256?: string, bytes?: number}} entry the ledger's row for it
 * @param {string} label names the artifact in the ledger and in every error
 */
function verifiedArtifact(tgz, entry, label) {
  const path = resolve(tgz);
  if (!existsSync(path)) fail(`${label.toUpperCase()}_TGZ_MISSING`, `${label} tarball not found: ${path}`);
  if (entry?.sha256 === undefined || entry?.bytes === undefined) fail('LOCK_INVALID', `runtime lock has no ${label} bytes/sha256 entry`);
  const bytes = readFileSync(path);
  if (bytes.length !== entry.bytes) {
    fail('STAGE_DIGEST_MISMATCH', `${label} tarball is ${bytes.length} bytes, the lock expects ${entry.bytes}`);
  }
  if (sha256Hex(bytes) !== entry.sha256) fail('STAGE_DIGEST_MISMATCH', `${label} tarball SHA-256 does not match the runtime lock`);
  return { path, bytes, entry };
}

/**
 * Install the verified artifact with its dependency closure under
 * `<resources>/dsh/node_modules`, then deduplicate identical nested copies.
 */
function installDshClosure(tgz, destination, { installer, deduper } = {}) {
  mkdirSync(destination, { recursive: true });
  const install = installer ?? ((tgzPath, dest) => {
    execNpm(['install', '--no-save', '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'error', tgzPath, '--prefix', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
  install(tgz, destination);
  const runDedupe = deduper ?? dedupeDshClosure;
  return runDedupe(join(destination, 'node_modules'));
}

/**
 * Unpack the verified pnpm archive under `<resources>/pnpm`, each file with
 * the mode the archive records. The archive is read back from its own bytes by
 * the repository's reader, which accepts regular files below `package/` only:
 * nothing can land outside the directory or arrive as a link. No package
 * manager is involved, so no lifecycle script of the archive runs here.
 */
export function unpackPnpm(bytes, destination) {
  let entries;
  try {
    entries = readBundleEntries(bytes, { withContent: true });
  } catch (error) {
    fail('STAGE_PNPM_ARCHIVE_INVALID', error instanceof ArchiveError ? error.message : `the pnpm tarball could not be read (${error?.message ?? 'UNKNOWN'})`);
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = join(destination, ...entry.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content, { mode: Number.parseInt(entry.mode, 8) });
  }
  return entries.length;
}

/**
 * The unpacked pnpm is the package the ledger named: its entry sits where
 * `layout.mjs` reads it, and its manifest carries the locked name and version.
 * A tarball that matched the digest already proved its bytes; this ties those
 * bytes to the version the shell will report and the lockfile will record.
 */
function assertPnpmIdentity(resources, version) {
  const entry = join(resources, ...PNPM_ENTRY_PARTS);
  if (!existsSync(entry)) fail('STAGE_LAYOUT_INVALID', `the unpacked pnpm carries no ${PNPM_ENTRY_PARTS.join('/')}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(resources, PNPM_ENTRY_PARTS[0], 'package.json'), 'utf8'));
  } catch {
    fail('STAGE_PNPM_IDENTITY_MISMATCH', 'the unpacked pnpm carries no readable package.json');
  }
  if (manifest?.name !== 'pnpm' || manifest?.version !== version) {
    fail('STAGE_PNPM_IDENTITY_MISMATCH', `the unpacked archive is ${manifest?.name}@${manifest?.version}, the lock names pnpm@${version}`);
  }
}

export function stagePayload({ output, dshTgz, pnpmTgz, brandDir, employeeAssets, lockPath, repoRoot, installer, deduper, maxDshBytes, maxDshFiles }) {
  const outputDir = resolve(output);
  const lock = JSON.parse(readFileSync(resolve(lockPath), 'utf8'));
  // dsh first: an incomplete handover is reported one artifact at a time, in the order the layout lists them.
  const dsh = verifiedArtifact(dshTgz, lock.dsh, 'dsh');
  if (typeof pnpmTgz !== 'string' || pnpmTgz.trim() === '') fail('PNPM_TGZ_MISSING', 'the pnpm tarball was not handed over (--pnpm-tgz)');
  const pnpm = verifiedArtifact(pnpmTgz, lock.pnpm, 'pnpm');
  const budget = resolveBudget(lock, { maxDshBytes, maxDshFiles });

  // Fail fast on a missing brand suite, before the output is rebuilt.
  const brand = resolve(brandDir ?? join(repoRoot, DEFAULT_BRAND_DIR));
  if (!existsSync(join(brand, 'manifest.json'))) fail('BRAND_MISSING', `brand suite not found: ${brand}`);

  // Stage into a sibling temporary directory and swap atomically so a failed run never corrupts an existing output.
  const parentDir = dirname(outputDir);
  mkdirSync(parentDir, { recursive: true });
  const stagingDir = join(parentDir, `.${basename(outputDir)}.staging-${process.pid}-${Date.now().toString(36)}`);
  const resources = join(stagingDir, 'resources');
  mkdirSync(resources, { recursive: true });

  try {
    const dshDir = join(resources, DSH_ENTRY_PARTS[0]);
    const deduped = installDshClosure(dsh.path, dshDir, { installer, deduper }) ?? { removedPackages: 0, hoistedPackages: 0 };
    const entry = join(resources, ...DSH_ENTRY_PARTS);
    if (!existsSync(entry)) fail('STAGE_LAYOUT_INVALID', `the unpacked artifact carries no ${DSH_ENTRY_PARTS.join('/')}`);

    const dshNodeModules = join(dshDir, 'node_modules');
    verifyDshIdentity(dshNodeModules, lock.dsh.version);
    const closure = inspectDshClosure(dshNodeModules);
    verifyDshClosureLock(closure, lock);
    enforceDshBudget(closure, budget);

    unpackPnpm(pnpm.bytes, join(resources, PNPM_ENTRY_PARTS[0]));
    assertPnpmIdentity(resources, pnpm.entry.version);

    const { byPath } = readManifest(brand);
    const { bytes: trayBytes } = verifyAsset(brand, byPath, TRAY_ICON_SOURCE);
    mkdirSync(join(resources, ...TRAY_ICON_PARTS.slice(0, -1)), { recursive: true });
    writeFileSync(join(resources, ...TRAY_ICON_PARTS), trayBytes);

    // The shell's own setup page travels beside the tray icon: local, link-free,
    // carrying no enterprise values — the state arrives via the query string.
    const statusSource = join(repoRoot, 'services', 'forge-desktop', 'resources', ...STATUS_PAGE_PARTS.slice(1));
    if (!existsSync(statusSource)) fail('STATUS_PAGE_MISSING', `shell setup page not found: ${statusSource}`);
    mkdirSync(join(resources, ...STATUS_PAGE_PARTS.slice(0, -1)), { recursive: true });
    writeFileSync(join(resources, ...STATUS_PAGE_PARTS), readFileSync(statusSource));

    // The shell's own title bar travels the same way: one local file, no links.
    // Which buttons it draws and the title it shows arrive via the query string.
    const titleBarSource = join(repoRoot, 'services', 'forge-desktop', 'resources', ...TITLE_BAR_PARTS.slice(1));
    if (!existsSync(titleBarSource)) fail('TITLE_BAR_MISSING', `shell title bar not found: ${titleBarSource}`);
    mkdirSync(join(resources, ...TITLE_BAR_PARTS.slice(0, -1)), { recursive: true });
    writeFileSync(join(resources, ...TITLE_BAR_PARTS), readFileSync(titleBarSource));

    let assets = null;
    if (employeeAssets !== undefined) {
      const source = resolve(employeeAssets);
      if (!existsSync(join(source, 'employee-manifest.json'))) fail('ASSETS_INVALID', 'employee assets directory carries no employee-manifest.json');
      cpSync(source, join(resources, ASSETS_DIR), { recursive: true });
      assets = ASSETS_DIR;
    }

    const record = {
      schema: 'heluo-desktop-staging/1',
      dsh: { version: lock.dsh.version, sha256: lock.dsh.sha256, bytes: lock.dsh.bytes, artifact: basename(dsh.path) },
      dshClosure: {
        packages: closure.packages.length,
        uniquePackages: closure.uniquePackages,
        duplicates: closure.duplicates,
        deduped: deduped.removedPackages,
        hoisted: deduped.hoistedPackages,
        files: closure.files,
        bytes: closure.bytes,
        digest: closure.digest,
      },
      budget,
      pnpm: { version: pnpm.entry.version, sha256: pnpm.entry.sha256, bytes: pnpm.entry.bytes, artifact: basename(pnpm.path) },
      tray: { source: TRAY_ICON_SOURCE, bytes: trayBytes.length, sha256: sha256Hex(trayBytes) },
      statusPage: { source: STATUS_PAGE_PARTS.join('/'), bytes: readFileSync(join(resources, ...STATUS_PAGE_PARTS)).length },
      titleBar: { source: TITLE_BAR_PARTS.join('/'), bytes: readFileSync(join(resources, ...TITLE_BAR_PARTS)).length },
      assets,
      layout: { dshEntry: DSH_ENTRY_PARTS.join('/'), pnpmEntry: PNPM_ENTRY_PARTS.join('/'), trayIcon: TRAY_ICON_PARTS.join('/') },
    };
    writeFileSync(join(stagingDir, 'staging-manifest.json'), `${JSON.stringify(record, null, 2)}\n`);

    rmSync(outputDir, { recursive: true, force: true });
    renameSync(stagingDir, outputDir);
    return record;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const record = stagePayload({
    output: options.output,
    dshTgz: options.dshTgz,
    pnpmTgz: options.pnpmTgz,
    brandDir: options.brandDir,
    employeeAssets: options.employeeAssets,
    lockPath: options.lock ?? join(repoRoot, DEFAULT_LOCK),
    maxDshBytes: options.maxDshBytes,
    maxDshFiles: options.maxDshFiles,
    repoRoot,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  else process.stdout.write(`staged: ${resolve(options.output)} (dsh ${record.dsh.version}, closure ${record.dshClosure.packages} pkgs / ${record.dshClosure.bytes} B, pnpm ${record.pnpm.version}, tray ${record.tray.source}${record.assets ? `, assets ${record.assets}` : ''})\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof StageError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
