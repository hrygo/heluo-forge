import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the manifest declares the repository package contract', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-iam');
  assert.equal(manifest.private, true);
  assert.ok(manifest.engines.dsh);
  assert.ok(manifest.scripts.test);
  await access(join(here, manifest.main));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) {
    await access(join(here, file));
  }
});

test('the package README claims only the development skeleton', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（开发骨架/);
  assert.match(text, /真实 IAM 未联调/);
  assert.doesNotMatch(text, /已联调/);
});

test('the source never imports a DSH runtime just to load the skeleton', async () => {
  const source = await read('src/index.mjs');
  assert.doesNotMatch(source, /from '@deepseek-ai\//);
  assert.match(source, /ctx\.provide\('iam'/);
});