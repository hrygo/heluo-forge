/**
 * T3 HTTP 契约（AC-4 / AC-8 / AC-9 / AC-10）：同源 `/api/forge-devops/cli` 的状态码矩阵。
 *
 * 页面塌了的第一个排查面就是这里：状态码 → 页面动作（400 改请求、409 刷新、422 标字段、
 * 503 降级只读）是写死在 client.js 里的，所以服务端这几点必须有用例钉住，而不是靠手点页面。
 *
 * 全部离线：`access` 是假实现，`toNodeRoute` 用假 req/res。宿主 `webServer` 的真实注册、
 * 企业 profile 的 `/api/*` 鉴权都属 NOT RUN，不在此文件断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_REASONS } from '../src/cli-config.mjs';
import { createCliAccess } from '../src/cli-access.mjs';
import { CLI_API_PREFIX, CLI_REQUEST_HEADER, CLI_ROUTE_PATH, createCliApi, toNodeRoute } from '../src/http.mjs';

const AT = Date.parse('2026-10-29T07:00:00.000Z');
const SECRET = 'C:\\Users\\someone\\profile\\dsh.patch.yml'; // security-scan: allow（夹具：合成路径，非真实主机）
const ENDPOINT = '/api/forge-devops/cli';

const SNAPSHOT = Object.freeze({
  revision: '0123456789abcdef',
  writable: Object.freeze({ ok: true, documentPath: true }),
  ready: true,
  reason: null,
  guidance: '命令行工具已就绪（dop 来自自动发现 · gh 来自自动发现）',
  entries: Object.freeze({}),
  host: Object.freeze({ platform: 'win32', arch: 'x64', node: process.version }),
});

/** 假 access：记录页面到底带没带 refresh、提交了什么（其余方法只会被现读，不会被调用）。 */
function makeAccess({ snapshotResult = SNAPSHOT, saveResult = null, throwsOn = null } = {}) {
  const calls = { snapshot: [], save: [] };
  return {
    calls,
    revision: () => SNAPSHOT.revision,
    describe: () => ({}),
    snapshot(options) {
      calls.snapshot.push(options ?? null);
      if (throwsOn === 'snapshot') throw new Error(`EACCES: open '${SECRET}'`);
      return typeof snapshotResult === 'function' ? snapshotResult(options) : snapshotResult;
    },
    async save(input) {
      calls.save.push(input);
      if (throwsOn === 'save') throw new Error(`EROFS: open '${SECRET}'`);
      return typeof saveResult === 'function' ? saveResult(input) : saveResult;
    },
  };
}

const buildApi = (accessOptions = {}) => createCliApi({ access: makeAccess(accessOptions), now: () => AT });

// `createCliApi` 冻结返回对象，用例通过注册表拿到那只假 access（看清"带没带 refresh、提交了什么"）。
const accessRegistry = new WeakMap();
const apiAccess = (api) => accessRegistry.get(api);
function trackedApi(options = {}) {
  const access = makeAccess(options);
  const api = createCliApi({ access, now: () => AT });
  accessRegistry.set(api, access);
  return api;
}

const post = (api, { headers = {}, body = '{}' } = {}) =>
  api.handlePost({
    headers: { [CLI_REQUEST_HEADER]: '1', 'content-type': 'application/json', ...headers },
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('端点常量与页面约定一致，路径都由 CLI_API_PREFIX 派生（客户端不再各写一份）', () => {
  assert.equal(CLI_API_PREFIX, '/api/forge-devops');
  assert.equal(CLI_ROUTE_PATH, ENDPOINT);
  assert.equal(CLI_ROUTE_PATH.startsWith(CLI_API_PREFIX), true);
  assert.equal(CLI_REQUEST_HEADER, 'x-forge-devops-request');
});

test('GET 快照：200 + 快照原样返回 + no-store，且不带任何 access-control-*', () => {
  const api = buildApi();
  const response = api.handleGet();

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, SNAPSHOT, '页面直接吃快照结构（含 revision 与 entries）');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /application\/json/u);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(
    Object.keys(response.headers).some((key) => key.toLowerCase().startsWith('access-control-')),
    false,
    '同源端点不开 CORS：放开等于把路径外泄给任意站点（AC-10）',
  );
  assert.equal(response.headers['x-forge-devops-at'], new Date(AT).toISOString());
});

