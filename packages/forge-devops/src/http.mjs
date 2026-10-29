/**
 * `@heluo/forge-devops` 配置页的同源 HTTP 契约（T3）。
 *
 * 页面要的是**服务端事实**（哪一层命中、发现到哪几个路径、写面可不可用），而配置值本身受
 * `dsh-settings` 表单面的 schema 约束（要 `toJSON` + `volatile`），所以数据通道是一条自己的
 * 同源路由，而不是 `configForms`：前缀 `/api/forge-devops`，端点 `/cli`。
 *
 * 三条收紧规则（AC-10 / 偏离 2）：
 *   1. **写完不设 CORS 头**：只有同源页面能读，路径回显不外溢；
 *   2. **全响应 `cache-control: no-store`**：路径与快照不许被任何中间层缓存；
 *   3. **写操作要求 `x-forge-devops-request: 1`**：跨站表单设不了自定义头，浏览器会把带该头的
 *      请求按预检处理，简单表单 POST 直接被挡在门外。
 *
 * 本模块与框架无关：`handleGet` / `handlePost` 返回 `{ status, headers, body }`（`body` 是对象，
 * 由适配器序列化），因此状态码矩阵可以在离线用例里逐条断言；`toNodeRoute` 是唯一的 Node 适配面。
 * 响应体只放**类别词与原因码**，绝不带路径：错误消息由本模块写死，不拼 `error.message`
 * （fs 抛出的错误消息里就带着绝对路径）。
 */
import { Buffer } from 'node:buffer';

import { CLI_FIELDS, CLI_REASONS } from './cli-config.mjs';

/** 路由前缀：`index.mjs` 用它注册（`kind:'prefix'`），页面用它拼端点。 */
export const CLI_API_PREFIX = '/api/forge-devops';

/** 端点全路径：前缀 + `/cli`。注册成 prefix 或 exact 都指向这里。 */
export const CLI_ROUTE_PATH = `${CLI_API_PREFIX}/cli`;

/** 写操作的预检头（值只有"在不在"的意义，见文件头第 3 条）。 */
export const CLI_REQUEST_HEADER = 'x-forge-devops-request';

/** 请求体形状：只认这两个顶层键，多一个就 400（不猜"也许他想写 revision"）。 */
const BODY_KEYS = Object.freeze(['revision', 'fields']);

/** 请求体上限：六个短字段的补丁，超过这个尺寸一定不是本页面发的。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 本模块自己的原因码（配置层的四码之外，只用于"请求不合法 / 路由不存在"）。 */
const CODES = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  SNAPSHOT_FAILED: 'CLI_SNAPSHOT_FAILED',
});

/** 响应头：统一 no-store + nosniff，**不设** `access-control-*`。 */
const BASE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
});

