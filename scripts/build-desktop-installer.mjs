#!/usr/bin/env node
/**
 * Build the desktop shell installer (CORP-DSH-PLAN-026 §4.3-7).
 *
 * The app identity comes from the employee package's `branding/app-identity.json`
 * — the same five-field truth the release lane writes — never from this file:
 * appId, upgrade GUID, productName, executable name and display name must not
 * drift between the plugin brand and the OS-level app.
 *
 * 用法：
 *   node scripts/build-desktop-installer.mjs --identity <app-identity.json> \
 *     --resources <staged resources dir> --version <vX.Y.Z | x.y.z> --output <dir> \
 *     [--app-dir <services/forge-desktop>] [--brand-dir <dir>] \
 *     [--target dir|mac|win|linux] [--arch x64|arm64|universal] \
 *     [--certificate-file <path>] [--config-only] [--json]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DSH_ENTRY_PARTS, PRIMARY_RUNTIME_DIR } from '../services/forge-desktop/src/layout.mjs';
import { readManifest, verifyAsset } from './derive-brand-icons.mjs';

const WIN_ICON = 'icons/app-icon.ico';
const MAC_ICON = 'icons/app-icon.icns';
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
 * File types the packaged runtime never reads. TypeScript sources and
 * declarations: the embedded Node refuses to strip types under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) and nothing in the closure
 * compiles TypeScript. Source maps: the shell drops NODE_OPTIONS from every
 * child environment, so `--enable-source-maps` cannot reach the runtime. Debug
 * symbols: only a debugger opens them. electron-builder's own default excludes
 * apply to the app files, not to `extraResources`, where the runtime travels.
 */
const RUNTIME_EXCLUDED_EXTENSIONS = ['.ts', '.cts', '.mts', '.map', '.pdb', '.flow'];

/**
 * Third-party packages inside `dsh/node_modules` (outside `@deepseek-ai/`)
 * carry test suites, docs, examples and changelogs that are never needed at
 * runtime; license/notice files are always preserved.
 */
const THIRD_PARTY_EXCLUDED_DIRS = [
  'test',
  'tests',
  '__tests__',
  'docs',
  'example',
  'examples',
  '.github',
  '.vscode',
  '.idea',
  'fixtures',
  '__fixtures__',
];
const THIRD_PARTY_EXCLUDED_DIR_SET = new Set(THIRD_PARTY_EXCLUDED_DIRS);
const THIRD_PARTY_EXCLUDED_DOC_EXTS = new Set(['.md', '.markdown']);
const THIRD_PARTY_EXCLUDED_DOC_PREFIXES = ['CHANGELOG', 'HISTORY'];
const THIRD_PARTY_EXCLUDED_CONFIG_GLOBS = [
  '.eslintrc*',
  '.prettier*',
  '.editorconfig',
  '.npmignore',
  '.flowconfig',
  '.babelrc*',
  'tsconfig*.json',
];
const THIRD_PARTY_LICENSE_PREFIXES = ['LICENSE', 'LICENCE', 'NOTICE', 'COPYING'];
const THIRD_PARTY_LICENSE_GLOBS = ['[Ll][Ii][Cc][Ee][Nn][SsCc][Ee]*', '[Nn][Oo][Tt][Ii][Cc][Ee]*', '[Cc][Oo][Pp][Yy][Ii][Nn][Gg]*'];

/**
 * Parity rule matching `THIRD_PARTY_EXCLUDED_CONFIG_GLOBS` exactly:
 * - exact filenames: .editorconfig, .npmignore, .flowconfig
 * - prefix matches: .eslintrc*, .prettier*, .babelrc*
 * - typescript config: tsconfig*.json (never non-json like tsconfig-loader.js)
 */
export function isExcludedConfigFile(file) {
  if (file === '.editorconfig' || file === '.npmignore' || file === '.flowconfig') return true;
  if (file.startsWith('.eslintrc') || file.startsWith('.prettier') || file.startsWith('.babelrc')) return true;
  if (file.startsWith('tsconfig') && file.endsWith('.json')) return true;
  return false;
}

