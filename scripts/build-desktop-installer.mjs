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
 *     --resources <staged resources dir> --version <x.y.z> --output <dir> \
 *     [--app-dir <services/forge-desktop>] [--brand-dir <dir>] [--target dir|mac|win] [--config-only] [--json]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManifest, verifyAsset } from './derive-brand-icons.mjs';

const WIN_ICON = 'icons/app-icon.ico';
const MAC_ICON = 'icons/app-icon.icns';
const DEFAULT_BRAND_DIR = join('docs', 'assets', 'branding', 'cyber-long');
const DEFAULT_APP_DIR = join('services', 'forge-desktop');

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

export function parseArguments(argv) {
  const options = { identity: undefined, resources: undefined, version: undefined, output: undefined, appDir: undefined, brandDir: undefined, target: 'dir', configOnly: false, json: false };
  const valued = new Map([
    ['--identity', 'identity'],
    ['--resources', 'resources'],
    ['--version', 'version'],
    ['--output', 'output'],
    ['--app-dir', 'appDir'],
    ['--brand-dir', 'brandDir'],
    ['--target', 'target'],
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
  if (!['dir', 'mac', 'win'].includes(options.target)) fail('BAD_ARGUMENT', '--target must be dir, mac or win');
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
 * The electron-builder configuration derived from the identity truth. Kept
 * pure: every field an installer carries is either a literal of the identity
 * or a path this tool was handed, nothing invented here.
 */
export function builderConfig({ identity, version, resourcesDir, iconsDir, appDir, outputDir }) {
  return {
    appId: identity.appId,
    productName: identity.productName,
    executableName: identity.executableName,
    artifactName: `${identity.executableName}-\${version}-\${arch}.\${ext}`,
    directories: { output: resolve(outputDir), buildResources: resolve(appDir) },
    files: ['src/**/*', 'package.json', 'runtime-lock.json'],
    extraResources: [{ from: resolve(resourcesDir), to: '.' }],
    asar: true,
    extraMetadata: { version },
    win: { icon: join(iconsDir, basename(WIN_ICON)), target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: {
      guid: identity.upgradeGuid,
      artifactName: `${identity.executableName}-\${version}-setup-\${arch}.\${ext}`,
      oneClick: true,
      perMachine: false,
    },
    mac: { icon: join(iconsDir, basename(MAC_ICON)), target: [{ target: 'dir', arch: ['arm64'] }] },
    linux: { icon: join(iconsDir), target: [{ target: 'deb', arch: ['x64'] }] },
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const identity = readAppIdentity(options.identity);
  if (!existsSync(resolve(options.resources))) fail('RESOURCES_MISSING', `staged resources not found: ${options.resources}`);
  const brandDir = resolve(options.brandDir ?? join(repoRoot, DEFAULT_BRAND_DIR));
  verifiedIcons(brandDir);
  const appDir = resolve(options.appDir ?? join(repoRoot, DEFAULT_APP_DIR));
  const outputDir = resolve(options.output);
  mkdirSync(outputDir, { recursive: true });

  const config = builderConfig({
    identity,
    version: options.version,
    resourcesDir: options.resources,
    iconsDir: join(brandDir, 'icons'),
    appDir,
    outputDir,
  });
  const configPath = join(outputDir, 'builder-config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const summary = {
    schema: 'heluo-desktop-installer/1',
    identity: { appId: identity.appId, productName: identity.productName, executableName: identity.executableName, guid: identity.upgradeGuid, displayName: identity.displayName },
    version: options.version,
    target: options.target,
    config: configPath,
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
  else args.push('--win');
  const run = spawnSync(process.execPath, [builder, ...args], { cwd: appDir, encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) {
    const outcome = run.error === undefined ? `exited ${run.status}` : `could not start (${run.error.message})`;
    fail('BUILDER_FAILED', `electron-builder ${outcome}\n${(run.stdout ?? '').slice(-4000)}\n${(run.stderr ?? '').slice(-4000)}`);
  }
  summary.builderLog = `${run.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `built: ${outputDir} (${options.target})\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof InstallerBuildError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
