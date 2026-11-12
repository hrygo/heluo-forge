#!/usr/bin/env node
/** #37 / ADR-12: close workspace dependencies at build time, never at the terminal. */
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_PEERS, peerDependencyErrors } from './lib/bundle-rules.mjs';
import { readBundleEntries } from './lib/bundle-archive.mjs';
import { createBundleManifest, serializeBundleManifest, serializeSha256Sums } from './lib/bundle-manifest.mjs';
import { auditReleaseClosure, auditTarball, execNpm, parsePackOutput } from './lib/bundle-rules.mjs';
import { auditPackagedNativeResources, auditStagedNativeResources, describeNativeFindings, NATIVE_CHECKSUMS } from './lib/native-resources.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const fail = (message) => { throw new Error(`bundle build: ${message}`); };

// Deliberately only support literal files/directories. Do not silently copy an
// unbounded glob, a symlink, a cache, or tests into a release artifact.
function copyResource(source, target) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) fail(`symlink is not a release resource: ${basename(source)}`);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      if (['node_modules', 'test', 'tests', 'coverage', '.git'].includes(name) || /\.test\.[cm]?js$/u.test(name)) fail(`non-release resource: ${name}`);
      copyResource(join(source, name), join(target, name));
    }
  } else if (info.isFile()) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  } else fail(`not a regular release file: ${basename(source)}`);
}

/** 默认安装单元：企业组合包。 */
export const DEFAULT_ENTRY = '@heluo/forge-enterprise';

/** 宿主 peer 白名单（再导出，便于用例与文档引用同一份定义）。 */
export { HOST_PEERS };

/**
 * Build a self-contained npm tarball for one workspace entry, using only explicitly
 * declared workspace resources. `entry` is the package that becomes the tarball root:
 * the enterprise umbrella and single-install units (e.g. devops) share this one
 * closure-building path, so neither can ship a `workspace:` reference.
 *
 * `requireNativeResources` is the issue #216 gate: any member that ships a
 * `vendor/CHECKSUMS.json` must have every recorded addon staged and byte-exact
 * before `npm pack` runs. Only the offline structural audit
 * (test fixtures with `requireNativeResources: false`) may skip it, and
 * `verify-enterprise-bundle.mjs` independently rejects such an artifact.
 */