/**
 * The directories that travel exactly as they were staged: the dsh artifact
 * `runtime-lock.json` pins by digest, and the bundled runtime, whose staged
 * bytes are the ones its checks ran against and its record counts. Everything
 * else under `dsh/node_modules` is the registry closure.
 */
const VERBATIM_RUNTIME_DIRS = Object.freeze([`${DSH_ENTRY_PARTS.slice(0, 4).join('/')}/`, `${PRIMARY_RUNTIME_DIR}/`]);

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
    certificateFile: undefined,
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
    ['--certificate-file', 'certificateFile'],
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
  if (options.certificateFile !== undefined) {
    if (typeof options.certificateFile !== 'string' || options.certificateFile.trim() === '') {
      fail('BAD_ARGUMENT', '--certificate-file cannot be empty');
    }
    if (options.target !== 'win') {
      fail('BAD_ARGUMENT', '--certificate-file is only supported for target win');
    }
  }
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
 * Whether a staged file reaches the package. `relativePath` is `/`-separated
 * from the resources root, and the rule matches `runtimeFilter()` identically.
 */
export function isPackaged(relativePath) {
  if (VERBATIM_RUNTIME_DIRS.some((directory) => relativePath.startsWith(directory))) return true;
  if (!relativePath.startsWith('dsh/node_modules/')) {
    if (RUNTIME_EXCLUDED_EXTENSIONS.includes(extname(relativePath))) return false;
    return true;
  }
  const segments = relativePath.slice('dsh/node_modules/'.length).split('/');
  const file = segments.at(-1) ?? '';
  const upperFile = file.toUpperCase();
  const isLicense = THIRD_PARTY_LICENSE_PREFIXES.some((prefix) => upperFile.startsWith(prefix));
  if (isLicense) return true;
  if (RUNTIME_EXCLUDED_EXTENSIONS.includes(extname(relativePath))) return false;
  if (relativePath.startsWith('dsh/node_modules/@deepseek-ai/')) {
    return true;
  }
  if (segments.slice(0, -1).some((segment) => THIRD_PARTY_EXCLUDED_DIR_SET.has(segment))) {
    return false;
  }
  if (THIRD_PARTY_EXCLUDED_DOC_EXTS.has(extname(file).toLowerCase())) return false;
  if (THIRD_PARTY_EXCLUDED_DOC_PREFIXES.some((prefix) => upperFile.startsWith(prefix))) return false;
  if (isExcludedConfigFile(file)) return false;
  return true;
}

/**
 * The `extraResources` filter. electron-builder applies its patterns in order
 * and lets a later pattern override an earlier one, so license files and each
 * verbatim directory are re-included after the exclusions, not before them.
 */
export function runtimeFilter() {
  return [
    '**/*',
    ...RUNTIME_EXCLUDED_EXTENSIONS.map((extension) => `!**/*${extension}`),
    ...THIRD_PARTY_EXCLUDED_DIRS.flatMap((dir) => [
      `!dsh/node_modules/!(@deepseek-ai)/**/${dir}`,
      `!dsh/node_modules/!(@deepseek-ai)/**/${dir}/**`,
    ]),
    '!dsh/node_modules/!(@deepseek-ai)/**/*.md',
    '!dsh/node_modules/!(@deepseek-ai)/**/*.markdown',
    '!dsh/node_modules/!(@deepseek-ai)/**/CHANGELOG*',
    '!dsh/node_modules/!(@deepseek-ai)/**/HISTORY*',
    ...THIRD_PARTY_EXCLUDED_CONFIG_GLOBS.map((glob) => `!dsh/node_modules/!(@deepseek-ai)/**/${glob}`),
    ...THIRD_PARTY_LICENSE_GLOBS.map((glob) => `dsh/node_modules/**/${glob}`),
    ...VERBATIM_RUNTIME_DIRS.map((directory) => `${directory}**`),
  ];
}

/**
 * What the staged resources amount to, and how much of them the rule leaves
 * out: the numbers every build log keeps. Regular files only; links are copied
 * as links and are not counted.
 */
