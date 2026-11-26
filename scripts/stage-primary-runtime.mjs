#!/usr/bin/env node
/**
 * Stage the primary runtime the packaged shell ships (CORP-DSH-PLAN-026 §4.3 P2-4).
 *
 * Upstream ships a relocatable payload of standalone Node.js, pnpm and CPython
 * with the Office authoring libraries, and its `load_workspace_dependencies`
 * tool reads that payload through a `runtime.json`. This script builds the same
 * payload for one target and puts it where the shell hands it to dsh:
 *
 *   <output>/primary-runtime/runtime.json                 what upstream's tool validates
 *   <output>/primary-runtime/dependencies/node/bin/node   the interpreter and its license, nothing else
 *   <output>/primary-runtime/dependencies/pnpm/           the locked npm archive, other targets' native packages removed
 *   <output>/primary-runtime/dependencies/python/         the standalone CPython with the wheels unpacked into it
 *
 * Fail-closed rules:
 *   - every archive is the one upstream's lock names: read from the
 *     digest-addressed cache or downloaded from the locked URL, SHA-256
 *     checked either way, and a cache file is trusted only by its digest;
 *   - the lock inside the ledger must still hash to the upstream file the
 *     ledger names (`--verify-lock` compares it with upstream itself);
 *   - pnpm is the tarball `runtime-lock.json` already locks, so the payload
 *     and `<resources>/pnpm` are the same bytes unpacked the same way;
 *   - the layout helpers are the ones in the staged dsh closure, so the payload
 *     is laid out the way the locked dsh reads it;
 *   - a payload built for the build machine's own platform and architecture
 *     runs before the staging is reported: its Python imports the Office
 *     libraries and writes and reads back a document of each kind, `pip check`
 *     passes, Node reports the locked version and pnpm starts. A payload that
 *     fails is removed again, and one built for another target is reported as
 *     not run.
 *
 * 用法：
 *   node scripts/stage-primary-runtime.mjs --target <mac-arm64|mac-x64|win-x64|linux-x64|linux-arm64> \
 *     --output <resources dir> --pnpm-tgz <path.tgz> --dsh-modules <resources/dsh/node_modules> \
 *     [--version <carrier version>] [--cache <dir>] [--lock <ledger>] [--runtime-lock <runtime-lock.json>] \
 *     [--record <path>] [--json]
 *   node scripts/stage-primary-runtime.mjs --verify-lock [--lock <ledger>] [--json]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readDshVersion } from './lib/dsh-version.mjs';
import {
  UPSTREAM_TAG_PREFIX,
  acceptsNpmPlatform,
  buildManifest,
  formatRecord,
  lockedArchives,
  parseRecord,
  payloadDigest,
  PrimaryRuntimeError,
  readPinnedLock,
  retainRecordRows,
  TARGETS,
  upstreamLockUrl,
  wheelEntryProblem,
} from './lib/primary-runtime.mjs';
import { readZipEntries, ZipError } from './lib/zip-archive.mjs';
import { unpackPnpm } from './stage-desktop-payload.mjs';
import { PRIMARY_RUNTIME_DIR } from '../services/forge-desktop/src/layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK = join('services', 'forge-desktop', 'primary-runtime-lock.json');
const DEFAULT_RUNTIME_LOCK = join('services', 'forge-desktop', 'runtime-lock.json');
const SMOKE_SCRIPT = join(HERE, 'lib', 'primary-runtime-smoke.py');

/** The upstream package whose exported helpers define and copy the payload. */
const HELPER_PACKAGE = 'dsh-tool-workspace-dependencies';
const HELPER_EXPORTS = ['copyPrimaryRuntime', 'parsePrimaryRuntime', 'primaryRuntimePythonAliases', 'workspaceDependencyPaths'];

/** Distributions whose upstream test suites are left out of the payload. */
const PRUNED_DISTRIBUTIONS = ['numpy', 'pandas'];

