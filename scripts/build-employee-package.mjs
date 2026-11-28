#!/usr/bin/env node
/**
 * Unified employee package builder (CORP-DSH-PLAN-026 §4.0).
 *
 * One tagged source commit goes in, one employee package comes out:
 *
 *   - `enterprise-plugin/` — the enterprise plugin tarball with the enterprise
 *     configuration injected into its patch layer, beside the installer
 *   - `engineering-plugin/` — the engineering extension, neutral (`--with-engineering`)
 *   - `installer/`, `INSTALL.md` — what the employee runs
 *   - `employee-manifest.json` — source commit, package digests and config key names
 *   - `SHA256SUMS` — every file of the package
 *
 * The package is assembled from the source tree by the existing gates: the
 * public release builder (clean checkout at the tag, configuration-neutral
 * artifact, artifact closure), then the delivery builder (maker validation,
 * private tarball, independent verification). This script only sequences them
 * and records what was built.
 *
 * What it must never do: put a configuration value into the manifest, the
 * release notes, the log or an error. The manifest carries key names only.
 * The client secret is carried as a file for first-run provisioning and never
 * enters the patch layer.
 *
 * The protected environment's approval is the human confirmation of a build;
 * the maker's interactive `--confirm` digest is therefore supplied by this
 * script from the very inputs it passes to the delivery builder.
 *
 * Discovery is not checked here: a runner cannot reach the enterprise IAM.
 * The receipt records it as not run; the first enterprise login verifies it.
 *
 * 用法：
 *   node scripts/build-employee-package.mjs --tag <v-semver> --output <dir> \
 *     (--config <file> | --config-from-env) [--repo-root <dir>] [--license <SPDX>] \
 *     [--with-engineering] [--notes <file>] [--previous-issuer <issuer>]... \
 *     [--allow-dirty] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPublicRelease } from './build-public-release.mjs';
import { buildDelivery } from './release-delivery.mjs';
import { readDshVersion } from './lib/dsh-version.mjs';
import {
  buildConfig,
  parseEnvConfig,
  planDigest,
  readConfigFile,
  resolveBundleConfig,
  SUPPORTED_PLATFORMS,
} from './lib/private-bundle.mjs';
import { configTextFromEnv } from './lib/release-config.mjs';
import { sha256, stableJson, zipDirectory } from './lib/release-support.mjs';

export const EMPLOYEE_PACKAGE_SCHEMA = 'heluo-employee-package/1';
export const EMPLOYEE_MANIFEST_FILE = 'employee-manifest.json';
export const ENTERPRISE_ENTRY = '@heluo/forge-enterprise';
export const ENGINEERING_ENTRY = '@heluo/forge-engineering';
const DISCOVERY_NOT_RUN = Object.freeze({ checked: false, reason: 'not-run: the runner cannot reach the enterprise IAM' });
const COMMIT = /^[0-9a-f]{40}$/u;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class EmployeePackageError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EmployeePackageError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new EmployeePackageError(code, message, details);
};

/**
 * The tag names the employee package; the private plugin inside carries a
 * build suffix so that it never shares a version with the neutral public
 * artifact: the same name and version must mean the same bytes.
 */
export function employeeVersionOf(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag ?? '');
  if (match === null) fail('TAG_INVALID', 'tag must be v<semver>, for example v1.2.3');
  return { packageVersion: match[1], pluginVersion: `${match[1]}-corp.1` };
}

