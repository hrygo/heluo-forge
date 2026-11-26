/** Build the standalone internal package with its Nacos connection preset. */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle, writeBundleArtifacts } from '../../../scripts/build-enterprise-bundle.mjs';
import { readBundleEntries } from '../../../scripts/lib/bundle-archive.mjs';
import { writeBundleTarball } from '../../../scripts/lib/bundle-write.mjs';
import { NACOS_ENV_MAP, parseNacosConfig, assertNacosReleaseConfig, checkNacosRelease } from '../../../scripts/lib/nacos-release.mjs';
import { injectPatchConfig, parseEnvConfig, skillsPatchEntry } from '../../../scripts/lib/private-bundle.mjs';
import { assertOutsideDirectory, scanReleaseFiles, sha256, stableJson } from '../../../scripts/lib/release-support.mjs';
import { verifyBundle } from '../../../scripts/verify-enterprise-bundle.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = '@heluo/forge-skills-manager';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Values are parsed as data; IAM and unrelated deployment keys are rejected. */
export function parsePackageConfig(text) {
  const entries = parseEnvConfig(text);
  for (const { key } of entries) {
    if (!Object.hasOwn(NACOS_ENV_MAP, key)) fail('CONFIG_UNKNOWN_KEY', `standalone package does not accept ${key}`);
  }
  const problems = [];
  const nacos = parseNacosConfig(new Map(entries.map(({ key, value }) => [key, value])), problems);
  assertNacosReleaseConfig({ nacos }, fail);
  if (problems.length) fail('CONFIG_INVALID', problems.join('; '));
  return { nacos };
}

/** NTFS permissions are checked directly rather than emulating POSIX mode bits. */
export function readPackageConfig(path) {
  const target = resolve(path);
  if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) fail('CONFIG_INVALID', 'configuration must be a regular file');
  const rel = relative(repo, target);
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) {
    const options = { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const tracked = execFileSync('git', ['ls-files', '--', rel], options).trim();
    if (tracked) fail('CONFIG_TRACKED', 'configuration must not be tracked');
    try { execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', rel], options); }
    catch (error) {
      if (error.status === 1) fail('CONFIG_NOT_IGNORED', 'configuration inside the repository must be Git ignored');
      throw error;
    }
  }
  if (process.platform === 'win32') {
    const script = String.raw`
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:FORGE_SKILLS_CONFIG_PATH
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed=@($current,'S-1-5-18','S-1-5-32-544')
if (-not $acl.AreAccessRulesProtected) { exit 2 }
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if ($rules.Count -eq 0) { exit 2 }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin $allowed) { exit 2 }
}
if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $current })) { exit 2 }
`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), FORGE_SKILLS_CONFIG_PATH: target }, windowsHide: true, stdio: 'pipe', timeout: 15000,
      });
    } catch (error) {
      if (error.status === 2) fail('CONFIG_PERMISSIONS', 'configuration ACL must be restricted to the current user, SYSTEM and Administrators, with inheritance disabled');
      throw error;
    }
  } else if ((lstatSync(target).mode & 0o077) !== 0) {
    fail('CONFIG_PERMISSIONS', 'configuration permissions must be 0600');
  }
  return readFileSync(target, 'utf8');
}

