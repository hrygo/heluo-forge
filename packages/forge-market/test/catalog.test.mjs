import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, normalizeEntry, sortEntries } from '../src/catalog.mjs';

const entry = (name, stars, downloads) => ({
  name,
  title: name,
  summary: 's',
  scenarios: ['日常问答'],
  version: '0.1.0',
  engines: { dsh: '>=0.2.1' },
  stars,
  downloads,
});

test('normalizes a complete entry', () => {
  const result = normalizeEntry({ ...entry('@heluo/a', 1, 2), maintainer: '平台组', repo: 'https://gitee.corp.example/a' });
  assert.equal(result.ok, true);
  assert.equal(result.entry.stars, 1);
  assert.equal(result.entry.engines, '>=0.2.1');
});

test('reports missing fields instead of inventing them', () => {
  assert.deepEqual(normalizeEntry({ title: 'x' }).detail, ['name', 'version']);
});

test('sorts by stars, then downloads, then name', () => {
  const sorted = sortEntries([entry('b', 1, 9), entry('a', 1, 9), entry('c', 2, 0)]);
  assert.deepEqual(sorted.map((item) => item.name), ['c', 'a', 'b']);
  const byDownloads = sortEntries([entry('a', 0, 1), entry('b', 0, 5)], 'downloads');
  assert.deepEqual(byDownloads.map((item) => item.name), ['b', 'a']);
});

test('filters on title, summary and scenarios', () => {
  const items = [entry('@heluo/a', 0, 0), { ...entry('@heluo/b', 0, 0), summary: '网关接入' }];
  assert.deepEqual(filterEntries(items, '网关').map((i) => i.name), ['@heluo/b']);
  assert.deepEqual(filterEntries(items, '日常').map((i) => i.name), ['@heluo/a', '@heluo/b']);
});
