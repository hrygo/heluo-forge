import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceClient } from '../src/client.mjs';
import { normalizeEntry } from '../src/catalog.mjs';

// 端点集合来自 docs/design/services/market-index.md §5「端点（示意）」。
// 客户端改了路径而文档没改，或文档改了客户端没跟，这里先红。
const DOCUMENTED = [
  ['list', 'GET', '/api/plugins'],
  ['detail', 'GET', '/api/plugins/%40heluo%2Fa'],
  ['submit', 'POST', '/api/plugins'],
  ['metrics', 'GET', '/api/metrics?plugin=%40heluo%2Fa'],
];

test('the client speaks exactly the documented endpoints', async () => {
  const seen = [];
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    fetchImpl: (url, init) => {
      seen.push([init.method ?? 'GET', new URL(url).pathname + new URL(url).search]);
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    },
  });

  await client.list();
  await client.detail('@heluo/a');
  await client.submit({ repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0', title: 'x' });
  await client.metrics('@heluo/a');

  assert.deepEqual(seen, DOCUMENTED.map(([, method, path]) => [method, path]));
});

test('submit sends JSON with a content type', async () => {
  let init;
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    fetchImpl: (url, request) => {
      init = request;
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ state: 'pending' }) });
    },
  });

  await client.submit({ repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0', title: 'x' });
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(init.body).tag, 'v0.1.0');
});

test('submit sends only the fields DESIGN-012 declares', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const doc = await readFile(join(root, 'docs/design/services/market-index.md'), 'utf8');
  const section = doc.slice(doc.indexOf('**提交请求体**'), doc.indexOf('**并发**'));
  const documented = [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((match) => match[1]);
  assert.ok(documented.length >= 3, 'expected a documented request body');

  let sent;
  const client = createServiceClient({
    baseUrl: 'https://plugins.corp.example',
    fetchImpl: (url, init) => {
      sent = JSON.parse(init.body);
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    },
  });

  await client.submit({ name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0', summary: '', scenarios: [] });
  assert.deepEqual(Object.keys(sent).sort(), documented.sort());
});

test('every documented entry field survives normalization', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const doc = await readFile(join(root, 'docs/design/services/market-index.md'), 'utf8');
  const section = doc.slice(doc.indexOf('字段级约定'), doc.indexOf('### 5.1'));
  const documented = [...section.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((match) => match[1]);
  assert.ok(documented.length >= 5, 'expected a documented field table');

  const normalized = normalizeEntry({
    name: '@heluo/a',
    title: '网关',
    summary: '接入',
    scenarios: ['日常问答'],
    maintainer: '平台组',
    repo: 'https://gitee.corp.example/g/a',
    status: 'listed',
    version: '0.1.0',
    versions: [{ version: '0.1.0', tag: 'v0.1.0', archiveUrl: 'https://gitee.corp.example/g/a.tar.gz', engines: '>=0.2.1', submittedAt: '2026-10-20T00:00:00Z' }],
    downloads: 1,
    stars: 2,
  });
  assert.equal(normalized.ok, true);

  const present = new Set(Object.keys(normalized.entry));
  for (const version of normalized.entry.versions) for (const key of Object.keys(version)) present.add(key);
  const missing = documented.filter((field) => !present.has(field));
  assert.deepEqual(missing, [], `fields lost by normalization: ${missing.join(', ')}`);
});
