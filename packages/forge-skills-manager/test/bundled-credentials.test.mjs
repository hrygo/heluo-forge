import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fakeNacos, useNacosEnvironment } from '../spec/fixtures/nacos.mjs';

const selected = { skillName: 'example-skill', version: '1.0.0' };
const secrets = { username: ' bundled-synthetic-user ', password: ' bundled-synthetic-password ' };
const config = Object.freeze({ serverUrl: 'https://nacos.corp.example/nacos', namespaceId: 'public', credentialsRef: 'bundled' });
async function sandbox(t) {
  useNacosEnvironment(t);
  const root = await mkdtemp(join(tmpdir(), 'forge-bundled-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  await cp(new URL('../lib/', import.meta.url), join(root, 'lib'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await mkdir(join(root, 'private'));
  const path = join(root, 'private', 'nacos-credentials.json');
  const write = value => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await write(secrets);
  const { createNacosClient } = await import(pathToFileURL(join(root, 'lib/nacos.js')).href);
  const fixture = fakeNacos();
  return { root, path, write, fixture, createNacosClient, client: createNacosClient(config, fixture.fetcher) };
}
const denied = promise => assert.rejects(promise, caught => {
  assert.equal(caught.code, 'error.nacos.config');
  assert.equal(caught.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(caught) + caught.message, /synthetic|nacos-credentials|ENOENT|JSON|file:/);
  return true;
});

test('bundled file authenticates every read operation without adding secrets to frozen Host config', async t => {
  const { client, fixture } = await sandbox(t);
  await client.list(); await client.detail(selected); await client.load(selected);
  const logins = fixture.calls.filter(call => call.url.pathname.endsWith('/login'));
  assert.equal(logins.length, 1);
  assert.deepEqual(Object.fromEntries(logins[0].options.body), secrets);
  assert.deepEqual(Object.keys(config).sort(), ['credentialsRef', 'namespaceId', 'serverUrl']);
  assert.ok(!JSON.stringify(config).includes(secrets.username));
  assert.ok(!JSON.stringify(config).includes(secrets.password));
});

test('missing, malformed, oversized and invalid bundled files never fall back to valid environment credentials', async t => {
  const { client, fixture, path, write } = await sandbox(t);
  const invalid = [Buffer.from(''), Buffer.from('{"password":"bundled-synthetic-password",'),
    Buffer.from([0xff]), Buffer.alloc((16 << 10) + 1, 32)];
  await rm(path);
  const check = async () => {
    await denied(client.list()); await denied(client.detail(selected)); await denied(client.load(selected));
    assert.equal(fixture.calls.length, 0);
  };
  await check();
  for (const bytes of invalid) { await writeFile(path, bytes); await check(); }
  for (const value of [null, [], {}, { ...secrets, path: '../elsewhere' }, { username: '', password: secrets.password },
    { username: secrets.username, password: '   ' }, { username: secrets.username, password: 42 }, { password: secrets.password }]) {
    await write(value); await check();
  }
  await rm(path); await mkdir(path); await check();
});

test('only the bundled literal is accepted and inline or environment field mixtures are rejected', async t => {
  const { createNacosClient, fixture } = await sandbox(t);
  for (const credentialsRef of ['', null, '../private/nacos-credentials.json', '/tmp/secret', 'https://corp.example/secret']) {
    await denied(createNacosClient({ ...config, credentialsRef }, fixture.fetcher).list());
  }
  for (const field of ['username', 'password', 'usernameEnv', 'passwordEnv']) {
    await denied(createNacosClient({ ...config, [field]: 'synthetic' }, fixture.fetcher).list());
  }
  assert.equal(fixture.calls.length, 0);
});

test('file removal invalidates cached token, restoration and rotation require login', async t => {
  const { client, fixture, path, write } = await sandbox(t);
  await client.list();
  const before = fixture.calls.length;
  await rm(path);
  await denied(client.list()); await denied(client.detail(selected)); await denied(client.load(selected));
  assert.equal(fixture.calls.length, before);
  await write(secrets); await client.list(); await client.list();
  await write({ ...secrets, password: 'rotated-synthetic-password' }); await client.list();
  const logins = fixture.calls.filter(call => call.url.pathname.endsWith('/login'));
  assert.equal(logins.length, 3);
  assert.equal(logins.at(-1).options.body.get('password'), 'rotated-synthetic-password');
});

test('a linked private directory is rejected before remote access', async t => {
  const { root, client, fixture } = await sandbox(t);
  const directory = join(root, 'private');
  await rm(directory, { recursive: true });
  const target = join(root, 'other');
  await mkdir(target); await writeFile(join(target, 'nacos-credentials.json'), JSON.stringify(secrets));
  await symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await denied(client.list()); assert.equal(fixture.calls.length, 0);
});
