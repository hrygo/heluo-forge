/**
 * Gitee 配置端点（T1 / TECHNICAL §3.2）：状态码矩阵、预检头、体积上限、零泄漏。
 *
 * 这一组用例只回答 HTTP 面上的事，不碰磁盘：`access` 是内存假实现，`now` 显式注入。
 * 契约里写死的几条在这里逐条锁住——缺预检头 400、超 64KB **413**、冲突 409、非法 422、
 * 不可用 503、只 GET/POST、全响应 `no-store` + `nosniff`、`applied` 原样透传。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITEE_API_PREFIX,
  GITEE_CONFIG_ROUTE,
  GITEE_MAX_BODY,
  GITEE_REQUEST_HEADER,
  createGiteeApi,
  toNodeRoute,
} from '../src/http.mjs';
import { GITEE_ACCESS_REASONS } from '../src/config-access.mjs';

const AT = '2026-11-06T10:00:00.000Z';
const SNAPSHOT = Object.freeze({ revision: 'abcdef0123456789', ready: true, entries: {} });
const WRITE_HEADERS = Object.freeze({ [GITEE_REQUEST_HEADER]: '1', 'content-type': 'application/json' });

/** 假 access：`save` 的返回值由用例指定，`calls` 记录被问了几次。 */
function makeAccess({ save = null, snapshot = () => SNAPSHOT } = {}) {
  const calls = { snapshot: 0, save: 0, last: null };
  const access = {
    entryId: 'heluo-gitee',
    revision: () => SNAPSHOT.revision,
    snapshot(options) {
      calls.snapshot += 1;
      return snapshot(options);
    },
    describe: () => ({ entryId: 'heluo-gitee', entries: {} }),
    async save(options) {
      calls.save += 1;
      calls.last = options;
      return save === null ? { ok: true, snapshot: SNAPSHOT } : save(options);
    },
  };
  return { access, calls };
}

const makeApi = (options = {}) => createGiteeApi({ access: options.access, snapshot: options.snapshot, now: () => Date.parse(AT) });

const post = (api, body, headers = WRITE_HEADERS) =>
  api.handlePost({ headers, rawBody: typeof body === 'string' ? body : JSON.stringify(body) });

test('常量：前缀 / 端点 / 预检头 / 上限与契约逐字一致', () => {
  assert.equal(GITEE_API_PREFIX, '/api/forge-gitee');
  assert.equal(GITEE_CONFIG_ROUTE, '/api/forge-gitee/config');
  assert.equal(GITEE_REQUEST_HEADER, 'x-forge-gitee-request');
  assert.equal(GITEE_MAX_BODY, 64 * 1024);
});

test('GET: 200 + no-store/nosniff + 时间戳头，响应体就是快照', () => {
  const { access } = makeAccess();
  const result = makeApi({ access }).handleGet({ query: undefined });

  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['x-forge-gitee-at'], AT);
  assert.equal(result.headers['access-control-allow-origin'], undefined, '不设 CORS 头');
  assert.deepEqual(result.body, SNAPSHOT);
});

test('GET ?refresh=1 把重建交给注入源（路由不知道"重建读面"这件事）', () => {
  const seen = [];
  const api = createGiteeApi({
    access: makeAccess().access,
    snapshot: (request) => {
      seen.push(request);
      return SNAPSHOT;
    },
    now: () => Date.parse(AT),
  });

  api.handleGet({ query: new URLSearchParams('refresh=1') });
  api.handleGet({ query: new URLSearchParams('') });

  assert.deepEqual(seen, [{ refresh: true }, { refresh: false }], '只有 refresh=1 才重建');
});

test('GET: 无 access → 503（装配未完成不是 500）', () => {
  const result = makeApi().handleGet({});
  assert.equal(result.status, 503);
  assert.equal(result.body.code, GITEE_ACCESS_REASONS.UNAVAILABLE);
});

test('GET: 读失败只回原因码与下一步，不带 error.message（AC-12）', () => {
  const api = createGiteeApi({
    access: makeAccess().access,
    snapshot: () => {
      throw new Error('ENOENT: /srv/qa/.dsh/profiles/qa/dsh.patch.yml');
    },
    now: () => Date.parse(AT),
  });

  const result = api.handleGet({});

  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'GITEE_SNAPSHOT_FAILED');
  const text = JSON.stringify(result.body);
  assert.ok(!text.includes('/srv/qa'), '不得回显绝对路径');
  assert.equal(result.body.detail.reason, 'GITEE_SNAPSHOT_FAILED');
  assert.ok(result.body.detail.next.includes('Gitee'), '下一步给页面入口');
});

