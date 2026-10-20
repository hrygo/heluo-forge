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

test('unknown tools are absent rather than failing silently', () => {
  const tools = buildMarketTools(client);
  assert.deepEqual(tools.map((t) => t.name), ['market_search', 'market_detail', 'market_plan_install']);
});
