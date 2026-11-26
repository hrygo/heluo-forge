/**
 * Primary runtime staging tests (CORP-DSH-PLAN-026 §4.3 P2-4).
 *
 * `scripts/stage-primary-runtime.mjs` assembles the payload the packaged shell
 * hands to dsh out of the archives upstream's lock names. These tests build
 * that payload through the real script from stand-in archives, with the
 * network refused, and hold it to the layout the locked dsh reads, to the
 * digest checks and to the fail-closed rules the header of the script states.
 * The locked archives are far too large for a unit test; what stands in for
 * them keeps only the properties the script depends on.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEDGER_SCHEMA, TARGETS, lockedArchives, lockProblems, readPinnedLock } from '../scripts/lib/primary-runtime.mjs';
import { measure, parseArguments, smokePayload, stagePrimaryRuntime, verifyPinnedLock } from '../scripts/stage-primary-runtime.mjs';
import { PRIMARY_RUNTIME_DIR } from '../services/forge-desktop/src/layout.mjs';
import * as helpers from './fixtures/primary-runtime-helpers.mjs';
import { writeZip } from './fixtures/zip-writer.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = join(REPO_ROOT, 'services', 'forge-desktop', 'primary-runtime-lock.json');
const HELPERS_SOURCE = join(REPO_ROOT, 'tests', 'fixtures', 'primary-runtime-helpers.mjs');

// The stand-in interpreters are shell scripts and the aliases are links: both are POSIX.
const POSIX = process.platform !== 'win32';
const HOST = { darwin: process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64', linux: process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64' }[process.platform];
const NODE_ARCHIVE = { 'mac-arm64': 'darwin-arm64.tar.gz', 'mac-x64': 'darwin-x64.tar.gz', 'linux-x64': 'linux-x64.tar.gz', 'linux-arm64': 'linux-arm64.tar.gz' };
const PYTHON_VERSION = '3.12.14';
const PNPM_VERSION = '11.28.5-test';
const PYTHON_PACKAGES = { numpy: '2.3.5', pandas: '3.0.1', lxml: '6.1.3', 'python-docx': '1.2.0' };

const refused = (code) => (error) => typeof error?.code === 'string' && error.code === code;
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-primary-runtime-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Archive a directory tree under one root name; links stay links, as the locked archives carry them. */
function archiveTree(source, root, tgz) {
  const staged = mkdtempSync(join(dirname(tgz), 'reroot-'));
  execFileSync('cp', ['-R', source, join(staged, root)], { stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync('tar', ['-czf', tgz, '-C', staged, root], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  rmSync(staged, { recursive: true, force: true });
  return readFileSync(tgz);
}

/** Put bytes into the digest-addressed cache and describe them the way upstream's lock would. */
function cached(cache, bytes, url) {
  const sha256 = sha256Hex(bytes);
  writeFileSync(join(cache, sha256), bytes);
  return { name: basename(url), url, sha256, bytes };
}

/** A stand-in wheel: its files, and the RECORD an installer would leave beside them. */
function putWheel(cache, name, members, { crlf = false, record } = {}) {
  const files = members.filter((member) => !member.directory).map((member) => member.path);
  const line = crlf ? '\r\n' : '\n';
  const rows = [...files.map((path) => `${path},sha256:0,0`), `${name}.dist-info/RECORD,,`];
  const bytes = writeZip([
    ...members,
    { path: `${name}.dist-info`, directory: true },
    { path: `${name}.dist-info/METADATA`, content: `Metadata-Version: 2.1\nName: ${name}\n` },
    { path: `${name}.dist-info/RECORD`, content: record ?? `${rows.join(line)}${line}` },
  ]);
  return cached(cache, bytes, `https://files.example.invalid/${name}-py3-none-any.whl`);
}

const numpyWheel = (cache, options) => putWheel(cache, 'numpy-2.3.5', [
  { path: 'numpy', directory: true },
  { path: 'numpy/__init__.py', content: 'VERSION = "2.3.5"\n' },
  { path: 'numpy/tests', directory: true },
  { path: 'numpy/tests/test_api.py', content: '# upstream test suite\n' },
  { path: 'numpy/_core', directory: true },
  { path: 'numpy/_core/__init__.py', content: '' },
  { path: 'numpy/_core/tests', directory: true },
  { path: 'numpy/_core/tests/test_c.py', content: '# upstream test suite\n' },
  { path: 'numpy/_core/_multiarray_umath.so', content: 'native extension', mode: 0o100755 },
], options);

/** One staging fixture: the archives in a cache, the ledgers, the helper package and the arguments. */
function fixture(t, { smoke = false, python = 'ok', numpy, native, extraWheel } = {}) {
  const root = temp(t);
  const cache = join(root, 'cache');
  mkdirSync(cache, { recursive: true });
  const nodeVersion = process.versions.node;
  const [platform, arch] = [TARGETS[HOST].platform, TARGETS[HOST].arch];

  const nodeSource = join(root, 'node-source');
  mkdirSync(join(nodeSource, 'bin'), { recursive: true });
  mkdirSync(join(nodeSource, 'share'), { recursive: true });
  // The checks need a Node that really starts; every other case is content with a file that does not.
  if (smoke) symlinkSync(process.execPath, join(nodeSource, 'bin', 'node'));
  else writeFileSync(join(nodeSource, 'bin', 'node'), '#!/bin/sh\necho stand-in node\n', { mode: 0o755 });
  writeFileSync(join(nodeSource, 'LICENSE'), 'Node.js is MIT licensed\n');
  writeFileSync(join(nodeSource, 'share', 'node-doc'), 'a distribution also carries npm, headers and docs\n');
  const nodeArchive = `node-v${nodeVersion}-${NODE_ARCHIVE[HOST]}`;
  const node = cached(cache, archiveTree(nodeSource, nodeArchive.replace(/\.tar\.gz$/u, ''), join(root, 'node.tgz')), `https://nodejs.example.invalid/dist/v${nodeVersion}/${nodeArchive}`);

  const pythonSource = join(root, 'python-source');
  mkdirSync(join(pythonSource, 'bin'), { recursive: true });
  mkdirSync(join(pythonSource, 'lib', 'python3.12'), { recursive: true });
  const interpreters = {
    ok: '#!/bin/sh\n# A stand-in interpreter: it answers what the checks ask of it.\nexit 0\n',
    failing: '#!/bin/sh\nexit 1\n',
    // An interpreter at work writes where it runs; the checks must not let that reach the payload.
    dirty: '#!/bin/sh\ntouch "$(dirname "$0")/touched-by-the-checks"\nexit 0\n',
  };
  writeFileSync(join(pythonSource, 'bin', 'python3.12'), interpreters[python], { mode: 0o755 });
  symlinkSync('python3.12', join(pythonSource, 'bin', 'python'));
  symlinkSync('python3.12', join(pythonSource, 'bin', 'python3'));
  writeFileSync(join(pythonSource, 'lib', 'python3.12', 'os.py'), '# stand-in standard library\n');
  const pythonArchive = `cpython-${PYTHON_VERSION}+20260901-standin-install_only_stripped.tar.gz`;
  const pythonArchiveEntry = cached(cache, archiveTree(pythonSource, 'python', join(root, 'python.tgz')), `https://github.example.invalid/astral-sh/python-build-standalone/releases/download/20260901/${pythonArchive}`);

  const wheels = [
    numpyWheel(cache, numpy),
    putWheel(cache, 'pandas-3.0.1', [
      { path: 'pandas/__init__.py', content: '' },
      { path: 'pandas/tests', directory: true },
      { path: 'pandas/tests/util.py', content: '# upstream test suite\n' },
    ]),
    putWheel(cache, 'lxml-6.1.3', [{ path: 'lxml/etree.so', content: 'native extension', mode: 0o100755 }]),
  ];
  const shared = [
    // A wheel may carry console scripts, and its `.data` directory names no scheme of its own.
    putWheel(cache, 'python_docx-1.2.0', [
      { path: 'docx/__init__.py', content: '' },
      { path: 'python_docx-1.2.0.data', directory: true },
      { path: 'python_docx-1.2.0.data/scripts', directory: true },
      { path: 'python_docx-1.2.0.data/scripts/docx', content: '#!/bin/sh\n' },
    ]),
  ];
  if (extraWheel !== undefined) shared.push(extraWheel(cache));

  const target = {
    nodeArchive: NODE_ARCHIVE[HOST],
    nodeSha256: node.sha256,
    pythonTarget: 'standin',
    pythonSha256: pythonArchiveEntry.sha256,
    wheels: wheels.map(({ url, sha256 }) => ({ url, sha256 })),
  };
  const elsewhere = { nodeArchive: 'standin.tar.gz', nodeSha256: 'a'.repeat(64), pythonTarget: 'standin', pythonSha256: 'b'.repeat(64), wheels: [] };
  const lock = {
    nodeVersion,
    pythonVersion: PYTHON_VERSION,
    pythonRelease: '20260901',
    targets: Object.fromEntries(Object.keys(TARGETS).map((name) => [name, name === HOST ? target : elsewhere])),
    wheels: shared.map(({ url, sha256 }) => ({ url, sha256 })),
    pythonPackages: PYTHON_PACKAGES,
  };
  const lockPath = join(root, 'primary-runtime-lock.json');
  writeLedger(lockPath, lock);

  const pnpmSource = join(root, 'pnpm-source');
  mkdirSync(join(pnpmSource, 'bin'), { recursive: true });
  mkdirSync(join(pnpmSource, 'dist', 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(pnpmSource, 'package.json'), `${JSON.stringify({ name: 'pnpm', version: PNPM_VERSION })}\n`);
  writeFileSync(join(pnpmSource, 'bin', 'pnpm.mjs'), `console.log(${JSON.stringify(PNPM_VERSION)});\n`, { mode: 0o755 });
  writeFileSync(join(pnpmSource, 'dist', 'node_modules', '.bin', 'pnpm'), 'command shim, not a package\n');
  const packages = native ?? {
    '@reflink/reflink-here': { os: [platform], cpu: [arch] },
    '@reflink/reflink-there': { os: [platform], cpu: [arch === 'arm64' ? 'x64' : 'arm64'] },
    'reflink-anywhere': {},
    'reflink-not-here': { os: [`!${platform}`] },
  };
  for (const [name, fields] of Object.entries(packages)) {
    mkdirSync(join(pnpmSource, 'dist', 'node_modules', ...name.split('/')), { recursive: true });
    // `manifest: false` leaves a package without the file the pruning reads; a file of its own keeps the directory alive when unpacked.
    if (fields?.manifest === false) {
      writeFileSync(join(pnpmSource, 'dist', 'node_modules', ...name.split('/'), 'index.js'), 'void 0;\n');
      continue;
    }
    writeFileSync(join(pnpmSource, 'dist', 'node_modules', ...name.split('/'), 'package.json'), `${JSON.stringify({ name, ...fields })}\n`);
  }
  const pnpmTgz = join(root, 'pnpm.tgz');
  const pnpmBytes = archiveTree(pnpmSource, 'package', pnpmTgz);
  const runtimeLockPath = join(root, 'runtime-lock.json');
  writeFileSync(runtimeLockPath, `${JSON.stringify({
    schema: 'heluo-desktop-runtime-lock/1',
    dsh: { version: '0.0.0-test', sha256: 'c'.repeat(64), bytes: 1 },
    pnpm: { version: PNPM_VERSION, sha256: sha256Hex(pnpmBytes), bytes: pnpmBytes.length },
  }, null, 2)}\n`);

  const dshModules = join(root, 'dsh', 'node_modules');
  const helperEntry = join(dshModules, '@deepseek-ai', 'dsh-tool-workspace-dependencies', 'lib');
  mkdirSync(helperEntry, { recursive: true });
  cpSync(HELPERS_SOURCE, join(helperEntry, 'index.js'));

  const resources = join(root, 'resources');
  return {
    root,
    cache,
    lock,
    lockPath,
    runtimeLockPath,
    pnpmTgz,
    pnpmBytes,
    pythonArchiveEntry,
    resources,
    payload: join(resources, PRIMARY_RUNTIME_DIR),
    sitePackages: join(resources, PRIMARY_RUNTIME_DIR, 'dependencies', 'python', 'lib', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`, 'site-packages'),
    // Arguments for one staging run; the network is refused so that nothing but the cache can feed it.
    args: (overrides = {}) => ({
      target: HOST,
      output: resources,
      pnpmTgz,
      dshModules,
      cache,
      version: 'v1.2.3-test',
      lockPath,
      runtimeLockPath,
      repoRoot: REPO_ROOT,
      fetchImpl: async (url) => {
        throw new Error(`the network is refused in this test (${url})`);
      },
      wait: async () => {},
      smoke: false,
      ...overrides,
    }),
  };
}

function writeLedger(path, lock) {
  const upstream = { repository: 'deepseek-ai/deepseek-harness', path: 'scripts/primary-runtime/lock.json', sha256: sha256Hex(`${JSON.stringify(lock, undefined, 2)}\n`) };
  writeFileSync(path, `${JSON.stringify({ schema: LEDGER_SCHEMA, upstream, lock }, null, 2)}\n`);
}

test('参数：暂存必填四项，未知参数与缺值即拒，--verify-lock 不与暂存参数同用', () => {
  const full = ['--target', 'mac-arm64', '--output', 'out', '--pnpm-tgz', 'pnpm.tgz', '--dsh-modules', 'node_modules'];
  assert.deepEqual(parseArguments(full), {
    mode: 'stage',
    target: 'mac-arm64',
    output: 'out',
    pnpmTgz: 'pnpm.tgz',
    dshModules: 'node_modules',
    cache: undefined,
    version: undefined,
    lock: undefined,
    runtimeLock: undefined,
    record: undefined,
    json: false,
  });
  assert.equal(parseArguments([...full, '--cache', 'cache', '--version', 'v2', '--lock', 'a.json', '--runtime-lock', 'b.json', '--record', 'c.json', '--json']).json, true);
  for (const flag of ['--target', '--output', '--pnpm-tgz', '--dsh-modules']) {
    const index = full.indexOf(flag);
    assert.throws(() => parseArguments([...full.slice(0, index), ...full.slice(index + 2)]), refused('BAD_ARGUMENT'), `${flag} is required`);
    assert.throws(() => parseArguments([...full.slice(0, index), flag]), refused('BAD_ARGUMENT'), `${flag} needs a value`);
    assert.throws(() => parseArguments([...full.slice(0, index), flag, '--json']), refused('BAD_ARGUMENT'), `${flag} does not take another flag as its value`);
  }
  assert.throws(() => parseArguments(['--target', 'mac-arm64', '--no-smoke']), refused('BAD_ARGUMENT'));
  assert.deepEqual(parseArguments(['--verify-lock', '--json']), { mode: 'verify-lock', json: true, target: undefined, output: undefined, pnpmTgz: undefined, dshModules: undefined, cache: undefined, version: undefined, lock: undefined, runtimeLock: undefined, record: undefined });
  assert.throws(() => parseArguments(['--verify-lock', '--target', 'mac-arm64']), refused('BAD_ARGUMENT'));
  assert.throws(() => parseArguments(['--verify-lock', '--record', 'r.json']), refused('BAD_ARGUMENT'));
});

test('measure：文件与链接计入个数，链接不计字节，目录不计个数', (t) => {
  const root = temp(t);
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'a'), 'abc');
  writeFileSync(join(root, 'lib', 'b'), '12345');
  symlinkSync('a', join(root, 'link'));
  assert.deepEqual(measure(root), { fileCount: 3, bytes: 8 });
});

test('仓库台账：内嵌副本与上游逐字节一致，Node 与 .node-version 相同，五个目标与 wheel 齐全（变异证明）', () => {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  const lock = readPinnedLock(ledger);
  assert.equal(ledger.schema, LEDGER_SCHEMA);
  assert.equal(ledger.upstream.sha256, sha256Hex(`${JSON.stringify(lock, undefined, 2)}\n`), 'the embedded lock is exactly the upstream file the ledger names');
  assert.equal(lock.nodeVersion, readFileSync(join(REPO_ROOT, '.node-version'), 'utf8').trim(), 'the payload runs the Node this repository is built with');
  assert.deepEqual(Object.keys(lock.targets), Object.keys(TARGETS));
  for (const artifact of Object.values(lock.targets)) {
    assert.equal(artifact.wheels.length, 4, 'each target carries its own binary wheels');
    assert.match(artifact.nodeSha256, /^[0-9a-f]{64}$/u);
    assert.match(artifact.pythonSha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(lock.wheels.length, 9, 'the pure wheels are shared by every target');
  assert.equal(Object.keys(lock.pythonPackages).length, 13);
  for (const name of ['numpy', 'pandas']) assert.equal(typeof lock.pythonPackages[name], 'string', `${name} is declared, so its test suite can be pruned`);

  // A lock edited by hand cannot pass for upstream's, whichever field is touched.
  const edits = [
    { edit: (copy) => { copy.pythonVersion = '3.13.0'; }, unusable: false },
    { edit: (copy) => { delete copy.targets['linux-arm64']; }, unusable: true },
    { edit: (copy) => { copy.targets['mac-arm64'].nodeSha256 = '0'.repeat(64); }, unusable: false },
    { edit: (copy) => { copy.wheels.pop(); }, unusable: false },
    { edit: (copy) => { copy.targets['win-x64'].wheels = []; }, unusable: false },
    { edit: (copy) => { copy.targets['win-x64'].nodeArchive = ''; }, unusable: true },
  ];
  for (const { edit, unusable } of edits) {
    const tampered = structuredClone(ledger);
    edit(tampered.lock);
    assert.throws(() => readPinnedLock(tampered), refused('LOCK_TAMPERED'));
    // Even with the digest brought in line with the edit, a lock that cannot build every target is refused.
    tampered.upstream.sha256 = sha256Hex(`${JSON.stringify(tampered.lock, undefined, 2)}\n`);
    if (unusable) assert.throws(() => readPinnedLock(tampered), refused('LOCK_INVALID'));
    // A consistent lock is a lock; only the comparison with upstream says whose it is.
    else assert.equal(readPinnedLock(tampered), tampered.lock);
  }
});

test('lockedArchives：下载清单按上游构建器的方式推导', () => {
  const lock = readPinnedLock(JSON.parse(readFileSync(LEDGER_PATH, 'utf8')));
  const archives = lockedArchives(lock, 'mac-arm64');
  assert.equal(archives.length, 15, 'one Node.js archive, one CPython archive, four target wheels, nine shared wheels');
  assert.equal(archives[0].url, `https://nodejs.org/dist/v${lock.nodeVersion}/node-v${lock.nodeVersion}-darwin-arm64.tar.gz`);
  assert.equal(archives[0].sha256, lock.targets['mac-arm64'].nodeSha256);
  assert.equal(archives[1].url, `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/cpython-${lock.pythonVersion}%2B${lock.pythonRelease}-aarch64-apple-darwin-install_only_stripped.tar.gz`);
  assert.equal(archives[1].sha256, lock.targets['mac-arm64'].pythonSha256);
  assert.equal(archives.filter((archive) => archive.kind === 'wheel').length, 13);
  assert.equal(new Set(archives.map((archive) => archive.name)).size, archives.length, 'no two archives share a name');
  assert.throws(() => lockedArchives(lock, 'mac-arm'), refused('BAD_TARGET'));
});

test('--verify-lock：与上游同版本的文件一致则通过，不一致或取不到即停', async () => {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  const upstreamBytes = `${JSON.stringify(ledger.lock, undefined, 2)}\n`;
  const requested = [];
  const serving = (status, body) => async (url) => {
    requested.push(url);
    return { ok: status === 200, status, arrayBuffer: async () => Buffer.from(body) };
  };
  const record = await verifyPinnedLock({ lockPath: LEDGER_PATH, dshVersion: '0.0.0-probe', fetchImpl: serving(200, upstreamBytes) });
  assert.equal(record.sha256, ledger.upstream.sha256);
  assert.deepEqual(requested, ['https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.0.0-probe/scripts/primary-runtime/lock.json'], 'the tag follows the dsh version this repository is on');
  await assert.rejects(verifyPinnedLock({ lockPath: LEDGER_PATH, dshVersion: '0.0.0-probe', fetchImpl: serving(200, '{}\n') }), refused('LOCK_DRIFT'));
  await assert.rejects(verifyPinnedLock({ lockPath: LEDGER_PATH, dshVersion: '0.0.0-probe', fetchImpl: serving(404, '') }), refused('LOCK_SOURCE_UNREACHABLE'));
  await assert.rejects(verifyPinnedLock({ lockPath: LEDGER_PATH, dshVersion: '0.0.0-probe', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), /ECONNRESET/u);
  await assert.rejects(verifyPinnedLock({ lockPath: LEDGER_PATH, dshVersion: '', fetchImpl: serving(200, upstreamBytes) }), refused('BAD_ARGUMENT'));
  await assert.rejects(verifyPinnedLock({ lockPath: join(REPO_ROOT, 'no-such-ledger.json'), dshVersion: '0.0.0-probe', fetchImpl: serving(200, upstreamBytes) }), refused('LOCK_MISSING'));
});

test('载荷布局：runtime.json 与上游工具读取的三个解释器落在暂存目录', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  const record = await stagePrimaryRuntime(f.args());
  const manifest = JSON.parse(readFileSync(join(f.payload, 'runtime.json'), 'utf8'));
  assert.equal(record.schema, 'heluo-primary-runtime-staging/1');
  assert.equal(record.target, HOST);
  assert.equal(record.payload.directory, PRIMARY_RUNTIME_DIR);
  assert.equal(manifest.desktopVersion, 'v1.2.3-test');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.python, PYTHON_VERSION);
  assert.equal(manifest.node, process.versions.node);
  assert.equal(manifest.pnpm, PNPM_VERSION);
  assert.deepEqual(manifest.pythonPackages, PYTHON_PACKAGES);
  assert.equal(manifest.payloadDigest, record.payloadDigest);
  assert.equal(record.node.version, process.versions.node);
  assert.equal(record.python.version, PYTHON_VERSION);
  assert.equal(record.wheels.length, 4);
  assert.equal(record.smoke.status, 'not-run');
  // The paths the tool derives for the locked dsh are where the entries are.
  const paths = helpers.workspaceDependencyPaths(f.payload, manifest);
  assert.equal(existsSync(paths.python), true, 'python');
  assert.equal(existsSync(paths.node), true, 'node');
  assert.equal(existsSync(paths.pnpm), true, 'pnpm');
  assert.equal(existsSync(join(paths.pythonPackages, 'numpy', '__init__.py')), true, 'the wheels are unpacked into site-packages');
  assert.equal(readFileSync(paths.python, 'utf8'), readFileSync(join(f.root, 'python-source', 'bin', 'python3.12'), 'utf8'));
  // The aliases stay relative links: a copy would not find the standard library next to itself.
  for (const name of ['python', 'python3']) {
    assert.equal(lstatSync(join(f.payload, 'dependencies', 'python', 'bin', name)).isSymbolicLink(), true, name);
    assert.equal(readlinkSync(join(f.payload, 'dependencies', 'python', 'bin', name)), 'python3.12');
  }
  assert.equal(lstatSync(join(f.payload, 'dependencies', 'python', 'bin', 'python3.12')).isFile(), true);
});

test('win-x64 载荷布局：从 Windows Node zip 根目录取 node.exe 落到 bin/node.exe，并跳过非 Windows 主机冒烟（回归）', { skip: !POSIX }, async (t) => {
  const buildWinFixture = (nodeEntries) => {
    const f = fixture(t);
    const root = temp(t);
    const cache = join(root, 'win-cache');
    mkdirSync(cache, { recursive: true });
    const nodeVersion = process.versions.node;
    const nodeRoot = `node-v${nodeVersion}-win-x64`;
    const nodeBytes = writeZip(nodeEntries(nodeRoot));
    const nodeEntry = cached(cache, nodeBytes, `https://nodejs.example.invalid/dist/v${nodeVersion}/${nodeRoot}.zip`);

    const pythonSource = join(root, 'win-python');
    mkdirSync(join(pythonSource, 'Lib'), { recursive: true });
    writeFileSync(join(pythonSource, 'python.exe'), 'MZ-standin-python');
    writeFileSync(join(pythonSource, 'Lib', 'os.py'), '# stand-in stdlib\n');
    const pythonArchive = `cpython-${PYTHON_VERSION}+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;
    const pythonEntry = cached(cache, archiveTree(pythonSource, 'python', join(root, 'win-python.tgz')), `https://github.example.invalid/astral-sh/python-build-standalone/releases/download/20260901/${pythonArchive}`);

    const winWheels = [numpyWheel(cache), putWheel(cache, 'pandas-3.0.1', [{ path: 'pandas/__init__.py', content: '' }]), putWheel(cache, 'lxml-6.1.3', [{ path: 'lxml/etree.pyd', content: 'pyd' }])];
    const sharedWheels = [putWheel(cache, 'python_docx-1.2.0', [{ path: 'docx/__init__.py', content: '' }])];
    const lock = {
      nodeVersion,
      pythonVersion: PYTHON_VERSION,
      pythonRelease: '20260901',
      targets: {
        ...f.lock.targets,
        'win-x64': {
          nodeArchive: 'win-x64.zip',
          nodeSha256: nodeEntry.sha256,
          pythonTarget: 'x86_64-pc-windows-msvc',
          pythonSha256: pythonEntry.sha256,
          wheels: winWheels.map(({ url, sha256 }) => ({ url, sha256 })),
        },
      },
      wheels: sharedWheels.map(({ url, sha256 }) => ({ url, sha256 })),
      pythonPackages: PYTHON_PACKAGES,
    };
    const lockPath = join(root, 'win-primary-runtime-lock.json');
    writeLedger(lockPath, lock);
    return { f, cache, lockPath };
  };

  // Official Windows Node.js zips keep `node.exe` at `<root>/node.exe`, never `<root>/bin/node.exe`.
  const valid = buildWinFixture((nodeRoot) => [
    { path: `${nodeRoot}/node.exe`, content: 'MZ-standin-node' },
    { path: `${nodeRoot}/LICENSE`, content: 'Node.js MIT\n' },
    { path: `${nodeRoot}/npm.cmd`, content: '@ECHO OFF\n' },
  ]);
  const record = await stagePrimaryRuntime(valid.f.args({ target: 'win-x64', cache: valid.cache, lockPath: valid.lockPath, smoke: process.platform !== 'win32' }));
  const manifest = JSON.parse(readFileSync(join(valid.f.payload, 'runtime.json'), 'utf8'));
  const paths = helpers.workspaceDependencyPaths(valid.f.payload, manifest);
  assert.equal(record.target, 'win-x64');
  assert.equal(record.smoke.status, 'skipped');
  assert.equal(manifest.platform, 'win32');
  assert.equal(readFileSync(paths.node, 'utf8'), 'MZ-standin-node');
  assert.equal(readFileSync(join(valid.f.payload, 'dependencies', 'node', 'LICENSE'), 'utf8'), 'Node.js MIT\n');
  assert.equal(existsSync(join(valid.f.payload, 'dependencies', 'node', 'npm.cmd')), false);
  assert.equal(readFileSync(paths.python, 'utf8'), 'MZ-standin-python');
  assert.equal(existsSync(join(paths.pythonPackages, 'numpy', '__init__.py')), true);

  // Reverse: a Windows zip missing `<root>/node.exe` (e.g. only under `bin/`) fails closed.
  const wrongLayout = buildWinFixture((nodeRoot) => [
    { path: `${nodeRoot}/bin/node.exe`, content: 'MZ-standin-node' },
    { path: `${nodeRoot}/LICENSE`, content: 'Node.js MIT\n' },
  ]);
  await assert.rejects(
    stagePrimaryRuntime(wrongLayout.f.args({ target: 'win-x64', cache: wrongLayout.cache, lockPath: wrongLayout.lockPath, smoke: false })),
    (error) => refused('ARCHIVE_LAYOUT_INVALID')(error) && error.message.includes('node.exe'),
  );
});

test('只有解释器与许可证进入载荷：Node.js 发行包里的其余成员不随包', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  await stagePrimaryRuntime(f.args());
  const node = join(f.payload, 'dependencies', 'node');
  assert.equal(readdirSync(node).sort().join(','), 'LICENSE,bin,node_modules', 'the interpreter, its license and the reserved packages directory, nothing else');
  assert.equal(readFileSync(join(node, 'LICENSE'), 'utf8'), 'Node.js is MIT licensed\n');
  assert.equal(existsSync(join(node, 'share')), false, 'the documentation of the distribution is left out');
  assert.equal(statSync(join(node, 'bin', 'node')).isFile(), true, 'the interpreter is a file, not a link into the cache');
});

test('载荷摘要只取决于输入：同样的输入两次暂存得到同一棵树，换载体版本只改 runtime.json', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  const first = await stagePrimaryRuntime(f.args());
  const again = await stagePrimaryRuntime(f.args());
  assert.equal(again.payloadDigest, first.payloadDigest);
  assert.deepEqual(again.payload, first.payload, 'staging the same inputs twice leaves the same tree');
  const reversioned = await stagePrimaryRuntime(f.args({ version: 'v9.9.9-other' }));
  assert.equal(reversioned.payloadDigest, first.payloadDigest, 'the digest names the inputs, not the carrier');
  assert.equal(reversioned.payload.fileCount, first.payload.fileCount);
  // The manifest is the one file that names the carrier; a longer version makes it exactly that much longer.
  assert.equal(reversioned.payload.bytes - first.payload.bytes, 'v9.9.9-other'.length - 'v1.2.3-test'.length);
  assert.equal(JSON.parse(readFileSync(join(f.payload, 'runtime.json'), 'utf8')).desktopVersion, 'v9.9.9-other');
});

test('缓存里的归档不符摘要时不被使用，改取锁定的字节后缓存被修正（变异证明）', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  const cachedPath = join(f.cache, f.pythonArchiveEntry.sha256);
  writeFileSync(cachedPath, Buffer.from(f.pythonArchiveEntry.bytes).fill(0, 0, 64));
  const served = [];
  const record = await stagePrimaryRuntime(f.args({
    fetchImpl: async (url) => {
      served.push(url);
      if (url !== lockedArchives(f.lock, HOST).find((archive) => archive.kind === 'python').url) throw new Error(`unexpected request for ${url}`);
      return { ok: true, arrayBuffer: async () => f.pythonArchiveEntry.bytes };
    },
  }));
  assert.deepEqual(served, [lockedArchives(f.lock, HOST).find((archive) => archive.kind === 'python').url], 'only the archive that failed its digest is fetched');
  assert.equal(sha256Hex(readFileSync(cachedPath)), f.pythonArchiveEntry.sha256, 'the cache holds the verified bytes again');
  assert.equal(record.python.sha256, f.pythonArchiveEntry.sha256);
});

test('反向：取到的字节与锁不符即停，缓存与输出里都不留东西', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  const requested = [];
  await assert.rejects(stagePrimaryRuntime(f.args({
    cache: join(f.root, 'fresh-cache'),
    fetchImpl: async (url) => {
      requested.push(url);
      return { ok: true, arrayBuffer: async () => Buffer.from('not the locked archive') };
    },
  })), refused('ARCHIVE_DIGEST_MISMATCH'));
  assert.equal(requested.length, 1, 'a digest mismatch is not retried: more of the same bytes will not help');
  assert.deepEqual(readdirSync(join(f.root, 'fresh-cache')), [], 'nothing unverified is written into the cache');
  assert.equal(existsSync(f.payload), false);
});

