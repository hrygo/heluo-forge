import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_HOST_VERSION,
  ENTRY_PACKAGE,
  InitError,
  CLIENT_SECRET_BINDING_FILE,
  CLIENT_SECRET_SCHEMA,
  METADATA_FILE,
  PROFILE_NAMES,
  PNPM_FROM_HOST_LINE,
  REINSTALL_LINE,
  RELEASE_SCHEMA,
  USAGE,
  dshHomeOf,
  inspectProfile,
  locateDsh,
  locateDshLaunch,
  locateNpmLaunch,
  parseArgs,
  credentialStoreDirectory,
  ensureStoreDirectory,
  pnpmErrorCode,
  probeStoreDirectory,
  provisionClientSecret,
  readEmbeddedClientSecret,
  readPrivateRelease,
  recordedStoreDirectory,
  reasonTail,
  resolveDshLaunch,
  resetProfileNodeModules,
  runInit,
  sha256File,
  shimEntryOf,
} from '../scripts/init-enterprise-plugin.mjs';
import { readDshVersion } from '../scripts/lib/dsh-version.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/init-enterprise-plugin.mjs', import.meta.url));
const TOOL_ROOT = dirname(dirname(SCRIPT));
const HEX = (digit) => digit.repeat(64);

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeRelease(root, { version = '0.1.0', bytes = Buffer.from('fake-tarball-bytes'), mutate } = {}) {
  const dir = join(root, 'release');
  mkdirSync(dir, { recursive: true });
  const name = `forge-enterprise-${version}.tgz`;
  const tarballPath = join(dir, name);
  writeFileSync(tarballPath, bytes);
  const metadata = {
    schema: RELEASE_SCHEMA,
    entry: { name: ENTRY_PACKAGE, version },
    base: { version: '0.1.0', tarballSha256: HEX('a') },
    tool: { name: 'heluo-forge-public-tools', version: '0.1.0' },
    config: { keys: [], secretEmbedded: false },
    changed: true,
    tarball: { name, sha256: sha256File(tarballPath), bytes: bytes.length },
    manifestSha256: HEX('b'),
    generatedAt: '2026-11-10T00:00:00.000Z',
  };
  if (mutate !== undefined) mutate(metadata, tarballPath);
  writeFileSync(join(dir, METADATA_FILE), JSON.stringify(metadata));
  return { dir, metadata, tarballPath };
}

function writeProfile(root, { profile = 'desktop', installedVersion = null, dependencies = {}, bundles = [] } = {}) {
  const home = join(root, 'home');
  const profileDir = join(home, '.dsh', 'profiles', profile);
  mkdirSync(profileDir, { recursive: true });
  const manifest = {
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: { profile: { bundles: [...bundles] } },
    dependencies: { ...dependencies },
  };
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest));
  if (installedVersion !== null) {
    const installed = join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/'));
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: ENTRY_PACKAGE, version: installedVersion }));
  }
  return { home, profileDir, manifestPath: join(profileDir, 'package.json') };
}

function writeDsh(root) {
  const dir = join(root, 'bin');
  mkdirSync(dir, { recursive: true });
  const name = process.platform === 'win32' ? 'dsh.exe' : 'dsh';
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

/** 一个只有 pnpm 的 PATH 目录：dsh 安装插件时由宿主自己调用 pnpm。 */
function writePnpm(root) {
  const dir = join(root, 'pnpm-bin');
  mkdirSync(dir, { recursive: true });
  const name = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
  const path = join(dir, name);
  writeFileSync(path, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(path, 0o755);
  return dir;
}

/**
 * 注入的 exec：install/remove 时真实改写 profile（模拟宿主 reconcile），dump-config 返回合成树。
 * `removeCode` 非 0 时 remove 失败且不改写 profile，用于验证卸载失败不会继续安装。
 */
function fakeExec({
  profileDir,
  version = '0.1.0',
  installCode = 0,
  removeCode = 0,
  dumpConfig = { includeEntry: true },
  dumpConfigCode = 0,
  dumpConfigStderr = 'profile "desktop" is managed exclusively by the Electron application',
} = {}) {
  const calls = [];
  const exec = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[0] === 'plugin') {
      const action = args[3];
      const installed = join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/'));
      const manifestPath = join(profileDir, 'package.json');
      if (action === 'remove') {
        if (removeCode !== 0) return { code: removeCode, stdout: '', stderr: 'remove failed' };
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        delete (manifest.dependencies ?? {})[ENTRY_PACKAGE];
        manifest.dsh = manifest.dsh ?? {};
        manifest.dsh.profile = manifest.dsh.profile ?? {};
        manifest.dsh.profile.bundles = (manifest.dsh.profile.bundles ?? []).filter((name) => name !== ENTRY_PACKAGE);
        writeFileSync(manifestPath, JSON.stringify(manifest));
        rmSync(installed, { recursive: true, force: true });
        return { code: 0, stdout: 'removed', stderr: '' };
      }
      if (installCode !== 0) return { code: installCode, stdout: '', stderr: 'pnpm failed' };
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [ENTRY_PACKAGE]: `file:${args[4]}` };
      manifest.dsh = manifest.dsh ?? {};
      manifest.dsh.profile = manifest.dsh.profile ?? {};
      manifest.dsh.profile.bundles = [...new Set([...(manifest.dsh.profile.bundles ?? []), ENTRY_PACKAGE])];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: ENTRY_PACKAGE, version }));
      return { code: 0, stdout: 'added', stderr: '' };
    }
    if (dumpConfigCode !== 0) return { code: dumpConfigCode, stdout: '', stderr: dumpConfigStderr };
    const plugins = dumpConfig.includeEntry ? [{ name: ENTRY_PACKAGE }] : [];
    return { code: 0, stdout: JSON.stringify({ plugins }), stderr: '' };
  };
  return { exec, calls };
}

test('parseArgs 接受完整参数并归一化摘要大小写', () => {
  const options = parseArgs([
    '--release',
    '/tmp/release',
    '--profile',
    'desktop',
    '--sha256',
    HEX('A'),
    '--dsh',
    '/usr/local/bin/dsh',
    '--dry-run',
    '--json',
  ]);
  assert.equal(options.release, '/tmp/release');
  assert.equal(options.profile, 'desktop');
  assert.equal(options.sha256, HEX('a'));
  assert.equal(options.dsh, '/usr/local/bin/dsh');
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
  assert.deepEqual(PROFILE_NAMES, ['desktop', 'web']);
  assert.deepEqual(parseArgs(['--profile=web', '--release=/r']).profile, 'web');
  const auto = parseArgs(['--release', '/r', '--profile', 'auto', '--install-host', '--host-version', '0.2.2-rc.1']);
  assert.equal(auto.profile, 'auto');
  assert.equal(auto.installHost, true);
  assert.equal(auto.hostVersion, '0.2.2-rc.1');
  assert.equal(parseArgs(['--release', '/r', '--profile', 'auto']).installHost, false);
});

test('runInit --profile auto --install-host：装宿主、建 web profile、装插件', async (t) => {
  const root = tempRoot(t);
  const { dir } = writeRelease(root);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const npm = join(bin, 'npm');
  writeFileSync(npm, '#!/bin/sh\nexit 0\n');
  chmodSync(npm, 0o755);
  const dshPath = join(bin, 'dsh');
  writeFileSync(join(bin, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'), process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(join(bin, 'pnpm'), 0o755);
  const dshHome = join(root, 'home', '.dsh');
  const profileDir = join(dshHome, 'profiles', 'web');
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    if (command === npm) {
      writeFileSync(dshPath, '#!/bin/sh\nexit 0\n');
      chmodSync(dshPath, 0o755);
      return { code: 0, stdout: 'installed', stderr: '' };
    }
    if (args[0] === 'plugin') {
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [ENTRY_PACKAGE]: `file:${args[4]}` };
      manifest.dsh = { profile: { bundles: [ENTRY_PACKAGE] } };
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest));
      const installed = join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/'));
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: ENTRY_PACKAGE, version: '0.1.0' }));
      return { code: 0, stdout: 'added', stderr: '' };
    }
    if (!existsSync(join(profileDir, 'package.json'))) {
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dsh: { profile: { bundles: [] } },
        dependencies: {},
      }));
    }
    return { code: 0, stdout: JSON.stringify({ plugins: [{ name: ENTRY_PACKAGE }] }), stderr: '' };
  };
  const outcome = await runInit({
    argv: ['--release', dir, '--profile', 'auto', '--install-host', '--json'],
    env: { PATH: bin, DSH_HOME: dshHome },
    home: join(root, 'home'),
    exec,
  });
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'installed');
  assert.equal(outcome.result.profile, 'web');
  assert.equal(outcome.result.verified.dumpConfig, true);
  assert.ok(
    calls.some((call) => call.command === npm && call.args.includes(`@deepseek-ai/dsh@${DEFAULT_HOST_VERSION}`)),
    '安装命令必须钉住脚本声明的默认宿主版本',
  );
  assert.equal(DEFAULT_HOST_VERSION, readDshVersion(TOOL_ROOT), '默认宿主版本必须等于仓库基线（发行默认宿主检查）');
  assert.ok(calls.some((call) => call.command === dshPath && call.args.join(' ') === '--profile web --dump-config'));
  assert.ok(calls.some((call) => call.command === dshPath && call.args[0] === 'plugin'));
});

test('runInit --profile auto 在只有 Desktop profile 时明确拒绝，不误选', async (t) => {
  const root = tempRoot(t);
  const { dir } = writeRelease(root);
  const dshPath = writeDsh(root);
  writeProfile(root, { profile: 'desktop' });
  const outcome = await runInit({
    argv: ['--release', dir, '--profile', 'auto', '--dsh', dshPath, '--json'],
    env: {},
    home: join(root, 'home'),
    exec: fakeExec({ profileDir: join(root, 'home', '.dsh', 'profiles', 'desktop') }).exec,
  });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'DESKTOP_PROFILE_UNSUPPORTED');
  assert.match(outcome.result.error.next, /Desktop/u);
});

test('runInit 对缺失的 desktop profile 仍 fail closed', async (t) => {
  const root = tempRoot(t);
  const { dir } = writeRelease(root);
  const dshPath = writeDsh(root);
  const outcome = await runInit({
    argv: ['--release', dir, '--profile', 'desktop', '--dsh', dshPath],
    env: {},
    home: join(root, 'home'),
    exec: fakeExec({ profileDir: join(root, 'home', '.dsh', 'profiles', 'desktop') }).exec,
  });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'PROFILE_MISSING');
});

