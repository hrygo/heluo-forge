#!/usr/bin/env node
/**
 * Public release builder (issue #222 item ③).
 *
 * Builds one cross-platform plugin tarball from a tagged clean checkout, refuses
 * to publish it unless it is configuration-neutral and license-declared, and
 * bundles the exact maker/initializer toolchain the private flow requires.
 *
 * The output directory is a delivery directory, never a source of truth: every
 * digest in `release-manifest.json` is recomputed from the bytes written here.
 *
 * Usage:
 *   node scripts/build-public-release.mjs --output dist/public \
 *     [--tag <release-tag>] [--license Apache-2.0] [--repo-root <dir>] [--allow-dirty]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBundle, writeBundleArtifacts } from './build-enterprise-bundle.mjs';
import { verifyBundle } from './verify-enterprise-bundle.mjs';
import { readBundleEntries } from './lib/bundle-archive.mjs';
import { writeBundleTarball } from './lib/bundle-write.mjs';
import { IAM_VALIDATOR_MODULES, TOOL_NAME, TOOL_VERSION, assertIamValidatorMatches, assertNeutralPatch } from './lib/private-bundle.mjs';
import { scanReleaseFiles, sha256, stableJson } from './lib/release-support.mjs';

export const PUBLIC_RELEASE_SCHEMA = 'heluo-public-release/1';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[0-9a-f]{64}$/u;
const FORBIDDEN_SOURCE = /(^|\/)(\.env(\.|$)|\.npmrc$|id_rsa$|id_ed25519$|\.p12$|\.pfx$|\.key$|\.pem$)/u;

const fail = (code, message, details) => {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  throw error;
};

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertCleanTag(root, { tag, allowDirty }) {
  const gitDirectory = join(root, '.git');
  if (!existsSync(gitDirectory)) return { commit: null, tag: null, dirty: false, git: false };
  const status = git(root, ['status', '--porcelain']);
  if (status !== '' && !allowDirty) fail('WORKTREE_DIRTY', `refusing to build a public release from a dirty tree:\n${status}`);
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (tag !== undefined) {
    let tagged;
    try {
      tagged = git(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
    } catch {
      fail('TAG_MISSING', `tag ${tag} does not exist`);
    }
    if (tagged !== commit) fail('TAG_MISMATCH', `tag ${tag} points at ${tagged}, not at HEAD ${commit}`);
  }
  return { commit, tag: tag ?? null, dirty: status !== '', git: true };
}

function licenseOf(manifest) {
  const license = typeof manifest?.license === 'string' ? manifest.license.trim() : '';
  return license === '' || license === 'UNLICENSED' ? undefined : license;
}

function collectLicenseInventory(entries, declared) {
  const inventory = [];
  for (const entry of entries) {
    const isRoot = entry.path === 'package.json';
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/u.exec(entry.path);
    if (!isRoot && match === null) continue;
    const manifest = JSON.parse(entry.content.toString('utf8'));
    inventory.push({
      name: manifest.name ?? match?.[1] ?? 'unknown',
      version: manifest.version ?? 'unknown',
      license: typeof manifest.license === 'string' && manifest.license.trim() !== '' ? manifest.license : null,
      entry: isRoot,
    });
  }
  inventory.sort((left, right) => (left.name === right.name ? left.version.localeCompare(right.version) : left.name.localeCompare(right.name)));
  const missing = inventory.filter((item) => item.license === null).map((item) => `${item.name}@${item.version}`);
  return { inventory, missing, declared };
}

function listFiles(root, relativeDirectory, filter = () => true) {
  const base = join(root, relativeDirectory);
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) {
        const path = relative(root, full).split('\\').join('/');
        if (filter(path)) files.push(path);
      }
    }
  };
  if (existsSync(base)) walk(base);
  return files;
}

function releaseToolFiles(root) {
  const roots = [
    'scripts/build-enterprise-bundle.mjs',
    'scripts/verify-enterprise-bundle.mjs',
    'scripts/build-public-release.mjs',
    'scripts/make-private-bundle.mjs',
    'scripts/init-enterprise-plugin.mjs',
    'scripts/release-delivery.mjs',
  ];
  const files = roots.filter((path) => existsSync(join(root, path)));
  files.push(...listFiles(root, 'scripts/lib', (path) => path.endsWith('.mjs')));
  files.push(...listFiles(root, '.agents/skills/heluo-forge-release-bundle'));
  // The maker invokes the same config validator as the IAM runtime. Include
  // its complete local import closure so the released toolchain stays standalone.
  files.push(...IAM_VALIDATOR_MODULES
    .map((name) => `packages/forge-iam/src/${name}`));
  for (const path of files) {
    if (!existsSync(join(root, path))) fail('TOOLS_INCOMPLETE', `release toolchain is missing ${path}`);
  }
  return files.sort();
}

function sourceGate(root, tracked) {
  const problems = [];
  for (const path of tracked) {
    if (FORBIDDEN_SOURCE.test(path)) problems.push(`${path}: credential-like path may not be published in the source archive`);
  }
  return problems;
}

/**
 * Build the public release directory.
 *
 * @param {{root?: string, toolRoot?: string, output: string, tag?: string, license?: string,
 *   allowDirty?: boolean, includeSource?: boolean}} input
 * `toolRoot` is where the maker/initializer toolchain is read from; it defaults to
 * the built checkout but tests (and a release captain assembling tools from a
 * separate verified tree) can point it elsewhere. It is never shipped as source.
 */
