#!/usr/bin/env node
/**
 * Build the desktop shell installer (CORP-DSH-PLAN-026 §4.3-7).
 *
 * The app identity comes from the employee package's `branding/app-identity.json`
 * — the same five-field truth the release lane writes — never from this file:
 * appId, upgrade GUID, productName, executable name and display name must not
 * drift between the plugin brand and the OS-level app.
 *
 * The staged resources go to two places (`scripts/lib/desktop-payload.mjs`): the
 * embedded runtime under `dsh/` into the app's archive as one file, everything
 * else beside the archive as it was staged. What the runtime hands to the
 * operating system is unpacked beside the archive, and `afterPack` checks the
 * archive against the staged tree before the build may continue.
 *
 * The staged resources have to be a real directory inside the app directory:
 * electron-builder counts the paths it matches from the app directory, and
 * refuses a file whose real location is outside the tree it packs. They are
 * therefore staged there (`services/forge-desktop/.staged/`, ignored by git).
 *
 * 用法：
 *   node scripts/build-desktop-installer.mjs --identity <app-identity.json> \
 *     --resources <app-dir 内的 staged resources dir> --version <vX.Y.Z | x.y.z> --output <dir> \
 *     [--app-dir <services/forge-desktop>] [--brand-dir <dir>] \
 *     [--target dir|mac|win|linux] [--arch x64|arm64|universal] [--config-only] [--json]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASAR_UNPACK, payloadFilter, resourcesFilter, summarizeResources, treeFilter, unpackedTrees } from './lib/desktop-payload.mjs';
import { ARCHIVE_VERIFIED_PREFIX } from './lib/desktop-after-pack.mjs';
import { readManifest, verifyAsset } from './derive-brand-icons.mjs';

const WIN_ICON = 'icons/app-icon.ico';
const MAC_ICON = 'icons/app-icon.icns';
const LINUX_ICON = join('sizes', 'app-icon-512.png');
const DEFAULT_BRAND_DIR = join('docs', 'assets', 'branding', 'cyber-long');
const DEFAULT_APP_DIR = join('services', 'forge-desktop');
const DEFAULT_AFTER_PACK = fileURLToPath(new URL('./lib/desktop-after-pack.mjs', import.meta.url));

const TARGET_ARCHES = Object.freeze({
  dir: ['arm64', 'x64', 'universal'],
  mac: ['arm64', 'x64', 'universal'],
  win: ['x64'],
  linux: ['x64', 'arm64'],
});

/**
 * The locales Electron keeps, each named the way the platform names its locale
 * file: Windows and Linux write `en-US.pak`, `zh-CN.pak`, `zh-TW.pak`; macOS
 * writes `en.lproj`, `zh_CN.lproj`, `zh_TW.lproj`. A system in any other locale
 * is served Electron's `en-US` resources. On macOS `desktop-after-pack.mjs`
 * removes unwanted `.lproj` directories inside `Electron Framework.framework`.
 */
const ELECTRON_LANGUAGES = ['en', 'en-US', 'zh-CN', 'zh-TW', 'zh_CN', 'zh_TW'];

export class InstallerBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallerBuildError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new InstallerBuildError(code, message);
};

/**
 * Resolve and validate `--arch` against `--target`. Each target has one default
 * architecture matching its primary build matrix entry and rejects unsupported
 * architectures before electron-builder runs.
 */
export function resolveTargetArch(target, arch) {
  const supported = TARGET_ARCHES[target];
  if (supported === undefined) fail('BAD_ARGUMENT', '--target must be dir, mac, win or linux');
  if (arch === undefined) return supported[0];
  if (!supported.includes(arch)) {
    fail('BAD_ARGUMENT', `--arch ${arch} is not supported for --target ${target} (allowed: ${supported.join(', ')})`);
  }
  return arch;
}

/**
 * The application version the installer carries, without the tag's leading `v`.
 *
 * The release lanes hand over the tag itself (`vX.Y.Z`). NSIS derives the
 * Windows numeric version from the application version and refuses a leading
 * `v` ("Invalid major number"), while the macOS `dir` target never looks — so
 * the tag form is accepted here and normalized once, for every target.
 */
export function normalizeVersion(version) {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(version ?? '');
  if (match === null) fail('BAD_ARGUMENT', '--version must be v<semver> or <semver>, for example v1.2.3');
  return match[1];
}