test('parseArgs 对缺参、未知参数、非法 profile 与非法摘要 fail-closed', () => {
  const cases = [
    { argv: [], code: 'BAD_ARGUMENT' },
    { argv: ['--release', '/r'], code: 'BAD_ARGUMENT' },
    { argv: ['--release', '/r', '--profile'], code: 'BAD_ARGUMENT' },
    { argv: ['--release', '/r', '--profile', '../sdk'], code: 'PROFILE_INVALID' },
    { argv: ['--release', '/r', '--profile', 'desktop', '--sha256', 'xyz'], code: 'DIGEST_INVALID' },
    { argv: ['--release', '/r', '--bogus'], code: 'BAD_ARGUMENT' },
  ];
  for (const { argv, code } of cases) {
    assert.throws(() => parseArgs(argv), (error) => error instanceof InitError && error.code === code, JSON.stringify(argv));
  }
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--release', '/r', '--profile', 'web']).dryRun, false);
});

test('dshHomeOf 以 DSH_HOME 优先，空白回落到 ~/.dsh', () => {
  assert.equal(dshHomeOf({ DSH_HOME: '/custom/dsh' }, '/tmp/u'), '/custom/dsh');
  assert.equal(dshHomeOf({ DSH_HOME: '  ' }, '/tmp/u'), join('/tmp/u', '.dsh'));
  assert.equal(dshHomeOf({}, '/tmp/u'), join('/tmp/u', '.dsh'));
});

test('locateDsh 只接受可执行文件，空 PATH 返回 null', (t) => {
  const root = tempRoot(t);
  assert.equal(locateDsh({ PATH: '' }), null);
  assert.equal(locateDsh({}), null);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const name = process.platform === 'win32' ? 'dsh.exe' : 'dsh';
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') assert.equal(locateDsh({ PATH: bin }), null);
  chmodSync(join(bin, name), 0o755);
  assert.equal(locateDsh({ PATH: bin }), join(bin, name));
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'dsh.cmd'), 'rem shim');
    assert.notEqual(locateDsh({ PATH: bin }), join(bin, 'dsh.cmd'));
  }
});

test('resolveDshLaunch 解析 npm 的 dsh.cmd，用 node 直接运行 JS 入口', (t) => {
  const root = tempRoot(t);
  const bin = join(root, 'bin');
  const entry = join(bin, 'node_modules', '@deepseek', 'harness', 'bin', 'dsh.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '// dsh entry\n');
  const shim = join(bin, 'dsh.cmd');
  writeFileSync(shim, [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek\\harness\\bin\\dsh.js" %*',
  ].join('\r\n'));

  assert.equal(shimEntryOf(shim), entry);
  assert.deepEqual(resolveDshLaunch(shim, 'win32'), { bin: process.execPath, prefix: [entry] });

  const located = locateDshLaunch({ PATH: bin }, 'win32');
  assert.equal(located.path, shim);
  assert.deepEqual({ bin: located.bin, prefix: located.prefix }, { bin: process.execPath, prefix: [entry] });
});

test('resolveDshLaunch 对不可解析、越界或非文件 shim fail closed', (t) => {
  const root = tempRoot(t);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const outside = join(root, 'outside.js');
  writeFileSync(outside, '// outside\n');

  const unparsable = join(bin, 'dsh.cmd');
  writeFileSync(unparsable, 'rem shim without a JS target');
  assert.equal(shimEntryOf(unparsable), null);
  assert.equal(resolveDshLaunch(unparsable, 'win32'), null);

  const traversal = join(bin, 'dsh.bat');
  writeFileSync(traversal, '"%dp0%\\..\\outside.js" %*');
  assert.equal(shimEntryOf(traversal), null);
  assert.equal(resolveDshLaunch(traversal, 'win32'), null);

  assert.equal(resolveDshLaunch(join(bin, 'missing.cmd'), 'win32'), null);
});

test('resolveDshLaunch 与 locateDsh 对原生 .exe 保持直接执行，且不跨平台误判', (t) => {
  const root = tempRoot(t);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, 'dsh.exe');
  writeFileSync(exe, 'MZ');
  assert.deepEqual(resolveDshLaunch(exe, 'win32'), { bin: exe, prefix: [] });
  assert.deepEqual(resolveDshLaunch(exe, 'linux'), null);
  assert.equal(locateDsh({ PATH: bin }, 'win32'), exe);
});

test('locateNpmLaunch 在 Windows 上固定选 npm-cli.js，不落到 npm-prefix.js', (t) => {
  const root = tempRoot(t);
  const bin = join(root, 'npm-bin');
  const cli = join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '');
  writeFileSync(join(bin, 'node_modules', 'npm', 'bin', 'npm-prefix.js'), '');
  writeFileSync(join(bin, 'npm.cmd'), '@ECHO OFF\n"%dp0%\\node.exe" "%dp0%\\node_modules\\npm\\bin\\npm-prefix.js" %*\n');

  const launch = locateNpmLaunch({ PATH: bin }, 'win32');
  assert.notEqual(launch, null);
  assert.deepEqual(launch.prefix, [cli]);

  assert.equal(locateNpmLaunch({ PATH: join(root, 'empty') }, 'win32'), null);
});

test('sha256File 输出 hex 小写', (t) => {
  const root = tempRoot(t);
  const path = join(root, 'bytes');
  writeFileSync(path, 'abc');
  assert.equal(sha256File(path), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('readPrivateRelease 核验 sidecar 与 tgz，逐项 fail-closed', (t) => {
  const root = tempRoot(t);
  const valid = writeRelease(root);
  const release = readPrivateRelease(valid.dir);
  assert.equal(release.version, '0.1.0');
  assert.equal(release.tarballPath, valid.tarballPath);
  assert.equal(release.sha256, sha256File(valid.tarballPath));

  const missing = join(root, 'missing');
  assert.throws(() => readPrivateRelease(missing), (error) => error.code === 'RELEASE_MISSING');

  const withoutSidecar = join(root, 'no-sidecar');
  mkdirSync(withoutSidecar, { recursive: true });
  assert.throws(() => readPrivateRelease(withoutSidecar), (error) => error.code === 'SIDECAR_MISSING');

  const checks = [
    { label: 'schema', mutate: (meta) => { meta.schema = 'heluo-private-release/2'; }, code: 'SIDECAR_INVALID' },
    { label: 'entry', mutate: (meta) => { meta.entry.name = '@heluo/forge-devops'; }, code: 'SIDECAR_INVALID' },
    { label: 'secret', mutate: (meta) => { meta.config.secretEmbedded = true; }, code: 'SECRET_BUNDLE_INCOMPLETE' },
    { label: 'traversal', mutate: (meta) => { meta.tarball.name = '../escape.tgz'; }, code: 'SIDECAR_INVALID' },
    { label: 'digest-format', mutate: (meta) => { meta.tarball.sha256 = 'nope'; }, code: 'SIDECAR_INVALID' },
    { label: 'bytes', mutate: (meta) => { meta.tarball.bytes = meta.tarball.bytes + 1; }, code: 'TARBALL_MISMATCH' },
    { label: 'digest', mutate: (meta) => { meta.tarball.sha256 = HEX('c'); }, code: 'SIDECAR_DIGEST_MISMATCH' },
    { label: 'missing-tarball', mutate: (meta) => { meta.tarball.name = 'gone.tgz'; }, code: 'TARBALL_MISSING' },
  ];
  for (const { label, mutate, code } of checks) {
    const dir = join(root, `case-${label}`);
    mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(`payload-${label}`);
    const name = 'forge-enterprise-0.1.0.tgz';
    writeFileSync(join(dir, name), bytes);
    const metadata = {
      schema: RELEASE_SCHEMA,
      entry: { name: ENTRY_PACKAGE, version: '0.1.0' },
      config: { keys: [], secretEmbedded: false },
      tarball: { name, sha256: sha256File(join(dir, name)), bytes: bytes.length },
    };
    mutate(metadata, dir);
    writeFileSync(join(dir, METADATA_FILE), JSON.stringify(metadata));
    assert.throws(() => readPrivateRelease(dir), (error) => error.code === code, label);
  }
});

test('inspectProfile 只读已有 profile，缺失/损坏分别报错', (t) => {
  const root = tempRoot(t);
  assert.throws(
    () => inspectProfile({ profile: 'desktop', env: { DSH_HOME: join(root, 'home', '.dsh') }, home: join(root, 'home') }),
    (error) => error.code === 'PROFILE_MISSING' && /Desktop/.test(error.next),
  );
  assert.throws(() => inspectProfile({ profile: '../sdk', env: {}, home: root }), (error) => error.code === 'PROFILE_INVALID');

  const { home, manifestPath } = writeProfile(root);
  const profile = inspectProfile({ profile: 'desktop', env: { DSH_HOME: join(home, '.dsh') }, home });
  assert.equal(profile.name, 'desktop');
  assert.equal(profile.manifestPath, manifestPath);

  writeFileSync(manifestPath, '{not json');
  assert.throws(() => inspectProfile({ profile: 'desktop', env: { DSH_HOME: join(home, '.dsh') }, home }), (error) => error.code === 'PROFILE_INVALID');
});

test('runInit 安装成功：argv 逐字、shell:false、L2 核验、mounted=unknown', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const { exec, calls } = fakeExec({ profileDir });

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--sha256', sha256File(release.tarballPath), '--dsh', dshPath],
    env: { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) },
    home,
    exec,
  });

  assert.equal(outcome.code, 0);
  assert.equal(outcome.result.status, 'installed');
  assert.equal(outcome.result.mounted, 'unknown');
  assert.deepEqual(outcome.result.verified, { exitCode: 0, dumpConfig: true, profileAligned: true });
  assert.equal(outcome.result.artifact.identity, 'confirmed');
  assert.equal(calls.length, 3, 'desktop 必须先探测 --dump-config 能否命令行核验，再 add，最后核验');
  assert.equal(calls[0].bin, dshPath);
  assert.deepEqual(calls[0].args, ['--profile', 'desktop', '--dump-config'], '写入前的可核验性探测');
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[1].args, ['plugin', '--profile', 'desktop', 'add', release.tarballPath]);
  assert.equal(calls[1].options.shell, false);
  assert.deepEqual(calls[2].args, ['--profile', 'desktop', '--dump-config']);
  assert.equal(calls[2].options.shell, false);
  assert.ok(outcome.lines.some((line) => line.includes('mounted=unknown')));
  assert.ok(outcome.lines.every((line) => !line.includes('secret')));
  // 第 19 条：启动器传入的 --sha256 是同一 tgz 的自算值，必须标成自证，不能冒充独立口径。
  assert.ok(
    outcome.lines.some((line) => line.includes('摘要') && line.includes('自证')),
    '摘要来源必须如实标注自证',
  );
  assert.ok(outcome.lines.every((line) => !line.includes('独立口径')), '自算摘要不得标成独立口径');
});