test('POST: 缺同源预检头 / 非 JSON 内容类型 / 顶层多键 → 400 且不写盘', async () => {
  const { access, calls } = makeAccess();
  const api = makeApi({ access });

  const noHeader = await post(api, { revision: 'x', fields: {} }, { 'content-type': 'application/json' });
  assert.equal(noHeader.status, 400);

  const wrongType = await post(api, { revision: 'x', fields: {} }, { [GITEE_REQUEST_HEADER]: '1', 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 400);

  const extraKey = await post(api, { revision: 'x', fields: {}, force: true });
  assert.equal(extraKey.status, 400);
  assert.deepEqual(extraKey.body.errors, { force: '未知字段' });

  assert.equal(calls.save, 0, '请求不合法时一次都不写');
});

test('POST: fields 非对象 / revision 非字符串 / 未知配置项 → 400', async () => {
  const { access, calls } = makeAccess();
  const api = makeApi({ access });

  assert.equal((await post(api, { revision: 'x', fields: [] })).status, 400);
  assert.equal((await post(api, { revision: 1, fields: {} })).status, 400);
  assert.equal((await post(api, { revision: 'x', fields: { gitCwd: '/tmp' } })).status, 400);
  assert.equal(calls.save, 0);
});

test('POST: 请求体超 64KB → 413（不是 400：形状没错，只是太大）', async () => {
  const { access, calls } = makeAccess();
  const api = makeApi({ access });
  const oversized = JSON.stringify({ revision: 'x', fields: { cliPath: 'a'.repeat(GITEE_MAX_BODY) } });

  const result = await post(api, oversized);

  assert.equal(result.status, 413);
  assert.equal(result.body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(calls.save, 0);
});

test('POST: 成功回 {ok,snapshot} 并原样透传 applied（保存 ≠ 已应用）', async () => {
  const { access, calls } = makeAccess({
    save: () => ({ ok: true, snapshot: SNAPSHOT, applied: { ok: false, reason: 'GITEE_REBUILD_FAILED' } }),
  });
  const api = makeApi({ access });

  const result = await post(api, { revision: SNAPSHOT.revision, fields: { timeoutMs: 30000 } });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.snapshot, SNAPSHOT);
  assert.deepEqual(result.body.applied, { ok: false, reason: 'GITEE_REBUILD_FAILED' });
  assert.deepEqual(calls.last, { revision: SNAPSHOT.revision, fields: { timeoutMs: 30000 } });
});

test('POST: 没有 applied 时不编一个"已应用"出来', async () => {
  const { access } = makeAccess();
  const result = await post(makeApi({ access }), { revision: SNAPSHOT.revision, fields: {} });

  assert.equal(result.status, 200);
  assert.equal(result.body.applied, undefined);
});

test('POST: 409 / 422 / 503 三条失败面逐条映射', async () => {
  const conflict = await post(
    makeApi({ access: makeAccess({ save: () => ({ ok: false, code: GITEE_ACCESS_REASONS.CONFLICT, message: '配置已在别处修改' }) }).access }),
    { revision: 'stale', fields: {} },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, GITEE_ACCESS_REASONS.CONFLICT);

  const invalid = await post(
    makeApi({
      access: makeAccess({
        save: () => ({ ok: false, code: GITEE_ACCESS_REASONS.INVALID, errors: { timeoutMs: '超时必须是 1000–600000' } }),
      }).access,
    }),
    { revision: SNAPSHOT.revision, fields: { timeoutMs: 1 } },
  );
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body.errors, { timeoutMs: '超时必须是 1000–600000' });

  const unavailable = await post(
    makeApi({ access: makeAccess({ save: () => ({ ok: false, code: GITEE_ACCESS_REASONS.UNAVAILABLE }) }).access }),
    { revision: SNAPSHOT.revision, fields: {} },
  );
  assert.equal(unavailable.status, 503);
});

test('toNodeRoute: 未知路径 404、非 GET/POST 405 带 allow 头、HEAD 走 GET', async () => {
  const { access } = makeAccess();
  const route = toNodeRoute(makeApi({ access }));

  const notFound = { status: 0, headers: null, body: '' };
  await route({ url: '/api/forge-gitee/other', method: 'GET' }, notFound);
  assert.equal(notFound.status, 404);

  const rejected = { status: 0, headers: null, body: '' };
  await route({ url: GITEE_CONFIG_ROUTE, method: 'PUT' }, rejected);
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.allow, 'GET, POST');

  const head = { status: 0, headers: null, body: '' };
  await route({ url: `${GITEE_CONFIG_ROUTE}?refresh=1`, method: 'HEAD' }, head);
  assert.equal(head.status, 200);
});

test('toNodeRoute: 端点尾斜杠等价，POST 请求体经 Node 流读取后写盘', async () => {
  const { access, calls } = makeAccess();
  const route = toNodeRoute(makeApi({ access }));

  const res = { status: 0, headers: null, body: '' };
  await route(
    {
      url: `${GITEE_CONFIG_ROUTE}/`,
      method: 'POST',
      headers: { ...WRITE_HEADERS },
      body: JSON.stringify({ revision: SNAPSHOT.revision, fields: { cliPath: '/opt/gh' } }),
    },
    res,
  );

  assert.equal(res.status, 200);
  assert.equal(calls.save, 1);
  assert.deepEqual(calls.last.fields, { cliPath: '/opt/gh' });
});

test('toNodeRoute: 流式请求体超限直接 413，不把内容读进内存', async () => {
  const { access, calls } = makeAccess();
  const route = toNodeRoute(makeApi({ access }));
  const chunk = Buffer.alloc(GITEE_MAX_BODY, 0x61);

  async function* body() {
    yield chunk;
    yield chunk;
  }

  const req = { url: GITEE_CONFIG_ROUTE, method: 'POST', headers: { ...WRITE_HEADERS }, [Symbol.asyncIterator]: body };
  const res = { status: 0, headers: null, body: '' };
  await route(req, res);

  assert.equal(res.status, 413);
  assert.equal(calls.save, 0);
});