export function parseArguments(argv) {
  const options = {
    identity: undefined,
    resources: undefined,
    version: undefined,
    output: undefined,
    appDir: undefined,
    brandDir: undefined,
    target: 'dir',
    arch: undefined,
    configOnly: false,
    json: false,
  };
  const valued = new Map([
    ['--identity', 'identity'],
    ['--resources', 'resources'],
    ['--version', 'version'],
    ['--output', 'output'],
    ['--app-dir', 'appDir'],
    ['--brand-dir', 'brandDir'],
    ['--target', 'target'],
    ['--arch', 'arch'],
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
    if (argument === '--config-only') {
      options.configOnly = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    fail('BAD_ARGUMENT', `unknown argument ${argument}`);
  }
  options.arch = resolveTargetArch(options.target, options.arch);
  for (const key of ['identity', 'resources', 'version', 'output']) {
    if (typeof options[key] !== 'string' || options[key].trim() === '') fail('BAD_ARGUMENT', `missing required option for ${key}`);
  }
  return options;
}

export function readAppIdentity(path) {
  const identity = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (identity?.schema !== 'heluo-app-identity/1') fail('IDENTITY_INVALID', 'identity file is not schema heluo-app-identity/1');
  for (const field of ['appId', 'upgradeGuid', 'productName', 'executableName', 'displayName']) {
    if (typeof identity[field] !== 'string' || identity[field].trim() === '') fail('IDENTITY_INVALID', `identity field ${field} is missing`);
  }
  return identity;
}

/**
 * The app directory and the staged resources, as where they really are, after
 * checking that the latter is inside the former.
 *
 * electron-builder matches its unpack patterns against a path it counts from
 * the app directory — by length, not by resolving — and refuses to pack a file
 * whose real location is outside the tree it was handed. A staged tree anywhere
 * else would be unpacked by a path that means nothing, differently on every
 * machine; one reached through a link would be refused. Both are refused here
 * first, with the reason.
 *
 * @param {{appDir: string, resourcesDir: string, real?: (path: string) => string}} input `real` is an injection point for the offline tests
 * @returns {{appDir: string, resourcesDir: string}}
 */
export function stagedInsideAppDir(appDir, resourcesDir, { real = realpathSync } = {}) {
  const realAppDir = real(resolve(appDir));
  const realResourcesDir = real(resolve(resourcesDir));
  if (realResourcesDir !== realAppDir && !realResourcesDir.startsWith(`${realAppDir}${sep}`)) {
    fail('RESOURCES_OUTSIDE_APP_DIR', `the staged resources must be a real directory inside the app directory: electron-builder counts the paths it matches from there, and packs only what really lies inside it. App directory ${realAppDir}; staged resources ${realResourcesDir}`);
  }
  return { appDir: realAppDir, resourcesDir: realResourcesDir };
}

/**
 * The electron-builder configuration derived from the identity truth. Kept
 * pure: the identity fields are literals of the identity, the paths are the
 * ones this tool was handed, and the rules are what `desktop-payload.mjs` owns
 * — what travels, what the archive holds and what lies unpacked beside it,
 * which locales ship, how the installer upgrades/preserves user data, and
 * which platform architecture is targeted.
 *
 * @param {{identity: object, version: string, resourcesDir: string, iconsDir: string, appDir: string, outputDir: string,
 *   target?: string, arch?: string, afterPackPath?: string, unpackedTrees?: readonly {from: string, to: string}[]}} input
 *   `unpackedTrees` are the whole-unpacked trees the staged resources hold (`unpackedTrees()` of the rules).
 */
export function builderConfig({ identity, version, resourcesDir, iconsDir, appDir, outputDir, target = 'dir', arch, afterPackPath = DEFAULT_AFTER_PACK, unpackedTrees: trees = [] }) {
  const resolvedArch = resolveTargetArch(target, arch);
  const macArch = target === 'mac' || target === 'dir' ? resolvedArch : 'arm64';
  const linuxArch = target === 'linux' ? resolvedArch : 'x64';
  const macTargets = target === 'mac' ? ['dmg'] : ['dir'];
  return {
    appId: identity.appId,
    productName: identity.productName,
    executableName: identity.executableName,
    artifactName: `${identity.executableName}-\${version}-\${arch}.\${ext}`,
    directories: { output: resolve(outputDir), buildResources: resolve(appDir) },
    // The shell's own code, then the staged `dsh/` tree: one archive. The trees
    // that are unpacked whole are file sets of their own, each passed to the
    // archive as the directory it is unpacked from.
    files: [
      'src/**/*',
      'package.json',
      'runtime-lock.json',
      { from: resolve(resourcesDir), to: '.', filter: payloadFilter() },
      ...trees.map((tree) => ({ from: tree.from, to: tree.to, filter: treeFilter() })),
    ],
    // The staged resources minus that tree, as they were staged.
    extraResources: [{ from: resolve(resourcesDir), to: '.', filter: resourcesFilter() }],
    asar: true,
    asarUnpack: [...ASAR_UNPACK],
    compression: 'maximum',
    afterPack: afterPackPath,
    extraMetadata: { version },
    electronLanguages: [...ELECTRON_LANGUAGES],
    win: { icon: join(iconsDir, basename(WIN_ICON)), target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: {
      guid: identity.upgradeGuid,
      artifactName: `${identity.executableName}-\${version}-setup-\${arch}.\${ext}`,
      uninstallDisplayName: `${identity.displayName} \${version}`,
      oneClick: true,
      perMachine: false,
      // Upgrades converge by uninstalling differing versions and reinstalling;
      // keeping user app data ensures profile markers, logs and local state
      // survive uninstall/reinstall and rollback.
      deleteAppDataOnUninstall: false,
      // The differential form exists for electron-updater, and this app ships
      // no update feed: an upgrade reinstalls. Its block-map layout (non-solid,
      // 1 MB dictionary) is what makes the archive a third larger than a solid
      // one, which also decodes faster.
      differentialPackage: false,
    },
    mac: { icon: join(iconsDir, basename(MAC_ICON)), target: macTargets.map((kind) => ({ target: kind, arch: [macArch] })) },
    // `compression: maximum` selects UDBZ (bzip2) DMG; skip blockmap since there is no update feed.
    dmg: { writeUpdateInfo: false },
    linux: {
      icon: join(dirname(iconsDir), LINUX_ICON),
      target: [{ target: 'deb', arch: [linuxArch] }],
      category: 'Development',
      maintainer: ['Heluo Forge <heluo-forge', 'corp.example>'].join('@'),
    },
  };
}

/** Icons must be the committed, manifest-verified brand set — not redrawn. */
function verifiedIcons(brandDir) {
  const { byPath } = readManifest(brandDir);
  return {
    ico: verifyAsset(brandDir, byPath, WIN_ICON).bytes,
    icns: verifyAsset(brandDir, byPath, MAC_ICON).bytes,
    linuxPng: verifyAsset(brandDir, byPath, 'sizes/app-icon-512.png').bytes,
  };
}

/**
 * The CLI entry the `electron-builder` package declares for itself, or null
 * when it is not installed.
 *
 * pnpm exposes that CLI as one shim per shell (`.cmd` on Windows, an sh script
 * on POSIX); neither is a portable spawn target, so the build runs the declared
 * entry with the Node that runs this tool, on every platform.
 */
export function builderEntry(builderDir, exists = existsSync, read = readFileSync) {
  const manifestPath = join(builderDir, 'package.json');
  if (!exists(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const entry = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.['electron-builder'];
  if (typeof entry !== 'string') return null;
  const cli = join(builderDir, entry);
  return exists(cli) ? cli : null;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const identity = readAppIdentity(options.identity);
  if (!existsSync(resolve(options.resources))) fail('RESOURCES_MISSING', `staged resources not found: ${options.resources}`);
  const brandDir = resolve(options.brandDir ?? join(repoRoot, DEFAULT_BRAND_DIR));
  verifiedIcons(brandDir);
  // Refused here, before anything is packed, when the staged tree is not where electron-builder can match it.
  const { appDir, resourcesDir } = stagedInsideAppDir(resolve(options.appDir ?? join(repoRoot, DEFAULT_APP_DIR)), options.resources);
  const outputDir = resolve(options.output);
  const version = normalizeVersion(options.version);
  mkdirSync(outputDir, { recursive: true });

  const config = builderConfig({
    identity,
    version,
    resourcesDir,
    iconsDir: join(brandDir, 'icons'),
    appDir,
    outputDir,
    target: options.target,
    arch: options.arch,
    unpackedTrees: unpackedTrees(resourcesDir),
  });
  const configPath = join(outputDir, 'builder-config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const summary = {
    schema: 'heluo-desktop-installer/1',
    identity: { appId: identity.appId, productName: identity.productName, executableName: identity.executableName, guid: identity.upgradeGuid, displayName: identity.displayName },
    version,
    target: options.target,
    arch: options.arch,
    config: configPath,
    resources: summarizeResources(resourcesDir),
  };
  if (options.configOnly) {
    process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `config: ${configPath}\n`);
    return;
  }

  const builder = builderEntry(join(appDir, 'node_modules', 'electron-builder'));
  if (builder === null) fail('BUILDER_MISSING', `electron-builder not installed under ${appDir} (pnpm install first)`);
  const args = ['--config', configPath];
  if (options.target === 'dir') args.push('--mac', '--dir');
  else if (options.target === 'mac') args.push('--mac');
  else if (options.target === 'win') args.push('--win');
  else args.push('--linux');
  args.push(`--${options.arch}`);
  const run = spawnSync(process.execPath, [builder, ...args], { cwd: appDir, encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) {
    const outcome = run.error === undefined ? `exited ${run.status}` : `could not start (${run.error.message})`;
    fail('BUILDER_FAILED', `electron-builder ${outcome}\n${(run.stdout ?? '').slice(-4000)}\n${(run.stderr ?? '').slice(-4000)}`);
  }
  // What afterPack found when it checked the archive, in the one line it logs for this tool to keep.
  const verified = new RegExp(`^.*${ARCHIVE_VERIFIED_PREFIX}(\\{[^\\n]*\\})`, 'mu').exec(run.stdout ?? '')?.[1];
  if (verified === undefined) fail('ARCHIVE_UNVERIFIED', 'electron-builder finished without the afterPack check of the packed runtime reporting');
  summary.archive = JSON.parse(verified);
  summary.builderLog = `${run.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `built: ${outputDir} (${options.target}/${options.arch})\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof InstallerBuildError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
