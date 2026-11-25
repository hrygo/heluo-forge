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

import { ASSETS_DIR, DSH_ENTRY_PARTS, PNPM_ENTRY_PARTS, STATUS_PAGE_PARTS, TRAY_ICON_PARTS } from '../services/forge-desktop/src/layout.mjs';
import { parseArguments, StageError, stagePayload, unpackPnpm } from '../scripts/stage-desktop-payload.mjs';

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
function stageArgs(root, dsh, pnpm) {
  return {
    output: join(root, 'out'),
    dshTgz: dsh.tgz,
    pnpmTgz: pnpm?.tgz,
    brandDir: BRAND_DIR,
    lockPath: join(root, 'runtime-lock.json'),
    repoRoot: REPO_ROOT,
    installer: fakeInstaller(),
  };
}

/** The ledger row that matches a pnpm fixture. */
const pnpmRow = (artifact, version = '11.28.5-test') => ({ version, sha256: artifact.sha256, bytes: artifact.bytes.length });

/** A ledger naming the dsh fixture, the pnpm row when there is one, and any dsh field to vary. */
function ledger(dsh, { pnpm, dsh: varied = {} } = {}) {
  return {
    schema: 'heluo-desktop-runtime-lock/1',
    dsh: { version: '0.0.0-test', sha256: dsh.sha256, bytes: dsh.bytes.length, ...varied },
    ...(pnpm === undefined ? {} : { pnpm }),
  };
}

/** Stage both fixtures against a ledger written to disk: the matching rows, with any field to vary. */
function stageWith(root, dsh, pnpm, { dsh: variedDsh = {}, pnpm: variedPnpm } = {}) {
  const args = stageArgs(root, dsh, pnpm);
  writeFileSync(args.lockPath, `${JSON.stringify(ledger(dsh, { dsh: variedDsh, pnpm: variedPnpm ?? pnpmRow(pnpm) }), null, 2)}\n`);
  return stagePayload(args);
}

test('暂存布局与 layout.mjs 双向契约：dsh 入口与托盘图标落在 main.mjs 读取的路径', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const pnpm = fixturePnpm(root);
  const record = stageWith(root, artifact, pnpm);
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
  assert.equal(record.dsh.version, '0.0.0-test');
  assert.equal(record.assets, null);
});

test('pnpm 按 PNPM_ENTRY_PARTS 暂存：入口、嵌套文件与执行位原样落地，台账记录摘要', { skip: !POSIX }, (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const pnpm = fixturePnpm(root, { executable: true });
  const record = stageWith(root, artifact, pnpm);
  const resources = join(root, 'out', 'resources');
  // The entry is where the shell starts pnpm from, and it is the file the archive carried.
  assert.equal(existsSync(join(resources, ...PNPM_ENTRY_PARTS)), true, 'pnpm entry must sit exactly where the shell reads it');
  assert.equal(readFileSync(join(resources, ...PNPM_ENTRY_PARTS)).toString(), "console.log('pnpm');\n");
  assert.equal(statSync(join(resources, ...PNPM_ENTRY_PARTS)).mode & 0o777, 0o755, 'the executable bit the archive recorded is kept');
  assert.equal(readFileSync(join(resources, 'pnpm', 'dist', 'nested', 'payload.mjs')).toString(), 'void 0;\n', 'nested files land below the package root');
  assert.equal(statSync(join(resources, 'pnpm', 'dist', 'nested', 'payload.mjs')).mode & 0o777, 0o644);
  assert.equal(JSON.parse(readFileSync(join(resources, 'pnpm', 'package.json'), 'utf8')).version, '11.28.5-test', 'the manifest is unpacked verbatim');
  // Nothing of the archive's `package/` root leaks into the layout.
  assert.equal(existsSync(join(resources, 'pnpm', 'package')), false);
  // The record names what was staged, for the build and the audit after it.
  assert.deepEqual(record.pnpm, { version: '11.28.5-test', sha256: pnpm.sha256, bytes: pnpm.bytes.length, artifact: basename(pnpm.tgz) });
  assert.equal(record.layout.pnpmEntry, PNPM_ENTRY_PARTS.join('/'));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'out', 'staging-manifest.json'), 'utf8')).pnpm, record.pnpm);
});

test('员工资产目录按 ASSETS_DIR 暂存', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const pnpm = fixturePnpm(root);
  const assets = join(root, 'employee');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'employee-manifest.json'), '{}\n');
  const args = { ...stageArgs(root, artifact, pnpm), employeeAssets: assets };
  writeFileSync(args.lockPath, `${JSON.stringify(ledger(artifact, { pnpm: pnpmRow(pnpm) }))}\n`);
  const record = stagePayload(args);
  assert.equal(existsSync(join(root, 'out', 'resources', ASSETS_DIR, 'employee-manifest.json')), true);
  assert.equal(record.assets, ASSETS_DIR);
});