/** 保存结果码 → HTTP 状态。码是配置层的唯一词汇（`cli-config.CLI_REASONS`）。 */
const STATUS_BY_CODE = Object.freeze({
  [CLI_REASONS.CONFLICT]: 409,
  [CLI_REASONS.INVALID]: 422,
  [CLI_REASONS.UNAVAILABLE]: 503,
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const headersOf = (extra = null) => (extra === null ? BASE_HEADERS : { ...BASE_HEADERS, ...extra });

/** 成功响应：`body` 由适配器序列化（用例可以直接 `deepEqual(body, snapshot)`）。 */
function ok(body, extraHeaders = null) {
  return { status: 200, headers: headersOf(extraHeaders), body };
}

/** 统一错误体 `{ ok:false, code, message, errors? }`——页面据此选文案，别再拼字符串。 */
function fail(status, code, message, errors = null, extraHeaders = null) {
  const body = { ok: false, code, message };
  if (isPlainObject(errors) && Object.keys(errors).length > 0) body.errors = { ...errors };
  return { status, headers: headersOf(extraHeaders), body };
}

/** 去掉尾斜杠：`/api/forge-devops/cli/` 与 exact 注册等价。 */
function normalizeRoutePath(value) {
  if (typeof value !== 'string' || value === '') return '/';
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * 拆 `req.url`（origin-form）。不用 `URL`：它需要一个带 scheme 的基址，而基址字面量本身就是
 * "硬编码 URL"（交付自检会红），这里只需要路径 + 查询串。
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

/** `?refresh=1`（也接受 true/yes/on）：只有它会让主机重做一次有界发现（AC-4）。 */
function refreshFlag(query) {
  const raw = queryValue(query, 'refresh');
  if (typeof raw !== 'string') return false;
  const flag = raw.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

/** 请求体 → 对象。非对象 / 非法 JSON / 超限都返回 `{ ok:false }`（由调用方给 400）。 */
function parseBody(rawBody) {
  if (isPlainObject(rawBody)) return { ok: true, value: rawBody };
  let text = null;
  if (typeof rawBody === 'string') text = rawBody;
  else if (Buffer.isBuffer(rawBody)) text = rawBody.toString('utf8');
  else if (rawBody === null || rawBody === undefined) text = '';
  if (text === null) return { ok: false, reason: 'json' };
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { ok: false, reason: 'size' };
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
 *   `createCliAccess()` 的返回值（缺失时读面 503，而不是抛异常）
 * @param {() => number} [options.now] 时钟：只用于响应头 `x-forge-devops-at`（诊断用）
 * @returns {{handleGet: (request?: object) => object, handlePost: (request?: object) => Promise<object>}}
 */
export function createCliApi(options = {}) {
  const { access = null, now = Date.now } = options ?? {};
  const clock = typeof now === 'function' ? now : Date.now;
  const usable = isPlainObject(access) && typeof access.snapshot === 'function';

  function stamp() {
    const value = clock();
    const at = new Date(typeof value === 'number' && Number.isFinite(value) ? value : Date.now());
    return { 'x-forge-devops-at': at.toISOString() };
  }

  /** GET：无参 = 装配期快照；`?refresh=1` = 重新做一次有界发现（页面唯一的重扫动作）。 */
  function handleGet(request = {}) {
    if (!usable) return fail(503, CLI_REASONS.UNAVAILABLE, '配置面尚未装配，无法读取命令行状态');
    try {
      const snapshot = access.snapshot({ refresh: refreshFlag(request?.query) });
      return ok(snapshot, stamp());
    } catch {
      // 不拼 error.message：fs / YAML 的错误消息里可能带绝对路径（AC-10）。
      return fail(500, CODES.SNAPSHOT_FAILED, '读取命令行状态失败，请刷新重试');
    }
  }

  /** POST：预检头 → JSON → 形状 → 保存，状态码见 TECHNICAL §3.1。 */
  async function handlePost(request = {}) {
    if (!usable || typeof access.save !== 'function') {
      return fail(503, CLI_REASONS.UNAVAILABLE, '配置面尚未装配，无法保存配置');
    }

    const token = headerValue(request?.headers, CLI_REQUEST_HEADER);
    if (token !== '1' && token !== 'true') {
      return fail(400, CODES.BAD_REQUEST, `缺少同源请求头 ${CLI_REQUEST_HEADER}: 1`);
    }

    const contentType = headerValue(request?.headers, 'content-type');
    if (typeof contentType === 'string' && contentType !== '' && !/json/iu.test(contentType)) {
      return fail(400, CODES.BAD_REQUEST, '请求体必须是 application/json');
    }

    const parsed = parseBody(request?.rawBody);
    if (parsed.ok !== true) {
      return fail(
        400,
        CODES.BAD_REQUEST,
        parsed.reason === 'size' ? '请求体过大' : '请求体不是合法的 JSON 对象',
      );
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
    const unknownFields = Object.keys(payload.fields ?? {}).filter((field) => !CLI_FIELDS.includes(field));
    if (unknownFields.length > 0) {
      return fail(400, CODES.BAD_REQUEST, '请求体包含未知配置项', { [unknownFields[0]]: '未知配置项' });
    }

    let result;
    try {
      result = await access.save({ revision: payload.revision ?? '', fields: payload.fields ?? {} });
    } catch {
      return fail(503, CLI_REASONS.UNAVAILABLE, '写入配置失败，请检查 profile 权限');
    }

    if (isPlainObject(result) && result.ok === true && result.snapshot) {
      return ok({ ok: true, snapshot: result.snapshot }, stamp());
    }
    const code = isPlainObject(result) && typeof result.code === 'string' ? result.code : CLI_REASONS.UNAVAILABLE;
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
    if (size > MAX_BODY_BYTES) return { text: '', tooLarge: true };
    chunks.push(buffer);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

/** 把 `{ status, headers, body }` 写回 Node 响应；响应已断开就静默（绝不写日志，AC-10）。 */
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
 * 路由既可能是 `kind:'prefix'`（`/api/forge-devops`）也可能是 exact（`/cli`），两种都收到同一条
 * `req.url`，所以这里按**全路径**比对 `CLI_ROUTE_PATH`，不依赖注册方式。
 *
 * @param {{handleGet:Function, handlePost:Function}} api `createCliApi()` 的结果
 * @param {{path?: string}} [options] `path` 可覆盖端点（默认 `CLI_ROUTE_PATH`）
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function toNodeRoute(api, options = {}) {
  const routePath = typeof options?.path === 'string' && options.path !== '' ? options.path : CLI_ROUTE_PATH;
  const trimmed = normalizeRoutePath(routePath);

  return async function handleForgeDevopsCliRequest(req, res) {
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
            ? fail(400, CODES.BAD_REQUEST, '请求体过大')
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
