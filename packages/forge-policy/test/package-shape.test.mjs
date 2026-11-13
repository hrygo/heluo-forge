import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the manifest declares the repository package contract', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-policy');
  assert.equal(manifest.private, true);
  assert.equal(manifest.icon, './icon.svg');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.ok(manifest.files.includes('locale'));
  assert.ok(manifest.files.includes('icon.svg'));
  assert.ok(manifest.files.includes('docs'));
  assert.ok(manifest.engines.dsh);
  assert.ok(manifest.scripts.test);
  await access(join(here, manifest.main));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) {
    await access(join(here, file));
  }
});

test('bilingual plugin intro metadata, detail docs, and branding icon conform to contract', async () => {
  const zh = JSON.parse(await read('locale/zh.json'));
  const en = JSON.parse(await read('locale/en.json'));
  assert.equal(zh.meta.detail, 'docs/DETAIL.zh.md');
  assert.equal(en.meta.detail, 'docs/DETAIL.md');
  assert.ok(zh.meta.title.length > 0 && zh.meta.description.length > 0);
  assert.ok(en.meta.title.length > 0 && en.meta.description.length > 0);

  const detailZh = await read(zh.meta.detail);
  const detailEn = await read(en.meta.detail);
  assert.ok(detailZh.length > 80 && detailEn.length > 80);
  assert.doesNotMatch(`${detailZh}\n${detailEn}`, /<[a-z!/]/i, 'DETAIL docs must avoid raw HTML');

  const actualIcon = await read('icon.svg');
  const canonicalIcon = await readFile(join(here, '..', '..', 'docs', 'assets', 'branding', 'cyber-long', 'components', 'forge-policy-symbol.svg'), 'utf8');
  assert.equal(actualIcon, canonicalIcon);
});

test('the README claims only the gate skeleton and its boundaries', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（受控动作目录/);
  assert.match(text, /不提供 fail-open/);
  assert.doesNotMatch(text, /已联调/);
});

test('the gate keeps the hard-denial seam and offers no fail-open switch', async () => {
  const source = await read('src/index.mjs');
  assert.match(source, /ctx\.tools\.guard/);
  assert.match(source, /tools\/pre-execute/);
  assert.doesNotMatch(source, /failMode|fail-open|failOpen/);
});
