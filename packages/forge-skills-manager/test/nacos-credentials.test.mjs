import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import { fakeNacos, nacosConfig, useNacosEnvironment } from '../spec/fixtures/nacos.mjs';

beforeEach(context => useNacosEnvironment(context));

const sourceModule = async name => {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const { createNacosClient } = await sourceModule('nacos');
const plugin = await sourceModule('index');
const selected = { skillName: 'example-skill', version: '1.0.0' };
const denied = promise => assert.rejects(promise, caught => {
  assert.equal(caught.code, 'error.nacos.config');
  assert.equal(caught.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(caught) + caught.message, /synthetic|svc-ci|TEST_NACOS/);
  return true;
});

test('default and configured environment names supply all remote operations without a Host credential service', async () => {
  for (const config of [{ serverUrl: nacosConfig.serverUrl }, nacosConfig]) {
    const fixture = fakeNacos();
    const client = createNacosClient(config, fixture.fetcher);
    await client.list();
    await client.detail(selected);
    await client.load(selected);
    const logins = fixture.calls.filter(call => call.url.pathname.endsWith('/login'));
    assert.equal(logins.length, 1);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(logins[0].options.body)), { username: 'svc-ci', password: 'synthetic-password' });
  }
});

test('explicit environment names override defaults and preserve credential bytes', async () => {
  process.env.TEST_NACOS_USER = ' svc-ci ';
  process.env.TEST_NACOS_PASSWORD = ' synthetic-password ';
  const fixture = fakeNacos();
  const client = createNacosClient(nacosConfig, fixture.fetcher);
  await client.list();
  assert.equal(new URLSearchParams(fixture.calls[0].options.body).get('username'), ' svc-ci ');
  assert.equal(new URLSearchParams(fixture.calls[0].options.body).get('password'), ' synthetic-password ');
});

test('unconfigured Nacos performs no remote request', async () => {
  const client = createNacosClient(undefined, () => { throw new Error('network forbidden'); });
  assert.equal((await client.list()).configured, false);
  await assert.rejects(client.load(selected), { code: 'error.nacos.unconfigured' });
});

test('invalid environment names fail before network access', async () => {
  for (const field of ['usernameEnv', 'passwordEnv']) {
    for (const ref of ['', '../secret', 'invalid-reference', '1INVALID']) {
      const client = createNacosClient({ serverUrl: nacosConfig.serverUrl, [field]: ref },
        () => { throw new Error('network forbidden'); });
      await denied(client.list());
    }
  }
});

test('missing, empty and blank environment values reject every remote operation without falling back to defaults', async () => {
  for (const missingEnv of [nacosConfig.usernameEnv, nacosConfig.passwordEnv]) {
    const previous = process.env[missingEnv];
    for (const value of [undefined, '', '   ', '\t\r\n']) {
      if (value === undefined) delete process.env[missingEnv]; else process.env[missingEnv] = value;
      const fixture = fakeNacos();
      const client = createNacosClient(nacosConfig, fixture.fetcher);
      await denied(client.list());
      await denied(client.detail(selected));
      await denied(client.load(selected));
      assert.equal(fixture.calls.length, 0);
    }
    process.env[missingEnv] = previous;
  }
});

test('programming defects retain identity with environment credentials configured', async () => {
  for (const failure of [new ReferenceError('missing symbol'), new TypeError('bad implementation')]) {
    await assert.rejects(createNacosClient(nacosConfig, async () => { throw failure; }).list(), caught => caught === failure);
  }
});

test('credential removal blocks cached-token list, detail and download; rotation requires a new login', async () => {
  const fixture = fakeNacos();
  const client = createNacosClient(nacosConfig, fixture.fetcher);
  await client.list();
  const count = fixture.calls.length;
  delete process.env.TEST_NACOS_PASSWORD;
  await denied(client.list());
  await denied(client.detail(selected));
  await denied(client.load(selected));
  assert.equal(fixture.calls.length, count);
  process.env.TEST_NACOS_PASSWORD = 'synthetic-password';
  await client.list();
  await client.list();
  assert.equal(fixture.calls.filter(call => call.url.pathname.endsWith('/login')).length, 2);
  process.env.TEST_NACOS_PASSWORD = 'synthetic-rotated-password';
  await client.list();
  assert.equal(fixture.calls.filter(call => call.url.pathname.endsWith('/login')).length, 3);
  assert.equal(new URLSearchParams(fixture.calls.at(-2).options.body).get('password'), process.env.TEST_NACOS_PASSWORD);
  process.env.TEST_NACOS_USER = 'synthetic-rotated-user';
  await client.list();
  assert.equal(fixture.calls.filter(call => call.url.pathname.endsWith('/login')).length, 4);
  assert.equal(new URLSearchParams(fixture.calls.at(-2).options.body).get('username'), process.env.TEST_NACOS_USER);
});