export function buildPublicRelease(input) {
  const root = resolve(input.root ?? repo);
  const toolRoot = resolve(input.toolRoot ?? root);
  const output = resolve(input.output);
  if (!existsSync(join(root, 'package.json'))) fail('ROOT_INVALID', `${root} has no package.json`);
  if (existsSync(output) && readdirSync(output).length > 0) fail('OUTPUT_EXISTS', `output directory is not empty: ${output}`);

  const rootManifest = readJson(join(root, 'package.json'));
  const declaredLicense = input.license ?? licenseOf(rootManifest);
  if (declaredLicense === undefined) {
    fail('LICENSE_MISSING', 'a public release needs an explicit license: pass --license <SPDX> or set a non-UNLICENSED "license" in package.json');
  }
  if (!/^[A-Za-z0-9.+-]+$/u.test(declaredLicense)) fail('LICENSE_INVALID', `license "${declaredLicense}" is not an SPDX-like identifier`);

  const gitState = assertCleanTag(root, { tag: input.tag, allowDirty: input.allowDirty === true });
  const tracked = gitState.git ? git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean) : [];
  if (gitState.git) {
    const problems = sourceGate(root, tracked);
    if (problems.length > 0) fail('SOURCE_UNSAFE', `source tree failed the public gate:\n- ${problems.join('\n- ')}`);
  }

  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.heluo-public-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const bundleDirectory = join(staging, 'artifact');
    const built = buildBundle({ root, destination: bundleDirectory });
    const tarballName = built.tarball.slice(built.tarball.lastIndexOf('/') + 1);
    const tarballPath = join(staging, tarballName);
    renameSync(built.tarball, tarballPath);
    const entries = readBundleEntries(tarballPath, { withContent: true });
    const patch = entries.find((entry) => entry.path === 'cordis.patch.yml');
    if (patch === undefined) fail('ARTIFACT_INVALID', 'public tarball has no cordis.patch.yml');
    const neutral = assertNeutralPatch(patch.content.toString('utf8'));
    if (neutral.length > 0) fail('ARTIFACT_NOT_NEUTRAL', `public tarball carries enterprise configuration:\n- ${neutral.join('\n- ')}`);
    assertIamValidatorMatches(entries, { toolRoot });
    const scan = scanReleaseFiles(entries.map((entry) => ({ path: entry.path, body: entry.content })), { publicOnly: true });
    if (scan.length > 0) fail('ARTIFACT_SENSITIVE', `public tarball failed the sensitive scan:\n- ${scan.join('\n- ')}`);

    const sidecar = writeBundleArtifacts({
      destination: staging,
      tarballPath,
      entry: { name: built.manifest.name, version: built.manifest.version },
      members: built.members,
      entries,
    });
    // Reuse the buyer's verifier on the artifact we are about to publish.
    const checked = verifyBundle(tarballPath, { manifestPath: sidecar.manifestPath });
    if (!checked.ok) fail('ARTIFACT_INVALID', `public tarball failed verification:\n- ${checked.errors.join('\n- ')}`);

    const licenses = collectLicenseInventory(entries, declaredLicense);
    if (licenses.inventory.find((item) => item.entry)?.license === 'UNLICENSED' && input.license === undefined) {
      fail('LICENSE_CONFLICT', 'package.json says UNLICENSED; pass --license to declare the release license explicitly');
    }
    const licensesText = stableJson({ schema: 'heluo-license-inventory/1', declared: declaredLicense, packages: licenses.inventory });
    writeFileSync(join(staging, 'LICENSES.json'), licensesText);

    let source = null;
    if (gitState.git && input.includeSource !== false) {
      const sourceName = `heluo-forge-${rootManifest.version}-source.tar.gz`;
      execFileSync('git', ['archive', '--format=tar.gz', `--prefix=heluo-forge-${rootManifest.version}/`, '-o', join(staging, sourceName), 'HEAD'], { cwd: root });
      source = { name: sourceName, sha256: sha256(readFileSync(join(staging, sourceName))), bytes: statSync(join(staging, sourceName)).size, commit: gitState.commit };
    }

    const toolFiles = releaseToolFiles(toolRoot);
    const toolPrefix = `${TOOL_NAME}-${TOOL_VERSION}/`;
    const toolBytes = writeBundleTarball(
      [
        ...toolFiles.map((path) => ({ path: `toolchain/${path}`, body: readFileSync(join(toolRoot, path)), mode: 0o644 })),
        {
          path: 'toolchain/README.md',
          mode: 0o644,
          body: Buffer.from(
            [
              `# ${TOOL_NAME} ${TOOL_VERSION}`,
              '',
              '离线发布工具链。解压后按 `toolchain/.agents/skills/heluo-forge-release-bundle/SKILL.md` 的步骤执行；',
              '真实企业配置只从仓库外的 `.env` 读取，任何密钥都不得写入日志、报告或 argv。',
              '',
              `source commit: ${gitState.commit ?? 'not-a-git-checkout'}`,
              `plugin tarball: ${tarballName}`,
              '',
            ].join('\n'),
          ),
        },
      ],
      { prefix: toolPrefix },
    );
    const toolsName = `${TOOL_NAME}-${TOOL_VERSION}.tgz`;
    writeFileSync(join(staging, toolsName), toolBytes);
    const tools = { name: toolsName, sha256: sha256(toolBytes), bytes: toolBytes.length, files: toolFiles.length };

    const release = {
      schema: PUBLIC_RELEASE_SCHEMA,
      entry: { name: built.manifest.name, version: built.manifest.version },
      tag: gitState.tag,
      commit: gitState.commit,
      git: gitState.git,
      license: { declared: declaredLicense, packageJson: rootManifest.license ?? null },
      toolchain: { node: process.version, npm: 'repo-scripts' },
      tools,
      artifact: { name: tarballName, sha256: sha256(readFileSync(tarballPath)), bytes: statSync(tarballPath).size, files: entries.length },
      source,
      configNeutral: true,
    };
    const releaseText = stableJson(release);
    writeFileSync(join(staging, 'release-manifest.json'), releaseText);
    writeFileSync(
      join(staging, 'README.md'),
      [
        '# 公版发布制品',
        '',
        `插件包：${tarballName}`,
        `版本：${built.manifest.version}`,
        `许可：${declaredLicense}`,
        `提交：${gitState.commit ?? 'not-a-git-checkout'}`,
        '',
        '本目录只包含公版插件、制作工具与清单；不包含企业配置、密钥或个人数据。',
        '使用 `bundle-manifest.json` 与 `SHA256SUMS` 校验下载完整性后再交付员工或制作私版。',
        '',
      ].join('\n'),
    );

    // `writeBundleArtifacts` already wrote an artifact-level SHA256SUMS here;
    // the delivery-level file below replaces it, so it must not be hashed as a
    // sibling (that would record the old bytes and fail its own verification).
    const files = readdirSync(staging)
      .filter((name) => name !== 'artifact' && name !== 'SHA256SUMS')
      .sort()
      .map((name) => {
        const path = join(staging, name);
        return { name, sha256: sha256(readFileSync(path)), bytes: statSync(path).size };
      });
    const sums = `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`;
    writeFileSync(join(staging, 'SHA256SUMS'), sums);
    const dirScan = scanReleaseFiles(files.filter((file) => file.name.endsWith('.json') || file.name.endsWith('.md')).map((file) => ({ path: file.name, body: readFileSync(join(staging, file.name)) })), { publicOnly: true });
    if (dirScan.length > 0) fail('RELEASE_SENSITIVE', `release sidecars failed the sensitive scan:\n- ${dirScan.join('\n- ')}`);

    rmSync(bundleDirectory, { recursive: true, force: true });
    if (existsSync(output)) rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
    return {
      output,
      tarball: join(output, tarballName),
      version: built.manifest.version,
      sha256: release.artifact.sha256,
      manifest: join(output, 'release-manifest.json'),
      sums: join(output, 'SHA256SUMS'),
      tools: join(output, toolsName),
      source: source === null ? null : join(output, source.name),
      license: declaredLicense,
      neutral: true,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const options = { root: repo, tag: undefined, license: undefined, allowDirty: false, includeSource: true };
  const valued = new Map([
    ['--output', 'output'],
    ['--tag', 'tag'],
    ['--license', 'license'],
    ['--repo-root', 'root'],
    ['--tool-root', 'toolRoot'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-dirty') {
      options.allowDirty = true;
      continue;
    }
    if (argument === '--no-source') {
      options.includeSource = false;
      continue;
    }
    const field = valued.get(argument);
    if (field === undefined) throw new Error(`unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a value`);
    options[field] = value;
    index += 1;
  }
  if (typeof options.output !== 'string' || options.output === '') throw new Error('--output is required');
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = buildPublicRelease(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { parseArguments, licenseOf };
