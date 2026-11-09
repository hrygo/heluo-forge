/**
 * `@heluo/forge-gitee` 配置页的同源 HTTP 契约（T1）。
 *
 * 与 `@heluo/forge-devops/src/http.mjs` 同形（TECHNICAL §3.2），差异只有三处，都是契约里
 * 写死的：
 *
 *   1. 端点前缀 `/api/forge-gitee`、端点 `/config`、预检头 `x-forge-gitee-request`；
 *   2. 请求体超限回 **413**（devops 侧是 400）——"太大了"与"写错了"是两种处置；
 *   3. POST 成功体多一个 `applied`（TECHNICAL §3.4）：保存成功与运行时生效是两件事，
 *      页面必须能分别说，所以 `applied` 原样透传，本模块不解释它。
 *
 * 三条收紧规则沿用 devops：**不设 CORS 头**（只有同源页面能读）、**全响应 `cache-control:
 * no-store`**、**写操作要求自定义头**（跨站表单设不了，浏览器会把它按预检处理）。
 *
 * 本模块与框架无关：`handleGet` / `handlePost` 返回 `{ status, headers, body }`，状态码矩阵
 * 可以在离线用例里逐条断言；`toNodeRoute` 是唯一的 Node 适配面。错误体只放类别词与原因码，
 * 消息由本模块写死，**绝不**拼 `error.message`（fs 的错误消息里就带着绝对路径，AC-12）。
 */
import { Buffer } from 'node:buffer';

import {
  GITEE_ACCESS_REASONS,
  GITEE_CONFIG_KEYS,
  GITEE_PAGE_HINT,
  GITEE_REBUILD_REASON,
} from './config-access.mjs';

/** 路由前缀：`index.mjs` 用它注册（`kind:'prefix'`），页面用它拼端点。 */
export const GITEE_API_PREFIX = '/api/forge-gitee';

/** 端点全路径：前缀 + `/config`。注册成 prefix 或 exact 都指向这里。 */
export const GITEE_CONFIG_ROUTE = `${GITEE_API_PREFIX}/config`;

/** 写操作的预检头（值只有"在不在"的意义）。 */
export const GITEE_REQUEST_HEADER = 'x-forge-gitee-request';

/** 请求体上限：五个短字段的补丁，超过这个尺寸一定不是本页面发的。 */
export const GITEE_MAX_BODY = 64 * 1024;

/** 请求体形状：只认这两个顶层键，多一个就 400（不猜"也许他想写 revision"）。 */
const BODY_KEYS = Object.freeze(['revision', 'fields']);

/** 本模块自己的原因码（配置层的三码之外，只用于"请求不合法 / 路由不存在 / 读失败"）。 */
const CODES = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SNAPSHOT_FAILED: 'GITEE_SNAPSHOT_FAILED',
});

/** 响应头：统一 no-store + nosniff，**不设** `access-control-*`。 */
const BASE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
});

