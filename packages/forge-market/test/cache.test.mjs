import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCache, writeCache } from '../src/cache.mjs';

const temp = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-market-cache-'));
  try {
    return await fn(join(dir, 'catalog.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('round-trips entries with a timestamp', async () => {
  await temp(async (path) => {
    assert.equal((await writeCache(path, [{ name: '@heluo/a' }], { now: 1000 })).ok, true);
    const read = await readCache(path, { now: 2000 });
    assert.equal(read.ok, true);
    assert.equal(read.savedAt, 1000);
    assert.equal(read.stale, false);
  });
});

test('marks a cache older than the ttl as stale', async () => {
  await temp(async (path) => {
    await writeCache(path, [], { now: 0 });
    assert.equal((await readCache(path, { ttlMs: 10, now: 100 })).stale, true);
  });
});

test('reports missing and malformed caches separately', async () => {
  await temp(async (path) => {
    assert.equal((await readCache(path)).reason, 'missing');
    await writeFile(path, '{"entries": "nope"}');
    assert.equal((await readCache(path)).reason, 'bad-cache');
  });
});

test('an unreadable timestamp counts as stale rather than fresh', async () => {
  await temp(async (path) => {
    await writeFile(path, JSON.stringify({ savedAt: 'yesterday', entries: [] }));
    const read = await readCache(path, { now: Date.now() });
    assert.equal(read.stale, true);
  });
});

test('reports a failed write instead of throwing', async () => {
  await temp(async (path) => {
    const { writeCache } = await import('../src/cache.mjs');
    const result = await writeCache(join(path, '..'), []);
    assert.equal(result.reason, 'write-failed');
  });
});
