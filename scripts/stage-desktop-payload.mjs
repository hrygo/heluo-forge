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
 *   - the tray icon must match the brand manifest ledger;
 *   - the staged layout is re-checked against layout.mjs before anything is
 *     published, so a contract change fails the staging run, not the app.
 *
 * 用法：
 *   node scripts/stage-desktop-payload.mjs --output <dir> --dsh-tgz <path.tgz> --pnpm-tgz <path.tgz> \
 *     [--brand-dir <dir>] [--employee-assets <dir>] [--lock <runtime-lock.json>] [--json]
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArchiveError, readBundleEntries } from './lib/bundle-archive.mjs';
import { execNpm } from './lib/bundle-rules.mjs';
import { ASSETS_DIR, DSH_ENTRY_PARTS, PNPM_ENTRY_PARTS, STATUS_PAGE_PARTS, TRAY_ICON_PARTS } from '../services/forge-desktop/src/layout.mjs';
import { readManifest, verifyAsset } from './derive-brand-icons.mjs';

const TRAY_ICON_SOURCE = 'sizes/app-icon-256.png';
const DEFAULT_BRAND_DIR = join('docs', 'assets', 'branding', 'cyber-long');
const DEFAULT_LOCK = join('services', 'forge-desktop', 'runtime-lock.json');

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

export function parseArguments(argv) {
  const options = { output: undefined, dshTgz: undefined, pnpmTgz: undefined, brandDir: undefined, employeeAssets: undefined, lock: undefined, json: false };
  const valued = new Map([
    ['--output', 'output'],
    ['--dsh-tgz', 'dshTgz'],
    ['--pnpm-tgz', 'pnpmTgz'],
    ['--brand-dir', 'brandDir'],
    ['--employee-assets', 'employeeAssets'],
    ['--lock', 'lock'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('BAD_ARGUMENT', `${argument} requires a value`);
      options[valued.get(argument)] = value;
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
 * `<resources>/dsh/node_modules`. dsh is not a self-contained bundle: `bin.js`
 * resolves siblings like `@deepseek-ai/dsh-app-boot` from node_modules, so the
 * default installer is `npm install <verified local tgz>` — the top package's
 * bytes are the registry artifact the lock pinned, and the closure comes from
 * the registry in npm's own tree layout. The installer is injectable so the
 * offline tests can stage a fixture tree without the network.
 *
 * npm is launched through `execNpm`: on Windows `npm` is a `.cmd` shim that a
 * bare `execFileSync('npm', …)` cannot start, so the CLI script runs under the
 * current Node instead, on every platform.
 */
function installDshClosure(tgz, destination, { installer } = {}) {
  mkdirSync(destination, { recursive: true });
  const install = installer ?? ((tgzPath, dest) => {
    execNpm(['install', '--no-save', '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'error', tgzPath, '--prefix', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
  install(tgz, destination);
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

export function stagePayload({ output, dshTgz, pnpmTgz, brandDir, employeeAssets, lockPath, repoRoot, installer }) {
  const outputDir = resolve(output);
  const lock = JSON.parse(readFileSync(resolve(lockPath), 'utf8'));
  // dsh first: an incomplete handover is reported one artifact at a time, in the order the layout lists them.
  const dsh = verifiedArtifact(dshTgz, lock.dsh, 'dsh');
  if (typeof pnpmTgz !== 'string' || pnpmTgz.trim() === '') fail('PNPM_TGZ_MISSING', 'the pnpm tarball was not handed over (--pnpm-tgz)');
  const pnpm = verifiedArtifact(pnpmTgz, lock.pnpm, 'pnpm');

  // Fail fast on a missing brand suite, before the output is rebuilt.
  const brand = resolve(brandDir ?? join(repoRoot, DEFAULT_BRAND_DIR));
  if (!existsSync(join(brand, 'manifest.json'))) fail('BRAND_MISSING', `brand suite not found: ${brand}`);

  const resources = join(outputDir, 'resources');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(resources, { recursive: true });

  // The tarball root IS the dsh package: installing the verified file with
  // prefix `dsh/` puts it at `node_modules/@deepseek-ai/dsh` with its closure
  // beside it — DSH_ENTRY_PARTS starts with that prefix root.
  const dshDir = join(resources, DSH_ENTRY_PARTS[0]);
  installDshClosure(dsh.path, dshDir, { installer });
  const entry = join(resources, ...DSH_ENTRY_PARTS);
  if (!existsSync(entry)) fail('STAGE_LAYOUT_INVALID', `the unpacked artifact carries no ${DSH_ENTRY_PARTS.join('/')}`);

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
    pnpm: { version: pnpm.entry.version, sha256: pnpm.entry.sha256, bytes: pnpm.entry.bytes, artifact: basename(pnpm.path) },
    tray: { source: TRAY_ICON_SOURCE, bytes: trayBytes.length, sha256: sha256Hex(trayBytes) },
    statusPage: { source: STATUS_PAGE_PARTS.join('/'), bytes: readFileSync(join(resources, ...STATUS_PAGE_PARTS)).length },
    assets,
    layout: { dshEntry: DSH_ENTRY_PARTS.join('/'), pnpmEntry: PNPM_ENTRY_PARTS.join('/'), trayIcon: TRAY_ICON_PARTS.join('/') },
  };
  writeFileSync(join(outputDir, 'staging-manifest.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
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
    repoRoot,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  else process.stdout.write(`staged: ${resolve(options.output)} (dsh ${record.dsh.version}, pnpm ${record.pnpm.version}, tray ${record.tray.source}${record.assets ? `, assets ${record.assets}` : ''})\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof StageError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
