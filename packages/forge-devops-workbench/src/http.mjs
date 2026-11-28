/**
 * `@heluo/forge-devops-workbench` 同源 HTTP 路由聚合器（CORP-DSH-DESIGN-028 §5.1）。
 *
 * 安全收敛规则：
 *   1. 不设 CORS 头，接入宿主 `connection` 同源会话鉴权；
 *   2. 全响应 `cache-control: no-store` 与 `x-content-type-options: nosniff`；
 *   3. 全部端点强制要求 `x-forge-workbench-request: 1` 自定义头防跨站伪造；
 *   4. 仅维护公共基础路由与各领域 `routes.mjs` 注册表，各域互不冲突。
 */
import { Buffer } from 'node:buffer';
import { ERROR_CODES, WorkbenchError, toErrorEnvelope } from './shared/errors.mjs';
import { createOverviewRoutes } from './domains/overview/routes.mjs';
import { createRequirementRoutes } from './domains/requirement/routes.mjs';

export const WORKBENCH_API_PREFIX = '/api/forge-devops-workbench';
export const WORKBENCH_REQUEST_HEADER = 'x-forge-workbench-request';

const MAX_BODY_BYTES = 128 * 1024;

const BASE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const headersOf = (extra = null) => (extra ? { ...BASE_HEADERS, ...extra } : BASE_HEADERS);

function ok(body, status = 200, extraHeaders = null) {
  return { status, headers: headersOf(extraHeaders), body };
}

function failFromError(err, endpointKind = 'enterprise', requestId = '', extraHeaders = null) {
  if (err instanceof WorkbenchError) {
    return {
      status: err.httpStatus,
      headers: headersOf(extraHeaders),
      body: toErrorEnvelope(err, { endpointKind, requestId }),
    };
  }
  const wrapped = new WorkbenchError(ERROR_CODES.INTERNAL_ERROR, undefined, { requestId });
  return {
    status: wrapped.httpStatus,
    headers: headersOf(extraHeaders),
    body: toErrorEnvelope(wrapped, { endpointKind, requestId }),
  };
}

function normalizePath(raw) {
  if (typeof raw !== 'string' || raw === '') return '/';
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * 拆解 origin-form URL，不依赖写死 baseUrl 字面量。
 *
 * @param {string} rawUrl
 */
export function splitRequestUrl(rawUrl) {
  const text = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : '/';
  const hashAt = text.indexOf('#');
  const noHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const queryAt = noHash.indexOf('?');
  const pathname = normalizePath(queryAt === -1 ? noHash : noHash.slice(0, queryAt));
  const search = queryAt === -1 ? '' : noHash.slice(queryAt + 1);
  return { pathname, params: new URLSearchParams(search) };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const val = headers.get(name);
    return typeof val === 'string' ? val : undefined;
  }
  if (typeof headers !== 'object') return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : undefined;
    }
  }
  return undefined;
}

function assertRequestHeader(headers) {
  const value = headerValue(headers, WORKBENCH_REQUEST_HEADER);
  if (value !== '1') {
    throw new WorkbenchError(
      ERROR_CODES.REQUEST_HEADER_REQUIRED,
      `缺少或无效请求头 ${WORKBENCH_REQUEST_HEADER}: 1`,
      { httpStatus: 403, upstream: 'workbench-http' },
    );
  }
}

function parseJsonBody(rawBody) {
  if (isPlainObject(rawBody)) return rawBody;
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, 'JSON 请求体必须为对象');
    }
    return parsed;
  } catch (err) {
    if (err instanceof WorkbenchError) throw err;
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, 'JSON 请求体解析失败');
  }
}

async function readRequestBody(req) {
  if (isPlainObject(req) && (typeof req.body === 'string' || Buffer.isBuffer(req.body) || isPlainObject(req.body))) {
    return { text: req.body, tooLarge: false };
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    return { text: '', tooLarge: false };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return { text: '', tooLarge: true };
    chunks.push(buf);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

function writeResponse(res, result) {
  if (!res) return;
  const headers = isPlainObject(result?.headers) ? result.headers : BASE_HEADERS;
  const payload = JSON.stringify(result?.body ?? null);
  try {
    if (typeof res.setHeader === 'function') {
      for (const key of Object.keys(headers)) res.setHeader(key, headers[key]);
      if ('statusCode' in res || typeof res.statusCode === 'number') res.statusCode = result.status;
      if (typeof res.end === 'function' && res.writableEnded !== true) res.end(payload);
      return;
    }
    if (typeof res.writeHead === 'function') {
      res.writeHead(result.status, headers);
      if (typeof res.end === 'function') res.end(payload);
      return;
    }
    res.status = result.status;
    res.headers = headers;
    res.body = payload;
  } catch {
    // 忽略客户端已断开的写异常
  }
}

function toIntOrDefault(val, fallback, min = 1, max = 200) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `分页或数字参数越界（允许 ${min}-${max}）`);
  }
  return n;
}

/**
 * 复用 DSH Connection 同源鉴权（与 @heluo/forge-iam 一致，CORP-DSH-DESIGN-028 / issue #260 §3.2）。
 * 若当前宿主未注册 connection（如离线单测或简化环境），不额外拦截，保留自定义请求头校验。
 *
 * @param {unknown} headers
 * @param {(() => object | undefined) | undefined} getConnection
 * @returns {401 | 403 | 503 | undefined}
 */