export function summarizeResources(resourcesDir) {
  const root = resolve(resourcesDir);
  const summary = { files: 0, bytes: 0, excluded: { files: 0, bytes: 0 } };
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const size = statSync(path).size;
    summary.files += 1;
    summary.bytes += size;
    if (!isPackaged(relative(root, path).split(sep).join('/'))) {
      summary.excluded.files += 1;
      summary.excluded.bytes += size;
    }
  }
  return summary;
}

/**
 * The electron-builder configuration derived from the identity truth. Kept
 * pure: the identity fields are literals of the identity, the paths are the
 * ones this tool was handed, and the rules are what this file owns — what
 * travels, which locales ship, how the installer upgrades/preserves user data,
 * and which platform architecture is targeted.
 */
export function builderConfig({
  identity,
  version,
  resourcesDir,
  iconsDir,
  appDir,
  outputDir,
  target = 'dir',
  arch,
  afterPackPath = DEFAULT_AFTER_PACK,
}) {
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
    files: ['src/**/*', 'package.json', 'runtime-lock.json'],
    extraResources: [{ from: resolve(resourcesDir), to: '.', filter: runtimeFilter() }],
    asar: true,
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
      packElevateHelper: false,
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
    linux: { icon: join(iconsDir), target: [{ target: 'deb', arch: [linuxArch] }], category: 'Development' },
  };
}

/** Icons must be the committed, manifest-verified brand set — not redrawn. */
function verifiedIcons(brandDir) {
  const { byPath } = readManifest(brandDir);
  return {
    ico: verifyAsset(brandDir, byPath, WIN_ICON).bytes,
    icns: verifyAsset(brandDir, byPath, MAC_ICON).bytes,
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

/**
 * Environment variables for the electron-builder subprocess.
 *
 * Code signing credentials must never travel via CLI arguments or get written
 * to disk in builder-config.json, nor may a certificate password be passed to
 * signtool.exe via `/p` command-line arguments. When --certificate-file is
 * given, the path to a passwordless PFX is passed via WIN_CSC_LINK. Any
 * non-empty WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD in the environment is
 * rejected (fail-closed) so no password can reach child process arguments.
 */
export function builderEnv(options = {}, env = process.env) {
  const next = { ...env };
  for (const key of ['WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD']) {
    if (typeof next[key] === 'string' && next[key].trim() !== '') {
      fail('BAD_ARGUMENT', `${key} is not supported: use a passwordless PFX or Windows certificate store`);
    }
    delete next[key];
  }
  if (options?.certificateFile !== undefined) {
    if (typeof options.certificateFile !== 'string' || options.certificateFile.trim() === '') {
      fail('BAD_ARGUMENT', '--certificate-file cannot be empty');
    }
    if (options.target !== undefined && options.target !== 'win') {
      fail('BAD_ARGUMENT', '--certificate-file is only supported for target win');
    }
    next.WIN_CSC_LINK = resolve(options.certificateFile);
  }
  return next;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const identity = readAppIdentity(options.identity);
  if (!existsSync(resolve(options.resources))) fail('RESOURCES_MISSING', `staged resources not found: ${options.resources}`);
  const brandDir = resolve(options.brandDir ?? join(repoRoot, DEFAULT_BRAND_DIR));
  verifiedIcons(brandDir);
  const appDir = resolve(options.appDir ?? join(repoRoot, DEFAULT_APP_DIR));
  const outputDir = resolve(options.output);
  const version = normalizeVersion(options.version);
  mkdirSync(outputDir, { recursive: true });

  const config = builderConfig({
    identity,
    version,
    resourcesDir: options.resources,
    iconsDir: join(brandDir, 'icons'),
    appDir,
    outputDir,
    target: options.target,
    arch: options.arch,
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
    resources: summarizeResources(options.resources),
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
  const childEnv = builderEnv(options, process.env);
  const run = spawnSync(process.execPath, [builder, ...args], { cwd: appDir, env: childEnv, encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) {
    const outcome = run.error === undefined ? `exited ${run.status}` : `could not start (${run.error.message})`;
    fail('BUILDER_FAILED', `electron-builder ${outcome}\n${(run.stdout ?? '').slice(-4000)}\n${(run.stderr ?? '').slice(-4000)}`);
  }
  summary.builderLog = `${run.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `built: ${outputDir} (${options.target}/${options.arch})\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof InstallerBuildError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