test('反向：dsh 或 pnpm 的摘要、字节数与台账不符即拒绝，且不动已有输出（fail-closed）', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const pnpm = fixturePnpm(root);
  mkdirSync(join(root, 'out', 'resources'), { recursive: true });
  writeFileSync(join(root, 'out', 'resources', 'leftover.txt'), 'previous run\n');

  assert.throws(() => stageWith(root, artifact, pnpm, { dsh: { sha256: '0'.repeat(64) } }), refused('STAGE_DIGEST_MISMATCH'));
  assert.throws(() => stageWith(root, artifact, pnpm, { dsh: { bytes: artifact.bytes.length + 1 } }), refused('STAGE_DIGEST_MISMATCH'));
  assert.throws(() => stageWith(root, artifact, pnpm, { pnpm: { ...pnpmRow(pnpm), sha256: 'f'.repeat(64) } }), refused('STAGE_DIGEST_MISMATCH'));
  assert.throws(
    () => stageWith(root, artifact, pnpm, { pnpm: { ...pnpmRow(pnpm), bytes: pnpm.bytes.length + 1 } }),
    (error) => error.code === 'STAGE_DIGEST_MISMATCH' && /pnpm tarball is/.test(error.message),
  );
  // The failure names the artifact it is about.
  assert.throws(() => stageWith(root, artifact, pnpm, { pnpm: { ...pnpmRow(pnpm), sha256: 'f'.repeat(64) } }), (error) => /pnpm tarball SHA-256/.test(error.message));

  // Nothing of a refused run reaches the output: the previous content is still there, untouched.
  assert.equal(readFileSync(join(root, 'out', 'resources', 'leftover.txt')).toString(), 'previous run\n');
  assert.equal(existsSync(join(root, 'out', 'staging-manifest.json')), false);
});

test('反向：pnpm 制品缺失、未交接、台账无行、包内身份不符、归档不合规各自报错', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const pnpm = fixturePnpm(root);
  // Every refusal below comes after a ledger that would otherwise admit the handover.
  const valid = stageArgs(root, artifact, pnpm);
  writeFileSync(valid.lockPath, `${JSON.stringify(ledger(artifact, { pnpm: pnpmRow(pnpm) }), null, 2)}\n`);

  assert.throws(() => stagePayload({ ...valid, pnpmTgz: join(root, 'absent.tgz') }), refused('PNPM_TGZ_MISSING'));
  assert.throws(() => stagePayload({ ...valid, pnpmTgz: undefined }), refused('PNPM_TGZ_MISSING'));
  // A ledger without the pnpm row is not a staging input, whoever supplied the tarball.
  const rowless = { ...valid };
  writeFileSync(rowless.lockPath, `${JSON.stringify(ledger(artifact), null, 2)}\n`);
  assert.throws(() => stagePayload(rowless), refused('LOCK_INVALID'));
  writeFileSync(valid.lockPath, `${JSON.stringify(ledger(artifact, { pnpm: pnpmRow(pnpm) }), null, 2)}\n`);

  // Bytes the ledger matches, but not the package it names: identity is checked on what landed.
  const older = fixturePnpm(root, { version: '11.28.4-test' });
  assert.throws(() => stageWith(root, artifact, older), refused('STAGE_PNPM_IDENTITY_MISMATCH'));
  const foreign = fixturePnpm(root, { name: 'npm' });
  assert.throws(() => stageWith(root, artifact, foreign), refused('STAGE_PNPM_IDENTITY_MISMATCH'));
  assert.throws(() => stageWith(root, artifact, older, { pnpm: pnpmRow(older, '11.28.6-test') }), refused('STAGE_PNPM_IDENTITY_MISMATCH'));

  // The right package with no entry to start: the layout contract catches it here, not in the app.
  const entryless = fixturePnpm(root, { entry: false });
  assert.throws(() => stageWith(root, artifact, entryless), refused('STAGE_LAYOUT_INVALID'));

  // An archive that is not rooted at `package/` is not a registry artifact.
  const rooted = fixturePnpm(root, { archiveRoot: 'elsewhere' });
  assert.throws(() => stageWith(root, artifact, rooted), refused('STAGE_PNPM_ARCHIVE_INVALID'));
});