export function buildBundle({ root = repo, entry = DEFAULT_ENTRY, destination, version, requireNativeResources = true } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'forge-bundle-build-'));
  const stage = join(work, 'package');
  const output = destination === undefined ? mkdtempSync(join(tmpdir(), 'forge-bundle-artifact-')) : resolve(destination);
  const members = new Map();
  const sources = new Map();
  const nativeRecords = [];
  let pendingOutput;
  try {
    for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
      const dir = join(root, 'packages', entry.name);
      if (entry.isDirectory() && existsSync(join(dir, 'package.json'))) sources.set(readManifest(dir).name, dir);
    }
    const visit = (name, target) => {
      const source = sources.get(name);
      if (source === undefined) fail(`missing workspace member ${name}`);
      const manifest = readManifest(source);
      if (members.has(name)) return;
      members.set(name, manifest.version);
      // 宿主 peer（浏览器半只 require('react')）允许留在清单里，其余 peer 与
      // optionalDependencies 仍算"没闭合"：终端装出来的东西必须自洽（TECHNICAL §9）。
      const peerErrors = peerDependencyErrors(name, manifest, { prefix: '' });
      if (peerErrors.length > 0) fail(peerErrors.join('; '));
      for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
        if (manifest.scripts?.[lifecycle] !== undefined) fail(`${name} has install-time script ${lifecycle}`);
      }
      const deps = Object.entries(manifest.dependencies ?? {});
      for (const [dep, spec] of deps) {
        if (!dep.startsWith('@heluo/forge-') || typeof spec !== 'string' || spec !== 'workspace:*') fail(`${name} has unclosed runtime dependency ${dep}`);
        if (!sources.has(dep)) fail(`missing workspace member ${dep}`);
      }
      if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail(`${name} must declare release files`);
      if (requireNativeResources) {
        // Before anything is copied: a release that ships a package with declared
        // native resources must carry the record and all of its bytes. Fail
        // closed, and only point at the fetch script when fetching would help.
        const findings = auditStagedNativeResources({ dir: source, label: name, releaseFiles: manifest.files });
        if (findings.length > 0) fail(`${name}: ${describeNativeFindings(findings)}.`);
        const record = join(source, NATIVE_CHECKSUMS);
        if (existsSync(record)) nativeRecords.push({ name, content: readFileSync(record) });
      }
      mkdirSync(target, { recursive: true });
      for (const resource of new Set([...manifest.files, 'README.md'])) {
        if (typeof resource !== 'string' || isAbsolute(resource) || resource.split('/').some((part) => ['..', 'node_modules', 'test', 'tests', 'coverage', '.git'].includes(part)) || /[*?\\]/u.test(resource)) fail(`${name} has unsafe release resource ${resource}`);
        copyResource(join(source, resource), join(target, resource));
      }
      const released = { ...manifest };
      // The terminal never runs source scripts or sees workspace references.
      delete released.scripts;
      delete released.devDependencies;
      if (name === entry && version !== undefined) released.version = version;
      if (deps.length > 0) {
        released.dependencies = Object.fromEntries(deps.map(([dep]) => [dep, readManifest(sources.get(dep)).version]));
        released.bundledDependencies = deps.map(([dep]) => dep);
      } else {
        delete released.dependencies;
        delete released.bundledDependencies;
      }
      writeFileSync(join(target, 'package.json'), `${JSON.stringify(released, null, 2)}\n`);
      for (const [dep] of deps) visit(dep, join(stage, 'node_modules', dep));
    };
    visit(entry, stage);
    const manifest = readManifest(stage);
    const closureErrors = auditReleaseClosure(stage);
    if (closureErrors.length > 0) fail(closureErrors.join('; '));
    const packedDir = join(work, 'packed');
    mkdirSync(packedDir);
    const stdout = execNpm(['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', packedDir], { cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const packed = parsePackOutput(stdout);
    if (packed === null) fail('npm returned no packed file list');
    const errors = auditTarball({ label: manifest.name, manifest, packed });
    for (const name of members.keys()) {
      if (name === manifest.name) continue;
      const prefix = `node_modules/${name}/`;
      const member = readManifest(join(stage, 'node_modules', name));
      // Graph identity/version closure was checked above; audit each member's
      // actual packed resources too, including exports, locale and bin mode.
      errors.push(...auditTarball({ label: name, manifest: { ...member, dependencies: {}, bundledDependencies: [] }, packed: packed.filter((entry) => entry.path.startsWith(prefix)).map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) })) }));
    }
    if (errors.length > 0) fail(errors.join('; '));
    const tarballs = readdirSync(packedDir).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) fail('npm did not create exactly one tarball');
    if (requireNativeResources && nativeRecords.length > 0) {
      // npm may exclude files after preflight. Judge the archive's actual bytes
      // against the staged record before creating anything in the destination.
      const files = new Map(readBundleEntries(join(packedDir, tarballs[0]), { withContent: true }).map((item) => [item.path, item.content]));
      for (const { name, content } of nativeRecords) {
        const vendorPrefix = `${name === entry ? '' : `node_modules/${name}/`}vendor/`;
        const packedRecord = files.get(`${vendorPrefix}CHECKSUMS.json`);
        if (packedRecord === undefined || !packedRecord.equals(content)) fail(`${name}: packed vendor/CHECKSUMS.json is missing or differs from the staged record`);
        const findings = auditPackagedNativeResources({
          label: name,
          content,
          read: (relative) => files.get(`${vendorPrefix}${relative}`),
          list: () => [...files.keys()].filter((path) => path.startsWith(vendorPrefix)).map((path) => path.slice(vendorPrefix.length)),
        });
        if (findings.length > 0) fail(`${name}: packed ${describeNativeFindings(findings)}`);
      }
    }
    mkdirSync(output, { recursive: true });
    const tarball = join(output, tarballs[0]);
    if (existsSync(tarball)) fail(`refusing to replace existing artifact ${basename(tarball)}`);
    pendingOutput = join(output, `.${tarballs[0]}.${basename(work)}.tmp`);
    copyFileSync(join(packedDir, tarballs[0]), pendingOutput, constants.COPYFILE_EXCL);
    renameSync(pendingOutput, tarball);
    pendingOutput = undefined;
    return { tarball, manifest, packed, members: Object.fromEntries([...members].filter(([name]) => name !== manifest.name).sort()), relativeResources: packed.map((entry) => entry.path) };
  } finally {
    // Only remove this invocation's own verified OS scratch / pending output.
    if (pendingOutput !== undefined && dirname(pendingOutput) === output && basename(pendingOutput).endsWith('.tmp')) rmSync(pendingOutput, { force: true });
    if (dirname(work) === tmpdir() && basename(work).startsWith('forge-bundle-build-')) rmSync(work, { recursive: true, force: true });
  }
}

