/**
 * RMP 域（/rdp/vpgatway/**）SSO 换票与 HTTP 客户端（CORP-DSH-TOOLS-002 §2 & §3.4）。
 *
 * 严格约束：
 *   1. IAM 访问令牌不能直接透传 RMP 业务接口；须先 GET /rdp/vpgatway/vrmprovider/rms/api/sso
 *      换取 302 Set-Cookie: _tk=<tk>；
 *   2. 进程内存按 sessionKey 隔离缓存 _tk，TTL 上限不超过 11.5 小时；
 *   3. 业务请求必须携带 Authorization: Bearer <_tk>；
 *   4. getOutlineTree / selectArtInfo 强制发送 application/x-www-form-urlencoded 表单；
 *   5. 任何 RMP 接口返回 HTTP 401（含空响应体）时立即失效缓存并重换 _tk 重试至多 1 次。
 */
import { ERROR_CODES, WorkbenchError } from './errors.mjs';

export const DEFAULT_RMP_TK_TTL_MS = 11.5 * 60 * 60 * 1000;
const MAX_RMP_TK_TTL_MS = 11.5 * 60 * 60 * 1000;
const HTML_BODY_RE = /^\s*(?:<!doctype\s+html|<html\b)/iu;

function buildUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function linkAbortSignals(outerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let outerAborted = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('TIMEOUT'));
  }, timeoutMs);
  timer.unref?.();

  const onOuterAbort = () => {
    outerAborted = true;
    controller.abort(outerSignal?.reason);
  };

  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    wasOuterAborted: () => outerAborted,
    cleanup() {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    },
  };
}

/**
 * 从 Fetch Response Headers 提取 `_tk` Cookie 值。
 *
 * @param {Headers | Record<string, unknown>} headers
 * @returns {string}
 */
