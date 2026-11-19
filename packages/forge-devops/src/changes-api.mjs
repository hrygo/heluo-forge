/**
 * `@heluo/forge-devops` 会话起始变更选择器的同源 HTTP 契约（r19）。
 *
 * 新会话编辑器要列出「当前登录人可见的变更」（编号 + 概要），数据只能来自服务端：
 * 浏览器半不持有 CLI 入口、不执行命令，也不允许把平台记录塞进宿主持久化。因此这里是一条
 * 独立的只读路由 `/api/forge-devops/changes`，与 `/cli` 共用前缀但**注册成更长的前缀**
 * （宿主按最长前缀匹配，两条路由互不遮挡）。
 *
 * 三条边界：
 *   1. **读取只有一条链路**：`list()` 由装配层注入，固定指向 `service.read({action:'change.list',
 *      target:'@me'})`——与工具面同一次策略门禁、同一个适配器、同一套原因词表，不另开渠道。
 *   2. **只读**：只暴露 GET/HEAD；响应 no-store、无 CORS 头。清单不是授权凭据，可见范围由企业侧判定。
 *   3. **错误体不拼异常文本**：消息由本模块按原因词写死；异常可能带命令行路径，绝不外溢。
 *
 * 本模块与框架无关：`handleGet` 返回 `{status, headers, body}`，`toChangesRoute` 是唯一的
 * Node 适配面，因此状态码矩阵可以在离线用例里逐条断言。
 */
import { CLI_API_PREFIX, fail, normalizeRoutePath, ok, splitRequestUrl, writeResponse } from './http.mjs';

/** 端点全路径：前缀 + `/changes`（客户端 `client.js` 用同一字面量，由用例逐字比对）。 */
export const CHANGES_ROUTE_PATH = `${CLI_API_PREFIX}/changes`;

/** 清单查询的固定目标：CLI 的 list 天然是当前登录人范围，读层只接受 `@me`。 */
export const CHANGES_READ_TARGET = '@me';

/** 一次最多返回多少条：面板是小浮层，几百条既不可读也会把响应撑大。 */
export const CHANGES_MAX_ITEMS = 100;

/** 本模块自己的原因码（配置层/读层的原因码之外，只用于"请求不合法 / 路由不存在 / 未装配"）。 */
export const CHANGES_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PICKER_UNAVAILABLE: 'PICKER_UNAVAILABLE',
  READ_FAILED: 'READ_FAILED',
});

/** 读层原因 → HTTP 状态：页面只按类别词选文案，具体原因走 `detail.reason`。 */
const STATUS_BY_REASON = Object.freeze({
  NO_READER: 503,
  POLICY_REQUIRED: 503,
  POLICY_ACTION_UNREGISTERED: 503,
  POLICY_DENIED: 403,
  COMMAND_FAILED: 502,
  COMMAND_TIMEOUT: 504,
  MALFORMED_RESULT: 502,
  NO_STRUCTURED_STATUS: 502,
  MISSING_SOURCE_REVISION: 502,
  UNKNOWN_ACTION: 500,
  MISSING_TARGET: 500,
});

/** 原因 → 固定消息（中文词表；不拼 `error.message`）。 */
const MESSAGE_BY_REASON = Object.freeze({
  NO_READER: '尚未解析到可用的 dop 入口',
  POLICY_REQUIRED: '策略面不可用，变更清单暂不可读',
  POLICY_ACTION_UNREGISTERED: '策略目录未登记 change.list，变更清单暂不可读',
  POLICY_DENIED: '策略拒绝了变更清单查询',
  COMMAND_FAILED: 'dop 变更清单执行失败',
  COMMAND_TIMEOUT: 'dop 变更清单执行超时',
  MALFORMED_RESULT: '平台返回的变更清单无法解析',
  NO_STRUCTURED_STATUS: '平台返回的变更清单没有结构化状态',
  MISSING_SOURCE_REVISION: '平台返回的变更清单缺少来源版本',
});

const messageOf = (reason) =>
  typeof reason === 'string' && MESSAGE_BY_REASON[reason] !== undefined ? MESSAGE_BY_REASON[reason] : '变更清单读取失败';