test('GET ?refresh=1：四种 query 形态都收敛到同一次重扫，其余取值都不扫（AC-4）', () => {
  const api = trackedApi();

  for (const query of [new URLSearchParams('refresh=1'), 'refresh=1', { refresh: '1' }, { refresh: true }]) {
    api.handleGet({ query });
  }
  assert.deepEqual(
    apiAccess(api).calls.snapshot,
    [{ refresh: true }, { refresh: true }, { refresh: true }, { refresh: true }],
    'refresh=1 是页面唯一的重扫动作',
  );

  for (const query of [undefined, {}, new URLSearchParams(''), new URLSearchParams('refresh=0')]) {
    api.handleGet({ query });
  }
  assert.deepEqual(
    apiAccess(api).calls.snapshot.slice(4),
    [{ refresh: false }, { refresh: false }, { refresh: false }, { refresh: false }],
    '普通读取绝不触发扫描',
  );
});

// 上面两条用例已通过注册表断言过 refresh 语义，这里不再重复取 access。

test('GET 读面失败：500 + 固定文案，绝不回显宿主异常里的路径（AC-10）', () => {
  const api = createCliApi({ access: makeAccess({ throwsOn: 'snapshot' }), now: () => AT });
  const response = api.handleGet();

  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'CLI_SNAPSHOT_FAILED');
  assert.equal(JSON.stringify(response.body).includes(SECRET), false);
  assert.equal(JSON.stringify(response.body).includes('C:'), false);
});

test('GET 未装配：503 而不是抛异常（可选服务缺失不得让整片读面炸掉）', () => {
  const api = createCliApi({ access: null, now: () => AT });
  const response = api.handleGet();

  assert.equal(response.status, 503);
  assert.equal(response.body.code, CLI_REASONS.UNAVAILABLE);
});

test('POST 前置校验：缺预检头 / 头值不对 → 400 且一个字节都不保存（CSRF 预检）', async () => {
  const api = trackedApi({ saveResult: { ok: true, snapshot: SNAPSHOT } });

  const missing = await api.handlePost({ headers: { 'content-type': 'application/json' }, rawBody: '{}' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /x-forge-devops-request/u);

  const wrong = await post(api, { headers: { [CLI_REQUEST_HEADER]: '0' } });
  assert.equal(wrong.status, 400);

  const accepted = await post(api, { headers: { [CLI_REQUEST_HEADER]: 'true' } });
  assert.equal(accepted.status, 200, '预检头也接受 "true"，页面只需一致');
  assert.equal(apiAccess(api).calls.save.length, 1, '被拒的两次不得进 save');
});

test('POST 请求体校验：非 JSON content-type、非法 JSON、空体、超大 → 400', async () => {
  const api = trackedApi({ saveResult: { ok: true, snapshot: SNAPSHOT } });

  const form = await post(api, { headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 400);

  assert.equal((await post(api, { body: '{not json' })).status, 400);
  assert.equal((await post(api, { body: '   ' })).status, 400);
  assert.equal((await post(api, { body: '[]' })).status, 400, '顶层必须是对象');
  assert.equal((await post(api, { body: { blob: 'x'.repeat(70000) } })).status, 400, '超过上限直接拒');
  assert.equal(apiAccess(api).calls.save.length, 0);
});

test('POST 形状校验：未知顶层键 / 未知配置项 / fields 非对象 / revision 非字符串 → 400 且带字段错误', async () => {
  const api = trackedApi({ saveResult: { ok: true, snapshot: SNAPSHOT } });

  const extra = await post(api, { body: { revision: 'abc', fields: {}, patch: 'rm -rf' } });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.errors.patch, '未知字段');

  const stray = await post(api, { body: { fields: { dopBin: 'x', nope: 'y' } } });
  assert.equal(stray.status, 400);
  assert.equal(stray.body.errors.nope, '未知配置项');

  assert.equal((await post(api, { body: { fields: [] } })).status, 400);
  assert.equal((await post(api, { body: { revision: 7, fields: {} } })).status, 400);
  assert.equal(apiAccess(api).calls.save.length, 0, '形状不对不进 save');
});

test('POST 成功：200 + { ok:true, snapshot }，回的新 revision 就是页面的下一枚栅栏', async () => {
  const written = { dopBin: 'C:\\company\\dop.exe' };
  const api = trackedApi({
    saveResult: (input) => ({ ok: true, snapshot: { ...SNAPSHOT, revision: 'fedcba9876543210' } }),
  });

  const response = await post(api, { body: { revision: SNAPSHOT.revision, fields: written } });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.snapshot.revision, 'fedcba9876543210');
  assert.deepEqual(apiAccess(api).calls.save[0], { revision: SNAPSHOT.revision, fields: written });
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('POST revision 过期：409 + 冲突码，页面据此保留草稿并提示刷新（AC-9）', async () => {
  const api = trackedApi({
    saveResult: { ok: false, code: CLI_REASONS.CONFLICT, message: '配置已在别处修改，请刷新后重试' },
  });

  const response = await post(api, { body: { revision: 'deadbeefdeadbeef', fields: { dopBin: 'x' } } });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, CLI_REASONS.CONFLICT);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('POST 校验失败：422 + 逐字段 errors（页面逐项标红，不用猜哪一项错）', async () => {
  const errors = { dopBin: '该文件不存在或不可直接执行', timeoutMs: '必须是 1000–600000 的整数' };
  const api = trackedApi({
    saveResult: { ok: false, code: CLI_REASONS.INVALID, message: '有字段未通过校验', errors },
  });

  const response = await post(api, { body: { revision: SNAPSHOT.revision, fields: { dopBin: 'x' } } });

  assert.equal(response.status, 422);
  assert.deepEqual(response.body.errors, errors);
  assert.equal(response.body.ok, false);
});

test('POST 写面不可用：503（无 configEditor / 无条目都归这一类）', async () => {
  const api = trackedApi({
    saveResult: { ok: false, code: CLI_REASONS.UNAVAILABLE, message: '配置文件不可写' },
  });
  const response = await post(api, { body: { revision: '', fields: {} } });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, CLI_REASONS.UNAVAILABLE);
});

test('POST save 抛异常：503 且固定文案，宿主错误里的路径不外泄（AC-10）', async () => {
  const api = createCliApi({ access: makeAccess({ throwsOn: 'save' }), now: () => AT });
  const response = await api.handlePost({
    headers: { [CLI_REQUEST_HEADER]: '1', 'content-type': 'application/json' },
    rawBody: '{"fields":{}}',
  });

  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.body).includes(SECRET), false);
});