test('缺 pnpm 时用 npm 补装，并把 pnpm 目录注入安装子进程 PATH', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const bin = join(root, 'bin-npm');
  mkdirSync(bin, { recursive: true });
  const npm = join(bin, 'npm');
  writeFileSync(npm, '#!/bin/sh\nexit 0\n');
  chmodSync(npm, 0o755);
  const inner = fakeExec({ profileDir });
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === npm) {
      const pnpm = join(bin, 'pnpm');
      writeFileSync(pnpm, '#!/bin/sh\nexit 0\n');
      chmodSync(pnpm, 0o755);
      return { code: 0, stdout: 'added 1 package', stderr: '' };
    }
    return inner.exec(command, args, options);
  };

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env: { DSH_HOME: join(home, '.dsh'), PATH: bin },
    home,
    exec,
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.deepEqual(calls[0].args, ['--profile', 'desktop', '--dump-config'], '先探测 desktop 可核验性');
  assert.deepEqual(calls[1].args, ['install', '-g', 'pnpm']);
  const add = calls.find((call) => call.args[0] === 'plugin');
  assert.ok(add !== undefined, '应执行 dsh plugin add');
  assert.ok(add.options.env.PATH.startsWith(`${bin}${process.platform === 'win32' ? ';' : ':'}`));
  assert.ok(outcome.lines.some((line) => line.includes('npm install -g pnpm')));
});

/** 一个既没有 pnpm 也没有 npm 的 PATH 目录：没有开发环境的员工机器就是这个样子。 */
function writeBarePath(root) {
  const dir = join(root, 'bare-bin');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('--pnpm-from-host：PATH 上没有 pnpm 也没有 npm 时照常安装，不查找、不补装', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writeBarePath(root) };
  const base = ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath];

  // The same machine without the flag: the installer stops for the missing tool, before any install.
  const plain = fakeExec({ profileDir });
  const stopped = await runInit({ argv: base, env, home, exec: plain.exec });
  assert.equal(stopped.result.error.code, 'PNPM_REQUIRED');
  assert.equal(existsSync(join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/'))), false, '缺工具时不得写入');

  // With the flag the tool is the host's: nothing is looked up, nothing is installed, the plugin is.
  const { exec, calls } = fakeExec({ profileDir });
  const outcome = await runInit({ argv: [...base, '--pnpm-from-host'], env, home, exec });
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'installed');
  assert.ok(calls.length > 0 && calls.every((call) => call.bin === dshPath), '只启动宿主，不启动任何补装命令');
  assert.equal(calls.some((call) => call.args[0] === 'install'), false, '不得执行 npm install -g pnpm');
  const add = calls.find((call) => call.args[0] === 'plugin');
  assert.ok(add !== undefined, '应执行 dsh plugin add');
  // PATH reaches dsh exactly as it was handed over: no directory is put in front of it.
  assert.equal(add.options.env.PATH, env.PATH);
  // The conclusion says where the tool came from, so the log does not read as if PATH had been searched.
  assert.ok(outcome.lines.includes(PNPM_FROM_HOST_LINE), '结论须写明 pnpm 由宿主提供');
});

test('--pnpm-from-host 演练：写明工具来源，不执行安装，也不要求 PATH 上有 pnpm', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const { exec, calls } = fakeExec({ profileDir });
  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath, '--pnpm-from-host', '--dry-run', '--json'],
    env: { DSH_HOME: join(home, '.dsh'), PATH: writeBarePath(root) },
    home,
    exec,
  });
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'dry-run');
  assert.ok(outcome.lines.includes(PNPM_FROM_HOST_LINE));
  assert.equal(calls.some((call) => call.args[0] === 'plugin'), false, '演练不得安装');
});

test('parseArgs：--pnpm-from-host 是布尔开关，缺省关闭，不带值', () => {
  const base = ['--release', '/r', '--profile', 'web'];
  assert.equal(parseArgs(base).pnpmFromHost, false);
  assert.equal(parseArgs([...base, '--pnpm-from-host']).pnpmFromHost, true);
  assert.throws(() => parseArgs([...base, '--pnpm-from-host=true']), (error) => error.code === 'BAD_ARGUMENT' && /未知参数/u.test(error.message));
  assert.throws(() => parseArgs([...base, '--pnpm']), (error) => error.code === 'BAD_ARGUMENT' && /未知参数/u.test(error.message));
  assert.ok(USAGE.includes('--pnpm-from-host'), '用法说明须列出该参数');
});

test('parseArgs：--reinstall-on-store-mismatch 是布尔开关，缺省关闭，不带值', () => {
  const base = ['--release', '/r', '--profile', 'web'];
  assert.equal(parseArgs(base).reinstallOnStoreMismatch, false);
  assert.equal(parseArgs([...base, '--reinstall-on-store-mismatch']).reinstallOnStoreMismatch, true);
  assert.throws(() => parseArgs([...base, '--reinstall-on-store-mismatch=true']), (error) => error.code === 'BAD_ARGUMENT' && /未知参数/u.test(error.message));
  assert.ok(USAGE.includes('--reinstall-on-store-mismatch'), '用法说明须列出该参数');
  assert.ok(USAGE.includes('PROFILE_STORE_MISMATCH'), '用法说明须写明不带该参数时的结论');
});

/**
 * pnpm 在「由另一个 store 链接的 node_modules」上拒绝继续安装时的输出：错误码在输出前部，
 * 末尾几行只剩通用提示。结论若只看末尾，员工看到的就是「换一个 store 或重装依赖」，
 * 看不出是哪一个 profile 出的问题。
 */
const STORE_MISMATCH_STDERR = [
  'Error: ERR_PNPM_UNEXPECTED_STORE',
  '  × adding a new package',
  '  ╰─▶ Unexpected store location',
  '  help: The dependencies at "/dsh/profiles/p/node_modules" are currently linked from the store at "/storeA/v11".',
  '        If you want to use the new store location, reinstall your dependencies with "pnpm install".',
  '        (This error may happen if the node_modules was installed with a different major version of pnpm)',
].join('\n');

const OWNED_PROFILE = 'heluo-desktop';
const anotherStore = (root) => join(root, 'another-pnpm', 'store', 'v10');

/**
 * 一个「被另一个 pnpm 装过」的 profile：node_modules 里留着那份 pnpm 的记录和别的插件。
 * `installedVersion` 给出时，profile 的清单已登记旧版本的企业插件（升级走卸载那一步）。
 */
function seedForeignProfile(root, { installedVersion = null } = {}) {
  const seeded = writeProfile(root, {
    profile: OWNED_PROFILE,
    ...(installedVersion === null
      ? {}
      : { installedVersion, dependencies: { [ENTRY_PACKAGE]: 'file:/old/forge-enterprise-0.0.9.tgz' }, bundles: [ENTRY_PACKAGE] }),
  });
  const modules = join(seeded.profileDir, 'node_modules');
  mkdirSync(modules, { recursive: true });
  writeFileSync(
    join(modules, '.modules.yaml'),
    JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted', packageManager: 'pnpm@10.0.0', storeDir: anotherStore(root) }),
  );
  mkdirSync(join(modules, 'other-plugin'), { recursive: true });
  writeFileSync(join(modules, 'other-plugin', 'package.json'), '{"name":"other-plugin"}');
  mkdirSync(join(modules, '.pnpm', 'other-plugin@1.0.0', 'node_modules', 'other-plugin'), { recursive: true });
  writeFileSync(join(modules, '.pnpm', 'other-plugin@1.0.0', 'node_modules', 'other-plugin', 'index.js'), 'module.exports = 1;');
  // pnpm 的布局里链接可以指向 profile 之外：清空 node_modules 不得进入它的目标。
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  symlinkSync(outside, join(modules, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  return { ...seeded, modules, outside };
}

/**
 * 宿主替身：见到别的 pnpm 留下的记录，就对 `actions` 里的包操作报 store 不一致
 * （`forever` 时清空之后也照报），其余交给 `fakeExec`。
 */
function hostOverForeignStore({ profileDir, actions = ['add'], forever = false }) {
  const inner = fakeExec({ profileDir });
  const record = join(profileDir, 'node_modules', '.modules.yaml');
  const calls = [];
  const exec = async (bin, args, options) => {
    calls.push({ bin, args, options });
    const refused = args[0] === 'plugin' && actions.includes(args[3]) && (forever || existsSync(record));
    return refused ? { code: 1, stdout: '', stderr: STORE_MISMATCH_STDERR } : inner.exec(bin, args, options);
  };
  const packageActions = () => calls.filter((call) => call.args[0] === 'plugin').map((call) => call.args[3]);
  return { exec, calls, packageActions };
}

const ownedRun = (release, dshPath, home, extra, exec) => runInit({
  argv: ['--release', release.dir, '--profile', OWNED_PROFILE, '--dsh', dshPath, '--pnpm-from-host', ...extra],
  env: { DSH_HOME: join(home, '.dsh'), PATH: writeBarePath(home) },
  home,
  exec,
});

test('pnpm store 不一致且未获修复授权：PROFILE_STORE_MISMATCH 带出 profile 与记录的 store，不重试、不动 node_modules', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, modules, outside } = seedForeignProfile(root);
  const host = hostOverForeignStore({ profileDir });

  const outcome = await ownedRun(release, writeDsh(root), home, ['--json'], host.exec);

  assert.equal(outcome.code, 1);
  // 不是笼统的 INSTALL_FAILED：错误码本身说出是哪一类问题。
  assert.equal(outcome.result.error.code, 'PROFILE_STORE_MISMATCH');
  assert.ok(outcome.result.error.message.includes(`profile「${OWNED_PROFILE}」的 node_modules 由另一个 pnpm store 装入`), outcome.result.error.message);
  assert.ok(outcome.result.error.message.includes(`（记录的 store：${anotherStore(root)}）`), '带出这份 node_modules 当初链接的 store');
  assert.match(outcome.result.error.next, new RegExp(`删除 profiles[/\\\\]${OWNED_PROFILE}[/\\\\]node_modules 后重跑`, 'u'));
  // 没有授权就只试这一次：不清空，不重试。
  assert.deepEqual(host.packageActions(), ['add']);
  assert.equal(existsSync(join(modules, '.modules.yaml')), true, '未获授权不得动 node_modules');
  assert.equal(existsSync(join(modules, 'other-plugin', 'package.json')), true);
  assert.equal(existsSync(join(modules, 'linked')), true);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('--reinstall-on-store-mismatch：清空 node_modules 后重试一次装上；链接只删链接，不进入目标', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, modules, outside } = seedForeignProfile(root);
  const host = hostOverForeignStore({ profileDir });

  const outcome = await ownedRun(release, writeDsh(root), home, ['--reinstall-on-store-mismatch', '--json'], host.exec);

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'installed');
  // 同一条命令试了两次：第一次被拒，清空后第二次通过。
  assert.deepEqual(host.packageActions(), ['add', 'add']);
  assert.equal(existsSync(join(modules, '.modules.yaml')), false);
  assert.equal(existsSync(join(modules, 'other-plugin')), false, '别的 pnpm 留下的插件随 node_modules 一起清掉');
  assert.equal(existsSync(join(modules, '.pnpm')), false, '嵌套目录逐层删除');
  assert.equal(existsSync(join(modules, 'linked')), false, '链接本身被删除');
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep', '链接的目标原样保留');
  assert.equal(existsSync(join(modules, ...ENTRY_PACKAGE.split('/'), 'package.json')), true, '重试后插件装上了');
  // 结论写明修复发生过：读日志的人能看出 node_modules 被清过。
  assert.ok(outcome.lines.includes(REINSTALL_LINE));
  assert.ok(outcome.lines.includes(`已清空 profiles/${OWNED_PROFILE}/node_modules`), outcome.lines.join('\n'));
  assert.ok(
    outcome.warnings.some((line) => line.startsWith(`warn: 已按 --reinstall-on-store-mismatch 清空 profiles/${OWNED_PROFILE}/node_modules`)),
    outcome.warnings.join('\n'),
  );
});

