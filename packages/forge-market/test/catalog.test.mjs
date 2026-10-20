import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, filterEntries, normalizeEntry, normalizeVersion, pickUpdate, sortEntries } from '../src/catalog.mjs';

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

test('keeps an explicit tag and archive when the service supplies them', () => {
  const result = normalizeEntry({
    ...entry('@heluo/a', 0, 0),
    versions: [
      { version: '0.1.0', tag: 'release-0.1.0', archiveUrl: 'https://gitee.corp.example/a/archive/release-0.1.0.tar.gz', engines: '>=0.3.0' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.version, '0.1.0');
  assert.equal(result.entry.versions[0].tag, 'release-0.1.0');
  assert.equal(result.entry.engines, '>=0.3.0');
  assert.equal(result.entry.status, 'listed');
});

test('derives a tag only when the service omits one', () => {
  assert.deepEqual(normalizeVersion('0.2.0'), { version: '0.2.0', tag: 'v0.2.0' });
});

test('defaults title to the package name', () => {
  const result = normalizeEntry({ name: '@heluo/a', version: '0.1.0' });
  assert.equal(result.entry.title, '@heluo/a');
});

test('compares versions numerically, not as strings', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1);
});

test('reports an update only when the listed version is newer', () => {
  const entry = normalizeEntry({ name: '@heluo/a', version: '0.3.0', versions: ['0.2.0', '0.3.0'] }).entry;
  assert.deepEqual(pickUpdate(entry, '0.2.0'), { updateAvailable: true, installed: '0.2.0', latest: '0.3.0', reason: null });
  assert.equal(pickUpdate(entry, '0.3.0').updateAvailable, false);
  assert.equal(pickUpdate(entry, '').reason, 'no-installed-version');
});

test('never suggests a withdrawn version', () => {
  const entry = normalizeEntry({
    name: '@heluo/a',
    version: '0.3.0',
    versions: [
      { version: '0.2.0', tag: 'v0.2.0' },
      { version: '0.3.0', tag: 'v0.3.0', revoked: true },
    ],
  }).entry;
  assert.deepEqual(pickUpdate(entry, '0.2.0'), { updateAvailable: false, installed: '0.2.0', latest: '0.2.0', reason: 'up-to-date' });
});

test('asks an installed withdrawn version to move, even to an older one', () => {
  const entry = normalizeEntry({
    name: '@heluo/a',
    version: '0.3.0',
    versions: [
      { version: '0.2.0', tag: 'v0.2.0' },
      { version: '0.3.0', tag: 'v0.3.0', revoked: true },
    ],
  }).entry;
  const result = pickUpdate(entry, '0.3.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.reason, 'installed-revoked');
  assert.equal(result.latest, '0.2.0');
});

test('reports when every version is withdrawn', () => {
  const entry = normalizeEntry({ name: '@heluo/a', version: '0.1.0', versions: [{ version: '0.1.0', revoked: true }] }).entry;
  assert.equal(pickUpdate(entry, '0.1.0').reason, 'no-latest-version');
});
