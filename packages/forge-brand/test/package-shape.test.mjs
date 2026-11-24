/**
 * Package shape tests for @heluo/forge-brand.
 *
 * The packaged brand assets must be byte-identical copies of the Cyber-Long
 * brand sources, and those sources must still match the brand manifest's
 * SHA-256 ledger: a redrawn icon or an unregistered source file fails here.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(here, '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const BRAND_DIR = join(REPO_ROOT, 'docs', 'assets', 'branding', 'cyber-long');

const manifest = JSON.parse(await readFile(join(BRAND_DIR, 'manifest.json'), 'utf8'));
const manifestEntryOf = (path) => {
  const entry = manifest.assets.find((asset) => asset.path === path);
  assert.ok(entry, `${path} must be registered in the brand manifest`);
  return entry;
};

async function assertIdenticalToSource(packaged, source) {
  const [packagedBytes, sourceBytes] = await Promise.all([readFile(join(PKG_ROOT, packaged)), readFile(join(BRAND_DIR, source))]);
  assert.equal(Buffer.compare(packagedBytes, sourceBytes), 0, `${packaged} must be byte-identical to ${source}`);
  const entry = manifestEntryOf(source);
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  assert.equal(digest, entry.sha256, `${source} no longer matches the brand manifest ledger`);
  assert.equal(sourceBytes.length, entry.bytes);
  return packagedBytes;
}

test('清单形态：私有、图标导出、engines 与测试入口齐备', async () => {
  const pkg = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@heluo/forge-brand');
  assert.equal(pkg.private, true);
  assert.equal(pkg.icon, './icon.svg');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.exports['./assets/wordmark-color.svg'], './assets/wordmark-color.svg');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.ok(pkg.engines.dsh);
  assert.equal(typeof pkg.scripts.test, 'string');
  for (const entry of pkg.files) await access(join(PKG_ROOT, entry));
  await access(join(PKG_ROOT, pkg.main));
});

test('品牌资源随包：icon 与 wordmark 与品牌源文件逐字节一致且源在 manifest 账本内', async () => {
  const icon = await assertIdenticalToSource('icon.svg', 'primary/symbol-color.svg');
  const wordmark = await assertIdenticalToSource('assets/wordmark-color.svg', 'primary/wordmark-color.svg');
  assert.match(icon.toString('utf8'), /^<svg/u);
  assert.match(wordmark.toString('utf8'), /^<svg/u);
  assert.ok(icon.length <= 256 * 1024);
  assert.ok(wordmark.length <= 256 * 1024);
});

test('locale 成对且指向存在的明细文档', async () => {
  const en = JSON.parse(await readFile(join(PKG_ROOT, 'locale', 'en.json'), 'utf8'));
  const zh = JSON.parse(await readFile(join(PKG_ROOT, 'locale', 'zh.json'), 'utf8'));
  for (const meta of [en.meta, zh.meta]) {
    assert.ok(meta.title.trim().length > 0);
    assert.ok(meta.description.trim().length > 0);
    await access(join(PKG_ROOT, meta.detail));
  }
});

test('默认主色通过双底对比度门槛（品牌令牌自洽）', async () => {
  const { BRAND_DEFAULTS, passesAccentContrast } = await import(join(PKG_ROOT, 'src', 'index.mjs'));
  assert.equal(BRAND_DEFAULTS.productName, '河洛 Forge 企业版');
  assert.equal(passesAccentContrast(BRAND_DEFAULTS.accent), true);
  assert.equal(passesAccentContrast('#1D4ED8'), false);
});
