import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');

const read = (relative) => readFileSync(join(PKG_ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

test('package shape exports icon, bilingual locale metadata, and dedicated detail docs', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.icon, './icon.svg');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./issue-delivery-skill/locale/*.json'], './locale/issue-delivery-skill/*.json');
  assert.equal(pkg.exports['./issue-delivery-skill/icon'], './icon.svg');

  const zh = readJson('locale/zh.json');
  const en = readJson('locale/en.json');
  assert.equal(zh.meta.detail, 'docs/DETAIL.zh.md');
  assert.equal(en.meta.detail, 'docs/DETAIL.md');
  assert.ok(zh.meta.title.length > 0 && zh.meta.description.length > 0);
  assert.ok(en.meta.title.length > 0 && en.meta.description.length > 0);

  // DevOps user-facing intro copy must not emphasize read-only framing.
  assert.doesNotMatch(`${zh.meta.title}\n${zh.meta.description}\n${en.meta.title}\n${en.meta.description}`, /只读|read-only/i);

  const skillZh = readJson('locale/issue-delivery-skill/zh.json');
  const skillEn = readJson('locale/issue-delivery-skill/en.json');
  assert.ok(skillZh.meta.title.length > 0 && skillZh.meta.description.length > 0);
  assert.ok(skillEn.meta.title.length > 0 && skillEn.meta.description.length > 0);

  const detailZh = read(zh.meta.detail);
  const detailEn = read(en.meta.detail);
  assert.ok(detailZh.length > 100 && detailEn.length > 100);
  assert.doesNotMatch(`${detailZh}\n${detailEn}`, /<[a-z!/]/i, 'DETAIL docs must avoid raw HTML');
  assert.doesNotMatch(`${detailZh}\n${detailEn}`, /只读|read-only/i, 'engineering bundle detail should not emphasize read-only DevOps copy');
});

test('bundled icon.svg is byte-identical to official forge-cli-app-icon branding asset', () => {
  const actual = readFileSync(join(PKG_ROOT, 'icon.svg'));
  const canonical = readFileSync(
    join(REPO_ROOT, 'docs', 'assets', 'branding', 'cyber-long', 'components', 'forge-cli-app-icon.svg'),
  );
  assert.equal(Buffer.compare(actual, canonical), 0);
});