export function parseArguments(argv) {
  const options = {
    tag: undefined,
    output: undefined,
    config: undefined,
    configFromEnv: false,
    repoRoot: undefined,
    license: undefined,
    withEngineering: false,
    notes: undefined,
    allowDirty: false,
    previousIssuers: [],
    json: false,
  };
  const valued = new Map([
    ['--tag', 'tag'],
    ['--output', 'output'],
    ['--config', 'config'],
    ['--repo-root', 'repoRoot'],
    ['--license', 'license'],
    ['--notes', 'notes'],
  ]);
  const FLAGS = {
    '--config-from-env': 'configFromEnv',
    '--with-engineering': 'withEngineering',
    '--allow-dirty': 'allowDirty',
    '--json': 'json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('BAD_ARGUMENT', `${argument} requires a value`);
      options[valued.get(argument)] = value;
      index += 1;
      continue;
    }
    if (argument === '--previous-issuer') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('BAD_ARGUMENT', `${argument} requires a value`);
      options.previousIssuers.push(value);
      index += 1;
      continue;
    }
    if (Object.hasOwn(FLAGS, argument)) {
      options[FLAGS[argument]] = true;
      continue;
    }
    fail('BAD_ARGUMENT', `unknown argument ${argument}`);
  }
  for (const [flag, key] of [['--tag', 'tag'], ['--output', 'output']]) {
    if (typeof options[key] !== 'string' || options[key].trim() === '') fail('BAD_ARGUMENT', `${flag} is required`);
  }
  // Two configuration sources at once would leave it undecided which one won.
  if (options.configFromEnv === (options.config !== undefined)) {
    fail('BAD_ARGUMENT', 'give exactly one of --config <file> and --config-from-env');
  }
  return options;
}

/**
 * The validated configuration, from a snapshot, a mode-600 file or the mapped
 * environment. Validation is the maker's: a value the plugins would refuse at
 * load time is refused here, by key name, before anything is built.
 */
export function resolveEmployeeConfig({ config, configPath, env } = {}) {
  if (config !== undefined) return resolveBundleConfig({ config, allowSecret: true });
  const text = env !== undefined ? configTextFromEnv(env) : readConfigFile(resolve(configPath));
  const entries = parseEnvConfig(text, { allowSecret: true });
  // Employee packages target the enterprise IAM's confirmed work-number claim.
  if (!entries.some(({ key }) => key === 'HELUO_IAM_PROFILE_FIELDS')) {
    entries.push({ key: 'HELUO_IAM_PROFILE_FIELDS', value: 'workNo=employeeNumber' });
  }
  return buildConfig(entries);
}

function readReleaseManifest(path) {
  let release;
  try {
    release = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('SOURCE_INVALID', 'the built plugin release has no readable release manifest');
  }
  if (typeof release.commit !== 'string' || !COMMIT.test(release.commit)) {
    fail('SOURCE_UNKNOWN', 'the source commit is unknown; build from a Git checkout of the tag');
  }
  for (const field of ['entry', 'artifact']) {
    if (release[field] === null || typeof release[field] !== 'object') fail('SOURCE_INVALID', `the release manifest has no ${field} record`);
  }
  return release;
}

function isDirty(root) {
  try {
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim() !== '';
  } catch {
    // Without a usable answer the source is not known to be clean.
    return true;
  }
}

function hostVersion(root) {
  try {
    return readDshVersion(root);
  } catch {
    return fail('HOST_VERSION_UNKNOWN', '.dsh-version is missing or not a version in the source tree');
  }
}