const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_BACKOFF_MS = 2_000;
const SMOKE_TIMEOUT_MS = 5 * 60_000;
const TAR_LISTING_BYTES = 64 * 1024 * 1024;
const ERROR_TAIL_BYTES = 2000;

/** Knobs that would change how the interpreters under test start. */
const NODE_KNOBS = new Set(['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']);

export class RuntimeStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeStageError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new RuntimeStageError(code, message);
};

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const sleep = (ms) => new Promise((resolveSleep) => {
  setTimeout(resolveSleep, ms);
});
const describe = (error) => String(error?.cause?.code ?? error?.code ?? error?.message ?? error ?? 'UNKNOWN');
const tail = (text) => String(text ?? '').slice(-ERROR_TAIL_BYTES).trim();

export function parseArguments(argv) {
  const options = {
    mode: 'stage',
    target: undefined,
    output: undefined,
    pnpmTgz: undefined,
    dshModules: undefined,
    cache: undefined,
    version: undefined,
    lock: undefined,
    runtimeLock: undefined,
    record: undefined,
    json: false,
  };
  const valued = new Map([
    ['--target', 'target'],
    ['--output', 'output'],
    ['--pnpm-tgz', 'pnpmTgz'],
    ['--dsh-modules', 'dshModules'],
    ['--cache', 'cache'],
    ['--version', 'version'],
    ['--lock', 'lock'],
    ['--runtime-lock', 'runtimeLock'],
    ['--record', 'record'],
  ]);
  const staging = new Set(['--target', '--output', '--pnpm-tgz', '--dsh-modules', '--cache', '--version', '--runtime-lock', '--record']);
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
    if (argument === '--verify-lock') {
      options.mode = 'verify-lock';
      continue;
    }
    fail('BAD_ARGUMENT', `unknown argument ${argument}`);
  }
  if (options.mode === 'verify-lock') {
    for (const flag of staging) {
      if (options[valued.get(flag)] !== undefined) fail('BAD_ARGUMENT', `${flag} stages a payload and cannot accompany --verify-lock`);
    }
    return options;
  }
  for (const flag of ['--target', '--output', '--pnpm-tgz', '--dsh-modules']) {
    const value = options[valued.get(flag)];
    if (typeof value !== 'string' || value.trim() === '') fail('BAD_ARGUMENT', `${flag} is required`);
  }
  return options;
}

/** The ledger as parsed JSON; a file that is not there or not JSON is reported as such. */
function readLedger(lockPath) {
  let text;
  try {
    text = readFileSync(resolve(lockPath), 'utf8');
  } catch (error) {
    return fail('LOCK_MISSING', `the primary runtime ledger was not read from ${lockPath}: ${error?.message ?? 'UNKNOWN'}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail('LOCK_INVALID', `the primary runtime ledger ${lockPath} is not JSON`);
  }
}

/**
 * Compare the pinned lock with the file upstream publishes for the dsh version
 * this repository is on. Equal bytes are what let the payload be upstream's;
 * anything else means the ledger was not refreshed with the baseline, and a
 * release build stops here.
 *
 * @param {{lockPath: string, dshVersion: string, fetchImpl?: Function}} input
 *   `fetchImpl` defaults to the global fetch; the tests inject a stand-in.
 */
export async function verifyPinnedLock({ lockPath, dshVersion, fetchImpl = fetch }) {
  const ledger = readLedger(lockPath);
  readPinnedLock(ledger);
  if (typeof dshVersion !== 'string' || dshVersion === '') fail('BAD_ARGUMENT', 'the dsh version is required to locate the upstream lock');
  const url = upstreamLockUrl(ledger, dshVersion);
  let bytes;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return fail('LOCK_SOURCE_UNREACHABLE', `the upstream lock was not fetched from ${url}: ${describe(error)}`);
  }
  const sha256 = sha256Hex(bytes);
  if (sha256 !== ledger.upstream.sha256) {
    fail(
      'LOCK_DRIFT',
      `upstream's ${ledger.upstream.path} at ${UPSTREAM_TAG_PREFIX}${dshVersion} is not the lock this repository pins; refresh ${basename(lockPath)} from that tag`,
    );
  }
  return { schema: 'heluo-primary-runtime-lock-check/1', dshVersion, path: ledger.upstream.path, sha256 };
}

