import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');

const read = (relative) => readFileSync(join(PKG_ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

test('package shape exports icon, bilingual locale metadata, and clean detail docs without read-only framing', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.icon, './icon.svg');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.ok(pkg.files.includes('locale'));
  assert.ok(pkg.files.includes('icon.svg'));
  assert.ok(pkg.files.includes('docs'));
  assert.doesNotMatch(pkg.description, /only read|read-only|policy-gated reads|只读/i);

  const zh = readJson('locale/zh.json');
  const en = readJson('locale/en.json');
  assert.equal(zh.meta.detail, 'docs/DETAIL.zh.md');
  assert.equal(en.meta.detail, 'docs/DETAIL.md');
  assert.ok(zh.meta.title.length > 0 && zh.meta.description.length > 0);
  assert.ok(en.meta.title.length > 0 && en.meta.description.length > 0);

  const detailZh = read(zh.meta.detail);
  const detailEn = read(en.meta.detail);
  assert.ok(detailZh.length > 80 && detailEn.length > 80);
  const intro = `${zh.meta.title}\n${zh.meta.description}\n${en.meta.title}\n${en.meta.description}\n${detailZh}\n${detailEn}`;
  assert.doesNotMatch(intro, /<[a-z!/]/i, 'DETAIL docs must avoid raw HTML');
  assert.doesNotMatch(intro, /只读|read-only/i);
});

test('bundled icon.svg is byte-identical to official forge-devops-symbol branding asset', () => {
  const actual = readFileSync(join(PKG_ROOT, 'icon.svg'));
  const canonical = readFileSync(
    join(REPO_ROOT, 'docs', 'assets', 'branding', 'cyber-long', 'components', 'forge-devops-symbol.svg'),
  );
  assert.equal(Buffer.compare(actual, canonical), 0);
});
