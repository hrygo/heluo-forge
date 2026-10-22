import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the client entry is a ModuleLoader plugin with the package id', async () => {
  const client = await read('client.js');
  assert.match(client, /__ModuleLoader__\.load/);
  assert.match(client, /id: '@heluo\/forge-iam'/);
  assert.match(client, /inject: \['slots'\]/);
  assert.match(client, /settings\.section/);
  assert.match(client, /id: 'forge-iam'/);
});

test('the client only targets the IAM routes and sends the CSRF header', async () => {
  const client = await read('client.js');
  const fetches = [...client.matchAll(/fetch\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(fetches)].sort(), ['/api/forge-iam/view']);
  assert.match(client, /postJson\('\/api\/forge-iam\/sign-in'\)/);
  assert.match(client, /postJson\('\/api\/forge-iam\/sign-out'\)/);
  assert.match(client, /x-forge-iam-request/);
  assert.match(client, /authorizationUrl/);
  assert.match(client, /window\.open/);
});

test('the client registers the settings section, signed-out banner and a four-step onboarding overlay', async () => {
  const client = await read('client.js');
  assert.doesNotMatch(client, /settings\.launcher/);
  assert.match(client, /shell\.overlay/);
  assert.match(client, /未登录企业 IAM/);
  assert.match(client, /forge-iam-banner/);
  assert.match(client, /forge-iam\.onboarding\.v1/);
  for (const title of ['欢迎使用企业版', '登录企业账号', '登录成功', '准备就绪']) {
    assert.match(client, new RegExp(title));
  }
  assert.match(client, /close\('skipped'\)/);
});

test('the client does not render tokens or set authorization headers', async () => {
  const client = await read('client.js');
  assert.doesNotMatch(client, /access_token|refresh_token|id_token|Authorization:/);
});

test('the manifest declares the client entry and the file exists', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './client.js');
  await access(join(here, 'client.js'));
});
test('the overlay opts back into pointer events under the click-through shell layer', async () => {
  const client = await read('client.js');
  // shell.overlay is a pointer-events:none layer: the dialog must opt in or
  // every click falls through to the application underneath.
  const overlay = client.slice(client.indexOf('const overlay = {'), client.indexOf('const card = {'));
  assert.match(overlay, /pointerEvents: 'auto'/);
});

test('the banner polls for the component lifetime instead of while visible', async () => {
  const client = await read('client.js');
  assert.match(client, /useSessionPoll\(true,/);
  assert.doesNotMatch(client, /useSessionPoll\(state\.visible/);
});

test('a repeated ready poll cannot pull onboarding back from the final step', async () => {
  const client = await read('client.js');
  assert.match(client, /view\.state === 'ready' && current\.step < 2/);
});

test('the client follows host theme tokens instead of private fallbacks', async () => {
  const client = await read('client.js');
  assert.doesNotMatch(client, /--dsh-surface|--dsh-text/);
  assert.match(client, /--dsw-alias-bg-layer-1/);
  assert.match(client, /--dsw-alias-label-primary/);
});

test('the package ships plugin display metadata and an icon', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.ok(manifest.files.includes('icon.svg'));
  assert.ok(manifest.files.includes('locale'));
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await read(`locale/${locale}.json`));
    assert.ok(meta.meta.title);
    assert.ok(meta.meta.description);
  }
});