/**
 * The locked archive, from the cache when its bytes verify and otherwise
 * downloaded from the URL upstream's lock names. A transport failure is retried
 * a bounded number of times; bytes that do not match the lock are not, because
 * more of the same will not help.
 *
 * @param {{name: string, url: string, sha256: string}} archive the locked artifact
 * @param {string} cache the digest-addressed cache directory
 * @param {Function} fetchImpl `fetch`-compatible
 * @param {Function} wait between attempts; the tests inject a no-op
 */
async function fetchLockedArchive(archive, cache, fetchImpl, wait) {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, archive.sha256);
  if (existsSync(file)) {
    const cached = readFileSync(file);
    // A cache file is whatever its name says, or it is nothing: it is not repaired, only replaced.
    if (sha256Hex(cached) === archive.sha256) return { ...archive, file, bytes: cached };
    rmSync(file, { force: true });
  }
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(archive.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256Hex(bytes) !== archive.sha256) {
        fail('ARCHIVE_DIGEST_MISMATCH', `${archive.name} is not the bytes upstream's lock names (${archive.url})`);
      }
      writeFileSync(`${file}.partial`, bytes);
      renameSync(`${file}.partial`, file);
      return { ...archive, file, bytes };
    } catch (error) {
      if (error instanceof RuntimeStageError) throw error;
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) await wait(DOWNLOAD_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  return fail('ARCHIVE_DOWNLOAD_FAILED', `${archive.name} was not downloaded from ${archive.url}: ${describe(lastError)}`);
}

/** The pnpm tarball the build was handed, checked against the ledger row of `<resources>/pnpm`. */
function verifiedPnpm(pnpmTgz, entry) {
  if (typeof pnpmTgz !== 'string' || pnpmTgz.trim() === '') fail('PNPM_TGZ_MISSING', 'the pnpm tarball was not handed over (--pnpm-tgz)');
  const path = resolve(pnpmTgz);
  if (!existsSync(path)) fail('PNPM_TGZ_MISSING', `pnpm tarball not found: ${path}`);
  if (typeof entry?.version !== 'string' || !isDigest(entry?.sha256) || !Number.isSafeInteger(entry?.bytes)) {
    fail('LOCK_INVALID', 'runtime-lock.json has no pnpm version, bytes and sha256');
  }
  const bytes = readFileSync(path);
  if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
    fail('STAGE_DIGEST_MISMATCH', 'the pnpm tarball is not the artifact runtime-lock.json locks');
  }
  return { path, bytes, version: entry.version };
}

/** The members a tarball carries, as `tar` lists them. */
function tarMembers(file, name) {
  try {
    const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: TAR_LISTING_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
    return listing.split('\n').filter((member) => member !== '');
  } catch (error) {
    return fail('ARCHIVE_INVALID', `${name} is not a tarball: ${tail(error?.stderr ?? error?.message)}`);
  }
}

/** Whether a member lands below the directory it is extracted into. */
function safeMember(member) {
  if (member === '' || member.startsWith('/') || member.includes('\\') || member.includes('\0')) return false;
  const parts = member.replace(/\/+$/u, '').split('/');
  return parts.every((part, index) => (index === 0 && part === '.' && parts.length > 1) || (part !== '' && part !== '.' && part !== '..'));
}