/** 保存结果码 → HTTP 状态。码是配置层的唯一词汇（`config-access.GITEE_ACCESS_REASONS`）。 */
const STATUS_BY_CODE = Object.freeze({
  [GITEE_ACCESS_REASONS.CONFLICT]: 409,
  [GITEE_ACCESS_REASONS.INVALID]: 422,
  [GITEE_ACCESS_REASONS.UNAVAILABLE]: 503,
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const headersOf = (extra = null) => (extra === null ? BASE_HEADERS : { ...BASE_HEADERS, ...extra });

/** 成功响应：`body` 由适配器序列化（用例可以直接 `deepEqual(body, snapshot)`）。 */
function ok(body, extraHeaders = null) {
  return { status: 200, headers: headersOf(extraHeaders), body };
}

/** 统一错误体 `{ ok:false, code, message, errors?, detail? }`——页面据此选文案，别再拼字符串。 */
function fail(status, code, message, errors = null, extraHeaders = null, detail = null) {
  const body = { ok: false, code, message };
  if (isPlainObject(errors) && Object.keys(errors).length > 0) body.errors = { ...errors };
  if (isPlainObject(detail) && Object.keys(detail).length > 0) body.detail = { ...detail };
  return { status, headers: headersOf(extraHeaders), body };
}

/**
 * 失败细因：页面按 `code` 选文案，`detail.reason` + `detail.next` 给出"为什么失败 + 下一步"。
 * 只输出词表值与固定指引——这里就是路径泄漏的最后一道闸。
 */
function failureDetailOf(error, refresh) {
  const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : '';
  if (refresh === true || code === GITEE_REBUILD_REASON) {
    return { reason: GITEE_REBUILD_REASON, next: GITEE_PAGE_HINT };
  }
  return { reason: CODES.SNAPSHOT_FAILED, next: GITEE_PAGE_HINT };
}

/** 去掉尾斜杠：`/api/forge-gitee/config/` 与 exact 注册等价。 */
function normalizeRoutePath(value) {
  if (typeof value !== 'string' || value === '') return '/';
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * 拆 `req.url`（origin-form）。不用 `URL`：它需要一个带 scheme 的基址，而基址字面量本身
 * 就是"硬编码 URL"（交付自检会红），这里只需要路径 + 查询串。
 *
 * @param {string} rawUrl `req.url`
 * @returns {{ pathname: string, params: URLSearchParams }}
 */
function splitRequestUrl(rawUrl) {
  const text = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : '/';
  const hashAt = text.indexOf('#');
  const withoutHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  const rawPath = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const search = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1);
  return { pathname: normalizeRoutePath(rawPath), params: new URLSearchParams(search) };
}

/** 大小写不敏感的取头（Node 的 `req.headers` 是小写，用例里常写成驼峰或 Map）。 */
function headerValue(headers, name) {
  if (headers === null || headers === undefined) return undefined;
  if (typeof headers.get === 'function') {
    const hit = headers.get(name);
    return typeof hit === 'string' ? hit : undefined;
  }
  if (typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** 取查询参数：兼容 `URLSearchParams`、查询串、普通对象三种形态。 */
function queryValue(query, name) {
  if (query === null || query === undefined) return undefined;
  if (typeof query.get === 'function') {
    const hit = query.get(name);
    return typeof hit === 'string' ? hit : undefined;
  }
  if (typeof query === 'string') {
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    const hit = params.get(name);
    return hit === null ? undefined : hit;
  }
  if (typeof query === 'object') {
    const hit = query[name];
    if (typeof hit === 'string') return hit;
    return hit === true ? 'true' : undefined;
  }
  return undefined;
}

/** `?refresh=1`（也接受 true/yes/on）：只有它会让装配层重建一次读面。 */
function refreshFlag(query) {
  const raw = queryValue(query, 'refresh');
  if (typeof raw !== 'string') return false;
  const flag = raw.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

/** 请求体 → 对象。非对象 / 非法 JSON / 超限都返回 `{ ok:false }`（超限由调用方给 413）。 */
function parseBody(rawBody) {
  if (isPlainObject(rawBody)) return { ok: true, value: rawBody };
  let text = null;
  if (typeof rawBody === 'string') text = rawBody;
  else if (Buffer.isBuffer(rawBody)) text = rawBody.toString('utf8');
  else if (rawBody === null || rawBody === undefined) text = '';
  if (text === null) return { ok: false, reason: 'json' };
  if (Buffer.byteLength(text, 'utf8') > GITEE_MAX_BODY) return { ok: false, reason: 'size' };
  if (text.trim() === '') return { ok: false, reason: 'json' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'json' };
  }
  return isPlainObject(value) ? { ok: true, value } : { ok: false, reason: 'json' };
}

/**
 * 建立 HTTP 契约。
 *
 * @param {object} options
 * @param {{revision:Function, snapshot:Function, describe:Function, save:Function}} [options.access]
 *   `createGiteeAccess()` 的返回值（缺失时读面 503，而不是抛异常）
 * @param {(options: {refresh: boolean}) => object} [options.snapshot]
 *   读快照的**注入源**：给了它就由它决定 `refresh` 怎么实现（装配层传 `refreshSnapshot()`，
 *   先重建读面再回响应），路由不再知道"重建读面"这件事；不给则退回 `access.snapshot()`。
 * @param {() => number} [options.now] 时钟：只用于响应头 `x-forge-gitee-at`（诊断用）
 * @returns {{handleGet: (request?: object) => object, handlePost: (request?: object) => Promise<object>}}
 */
export function createGiteeApi(options = {}) {
  const { access = null, snapshot = null, now = Date.now } = options ?? {};
  const clock = typeof now === 'function' ? now : Date.now;
  const source = typeof snapshot === 'function' ? snapshot : null;
  const canRead = source !== null || (isPlainObject(access) && typeof access.snapshot === 'function');
  const canSave = isPlainObject(access) && typeof access.save === 'function';
  const readSnapshot = source !== null ? source : (request) => access.snapshot(request);

  function stamp() {
    const value = clock();
    const at = new Date(typeof value === 'number' && Number.isFinite(value) ? value : Date.now());
    return { 'x-forge-gitee-at': at.toISOString() };
  }

  /** GET：无参 = 当前快照；`?refresh=1` = 重读磁盘 + 重建读面（页面唯一的刷新动作）。 */
  function handleGet(request = {}) {
    if (!canRead) return fail(503, GITEE_ACCESS_REASONS.UNAVAILABLE, '配置面尚未装配，无法读取 Gitee 配置');
    const refresh = refreshFlag(request?.query);
    try {
      return ok(readSnapshot({ refresh }), stamp());
    } catch (error) {
      // 不拼 error.message：fs / YAML 的错误消息里可能带绝对路径（AC-12）。
      return fail(
        500,
        CODES.SNAPSHOT_FAILED,
        '读取 Gitee 配置失败，请刷新重试',
        null,
        null,
        failureDetailOf(error, refresh),
      );
    }
  }

  /** POST：预检头 → JSON → 形状 → 保存，状态码见 TECHNICAL §3.2。 */
  async function handlePost(request = {}) {
    if (!canRead || !canSave) {
      return fail(503, GITEE_ACCESS_REASONS.UNAVAILABLE, '配置面尚未装配，无法保存配置');
    }

    const token = headerValue(request?.headers, GITEE_REQUEST_HEADER);
    if (token !== '1' && token !== 'true') {
      return fail(400, CODES.BAD_REQUEST, `缺少同源请求头 ${GITEE_REQUEST_HEADER}: 1`);
    }

    const contentType = headerValue(request?.headers, 'content-type');
    if (typeof contentType === 'string' && contentType !== '' && !/json/iu.test(contentType)) {
      return fail(400, CODES.BAD_REQUEST, '请求体必须是 application/json');
    }

    const parsed = parseBody(request?.rawBody);
    if (parsed.ok !== true) {
      // 超限是 413：请求形状本身没错，只是不该有这么大。
      return parsed.reason === 'size'
        ? fail(413, CODES.PAYLOAD_TOO_LARGE, '请求体过大')
        : fail(400, CODES.BAD_REQUEST, '请求体不是合法的 JSON 对象');
    }

    const payload = parsed.value;
    const unknownKeys = Object.keys(payload).filter((key) => !BODY_KEYS.includes(key));
    if (unknownKeys.length > 0) {
      return fail(400, CODES.BAD_REQUEST, '请求体包含未知字段', { [unknownKeys[0]]: '未知字段' });
    }
    if (payload.fields !== undefined && !isPlainObject(payload.fields)) {
      return fail(400, CODES.BAD_REQUEST, 'fields 必须是一个字段对象');
    }
    if (payload.revision !== undefined && typeof payload.revision !== 'string') {
      return fail(400, CODES.BAD_REQUEST, 'revision 必须是字符串');
    }
    const unknownFields = Object.keys(payload.fields ?? {}).filter((field) => !GITEE_CONFIG_KEYS.includes(field));
    if (unknownFields.length > 0) {
      return fail(400, CODES.BAD_REQUEST, '请求体包含未知配置项', { [unknownFields[0]]: '未知配置项' });
    }

    let result;
    try {
      result = await access.save({ revision: payload.revision ?? '', fields: payload.fields ?? {} });
    } catch {
      return fail(503, GITEE_ACCESS_REASONS.UNAVAILABLE, '写入配置失败，请检查 profile 权限');
    }

    if (isPlainObject(result) && result.ok === true && result.snapshot) {
      const body = { ok: true, snapshot: result.snapshot };
      // `applied` 是增量字段（§3.4）：有就原样透传，没有就不编一个"已应用"。
      if (isPlainObject(result.applied)) body.applied = { ...result.applied };
      return ok(body, stamp());
    }
    const code = isPlainObject(result) && typeof result.code === 'string'
      ? result.code
      : GITEE_ACCESS_REASONS.UNAVAILABLE;
    const status = STATUS_BY_CODE[code] ?? 500;
    const message = isPlainObject(result) && typeof result.message === 'string' && result.message !== ''
      ? result.message
      : '保存配置失败';
    const errors = isPlainObject(result) && isPlainObject(result.errors) ? result.errors : null;
    return fail(status, code, message, errors);
  }

  return Object.freeze({ handleGet, handlePost });
}

/** 收集 Node 请求体（有上限）。返回 `{ text, tooLarge }`；非流对象退化为空体。 */
async function readRequestBody(req) {
  if (isPlainObject(req) && (typeof req.body === 'string' || Buffer.isBuffer(req.body) || isPlainObject(req.body))) {
    return { text: req.body, tooLarge: false };
  }
  if (req === null || req === undefined || typeof req[Symbol.asyncIterator] !== 'function') {
    return { text: '', tooLarge: false };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buffer.length;
    if (size > GITEE_MAX_BODY) return { text: '', tooLarge: true };
    chunks.push(buffer);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

/** 把 `{ status, headers, body }` 写回 Node 响应；响应已断开就静默（绝不写日志，AC-12）。 */
function writeResponse(res, result) {
  if (res === null || res === undefined) return;
  const headers = isPlainObject(result?.headers) ? result.headers : BASE_HEADERS;
  const payload = JSON.stringify(result?.body ?? null);
  try {
    if (typeof res.setHeader === 'function') {
      for (const key of Object.keys(headers)) res.setHeader(key, headers[key]);
      if ('statusCode' in res || typeof res.statusCode === 'number') res.statusCode = result.status;
      if (typeof res.writeHead === 'function' && typeof res.end !== 'function') {
        res.writeHead(result.status, headers);
        return;
      }
      if (typeof res.end === 'function' && res.writableEnded !== true) res.end(payload);
      return;
    }
    if (typeof res.writeHead === 'function') {
      res.writeHead(result.status, headers);
      if (typeof res.end === 'function') res.end(payload);
      return;
    }
    // 兜底：给"只收集结果"的假对象用（用例/其他框架适配器）。
    res.status = result.status;
    res.headers = headers;
    res.body = payload;
  } catch {
    // 客户端断开：没有可恢复的动作，也不能把内容打进日志。
  }
}

/**
 * Node `req/res` 适配器（`webServer.register` 的 handler 形态）。
 *
 * 路由既可能是 `kind:'prefix'`（`/api/forge-gitee`）也可能是 exact（`/config`），两种都收到
 * 同一条 `req.url`，所以这里按**全路径**比对 `GITEE_CONFIG_ROUTE`，不依赖注册方式。
 *
 * @param {{handleGet:Function, handlePost:Function}} api `createGiteeApi()` 的结果
 * @param {{path?: string}} [options] `path` 可覆盖端点（默认 `GITEE_CONFIG_ROUTE`）
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function toNodeRoute(api, options = {}) {
  const routePath = typeof options?.path === 'string' && options.path !== '' ? options.path : GITEE_CONFIG_ROUTE;
  const trimmed = normalizeRoutePath(routePath);

  return async function handleForgeGiteeConfigRequest(req, res) {
    let result;
    try {
      const { pathname, params } = splitRequestUrl(req?.url);

      if (pathname !== trimmed) {
        result = fail(404, CODES.NOT_FOUND, '未知的配置端点');
      } else {
        const method = String(req?.method ?? 'GET').toUpperCase();
        if (method === 'GET' || method === 'HEAD') {
          result = await api.handleGet({ query: params });
        } else if (method === 'POST') {
          const body = await readRequestBody(req);
          result = body.tooLarge
            ? fail(413, CODES.PAYLOAD_TOO_LARGE, '请求体过大')
            : await api.handlePost({ headers: isPlainObject(req?.headers) ? req.headers : {}, rawBody: body.text });
        } else {
          result = fail(405, CODES.METHOD_NOT_ALLOWED, '只支持 GET 与 POST', null, { allow: 'GET, POST' });
        }
      }
    } catch {
      result = fail(500, CODES.SNAPSHOT_FAILED, '请求处理失败');
    }
    writeResponse(res, result);
  };
}
