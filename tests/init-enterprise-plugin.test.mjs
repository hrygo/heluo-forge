import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_HOST_VERSION,
  ENTRY_PACKAGE,
  InitError,
  METADATA_FILE,
  PROFILE_NAMES,
  RELEASE_SCHEMA,
  dshHomeOf,
  inspectProfile,
  locateDsh,
  locateDshLaunch,
  locateNpmLaunch,
  parseArgs,
  readPrivateRelease,
  resolveDshLaunch,
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

/** 注入的 exec：install 时真实改写 profile（模拟宿主 reconcile），dump-config 返回合成树。 */
function fakeExec({
  profileDir,
  version = '0.1.0',
  installCode = 0,
  dumpConfig = { includeEntry: true },
  dumpConfigCode = 0,
  dumpConfigStderr = 'profile "desktop" is managed exclusively by the Electron application',
} = {}) {
  const calls = [];
  const exec = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[0] === 'plugin') {
      if (installCode !== 0) return { code: installCode, stdout: '', stderr: 'pnpm failed' };
      const manifestPath = join(profileDir, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [ENTRY_PACKAGE]: `file:${args[4]}` };
      manifest.dsh = manifest.dsh ?? {};
      manifest.dsh.profile = manifest.dsh.profile ?? {};
      manifest.dsh.profile.bundles = [...new Set([...(manifest.dsh.profile.bundles ?? []), ENTRY_PACKAGE])];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const installed = join(profileDir, 'node_modules', ...ENTRY_PACKAGE.split('/'));
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
    { argv: ['--release', '/r', '--profile', 'sdk'], code: 'PROFILE_INVALID' },
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
    { label: 'secret', mutate: (meta) => { meta.config.secretEmbedded = true; }, code: 'SECRET_EMBEDDED' },
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
  assert.throws(() => inspectProfile({ profile: 'sdk', env: {}, home: root }), (error) => error.code === 'PROFILE_INVALID');

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
  const { home, profileDir, manifestPath } = writeProfile(root);
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
  assert.equal(calls.length, 1, '只做一次探测，不得执行 plugin add');
  assert.deepEqual(calls[0].args, ['--profile', 'desktop', '--dump-config']);
  assert.ok(calls.every((call) => call.args[0] !== 'plugin'), '不可核验时不能留下"已安装却报失败"');
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('runInit 异版本停止且零写入；dependencies 有包但读不出版本同样停止', async (t) => {
  const root = tempRoot(t);
  const release = writeRelease(root);
  const conflict = writeProfile(root, {
    installedVersion: '0.0.9',
    dependencies: { [ENTRY_PACKAGE]: 'file:/old/forge-enterprise-0.0.9.tgz' },
    bundles: [ENTRY_PACKAGE],
  });
  const dshPath1 = writeDsh(root);
  const conflicting = fakeExec({ profileDir: conflict.profileDir });
  const c1 = await runInit({
    argv: ['--release', release.dir, '--profile', 'desktop', '--dsh', dshPath1],
    env: { DSH_HOME: join(conflict.home, '.dsh') },
    home: conflict.home,
    exec: conflicting.exec,
  });
  assert.equal(c1.code, 1);
  assert.equal(c1.result.error.code, 'VERSION_CONFLICT');
  assert.equal(conflicting.calls.length, 0);

  const root2 = tempRoot(t);
  const release2 = writeRelease(root2);
  const unknown = writeProfile(root2, { dependencies: { [ENTRY_PACKAGE]: 'file:/old/x.tgz' } });
  const dshPath2 = writeDsh(root2);
  const unknownExec = fakeExec({ profileDir: unknown.profileDir });
  const c2 = await runInit({
    argv: ['--release', release2.dir, '--profile', 'desktop', '--dsh', dshPath2],
    env: { DSH_HOME: join(unknown.home, '.dsh') },
    home: unknown.home,
    exec: unknownExec.exec,
  });
  assert.equal(c2.result.error.code, 'VERSION_UNKNOWN');
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