/** Every regular file under `root` as POSIX paths relative to it, sorted. */
function filesOf(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

function sumsOf(root, files) {
  return `${files.map((file) => `${sha256(readFileSync(join(root, file)))}  ${file}`).join('\n')}\n`;
}

/** Hash a file in bounded memory: the archive can be hundreds of megabytes. */
function sha256OfFile(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    for (let read = readSync(descriptor, buffer, 0, buffer.length, null); read > 0; read = readSync(descriptor, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function assertDestinationFree(output, archive) {
  if (existsSync(archive)) fail('OUTPUT_EXISTS', `archive already exists: ${archive}`);
  if (existsSync(output) && (!statSync(output).isDirectory() || readdirSync(output).length > 0)) {
    fail('OUTPUT_EXISTS', `output directory is not empty: ${output}`);
  }
}

/**
 * Build the employee package of a tag.
 *
 * @param {{tag: string, output: string, config?: object, configPath?: string, env?: object,
 *   repoRoot?: string, license?: string, withEngineering?: boolean, previousIssuers?: string[],
 *   allowDirty?: boolean, zipCommand?: string,
 *   buildPublicReleaseImpl?: Function, buildDeliveryImpl?: Function}} input
 *   The two `*Impl` options are injection points for tests; production always
 *   runs the real builders.
 */
export function buildEmployeePackage(input) {
  const root = resolve(input.repoRoot ?? repo);
  const buildPublic = input.buildPublicReleaseImpl ?? buildPublicRelease;
  const buildDeliveryOf = input.buildDeliveryImpl ?? buildDelivery;
  const output = resolve(input.output);
  const archive = `${output}.zip`;
  const { packageVersion, pluginVersion } = employeeVersionOf(input.tag);
  // Validated before the first build runs: a bad key must not cost a build.
  const config = resolveEmployeeConfig({ config: input.config, configPath: input.configPath, env: input.env });
  const previousIssuers = Array.isArray(input.previousIssuers) ? input.previousIssuers : [];
  assertDestinationFree(output, archive);

  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  // Built beside the destination and moved into place only when complete, so a
  // failed run never leaves a half package under the requested name.
  const staging = join(parent, `.heluo-employee-${process.pid}-${Date.now().toString(36)}`);
  const content = join(staging, basename(output));
  mkdirSync(staging, { mode: 0o700 });
  try {
    // The toolchain (builders, installer, validators) is the checkout this
    // script runs from; `root` is only the source being built.
    const publicInput = { root, tag: input.tag, license: input.license, allowDirty: input.allowDirty === true, includeSource: false, toolRoot: repo };
    const built = buildPublic({ ...publicInput, output: join(staging, 'public') });
    const release = readReleaseManifest(built.manifest);
    if (release.tag !== input.tag) fail('TAG_MISMATCH', `the plugin release was built for ${release.tag}, not ${input.tag}`);
    if (release.entry.name !== ENTERPRISE_ENTRY) fail('SOURCE_INVALID', `the plugin release is ${release.entry.name}, not ${ENTERPRISE_ENTRY}`);

    const delivery = buildDeliveryOf({
      publicPath: built.tarball,
      publicSha256: release.artifact.sha256,
      config,
      version: pluginVersion,
      output: content,
      toolRoot: repo,
      confirm: planDigest({ publicSha256: release.artifact.sha256, version: pluginVersion, config, platforms: SUPPORTED_PLATFORMS }),
      embedClientSecret: true,
      previousIssuers,
      discovery: DISCOVERY_NOT_RUN,
      zipCommand: input.zipCommand,
    });
    const packages = [
      {
        role: 'enterprise',
        name: ENTERPRISE_ENTRY,
        version: delivery.privateVersion,
        file: relative(content, delivery.privateTarball).split(sep).join('/'),
        sha256: delivery.privateSha256,
      },
    ];
    // The engineering extension declares no IAM row, so it carries no
    // configuration: the neutral tarball is the whole of it.
    if (input.withEngineering === true) {
      const engineering = buildPublic({ ...publicInput, entry: ENGINEERING_ENTRY, output: join(staging, 'engineering') });
      const engineeringRelease = readReleaseManifest(engineering.manifest);
      const tarballName = basename(engineering.tarball);
      mkdirSync(join(content, 'engineering-plugin'));
      for (const name of [tarballName, 'bundle-manifest.json']) {
        copyFileSync(join(engineering.output, name), join(content, 'engineering-plugin', name));
      }
      packages.push({
        role: 'engineering',
        name: ENGINEERING_ENTRY,
        version: engineeringRelease.entry.version,
        file: `engineering-plugin/${tarballName}`,
        sha256: engineeringRelease.artifact.sha256,
      });
    }

    // Key names only: `config` is never read below this point.
    const result = {
      schema: EMPLOYEE_PACKAGE_SCHEMA,
      tag: input.tag,
      version: packageVersion,
      source: { commit: release.commit, dirty: isDirty(root) },
      host: { dshVersion: hostVersion(root) },
      packages,
      branding: delivery.branding,
      configKeys: delivery.configKeys,
      clientSecretEmbedded: delivery.clientSecretEmbedded,
      discovery: DISCOVERY_NOT_RUN,
    };
    writeFileSync(join(content, EMPLOYEE_MANIFEST_FILE), stableJson(result));

    // The delivery builder's list predates the manifest and the engineering directory.
    writeFileSync(join(content, 'SHA256SUMS'), sumsOf(content, filesOf(content).filter((file) => file !== 'SHA256SUMS')));

    const partial = join(staging, 'archive.zip');
    try {
      zipDirectory({ staging, name: basename(content), archive: partial, zipCommand: input.zipCommand });
    } catch (error) {
      fail('ARCHIVE_FAILED', `zip failed (${error?.code ?? error?.status ?? 'UNKNOWN'}); nothing was published`);
    }
    // Superseded by the archive above, which also holds the added files.
    rmSync(`${content}.zip`, { force: true });
    const archiveSha256 = sha256OfFile(partial);

    // Checked again just before publishing: a path that appeared during the
    // build belongs to someone else and is never replaced.
    assertDestinationFree(output, archive);
    renameSync(partial, archive);
    try {
      if (existsSync(output)) rmdirSync(output);
      renameSync(content, output);
    } catch (error) {
      rmSync(archive, { force: true });
      throw error;
    }
    return { ...result, output, archive, archiveSha256 };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Body for the draft Release: traceability only, never a configuration value. */
export function releaseNotesOf(result) {
  return [
    `# ${result.tag}（草稿）`,
    '',
    '由统一构建从 tag 对应的源提交产出；草稿 Release 仅仓库写权限协作者可见。',
    '',
    `- 源提交：\`${result.source.commit}\`${result.source.dirty ? '（含未提交改动，仅限演练，不得分发）' : ''}`,
    `- 宿主 DSH 版本：\`${result.host.dshVersion}\`（根目录 \`.dsh-version\` 锁定版）`,
    `- 员工包版本：\`${result.version}\``,
    '',
    '## 资产',
    '',
    '| 资产 | 字节 | SHA-256 |',
    '|---|---|---|',
    `| ${basename(result.archive)} | ${statSync(result.archive).size} | \`${result.archiveSha256}\` |`,
    '',
    '## 插件包',
    '',
    '| 包 | 版本 | SHA-256 |',
    '|---|---|---|',
    ...result.packages.map((pkg) => `| ${pkg.name} | ${pkg.version} | \`${pkg.sha256}\` |`),
    '',
    '## 配置键（仅键名）',
    '',
    ...result.configKeys.map((key) => `- \`${key}\``),
    '',
    '未核验项：Discovery 预检未在构建时执行（runner 访问不到企业 IAM），首次企业登录时一并验证。',
    '',
  ].join('\n');
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = buildEmployeePackage({
    repoRoot: options.repoRoot,
    tag: options.tag,
    output: options.output,
    configPath: options.config,
    env: options.configFromEnv ? process.env : undefined,
    license: options.license ?? process.env.HELUO_PUBLIC_LICENSE,
    withEngineering: options.withEngineering,
    previousIssuers: options.previousIssuers,
    allowDirty: options.allowDirty,
  });
  if (options.notes !== undefined) {
    mkdirSync(dirname(resolve(options.notes)), { recursive: true });
    writeFileSync(resolve(options.notes), releaseNotesOf(result));
  }
  const summary = {
    tag: result.tag,
    version: result.version,
    source: result.source,
    output: result.output,
    archive: result.archive,
    archiveSha256: result.archiveSha256,
    packages: result.packages,
    configKeys: result.configKeys,
    clientSecretEmbedded: result.clientSecretEmbedded,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${stableJson(summary)}`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'FAILED';
    process.stderr.write(`${code}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