function tarExtract(file, name, destination, members) {
  try {
    execFileSync('tar', ['-xzf', file, '-C', destination, '-p', ...members], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    fail('ARCHIVE_INVALID', `${name} was not unpacked: ${tail(error?.stderr ?? error?.message)}`);
  }
}

/**
 * The standalone interpreter under `dependencies/node`: upstream's payload
 * carries `bin/node` and the license, never the npm, headers or documentation
 * a Node.js distribution also holds.
 */
function stageNode(archive, dependencies, platform) {
  const root = archive.name.replace(/\.(?:zip|tar\.gz)$/u, '');
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const members = [`${root}/bin/${executable}`, `${root}/LICENSE`];
  const node = join(dependencies, 'node');
  mkdirSync(join(node, 'bin'), { recursive: true });
  // Reserved the way upstream reserves it: the directory the tool reports for bundled Node packages.
  mkdirSync(join(node, 'node_modules'), { recursive: true });
  writeFileSync(join(node, 'node_modules', 'README.txt'), 'Reserved for bundled Node packages. pnpm uses its default installation directories.\n');

  const placed = [join(node, 'bin', executable), join(node, 'LICENSE')];
  if (archive.name.endsWith('.zip')) {
    let entries;
    try {
      entries = readZipEntries(archive.bytes, { withContent: true });
    } catch (error) {
      fail(zipCode(error), `${archive.name}: ${error.message}`);
    }
    members.forEach((member, index) => {
      const entry = entries.find((candidate) => candidate.path === member);
      if (entry === undefined) fail('ARCHIVE_LAYOUT_INVALID', `${archive.name} carries no ${member}`);
      writeFileSync(placed[index], entry.content, { mode: index === 0 ? 0o755 : 0o644 });
    });
    return;
  }
  const listing = tarMembers(archive.file, archive.name);
  if (!listing.every(safeMember)) fail('ARCHIVE_INVALID', `${archive.name} has a member that would not land below its directory`);
  for (const member of members) {
    if (!listing.includes(member)) fail('ARCHIVE_LAYOUT_INVALID', `${archive.name} carries no ${member}`);
  }
  tarExtract(archive.file, archive.name, node, members);
  members.forEach((member, index) => renameSync(join(node, ...member.split('/')), placed[index]));
  rmSync(join(node, root), { recursive: true, force: true });
}

/** The standalone CPython under `dependencies/python`, unpacked whole: its links are part of how it finds itself. */
function stagePython(archive, dependencies) {
  const listing = tarMembers(archive.file, archive.name);
  if (!listing.every(safeMember)) fail('ARCHIVE_INVALID', `${archive.name} has a member that would not land below its directory`);
  if (!listing.every((member) => member.replace(/\/$/u, '') === 'python' || member.startsWith('python/'))) {
    fail('ARCHIVE_LAYOUT_INVALID', `${archive.name} is not rooted at python/`);
  }
  mkdirSync(dependencies, { recursive: true });
  tarExtract(archive.file, archive.name, dependencies, []);
  if (!statSync(join(dependencies, 'python')).isDirectory()) fail('ARCHIVE_LAYOUT_INVALID', `${archive.name} unpacked to no python/ directory`);
}

/** The wheels, unpacked into site-packages the way an installer would lay them out, with no script run. */
function stageWheels(archives, sitePackages) {
  mkdirSync(sitePackages, { recursive: true });
  const seen = new Set();
  for (const archive of archives) {
    let entries;
    try {
      entries = readZipEntries(archive.bytes, { withContent: true });
    } catch (error) {
      fail(zipCode(error), `${archive.name}: ${error.message}`);
    }
    for (const entry of entries) {
      const problem = wheelEntryProblem(entry.path);
      if (problem !== '') fail('ARCHIVE_UNSUPPORTED', `${archive.name}: ${problem}`);
      if (seen.has(entry.path)) {
        if (entry.directory) continue;
        fail('ARCHIVE_LAYOUT_INVALID', `${archive.name} repeats ${entry.path}, which another wheel already placed`);
      }
      seen.add(entry.path);
      const target = join(sitePackages, ...entry.path.split('/'));
      if (entry.directory) mkdirSync(target, { recursive: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        // The mode the wheel records: a native extension keeps the bits its build gave it.
        writeFileSync(target, entry.content, { mode: Number.parseInt(entry.mode, 8) });
      }
    }
  }
  return archives.length;
}

/** Every `tests` directory below one package, removed; the paths are what its RECORD rows start with. */
function removeTestDirectories(root, directory) {
  const removed = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.name === 'tests') {
      rmSync(join(root, path), { recursive: true, force: true });
      removed.push(path);
    } else removed.push(...removeTestDirectories(root, path));
  }
  return removed;
}