test('--reinstall-on-store-mismatch：卸载旧版本时遇到 store 不一致，清空后重试卸载，再安装', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = seedForeignProfile(root, { installedVersion: '0.0.9' });
  const host = hostOverForeignStore({ profileDir, actions: ['remove'] });

  const outcome = await ownedRun(release, writeDsh(root), home, ['--reinstall-on-store-mismatch', '--json'], host.exec);

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'installed');
  assert.equal(outcome.result.previousVersion, '0.0.9');
  assert.deepEqual(host.packageActions(), ['remove', 'remove', 'add']);
});

test('--reinstall-on-store-mismatch：清空后重试仍报 store 不一致，以 PROFILE_STORE_MISMATCH 停止，不再修复第二次', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, modules } = seedForeignProfile(root);
  const host = hostOverForeignStore({ profileDir, forever: true });

  const outcome = await ownedRun(release, writeDsh(root), home, ['--reinstall-on-store-mismatch', '--json'], host.exec);

  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'PROFILE_STORE_MISMATCH');
  assert.match(outcome.result.error.message, /清空 profiles\/heluo-desktop\/node_modules 重试后 pnpm 仍报 store 不一致/u);
  assert.match(outcome.result.error.next, /pnpm 配置（store-dir、PNPM_HOME）/u);
  assert.deepEqual(host.packageActions(), ['add', 'add'], '只修复一次');
  assert.equal(existsSync(join(modules, 'other-plugin')), false, '修复那一次确实清空了');
});

test('--reinstall-on-store-mismatch：node_modules 本身是链接时不清空，链接与它指向的内容都原样', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root, { profile: OWNED_PROFILE });
  const foreign = join(root, 'foreign-node-modules');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, '.modules.yaml'), JSON.stringify({ storeDir: anotherStore(root) }));
  writeFileSync(join(foreign, 'keep.txt'), 'keep');
  const link = join(profileDir, 'node_modules');
  symlinkSync(foreign, link, 'dir');
  const host = hostOverForeignStore({ profileDir });

  const outcome = await ownedRun(release, writeDsh(root), home, ['--reinstall-on-store-mismatch', '--json'], host.exec);

  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'PROFILE_RESET_FAILED');
  assert.match(outcome.result.error.message, /node_modules 是链接或不是目录，未清空/u);
  assert.deepEqual(host.packageActions(), ['add'], '清不了就不重试');
  assert.equal(lstatSync(link).isSymbolicLink(), true, '链接本身未被删除');
  assert.equal(existsSync(join(foreign, '.modules.yaml')), true);
  assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'keep');
});

test('--reinstall-on-store-mismatch 演练：写明修复已获准，不执行任何命令', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home } = writeProfile(root, { profile: OWNED_PROFILE });
  const outcome = await ownedRun(release, writeDsh(root), home, ['--reinstall-on-store-mismatch', '--dry-run', '--json'], async () => assert.fail('演练不得调用 exec'));
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'dry-run');
  assert.ok(outcome.lines.includes(REINSTALL_LINE));
});

test('recordedStoreDirectory 与 resetProfileNodeModules：两种记录格式都读得出，目录不存在时无事可做', (t) => {
  const root = tempRoot(t);
  assert.equal(recordedStoreDirectory(root), null, '没有 node_modules 就没有记录');
  assert.equal(resetProfileNodeModules(root), 'absent');
  mkdirSync(join(root, 'node_modules'));
  const record = join(root, 'node_modules', '.modules.yaml');
  // 现行 pnpm 写的是 JSON。
  writeFileSync(record, JSON.stringify({ layoutVersion: 5, storeDir: '/store/a' }));
  assert.equal(recordedStoreDirectory(root), '/store/a');
  // 逐行的写法也读：路径里的反斜杠与两端的引号不被改动。
  writeFileSync(record, 'layoutVersion: 5\nstoreDir: "C:\\corp\\store\\v10"\n');
  assert.equal(recordedStoreDirectory(root), 'C:\\corp\\store\\v10');
  writeFileSync(record, 'layoutVersion: 5\n');
  assert.equal(recordedStoreDirectory(root), null, '没有 storeDir 就不猜');
});

test('包操作失败时结论带出 pnpm 的错误码：错误码在输出前部，只看末尾几行看不出原因', async (t) => {
  assert.equal(pnpmErrorCode({ stdout: '', stderr: STORE_MISMATCH_STDERR }), 'ERR_PNPM_UNEXPECTED_STORE');
  assert.equal(pnpmErrorCode({ stdout: 'added\n', stderr: 'warn: something\n' }), null);

  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const inner = fakeExec({ profileDir });
  const refused = async (bin, args, options) => (args[0] === 'plugin'
    ? { code: 1, stdout: '', stderr: 'Error: ERR_PNPM_FETCH_404\n  help: request failed with status 404\n' }
    : inner.exec(bin, args, options));
  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', writeDsh(root), '--pnpm-from-host', '--json'],
    env: { DSH_HOME: join(home, '.dsh') },
    home,
    exec: refused,
  });
  assert.equal(outcome.result.error.code, 'INSTALL_FAILED', '不是 store 不一致，仍是原有分类');
  assert.ok(outcome.result.error.message.includes('：ERR_PNPM_FETCH_404：'), outcome.result.error.message);
});

/** What Node prints when a child dies of an uncaught exception: source, caret, the error, then where it happened. */
const CRASH = [
  'file:///apps/Resources/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:547',
  '\tif (name === "" || name.includes("/")) throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`);',
  '\t                                                                                                                                ^',
  '',
  'Error: dsh: invalid profile name "/profiles/web/node_modules/@heluo/forge-enterprise/node_modules/@heluo/forge-iam/bin/heluo-forge.mjs"',
  '    at resolveProfileDir (file:///apps/Resources/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:547:130)',
  '    at loadProfile (file:///apps/Resources/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1066:14)',
  '    at async Module.runCli (file:///apps/Resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js:253:5)',
  '',
  'Node.js v24.21.0',
].join('\n');

test('reasonTail：子进程因异常退出时带回真正的报错行，而不是占满末尾的调用栈', () => {
  const reason = reasonTail({ stdout: '', stderr: `${CRASH}\n` });
  assert.ok(reason.includes('Error: dsh: invalid profile name "/profiles/web/node_modules/@heluo/forge-enterprise/node_modules/@heluo/forge-iam/bin/heluo-forge.mjs"'), reason);
  assert.equal(reason.includes('at resolveProfileDir'), false, '调用栈只说明代码位置，不是原因');
  assert.equal(reason.includes('at async Module.runCli'), false);
  assert.equal(reason.includes('index.js:547\n'), false, '源码位置与插入符同样不算');
  assert.equal(reason.includes('Node.js v24.21.0'), false);
  // The error line is last and whole: a long line before it is cut on its own instead of crowding it out.
  assert.ok(reason.endsWith('"'), reason);
  assert.ok(reason.split(' / ').length <= 3);

  // An ordinary failure is repeated as it was, and a line that merely starts with "at" is not mistaken for a frame.
  assert.equal(reasonTail({ stdout: '', stderr: 'dsh: pnpm was not found; install pnpm and make it available on PATH.\n' }), 'dsh: pnpm was not found; install pnpm and make it available on PATH.');
  assert.equal(reasonTail({ stdout: 'added\n', stderr: 'warn: at least one warning\n' }), 'warn: at least one warning / added');
  assert.equal(reasonTail({ stdout: '', stderr: ' \n\n' }), '');
  const long = reasonTail({ stdout: `${'x'.repeat(400)}\n`, stderr: '' });
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
});

