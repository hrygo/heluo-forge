/**
 * Full-installer assembly for issue #222 item ⑤.
 *
 * A full installer is *data*: per platform it carries the official host archive,
 * the verified private plugin tarball, an `install.json` that the platform
 * procedure reads, and digests. It never invents a host download and never
 * claims a signature was verified -- `signature` is what the release engineer
 * declared, and `verify` reports it as declared, not as validated.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { readBundleEntries } from './bundle-archive.mjs';
import { PRIVATE_METADATA_FILE, PRIVATE_SCHEMA, PrivateBundleError, SUPPORTED_PLATFORMS, TOOL_NAME, TOOL_VERSION } from './private-bundle.mjs';
import { scanReleaseFiles, sha256, stableJson } from './release-support.mjs';

export const INSTALLER_SCHEMA = 'heluo-full-installer/1';
export const INPUTS_SCHEMA = 'heluo-installer-inputs/1';
export const INSTALL_SCHEMA = 'heluo-installer/1';
export const DEFAULT_WEB_PORT = 58260;

const fail = (code, message, details) => {
  throw new PrivateBundleError(code, message, details);
};

export const PLATFORM_DEFAULT_FORM = Object.freeze({
  'windows-x64': 'desktop',
  'windows-arm64': 'web',
  'linux-x64': 'web',
  'linux-arm64': 'web',
  'macos-x64': 'desktop',
  'macos-arm64': 'desktop',
});

const HOST_EXTENSIONS = /\.(zip|tar\.gz|tgz|tar\.xz|dmg|exe|AppImage)$/u;
const SIGNATURE_VALUES = new Set(['signed', 'unsigned', 'notarized', 'unknown']);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INPUTS_INVALID', `${field} must be a non-empty string`);
  return value;
}

function requireDigest(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) fail('INPUTS_INVALID', `${field} must be a lowercase sha256 digest`);
  return value;
}

export function readInstallerInputs(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail('INPUTS_INVALID', `cannot read installer inputs "${path}": ${error.code ?? error.message}`);
  }
  if (parsed?.schema !== INPUTS_SCHEMA) fail('INPUTS_INVALID', `installer inputs must declare schema ${INPUTS_SCHEMA}`);
  const host = parsed.host;
  if (host === null || typeof host !== 'object') fail('INPUTS_INVALID', 'inputs.host is required');
  requireText(host.version, 'host.version');
  requireText(host.license, 'host.license');
  if (typeof host.source !== 'string' || !/^https:\/\//u.test(host.source)) {
    fail('INPUTS_INVALID', 'host.source must be the https location the host archive was obtained from');
  }
  if (parsed.platforms === null || typeof parsed.platforms !== 'object' || Array.isArray(parsed.platforms)) {
    fail('INPUTS_INVALID', 'inputs.platforms must be an object keyed by platform id');
  }
  const base = dirname(resolve(path));
  const platforms = {};
  for (const [id, entry] of Object.entries(parsed.platforms)) {
    if (!SUPPORTED_PLATFORMS.includes(id)) fail('INPUTS_INVALID', `unknown platform "${id}"`);
    if (entry === null || typeof entry !== 'object') fail('INPUTS_INVALID', `platforms.${id} must be an object`);
    const archive = requireText(entry.archive, `platforms.${id}.archive`);
    if (archive.includes('..') || archive.includes('\\') || archive.startsWith('/')) fail('INPUTS_INVALID', `platforms.${id}.archive must stay inside the inputs directory`);
    if (!HOST_EXTENSIONS.test(archive)) fail('INPUTS_INVALID', `platforms.${id}.archive must be a supported host archive`);
    const archivePath = resolve(base, archive);
    if (!existsSync(archivePath) || !statSync(archivePath).isFile()) fail('INPUTS_INVALID', `platforms.${id}.archive does not exist: ${archivePath}`);
    if (!SIGNATURE_VALUES.has(entry.signature)) fail('INPUTS_INVALID', `platforms.${id}.signature must be one of ${[...SIGNATURE_VALUES].join(', ')}`);
    requireText(entry.license, `platforms.${id}.license`);
    const web = entry.web === true;
    if (entry.web !== undefined && typeof entry.web !== 'boolean') fail('INPUTS_INVALID', `platforms.${id}.web must be a boolean`);
    platforms[id] = {
      archive: archivePath,
      archiveName: basename(archivePath),
      sha256: requireDigest(entry.sha256, `platforms.${id}.sha256`),
      license: entry.license,
      signature: entry.signature,
      web,
    };
  }
  return { host: { version: host.version, license: host.license, source: host.source }, platforms, webPort: parsed.webPort ?? DEFAULT_WEB_PORT };
}

/** Reject an archive whose bytes are not the declared host: the whole input is unusable. */
export function assertInputsMatch(inputs) {
  const problems = [];
  for (const [id, platform] of Object.entries(inputs.platforms)) {
    const actual = sha256(readFileSync(platform.archive));
    if (actual !== platform.sha256) problems.push(`${id}: host archive digest ${actual} does not match declared ${platform.sha256}`);
  }
  return problems;
}