/**
 * Leave the upstream test suites of the large numerical libraries out of the
 * payload and keep their RECORD files true, so `pip check` and a reinstall
 * from the record still see a complete distribution.
 */
function prunePythonTests(sitePackages, pythonPackages) {
  const pruned = [];
  for (const name of PRUNED_DISTRIBUTIONS) {
    const version = pythonPackages[name];
    if (typeof version !== 'string') fail('ARCHIVE_LAYOUT_INVALID', `the lock declares no ${name} distribution`);
    const record = join(sitePackages, `${name}-${version}.dist-info`, 'RECORD');
    if (!existsSync(record)) fail('ARCHIVE_LAYOUT_INVALID', `site-packages carries no ${name}-${version} RECORD`);
    let rows;
    try {
      rows = parseRecord(readFileSync(record, 'utf8'));
    } catch (error) {
      fail('ARCHIVE_INVALID', `${name} RECORD: ${error.message}`);
    }
    // Sorted, so the record reads the same whatever order the filesystem lists directories in.
    const removed = removeTestDirectories(sitePackages, name).sort();
    if (removed.length === 0) continue;
    writeFileSync(record, formatRecord(retainRecordRows(rows, removed)));
    pruned.push(...removed);
  }
  return pruned;
}

/** The package directories directly under a `node_modules`, scoped packages one level down; `.bin` holds command shims, not packages. */
function packageDirectories(modules) {
  const directories = (parent) => readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== '.bin').map((entry) => join(parent, entry.name));
  return directories(modules).flatMap((directory) => (basename(directory).startsWith('@') ? directories(directory) : [directory]));
}

/**
 * The pnpm the payload reports, unpacked from the same bytes as
 * `<resources>/pnpm`. The npm archive carries every platform's optional native
 * package; only what this target can load is kept.
 */
function stagePnpm(bytes, dependencies, platform, arch, version) {
  const pnpm = join(dependencies, 'pnpm');
  unpackPnpm(bytes, pnpm);
  const manifest = JSON.parse(readFileSync(join(pnpm, 'package.json'), 'utf8'));
  if (manifest?.name !== 'pnpm' || manifest?.version !== version) {
    fail('STAGE_PNPM_IDENTITY_MISMATCH', `the unpacked archive is ${manifest?.name}@${manifest?.version}, the lock names pnpm@${version}`);
  }
  const modules = join(pnpm, 'dist', 'node_modules');
  const pruned = [];
  if (existsSync(modules)) {
    for (const directory of packageDirectories(modules)) {
      let fields;
      try {
        fields = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      } catch {
        fail('PNPM_MANIFEST_INVALID', `${relative(modules, directory)} carries no readable package.json`);
      }
      const admitted = acceptsNpmPlatform(fields?.os, platform) && acceptsNpmPlatform(fields?.cpu, arch);
      if (admitted) continue;
      rmSync(directory, { recursive: true, force: true });
      pruned.push(relative(modules, directory).split('\\').join('/'));
    }
  }
  return { version: manifest.version, pruned: pruned.sort() };
}

/** Where the zip reader's verdict lands: an archive this payload cannot carry, or one that is broken. */
function zipCode(error) {
  return error instanceof ZipError && error.code === 'ZIP_UNSUPPORTED' ? 'ARCHIVE_UNSUPPORTED' : 'ARCHIVE_INVALID';
}

/**
 * The layout helpers of the staged dsh closure: upstream's own package, read
 * from the exact dsh the app ships. Importing it runs none of its plugin code;
 * what is used are the functions that define and copy the payload.
 *
 * @param {string} dshModules the staged `resources/dsh/node_modules`
 */
