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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ASSETS_DIR, DSH_ENTRY_PARTS, STATUS_PAGE_PARTS, TRAY_ICON_PARTS } from '../services/forge-desktop/src/layout.mjs';
import { parseArguments, StageError, stagePayload } from '../scripts/stage-desktop-payload.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(REPO_ROOT, 'docs', 'assets', 'branding', 'cyber-long');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-stage-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A minimal dsh tarball: the registry layout `package/` with `lib/bin.js`. */
function fixtureTgz(root) {
  const source = join(root, 'artifact');
  mkdirSync(join(source, 'lib'), { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' })}\n`);
  writeFileSync(join(source, 'lib', 'bin.js'), 'void 0;\n');
  const tgz = join(root, 'dsh-test.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', source, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
  // The registry tarball carries a `package/` root, not `.`.
  const reroot = join(root, 'reroot');
  mkdirSync(join(reroot, 'package'), { recursive: true });
  rmSync(join(reroot, 'package'), { recursive: true });
  execFileSync('cp', ['-R', source, join(reroot, 'package')]);
  execFileSync('tar', ['-czf', tgz, '-C', reroot, 'package']);
  const bytes = readFileSync(tgz);
  return { tgz, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function fixtureLock(root, artifact) {
  const lock = join(root, 'runtime-lock.json');
  writeFileSync(lock, `${JSON.stringify({ schema: 'heluo-desktop-runtime-lock/1', dsh: { version: '0.0.0-test', sha256: artifact.sha256, bytes: artifact.bytes.length } }, null, 2)}\n`);
  return lock;
}

/** A stand-in for npm install: the registry layout a closure install produces. */
function fakeInstaller(sourceTgzRoot) {
  return (tgz, dest) => {
    const moduleDir = join(dest, 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(moduleDir, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', moduleDir, '--strip-components', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  };
}

test('暂存布局与 layout.mjs 双向契约：dsh 入口与托盘图标落在 main.mjs 读取的路径', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const record = stagePayload({
    output: join(root, 'out'),
    dshTgz: artifact.tgz,
    brandDir: BRAND_DIR,
    lockPath: fixtureLock(root, artifact),
    repoRoot: REPO_ROOT,
    installer: fakeInstaller(),
  });
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

test('员工资产目录按 ASSETS_DIR 暂存', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const assets = join(root, 'employee');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'employee-manifest.json'), '{}\n');
  const record = stagePayload({
    output: join(root, 'out'),
    dshTgz: artifact.tgz,
    brandDir: BRAND_DIR,
    employeeAssets: assets,
    lockPath: fixtureLock(root, artifact),
    repoRoot: REPO_ROOT,
  });
  assert.equal(existsSync(join(root, 'out', 'resources', ASSETS_DIR, 'employee-manifest.json')), true);
  assert.equal(record.assets, ASSETS_DIR);
});

test('反向：摘要或字节数与台账不符即拒绝（fail-closed）', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  const lock = join(root, 'runtime-lock.json');
  writeFileSync(lock, `${JSON.stringify({ dsh: { version: 'x', sha256: '0'.repeat(64), bytes: artifact.bytes.length } })}\n`);
  assert.throws(
    () => stagePayload({ output: join(root, 'out'), dshTgz: artifact.tgz, brandDir: BRAND_DIR, lockPath: lock, repoRoot: REPO_ROOT }),
    (error) => error instanceof StageError && error.code === 'STAGE_DIGEST_MISMATCH',
  );
});

test('反向：缺品牌套件与缺 dsh 制品各自报错；参数解析拒绝未知项', (t) => {
  const root = temp(t);
  const artifact = fixtureTgz(root);
  assert.throws(
    () => stagePayload({ output: join(root, 'a'), dshTgz: artifact.tgz, brandDir: join(root, 'no-brand'), lockPath: fixtureLock(root, artifact), repoRoot: REPO_ROOT }),
    (error) => error.code === 'BRAND_MISSING',
  );
  assert.throws(
    () => stagePayload({ output: join(root, 'b'), dshTgz: join(root, 'missing.tgz'), brandDir: BRAND_DIR, lockPath: fixtureLock(root, artifact), repoRoot: REPO_ROOT }),
    (error) => error.code === 'DSH_TGZ_MISSING',
  );
  assert.throws(() => parseArguments(['--output', 'x', '--mystery']), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => parseArguments(['--dsh-tgz', 'x.tgz']), (error) => error.code === 'BAD_ARGUMENT');
});
