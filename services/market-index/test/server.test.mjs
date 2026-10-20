import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMarketApp } from '../server.mjs';

const entries = [
  { name: '@heluo/a', title: '网关', summary: '接入', version: '0.1.0', versions: [{ version: '0.1.0', tag: 'v0.1.0' }], stars: 2, downloads: 9 },
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
    assert.equal(detail.entry.title, '网关');
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

test('submission, approval and revocation follow one path', async () => {
  const app = createMarketApp({ entries: [] });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/plugins', { name: '@heluo/c', repo: 'https://gitee.corp.example/g/c', tag: 'v0.1.0' })).status, 202);
    assert.deepEqual((await (await fetch(`${base}/api/plugins`)).json()).entries, []);

    assert.equal((await post('/api/admin/review', { name: '@heluo/c', action: 'approve' })).status, 200);
    const listed = (await (await fetch(`${base}/api/plugins`)).json()).entries;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'listed');
    assert.equal(listed[0].version, '0.1.0');

    assert.equal((await post('/api/admin/review', { name: '@heluo/c', action: 'revoke' })).status, 200);
    assert.deepEqual((await (await fetch(`${base}/api/plugins`)).json()).entries, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('review rejects unknown actions and unknown names', async () => {
  const app = createMarketApp({ entries });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/admin/review', { name: '@heluo/a', action: 'delete' })).status, 400);
    assert.equal((await post('/api/admin/review', { name: '@heluo/zzz', action: 'approve' })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('counts one download per machine and day', async () => {
  const day = '2026-10-20';
  const app = createMarketApp({ entries: structuredClone(entries), today: () => day });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const hit = (machine) => fetch(`${base}/api/plugins/@heluo%2Fa/versions/0.1.0/download`, { headers: { 'x-machine-hash': machine } }).then((r) => r.json());
  try {
    const first = await hit('m1');
    assert.equal(first.counted, true);
    assert.match(first.url, /archive\/refs\/tags\/v0\.1\.0\.tar\.gz$/);
    assert.equal((await hit('m1')).counted, false);
    assert.equal((await hit('m2')).counted, true);
    const metrics = await (await fetch(`${base}/api/metrics?plugin=${encodeURIComponent('@heluo/a')}`)).json();
    assert.equal(metrics.downloads, 11);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unknown version is refused and an anonymous hit counts once a day', async () => {
  const app = createMarketApp({ entries: structuredClone(entries), today: () => '2026-10-21' });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/plugins/@heluo%2Fa/versions/9.9.9/download`)).status, 404);
    await fetch(`${base}/api/plugins/@heluo%2Fa/versions/0.1.0/download`);
    await fetch(`${base}/api/plugins/@heluo%2Fa/versions/0.1.0/download`);
    const metrics = await (await fetch(`${base}/api/metrics?plugin=${encodeURIComponent('@heluo/a')}`)).json();
    assert.equal(metrics.downloads, 10);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a revoked version refuses downloads while the entry stays listed', async () => {
  const app = createMarketApp({ entries: structuredClone(entries) });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/admin/review', { name: '@heluo/a', action: 'revoke', version: '0.1.0' })).status, 200);
    const download = await fetch(`${base}/api/plugins/@heluo%2Fa/versions/0.1.0/download`);
    assert.equal(download.status, 409);
    assert.equal((await download.json()).error, 'version-revoked');
    const listed = (await (await fetch(`${base}/api/plugins`)).json()).entries;
    const revoked = listed.find((entry) => entry.name === '@heluo/a');
    assert.equal(revoked.versions[0].revoked, true);
    assert.equal((await post('/api/admin/review', { name: '@heluo/a', action: 'revoke', version: '9.9.9' })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('approval keeps the submitted title, summary and scenarios', async () => {
  const app = createMarketApp({ entries: [] });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    await post('/api/plugins', {
      name: '@heluo/d',
      repo: 'https://gitee.corp.example/g/d',
      tag: 'v0.1.0',
      title: '数据同步',
      summary: '把订单同步到仓库',
      scenarios: ['夜间批处理'],
    });
    await post('/api/admin/review', { name: '@heluo/d', action: 'approve' });
    const detail = await (await fetch(`${base}/api/plugins/${encodeURIComponent('@heluo/d')}`)).json();
    assert.equal(detail.entry.title, '数据同步');
    assert.equal(detail.entry.summary, '把订单同步到仓库');
    assert.deepEqual(detail.entry.scenarios, ['夜间批处理']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