test('未装配时的 POST：503（与 GET 同一降级口径）', async () => {
  const api = createCliApi({ access: null, now: () => AT });
  const response = await api.handlePost({ headers: { [CLI_REQUEST_HEADER]: '1' }, rawBody: '{}' });
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
});

test('错误体形状统一：ok/code/message 三件套，message 非空（页面只认这三样）', async () => {
  const api = trackedApi({ saveResult: { ok: false, code: CLI_REASONS.CONFLICT, message: '配置已在别处修改' } });
  const responses = [
    api.handleGet({ query: new URLSearchParams('refresh=1') }),
    await post(api, { headers: { [CLI_REQUEST_HEADER]: '0' } }),
    await post(api, { body: { fields: { nope: 1 } } }),
    await post(api, { body: { fields: {} } }),
  ];

  for (const response of responses) {
    if (response.status === 200) continue;
    assert.equal(response.body.ok, false);
    assert.equal(typeof response.body.code, 'string');
    assert.ok(response.body.code.length > 0);
    assert.equal(typeof response.body.message, 'string');
    assert.ok(response.body.message.length > 0);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.stringify(response.body).includes('C:'), false, '错误体不带盘符路径');
  }
});

/** 假 res：真实 `ServerResponse` 的最小形状（statusCode 初始 200，正好检验适配器有没有写状态）。 */
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    writableEnded: false,
    setHeader(key, value) {
      res.headers[key.toLowerCase()] = value;
    },
    end(payload) {
      res.body = payload;
      res.writableEnded = true;
    },
  };
  return res;
}

const callRoute = async (route, request) => {
  const res = makeRes();
  await route(request, res);
  return { status: res.statusCode, headers: res.headers, body: res.body === null ? null : JSON.parse(res.body) };
};

