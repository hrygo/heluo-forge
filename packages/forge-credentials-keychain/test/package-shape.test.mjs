import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the manifest declares the repository package contract', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-credentials-keychain');
  assert.equal(manifest.private, true);
  assert.ok(manifest.engines.dsh);
  assert.ok(manifest.scripts.test);
  await access(join(here, manifest.main));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) {
    await access(join(here, file));
  }
});

test('the package ships SQLite storage and does not ship retired native resources', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.ok(manifest.files.includes('src'));
  assert.equal(manifest.files.includes('vendor'), false);
  await access(join(here, 'src/credential-store.mjs'));
  await access(join(here, 'src/sqlite-backend.mjs'));
});

test('the README identifies SQLite and distinguishes unverified environments', async () => {
  const text = await read('README.md');
  assert.ok(/SQLite/iu.test(text), 'README must describe SQLite');
  assert.ok(/未实机|未取证|未验证/u.test(text), 'README must distinguish unverified environments');
});
