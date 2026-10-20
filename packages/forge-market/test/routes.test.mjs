import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketRoutes, loadCatalog } from '../src/routes.mjs';
import { writeCache } from '../src/cache.mjs';

const entries = [{ name: '@heluo/a', title: '网关', version: '0.1.0', stars: 2, downloads: 1 }];
const client = { list: async () => ({ entries }), detail: async (name) => entries.find((e) => e.name === name) };

function fake(method, url) {
  const res = { statusCode: 0, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
  return { req: { method, url }, res };
}

test('serves the catalog from the service', async () => {
  const handle = createMarketRoutes({ client });
  const { req, res } = fake('GET', '/api/forge-market/catalog');
  await handle(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).entries.map((e) => e.name), ['@heluo/a']);
});

test('serves a detail and 404s an unknown one', async () => {
  const handle = createMarketRoutes({ client });
  const hit = fake('GET', '/api/forge-market/detail/@heluo%2Fa');
  await handle(hit.req, hit.res);
  assert.equal(hit.res.statusCode, 200);
  const miss = fake('GET', '/api/forge-market/detail/@heluo%2Fzzz');
  await handle(miss.req, miss.res);
  assert.equal(miss.res.statusCode, 404);
});

test('falls back to the cache when the service is down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-market-routes-'));
  const cachePath = join(dir, 'catalog.json');
  try {
    await writeCache(cachePath, entries, { now: Date.now() });
    const handle = createMarketRoutes({ client: { list: async () => { throw new Error('down'); } }, cachePath });
    const { req, res } = fake('GET', '/api/forge-market/catalog');
    await handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).source, 'cache');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects writes and unknown paths', async () => {
  const handle = createMarketRoutes({ client });
  const post = fake('POST', '/api/forge-market/catalog');
  await handle(post.req, post.res);
  assert.equal(post.res.statusCode, 405);
  const unknown = fake('GET', '/api/forge-market/nope');
  await handle(unknown.req, unknown.res);
  assert.equal(unknown.res.statusCode, 404);
});

test('reports 503 without a cache', async () => {
  const result = await loadCatalog({ list: async () => { throw new Error('down'); } }, null);
  assert.equal(result.status, 503);
});