test('already cancelled requests do not log in or access the remote library', async () => {
  const fixture = fakeNacos();
  const client = createNacosClient(nacosConfig, fixture.fetcher);
  const signal = AbortSignal.abort();
  await assert.rejects(client.list('', 1, signal), { code: 'error.nacos.cancelled' });
  await assert.rejects(client.detail(selected, signal), { code: 'error.nacos.cancelled' });
  await assert.rejects(client.load(selected, signal), { code: 'error.nacos.cancelled' });
  assert.equal(fixture.calls.length, 0);
});

test('real Cordis keeps local management available and reads environment credentials without a Host credential service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-nacos-credential-'));
  const keys = ['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_CODEX_HOME', 'DSH_CLAUDE_HOME', 'DSH_GEMINI_HOME', 'DSH_OPENCODE_HOME', 'DSH_CURSOR_HOME', 'DSH_COPILOT_HOME', 'DSH_WINDSURF_HOME', 'DSH_WINDSURF_USER_HOME', 'DSH_TRAE_HOME', 'DSH_TRAE_CN_HOME'];
  const previous = keys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  keys.forEach(key => { process.env[key] = join(directory, key); });
  const context = new Context(), routes = new Map(), fixture = fakeNacos();
  const prefix = '/api/forge-skills-manager';
  for (const [name, value] of Object.entries({
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    skills: { registerProvider() { return () => {}; } }, sessions: { list: () => [] },
  })) context.provide(name, value);
  const get = async path => {
    const response = await routes.get(prefix + path).fetch(new Request('http://localhost' + prefix + path));
    return { status: response.status, body: await response.json() };
  };
  try {
    delete process.env.TEST_NACOS_PASSWORD;
    globalThis.fetch = fixture.fetcher;
    const fiber = context.plugin(plugin, { nacos: nacosConfig });
    await fiber.await();
    assert.equal((await get('/state')).body.ok, true);
    const missing = await get('/nacos/list');
    assert.equal(missing.status, 503);
    assert.equal(missing.body.code, 'error.nacos.config');
    assert.equal(fixture.calls.length, 0);
    process.env.TEST_NACOS_PASSWORD = 'synthetic-password';
    const page = await get('/nacos/list');
    assert.equal(page.body.ok, true);
    assert.doesNotMatch(JSON.stringify(page.body), /synthetic-password|synthetic-read-token|svc-ci/);
    const count = fixture.calls.length;
    delete process.env.TEST_NACOS_PASSWORD;
    assert.equal((await get('/nacos/list')).status, 503);
    assert.equal(fixture.calls.length, count);
    assert.equal((await get('/state')).body.ok, true);
    await fiber.dispose();
    await fiber.await();
    assert.equal(routes.size, 0);
  } finally {
    await context.fiber.dispose();
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(directory, { recursive: true, force: true });
  }
});


test('explicit package credentials work over HTTP without environment injection and preserve bytes', async () => {
  for (const key of ['TEST_NACOS_USER', 'TEST_NACOS_PASSWORD', 'FORGE_NACOS_USERNAME', 'FORGE_NACOS_PASSWORD']) delete process.env[key];
  const fixture = fakeNacos('http://nacos.corp.example');
  const config = { serverUrl: 'http://nacos.corp.example/nacos', namespaceId: 'public', username: ' svc-ci ', password: ' synthetic-password ' };
  const client = createNacosClient(config, fixture.fetcher);
  await client.list();
  await client.detail(selected);
  await client.load(selected);
  assert.equal(fixture.calls.filter(call => call.url.pathname.endsWith('/login')).length, 1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(fixture.calls[0].options.body)), { username: config.username, password: config.password });
  assert.ok(fixture.calls.every(call => call.url.protocol === 'http:'));
});

test('partial, blank and invalid explicit credentials never fall back to existing environment values', async () => {
  for (const fields of [{ username: 'svc-ci' }, { password: 'synthetic-password' }, { username: '', password: 'synthetic-password' },
    { username: 'svc-ci', password: '   ' }, { username: 'svc-ci', password: 42 }, { username: null, password: 'synthetic-password' }]) {
    const fixture = fakeNacos();
    const client = createNacosClient({ ...nacosConfig, ...fields }, fixture.fetcher);
    await denied(client.list());
    await denied(client.detail(selected));
    await denied(client.load(selected));
    assert.equal(fixture.calls.length, 0);
  }
});

test('explicit credential removal invalidates cached tokens; rotation requires login', async () => {
  const fixture = fakeNacos();
  const config = { ...nacosConfig, username: 'svc-ci', password: 'synthetic-password' };
  const client = createNacosClient(config, fixture.fetcher);
  await client.list();
  const count = fixture.calls.length;
  config.password = '';
  await denied(client.list());
  assert.equal(fixture.calls.length, count);
  config.password = 'synthetic-rotated-password';
  await client.list();
  assert.equal(fixture.calls.filter(call => call.url.pathname.endsWith('/login')).length, 2);
  assert.equal(new URLSearchParams(fixture.calls.at(-2).options.body).get('password'), config.password);
});