test('失败的结论带上走到失败为止的回显（progress），供桌面壳写日志；终端回显不变', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const inner = fakeExec({ profileDir });
  // The add step dies the way a crashing child does.
  const exec = async (bin, args, options) => {
    const result = await inner.exec(bin, args, options);
    return args[0] === 'plugin' ? { ...result, code: 1, stdout: '', stderr: CRASH } : result;
  };
  const base = ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath, '--pnpm-from-host'];

  const structured = await runInit({ argv: [...base, '--json'], env: { DSH_HOME: join(home, '.dsh'), PATH: writeBarePath(root) }, home, exec });
  assert.equal(structured.result.error.code, 'INSTALL_FAILED');
  // With --json nothing is printed as echo, before or now: what the run printed travels beside the verdict.
  assert.deepEqual(structured.lines, []);
  assert.ok(structured.progress[0] === '企业插件初始化');
  assert.ok(structured.progress.includes(`命令：dsh plugin --profile desktop add ${release.tarballPath}`), '回显停在失败的那条命令上');
  assert.equal(structured.progress.some((line) => line.startsWith('核验：')), false, '失败之后的步骤没有回显');
  // The verdict itself now names the error line of the crash.
  assert.match(structured.result.error.message, /Error: dsh: invalid profile name/u);

  // Without --json the terminal sees the three lines it always saw; the same progress travels beside them.
  // (A second profile: the first run's stand-in already recorded the plugin.)
  const second = writeProfile(tempRoot(t));
  const plainExec = async (bin, args, options) => {
    const result = await fakeExec({ profileDir: second.profileDir }).exec(bin, args, options);
    return args[0] === 'plugin' ? { ...result, code: 1, stdout: '', stderr: CRASH } : result;
  };
  const printed = await runInit({ argv: base, env: { DSH_HOME: join(second.home, '.dsh'), PATH: writeBarePath(root) }, home: second.home, exec: plainExec });
  assert.deepEqual(printed.lines, [`失败：INSTALL_FAILED`, printed.result.error.message, `下一步：${printed.result.error.next}`]);
  assert.deepEqual(printed.progress, structured.progress);
});

test('runInit 同版本幂等：只跑 dump-config，不调用 add', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root, {
    installedVersion: '0.1.0',
    dependencies: { [ENTRY_PACKAGE]: 'file:/old/forge-enterprise-0.1.0.tgz' },
    bundles: [ENTRY_PACKAGE],
  });
  const dshPath = writeDsh(root);
  const { exec, calls } = fakeExec({ profileDir });

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env: { DSH_HOME: join(home, '.dsh') },
    home,
    exec,
  });

  assert.equal(outcome.code, 0);
  assert.equal(outcome.result.status, 'already-installed');
  // 第 24 条 / R5：仅版本相同不能证明是同一制品；没有安装时刻证据时必须如实报"无法确认"。
  assert.equal(outcome.result.artifact.identity, 'unconfirmed');
  assert.ok(outcome.lines.some((line) => line.includes('无法确认') && line.includes('仅版本相同不能证明')));
  assert.ok(outcome.lines.every((line) => !line.includes('逐字节')), '没有安装时刻证据时不得声称逐字节一致');
  assert.ok(outcome.warnings.some((line) => line.includes('无法确认两者是同一制品')));
  assert.deepEqual(calls.map((call) => call.args[0]), ['--profile']);
});

test('runInit 装完但留不下制品证据：结论降级为无法确认，不报假 confirmed（PR #256 复查）', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) };
  // 证据文件的位置被一个目录占住：writeInstallRecord() 必然写得失败并返回 null。
  mkdirSync(join(profileDir, '.heluo-enterprise-install.json'), { recursive: true });

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec: fakeExec({ profileDir }).exec,
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'installed');
  assert.equal(outcome.result.artifact.identity, 'unconfirmed', '没留下证据就不能声称已核对');
  assert.match(outcome.result.artifact.detail, /未能留存安装时刻的制品证据/u);
  assert.ok(outcome.warnings.some((line) => line.includes('未能留存制品证据')));
  assert.ok(outcome.lines.every((line) => !line.includes('制品证据：已记录')), '写不成证据时不得回显已记录');
});

test('runInit 同版本且已安装内容与交付一致：安装时刻证据对齐才报 confirmed', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) };

  const installed = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec: fakeExec({ profileDir }).exec,
  });
  assert.equal(installed.code, 0, JSON.stringify(installed.result));
  assert.equal(installed.result.status, 'installed');
  assert.ok(existsSync(join(profileDir, '.heluo-enterprise-install.json')), '安装成功必须留存安装时刻证据');

  const { exec, calls } = fakeExec({ profileDir });
  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec,
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'already-installed');
  assert.equal(outcome.result.artifact.identity, 'confirmed');
  assert.ok(outcome.lines.some((line) => line.includes('已确认') && line.includes('安装时刻记录')));
  assert.ok(outcome.lines.every((line) => !line.includes('无法确认')));
  assert.deepEqual(calls.map((call) => call.args[0]), ['--profile'], '一致时只读回配置，不重装');
});

test('runInit 同路径被换成新内容、版本不变、已安装仍是旧包：不得报 confirmed', async (t) => {
  const root = tempRoot(t);
  const original = writeRelease(root, { bytes: Buffer.from('old-private-bundle') });
  const { home, profileDir, manifestPath } = writeProfile(root);
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) };

  const installed = await runInit({
    argv: ['--release', original.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec: fakeExec({ profileDir }).exec,
  });
  assert.equal(installed.code, 0, JSON.stringify(installed.result));

  // 管理员把新交付物覆盖到同一路径、版本号不变；node_modules 里仍是旧包。
  const replaced = writeRelease(root, { bytes: Buffer.from('new-private-bundle') });
  assert.equal(replaced.tarballPath, original.tarballPath, '夹具：同一路径');
  assert.notEqual(replaced.metadata.tarball.sha256, original.metadata.tarball.sha256);
  const before = readFileSync(manifestPath, 'utf8');
  const { exec, calls } = fakeExec({ profileDir });

  const outcome = await runInit({
    argv: ['--release', replaced.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec,
  });

  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'ARTIFACT_CONFLICT');
  assert.match(outcome.result.error.message, /同一路径上的文件可能已被替换/u);
  assert.equal(calls.length, 0, '冲突时不得调用宿主');
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('runInit 没有安装时刻证据：file: 路径内容与交付一致也只能报无法确认', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root, {
    installedVersion: '0.1.0',
    dependencies: { [ENTRY_PACKAGE]: `file:${release.tarballPath}` },
    bundles: [ENTRY_PACKAGE],
  });
  const dshPath = writeDsh(root);
  const { exec, calls } = fakeExec({ profileDir });

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env: { DSH_HOME: join(home, '.dsh') },
    home,
    exec,
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'already-installed');
  assert.equal(outcome.result.artifact.identity, 'unconfirmed');
  assert.ok(outcome.lines.some((line) => line.includes('无法确认') && line.includes('安装时刻的制品证据')));
  assert.ok(outcome.lines.every((line) => !line.includes('逐字节')), '没有安装时刻证据时不得声称逐字节一致');
  assert.ok(outcome.warnings.some((line) => line.includes('无法确认两者是同一制品')));
  assert.deepEqual(calls.map((call) => call.args[0]), ['--profile']);
});

test('runInit 安装后已安装文件被改动：报无法确认而不是 confirmed', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir } = writeProfile(root);
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) };

  const installed = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec: fakeExec({ profileDir }).exec,
  });
  assert.equal(installed.code, 0, JSON.stringify(installed.result));

  const installedManifest = join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/'), 'package.json');
  writeFileSync(installedManifest, JSON.stringify({ name: ENTRY_PACKAGE, version: '0.1.0', tampered: true }));
  const { exec } = fakeExec({ profileDir });
  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec,
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.artifact.identity, 'unconfirmed');
  assert.ok(outcome.lines.some((line) => line.includes('已安装包内容与安装时刻记录不一致')));
  assert.ok(outcome.lines.every((line) => !line.includes('逐字节')));
});

test('runInit 同版本但安装时刻记录的是另一份制品：拒绝并提示先 remove，零写入', async (t) => {
  const root = tempRoot(t);
  const other = writeRelease(join(root, 'other'), { bytes: Buffer.from('another-private-bundle') });
  const { home, profileDir, manifestPath } = writeProfile(root);
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) };

  const installed = await runInit({
    argv: ['--release', other.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec: fakeExec({ profileDir }).exec,
  });
  assert.equal(installed.code, 0, JSON.stringify(installed.result));

  const release = writeRelease(root);
  const before = readFileSync(manifestPath, 'utf8');
  const { exec, calls } = fakeExec({ profileDir });
  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec,
  });

  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'ARTIFACT_CONFLICT');
  assert.match(outcome.result.error.next, /remove/u);
  assert.match(outcome.result.error.message, /安装时刻记录的制品摘要/u);
  assert.equal(calls.length, 0, '冲突时不得调用宿主');
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('runInit 显式 desktop：宿主拒绝命令行核验时在写入前拒绝', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, manifestPath } = writeProfile(root, {
    installedVersion: '0.0.9',
    dependencies: { [ENTRY_PACKAGE]: 'file:/old/forge-enterprise-0.0.9.tgz' },
    bundles: [ENTRY_PACKAGE],
  });
  const before = readFileSync(manifestPath, 'utf8');
  const dshPath = writeDsh(root);
  const { exec, calls } = fakeExec({ profileDir, dumpConfigCode: 1 });

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env: { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) },
    home,
    exec,
  });

  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'DESKTOP_PROFILE_UNSUPPORTED');
  assert.equal(calls.length, 1, '只做一次探测，不得执行 plugin remove/add');
  assert.deepEqual(calls[0].args, ['--profile', 'desktop', '--dump-config']);
  assert.ok(calls.every((call) => call.args[0] !== 'plugin'), '不可核验时既不能先装也不能先卸');
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('runInit 异版本：先卸载旧版本再安装本次交付', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, manifestPath } = writeProfile(root, {
    installedVersion: '0.0.9',
    dependencies: { [ENTRY_PACKAGE]: 'file:/old/forge-enterprise-0.0.9.tgz' },
    bundles: [ENTRY_PACKAGE],
  });
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) };
  const { exec, calls } = fakeExec({ profileDir });

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec,
  });

  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.status, 'installed');
  assert.equal(outcome.result.previousVersion, '0.0.9');
  assert.ok(outcome.lines.some((line) => line.includes('与交付版本 0.1.0 不同，先卸载再安装')));
  assert.ok(outcome.lines.some((line) => line.includes('旧版本 0.0.9 已移除')));
  assert.deepEqual(calls.map((call) => call.args[0]), ['--profile', 'plugin', 'plugin', '--profile']);
  assert.deepEqual(calls[1].args, ['plugin', '--profile', 'desktop', 'remove', ENTRY_PACKAGE], '先卸载旧版本');
  assert.deepEqual(calls[2].args.slice(0, 4), ['plugin', '--profile', 'desktop', 'add'], '再安装本次交付');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.dependencies[ENTRY_PACKAGE], `file:${release.tarballPath}`);
  assert.ok(manifest.dsh.profile.bundles.includes(ENTRY_PACKAGE));
  assert.ok(existsSync(join(profileDir, '.heluo-enterprise-install.json')), '重装成功后同样留存制品证据');
});

