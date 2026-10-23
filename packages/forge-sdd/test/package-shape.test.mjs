import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the manifest declares the repository package contract', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-sdd');
  assert.equal(manifest.private, true);
  assert.ok(manifest.engines.dsh);
  assert.ok(manifest.scripts.test);
  await access(join(here, manifest.main));
  await access(join(here, manifest.bin['forge-sdd']));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) {
    await access(join(here, file));
  }
});

test('the README claims only the local pre-check skeleton', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（本地交付清单校验骨架/);
  assert.match(text, /未经 CI 验证/);
  assert.match(text, /不证明业务正确/);
  assert.doesNotMatch(text, /已联调|服务端不可绕过/);
});

test('the package keeps no second path engine and no bypass claim', async () => {
  const source = await read('src/index.mjs');
  assert.match(source, /@heluo\/forge-policy/);
  const cli = await read('src/cli.mjs');
  assert.doesNotMatch(cli, /不可绕过|bypass/i);
});