export async function loadHelpers(dshModules) {
  if (typeof dshModules !== 'string' || dshModules.trim() === '') {
    fail('RUNTIME_HELPER_MISSING', `the staged dsh closure was not named (--dsh-modules), so ${HELPER_PACKAGE} cannot be read`);
  }
  const entry = join(resolve(dshModules), '@deepseek-ai', HELPER_PACKAGE, 'lib', 'index.js');
  if (!existsSync(entry)) fail('RUNTIME_HELPER_MISSING', `the staged dsh closure carries no ${HELPER_PACKAGE} at ${entry}`);
  const loaded = await import(pathToFileURL(entry).href);
  for (const name of HELPER_EXPORTS) {
    if (typeof loaded[name] !== 'function') fail('RUNTIME_HELPER_MISSING', `${HELPER_PACKAGE} does not export ${name}`);
  }
  return loaded;
}

/** File count and byte count of a tree; a link counts as a file and carries no bytes of its own. */
export function measure(directory) {
  const totals = { fileCount: 0, bytes: 0 };
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) totals.fileCount += 1;
      else if (entry.isDirectory()) walk(path);
      else {
        totals.fileCount += 1;
        totals.bytes += lstatSync(path).size;
      }
    }
  };
  walk(directory);
  return totals;
}

/** An environment for the interpreters under test: no credentials, no Node knobs, and no home to write into. */
function smokeEnvironment(environment, scratch) {
  const env = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || NODE_KNOBS.has(name) || /(KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)) continue;
    env[name] = value;
  }
  env.CI = '1';
  for (const [name, path] of Object.entries({ XDG_CACHE_HOME: 'cache', PNPM_HOME: 'pnpm', TMPDIR: 'tmp' })) {
    mkdirSync(join(scratch, path), { recursive: true });
    env[name] = join(scratch, path);
  }
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  if (process.platform === 'win32') env.USERPROFILE = home;
  else env.HOME = home;
  return env;
}

/**
 * Run a payload built for this machine the way its first caller will, from a
 * directory that holds nothing of it. A payload for another target is not run:
 * its interpreters cannot start here, and the record says so.
 *
 * @param {string} root a copy of the staged payload the checks may write into
 * @param {object} manifest the `runtime.json` it declares
 * @param {object} helpers the layout helpers of the staged dsh closure
 * @param {{environment?: object, scratch: string}} options
 *   `scratch` is the caller's directory for the working files the checks leave behind
 */
export async function smokePayload(root, manifest, helpers, { environment = process.env, scratch }) {
  if (typeof scratch !== 'string' || scratch === '') fail('BAD_ARGUMENT', 'the checks need a scratch directory');
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    return { status: 'skipped', reason: `built for ${manifest.platform}-${manifest.arch}; its interpreters are checked on that target` };
  }
  const paths = helpers.workspaceDependencyPaths(root, manifest);
  const run = (label, command, args) => {
    try {
      return execFileSync(command, args, { cwd: scratch, env: smokeEnvironment(environment, scratch), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SMOKE_TIMEOUT_MS }).trim();
    } catch (error) {
      return fail('SMOKE_FAILED', `${label} did not run: ${tail(error?.stderr ?? error?.message)}`);
    }
  };
  const interpreter = `python${manifest.python.split('.').slice(0, 2).join('.')}`;
  if (manifest.platform !== 'win32') {
    // The aliases are links on purpose: a copy would not find the standard library next to itself.
    // The tool refuses an alias that is not one, so its verdict is the check.
    let aliases;
    try {
      aliases = await helpers.primaryRuntimePythonAliases(root, manifest);
    } catch (error) {
      fail('SMOKE_FAILED', `the staged dsh refuses the payload's Python aliases: ${error?.message ?? 'UNKNOWN'}`);
    }
    for (const name of ['python', 'python3']) {
      if (!aliases.has(`dependencies/python/bin/${name}`)) fail('SMOKE_FAILED', `python/bin/${name} is not a relative alias of ${interpreter}`);
    }
    if (!lstatSync(join(root, 'dependencies', 'python', 'bin', interpreter)).isFile()) fail('SMOKE_FAILED', `python/bin/${interpreter} is not a regular file`);
  }
  run('the bundled Python', paths.python, ['-I', '-B', SMOKE_SCRIPT, JSON.stringify(manifest.pythonPackages), manifest.python]);
  run('pip check', paths.python, ['-I', '-B', '-m', 'pip', 'check']);
  const node = run('the bundled Node.js', paths.node, ['-p', 'process.versions.node']).split('\n').pop();
  if (node !== manifest.node) fail('SMOKE_FAILED', `the bundled Node.js reports ${node}, runtime.json declares ${manifest.node}`);
  const pnpm = run('the bundled pnpm', paths.node, [paths.pnpm, '--version']).split('\n').pop();
  if (pnpm !== manifest.pnpm) fail('SMOKE_FAILED', `the bundled pnpm reports ${pnpm}, runtime.json declares ${manifest.pnpm}`);
  return { status: 'passed', node, pnpm, python: manifest.python };
}