/** 默认安装单元（企业组合包）的构建入口，行为与 `buildBundle({ entry: DEFAULT_ENTRY })` 一致。 */
export function buildEnterpriseBundle(options = {}) {
  return buildBundle({ ...options, entry: DEFAULT_ENTRY });
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Build host identity only: no absolute paths, no hostname, no timestamps. */
function readToolchain() {
  let npm = 'unknown';
  try {
    npm = execNpm(['--version'], { encoding: 'utf8' }).trim();
  } catch {
    npm = 'unknown';
  }
  return { node: process.version, npm };
}

/** Write one sidecar without ever exposing a half-written file at its final name. */
function writeAtomic(target, text, created) {
  if (existsSync(target)) fail(`refusing to replace existing artifact ${basename(target)}`);
  const pending = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  writeFileSync(pending, text, { flag: 'wx' });
  try {
    renameSync(pending, target);
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
  created.push(target);
}

/**
 * Write `bundle-manifest.json` (generated from the tarball's own bytes) and
 * `SHA256SUMS` next to the finished tarball, both atomically. A failure removes
 * whatever this call already created, so the release directory never ends up
 * with a sidecar describing a tarball that was rolled back.
 */
export function writeBundleArtifacts({ destination, tarballPath, entry, members, entries } = {}) {
  const directory = resolve(destination);
  const tarball = resolve(tarballPath);
  const bytes = readFileSync(tarball);
  const manifest = createBundleManifest({
    entry: { name: entry?.name, version: entry?.version },
    // `members` from buildBundle lists dependencies only; the manifest declares
    // every shipped package, the entry umbrella included (6 for the enterprise set).
    members: { ...members, [entry?.name]: entry?.version },
    tarball: { name: basename(tarball), sha256: digest(bytes), bytes: bytes.length },
    entries,
    toolchain: readToolchain(),
  });
  const manifestText = serializeBundleManifest(manifest);
  const sumsText = serializeSha256Sums([
    { sha256: manifest.tarball.sha256, name: manifest.tarball.name },
    { sha256: digest(Buffer.from(manifestText, 'utf8')), name: 'bundle-manifest.json' },
  ]);
  const manifestPath = join(directory, 'bundle-manifest.json');
  const sumsPath = join(directory, 'SHA256SUMS');
  const created = [];
  try {
    writeAtomic(manifestPath, manifestText, created);
    writeAtomic(sumsPath, sumsText, created);
  } catch (error) {
    for (const path of created.splice(0)) rmSync(path, { force: true });
    throw error;
  }
  return { manifestPath, sumsPath };
}

/**
 * CLI arguments: `[--root <dir>] [destination]`.
 *
 * `--root` selects the workspace to build; it exists so a fixture workspace can
 * exercise this exact entry point (sidecars, refusal paths, exit codes) without
 * touching the real tree. It does not disable any rule: the native-resource
 * preflight and every tarball audit still run against whatever root is selected.
 */
function parseArguments(argv) {
  let root;
  let destination;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      root = argv[index + 1];
      index += 1;
      if (root === undefined) throw new Error('--root needs a directory');
      continue;
    }
    if (destination !== undefined) throw new Error(`unexpected argument ${argument}`);
    destination = argument;
  }
  return { root, destination };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let tarball;
  try {
    const { root, destination } = parseArguments(process.argv.slice(2));
    const result = buildEnterpriseBundle({ root, destination });
    tarball = result.tarball;
    const bytes = readFileSync(tarball);
    const entries = readBundleEntries(tarball);
    const sidecar = writeBundleArtifacts({
      destination: dirname(tarball),
      tarballPath: tarball,
      entry: { name: result.manifest.name, version: result.manifest.version },
      members: result.members,
      entries,
    });
    console.log(JSON.stringify({ tarball, version: result.manifest.version, members: result.members, files: result.packed.length, sha256: digest(bytes), manifest: sidecar.manifestPath, sums: sidecar.sumsPath }, null, 2));
  } catch (error) {
    // A sidecar failure means this invocation's tarball must not survive: the
    // artifact is only publishable together with its manifest and sums.
    if (tarball !== undefined) rmSync(tarball, { force: true });
    console.error(error.message);
    process.exitCode = 1;
  }
}
