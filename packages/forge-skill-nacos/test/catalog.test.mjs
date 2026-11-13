import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalog } from '../src/catalog.mjs';
import { createCredentialReader } from '../src/credentials.mjs';
import { validateConfig } from '../src/config.mjs';
import { REASONS } from '../src/errors.mjs';
import { baseConfig, skillPackage, startMockNacos } from './helpers.mjs';

const SKILLS = [
  {
    name: 'code-review-std',
    description: '提交前代码评审标准流程',
    versions: [
      { version: '1.4.2', status: 'online', updateTime: 1, zip: skillPackage('code-review-std', { version: '1.4.2' }) },
      { version: '1.5.0', status: 'online', updateTime: 2, zip: skillPackage('code-review-std', { version: '1.5.0' }) },
      { version: '1.6.0-rc1', status: 'draft', updateTime: 3, zip: skillPackage('code-review-std', { version: '1.6.0-rc1' }) },
    ],
  },
  { name: 'api-doc-gen', description: '接口文档生成', versions: [{ version: '2.0.0', status: 'online', updateTime: 1 }] },
];

async function makeCatalog(overrides = {}, serverOverrides = {}) {
  const server = await startMockNacos({ skills: SKILLS, ...serverOverrides });
  const config = validateConfig(baseConfig(server.url, overrides));
  const ctx = { get: (key) => (key === 'credentials'
    ? { readRecord: async () => ({ kind: 'grant', payload: { username: 'nacos', password: 'nacos' } }) }
    : undefined) };
  return { catalog: createCatalog(config, createCredentialReader(ctx, 'test-cred')), server, config };
}

test('console-list mode lists the catalog after login-for-token', async (t) => {
  const { catalog, server } = await makeCatalog();
  t.after(async () => server.close());
  const { items, total } = await catalog.list({ page: 1, pageSize: 10 });
  assert.equal(total, 2);
  assert.deepEqual(items.map((item) => item.name), ['code-review-std', 'api-doc-gen']);
  // 登录恰好一次；除登录外所有请求都携带 accessToken 查询参数。
  const logins = server.requests.filter((request) => request.path === '/v3/auth/user/login');
  assert.equal(logins.length, 1);
  assert.ok(server.requests.filter((request) => request.path !== '/v3/auth/user/login')
    .every((request) => request.query.get('accessToken') === 'mock-access-token'));
});

test('consoleEndpoint overrides the console base while download stays on endpoint', async (t) => {
  const consoleSide = await startMockNacos({ skills: [] });
  const clientSide = await startMockNacos({ skills: SKILLS });
  t.after(async () => { await consoleSide.close(); await clientSide.close(); });
  const config = validateConfig(baseConfig(clientSide.url, { consoleEndpoint: consoleSide.url }));
  const ctx = { get: (key) => (key === 'credentials'
    ? { readRecord: async () => ({ kind: 'grant', payload: { username: 'nacos', password: 'nacos' } }) }
    : undefined) };
  const catalog = createCatalog(config, createCredentialReader(ctx, 'test-cred'));
  const { total } = await catalog.list({}); // 目录走 consoleSide（空目录）
  assert.equal(total, 0);
  const bytes = await catalog.download('code-review-std', '1.5.0'); // 下载走 clientSide
  assert.ok(bytes.byteLength > 100);
  await consoleSide.close();
  await clientSide.close();
});

test('client-search and config-index routes work and mode mismatch stays local', async (t) => {
  const search = await makeCatalog({ catalogMode: 'client-search' });
  t.after(async () => search.server.close());
  assert.equal((await search.catalog.list({})).total, 2);

  const index = await makeCatalog({ catalogMode: 'config-index', configIndexDataId: 'skill-index.json' });
  t.after(async () => index.server.close());
  const meta = await index.catalog.getMeta('api-doc-gen');
  assert.equal(meta.versions[0].version, '2.0.0');
});

test('version resolution pins exact versions and refuses offline ones', async (t) => {
  const { catalog, server } = await makeCatalog();
  t.after(async () => server.close());
  const meta = await catalog.getMeta('code-review-std');

  const exact = catalog.resolveVersion(meta, { version: '1.4.2' });
  assert.deepEqual(exact, { version: '1.4.2', requestedRef: 'version:1.4.2' });

  const latest = catalog.resolveVersion(meta, { label: 'stable' });
  assert.equal(latest.version, '1.5.0'); // 1.6.0-rc1 是 draft，不参与

  assert.throws(() => catalog.resolveVersion(meta, { version: '1.6.0-rc1' }), (error) => error.code === REASONS.NOT_FOUND);
  assert.throws(() => catalog.resolveVersion(meta, { version: '9.9.9' }), (error) => error.code === REASONS.NOT_FOUND);
});

test('download returns the exact-version zip bytes', async (t) => {
  const { catalog, server } = await makeCatalog();
  t.after(async () => server.close());
  const bytes = await catalog.download('code-review-std', '1.5.0');
  assert.ok(bytes.byteLength > 100);
  const download = server.requests.find((request) => request.path === '/v3/client/ai/skills');
  assert.equal(download.query.get('version'), '1.5.0');
  await assert.rejects(catalog.download('code-review-std', '9.9.9'), (error) => error.code === REASONS.NOT_FOUND);
});

test('403 maps to FORBIDDEN without anonymous fallback; timeouts map to NETWORK', async (t) => {
  const forbidden = await makeCatalog({}, { requireAuth: true });
  t.after(async () => forbidden.server.close());
  const anonCtx = { get: () => undefined };
  const brokenCatalog = createCatalog(
    forbidden.config,
    createCredentialReader(anonCtx, 'missing'),
  );
  await assert.rejects(brokenCatalog.list({}), (error) => error.code === REASONS.AUTH_MISSING);

  const slow = await makeCatalog({ requestTimeoutMs: 150 }, { delayMs: 500 });
  t.after(async () => slow.server.close());
  await assert.rejects(slow.catalog.list({}), (error) => error.code === REASONS.NETWORK);
});

test('an unknown skill detail surfaces NOT_FOUND through the result envelope', async (t) => {
  const { catalog, server } = await makeCatalog();
  t.after(async () => server.close());
  await assert.rejects(catalog.getMeta('ghost-skill'), (error) => error.code === REASONS.CATALOG_INVALID);
});