function connectionRejection(headers, getConnection) {
  if (typeof getConnection !== 'function') return undefined;
  let connection;
  try {
    connection = getConnection();
  } catch {
    return 503;
  }
  if (connection === undefined || connection === null) return undefined;
  try {
    if (typeof connection.requestRejection !== 'function') return 503;
    const result = connection.requestRejection({ headers: isPlainObject(headers) ? headers : {} });
    if (result === undefined || result === 401 || result === 403) return result;
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    return 503;
  } catch {
    return 503;
  }
}

function buildCoreRoutes(service) {
  return [
    {
      path: '/bootstrap',
      methods: ['GET', 'HEAD'],
      allow: 'GET',
      async handler({ params }) {
        const refresh = params?.get('refresh') === '1' || params?.get('refresh') === 'true';
        return service.getBootstrap({ refresh });
      },
    },
    {
      path: '/config',
      methods: ['GET', 'HEAD', 'PUT', 'POST'],
      allow: 'GET, PUT',
      async handler({ method, rawBody }) {
        if (method === 'GET' || method === 'HEAD') {
          return service.getRuntimeConfig();
        }
        return service.updateRuntimeConfig(parseJsonBody(rawBody));
      },
    },
    {
      path: '/prompt/build',
      methods: ['POST'],
      allow: 'POST',
      async handler({ rawBody }) {
        return service.buildPrompt(parseJsonBody(rawBody));
      },
    },
    {
      path: '/preferences',
      methods: ['PUT', 'POST'],
      allow: 'PUT',
      async handler({ rawBody }) {
        return service.savePreferences(parseJsonBody(rawBody));
      },
    },
  ];
}

/**
 * 与具体 HTTP 服务器解耦的工作台同源路由处理器。
 *
 * @param {ReturnType<import('./service.mjs').createWorkbenchService>} service
 * @param {{ getConnection?: () => object | undefined }} [options]
 */
export function createWorkbenchHttpApi(service, options = {}) {
  const getEndpointKind = () => service?.endpointKind ?? 'enterprise';
  const getConnection = typeof options?.getConnection === 'function' ? options.getConnection : undefined;

  const helpers = Object.freeze({ toIntOrDefault, parseJsonBody });
  const routes = [
    ...buildCoreRoutes(service),
    ...createOverviewRoutes(service, helpers),
    ...createRequirementRoutes(service, helpers),
  ];
  const routeTable = new Map(routes.map((route) => [route.path, route]));

  async function dispatch({ method = 'GET', pathname, params, headers = {}, rawBody = '' }) {
    const endpointKind = getEndpointKind();
    const subPath = pathname.startsWith(WORKBENCH_API_PREFIX)
      ? pathname.slice(WORKBENCH_API_PREFIX.length) || '/'
      : pathname;
    const normSub = normalizePath(subPath);

    try {
      const connRejected = connectionRejection(headers, getConnection);
      if (connRejected === 401) {
        return failFromError(
          new WorkbenchError(ERROR_CODES.UNAUTHORIZED, '未通过宿主同源会话鉴权', {
            httpStatus: 401,
            upstream: 'workbench-http',
          }),
          endpointKind,
        );
      }
      if (connRejected === 403) {
        return failFromError(
          new WorkbenchError(ERROR_CODES.FORBIDDEN, '同源连接来源被拒绝', {
            httpStatus: 403,
            upstream: 'workbench-http',
          }),
          endpointKind,
        );
      }
      if (connRejected) {
        return failFromError(
          new WorkbenchError(ERROR_CODES.UNAVAILABLE, '宿主连接鉴权服务暂时不可用', {
            httpStatus: 503,
            upstream: 'workbench-http',
          }),
          endpointKind,
        );
      }

      assertRequestHeader(headers);

      const route = routeTable.get(normSub);
      if (!route) {
        return failFromError(
          new WorkbenchError(ERROR_CODES.NOT_FOUND, undefined, { httpStatus: 404 }),
          endpointKind,
        );
      }

      const upper = String(method || 'GET').toUpperCase();
      if (!route.methods.includes(upper)) {
        return failFromError(
          new WorkbenchError(ERROR_CODES.METHOD_NOT_ALLOWED, `只支持 ${route.allow}`, { httpStatus: 405 }),
          endpointKind,
          '',
          { allow: route.allow },
        );
      }

      return ok(await route.handler({ method: upper, params, headers, rawBody, ...helpers }));
    } catch (err) {
      return failFromError(err, endpointKind);
    }
  }

  return Object.freeze({ dispatch });
}

/**
 * Node `req/res` 适配器（供 `webServer.register` 使用）。
 */
export function toNodeRoute(api) {
  return async function handleForgeDevopsWorkbenchRequest(req, res) {
    let result;
    try {
      const { pathname, params } = splitRequestUrl(req?.url);
      const method = String(req?.method ?? 'GET').toUpperCase();
      let rawBody = '';
      if (method === 'POST' || method === 'PUT') {
        const body = await readRequestBody(req);
        if (body.tooLarge) {
          result = failFromError(new WorkbenchError(ERROR_CODES.BAD_REQUEST, '请求体超过 128 KiB 上限'));
          writeResponse(res, result);
          return;
        }
        rawBody = body.text;
      }
      result = await api.dispatch({
        method,
        pathname,
        params,
        headers: isPlainObject(req?.headers) ? req.headers : {},
        rawBody,
      });
    } catch {
      result = failFromError(new WorkbenchError(ERROR_CODES.INTERNAL_ERROR));
    }
    writeResponse(res, result);
  };
}