test('runInit 卸载旧版本失败：停止且不执行安装，profile 原样', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, manifestPath } = writeProfile(root, {
    installedVersion: '0.0.9',
    dependencies: { [ENTRY_PACKAGE]: 'file:/old/forge-enterprise-0.0.9.tgz' },
    bundles: [ENTRY_PACKAGE],
  });
  const dshPath = writeDsh(root);
  const env = { DSH_HOME: join(home, '.dsh'), PATH: writePnpm(root) };
  const before = readFileSync(manifestPath, 'utf8');
  const { exec, calls } = fakeExec({ profileDir, removeCode: 7 });

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec,
  });

  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'UNINSTALL_FAILED');
  assert.match(outcome.result.error.message, /退出码 7/u);
  assert.match(outcome.result.error.next, /本次未执行安装/u);
  assert.equal(calls.some((call) => call.args[3] === 'add'), false, '卸载失败后不得继续安装');
  assert.deepEqual(calls.at(-1).args, ['plugin', '--profile', 'desktop', 'remove', ENTRY_PACKAGE]);
  assert.equal(readFileSync(manifestPath, 'utf8'), before, '卸载失败不得留下半程改动');
});

test('runInit --dry-run 对异版本只打印卸载与安装计划，零 exec', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, manifestPath } = writeProfile(root, {
    installedVersion: '0.0.9',
    dependencies: { [ENTRY_PACKAGE]: 'file:/old/forge-enterprise-0.0.9.tgz' },
    bundles: [ENTRY_PACKAGE],
  });
  const dshPath = writeDsh(root);
  const before = readFileSync(manifestPath, 'utf8');

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath, '--dry-run'],
    env: { DSH_HOME: join(home, '.dsh') },
    home,
    exec: async () => assert.fail('dry-run 不得调用 exec'),
  });

  assert.equal(outcome.code, 0);
  assert.equal(outcome.result.status, 'dry-run');
  assert.equal(outcome.result.previousVersion, '0.0.9');
  assert.ok(outcome.lines.some((line) => line.includes(`remove ${ENTRY_PACKAGE}`)));
  assert.ok(outcome.lines.some((line) => line.includes(`add ${release.tarballPath}`)));
  assert.ok(outcome.lines.some((line) => line.includes('未执行卸载与安装')));
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('runInit dependencies 有包但读不出版本：停止且零写入', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const unknown = writeProfile(root, { dependencies: { [ENTRY_PACKAGE]: 'file:/old/x.tgz' } });
  const dshPath = writeDsh(root);
  const unknownExec = fakeExec({ profileDir: unknown.profileDir });
  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env: { DSH_HOME: join(unknown.home, '.dsh') },
    home: unknown.home,
    exec: unknownExec.exec,
  });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.result.error.code, 'VERSION_UNKNOWN');
  assert.match(outcome.result.error.next, /不在安装状态不明时自动卸载/u);
  assert.equal(unknownExec.calls.length, 0);
});

test('runInit 摘要口径、缺 dsh、安装失败、核验失败各自分类且不写 profile', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home, profileDir, manifestPath } = writeProfile(root);
  const before = readFileSync(manifestPath, 'utf8');
  const env = { DSH_HOME: join(home, '.dsh'), PATH: '' };

  const mismatch = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--sha256', HEX('d')],
    env,
    home,
    exec: async () => assert.fail('不应调用 exec'),
  });
  assert.equal(mismatch.result.error.code, 'DIGEST_MISMATCH');

  const noDsh = await runInit({ argv: ['--release', release.dir, '--profile', 'desktop'], env, home, exec: async () => assert.fail('不应调用 exec') });
  assert.equal(noDsh.result.error.code, 'DSH_MISSING');

  const dshPath = writeDsh(root);
  const installFail = fakeExec({ profileDir, installCode: 1 });
  const c1 = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env: { ...env, PATH: writePnpm(root) },
    home,
    exec: installFail.exec,
  });
  assert.equal(c1.result.error.code, 'INSTALL_FAILED');
  assert.match(c1.result.error.message, /pnpm failed/u, '必须带出宿主自己的失败原因');
  assert.equal(readFileSync(manifestPath, 'utf8'), before);

  const probeOnly = fakeExec({ profileDir });
  const noPnpm = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath],
    env,
    home,
    exec: probeOnly.exec,
  });
  assert.equal(noPnpm.result.error.code, 'PNPM_REQUIRED');
  assert.match(noPnpm.result.error.next, /npm install -g pnpm/u);
  assert.ok(probeOnly.calls.every((call) => call.args[0] !== 'plugin'), '缺 pnpm 时不得尝试 plugin add');
  assert.equal(readFileSync(manifestPath, 'utf8'), before);

  const root2 = tempRoot(t);
  const release2 = writeRelease(root2);
  const second = writeProfile(root2);
  const dshPath2 = writeDsh(root2);
  const verifyFail = fakeExec({ profileDir: second.profileDir, dumpConfig: { includeEntry: false } });
  const c2 = await runInit({
    argv: ['--release', release2.dir, '--profile', 'desktop', '--dsh', dshPath2],
    env: { DSH_HOME: join(second.home, '.dsh'), PATH: writePnpm(root2) },
    home: second.home,
    exec: verifyFail.exec,
  });
  assert.equal(c2.result.error.code, 'VERIFY_FAILED');
});

test('runInit --dry-run 零 exec 并回显命令与核验点', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const { home } = writeProfile(root, { profile: 'web' });
  const dshPath = writeDsh(root);

  const outcome = await runInit({
    argv: ['--release', release.dir, '--profile', 'web', '--dry-run', '--dsh', dshPath],
    env: { DSH_HOME: join(home, '.dsh') },
    home,
    exec: async () => assert.fail('dry-run 不应调用 exec'),
  });

  assert.equal(outcome.code, 0);
  assert.equal(outcome.result.status, 'dry-run');
  assert.equal(outcome.result.mounted, 'unknown');
  assert.deepEqual(outcome.result.command, ['plugin', '--profile', 'web', 'add', release.tarballPath]);
  assert.ok(outcome.lines.some((line) => line.startsWith('命令：dsh plugin --profile web add ')));
  assert.equal(outcome.lines.filter((line) => line.startsWith('核验点：')).length, 3);
  assert.ok(outcome.lines.some((line) => line.includes('未写入 profile')));
});

test('runInit --json 失败只回结构化结论', async () => {
  const outcome = await runInit({ argv: ['--json'], env: {}, home: '/' , exec: null });
  assert.equal(outcome.code, 1);
  assert.deepEqual(outcome.lines, []);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.error.code, 'BAD_ARGUMENT');
  assert.equal(typeof outcome.result.error.next, 'string');
});

test('通过符号链接调用时仍执行入口，而不是静默退出', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forge-init-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, 'init-link.mjs');
  symlinkSync(SCRIPT, link);
  const help = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /用法：node scripts\/init-enterprise-plugin\.mjs/u);
});

test('CLI：--help 退出 0；无参 --json 退出 1 且可解析', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法：node scripts\/init-enterprise-plugin\.mjs/);

  const failed = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  const parsed = JSON.parse(failed.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'BAD_ARGUMENT');
});