/** Read the redacted metadata added by the private maker. */
export function readPrivateRelease(tarballPath) {
  const bytes = readFileSync(tarballPath);
  const entries = readBundleEntries(bytes, { withContent: true });
  const file = entries.find((entry) => entry.path === PRIVATE_METADATA_FILE);
  if (file === undefined) fail('PRIVATE_INVALID', 'tarball has no heluo-private-release.json; it is not a private release');
  let metadata;
  try {
    metadata = JSON.parse(file.content.toString('utf8'));
  } catch {
    fail('PRIVATE_INVALID', 'heluo-private-release.json is not valid JSON');
  }
  if (metadata?.schema !== PRIVATE_SCHEMA) fail('PRIVATE_INVALID', `private metadata must declare schema ${PRIVATE_SCHEMA}`);
  if (metadata.config?.secretEmbedded !== false) fail('PRIVATE_INVALID', 'private metadata must record secretEmbedded=false for the current tool');
  const root = entries.find((entry) => entry.path === 'package.json');
  if (root === undefined) fail('PRIVATE_INVALID', 'private tarball has no package.json');
  let manifest;
  try {
    manifest = JSON.parse(root.content.toString('utf8'));
  } catch {
    fail('PRIVATE_INVALID', 'private package.json is not valid JSON');
  }
  if (metadata.entry?.version !== manifest.version) fail('PRIVATE_INVALID', 'private metadata version does not match package.json');
  return { metadata, manifest, bytes, sha256: sha256(bytes) };
}

export function selectPlatforms(inputs, requested) {
  const all = Object.keys(inputs.platforms).sort();
  if (requested === undefined || requested.length === 0) {
    const missing = SUPPORTED_PLATFORMS.filter((id) => !all.includes(id));
    if (missing.length > 0) fail('PLATFORMS_INCOMPLETE', `installer inputs are missing required platforms: ${missing.join(', ')}`);
    return [...SUPPORTED_PLATFORMS].sort();
  }
  for (const id of requested) {
    if (!SUPPORTED_PLATFORMS.includes(id)) fail('PLATFORMS_INVALID', `unknown platform "${id}"`);
    if (!all.includes(id)) fail('PLATFORMS_INVALID', `installer inputs have no platform "${id}"`);
  }
  return [...new Set(requested)].sort();
}

function installSteps(platform, web) {
  const common = [
    'verify the host and private digests against install.json before running anything',
    'start the packaged host once to initialize its fresh profile, then quit it completely',
    'install the private plugin with the bundled CLI in offline mode',
  ];
  if (web) {
    return [...common, 'start the host in Web form bound to 127.0.0.1 only; never expose the port', 'open the Web entry with its local token; keep the token out of logs'];
  }
  return [...common, 'relaunch the host and confirm the enterprise account/proxy entry appears', 'sign in with the enterprise identity, then enter the personal gateway key on first use'];
}

