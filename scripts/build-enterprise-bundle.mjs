#!/usr/bin/env node
/** #37 / ADR-12: close workspace dependencies at build time, never at the terminal. */
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReleaseClosure, auditTarball, npmExecutable, parsePackOutput } from './lib/bundle-rules.mjs';

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

/** Build a self-contained npm tarball using only explicitly declared workspace resources. */
export function buildEnterpriseBundle({ root = repo, destination, version } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'forge-bundle-build-'));
  const stage = join(work, 'package');
  const output = destination === undefined ? mkdtempSync(join(tmpdir(), 'forge-bundle-artifact-')) : resolve(destination);
  const members = new Map();
  const sources = new Map();
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
      for (const field of ['peerDependencies', 'optionalDependencies']) {
        if (Object.keys(manifest[field] ?? {}).length > 0) fail(`${name} has unclosed ${field}`);
      }
      for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
        if (manifest.scripts?.[lifecycle] !== undefined) fail(`${name} has install-time script ${lifecycle}`);
      }
      const deps = Object.entries(manifest.dependencies ?? {});
      for (const [dep, spec] of deps) {
        if (!dep.startsWith('@heluo/forge-') || typeof spec !== 'string' || spec !== 'workspace:*') fail(`${name} has unclosed runtime dependency ${dep}`);
        if (!sources.has(dep)) fail(`missing workspace member ${dep}`);
      }
      if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail(`${name} must declare release files`);
      mkdirSync(target, { recursive: true });
      for (const resource of new Set([...manifest.files, 'README.md'])) {
        if (typeof resource !== 'string' || isAbsolute(resource) || resource.split('/').some((part) => ['..', 'node_modules', 'test', 'tests', 'coverage', '.git'].includes(part)) || /[*?\\]/u.test(resource)) fail(`${name} has unsafe release resource ${resource}`);
        copyResource(join(source, resource), join(target, resource));
      }
      const released = { ...manifest };
      // The terminal never runs source scripts or sees workspace references.
      delete released.scripts;
      delete released.devDependencies;
      if (name === '@heluo/forge-enterprise' && version !== undefined) released.version = version;
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
    visit('@heluo/forge-enterprise', stage);
    const manifest = readManifest(stage);
    const closureErrors = auditReleaseClosure(stage);
    if (closureErrors.length > 0) fail(closureErrors.join('; '));
    const packedDir = join(work, 'packed');
    mkdirSync(packedDir);
    const stdout = execFileSync(npmExecutable(), ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', packedDir], { cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildEnterpriseBundle({ destination: process.argv[2] });
    console.log(JSON.stringify({ tarball: result.tarball, version: result.manifest.version, members: result.members, files: result.packed.length }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