test('反向：unpackPnpm 拒绝非归档字节与越出 package/ 的归档，且不写出任何文件', (t) => {
  const root = temp(t);
  const destination = join(root, 'pnpm');
  assert.throws(() => unpackPnpm(Buffer.from('this is not a tarball, not even gzip'), destination), refused('STAGE_PNPM_ARCHIVE_INVALID'));
  assert.throws(() => unpackPnpm(fixturePnpm(root, { archiveRoot: 'other' }).bytes, destination), refused('STAGE_PNPM_ARCHIVE_INVALID'));
  assert.equal(existsSync(destination), false, 'a refused archive creates nothing');
});

test('反向：缺品牌套件与缺 dsh 制品各自报错；参数解析要求并拒绝未知项', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const pnpm = fixturePnpm(root);
  const brandless = temp(t, 'forge-stage-nobrand-');
  // Artifacts are verified before the brand is looked at, so the ledger on disk is a valid one.
  const valid = stageArgs(root, artifact, pnpm);
  writeFileSync(valid.lockPath, `${JSON.stringify(ledger(artifact, { pnpm: pnpmRow(pnpm) }), null, 2)}\n`);
  assert.throws(() => stagePayload({ ...valid, output: join(brandless, 'out'), brandDir: join(brandless, 'no-brand') }), (error) => error.code === 'BRAND_MISSING');
  // dsh is reported before pnpm: the handover is refused one artifact at a time, in layout order.
  assert.throws(
    () => stagePayload({ ...valid, output: join(root, 'b'), dshTgz: join(root, 'missing.tgz'), pnpmTgz: join(root, 'also-missing.tgz') }),
    (error) => error.code === 'DSH_TGZ_MISSING',
  );
  assert.throws(() => parseArguments(['--output', 'x', '--mystery']), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => parseArguments(['--dsh-tgz', 'x.tgz']), (error) => error.code === 'BAD_ARGUMENT');
  // Both artifacts are part of every handover.
  assert.throws(() => parseArguments(['--output', 'x', '--dsh-tgz', 'x.tgz']), (error) => error.code === 'BAD_ARGUMENT' && /--pnpm-tgz is required/.test(error.message));
  assert.throws(() => parseArguments(['--output', 'x', '--pnpm-tgz', 'p.tgz']), (error) => error.code === 'BAD_ARGUMENT' && /--dsh-tgz is required/.test(error.message));
  assert.deepEqual(parseArguments(['--output', 'x', '--dsh-tgz', 'x.tgz', '--pnpm-tgz', 'p.tgz', '--json']), {
    output: 'x',
    dshTgz: 'x.tgz',
    pnpmTgz: 'p.tgz',
    brandDir: undefined,
    employeeAssets: undefined,
    lock: undefined,
    json: true,
  });
});

test('流水线契约：release-bundle 的每个桌面任务都取得 pnpm 制品并交给暂存工具', () => {
  // The workflow runs only on a tag, behind an approval: a handover it gets wrong would be found late.
  const count = (text, pattern) => (text.match(pattern) ?? []).length;
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release-bundle.yml'), 'utf8');
  const stagings = count(workflow, /stage-desktop-payload\.mjs/gu);
  assert.equal(stagings, 2, 'one desktop job per platform');
  assert.equal(count(workflow, /--pnpm-tgz "\$PNPM_TGZ"/gu), stagings, 'every staging gets the pnpm artifact');
  assert.equal(count(workflow, /node -p "require\('\.\/services\/forge-desktop\/runtime-lock\.json'\)\.pnpm\.version"/gu), stagings, 'the version comes from the ledger');
  assert.equal(count(workflow, /echo "PNPM_TGZ=/gu), stagings, 'the artifact path is published to the later steps');
  // The guard fails on a workflow that stages without the pnpm artifact.
  const dropped = workflow.replace('--pnpm-tgz "$PNPM_TGZ"', '');
  assert.equal(count(dropped, /--pnpm-tgz "\$PNPM_TGZ"/gu), stagings - 1);
});

/** Kept pure so the mutation below proves the agreement check fails. */
function pnpmPinProblems(lock, packageManager) {
  const problems = [];
  const pinned = /^pnpm@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(packageManager ?? '')?.[1];
  if (pinned === undefined) problems.push(`root packageManager must pin pnpm exactly, got ${JSON.stringify(packageManager)}`);
  if (lock?.pnpm?.version !== pinned) problems.push(`runtime-lock pnpm "${lock?.pnpm?.version}" must equal the root packageManager pin "${pinned}"`);
  return problems;
}

test('台账：随包 pnpm 与仓库的 packageManager 钉同一个版本，且锁的是一行真实摘要（变异证明）', () => {
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
