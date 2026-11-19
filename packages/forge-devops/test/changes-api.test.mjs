/**
 * 会话起始变更选择器（r19）的同源契约用例。
 *
 * 只守离线可判定的面：清单投影（去空/去重/上限）、失败信封与状态码矩阵、方法与路径门禁、
 * 响应头，以及客户端字面量与端点/模板逐字一致（避免两半各写一份常量后静默漂移）。
 * 真实浏览器渲染与宿主槽位装配 → 不在此处假装覆盖（DESIGN §10 记为手工/实机）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DevopsReadError } from '../src/read.mjs';
import {
  CHANGES_CODES,
  CHANGES_MAX_ITEMS,
  CHANGES_READ_TARGET,
  CHANGES_ROUTE_PATH,
  createChangesApi,
  projectChangeItems,
  toChangesRoute,
} from '../src/changes-api.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SOURCE = readFileSync(path.join(PACKAGE_ROOT, 'client.js'), 'utf8');

const envelopeOf = (items, extra = {}) => ({
  action: 'change.list',
  target_ref: '@me',
  status: 'succeeded',
  source_revision: 'dop:abc',
  observed_at: '2026-11-18T10:00:00.000Z',
  error_code: null,
  facts: { user: null, total: items.length, count: items.length, filter: null, items, raw: null },
  truncated: false,
  ...extra,
});

const row = (code, summary) => ({ code, summary, state: '开发中', team: '智能工程分队', createDate: '2026-09-01 09:20:11' });

/** 极简 req/res：写回走 `writeResponse` 的兜底分支（无 setHeader 时落到 res.status/headers/body）。 */
async function call(handler, { url = CHANGES_ROUTE_PATH, method = 'GET' } = {}) {
  const res = {};
  await handler({ url, method, headers: {} }, res);
  return { status: res.status, headers: res.headers ?? {}, body: JSON.parse(res.body) };
}

/* ------------------------------------------------------------------ *
 * 1. 清单投影                                                        *
 * ------------------------------------------------------------------ */

test('投影：只给 {id, summary}，保留 total 与 observed_at', () => {
  const projected = projectChangeItems(envelopeOf([row('ARD384859', '企业级sdd工具开发'), row('MST302881', '消息中心多活容灾切换')]));
  assert.deepEqual(projected, {
    ok: true,
    items: [
      { id: 'ARD384859', summary: '企业级sdd工具开发' },
      { id: 'MST302881', summary: '消息中心多活容灾切换' },
    ],
    count: 2,
    total: 2,
    truncated: false,
    observed_at: '2026-11-18T10:00:00.000Z',
  });
});

test('投影：缺编号/缺概要的行不可选，重复编号只留第一条', () => {
  const projected = projectChangeItems(
    envelopeOf([
      row('A1', '甲'),
      { code: '', summary: '没有编号' },
      { code: 'A2', summary: '   ' },
      row('A1', '甲（重复）'),
      row(' A3 ', ' 丙 '),
    ]),
  );
  assert.deepEqual(projected.items, [
    { id: 'A1', summary: '甲' },
    { id: 'A3', summary: '丙' },
  ]);
  assert.equal(projected.count, 2, 'count 是精选后的可选项数，不是原始行数');
});

test(`投影：超过 ${CHANGES_MAX_ITEMS} 条截断并置 truncated`, () => {
  const rows = Array.from({ length: CHANGES_MAX_ITEMS + 5 }, (_, index) => row(`C${index}`, `概要 ${index}`));
  const projected = projectChangeItems(envelopeOf(rows));
  assert.equal(projected.items.length, CHANGES_MAX_ITEMS);
  assert.equal(projected.truncated, true, '被截断必须可见，页面才能提示"仅显示前 N 条"');
  assert.equal(projected.total, CHANGES_MAX_ITEMS + 5);
});

