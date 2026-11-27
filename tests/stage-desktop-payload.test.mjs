/**
 * Staging tool tests (CORP-DSH-PLAN-026 §4.3-2).
 *
 * The staged layout is a contract with `services/forge-desktop/src/layout.mjs`:
 * these tests import the very constants `main.mjs` consumes, so a change on
 * either side of the contract fails here instead of in a packaged app.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ASSETS_DIR, DSH_ENTRY_PARTS, STATUS_PAGE_PARTS, TITLE_BAR_PARTS, TRAY_ICON_PARTS } from '../services/forge-desktop/src/layout.mjs';
import { dedupeDshClosure, inspectDshClosure, parseArguments, pruneForeignPrebuilds, StageError, stagePayload, unpackPnpm } from '../scripts/stage-desktop-payload.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(REPO_ROOT, 'docs', 'assets', 'branding', 'cyber-long');
const LOCK_PATH = join(REPO_ROOT, 'services', 'forge-desktop', 'runtime-lock.json');

const POSIX = process.platform !== 'win32';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (code) => (error) => error instanceof StageError && error.code === code;

function temp(t, prefix = 'forge-stage-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Archive a directory tree under one root name, the way the registry stores a
 * package. macOS `tar` would add `._` AppleDouble entries for copied files;
 * registry tarballs carry none, so they are kept out of the fixture.
 */
