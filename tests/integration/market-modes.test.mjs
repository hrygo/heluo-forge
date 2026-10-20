import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketApp } from '../../services/market-index/server.mjs';
import { createLocalCatalog } from '../../packages/forge-market/src/local-catalog.mjs';
import { createServiceClient } from '../../packages/forge-market/src/client.mjs';
import { buildMarketTools } from '../../packages/forge-market/src/market-tools.mjs';

const entries = [
  {
    name: '@heluo/demo',
    title: '演示',
    version: '0.2.0',
    versions: [
      { version: '0.1.0', tag: 'v0.1.0' },
      { version: '0.2.0', tag: 'v0.2.0', revoked: true },
    ],
    repo: 'https://gitee.corp.example/g/demo',
    stars: 1,
    downloads: 0,
  },
];

const installDeps = {
  download: async () => ({ ok: true, bytes: Buffer.from('x') }),
  extract: async () => ({
    ok: true,
    files: [{ path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/demo', version: '0.1.0' })) }],
  }),
};

async function bothModes(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'market-parity-'));
  const catalogFile = join(dir, 'catalog.json');
  await writeFile(catalogFile, JSON.stringify({ entries }));
  const server = createServer((req, res) => void createMarketApp({ entries: structuredClone(entries) })(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({
      local: buildMarketTools(createLocalCatalog(catalogFile), { allowedHosts: ['gitee.corp.example'], install: installDeps }),
      service: buildMarketTools(createServiceClient({ baseUrl: base }), { allowedHosts: ['gitee.corp.example'], install: installDeps }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

const call = async (tools, name, args) =>
  JSON.parse((await tools.find((tool) => tool.name === name).execute(args)).content[0].text);

test('both sources rank and describe the same entry', async () => {
  await bothModes(async ({ local, service }) => {
    const a = await call(local, 'market_search', {});
    const b = await call(service, 'market_search', {});
    assert.equal(a.entries[0].name, b.entries[0].name);
    assert.equal(a.entries[0].versions[1].revoked, true);
    assert.equal(b.entries[0].versions[1].revoked, true);
  });
});

test('both sources skip a revoked version and refuse it explicitly', async () => {
  await bothModes(async ({ local, service }) => {
    for (const tools of [local, service]) {
      assert.equal((await call(tools, 'market_plan_install', { name: '@heluo/demo' })).plan.version, '0.1.0');
      assert.equal((await call(tools, 'market_plan_install', { name: '@heluo/demo', version: '0.2.0' })).reason, 'version-revoked');
      assert.equal((await call(tools, 'market_install', { name: '@heluo/demo', version: '0.2.0' })).reason, 'version-revoked');
    }
  });
});

test('both sources install the available version', async () => {
  await bothModes(async ({ local, service }) => {
    const a = await call(local, 'market_install', { name: '@heluo/demo' });
    const b = await call(service, 'market_install', { name: '@heluo/demo' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.installed.version, b.installed.version);
  });
});