/**
 * Build the payload for one target and put it under `<output>/primary-runtime`.
 *
 * @param {object} input
 *   `helpers`, `fetchImpl`, `wait` and `smoke` are injection points for the
 *   offline tests; `repoRoot` resolves the default ledgers.
 */
export async function stagePrimaryRuntime({
  target,
  output,
  pnpmTgz,
  dshModules,
  cache,
  version = '0.0.0-dev',
  lockPath,
  runtimeLockPath,
  repoRoot,
  helpers,
  fetchImpl = fetch,
  wait = sleep,
  smoke = true,
  environment = process.env,
}) {
  const root = resolve(repoRoot ?? join(HERE, '..'));
  const lock = readPinnedLock(readLedger(lockPath ?? join(root, DEFAULT_LOCK)));
  if (TARGETS[target] === undefined) fail('BAD_TARGET', `unknown target ${String(target)}; expected one of ${Object.keys(TARGETS).join(', ')}`);
  if (typeof version !== 'string' || version === '') fail('BAD_ARGUMENT', 'the carrier version must not be empty');
  const runtimeLock = JSON.parse(readFileSync(resolve(runtimeLockPath ?? join(root, DEFAULT_RUNTIME_LOCK)), 'utf8'));
  const pnpm = verifiedPnpm(pnpmTgz, runtimeLock.pnpm);
  const tool = helpers ?? (await loadHelpers(dshModules));

  const archives = [];
  for (const archive of lockedArchives(lock, target)) archives.push(await fetchLockedArchive(archive, resolve(cache ?? join(tmpdir(), 'heluo-primary-runtime-cache')), fetchImpl, wait));
  const { platform, arch } = TARGETS[target];

  const staging = mkdtempSync(join(tmpdir(), 'heluo-primary-runtime-'));
  const destination = join(resolve(output), PRIMARY_RUNTIME_DIR);
  try {
    const payload = join(staging, 'payload');
    const dependencies = join(payload, 'dependencies');
    stageNode(archives.find((archive) => archive.kind === 'node'), dependencies, platform);
    stagePython(archives.find((archive) => archive.kind === 'python'), dependencies);
    const bundled = stagePnpm(pnpm.bytes, dependencies, platform, arch, pnpm.version);

    const digest = payloadDigest({ target, lock, pnpmVersion: bundled.version, archives });
    const manifest = buildManifest({ lock, target, version, pnpmVersion: bundled.version, digest });
    try {
      tool.parsePrimaryRuntime(manifest);
    } catch (error) {
      fail('MANIFEST_INVALID', `runtime.json is not a manifest the staged dsh accepts: ${error?.message ?? 'UNKNOWN'}`);
    }
    const paths = tool.workspaceDependencyPaths(payload, manifest);
    stageWheels(archives.filter((archive) => archive.kind === 'wheel'), paths.pythonPackages);
    const pruned = prunePythonTests(paths.pythonPackages, lock.pythonPackages);
    writeFileSync(join(payload, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // What the tool resolves must be what was staged: its paths, not this script's, name the entries.
    // Links are followed, as the tool follows them: `bin/python3` is an alias of the versioned interpreter.
    for (const [path, kind] of [[paths.python, 'file'], [paths.node, 'file'], [paths.pnpm, 'file'], [paths.nodePackages, 'directory'], [paths.pythonPackages, 'directory']]) {
      if (path === undefined) continue;
      const entry = statSync(path);
      if (!(kind === 'file' ? entry.isFile() : entry.isDirectory())) fail('STAGE_LAYOUT_INVALID', `expected a ${kind} where the staged dsh looks for it: ${path}`);
    }

    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    await tool.copyPrimaryRuntime(payload, destination, manifest);
    const staged = measure(destination);
    // The checks run against a copy, the way the tool installs the payload before
    // its first call. An interpreter at work writes — bytecode caches, a virtual
    // environment — and none of it may reach the payload that ships, so the copy
    // is what is written to and then discarded.
    let result = { status: 'not-run' };
    if (smoke) {
      const scratch = mkdtempSync(join(tmpdir(), 'heluo-primary-runtime-smoke-'));
      try {
        // Verbatim, or Node would re-aim the interpreter aliases at this copy by absolute path.
        cpSync(destination, join(scratch, PRIMARY_RUNTIME_DIR), { recursive: true, verbatimSymlinks: true });
        result = await smokePayload(join(scratch, PRIMARY_RUNTIME_DIR), manifest, tool, { environment, scratch });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    if (JSON.stringify(measure(destination)) !== JSON.stringify(staged)) {
      fail('SMOKE_FAILED', 'the checks changed the staged payload; it must be the same bytes before and after them');
    }
    return {
      schema: 'heluo-primary-runtime-staging/1',
      target,
      platform,
      arch,
      desktopVersion: version,
      payloadDigest: digest,
      node: { version: lock.nodeVersion, ...summarize(archives.find((archive) => archive.kind === 'node')) },
      python: { version: lock.pythonVersion, release: lock.pythonRelease, ...summarize(archives.find((archive) => archive.kind === 'python')) },
      wheels: archives.filter((archive) => archive.kind === 'wheel').map(summarize),
      pnpm: { version: bundled.version, sha256: sha256Hex(pnpm.bytes), bytes: pnpm.bytes.length, pruned: bundled.pruned },
      prunedPythonTests: pruned,
      payload: { directory: PRIMARY_RUNTIME_DIR, ...staged },
      smoke: result,
    };
  } catch (error) {
    // A payload that was not staged whole, or did not run, is not left where a later step would ship it.
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const summarize = ({ name, sha256, bytes }) => ({ archive: name, sha256, bytes: bytes.length });

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repoRoot = resolve(HERE, '..');
  if (options.mode === 'verify-lock') {
    const record = await verifyPinnedLock({ lockPath: options.lock ?? join(repoRoot, DEFAULT_LOCK), dshVersion: readDshVersion(repoRoot) });
    process.stdout.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `lock: ${record.path} at ${UPSTREAM_TAG_PREFIX}${record.dshVersion} is the pinned copy (${record.sha256})\n`);
    return;
  }
  const record = await stagePrimaryRuntime({ ...options, repoRoot });
  if (options.record !== undefined) {
    mkdirSync(dirname(resolve(options.record)), { recursive: true });
    writeFileSync(resolve(options.record), `${JSON.stringify(record, null, 2)}\n`);
  }
  const smoke = record.smoke.status === 'passed' ? 'checks passed' : `checks ${record.smoke.status}`;
  process.stdout.write(
    options.json
      ? `${JSON.stringify(record, null, 2)}\n`
      : `staged: ${resolve(options.output, PRIMARY_RUNTIME_DIR)} (target ${record.target}, node ${record.node.version}, python ${record.python.version}, pnpm ${record.pnpm.version}, ${record.payload.fileCount} files, ${smoke})\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof RuntimeStageError || error instanceof PrimaryRuntimeError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