test('投影：非 succeeded 一律失败，不把半份清单伪装成全部', () => {
  const partial = projectChangeItems(envelopeOf([row('A1', '甲')], { status: 'partial', error_code: 'COMMAND_TIMEOUT' }));
  assert.deepEqual(partial, { ok: false, code: CHANGES_CODES.READ_FAILED, reason: 'COMMAND_TIMEOUT' });
  const unknown = projectChangeItems(envelopeOf([], { status: 'unknown', error_code: 'NO_STRUCTURED_STATUS' }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'NO_STRUCTURED_STATUS');
  assert.equal(projectChangeItems(null).ok, false);
});

test('投影：空清单是合法结果（用户暂时没有变更），不是错误', () => {
  assert.deepEqual(projectChangeItems(envelopeOf([])), {
    ok: true,
    items: [],
    count: 0,
    total: 0,
    truncated: false,
    observed_at: '2026-11-18T10:00:00.000Z',
  });
});

/* ------------------------------------------------------------------ *
 * 2. 端点契约                                                        *
 * ------------------------------------------------------------------ */

test('端点：未装配 list 时 503 PICKER_UNAVAILABLE（fail closed）', async () => {
  const handler = toChangesRoute(createChangesApi());
  const { status, body } = await call(handler);
  assert.equal(status, 503);
  assert.deepEqual(body, { ok: false, code: CHANGES_CODES.PICKER_UNAVAILABLE, message: '变更选择器尚未装配' });
});

test('端点：成功体含 ok/items/count/total/truncated/observed_at', async () => {
  const seen = [];
  const handler = toChangesRoute(
    createChangesApi({
      list: async () => {
        seen.push(CHANGES_READ_TARGET);
        return envelopeOf([row('ARD384859', '企业级sdd工具开发')]);
      },
    }),
  );
  const { status, headers, body } = await call(handler);
  assert.equal(status, 200);
  assert.deepEqual(seen, ['@me'], '清单只能查 @me（当前登录人范围）');
  assert.deepEqual(body, {
    ok: true,
    items: [{ id: 'ARD384859', summary: '企业级sdd工具开发' }],
    count: 1,
    total: 1,
    truncated: false,
    observed_at: '2026-11-18T10:00:00.000Z',
  });
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(Object.keys(headers).some((key) => key.toLowerCase().startsWith('access-control')), false, '不设 CORS 头');
});

test('端点：读层原因映射到状态码，错误消息不外溢、不拼异常文本', async () => {
  const cases = [
    ['NO_READER', 503],
    ['POLICY_DENIED', 403],
    ['COMMAND_FAILED', 502],
    ['COMMAND_TIMEOUT', 504],
    ['MALFORMED_RESULT', 502],
    ['SOMETHING_ELSE', 502],
  ];
  for (const [code, expected] of cases) {
    const handler = toChangesRoute(
      createChangesApi({
        list: async () => {
          throw new DevopsReadError(code, 'EACCES: /usr/local/bin/dop');
        },
      }),
    );
    const { status, body } = await call(handler);
    assert.equal(status, expected, `${code} 应映射到 ${expected}`);
    assert.equal(body.ok, false);
    assert.equal(body.code, CHANGES_CODES.READ_FAILED);
    assert.equal(body.detail.reason, code);
    assert.equal(body.message.includes('/usr/local/bin'), false, '异常文本（可能含路径）不得出网');
    assert.equal(body.message.includes('EACCES'), false);
  }
});

test('端点：读信封失败走同一状态码矩阵', async () => {
  const handler = toChangesRoute(
    createChangesApi({ list: async () => envelopeOf([], { status: 'failed', error_code: 'COMMAND_TIMEOUT' }) }),
  );
  const { status, body } = await call(handler);
  assert.equal(status, 504);
  assert.equal(body.detail.reason, 'COMMAND_TIMEOUT');
});

test('端点：非 GET/HEAD 405 且带 allow；路径不符 404', async () => {
  const api = createChangesApi({ list: async () => envelopeOf([]) });
  const handler = toChangesRoute(api);
  const post = await call(handler, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.body.code, CHANGES_CODES.METHOD_NOT_ALLOWED);
  assert.equal(post.headers.allow, 'GET');
  const other = await call(handler, { url: '/api/forge-devops/other' });
  assert.equal(other.status, 404);
  assert.equal(other.body.code, CHANGES_CODES.NOT_FOUND);
});

/* ------------------------------------------------------------------ *
 * 3. 客户端字面量对齐                                                *
 * ------------------------------------------------------------------ */

test('客户端：端点与读目标逐字对齐，模板与用户口径一致', () => {
  assert.ok(CLIENT_SOURCE.includes(`'${CHANGES_ROUTE_PATH}'`), `client.js 必须请求 ${CHANGES_ROUTE_PATH}`);
  assert.equal(CLIENT_SOURCE.includes('target='), false, '客户端不传 target：清单范围由服务端固定为 @me');
  assert.ok(
    CLIENT_SOURCE.includes('变更 {code}：用 forge_devops_change_context 读取详情，提炼需求与验收标准；'),
    '默认模板首段必须与产品口径逐字一致',
  );
  assert.ok(CLIENT_SOURCE.includes('约束：提交说明不以 # 开头；不伪造验证结果。'), '默认模板末段必须与产品口径逐字一致');
  assert.ok(CLIENT_SOURCE.includes("'conversation.hero.options'"), '注册槽位必须是新会话工具栏行的选项区');
  assert.ok(CLIENT_SOURCE.includes("const PICKER_ID = 'devops.change-picker'"), '槽位条目 id 稳定');
});