test('反向：传输失败重试有界，放弃后不留输出', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  const waits = [];
  const requested = [];
  await assert.rejects(stagePrimaryRuntime(f.args({
    cache: join(f.root, 'fresh-cache'),
    fetchImpl: async (url) => {
      requested.push(url);
      throw new Error('ECONNRESET');
    },
    wait: async (ms) => { waits.push(ms); },
  })), refused('ARCHIVE_DOWNLOAD_FAILED'));
  assert.equal(requested.length, 4, 'four attempts');
  assert.deepEqual(waits, [2000, 4000, 8000], 'a growing pause between attempts, none after the last');
  assert.equal(existsSync(f.payload), false);
});

test('反向：pnpm 归档不是 runtime-lock 锁定的那一个即停（变异证明）', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  // The same file edited after the ledger was written.
  writeFileSync(f.pnpmTgz, Buffer.from(f.pnpmBytes).fill(1, f.pnpmBytes.length - 64));
  await assert.rejects(stagePrimaryRuntime(f.args()), refused('STAGE_DIGEST_MISMATCH'));
  await assert.rejects(stagePrimaryRuntime(f.args({ pnpmTgz: join(f.root, 'missing.tgz') })), refused('PNPM_TGZ_MISSING'));
  await assert.rejects(stagePrimaryRuntime(f.args({ pnpmTgz: undefined })), refused('PNPM_TGZ_MISSING'));
  const ledger = JSON.parse(readFileSync(f.runtimeLockPath, 'utf8'));
  delete ledger.pnpm.sha256;
  writeFileSync(f.runtimeLockPath, JSON.stringify(ledger));
  await assert.rejects(stagePrimaryRuntime(f.args()), refused('LOCK_INVALID'));
  assert.equal(existsSync(f.payload), false);
});

