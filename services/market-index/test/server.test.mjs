import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMarketApp } from '../server.mjs';

const entries = [
  { name: '@heluo/a', title: '网关', summary: '接入', version: '0.1.0', stars: 2, downloads: 9 },
  { name: '@heluo/b', title: '品牌', version: '0.2.0', stars: 7, downloads: 1 },
];

function listen(app) {
  const server = createServer((req, res) => void app(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('serves the catalog sorted by stars and filters by keyword', async () => {
  const app = createMarketApp({ entries });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const all = await (await fetch(`${base}/api/plugins`)).json();
    assert.deepEqual(all.entries.map((e) => e.name), ['@heluo/b', '@heluo/a']);
    const filtered = await (await fetch(`${base}/api/plugins?q=网关`)).json();
    assert.deepEqual(filtered.entries.map((e) => e.name), ['@heluo/a']);
    const byDownloads = await (await fetch(`${base}/api/plugins?sort=downloads`)).json();
    assert.deepEqual(byDownloads.entries.map((e) => e.name), ['@heluo/a', '@heluo/b']);
    const detail = await (await fetch(`${base}/api/plugins/${encodeURIComponent('@heluo/a')}`)).json();
    assert.equal(detail.title, '网关');
    const metrics = await (await fetch(`${base}/api/metrics?plugin=${encodeURIComponent('@heluo/b')}`)).json();
    assert.deepEqual(metrics, { downloads: 1, stars: 7 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('accepts a submission into the review queue and rejects a bad one', async () => {
  const reviews = [];
  const app = createMarketApp({ entries, reviews });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/plugins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@heluo/c', repo: 'https://gitee.corp.example/g/c', tag: 'v0.1.0' }),
    });
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { state: 'pending' });
    assert.equal(reviews.length, 1);

    const badTag = await fetch(`${base}/api/plugins`, { method: 'POST', body: JSON.stringify({ name: '@heluo/c', repo: 'r', tag: '0.1.0' }) });
    assert.equal(badTag.status, 400);
    const missing = await fetch(`${base}/api/plugins`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('answers 404 for unknown paths and details', async () => {
  const app = createMarketApp({ entries });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/plugins/@heluo%2Fzzz`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/admin/unindexed`)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