const statusOf = (reason) =>
  typeof reason === 'string' && STATUS_BY_REASON[reason] !== undefined ? STATUS_BY_REASON[reason] : 502;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * 读信封 → 面板条目。纯函数，逐条可断言。
 *
 * 只有 `status === 'succeeded'` 才算一份可用的清单：`partial` / `failed` / `unknown` 都是
 * "没拿到完整事实"，宁可显示失败并允许重试，也不把半份清单伪装成全部。条目只保留
 * `{id, summary}`：界面只需要编号与概要，其余平台字段不进浏览器。
 *
 * @param {object} envelope `service.read({action:'change.list', target:'@me'})` 的返回值
 */
export function projectChangeItems(envelope) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, code: CHANGES_CODES.READ_FAILED, reason: 'MALFORMED_RESULT' };
  }
  if (envelope.status !== 'succeeded') {
    const reason = text(envelope.error_code) === '' ? 'MALFORMED_RESULT' : text(envelope.error_code);
    return { ok: false, code: CHANGES_CODES.READ_FAILED, reason };
  }
  const facts = envelope.facts !== null && typeof envelope.facts === 'object' ? envelope.facts : {};
  const rows = Array.isArray(facts.items) ? facts.items : [];
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    if (items.length >= CHANGES_MAX_ITEMS) break;
    const id = text(row?.code);
    const summary = text(row?.summary);
    // 没有编号或没有概要的行不可选：点选后模板里只会留下一个空变更号。
    if (id === '' || summary === '' || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, summary });
  }
  const reportedTotal = Number.isInteger(facts.total) && facts.total >= 0 ? facts.total : items.length;
  return {
    ok: true,
    items,
    count: items.length,
    total: reportedTotal,
    truncated: envelope.truncated === true || rows.length > CHANGES_MAX_ITEMS,
    observed_at: text(envelope.observed_at) === '' ? null : envelope.observed_at,
  };
}

/**
 * 只读端点的请求处理面（框架无关）。
 *
 * @param {{list?: Function}} [options] `list` 由装配层注入：`() => Promise<读信封>`。
 */
export function createChangesApi(options = {}) {
  const list = typeof options?.list === 'function' ? options.list : null;

  async function handleGet() {
    if (list === null) return fail(503, CHANGES_CODES.PICKER_UNAVAILABLE, '变更选择器尚未装配');
    let envelope;
    try {
      envelope = await list();
    } catch (error) {
      const reason = text(error?.code) === '' ? 'COMMAND_FAILED' : text(error.code);
      return fail(statusOf(reason), CHANGES_CODES.READ_FAILED, messageOf(reason), null, null, { reason });
    }
    const projected = projectChangeItems(envelope);
    if (projected.ok !== true) {
      return fail(statusOf(projected.reason), CHANGES_CODES.READ_FAILED, messageOf(projected.reason), null, null, {
        reason: projected.reason,
      });
    }
    return ok({
      ok: true,
      items: projected.items,
      count: projected.count,
      total: projected.total,
      truncated: projected.truncated,
      observed_at: projected.observed_at,
    });
  }

  return Object.freeze({ handleGet });
}

/**
 * Node `req/res` 适配器：只服务 `CHANGES_ROUTE_PATH`，其他路径 404、非 GET/HEAD 405。
 *
 * 与 `/cli` 的 `toNodeRoute` 分开是故意的：两条路由的生命周期与状态码矩阵不同
 * （`/cli` 有写面与自检，这里只有一次只读），合并会让任一方的边界变化牵连另一方。
 *
 * @param {{handleGet: Function}} api `createChangesApi()` 的结果
 * @param {{path?: string}} [options] `path` 可覆盖端点（默认 `CHANGES_ROUTE_PATH`）
 */
export function toChangesRoute(api, options = {}) {
  const routePath = normalizeRoutePath(
    typeof options?.path === 'string' && options.path !== '' ? options.path : CHANGES_ROUTE_PATH,
  );

  return async function handleForgeDevopsChangesRequest(req, res) {
    let result;
    try {
      const { pathname } = splitRequestUrl(req?.url);
      if (pathname !== routePath) {
        result = fail(404, CHANGES_CODES.NOT_FOUND, '未知的变更端点');
      } else {
        const method = String(req?.method ?? 'GET').toUpperCase();
        if (method === 'GET' || method === 'HEAD') {
          result = await api.handleGet();
        } else {
          result = fail(405, CHANGES_CODES.METHOD_NOT_ALLOWED, '变更清单只支持 GET', null, { allow: 'GET' });
        }
      }
    } catch {
      result = fail(500, CHANGES_CODES.READ_FAILED, '变更清单读取失败');
    }
    writeResponse(res, result);
  };
}