test('pnpm：别的目标的原生包被裁掉，本目标与无约束的保留，.bin 不被当作包', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  const record = await stagePrimaryRuntime(f.args());
  const modules = join(f.payload, 'dependencies', 'pnpm', 'dist', 'node_modules');
  assert.equal(record.pnpm.version, PNPM_VERSION);
  assert.deepEqual(record.pnpm.pruned, ['@reflink/reflink-there', 'reflink-not-here']);
  assert.equal(existsSync(join(modules, '@reflink', 'reflink-here')), true);
  assert.equal(existsSync(join(modules, '@reflink', 'reflink-there')), false);
  assert.equal(existsSync(join(modules, 'reflink-anywhere')), true);
  assert.equal(existsSync(join(modules, 'reflink-not-here')), false);
  assert.equal(existsSync(join(modules, '.bin', 'pnpm')), true, 'the command shims are left alone');
  assert.equal(existsSync(join(f.payload, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')), true);
  assert.equal(statSync(join(f.payload, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')).mode & 0o777, 0o755);
});

test('反向：pnpm 自带包的清单不可读，或平台约束不是字符串数组即停', { skip: !POSIX }, async (t) => {
  const invalid = fixture(t, { native: { 'reflink-bad': { os: 'darwin' } } });
  await assert.rejects(stagePrimaryRuntime(invalid.args()), refused('PNPM_MANIFEST_INVALID'));
  const unreadable = fixture(t, { native: { 'reflink-no-manifest': { manifest: false } } });
  await assert.rejects(stagePrimaryRuntime(unreadable.args()), refused('PNPM_MANIFEST_INVALID'));
  assert.equal(existsSync(invalid.payload), false);
  assert.equal(existsSync(unreadable.payload), false);
});

test('反向：wheel 要求载荷给不了的安装路径即停', { skip: !POSIX }, async (t) => {
  // `purelib` is where an installer would redirect files; nothing here does that.
  const f = fixture(t, {
    extraWheel: (cache) => putWheel(cache, 'six-1.17.0', [
      { path: 'six-1.17.0.data', directory: true },
      { path: 'six-1.17.0.data/purelib/six.py', content: '' },
    ]),
  });
  await assert.rejects(stagePrimaryRuntime(f.args()), (error) => refused('ARCHIVE_UNSUPPORTED')(error) && /six-1\.17\.0\.data\/purelib\/six\.py/u.test(error.message));
  assert.equal(existsSync(f.payload), false);
});

test('numpy 与 pandas 的上游测试目录被裁掉，RECORD 同步且不再带 CRLF；原生扩展保留执行位', { skip: !POSIX }, async (t) => {
  const f = fixture(t, { numpy: { crlf: true } });
  const record = await stagePrimaryRuntime(f.args());
  assert.equal(existsSync(join(f.sitePackages, 'numpy', 'tests')), false);
  assert.equal(existsSync(join(f.sitePackages, 'numpy', '_core', 'tests')), false);
  assert.equal(existsSync(join(f.sitePackages, 'pandas', 'tests')), false);
  assert.equal(existsSync(join(f.sitePackages, 'numpy', '_core', '_multiarray_umath.so')), true, 'the native extension is not a test');
  assert.equal(statSync(join(f.sitePackages, 'numpy', '_core', '_multiarray_umath.so')).mode & 0o777, 0o755, 'the wheel recorded the mode');
  assert.deepEqual(record.prunedPythonTests, ['numpy/_core/tests', 'numpy/tests', 'pandas/tests'], 'every tests directory below both packages, in byte order');
  const rows = readFileSync(join(f.sitePackages, 'numpy-2.3.5.dist-info', 'RECORD'), 'utf8');
  assert.equal(rows.includes('\r'), false);
  assert.equal(rows.includes('/tests/'), false);
  assert.match(rows, /^numpy\/__init__\.py,sha256:0,0$/mu);
  assert.match(rows, /^numpy-2\.3\.5\.dist-info\/RECORD,,$/mu);
  assert.equal(existsSync(join(f.sitePackages, 'python_docx-1.2.0.data', 'scripts', 'docx')), true, 'console scripts a wheel carries are unpacked where it lays them');
});

test('反向：RECORD 不是纯 path,hash,size 行即停，裁剪不建立在误读的记录上', { skip: !POSIX }, async (t) => {
  const f = fixture(t, { numpy: { record: '"numpy/__init__.py",, \nnumpy/tests/test_api.py,,\n' } });
  await assert.rejects(stagePrimaryRuntime(f.args()), refused('ARCHIVE_INVALID'));
  assert.equal(existsSync(f.payload), false);
});

test('反向：暂存的 dsh 闭包里没有布局助手，或它不导出所需函数即停', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  await assert.rejects(stagePrimaryRuntime(f.args({ dshModules: join(f.root, 'nowhere') })), refused('RUNTIME_HELPER_MISSING'));
  const partial = join(f.root, 'partial', 'node_modules', '@deepseek-ai', 'dsh-tool-workspace-dependencies', 'lib');
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, 'index.js'), 'export const workspaceDependencyPaths = () => ({});\n');
  await assert.rejects(stagePrimaryRuntime(f.args({ dshModules: join(f.root, 'partial', 'node_modules') })), refused('RUNTIME_HELPER_MISSING'));
  await assert.rejects(stagePrimaryRuntime(f.args({ dshModules: undefined })), refused('RUNTIME_HELPER_MISSING'));
});

test('反向：台账里的上游锁被改动即停（变异证明）', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  const ledger = JSON.parse(readFileSync(f.lockPath, 'utf8'));
  ledger.lock.targets[HOST].pythonSha256 = 'f'.repeat(64);
  writeFileSync(f.lockPath, JSON.stringify(ledger));
  await assert.rejects(stagePrimaryRuntime(f.args()), refused('LOCK_TAMPERED'));
  assert.equal(existsSync(f.payload), false);
});

test('反向：目标名未知，或载体版本为空即停', { skip: !POSIX }, async (t) => {
  const f = fixture(t);
  await assert.rejects(stagePrimaryRuntime(f.args({ target: 'mac-arm' })), refused('BAD_TARGET'));
  await assert.rejects(stagePrimaryRuntime(f.args({ version: '' })), refused('BAD_ARGUMENT'));
});

test('本机构建的载荷要过检查：替身解释器与真实 Node 都被启动，暂存载荷不被写入', { skip: !POSIX }, async (t) => {
  const f = fixture(t, { smoke: true, python: 'dirty' });
  const unrun = await stagePrimaryRuntime(f.args());
  const record = await stagePrimaryRuntime(f.args({ smoke: true }));
  assert.deepEqual(record.smoke, { status: 'passed', node: process.versions.node, pnpm: PNPM_VERSION, python: PYTHON_VERSION });
  assert.deepEqual(record.payload, unrun.payload, 'a payload that passed its checks is the same payload as one that was never run');
  assert.equal(record.payloadDigest, unrun.payloadDigest);
  assert.equal(existsSync(join(f.payload, 'dependencies', 'python', 'bin', 'touched-by-the-checks')), false, 'what the interpreters wrote went into the copy, not into the payload');
});

test('反向：解释器跑不起来时暂存失败，已放好的载荷被撤下', { skip: !POSIX }, async (t) => {
  const f = fixture(t, { smoke: true, python: 'failing' });
  await assert.rejects(stagePrimaryRuntime(f.args({ smoke: true })), refused('SMOKE_FAILED'));
  assert.equal(existsSync(f.payload), false, 'a payload that did not pass its checks is not left where a later step would ship it');
});

test('检查只为构建机自己的目标运行：别的目标不运行并如实记录', { skip: !POSIX }, async (t) => {
  const f = fixture(t, { smoke: true });
  const record = await stagePrimaryRuntime(f.args({ smoke: true }));
  const manifest = JSON.parse(readFileSync(join(f.payload, 'runtime.json'), 'utf8'));
  const scratch = mkdtempSync(join(tmpdir(), 'forge-primary-runtime-scratch-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const foreign = await smokePayload(f.payload, { ...manifest, arch: manifest.arch === 'arm64' ? 'x64' : 'arm64' }, helpers, { scratch, environment: {} });
  assert.equal(foreign.status, 'skipped');
  assert.match(foreign.reason, /checked on that target/u);
  assert.equal(record.smoke.status, 'passed');
  assert.equal(existsSync(join(f.payload, 'runtime.json')), true);
  await assert.rejects(smokePayload(f.payload, manifest, helpers, { environment: {} }), refused('BAD_ARGUMENT'));
});

/** Why the release workflow would not put the right payload into the right installer; empty when it does. */
function workflowProblems(workflow) {
  // A job is everything below its two-space key, up to the next job.
  const jobs = Object.fromEntries(
    workflow.split(/\n  (?=[a-z][\w-]*:[ \t]*\n)/u).slice(1).map((block) => [block.slice(0, block.indexOf(':')), block]),
  );
  // A staged command is a first line ending in a backslash and the lines it is joined to; the one-line lock check is not one.
  const stagings = (block) => [...block.matchAll(/stage-primary-runtime\.mjs[^\n]*\n(?:[^\S\n]+[^\n]*\\\n)+[^\S\n]+[^\n]*/gu)].map((match) => ({ command: match[0], at: match.index }));
  const problems = [];
  for (const [name, target] of [['desktop-mac', 'mac-arm64'], ['desktop-windows', 'win-x64']]) {
    const block = jobs[name];
    if (block === undefined) {
      problems.push(`${name}: no such job`);
      continue;
    }
    const commands = stagings(block);
    // The payload is laid out the way the locked dsh reads it, so it is staged once the closure is there, and before the installer.
    if (commands.length === 1) {
      const before = block.indexOf('stage-desktop-payload.mjs');
      const after = block.indexOf('build-desktop-installer.mjs');
      if (!(0 <= before && before < commands[0].at && commands[0].at < after)) {
        problems.push(`${name}: the bundled runtime must be staged after the dsh closure and before the installer`);
      }
    } else {
      problems.push(`${name}: exactly one staging of the bundled runtime`);
    }
    // A ledger that is not upstream's for this dsh version must stop the job before anything is built.
    const verified = block.indexOf('stage-primary-runtime.mjs --verify-lock');
    if (verified === -1 || verified > block.indexOf('stage-desktop-payload.mjs')) {
      problems.push(`${name}: the pinned lock must be compared with upstream before anything is staged`);
    }
    for (const flag of [`--target ${target}`, '--output "$RUNNER_TEMP/staged/resources"', '--pnpm-tgz "$PNPM_TGZ"', '--dsh-modules "$RUNNER_TEMP/staged/resources/dsh/node_modules"', '--version "$GITHUB_REF_NAME"']) {
      if (commands.length === 1 && !commands[0].command.includes(flag)) problems.push(`${name}: the staging must pass ${flag}`);
    }
  }
  return problems;
}

test('流水线契约：两个桌面任务先核对台账与上游一致，再在 dsh 闭包之后、打包之前为目标平台暂存运行时', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release-bundle.yml'), 'utf8');
  assert.deepEqual(workflowProblems(workflow), []);
});

test('反向：流水线里运行时暂缺的任何一环都被识别（变异证明）', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release-bundle.yml'), 'utf8');
  const variants = [
    ['the lock is not compared with upstream', workflow.replace('      - name: Verify the pinned runtime lock against upstream\n        run: node scripts/stage-primary-runtime.mjs --verify-lock\n', ''), /desktop-mac: the pinned lock must be compared with upstream/u],
    ['the Windows job builds the wrong payload', workflow.replace(/(stage-primary-runtime\.mjs[^\n]*\n\s+)--target win-x64/u, '$1--target linux-x64'), /desktop-windows: the staging must pass --target win-x64/u],
    ['the macOS job stages before the dsh closure', workflow.replace(/(      - name: Stage the desktop payload\n        run: \|\n(?:[^\n]*\n)*?)(      - name: Stage the bundled runtime\n        run: \|\n(?:[^\n]*\n)*?[^\n]*primary-runtime-record\.json"\n)/u, '$2$1'), /desktop-mac: the bundled runtime must be staged after the dsh closure/u],
    ['the runtime is not staged at all', workflow.replace(/      - name: Stage the bundled runtime\n        run: \|\n(?:[^\n]*\n)*?[^\n]*primary-runtime-record\.json"\n/u, ''), /desktop-mac: exactly one staging/u],
  ];
  for (const [label, variant, pattern] of variants) {
    assert.notEqual(variant, workflow, `${label}: the mutation must change the workflow`);
    const problems = workflowProblems(variant);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${label}: ${problems.join('; ') || 'no problem reported'}`);
  }
});
