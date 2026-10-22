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