export function extractTkCookie(headers) {
  if (!headers) return '';
  const candidates = [];
  if (typeof headers.getSetCookie === 'function') {
    candidates.push(...headers.getSetCookie());
  }
  const single = typeof headers.get === 'function' ? headers.get('set-cookie') : headers['set-cookie'];
  if (typeof single === 'string' && single !== '') candidates.push(single);
  if (Array.isArray(single)) candidates.push(...single);

  for (const rawCookie of candidates) {
    const match = /(?:^|[,\s])_tk=([^;,\s]+)/u.exec(String(rawCookie));
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.ceil(num) : 2;
}

/**
 * 创建 RMP 域客户端（含进程内存 _tk 缓存与单飞换票）。
 */
export function createRmpClient(options) {
  const {
    apiBaseUrl,
    requestTimeoutMs = 10000,
    getSsoToken,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    ttlMs = DEFAULT_RMP_TK_TTL_MS,
    logger,
  } = options;

  const effectiveTtlMs = Math.min(
    MAX_RMP_TK_TTL_MS,
    Math.max(1000, Number.isFinite(ttlMs) ? ttlMs : DEFAULT_RMP_TK_TTL_MS),
  );

  /** @type {Map<string, { tk: string, expiresAtMs: number }>} */
  const tkCache = new Map();
  /** @type {Map<string, Promise<string>>} */
  const inFlightExchange = new Map();

  function clearCache(sessionKey) {
    if (sessionKey) {
      tkCache.delete(sessionKey);
    } else {
      tkCache.clear();
    }
  }

  async function exchangeTk({ sessionKey = 'default', forceRefresh = false, signal, requestId = '' } = {}) {
    if (!apiBaseUrl) {
      throw new WorkbenchError(ERROR_CODES.CONFIG_MISSING, undefined, { upstream: 'rmp-api', requestId });
    }
    if (typeof fetchImpl !== 'function') {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, '当前运行时缺少 fetch 支持', { upstream: 'rmp-api', requestId });
    }

    if (!forceRefresh) {
      const hit = tkCache.get(sessionKey);
      if (hit && hit.expiresAtMs > now()) {
        logger?.('workbench.rmp.sso_exchange', { outcome: 'hit', httpStatus: 200, requestId });
        return hit.tk;
      }
      tkCache.delete(sessionKey);
    } else {
      tkCache.delete(sessionKey);
    }

    const existingFlight = inFlightExchange.get(sessionKey);
    if (existingFlight && !forceRefresh) {
      return existingFlight;
    }

    const flight = (async () => {
      const ssoToken = await getSsoToken({ forceRefresh });
      if (typeof ssoToken !== 'string' || ssoToken.trim() === '') {
        logger?.('workbench.rmp.sso_exchange', { outcome: 'failed', httpStatus: 401, requestId });
        throw new WorkbenchError(ERROR_CODES.UNAUTHORIZED, undefined, { upstream: 'rmp-sso', requestId });
      }
      const cleanToken = ssoToken.trim().replace(/^bearer\s+/iu, '');
      const url = buildUrl(apiBaseUrl, '/rdp/vpgatway/vrmprovider/rms/api/sso', {
        page: 'createRequirement',
        token: cleanToken,
      });

      const linked = linkAbortSignals(signal, requestTimeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: linked.signal,
        });

        const tk = extractTkCookie(response.headers);
        if (!tk || (response.status !== 302 && response.status !== 301 && response.status !== 200)) {
          logger?.('workbench.rmp.sso_exchange', { outcome: 'failed', httpStatus: response.status, requestId });
          throw new WorkbenchError(ERROR_CODES.RMP_SSO_EXCHANGE_FAILED, undefined, {
            httpStatus: response.status === 401 || response.status === 403 ? 401 : 502,
            upstream: 'rmp-sso',
            retryable: false,
            requestId,
          });
        }

        tkCache.set(sessionKey, { tk, expiresAtMs: now() + effectiveTtlMs });
        logger?.('workbench.rmp.sso_exchange', {
          outcome: forceRefresh ? 'refreshed' : 'exchanged',
          httpStatus: response.status,
          requestId,
        });
        return tk;
      } catch (err) {
        if (err instanceof WorkbenchError) throw err;
        if (linked.wasOuterAborted()) {
          throw new WorkbenchError(ERROR_CODES.CONFLICT_BUSY, undefined, {
            upstream: 'rmp-sso',
            retryable: true,
            requestId,
            cause: err,
          });
        }
        throw new WorkbenchError(ERROR_CODES.RMP_SSO_EXCHANGE_FAILED, 'RMP SSO 换票连接失败', {
          httpStatus: 502,
          upstream: 'rmp-sso',
          retryable: true,
          requestId,
          cause: err,
        });
      } finally {
        linked.cleanup();
      }
    })();

    inFlightExchange.set(sessionKey, flight);
    try {
      return await flight;
    } finally {
      if (inFlightExchange.get(sessionKey) === flight) {
        inFlightExchange.delete(sessionKey);
      }
    }
  }

  async function requestRmp({
    method = 'POST',
    path,
    query = null,
    jsonBody = undefined,
    formBody = undefined,
    sessionKey = 'default',
    signal,
    routeKey = path,
    requestId = '',
  }) {
    if (!apiBaseUrl) {
      throw new WorkbenchError(ERROR_CODES.CONFIG_MISSING, undefined, { upstream: 'rmp-api', requestId });
    }

    let attempt = 0;
    while (attempt < 2) {
      const tk = await exchangeTk({ sessionKey, forceRefresh: attempt > 0, signal, requestId });
      const url = buildUrl(apiBaseUrl, path, query);
      const headers = {
        authorization: `Bearer ${tk}`,
        accept: 'application/json',
      };
      const init = { method, headers };

      if (formBody !== undefined) {
        headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(formBody)) {
          params.set(k, v === undefined || v === null ? '' : String(v));
        }
        init.body = params.toString();
      } else if (jsonBody !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(jsonBody);
      }

      const linked = linkAbortSignals(signal, requestTimeoutMs);
      init.signal = linked.signal;
      let response;
      try {
        response = await fetchImpl(url, init);
      } catch (err) {
        linked.cleanup();
        if (linked.wasOuterAborted()) {
          throw new WorkbenchError(ERROR_CODES.CONFLICT_BUSY, undefined, {
            upstream: 'rmp-api',
            retryable: true,
            requestId,
            cause: err,
          });
        }
        throw new WorkbenchError(
          ERROR_CODES.UNAVAILABLE,
          linked.wasTimedOut() ? `RMP 接口超时（${routeKey}）` : `RMP 接口连接失败（${routeKey}）`,
          { upstream: 'rmp-api', retryable: true, requestId, cause: err },
        );
      }

      try {
        const text = await response.text();

        if (response.status === 401) {
          clearCache(sessionKey);
          if (attempt === 0) {
            attempt += 1;
            continue;
          }
          throw new WorkbenchError(ERROR_CODES.RMP_SSO_EXCHANGE_FAILED, undefined, {
            httpStatus: 401,
            upstream: 'rmp-api',
            retryable: false,
            requestId,
          });
        }

        if (response.status === 403) {
          throw new WorkbenchError(ERROR_CODES.FORBIDDEN, undefined, {
            httpStatus: 403,
            upstream: 'rmp-api',
            retryable: false,
            requestId,
          });
        }

        if (response.status === 429) {
          throw new WorkbenchError(ERROR_CODES.RATE_LIMITED, undefined, {
            httpStatus: 429,
            upstream: 'rmp-api',
            retryable: true,
            retryAfterSec: parseRetryAfter(response.headers),
            requestId,
          });
        }

        if (response.status >= 500) {
          throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, `RMP 上游返回 HTTP ${response.status}（${routeKey}）`, {
            httpStatus: 503,
            upstream: 'rmp-api',
            retryable: true,
            requestId,
          });
        }

        if (response.status === 400 || response.status === 404) {
          throw new WorkbenchError(
            response.status === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.BAD_REQUEST,
            `RMP 请求参数被拒绝（HTTP ${response.status}）`,
            { httpStatus: response.status, upstream: 'rmp-api', retryable: false, requestId },
          );
        }

        if (!response.ok) {
          throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, `RMP 返回异常状态 HTTP ${response.status}`, {
            httpStatus: response.status,
            upstream: 'rmp-api',
            retryable: false,
            requestId,
          });
        }

        if (HTML_BODY_RE.test(text)) {
          throw new WorkbenchError(ERROR_CODES.UPSTREAM_SCHEMA_DRIFT, undefined, {
            upstream: 'rmp-api',
            requestId,
          });
        }

        let parsed;
        try {
          parsed = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          throw new WorkbenchError(ERROR_CODES.UPSTREAM_SCHEMA_DRIFT, undefined, {
            upstream: 'rmp-api',
            requestId,
          });
        }
        return parsed;
      } finally {
        linked.cleanup();
      }
    }

    throw new WorkbenchError(ERROR_CODES.RMP_SSO_EXCHANGE_FAILED, undefined, {
      httpStatus: 401,
      upstream: 'rmp-api',
      requestId,
    });
  }

  return Object.freeze({
    clearCache,
    exchangeTk,
    request: requestRmp,

    listAllTodoTask({ sessionKey = 'default', userName = '', currentPage = 1, numPerPage = 20, signal, requestId } = {}) {
      return requestRmp({
        method: 'POST',
        path: '/rdp/vpgatway/vrmprovider/rms/api/listAllTodoTask',
        jsonBody: { userName, currentPage, numPerPage },
        sessionKey,
        routeKey: 'rmp.todoTask',
        signal,
        requestId,
      });
    },

    listAllVerDoc({
      sessionKey = 'default',
      reqCode = '',
      userIds = '',
      quickSearch = '',
      currentPage = 1,
      numPerPage = 10,
      signal,
      requestId,
    } = {}) {
      return requestRmp({
        method: 'POST',
        path: '/rdp/vpgatway/vrmprovider/rms/api/listAllVerDoc',
        jsonBody: { reqCode, userIds, quickSearch, currentPage, numPerPage },
        sessionKey,
        routeKey: 'rmp.listAllVerDoc',
        signal,
        requestId,
      });
    },

    listAllNewVerDoc({
      sessionKey = 'default',
      reqCode = '',
      userIds = '',
      quickSearch = '',
      currentPage = 1,
      numPerPage = 10,
      signal,
      requestId,
    } = {}) {
      return requestRmp({
        method: 'POST',
        path: '/rdp/vpgatway/vrmprovider/rms/api/listAllNewVerDoc',
        jsonBody: { reqCode, userIds, quickSearch, currentPage, numPerPage },
        sessionKey,
        routeKey: 'rmp.listAllNewVerDoc',
        signal,
        requestId,
      });
    },

    listRelDocByReqCode({ sessionKey = 'default', reqCode, signal, requestId } = {}) {
      return requestRmp({
        method: 'POST',
        path: '/rdp/vpgatway/vrmprovider/rms/api/listRelDocByReqCode',
        jsonBody: { reqCode: String(reqCode ?? '').trim() },
        sessionKey,
        routeKey: 'rmp.listRelDocByReqCode',
        signal,
        requestId,
      });
    },

    getOutlineTree({
      sessionKey = 'default',
      docId,
      associatedSystem = '',
      currentPage = 1,
      numPerPage = 100,
      signal,
      requestId,
    } = {}) {
      const cleanDocId = String(docId ?? '').trim();
      if (cleanDocId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少 RMP 文档 docId', { requestId });
      }
      return requestRmp({
        method: 'POST',
        path: '/rdp/vpgatway/vrmprovider/vrm/docArt/getOutlineTree',
        formBody: {
          selectType: '1',
          docId: cleanDocId,
          associatedSystem,
          currentPage: String(currentPage),
          numPerPage: String(numPerPage),
        },
        sessionKey,
        routeKey: 'rmp.getOutlineTree',
        signal,
        requestId,
      });
    },

    selectArtInfo({
      sessionKey = 'default',
      docId,
      associatedSystem = '',
      currentPage = 1,
      numPerPage = 100,
      signal,
      requestId,
    } = {}) {
      const cleanDocId = String(docId ?? '').trim();
      if (cleanDocId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少 RMP 文档 docId', { requestId });
      }
      return requestRmp({
        method: 'POST',
        path: '/rdp/vpgatway/vrmprovider/vrm/docArt/selectArtInfo',
        formBody: {
          selectType: '1',
          docId: cleanDocId,
          associatedSystem,
          currentPage: String(currentPage),
          numPerPage: String(numPerPage),
        },
        sessionKey,
        routeKey: 'rmp.selectArtInfo',
        signal,
        requestId,
      });
    },

    getTabContent({ sessionKey = 'default', iid, entityid = '56', emptyContent, signal, requestId } = {}) {
      const cleanIid = String(iid ?? '').trim();
      if (cleanIid === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少 RMP 条目 iid', { requestId });
      }
      return requestRmp({
        method: 'GET',
        path: '/rdp/vpgatway/vrmprovider/vrm/docArt/getTabContent',
        query: { entityid, iid: cleanIid, emptyContent },
        sessionKey,
        routeKey: 'rmp.getTabContent',
        signal,
        requestId,
      });
    },
  });
}