test('toNodeRoute：GET 走快照、POST 走保存、未知路径 404、其他方法 405 + allow', async () => {
  const api = trackedApi({ saveResult: { ok: true, snapshot: SNAPSHOT } });
  const route = toNodeRoute(api);

  const read = await callRoute(route, { method: 'GET', url: `${ENDPOINT}?refresh=1`, headers: {} });
  assert.equal(read.status, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(read.body.ready, true);
  assert.deepEqual(apiAccess(api).calls.snapshot, [{ refresh: true }]);

  const save = await callRoute(route, {
    method: 'POST',
    url: ENDPOINT,
    headers: { [CLI_REQUEST_HEADER]: '1', 'content-type': 'application/json' },
    body: { revision: SNAPSHOT.revision, fields: { ghBin: null } },
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.ok, true);

  const unknown = await callRoute(route, { method: 'GET', url: `${CLI_API_PREFIX}/other`, headers: {} });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'NOT_FOUND');

  const wrongMethod = await callRoute(route, { method: 'DELETE', url: ENDPOINT, headers: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, POST');
});

test('toNodeRoute：流式请求体（无 req.body）也能读出，超限直接 400 且不进 save', async () => {
  const api = trackedApi({ saveResult: { ok: true, snapshot: SNAPSHOT } });
  const route = toNodeRoute(api);

  const stream = (chunks) => ({
    method: 'POST',
    url: ENDPOINT,
    headers: { [CLI_REQUEST_HEADER]: '1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
    },
  });

  const ok = await callRoute(route, stream(['{"fields":', '{"ghBin":null}}']));
  assert.equal(ok.status, 200);
  assert.deepEqual(apiAccess(api).calls.save[0], { revision: '', fields: { ghBin: null } });

  const big = await callRoute(route, stream(['x'.repeat(70000)]));
  assert.equal(big.status, 400);
  assert.equal(big.body.message, '请求体过大');
  assert.equal(apiAccess(api).calls.save.length, 1, '超限请求不进 save');
});

test('toNodeRoute：路径带尾斜杠仍命中，options.path 可覆盖端点（prefix/exact 两种注册都通吃）', async () => {
  const api = trackedApi({ saveResult: null });
  const trailing = await callRoute(toNodeRoute(api), { method: 'GET', url: `${ENDPOINT}/?refresh=1`, headers: {} });
  assert.equal(trailing.status, 200);

  const custom = toNodeRoute(api, { path: '/api/forge-devops/status' });
  const hit = await callRoute(custom, { method: 'GET', url: '/api/forge-devops/status', headers: {} });
  assert.equal(hit.status, 200);
  const miss = await callRoute(custom, { method: 'GET', url: ENDPOINT, headers: {} });
  assert.equal(miss.status, 404);
});

test('端到端主路径：GET 就绪 → POST 保存落盘 → GET 变 config → 旧 revision 被 409 挡住（真 access + 真路由）', async () => {
  const TOOLDIR = 'C:\\tools';
  const CHOSEN = 'C:\\config\\dop.exe';
  const dirs = { [TOOLDIR]: ['dop.exe', 'gh.exe'] };
  const files = { [`${TOOLDIR}\\dop.exe`]: true, [`${TOOLDIR}\\gh.exe`]: true, [CHOSEN]: true };
  const miss = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const fs = {
    readdirSync(dir) {
      if (!(dir in dirs)) throw miss();
      return [...dirs[dir]];
    },
    statSync(file) {
      if (!(file in files)) throw miss();
      return { isFile: () => true, mode: 0o755 };
    },
  };
  const patch = { override: {}, inherited: {} };
  const editor = {
    documentPath: 'C:\\profile\\dsh.patch.yml',
    configuration() {
      return [{
        entry: { options: { id: 'forge-devops', name: 'forge-devops' } },
        inherited: { ...patch.inherited },
        override: { ...patch.override },
      }];
    },
    async edit(_entry, change) {
      patch.override = { ...change({ ...patch.override }, { ...patch.inherited }) };
    },
  };
  const access = createCliAccess({
    config: {}, env: { Path: TOOLDIR }, platform: 'win32', fs, now: () => AT, configEditor: editor,
  });
  const route = toNodeRoute(createCliApi({ access, now: () => AT }));
  const write = (body) => ({
    method: 'POST',
    url: ENDPOINT,
    headers: { [CLI_REQUEST_HEADER]: '1', 'content-type': 'application/json' },
    body,
  });

  const first = await callRoute(route, { method: 'GET', url: ENDPOINT, headers: {} });
  assert.equal(first.status, 200);
  assert.equal(first.body.ready, true, '自动发现够用，正常情况用户什么都不用填（AG-4）');
  assert.equal(first.body.entries.dopBin.origin, 'discovered');

  const saved = await callRoute(route, write({ revision: first.body.revision, fields: { dopBin: CHOSEN } }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.snapshot.entries.dopBin.origin, 'config');
  assert.deepEqual(patch.override, { dopBin: CHOSEN }, '磁盘上只多出用户真的改的那一个键');

  const after = await callRoute(route, { method: 'GET', url: ENDPOINT, headers: {} });
  assert.equal(after.body.entries.dopBin.path, CHOSEN, '重新 GET 看得见刚落盘的路径');

  const stale = await callRoute(route, write({ revision: first.body.revision, fields: { dopBin: null } }));
  assert.equal(stale.status, 409, '拿旧 revision 回写必须被挡住');
  assert.equal(stale.body.code, CLI_REASONS.CONFLICT);
  assert.deepEqual(patch.override, { dopBin: CHOSEN }, '被挡住的写一个字节都不落盘');
});
