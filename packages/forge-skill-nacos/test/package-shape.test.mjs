import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the manifest declares the repository package contract', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-skill-nacos');
  assert.equal(manifest.private, true);
  assert.ok(manifest.engines.dsh);
  assert.ok(manifest.scripts.test);
  await access(join(here, manifest.main));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) {
    await access(join(here, file));
  }
  for (const target of Object.values(manifest.exports)) {
    await access(join(here, target));
  }
});

test('the README claims only the skeleton and its boundaries', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用/);
  assert.match(text, /企业 Nacos 已本地联调/);
  assert.match(text, /安装类动作按范围差异保持关闭/);
  assert.doesNotMatch(text, /已实测通过企业 Nacos/);
});

test('write tools keep the gate-visible target parameter', async () => {
  const source = await read('src/tools.mjs');
  assert.match(source, /required: \['target'\]/);
  const tools = await import(join(here, 'src/tools.mjs'));
  assert.equal(Object.keys(tools.WRITE_TOOLS).length, 6);
});
