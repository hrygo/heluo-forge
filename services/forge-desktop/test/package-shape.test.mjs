/**
 * Package shape tests for @heluo/forge-desktop.
 *
 * The shell is not an npm artifact: its deliverable is the packaged app, and
 * the two Electron toolchain dependencies are build-time only. That is why
 * they live in devDependencies and why their versions are pinned exactly:
 * the fingerprint allowlist (`{43.0.0,44.0.0,44.7.0,45.0.0-alpha.6}`) makes a
 * floating Electron a different, unverified runtime (plan §4.5-2).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(here, '..');

/** The only Electron builds the dsh fingerprint allowlist accepts for this shell. */
export const ELECTRON_PIN = '44.7.0';
export const ELECTRON_BUILDER_PIN = '26.0.12';

/** Rule kept pure so the mutation cases below prove it fails. */
export function pinnedProblems(manifest) {
  const problems = [];
  const dev = manifest.devDependencies ?? {};
  const electron = dev.electron;
  if (electron !== ELECTRON_PIN) {
    problems.push(`devDependencies.electron must be exactly "${ELECTRON_PIN}", got ${JSON.stringify(electron)}`);
  }
  const builder = dev['electron-builder'];
  if (builder !== ELECTRON_BUILDER_PIN) {
    problems.push(`devDependencies["electron-builder"] must be exactly "${ELECTRON_BUILDER_PIN}", got ${JSON.stringify(builder)}`);
  }
  for (const [name, range] of Object.entries(dev)) {
    if (/^[~^]| \|\| /u.test(range)) problems.push(`devDependencies.${name} uses a floating range: ${range}`);
  }
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    problems.push('the shell ships no runtime dependencies; the toolchain belongs in devDependencies');
  }
  return problems;
}

test('清单形态：钉版 devDependencies、零运行时依赖、files 闭包不夹带工具链', async () => {
  const manifest = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pinnedProblems(manifest), []);
  assert.deepEqual(manifest.files, ['src', 'README.md']);
  assert.ok(manifest.engines.dsh);
  assert.equal(manifest.private, true);
});

test('钉版反向：浮动范围、未知版本与运行时依赖各自被拒（变异证明）', async () => {
  const manifest = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'));
  const variants = [
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, electron: '^44.7.0' } }, /electron.*exactly/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, electron: '44.7.0' , 'electron-builder': '~26.0.12' } }, /electron-builder.*exactly/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, electron: '44.11.5' } }, /exactly/],
    [{ ...manifest, dependencies: { electron: '44.7.0' } }, /no runtime dependencies/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, foo: '^1.0.0' } }, /floating range/],
  ];
  for (const [variant, pattern] of variants) {
    const problems = pinnedProblems(variant);
    assert.ok(problems.length > 0, 'a mutated manifest must produce at least one problem');
    assert.match(problems.join('\n'), pattern);
  }
});

test('布局契约：main.mjs 消费 layout.mjs 的导出，不内联资源路径', async () => {
  const main = await readFile(join(PKG_ROOT, 'src', 'main.mjs'), 'utf8');
  assert.match(main, /from '\.\/layout\.mjs'/u);
  assert.doesNotMatch(main, /'node_modules', '@deepseek-ai'/u, 'dsh 入口路径必须来自 layout.mjs，不得内联');
  assert.doesNotMatch(main, /'brand', 'tray\.png'/u, '托盘图标路径必须来自 layout.mjs，不得内联');
  const layout = await readFile(join(PKG_ROOT, 'src', 'layout.mjs'), 'utf8');
  assert.match(layout, /export const DSH_ENTRY_PARTS/u);
  assert.match(layout, /export const TRAY_ICON_PARTS/u);
  assert.match(layout, /export const BIN_DIR/u);
  assert.match(layout, /export const ASSETS_DIR/u);
  assert.match(layout, /export const STATUS_PAGE_PARTS/u);
  assert.match(main, /STATUS_PAGE_PARTS/u, 'main.mjs must read the setup page path from layout.mjs');
});
