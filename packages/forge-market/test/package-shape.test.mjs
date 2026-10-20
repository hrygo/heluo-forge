import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the manifest points at files that exist', async () => {
  const manifest = JSON.parse(await read('package.json'));
  for (const target of Object.values(manifest.exports)) await access(join(here, target));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) await access(join(here, file));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
});

test('every client fetch path is served by the host routes', async () => {
  const client = await read('client.js');
  const routes = await read('src/routes.mjs');
  const calls = [...client.matchAll(/fetch\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(calls.length >= 1, 'expected the panel to fetch something');
  for (const path of calls) {
    const suffix = path.replace('/api/forge-market', '');
    assert.ok(
      routes.includes(`url.pathname === '${path}'`) || routes.includes(`\\\\/api\\\\/forge-market\\\\/detail`),
      `${path} has no host route`,
    );
    assert.ok(suffix === '' || routes.includes('forge-market'), `${path} is outside the prefix`);
  }
});

test('the panel registers into the slot it names', async () => {
  const client = await read('client.js');
  const slots = [...client.matchAll(/slots\.inject\('([^']+)'/g)].map((match) => match[1]);
  const registered = [...client.matchAll(/name: '([^']+)', key/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(registered)], slots);
});

test('the bundle row is named after the package and the client entry is declared', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const patch = await read('cordis.patch.yml');
  const names = [...patch.matchAll(/^\s+name:\s*'?([^'\n]+)'?\s*$/gm)].map((match) => match[1].trim());
  assert.ok(names.includes(manifest.name), `patch rows ${names.join(',')} do not include ${manifest.name}`);
  assert.ok(Array.isArray(manifest.dsh.client.inject), 'dsh.client.inject must be an array');
  assert.equal(typeof manifest.exports['./client'], 'string');
  await access(join(here, manifest.exports['./client']));
  await access(join(here, manifest.main));
});

test('the panel renders the summary view without the full list', async () => {
  const client = await read('client.js');
  assert.match(client, /function Panel\(\{ view \}/);
  assert.match(client, /view === 'summary'/);
  const summary = client.slice(client.indexOf("view === 'summary'"), client.indexOf("state.status === 'loading'"));
  assert.doesNotMatch(summary, /<ul|h\('ul'/);
});
