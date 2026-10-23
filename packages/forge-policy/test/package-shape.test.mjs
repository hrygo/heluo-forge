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
  assert.ok(manifest.engines.dsh);
  assert.ok(manifest.scripts.test);
  await access(join(here, manifest.main));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) {
    await access(join(here, file));
  }
});

test('the README claims only the gate skeleton and its boundaries', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（受控动作目录与统一门禁骨架/);
  assert.match(text, /不提供 fail-open/);
  assert.doesNotMatch(text, /已联调/);
});

test('the gate keeps the hard-denial seam and offers no fail-open switch', async () => {
  const source = await read('src/index.mjs');
  assert.match(source, /ctx\.tools\.guard/);
  assert.match(source, /tools\/pre-execute/);
  assert.doesNotMatch(source, /failMode|fail-open|failOpen/);
});
