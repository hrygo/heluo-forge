import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ENTRY_PACKAGE,
  InitError,
  METADATA_FILE,
  PROFILE_NAMES,
  RELEASE_SCHEMA,
  dshHomeOf,
  inspectProfile,
  locateDsh,
  locateDshLaunch,
  parseArgs,
  readPrivateRelease,
  resolveDshLaunch,
  runInit,
  sha256File,
  shimEntryOf,
} from '../scripts/init-enterprise-plugin.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/init-enterprise-plugin.mjs', import.meta.url));
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

/** 注入的 exec：install 时真实改写 profile（模拟宿主 reconcile），dump-config 返回合成树。 */
function fakeExec({ profileDir, version = '0.1.0', installCode = 0, dumpConfig = { includeEntry: true } } = {}) {
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
  assert.ok(calls.some((call) => call.command === npm && call.args.includes('@deepseek-ai/dsh@0.2.1-rc.5')));
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
    env: { DSH_HOME: join(home, '.dsh') },
    home,
    exec,
  });

  assert.equal(outcome.code, 0);
  assert.equal(outcome.result.status, 'installed');
  assert.equal(outcome.result.mounted, 'unknown');
  assert.deepEqual(outcome.result.verified, { exitCode: 0, dumpConfig: true, profileAligned: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].bin, dshPath);
  assert.deepEqual(calls[0].args, ['plugin', '--profile', 'desktop', 'add', release.tarballPath]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[1].args, ['--profile', 'desktop', '--dump-config']);
  assert.equal(calls[1].options.shell, false);
  assert.ok(outcome.lines.some((line) => line.includes('mounted=unknown')));
  assert.ok(outcome.lines.every((line) => !line.includes('secret')));
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
  assert.deepEqual(calls.map((call) => call.args[0]), ['--profile']);
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
    env,
    home,
    exec: installFail.exec,
  });
  assert.equal(c1.result.error.code, 'INSTALL_FAILED');
  assert.equal(readFileSync(manifestPath, 'utf8'), before);

  const root2 = tempRoot(t);
  const release2 = writeRelease(root2);
  const second = writeProfile(root2);
  const dshPath2 = writeDsh(root2);
  const verifyFail = fakeExec({ profileDir: second.profileDir, dumpConfig: { includeEntry: false } });
  const c2 = await runInit({
    argv: ['--release', release2.dir, '--profile', 'desktop', '--dsh', dshPath2],
    env: { DSH_HOME: join(second.home, '.dsh'), PATH: '' },
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