export function packageSkillsManager({ configText, output, version, dryRun = false, root = repo } = {}) {
  const config = parsePackageConfig(configText);
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) fail('VERSION_INVALID', 'provide an explicit private semver version');
  const destination = resolve(output);
  assertOutsideDirectory(destination, repo);
  assertOutsideDirectory(destination, root);
  if (existsSync(destination)) fail('OUTPUT_EXISTS', 'output must be a new directory');
  const work = mkdtempSync(join(tmpdir(), 'forge-skills-package-'));
  let staging;
  let outputLock;
  try {
    const neutral = buildBundle({ root, entry: ENTRY, destination: join(work, 'neutral') });
    if (version === neutral.manifest.version) fail('VERSION_UNCHANGED', 'private version must differ from the neutral version');
    const entries = readBundleEntries(neutral.tarball, { withContent: true });
    const findings = scanReleaseFiles(entries.map(e => ({ path: e.path, body: e.content })), { publicOnly: true });
    if (findings.length) fail('PUBLIC_UNSAFE', findings.join('\n'));
    const patch = skillsPatchEntry(entries);
    const gate = checkNacosRelease(entries, config, { installed: patch !== undefined, runtimePath: 'lib/nacos.js', toolRoot: root, fail });
    if (!patch) fail('PUBLIC_TARBALL_INVALID', 'Skill Manager has no effective insert row');
    const { username, password, ...connection } = config.nacos;
    const credentialsPath = 'private/nacos-credentials.json';
    const credentials = stableJson({ username, password });
    if (Buffer.byteLength(credentials, 'utf8') > 16 << 10) fail('CONFIG_INVALID', 'bundled credentials exceed the 16 KiB limit');
    if (entries.some(e => e.path === credentialsPath)) fail('PUBLIC_UNSAFE', 'neutral package must not contain bundled credentials');
    const rewritten = injectPatchConfig(patch.content.toString('utf8'), 'heluo-skills-manager', { nacos: { ...connection, credentialsRef: 'bundled' } });
    const manifest = { ...neutral.manifest, version, files: [...neutral.manifest.files, credentialsPath] };
    const metadata = {
      schema: 'heluo-skills-manager-package/1', entry: { name: ENTRY, version },
      base: { version: neutral.manifest.version, sha256: sha256(readFileSync(neutral.tarball)) },
      config: { keys: Object.keys(config.nacos).map(k => `nacos.${k}`).sort(), credentialsStorage: 'bundled-file', embeddedSecrets: gate.embeddedSecrets, secretEmbedded: true, clientSecretEmbedded: false },
    };
    const files = entries.map(e => ({ path: e.path, mode: Number.parseInt(e.mode, 8), body:
      e.path === 'package.json' ? stableJson(manifest) : e.path === patch.path ? rewritten : e.content }));
    files.push({ path: 'private-release.json', mode: 0o644, body: stableJson(metadata) });
    files.push({ path: credentialsPath, mode: 0o600, body: credentials });
    const sensitive = scanReleaseFiles(files, { publicOnly: false });
    if (sensitive.length) fail('ARTIFACT_SENSITIVE', sensitive.join('\n'));
    const bytes = writeBundleTarball(files);
    const name = `heluo-forge-skills-manager-${version}.tgz`;
    const tarball = join(work, name);
    writeFileSync(tarball, bytes);
    const verdict = verifyBundle(tarball);
    if (!verdict.ok) fail('ARTIFACT_VERIFY_FAILED', verdict.errors.join('\n'));
    const summary = { ...metadata, sha256: sha256(bytes), files: files.length, verified: true, written: !dryRun };
    if (!dryRun) {
      mkdirSync(dirname(destination), { recursive: true });
      const lockPath = `${destination}.lock`;
      closeSync(openSync(lockPath, 'wx', 0o600));
      outputLock = lockPath;
      if (existsSync(destination)) fail('OUTPUT_EXISTS', 'output must be a new directory');
      staging = mkdtempSync(join(dirname(destination), '.forge-skills-package-'));
      const stagedTarball = join(staging, name);
      writeFileSync(stagedTarball, bytes);
      const sidecars = writeBundleArtifacts({ destination: staging, tarballPath: stagedTarball, entry: manifest, members: {}, entries: readBundleEntries(stagedTarball, { withContent: true }) });
      if (!verifyBundle(stagedTarball, { manifestPath: sidecars.manifestPath }).ok) fail('ARTIFACT_VERIFY_FAILED', 'written archive did not pass independent verification');
      writeFileSync(join(staging, 'packaging-receipt.json'), stableJson(summary));
      if (existsSync(destination)) fail('OUTPUT_EXISTS', 'output appeared while packaging');
      renameSync(staging, destination);
      staging = undefined;
    }
    return { ...summary, ...(dryRun ? {} : { tarball: join(destination, name) }) };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (outputLock) rmSync(outputLock);
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    const key = { '--config': 'configPath', '--output': 'output', '--version': 'version' }[argv[i]];
    if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('BAD_ARGUMENT', 'usage: package.mjs --config <private.env> --version <private-semver> --output <new-directory> [--dry-run]');
    options[key] = argv[++i];
  }
  if (!options.configPath || !options.output || !options.version) fail('BAD_ARGUMENT', '--config, --version and --output are required');
  const configText = readPackageConfig(options.configPath);
  console.log(stableJson(packageSkillsManager({ ...options, configText })).trimEnd());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`${error.code ?? 'PACKAGE_FAILED'}: ${error.code ? error.message : 'package operation failed; no configuration values printed'}`); process.exitCode = 1; }
}
