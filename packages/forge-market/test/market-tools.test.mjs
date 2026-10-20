import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketTools } from '../src/market-tools.mjs';

const entries = [
  { name: '@heluo/a', title: '网关', summary: '接入网关', version: '0.1.0', stars: 3, downloads: 1, repo: 'https://gitee.corp.example/g/a' },
  { name: '@heluo/b', title: '品牌', summary: '外观', version: '0.2.0', stars: 9, downloads: 5, repo: 'https://gitee.corp.example/g/b' },
];

const client = {
  list: async () => ({ entries }),
  detail: async (name) => entries.find((entry) => entry.name === name),
};

const call = async (tools, name, args) => {
  const found = tools.find((item) => item.name === name);
  const result = await found.execute(args);
  return JSON.parse(result.content[0].text);
};

test('search sorts by stars and filters by keyword', async () => {
  const tools = buildMarketTools(client);
  const all = await call(tools, 'market_search', {});
  assert.deepEqual(all.entries.map((e) => e.name), ['@heluo/b', '@heluo/a']);
  const filtered = await call(tools, 'market_search', { query: '网关' });
  assert.deepEqual(filtered.entries.map((e) => e.name), ['@heluo/a']);
});

test('search falls back to the cache when the service fails', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeCache } = await import('../src/cache.mjs');

  const dir = await mkdtemp(join(tmpdir(), 'forge-market-tools-'));
  const cachePath = join(dir, 'catalog.json');
  try {
    await writeCache(cachePath, entries, { now: Date.now() });
    const failing = { list: async () => { throw Object.assign(new Error('down'), { code: 'service-unavailable' }); } };
    const tools = buildMarketTools(failing, { cachePath });
    const result = await call(tools, 'market_search', {});
    assert.equal(result.source, 'cache');
    assert.equal(result.entries.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detail normalizes the entry', async () => {
  const tools = buildMarketTools(client);
  const result = await call(tools, 'market_detail', { name: '@heluo/b' });
  assert.equal(result.entry.stars, 9);
});

test('plan resolves the tag and enforces the host allowlist', async () => {
  const ok = await call(buildMarketTools(client), 'market_plan_install', { name: '@heluo/a' });
  assert.equal(ok.plan.tag, 'v0.1.0');
  const blocked = await call(buildMarketTools(client, { allowedHosts: ['other.example'] }), 'market_plan_install', { name: '@heluo/a' });
  assert.equal(blocked.reason, 'host-not-allowed');
});

test('exposes exactly the documented tools', () => {
  const tools = buildMarketTools(client);
  assert.deepEqual(tools.map((t) => t.name), [
    'market_search',
    'market_detail',
    'market_submit',
    'market_diagnostics',
    'market_check_update',
    'market_registration',
    'market_install',
    'market_plan_install',
  ]);
});

test('install runs the pipeline with injected download and extract', async () => {
  const files = [
    { path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) },
    { path: 'cordis.patch.yml', bytes: Buffer.from('insert: []\n') },
  ];
  const tools = buildMarketTools(client, {
    allowedHosts: ['gitee.corp.example'],
    install: {
      download: async () => ({ ok: true, bytes: Buffer.from('x') }),
      extract: async () => ({ ok: true, files }),
    },
  });
  const result = await call(tools, 'market_install', { name: '@heluo/a' });
  assert.equal(result.ok, true);
  assert.equal(result.installed.version, '0.1.0');
});

test('install refuses a host outside the allowlist', async () => {
  const tools = buildMarketTools(client, { allowedHosts: ['other.example'] });
  const result = await call(tools, 'market_install', { name: '@heluo/a' });
  assert.equal(result.reason, 'host-not-allowed');
});

test('submit validates tag, host and reports the review state', async () => {
  let submitted;
  const submitClient = {
    ...client,
    submit: async (payload) => {
      submitted = payload;
      return { state: 'pending' };
    },
  };
  const tools = buildMarketTools(submitClient, { allowedHosts: ['gitee.corp.example'] });
  const payload = { name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' };

  assert.deepEqual(await call(tools, 'market_submit', payload), { ok: true, state: 'pending' });
  assert.equal(submitted.tag, 'v0.1.0');
  assert.equal(submitted.name, '@heluo/a');
  assert.equal((await call(tools, 'market_submit', { ...payload, tag: '0.1.0' })).reason, 'bad-tag');
  assert.equal((await call(tools, 'market_submit', { ...payload, repo: 'https://evil.example/x' })).reason, 'host-not-allowed');
});

test('a throwing client becomes a structured failure, not a crash', async () => {
  const exploding = { list: () => { throw new Error('boom'); }, detail: () => { throw new Error('boom'); } };
  const tools = buildMarketTools(exploding);
  const result = JSON.parse((await tools.find((t) => t.name === 'market_detail').execute({ name: '@heluo/a' })).content[0].text);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'internal');
  assert.match(result.detail, /boom/);
});

test('check_update answers without touching the service state', async () => {
  const tools = buildMarketTools(client);
  const result = await call(tools, 'market_check_update', { name: '@heluo/b', installedVersion: '0.1.0' });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest, '0.2.0');
});

test('submit refuses to run without a host allowlist', async () => {
  const tools = buildMarketTools(client);
  const result = await call(tools, 'market_submit', { name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' });
  assert.equal(result.reason, 'no-allowed-host');
});

test('submit rejects a repository address it cannot parse', async () => {
  const tools = buildMarketTools(client, { allowedHosts: ['gitee.corp.example'] });
  const result = await call(tools, 'market_submit', { name: '@heluo/a', repo: 'not a url', tag: 'v0.1.0' });
  assert.equal(result.reason, 'bad-repo');
});

test('diagnostics lists refused repositories with their codes', async () => {
  const diagClient = {
    ...client,
    unindexed: async () => ({ entries: [{ repo: 'https://gitee.corp.example/g/bad', name: '@heluo/bad', errors: ['missing-file', 'bad-tag'] }] }),
  };
  const tools = buildMarketTools(diagClient);
  const result = await call(tools, 'market_diagnostics', {});
  assert.equal(result.total, 1);
  assert.deepEqual(result.entries[0].errors, ['missing-file', 'bad-tag']);
});

test('diagnostics tolerates a service that returns nothing', async () => {
  const tools = buildMarketTools({ ...client, unindexed: async () => ({}) });
  assert.deepEqual(await call(tools, 'market_diagnostics', {}), { total: 0, entries: [] });
});