function archive(source, root, tgz) {
  const staged = mkdtempSync(join(dirname(tgz), 'reroot-'));
  execFileSync('cp', ['-R', source, join(staged, root)], { stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync('tar', ['-czf', tgz, '-C', staged, root], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  rmSync(staged, { recursive: true, force: true });
  const bytes = readFileSync(tgz);
  return { tgz, bytes, sha256: sha256(bytes) };
}

/** A minimal dsh tarball: the registry layout `package/` with `lib/bin.js`. */
function fixtureTgz(root) {
  const source = join(root, 'dsh-artifact');
  mkdirSync(join(source, 'lib'), { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' })}\n`);
  writeFileSync(join(source, 'lib', 'bin.js'), 'void 0;\n');
  return archive(source, 'package', join(root, 'dsh-test.tgz'));
}

let fixtures = 0;

/** A minimal pnpm tarball: `package.json` and the `bin/pnpm.mjs` the shell runs. Each call builds a fresh tree. */
function fixturePnpm(root, { version = '11.28.5-test', name = 'pnpm', entry = true, archiveRoot = 'package', executable = false } = {}) {
  fixtures += 1;
  const source = join(root, `pnpm-artifact-${fixtures}`);
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'dist', 'nested'), { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  if (entry) {
    writeFileSync(join(source, 'bin', 'pnpm.mjs'), "console.log('pnpm');\n");
    if (executable) chmodSync(join(source, 'bin', 'pnpm.mjs'), 0o755);
  }
  writeFileSync(join(source, 'dist', 'nested', 'payload.mjs'), 'void 0;\n');
  return archive(source, archiveRoot, join(root, `pnpm-test-${fixtures}.tgz`));
}

/** A stand-in for npm install: the registry layout a closure install produces. */
function fakeInstaller() {
  return (tgz, dest) => {
    const moduleDir = join(dest, 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(moduleDir, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', moduleDir, '--strip-components', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  };
}

/** Arguments for one staging run of `root`'s output; the ledger is written separately. */
function stageArgs(root, dsh) {
  return {
    output: join(root, 'out'),
    dshTgz: dsh.tgz,
    brandDir: BRAND_DIR,
    lockPath: join(root, 'runtime-lock.json'),
    repoRoot: REPO_ROOT,
    installer: fakeInstaller(),
  };
}

/** A ledger naming the dsh fixture, with any dsh field to vary. */
function ledger(dsh, { dsh: varied = {} } = {}) {
  return {
    schema: 'heluo-desktop-runtime-lock/1',
    dsh: { version: '0.0.0-test', sha256: dsh.sha256, bytes: dsh.bytes.length, ...varied },
  };
}

/** Stage the dsh fixture against a ledger written to disk: the matching row, with any field to vary. */
function stageWith(root, dsh, { dsh: variedDsh = {} } = {}) {
  const args = stageArgs(root, dsh);
  writeFileSync(args.lockPath, `${JSON.stringify(ledger(dsh, { dsh: variedDsh }), null, 2)}\n`);
  return stagePayload(args);
}

test('暂存布局与 layout.mjs 双向契约：dsh 入口与托盘图标落在 main.mjs 读取的路径，pnpm 只随内置运行时一份', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const record = stageWith(root, artifact);
  const resources = join(root, 'out', 'resources');
  assert.equal(existsSync(join(resources, ...DSH_ENTRY_PARTS)), true, 'dsh entry must sit exactly where main.mjs reads it');
  assert.equal(readFileSync(join(resources, ...DSH_ENTRY_PARTS.slice(0, -2), 'lib', 'bin.js')).toString(), 'void 0;\n', 'artifact bytes unpack verbatim');
  assert.equal(existsSync(join(resources, ...TRAY_ICON_PARTS)), true, 'tray icon must sit exactly where main.mjs reads it');
  assert.equal(
    readFileSync(join(resources, ...TRAY_ICON_PARTS)).equals(readFileSync(join(BRAND_DIR, 'sizes/app-icon-256.png'))),
    true,
    'tray icon is byte-identical to the brand source',
  );
  assert.equal(existsSync(join(resources, ...STATUS_PAGE_PARTS)), true, 'the setup page must sit beside the tray icon');
  assert.equal(
    readFileSync(join(resources, ...STATUS_PAGE_PARTS)).equals(readFileSync(join(REPO_ROOT, 'services/forge-desktop/resources/status.html'))),
    true,
    'the setup page is byte-identical to the shell source',
  );
  // The title bar sits beside them, where main.mjs opens it: a window without it has no controls.
  assert.equal(existsSync(join(resources, ...TITLE_BAR_PARTS)), true, 'the title bar must sit where main.mjs reads it');
  assert.equal(
    readFileSync(join(resources, ...TITLE_BAR_PARTS)).equals(readFileSync(join(REPO_ROOT, 'services/forge-desktop/resources/titlebar.html'))),
    true,
    'the title bar is byte-identical to the shell source',
  );
  assert.equal(record.titleBar.source, TITLE_BAR_PARTS.join('/'));
  assert.equal(record.dsh.version, '0.0.0-test');
  assert.equal(record.assets, null);
  // The pnpm the package operations run is the bundled runtime's one copy:
  // this stager unpacks none, so nothing sits at the place the old one did.
  assert.equal(existsSync(join(resources, 'pnpm')), false, 'no pnpm of its own is staged here');
  assert.equal(record.pnpm, undefined);
  assert.equal(record.layout.pnpmEntry, undefined);
});

test('反向：仓库缺标题栏页面即拒绝暂存，不发布台账', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  // A checkout with the setup page but without the title bar: the shell would open a window nothing can be closed from.
  const bare = temp(t, 'forge-stage-nobar-');
  const pages = ['services', 'forge-desktop', 'resources', ...STATUS_PAGE_PARTS.slice(1)];
  mkdirSync(join(bare, ...pages.slice(0, -1)), { recursive: true });
  writeFileSync(join(bare, ...pages), readFileSync(join(REPO_ROOT, ...pages)));
  const valid = stageArgs(root, artifact);
  writeFileSync(valid.lockPath, `${JSON.stringify(ledger(artifact), null, 2)}\n`);
  assert.throws(() => stagePayload({ ...valid, repoRoot: bare }), refused('TITLE_BAR_MISSING'));
  assert.equal(existsSync(join(valid.output, 'staging-manifest.json')), false);
});

test('员工资产目录按 ASSETS_DIR 暂存', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const assets = join(root, 'employee');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'employee-manifest.json'), '{}\n');
  const args = { ...stageArgs(root, artifact), employeeAssets: assets };
  writeFileSync(args.lockPath, `${JSON.stringify(ledger(artifact))}\n`);
  const record = stagePayload(args);
  assert.equal(existsSync(join(root, 'out', 'resources', ASSETS_DIR, 'employee-manifest.json')), true);
  assert.equal(record.assets, ASSETS_DIR);
});

test('反向：dsh 的摘要、字节数与台账不符即拒绝，且不动已有输出（fail-closed）', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  mkdirSync(join(root, 'out', 'resources'), { recursive: true });
  writeFileSync(join(root, 'out', 'resources', 'leftover.txt'), 'previous run\n');

  assert.throws(() => stageWith(root, artifact, { dsh: { sha256: '0'.repeat(64) } }), refused('STAGE_DIGEST_MISMATCH'));
  assert.throws(() => stageWith(root, artifact, { dsh: { bytes: artifact.bytes.length + 1 } }), refused('STAGE_DIGEST_MISMATCH'));

  // Nothing of a refused run reaches the output: the previous content is still there, untouched.
  assert.equal(readFileSync(join(root, 'out', 'resources', 'leftover.txt')).toString(), 'previous run\n');
  assert.equal(existsSync(join(root, 'out', 'staging-manifest.json')), false);
});

test('反向：本暂存器不再接 pnpm 制品——参数解析把 pnpm 的交接留给载荷暂存器', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const brandless = temp(t, 'forge-stage-nobrand-');
  // Artifacts are verified before the brand is looked at, so the ledger on disk is a valid one.
  const valid = stageArgs(root, artifact);
  writeFileSync(valid.lockPath, `${JSON.stringify(ledger(artifact), null, 2)}\n`);
  assert.throws(() => stagePayload({ ...valid, output: join(brandless, 'out'), brandDir: join(brandless, 'no-brand') }), (error) => error.code === 'BRAND_MISSING');
  // The one artifact this stager refuses is dsh; a pnpm tarball is no longer part of its handover.
  assert.throws(
    () => stagePayload({ ...valid, output: join(root, 'b'), dshTgz: join(root, 'missing.tgz') }),
    (error) => error.code === 'DSH_TGZ_MISSING',
  );
  assert.throws(() => parseArguments(['--output', 'x', '--mystery']), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => parseArguments(['--dsh-tgz', 'x.tgz']), (error) => error.code === 'BAD_ARGUMENT');
  // The pnpm artifact belongs to the bundled runtime's stager, not this one.
  assert.throws(() => parseArguments(['--output', 'x', '--dsh-tgz', 'x.tgz', '--pnpm-tgz', 'p.tgz']), (error) => error.code === 'BAD_ARGUMENT' && /unknown argument --pnpm-tgz/.test(error.message));
  assert.deepEqual(parseArguments(['--output', 'x', '--dsh-tgz', 'x.tgz', '--target', 'win-x64', '--max-dsh-bytes', '1024', '--max-dsh-files', '50', '--json']), {
    output: 'x',
    dshTgz: 'x.tgz',
    target: 'win-x64',
    brandDir: undefined,
    employeeAssets: undefined,
    lock: undefined,
    maxDshBytes: 1024,
    maxDshFiles: 50,
    json: true,
  });
  for (const bad of [['--target', 'solaris-x64'], ['--max-dsh-bytes', '0'], ['--max-dsh-bytes', '-1'], ['--max-dsh-files', 'abc']]) {
    assert.throws(() => parseArguments(['--output', 'x', '--dsh-tgz', 'x.tgz', ...bad]), refused('BAD_ARGUMENT'));
  }
});

test('反向：unpackPnpm 拒绝非归档字节与越出 package/ 的归档，且不写出任何文件', (t) => {
  // The pnpm tarball this unpacks is the bundled runtime's now; the reader
  // itself is still this module's, so its fail-closed rules are still tested here.
  const root = temp(t);
  const destination = join(root, 'pnpm');
  assert.throws(() => unpackPnpm(Buffer.from('this is not a tarball, not even gzip'), destination), refused('STAGE_PNPM_ARCHIVE_INVALID'));
  assert.throws(() => unpackPnpm(fixturePnpm(root, { archiveRoot: 'other' }).bytes, destination), refused('STAGE_PNPM_ARCHIVE_INVALID'));
  assert.equal(existsSync(destination), false, 'a refused archive creates nothing');
});

test('闭包去重、外平台 prebuilds 裁剪、Top 20 统计与预算门禁（正反向）', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const writePkg = (dir, name, version, size = 16) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version })}\n`);
    writeFileSync(join(dir, 'index.js'), 'x'.repeat(size));
  };

  // Build an installer that lays down nested duplicate copies of zod@4.4.3 and @scope/leaf@1.0.0,
  // a shadowed zod@3.22.0 inside pkg-legacy, plus multi-platform prebuilds and >20 packages.
  const nestedInstaller = (tgz, dest) => {
    fakeInstaller()(tgz, dest);
    const nm = join(dest, 'node_modules');
    writePkg(join(nm, 'zod'), 'zod', '4.4.3', 100);
    writePkg(join(nm, 'pkg-a', 'node_modules', 'zod'), 'zod', '4.4.3', 100);
    writePkg(join(nm, 'pkg-b', 'node_modules', 'zod'), 'zod', '4.4.3', 100);
    writePkg(join(nm, 'pkg-a', 'node_modules', '@scope', 'leaf'), '@scope/leaf', '1.0.0', 60);
    writePkg(join(nm, 'pkg-b', 'node_modules', '@scope', 'leaf'), '@scope/leaf', '1.0.0', 60);
    writePkg(join(nm, 'pkg-legacy', 'node_modules', 'zod'), 'zod', '3.22.0', 80);
    writePkg(join(nm, 'pkg-legacy', 'node_modules', 'sub', 'node_modules', 'zod'), 'zod', '4.4.3', 100);
    // Multi-platform prebuilds on a third-party native wrapper vs verbatim @deepseek-ai/dsh.
    writePkg(join(nm, 'native-wrap'), 'native-wrap', '1.0.0', 50);
    for (const [plat, bytes] of [['darwin-arm64', 40], ['darwin-x64+arm64', 45], ['win32-x64', 90], ['linux-x64', 85], ['android-arm64', 70], ['custom-metadata', 12]]) {
      mkdirSync(join(nm, 'native-wrap', 'prebuilds', plat), { recursive: true });
      writeFileSync(join(nm, 'native-wrap', 'prebuilds', plat, 'node.napi.node'), Buffer.alloc(bytes));
    }
    mkdirSync(join(nm, '@deepseek-ai', 'dsh', 'prebuilds', 'win32-x64'), { recursive: true });
    writeFileSync(join(nm, '@deepseek-ai', 'dsh', 'prebuilds', 'win32-x64', 'keep.node'), Buffer.alloc(8));
    for (let i = 1; i <= 20; i += 1) {
      writePkg(join(nm, `extra-pkg-${String(i).padStart(2, '0')}`), `extra-pkg-${i}`, '1.0.0', i * 10);
    }
  };

  const args = { ...stageArgs(root, artifact), target: 'mac-arm64', installer: nestedInstaller };
  writeFileSync(args.lockPath, `${JSON.stringify(ledger(artifact), null, 2)}\n`);
  const record = stagePayload(args);
  const stagedNm = join(root, 'out', 'resources', 'dsh', 'node_modules');

  assert.equal(existsSync(join(stagedNm, 'pkg-a', 'node_modules', 'zod')), false, 'duplicate zod@4.4.3 pruned');
  assert.equal(existsSync(join(stagedNm, 'pkg-b', 'node_modules', 'zod')), false, 'sibling duplicate zod@4.4.3 pruned');
  assert.equal(existsSync(join(stagedNm, '@scope', 'leaf', 'package.json')), true, 'missing root leaf hoisted');
  assert.equal(existsSync(join(stagedNm, 'pkg-a', 'node_modules', '@scope')), false, 'empty @scope directory cleaned');
  assert.equal(existsSync(join(stagedNm, 'pkg-b', 'node_modules', '@scope', 'leaf')), false, 'sibling duplicate @scope/leaf pruned after hoist');
  assert.equal(existsSync(join(stagedNm, 'pkg-legacy', 'node_modules', 'zod')), true, 'different-version zod@3.22.0 kept');
  assert.equal(existsSync(join(stagedNm, 'pkg-legacy', 'node_modules', 'sub', 'node_modules', 'zod')), true, 'nested zod@4.4.3 below zod@3.22.0 kept');
  assert.equal(existsSync(join(stagedNm, 'native-wrap', 'prebuilds', 'darwin-arm64')), true, 'matching prebuild kept');
  assert.equal(existsSync(join(stagedNm, 'native-wrap', 'prebuilds', 'darwin-x64+arm64')), true, 'universal mac prebuild kept');
  assert.equal(existsSync(join(stagedNm, 'native-wrap', 'prebuilds', 'custom-metadata')), true, 'non-platform prebuild dir untouched');
  for (const foreign of ['win32-x64', 'linux-x64', 'android-arm64']) {
    assert.equal(existsSync(join(stagedNm, 'native-wrap', 'prebuilds', foreign)), false, `foreign ${foreign} prebuild pruned`);
  }
  assert.equal(existsSync(join(stagedNm, '@deepseek-ai', 'dsh', 'prebuilds', 'win32-x64', 'keep.node')), true, 'verbatim dsh never pruned');
  assert.deepEqual(record.dshClosure.prunedPrebuilds, { removedDirs: 3, removedFiles: 3, removedBytes: 245 });
  assert.equal(record.dshClosure.hoisted, 1);
  assert.equal(record.dshClosure.deduped, 3);
  assert.equal(record.dshClosure.topPackages.length, 20);
  assert.ok(record.dshClosure.topPackages[0].bytes >= record.dshClosure.topPackages[1].bytes);
  assert.match(record.dshClosure.digest, /^[0-9a-f]{64}$/u);

  // Target-specific prebuild pruning on win-x64 keeps win32-x64 and prunes darwin-arm64.
  const winRoot = temp(t);
  const winPkgDir = join(winRoot, 'node_modules', 'native-wrap', 'prebuilds');
  mkdirSync(join(winPkgDir, 'win32-x64'), { recursive: true });
  mkdirSync(join(winPkgDir, 'darwin-arm64'), { recursive: true });
  mkdirSync(join(winRoot, 'node_modules', 'native-wrap'), { recursive: true });
  writeFileSync(join(winRoot, 'node_modules', 'native-wrap', 'package.json'), '{"name":"native-wrap","version":"1.0.0"}\n');
  writeFileSync(join(winPkgDir, 'win32-x64', 'a.node'), 'ok');
  writeFileSync(join(winPkgDir, 'darwin-arm64', 'b.node'), 'bad');
  assert.equal(pruneForeignPrebuilds(join(winRoot, 'node_modules'), 'win-x64').removedDirs, 1);
  assert.equal(existsSync(join(winPkgDir, 'win32-x64', 'a.node')), true);
  assert.equal(existsSync(join(winPkgDir, 'darwin-arm64')), false);

  // Deterministic closure lock: exact match passes; tampered digest or count fails closed without harming output.
  const locked = ledger(artifact);
  locked.dshClosure = { digest: record.dshClosure.digest, packages: record.dshClosure.packages };
  writeFileSync(args.lockPath, `${JSON.stringify(locked, null, 2)}\n`);
  assert.equal(stagePayload(args).dshClosure.digest, record.dshClosure.digest);

  const marker = join(root, 'out', 'resources', 'keep.txt');
  writeFileSync(marker, 'untouched\n');
  locked.dshClosure = { digest: '0'.repeat(64), packages: record.dshClosure.packages };
  writeFileSync(args.lockPath, `${JSON.stringify(locked, null, 2)}\n`);
  assert.throws(() => stagePayload(args), refused('STAGE_CLOSURE_MISMATCH'));
  assert.equal(readFileSync(marker, 'utf8'), 'untouched\n', 'existing output preserved on closure mismatch');

  // Budget gates (both CLI flags and lock fields) fail closed without destroying existing output.
  writeFileSync(args.lockPath, `${JSON.stringify(ledger(artifact), null, 2)}\n`);
  assert.throws(() => stagePayload({ ...args, maxDshBytes: record.dshClosure.bytes - 1 }), refused('STAGE_BUDGET_EXCEEDED'));
  assert.throws(() => stagePayload({ ...args, maxDshFiles: record.dshClosure.files - 1 }), refused('STAGE_BUDGET_EXCEEDED'));
  const budgetLock = ledger(artifact);
  budgetLock.dshClosure = { digest: record.dshClosure.digest, packages: record.dshClosure.packages, maxBytes: record.dshClosure.bytes - 1 };
  writeFileSync(args.lockPath, `${JSON.stringify(budgetLock, null, 2)}\n`);
  assert.throws(() => stagePayload(args), refused('STAGE_BUDGET_EXCEEDED'));
  assert.equal(readFileSync(marker, 'utf8'), 'untouched\n', 'existing output preserved on budget refusal');

  // Installed dsh version mismatch fails closed.
  writeFileSync(args.lockPath, `${JSON.stringify(ledger(artifact, { dsh: { version: '9.9.9' } }), null, 2)}\n`);
  assert.throws(() => stagePayload(args), refused('STAGE_DSH_IDENTITY_MISMATCH'));
});

test('流水线契约：release-bundle 的每个桌面任务都取得 pnpm 制品、只在运行时暂存交接它，按目标裁剪 prebuilds，macOS 产 dmg、Windows 产 exe、Linux 产 deb', () => {
  // The workflow runs only on a tag, behind an approval: a handover it gets wrong would be found late.
  const count = (text, pattern) => (text.match(pattern) ?? []).length;
  // A staged command is a first line ending in a backslash and the lines it is joined to; a one-line call is not a staging.
  const commands = (text, tool) => [...text.matchAll(new RegExp(`node scripts/${tool}\\.mjs[^\\n]*\\n(?:[^\\S\\n]+[^\\n]*\\\\\\n)+[^\\S\\n]+[^\\n]*`, 'gu'))].map((match) => match[0]);
  const jobBlock = (text, jobId) => {
    const start = text.indexOf(`\n  ${jobId}:\n`);
    if (start === -1) return '';
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-zA-Z0-9_-]+:\n/u);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  const checkDesktopJobs = (text) => {
    const expectedJobs = [
      { id: 'desktop-mac', runner: 'macos-15', target: 'mac-arm64', installerTarget: 'mac', installerArch: 'arm64', debArch: null, artifactPattern: /heluo-forge-enterprise-\*-arm64\.dmg/u },
      { id: 'desktop-windows', runner: 'windows-2025', target: 'win-x64', installerTarget: 'win', installerArch: null, debArch: null, artifactPattern: /heluo-forge-enterprise-\*-setup-\*\.exe/u },
      { id: 'desktop-linux-x64', runner: 'ubuntu-24.04', target: 'linux-x64', installerTarget: 'linux', installerArch: 'x64', debArch: 'amd64', artifactPattern: /heluo-forge-enterprise-\*\.deb/u },
      { id: 'desktop-linux-arm64', runner: 'ubuntu-24.04-arm', target: 'linux-arm64', installerTarget: 'linux', installerArch: 'arm64', debArch: 'arm64', artifactPattern: /heluo-forge-enterprise-\*\.deb/u },
    ];
    for (const job of expectedJobs) {
      const block = jobBlock(text, job.id);
      assert.notEqual(block, '', `missing job ${job.id}`);
      assert.match(block, new RegExp(`^\\s*runs-on:[ \\t]*${job.runner}[ \\t]*$`, 'mu'), `${job.id} runner`);
      const jobStagings = commands(block, 'stage-desktop-payload');
      assert.equal(jobStagings.length, 1, `${job.id} must have one payload staging`);
      assert.match(jobStagings[0], new RegExp(`--target ${job.target}\\b`, 'u'), `${job.id} payload target`);
      const jobRuntimes = commands(block, 'stage-primary-runtime');
      assert.equal(jobRuntimes.length, 1, `${job.id} must have one runtime staging`);
      assert.match(jobRuntimes[0], new RegExp(`--target ${job.target}\\b`, 'u'), `${job.id} runtime target`);
      const jobInstallers = commands(block, 'build-desktop-installer');
      assert.equal(jobInstallers.length, 1, `${job.id} must have one installer build`);
      assert.match(jobInstallers[0], new RegExp(`--target ${job.installerTarget}\\b`, 'u'), `${job.id} installer target`);
      if (job.installerArch !== null) {
        assert.match(jobInstallers[0], new RegExp(`--arch ${job.installerArch}\\b`, 'u'), `${job.id} installer arch`);
      }
      if (job.debArch !== null) {
        assert.match(block, new RegExp(`dpkg-deb -f "\\$DEB_FILE" Architecture[\\s\\S]*\\$ARCH" != '${job.debArch}'`, 'u'), `${job.id} deb Architecture check`);
      }
      assert.match(block, job.artifactPattern, `${job.id} artifact glob`);
      const uploads = commands(block, 'upload-draft-release');
      assert.equal(uploads.length, 1, `${job.id} must attach its artifact to the draft release`);
    }
  };

  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release-bundle.yml'), 'utf8');
  checkDesktopJobs(workflow);
  const stagings = commands(workflow, 'stage-desktop-payload');
  assert.equal(stagings.length, 4, 'one desktop job per platform');
  assert.equal(/ditto -c -k/u.test(workflow), false, 'mac job no longer repacks .app with ditto zip');
  assert.equal(count(workflow, /node -p "require\('\.\/services\/forge-desktop\/runtime-lock\.json'\)\.pnpm\.version"/gu), stagings.length, 'the version comes from the ledger');
  assert.equal(count(workflow, /echo "PNPM_TGZ=/gu), stagings.length, 'the artifact path is published to the later steps');
  const handed = (command) => /--pnpm-tgz "\$PNPM_TGZ"/u.test(command);
  // The payload is the one place pnpm is unpacked: every runtime staging hands the artifact over...
  const runtimes = commands(workflow, 'stage-primary-runtime');
  assert.equal(runtimes.length, stagings.length, 'one bundled runtime per desktop job');
  for (const command of runtimes) assert.equal(handed(command), true, `a runtime staging without the pnpm artifact:\n${command}`);
  // ...and the payload stager alone: a staging of the shell resources that hands it over would unpack a second copy.
  for (const command of stagings) assert.equal(handed(command), false, `the shell staging must not hand over the pnpm artifact:\n${command}`);
  // The guard fails on a workflow whose runtime staging loses the artifact...
  const dropped = workflow.replace('--pnpm-tgz "$PNPM_TGZ"', '');
  assert.equal([...commands(dropped, 'stage-primary-runtime')].some((command) => !handed(command)), true);
  // ...and on one that hands it to the shell staging as well.
  const extra = workflow.replace(
    '          node scripts/stage-desktop-payload.mjs \\\n            --output "$STAGED_DIR" \\\n            --dsh-tgz "$DSH_TGZ" \\\n',
    '          node scripts/stage-desktop-payload.mjs \\\n            --output "$RUNNER_TEMP/staged" \\\n            --dsh-tgz "$DSH_TGZ" \\\n            --pnpm-tgz "$PNPM_TGZ" \\\n',
  );
  assert.notEqual(extra, workflow, 'the mutation must land somewhere');
  assert.equal([...commands(extra, 'stage-desktop-payload')].some((command) => handed(command)), true);
  // ...and on swapped Linux installer arches or a missing Linux upload step.
  const swappedArch = workflow
    .replace('--target linux \\\n            --arch x64', '--target linux \\\n            --arch __TMP_ARCH__')
    .replace('--target linux \\\n            --arch arm64', '--target linux \\\n            --arch x64')
    .replace('--target linux \\\n            --arch __TMP_ARCH__', '--target linux \\\n            --arch arm64');
  assert.throws(() => checkDesktopJobs(swappedArch), /desktop-linux-x64 installer arch/u);
  const missingUpload = workflow.replace(
    '      - name: Attach the deb installer to the draft Release\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: |\n          node scripts/upload-draft-release.mjs \\\n            --tag "$GITHUB_REF_NAME" \\\n            --directory "$RUNNER_TEMP/upload" \\\n            --repo "$GITHUB_REPOSITORY"',
    '      - name: Attach skipped',
  );
  assert.throws(() => checkDesktopJobs(missingUpload), /desktop-linux-x64 must attach its artifact/u);
  const wrongRunner = workflow.replace('  desktop-linux-x64:\n    name: desktop installer (linux-x64, deb)\n    needs: employee\n    runs-on: ubuntu-24.04\n', '  desktop-linux-x64:\n    name: desktop installer (linux-x64, deb)\n    needs: employee\n    runs-on: ubuntu-24.04-arm\n');
  assert.throws(() => checkDesktopJobs(wrongRunner), /desktop-linux-x64 runner/u);
});