function writeSecretBundle(dir, { secret = Buffer.from('corp-secret-value\n'), overrides = {}, skipSecret = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = 'iam-client-secret.txt';
  if (!skipSecret) writeFileSync(join(dir, file), secret);
  const binding = {
    schema: CLIENT_SECRET_SCHEMA,
    file,
    sha256: createHash('sha256').update(secret).digest('hex'),
    discoveryUrl: 'https://iam.corp.example/.well-known/openid-configuration',
    clientId: 'DSH',
    clientAuthMethod: 'client_secret_post',
    clientSecretRef: 'enterprise-oidc',
    ...overrides,
  };
  writeFileSync(join(dir, CLIENT_SECRET_BINDING_FILE), JSON.stringify(binding));
  return { dir, file, binding, secret };
}

test('readEmbeddedClientSecret 核验绑定与摘要，密钥已删除视为已预置', (t) => {
  const root = tempRoot(t);
  const { dir, file, binding, secret } = writeSecretBundle(join(root, 'release'));
  const read = readEmbeddedClientSecret(dir);
  assert.equal(read.path, join(dir, file));
  assert.deepEqual(read.bytes, secret);

  const withoutBinding = join(root, 'without');
  mkdirSync(withoutBinding, { recursive: true });
  assert.throws(() => readEmbeddedClientSecret(withoutBinding), (error) => error.code === 'SECRET_BUNDLE_INCOMPLETE');

  writeFileSync(join(dir, file), 'tampered\n');
  assert.throws(() => readEmbeddedClientSecret(dir), (error) => error.code === 'SECRET_BUNDLE_MISMATCH');

  writeFileSync(join(dir, CLIENT_SECRET_BINDING_FILE), JSON.stringify({ ...binding, file: '../escape.txt' }));
  assert.throws(() => readEmbeddedClientSecret(dir), (error) => error.code === 'SECRET_BUNDLE_INCOMPLETE');

  const removed = writeSecretBundle(join(root, 'removed'), { skipSecret: true });
  assert.equal(readEmbeddedClientSecret(removed.dir).path, null);
});

test('provisionClientSecret 用 Discovery 的 issuer 写入凭据库并删除密钥文件', async (t) => {
  const root = tempRoot(t);
  const { dir, file, secret } = writeSecretBundle(join(root, 'release'));
  const profile = { dir: join(root, 'profile') };
  const cli = join(profile.dir, 'node_modules', ENTRY_PACKAGE, 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '// placeholder\n');
  const release = readPrivateRelease(writeRelease(root, {
    mutate: (metadata) => { metadata.config.secretEmbedded = true; },
  }).dir);
  release.secret = readEmbeddedClientSecret(dir);

  const calls = [];
  const exec = (bin, args, options) => {
    calls.push({ bin, args, options });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const fetchImpl = async (url) => {
    calls.push({ url });
    return { ok: true, status: 200, json: async () => ({ issuer: 'https://iam.corp.example/oidc', token_endpoint_auth_methods_supported: ['client_secret_post'] }) };
  };
  const lines = [];
  const status = await provisionClientSecret({ exec, profile, release, lines, fetchImpl, storeDirectory: join(root, 'store') });
  assert.equal(status.status, 'provisioned');
  const cliCall = calls.find((call) => Array.isArray(call.args));
  assert.equal(cliCall.bin, process.execPath);
  assert.deepEqual(cliCall.args.slice(1, 3), ['client-secret', 'set']);
  assert.equal(cliCall.args[cliCall.args.indexOf('--issuer') + 1], 'https://iam.corp.example/oidc');
  assert.equal(cliCall.args[cliCall.args.indexOf('--method') + 1], 'client_secret_post');
  assert.equal(cliCall.args[cliCall.args.indexOf('--ref') + 1], 'enterprise-oidc');
  assert.deepEqual(cliCall.options.input, secret);
  assert.equal(cliCall.options.env.HELUO_FORGE_STORE_DIRECTORY, join(root, 'store'));
  assert.equal(existsSync(join(dir, file)), false, '预置成功后删除交付目录内的密钥文件');
  assert.match(lines.join('\n'), /已写入本机凭据库/u);
});

test('scriptExec：密钥预置经调用方的执行器运行插件 CLI（args[0] 即脚本路径），不再占用 exec', async (t) => {
  const root = tempRoot(t);
  const { dir, file, secret } = writeSecretBundle(join(root, 'release'));
  const profile = { dir: join(root, 'profile') };
  const cli = join(profile.dir, 'node_modules', ENTRY_PACKAGE, 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '// placeholder\n');
  const release = readPrivateRelease(writeRelease(root, {
    mutate: (metadata) => { metadata.config.secretEmbedded = true; },
  }).dir);
  release.secret = readEmbeddedClientSecret(dir);

  const scriptCalls = [];
  const execCalls = [];
  const scriptExec = (args, options) => {
    scriptCalls.push({ args, options });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const exec = (bin, args, options) => {
    execCalls.push({ bin, args, options });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://iam.corp.example/oidc', token_endpoint_auth_methods_supported: ['client_secret_post'] }) });
  const lines = [];
  const status = await provisionClientSecret({ scriptExec, exec, profile, release, lines, fetchImpl, storeDirectory: join(root, 'store') });

  assert.equal(status.status, 'provisioned');
  // 桌面壳的契约：插件 CLI 的路径是第一条参数，前面没有 dsh 的入口，也没有 profile 名。
  assert.equal(scriptCalls.length, 1);
  assert.equal(scriptCalls[0].args[0], cli);
  assert.deepEqual(scriptCalls[0].args.slice(1, 3), ['client-secret', 'set']);
  assert.equal(scriptCalls[0].args[scriptCalls[0].args.indexOf('--issuer') + 1], 'https://iam.corp.example/oidc');
  assert.deepEqual(scriptCalls[0].options.input, secret);
  assert.equal(scriptCalls[0].options.env.HELUO_FORGE_STORE_DIRECTORY, join(root, 'store'));
  // exec 只留给 dsh 的命令：密钥预置不再占用它，壳的执行器也就不会给 CLI 加 dsh 入口。
  assert.equal(execCalls.length, 0);
  assert.equal(existsSync(join(dir, file)), false);

  // 缺省（终端形态）行为不变：不传 scriptExec 时以 exec 运行 process.execPath + 脚本路径。
  const again = writeSecretBundle(join(root, 'release-again'));
  const defaulted = await provisionClientSecret({
    exec: async (bin, args) => {
      assert.equal(bin, process.execPath, '缺省形态以当前 Node 运行插件 CLI');
      assert.equal(args[0], cli);
      return { code: 0, stdout: '', stderr: '' };
    },
    profile,
    release: { secret: readEmbeddedClientSecret(again.dir) },
    lines,
    fetchImpl,
    storeDirectory: join(root, 'store'),
  });
  assert.equal(defaulted.status, 'provisioned');
  assert.equal(existsSync(join(again.dir, again.file)), false);

  // 非 scriptExec 非函数：直接给出可读的拒绝，而不是跑到一半才 TypeError。
  for (const invalid of [42, 'function', null]) {
    await assert.rejects(
      provisionClientSecret({ scriptExec: invalid, exec, profile, release, lines: [], fetchImpl, storeDirectory: join(root, 'store') }),
      (error) => error.code === 'BAD_ARGUMENT' && /scriptExec/u.test(error.message),
    );
  }
  const refused = await runInit({ argv: ['--release', release.dir, '--profile', 'web'], scriptExec: 42, env: {}, home: join(root, 'home') });
  assert.equal(refused.code, 1);
  assert.equal(refused.result.error.code, 'BAD_ARGUMENT');
  assert.match(refused.result.error.message, /scriptExec/u);
});

test('readEmbeddedClientSecret 校验 previousIssuers 只接受 http(s) URL 数组', (t) => {
  const root = tempRoot(t);
  const ok = writeSecretBundle(join(root, 'ok'), { overrides: { previousIssuers: ['http://old-iam.corp.example/oidc'] } });
  assert.deepEqual(readEmbeddedClientSecret(ok.dir).binding.previousIssuers, ['http://old-iam.corp.example/oidc']);

  const notArray = writeSecretBundle(join(root, 'not-array'), { overrides: { previousIssuers: 'http://old-iam.corp.example/oidc' } });
  assert.throws(() => readEmbeddedClientSecret(notArray.dir), (error) => error.code === 'SECRET_BUNDLE_INCOMPLETE');
  const badScheme = writeSecretBundle(join(root, 'bad-scheme'), { overrides: { previousIssuers: ['file:///etc/passwd'] } });
  assert.throws(() => readEmbeddedClientSecret(badScheme.dir), (error) => error.code === 'SECRET_BUNDLE_INCOMPLETE');
  // 拼出来避免扫描器把它当真实带口令 URL；运行时仍是同一条字符串。
  const credentialed = ['https://', 'user', ':', 'pw', '@', 'iam.corp.example/oidc'].join('');
  const withCredentials = writeSecretBundle(join(root, 'cred'), { overrides: { previousIssuers: [credentialed] } });
  assert.throws(() => readEmbeddedClientSecret(withCredentials.dir), (error) => error.code === 'SECRET_BUNDLE_INCOMPLETE');
});

function secretProfile(root) {
  const { dir, file, secret } = writeSecretBundle(join(root, 'release'));
  const profile = { dir: join(root, 'profile') };
  const cli = join(profile.dir, 'node_modules', ENTRY_PACKAGE, 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '// placeholder\n');
  return { dir, file, secret, profile };
}

test('凭据绑定冲突时，安装器用 previousIssuers 逐个 replace 更正，不要求每台机器手工处理', async (t) => {
  const root = tempRoot(t);
  const { dir, file, secret, profile } = secretProfile(root);
  mkdirSync(join(root, 'release'), { recursive: true });
  writeSecretBundle(join(root, 'release'), { overrides: { previousIssuers: ['https://old.corp.example/oidc'] } });
  const release = { secret: readEmbeddedClientSecret(join(root, 'release')) };
  assert.deepEqual(release.secret.binding.previousIssuers, ['https://old.corp.example/oidc']);

  const calls = [];
  const exec = (bin, args, options) => {
    calls.push({ bin, args, options });
    // set 因旧绑定被库拒绝（CLI 折叠成退出码 4）；replace 用候选旧 issuer 成功。
    const replacing = args.includes('replace');
    return Promise.resolve(replacing
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 4, stdout: '', stderr: 'IAM_CLIENT_SECRET_BINDING_MISMATCH: 该凭据引用已绑定其他 IAM 客户端配置' });
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://iam.corp.example/oidc', token_endpoint_auth_methods_supported: ['client_secret_post'] }) });
  const lines = [];
  const status = await provisionClientSecret({ exec, profile, release, lines, fetchImpl, storeDirectory: join(root, 'store') });

  assert.equal(status.status, 'provisioned');
  assert.equal(status.reboundFrom, 'https://old.corp.example/oidc');
  const replace = calls.find((call) => Array.isArray(call.args) && call.args.includes('replace'));
  assert.equal(replace.args[replace.args.indexOf('--issuer') + 1], 'https://iam.corp.example/oidc');
  assert.equal(replace.args[replace.args.indexOf('--old-issuer') + 1], 'https://old.corp.example/oidc');
  assert.equal(replace.args[replace.args.indexOf('--old-client-id') + 1], 'DSH');
  assert.equal(replace.args[replace.args.indexOf('--old-method') + 1], 'client_secret_post');
  assert.equal(replace.args[replace.args.indexOf('--ref') + 1], 'enterprise-oidc');
  assert.deepEqual(replace.options.input, secret, 'replace 同样从 stdin 送密钥，不走参数');
  assert.equal(existsSync(join(dir, file)), false, '更正成功后删除交付目录内的密钥文件');
  assert.match(lines.join('\n'), /原先绑定 https:\/\/old\.corp\.example\/oidc，已更正为 https:\/\/iam\.corp\.example\/oidc/u);
});

test('所有候选旧 issuer 都更正失败时报 BINDING_CONFLICT，并保留密钥文件', async (t) => {
  const root = tempRoot(t);
  const { dir, file, profile } = secretProfile(root);
  mkdirSync(join(root, 'release'), { recursive: true });
  writeSecretBundle(join(root, 'release'), { overrides: { previousIssuers: ['https://stale.corp.example/oidc'] } });
  const release = { secret: readEmbeddedClientSecret(join(root, 'release')) };

  const exec = () => Promise.resolve({ code: 4, stdout: '', stderr: 'IAM_CLIENT_SECRET_BINDING_MISMATCH: 该凭据引用已绑定其他 IAM 客户端配置' });
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://iam.corp.example/oidc' }) });
  await assert.rejects(
    provisionClientSecret({ exec, profile, release, lines: [], fetchImpl, storeDirectory: join(root, 'store') }),
    (error) => error.code === 'IAM_CLIENT_SECRET_BINDING_CONFLICT'
      && /stale/u.test(error.message)
      && /https:\/\/iam\.corp\.example\/oidc/u.test(String(error.next ?? ''))
      && /client-secret replace --old-issuer/u.test(String(error.next ?? '')),
  );
  assert.equal(existsSync(join(dir, file)), true, '未更正成功时保留密钥文件，便于修好绑定后重跑');
});

test('provisionClientSecret 失败时保留密钥文件，且不静默降级', async (t) => {
  const root = tempRoot(t);
  const { dir, file } = writeSecretBundle(join(root, 'release'));
  const profile = { dir: join(root, 'profile') };
  const cli = join(profile.dir, 'node_modules', ENTRY_PACKAGE, 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '// placeholder\n');
  const release = { secret: readEmbeddedClientSecret(dir) };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://iam.corp.example/oidc' }) });

  await assert.rejects(
    provisionClientSecret({ exec: async () => ({ code: 2, stdout: '', stderr: 'CRED_STORE_INVALID: store is read-only' }), profile, release, lines: [], fetchImpl, storeDirectory: join(root, 'store') }),
    (error) => error.code === 'IAM_CLIENT_SECRET_PROVISION_FAILED' && /CRED_STORE_INVALID/u.test(error.message),
  );
  assert.equal(existsSync(join(dir, file)), true, '失败时保留密钥文件以便重跑');

  await assert.rejects(
    provisionClientSecret({ exec: async () => ({ code: 0 }), profile, release, lines: [], fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://iam.corp.example/oidc', token_endpoint_auth_methods_supported: ['client_secret_basic'] }) }), storeDirectory: join(root, 'store') }),
    (error) => error.code === 'IAM_CLIENT_AUTH_METHOD_UNSUPPORTED',
  );

  await assert.rejects(
    provisionClientSecret({ exec: async () => ({ code: 0 }), profile, release, lines: [], fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), storeDirectory: join(root, 'store') }),
    (error) => error.code === 'IAM_DISCOVERY_FAILED',
  );
});

test('credentialStoreDirectory 与凭据库同规则，probeStoreDirectory 用空文件探针', (t) => {
  const root = tempRoot(t);
  const host = '/srv/people/a';
  assert.equal(
    credentialStoreDirectory({ platform: 'darwin', home: host, env: {} }),
    join(host, 'Library', 'Application Support', 'HeluoForge'),
  );
  // win32 分支的路径拼接依赖宿主 path 模块：posix 上 join 会把盘符当普通段，故只断言后缀。
  const windows = credentialStoreDirectory({ platform: 'win32', home: 'D:\\people\\a', env: { LOCALAPPDATA: 'D:\\people\\a\\AppData\\Local' } });
  assert.equal(windows.endsWith('AppData/Local/HeluoForge'), true);
  const fallback = credentialStoreDirectory({ platform: 'win32', home: 'D:\\people\\a', env: { LOCALAPPDATA: 'relative\\Local' } });
  assert.equal(fallback.startsWith('D:\\people\\a'), true);
  assert.equal(fallback.endsWith('/AppData/Local/HeluoForge'), true);
  assert.equal(
    credentialStoreDirectory({ platform: 'linux', home: host, env: {} }),
    join(host, '.local', 'share', 'HeluoForge'),
  );
  assert.equal(
    credentialStoreDirectory({ platform: 'linux', home: host, env: { XDG_DATA_HOME: '/srv/xdg' } }),
    '/srv/xdg/HeluoForge',
  );

  const dir = join(root, 'store');
  assert.equal(probeStoreDirectory(dir), dir);
  assert.deepEqual(readdirSync(dir), [], '探针文件用完即删');
});

test('ensureStoreDirectory 收紧已存在目录的权限，并拒绝非目录占用', (t) => {
  const root = tempRoot(t);
  const dir = join(root, 'store');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  const lines = [];
  assert.equal(ensureStoreDirectory(dir, { lines }), dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700, '宽松目录被收紧为 0700');
  assert.match(lines.join('\n'), /已修正为 700/u);

  const keys = join(root, 'keys');
  mkdirSync(keys, { mode: 0o755 });
  chmodSync(keys, 0o755);
  ensureStoreDirectory(keys);
  assert.equal(statSync(keys).mode & 0o777, 0o700, `<dir>.keys 同样收紧`);

  const blocked = join(root, 'blocked');
  mkdirSync(blocked, { mode: 0o700 });
  writeFileSync(`${blocked}.keys`, 'not a directory');
  assert.throws(() => ensureStoreDirectory(blocked), (error) => error.code === 'IAM_SECRET_STORE_UNWRITABLE');
});

test('ensureStoreDirectory 识别只剩一半的凭据库，给出可执行修复提示', (t) => {
  const root = tempRoot(t);
  const dir = join(root, 'half');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'credentials.sqlite'), '', { mode: 0o600 });
  assert.throws(
    () => ensureStoreDirectory(dir),
    (error) => error.code === 'IAM_SECRET_STORE_ORPHANED' && error.message.includes(`${dir}.keys`),
  );

  const orphan = join(root, 'orphan');
  mkdirSync(`${orphan}.keys`, { recursive: true, mode: 0o700 });
  writeFileSync(join(`${orphan}.keys`, 'keyring.json'), '{}', { mode: 0o600 });
  assert.throws(
    () => ensureStoreDirectory(orphan),
    (error) => error.code === 'IAM_SECRET_STORE_ORPHANED' && error.message.includes(`${orphan}.keys`) && error.message.includes(`缺 ${orphan}`),
  );
});

test('凭据目录不可写时给出 IAM_SECRET_STORE_UNWRITABLE，而不是笼统的预置失败', async (t) => {
  const root = tempRoot(t);
  const { dir } = writeSecretBundle(join(root, 'release'));
  const profile = { dir: join(root, 'profile') };
  const cli = join(profile.dir, 'node_modules', ENTRY_PACKAGE, 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '// placeholder\n');
  const release = { secret: readEmbeddedClientSecret(dir) };
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'not a directory');

  await assert.rejects(
    provisionClientSecret({
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      profile,
      release,
      lines: [],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://iam.corp.example/oidc' }) }),
      storeDirectory: join(blocked, 'HeluoForge'),
    }),
    (error) => error.code === 'IAM_SECRET_STORE_UNWRITABLE' && error.message.includes(join(blocked, 'HeluoForge')),
  );
});

test('既有存储不可用时用空目录诊断区分 IAM_SECRET_STORE_UNHEALTHY', async (t) => {
  const root = tempRoot(t);
  const { dir, file } = writeSecretBundle(join(root, 'release'));
  const profile = { dir: join(root, 'profile') };
  const cli = join(profile.dir, 'node_modules', ENTRY_PACKAGE, 'node_modules', '@heluo', 'forge-iam', 'bin', 'heluo-forge.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '// placeholder\n');
  const release = { secret: readEmbeddedClientSecret(dir) };
  const seen = [];
  const exec = (bin, args, options) => {
    seen.push(options);
    const scratch = options?.env?.HELUO_FORGE_STORE_DIRECTORY;
    const isDiagnostic = typeof scratch === 'string' && scratch.includes('heluo-secret-probe-');
    return Promise.resolve(!isDiagnostic
      ? { code: 4, stdout: '', stderr: 'IAM_CLIENT_SECRET_PROVISION_FAILED: 无法预置密钥，请核对输入、客户端登记与凭据存储' }
      : { code: 0, stdout: '已预置 IAM 客户端密钥。', stderr: '' });
  };

  await assert.rejects(
    provisionClientSecret({
      exec,
      profile,
      release,
      lines: [],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://old-iam.corp.example/oidc' }) }),
      storeDirectory: join(root, 'store'),
    }),
    (error) => error.code === 'IAM_SECRET_STORE_UNHEALTHY'
      && error.message.includes(join(root, 'store'))
      && /已绑定过另一套客户端配置/u.test(error.message),
  );
  assert.equal(seen.length, 2, '失败后追加一次临时目录诊断');
  assert.equal(existsSync(join(dir, file)), true, '诊断不删除交付目录里的密钥文件');
  assert.equal(seen[1].env.HELUO_FORGE_STORE_DIRECTORY.startsWith(tmpdir()), true, '诊断使用系统临时目录');
});

test('parseArgs 接受自定义 profile 名（如 uat），拒绝越界名与保留字', () => {
  for (const name of ['uat', 'uat-2', 'qa1', 'sdk', 'web', 'auto']) {
    assert.equal(parseArgs(['--release', '/tmp/release', '--profile', name]).profile, name);
  }
  for (const name of ['../evil', 'Uat', 'a/b', '-x', 'auto!']) {
    assert.throws(
      () => parseArgs(['--release', '/tmp/release', '--profile', name]),
      (error) => {
        assert.equal(error instanceof InitError, true);
        assert.equal(error.code, 'PROFILE_INVALID', `${JSON.stringify(name)} 期望 PROFILE_INVALID，实际 ${error.code}`);
        return true;
      },
    );
  }
});

test('runInit --profile uat 从 web 模板创建自定义 profile 后安装并给出启动命令', async (t) => {
  const root = tempRoot(t);
  const { dir, tarballPath } = writeRelease(root);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const dshPath = join(bin, 'dsh');
  writeFileSync(dshPath, '#!/bin/sh\nexit 0\n');
  chmodSync(dshPath, 0o755);
  const dshHome = join(root, 'dsh');
  const profileDir = join(dshHome, 'profiles', 'uat');
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'plugin') {
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [ENTRY_PACKAGE]: `file:${args[4]}` };
      manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-web-app', ENTRY_PACKAGE] } };
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest));
      const installed = join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/'));
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: ENTRY_PACKAGE, version: '0.1.0' }));
      return { code: 0, stdout: 'added', stderr: '' };
    }
    if (!existsSync(join(profileDir, 'package.json'))) {
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-uat',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
        dependencies: {},
      }));
    }
    return {
      code: 0,
      stdout: existsSync(join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/')))
        ? JSON.stringify({ plugins: [{ name: ENTRY_PACKAGE }] })
        : '{}',
      stderr: '',
    };
  };
  const outcome = await runInit({
    argv: ['--release', dir, '--profile', 'uat', '--dsh', dshPath],
    env: { PATH: writePnpm(root), DSH_HOME: dshHome },
    home: join(root, 'home'),
    exec,
  });
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.profile, 'uat');
  assert.equal(outcome.result.verified.dumpConfig, true);
  assert.ok(
    calls.some((call) => call.args.join(' ') === '--profile uat --from-default-profile web --dump-config'),
    '自定义 profile 必须由宿主从 shipped web 模板创建，而不是复用 web',
  );
  assert.ok(calls.some((call) => call.args.join(' ') === `plugin --profile uat add ${tarballPath}`));
  assert.match(outcome.lines.join('\n'), /dsh --profile uat/, '启动提示要给出自定义 profile 的启动命令');
  assert.doesNotMatch(outcome.lines.join('\n'), /终端运行 dsh web（/, '自定义 profile 不能提示 dsh web');
});
