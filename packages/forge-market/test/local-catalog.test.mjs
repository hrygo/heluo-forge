import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCatalog } from '../src/local-catalog.mjs';
import { apply } from '../src/index.mjs';

const withCatalog = async (body, fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-market-local-'));
  const path = join(dir, 'catalog.json');
  try {
    await writeFile(path, JSON.stringify(body));
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('lists entries from a local file and 404s an unknown name', async () => {
  await withCatalog({ entries: [{ name: '@heluo/a', title: 'a', version: '0.1.0' }] }, async (path) => {
    const catalog = createLocalCatalog(path);
    assert.equal((await catalog.list()).entries.length, 1);
    await assert.rejects(() => catalog.detail('@heluo/zzz'), (error) => error.status === 404);
  });
});

test('accepts a bare array file and rejects a shapeless one', async () => {
  await withCatalog([{ name: '@heluo/a', title: 'a', version: '0.1.0' }], async (path) => {
    assert.equal((await createLocalCatalog(path).list()).entries.length, 1);
  });
  await withCatalog({ nope: true }, async (path) => {
    await assert.rejects(() => createLocalCatalog(path).list());
  });
});

test('submission is refused in local mode', async () => {
  await withCatalog({ entries: [] }, async (path) => {
    await assert.rejects(() => createLocalCatalog(path).submit({}), (error) => error.code === 'read-only');
  });
});

test('apply accepts a catalog file instead of a service url', async () => {
  await withCatalog({ entries: [{ name: '@heluo/a', title: 'a', version: '0.1.0' }] }, async (path) => {
    const registered = [];
    const dispose = apply({ tools: { register: (tool) => { registered.push(tool); return () => {}; } } }, { catalogFile: path });
    assert.equal(registered.length, 8);
    const search = registered.find((tool) => tool.name === 'market_search');
    const result = JSON.parse((await search.execute({})).content[0].text);
    assert.equal(result.total, 1);
    dispose();
  });
});

test('apply refuses to start with neither source', () => {
  assert.throws(() => apply({ tools: { register: () => () => {} } }, {}), /serviceUrl or catalogFile/);
});