/** Kept pure so the mutation below proves the agreement check fails. */
function pnpmPinProblems(lock, packageManager) {
  const problems = [];
  const pinned = /^pnpm@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(packageManager ?? '')?.[1];
  if (pinned === undefined) problems.push(`root packageManager must pin pnpm exactly, got ${JSON.stringify(packageManager)}`);
  if (lock?.pnpm?.version !== pinned) problems.push(`runtime-lock pnpm "${lock?.pnpm?.version}" must equal the root packageManager pin "${pinned}"`);
  return problems;
}

test('台账：载荷 pnpm 与仓库的 packageManager 钉同一个版本，且锁的是一行真实摘要（变异证明）', () => {
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const { packageManager } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pnpmPinProblems(lock, packageManager), []);
  // The row carries a digest and a size: the staging compares both.
  assert.match(lock.pnpm.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isSafeInteger(lock.pnpm.bytes) && lock.pnpm.bytes > 0);

  const variants = [
    [[{ ...lock, pnpm: { ...lock.pnpm, version: '11.28.4' } }, packageManager], /must equal the root packageManager pin/],
    [[{ ...lock, pnpm: null }, packageManager], /must equal the root packageManager pin/],
    [[lock, 'pnpm@^11.28.5'], /must pin pnpm exactly/],
    [[lock, undefined], /must pin pnpm exactly/],
  ];
  for (const [[variantLock, variantPackageManager], pattern] of variants) {
    const problems = pnpmPinProblems(variantLock, variantPackageManager);
    assert.ok(problems.length > 0, 'a mutated ledger or pin must produce at least one problem');
    assert.match(problems.join('\n'), pattern);
  }
});