function sumsText(files) {
  return `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`;
}

/**
 * Assemble a full-installer directory from trusted inputs.
 *
 * @param {{inputsPath: string, privatePath: string, expectedPrivateSha256: string,
 *   output: string, repoRoot?: string, platforms?: string[], webPort?: number}} input
 */
export function assembleFullInstaller(input) {
  const inputsPath = resolve(input.inputsPath);
  const inputs = readInstallerInputs(inputsPath);
  const digestProblems = assertInputsMatch(inputs);
  if (digestProblems.length > 0) fail('HOST_DIGEST_MISMATCH', `host archive verification failed:\n- ${digestProblems.join('\n- ')}`);

  const privatePath = resolve(input.privatePath);
  if (!existsSync(privatePath)) fail('PRIVATE_MISSING', `private tarball not found: ${privatePath}`);
  const privateRelease = readPrivateRelease(privatePath);
  if (privateRelease.sha256 !== requireDigest(input.expectedPrivateSha256, 'private tarball digest')) {
    fail('PRIVATE_DIGEST_MISMATCH', `private tarball digest ${privateRelease.sha256} does not match the trusted digest ${input.expectedPrivateSha256}`);
  }
  const privateScan = scanReleaseFiles(
    readBundleEntries(privateRelease.bytes, { withContent: true }).map((entry) => ({ path: entry.path, body: entry.content })),
    { publicOnly: false },
  );
  if (privateScan.length > 0) fail('PRIVATE_UNSAFE', `private tarball failed the sensitive scan:\n- ${privateScan.join('\n- ')}`);

  const output = resolve(input.output);
  if (input.repoRoot !== undefined) {
    const repo = resolve(input.repoRoot);
    if (output === repo || output.startsWith(`${repo}/`)) fail('OUTPUT_INSIDE_REPO', 'installer output must be outside the source checkout');
  }
  if (existsSync(output) && readdirSync(output).length > 0) fail('OUTPUT_EXISTS', `installer output directory is not empty: ${output}`);

  const platformIds = selectPlatforms(inputs, input.platforms);
  const webPort = input.webPort ?? inputs.webPort;
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) fail('INPUTS_INVALID', 'webPort must be a port number');

  const privateName = basename(privatePath);
  const artifacts = [];
  const staging = join(dirname(output), `.heluo-installer-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const id of platformIds) {
      const platform = inputs.platforms[id];
      const web = platform.web || PLATFORM_DEFAULT_FORM[id] === 'web';
      if (web && platform.web !== true) fail('PLATFORM_FORM_INVALID', `${id} is a Web target but inputs.platforms.${id}.web is not true`);
      if (!web && platform.web === true) fail('PLATFORM_FORM_INVALID', `${id} declares web=true but is a desktop target`);
      const directory = join(staging, id);
      mkdirSync(join(directory, 'host'), { recursive: true });
      mkdirSync(join(directory, 'private'), { recursive: true });
      const hostTarget = join(directory, 'host', platform.archiveName);
      copyFileSync(platform.archive, hostTarget);
      const privateTarget = join(directory, 'private', privateName);
      writeFileSync(privateTarget, privateRelease.bytes, { mode: 0o600 });

      const install = {
        schema: INSTALL_SCHEMA,
        platform: id,
        web,
        listen: web ? `127.0.0.1:${webPort}` : null,
        host: {
          archive: `host/${platform.archiveName}`,
          sha256: platform.sha256,
          version: inputs.host.version,
          license: platform.license,
          signature: platform.signature,
          signatureStatus: 'declared',
        },
        private: {
          archive: `private/${privateName}`,
          sha256: privateRelease.sha256,
          version: privateRelease.manifest.version,
          baseVersion: privateRelease.metadata.base?.version,
          baseSha256: privateRelease.metadata.base?.tarballSha256,
        },
        steps: installSteps(platform, web),
      };
      const installText = stableJson(install);
      writeFileSync(join(directory, 'install.json'), installText);
      const sums = sumsText([
        { name: 'install.json', sha256: sha256(Buffer.from(installText, 'utf8')) },
        { name: `host/${platform.archiveName}`, sha256: platform.sha256 },
        { name: `private/${privateName}`, sha256: privateRelease.sha256 },
      ]);
      writeFileSync(join(directory, 'SHA256SUMS'), sums);
      artifacts.push({
        id,
        web,
        listen: install.listen,
        signature: platform.signature,
        host: { archive: `host/${platform.archiveName}`, sha256: platform.sha256, version: inputs.host.version },
        private: { archive: `private/${privateName}`, sha256: privateRelease.sha256, version: privateRelease.manifest.version },
        files: [
          { path: 'install.json', sha256: sha256(Buffer.from(installText, 'utf8')), bytes: Buffer.byteLength(installText) },
          { path: `host/${platform.archiveName}`, sha256: platform.sha256, bytes: statSync(hostTarget).size },
          { path: `private/${privateName}`, sha256: privateRelease.sha256, bytes: privateRelease.bytes.length },
        ],
      });
    }

    const readme = [
      '# 企业完整安装包',
      '',
      `宿主版本：${inputs.host.version}`,
      `宿主来源：${inputs.host.source}`,
      `私版插件版本：${privateRelease.manifest.version}`,
      '',
      '每个平台目录包含官方宿主归档、已核验的私版插件、安装说明数据（install.json）与摘要（SHA256SUMS）。',
      '安装前先核对摘要；本包不包含个人网关 Key，首次登录后由员工自行录入。',
      '签名/公证状态按 install.json 的 signature 字段记录，仅代表发布者的声明，未在此步骤验证。',
      '',
    ].join('\n');
    writeFileSync(join(staging, 'README.md'), readme);
    const manifest = {
      schema: INSTALLER_SCHEMA,
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      host: { version: inputs.host.version, license: inputs.host.license, source: inputs.host.source },
      private: {
        name: privateName,
        sha256: privateRelease.sha256,
        version: privateRelease.manifest.version,
        base: privateRelease.metadata.base,
        configKeys: privateRelease.metadata.config?.keys ?? [],
      },
      platforms: artifacts,
      secretsIncluded: false,
    };
    const manifestText = stableJson(manifest);
    writeFileSync(join(staging, 'installer-manifest.json'), manifestText);
    const topFiles = [{ name: 'README.md', sha256: sha256(Buffer.from(readme, 'utf8')) }, { name: 'installer-manifest.json', sha256: sha256(Buffer.from(manifestText, 'utf8')) }];
    for (const artifact of artifacts) {
      for (const file of artifact.files) topFiles.push({ name: `${artifact.id}/${file.path}`, sha256: file.sha256 });
    }
    writeFileSync(join(staging, 'SHA256SUMS'), sumsText(topFiles));
    if (existsSync(output)) rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
    return { output, manifest: join(output, 'installer-manifest.json'), platforms: artifacts.map((artifact) => artifact.id), privateSha256: privateRelease.sha256, privateVersion: privateRelease.manifest.version, secretsIncluded: false };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Recompute every line of a SHA256SUMS file; a missing or escaped path is a problem. */
function verifySumsFile(path, prefix) {
  if (!existsSync(path)) return [`${prefix}SHA256SUMS is missing`];
  const problems = [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
  if (lines.length === 0) problems.push(`${prefix}SHA256SUMS is empty`);
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^\\]+)$/u.exec(line);
    if (match === null) {
      problems.push(`${prefix}SHA256SUMS has a malformed line`);
      continue;
    }
    const [, digest, name] = match;
    if (name.includes('..') || name.startsWith('/')) {
      problems.push(`${prefix}SHA256SUMS lists an unsafe path`);
      continue;
    }
    const target = join(path, '..', name);
    if (!existsSync(target)) {
      problems.push(`${prefix}${name} listed in SHA256SUMS is missing`);
      continue;
    }
    if (sha256(readFileSync(target)) !== digest) problems.push(`${prefix}${name} digest mismatch against SHA256SUMS`);
  }
  return problems;
}

/** Verify a directory produced above. Everything is recomputed from bytes. */
export function verifyFullInstaller(directory) {
  const root = resolve(directory);
  const problems = [];
  const manifestPath = join(root, 'installer-manifest.json');
  if (!existsSync(manifestPath)) fail('INSTALLER_MISSING', `no installer-manifest.json in ${root}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('INSTALLER_INVALID', 'installer-manifest.json is not valid JSON');
  }
  if (manifest?.schema !== INSTALLER_SCHEMA) fail('INSTALLER_INVALID', `manifest must declare schema ${INSTALLER_SCHEMA}`);
  if (manifest.secretsIncluded !== false) problems.push('manifest must record secretsIncluded=false');
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0) fail('INSTALLER_INVALID', 'manifest has no platforms');
  for (const artifact of manifest.platforms) {
    const directoryPath = join(root, artifact.id);
    const installPath = join(directoryPath, 'install.json');
    if (!existsSync(installPath)) {
      problems.push(`${artifact.id}: install.json is missing`);
      continue;
    }
    let install;
    try {
      install = JSON.parse(readFileSync(installPath, 'utf8'));
    } catch {
      problems.push(`${artifact.id}: install.json is not valid JSON`);
      continue;
    }
    if (install.schema !== INSTALL_SCHEMA) problems.push(`${artifact.id}: install.json schema mismatch`);
    if (install.platform !== artifact.id) problems.push(`${artifact.id}: install.json platform mismatch`);
    if (install.web !== artifact.web) problems.push(`${artifact.id}: install.json web flag mismatch`);
    if (install.web && install.listen !== `127.0.0.1:${String(install.listen).split(':').pop()}`) problems.push(`${artifact.id}: Web form must listen on 127.0.0.1`);
    if (!install.web && install.listen !== null) problems.push(`${artifact.id}: desktop form must not declare a listen address`);
    const files = new Map();
    for (const file of artifact.files ?? []) files.set(file.path, file);
    const declared = [
      { path: 'install.json', sha256: sha256(readFileSync(installPath)), required: true },
      { path: install.host?.archive, sha256: install.host?.sha256, required: true },
      { path: install.private?.archive, sha256: install.private?.sha256, required: true },
    ];
    for (const item of declared) {
      if (typeof item.path !== 'string') {
        problems.push(`${artifact.id}: install.json has no ${item.path === install.host?.archive ? 'host' : 'private'} archive`);
        continue;
      }
      const target = join(directoryPath, item.path);
      if (!existsSync(target)) {
        problems.push(`${artifact.id}: ${item.path} is missing`);
        continue;
      }
      const actual = sha256(readFileSync(target));
      if (actual !== item.sha256) problems.push(`${artifact.id}: ${item.path} digest mismatch`);
      const listed = files.get(item.path);
      if (listed === undefined) problems.push(`${artifact.id}: ${item.path} is not listed in the manifest`);
      else if (listed.sha256 !== actual) problems.push(`${artifact.id}: ${item.path} manifest digest mismatch`);
    }
    problems.push(...verifySumsFile(join(directoryPath, 'SHA256SUMS'), `${artifact.id}: `));
  }
  const rootSumsPath = join(root, 'SHA256SUMS');
  if (!existsSync(rootSumsPath)) problems.push('root SHA256SUMS is missing');
  else problems.push(...verifySumsFile(rootSumsPath, ''));
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      platforms: manifest.platforms.map((artifact) => ({ id: artifact.id, web: artifact.web, signature: artifact.signature })),
      hostVersion: manifest.host?.version,
      privateVersion: manifest.private?.version,
      secretsIncluded: manifest.secretsIncluded === false,
    },
  };
}
