/**
 * DOP 域通用裸头 HTTP 客户端（面向 /uam|asd|ppm|bpm|odo|tmp/api/**）。
 *
 * 严格遵循 CORP-DSH-TOOLS-002 §2 & §3：
 *   1. Authorization 头使用裸令牌格式，严禁添加 Bearer 前缀；
 *   2. HTTP 403（JSON Access Denied 或纯文本 Access Denied）：IAM 模式下刷新令牌重试至多 1 次，
 *      仍失败则归一为 UPSTREAM_AUTH_DENIED；
 *   3. /uam/api/user/myProfile 使用白名单字段投影，丢弃 teams 等超大数组。
 */
import { ERROR_CODES, WorkbenchError } from './errors.mjs';

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
    if (outerSignal.aborted) {
      onOuterAbort();
    } else {
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
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

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return 2;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.ceil(num) : 2;
}

/**
 * 对实测 4.77 MB 的 /uam/api/user/myProfile 响应执行白名单投影，仅保留必要身份摘要。
 *
 * @param {unknown} raw
 */
export function projectMyProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawRoles = Array.isArray(src.roles) ? src.roles : [];
  const roles = [];
  for (let i = 0; i < rawRoles.length && i < 20; i += 1) {
    const r = rawRoles[i];
    if (!r || typeof r !== 'object') continue;
    roles.push({
      code: String(r.code ?? r.roleCode ?? ''),
      name: String(r.name ?? r.roleName ?? ''),
    });
  }
  return Object.freeze({
    loginCode: String(src.loginCode ?? ''),
    name: String(src.name ?? ''),
    dashboardId: src.dashboardId ?? null,
    simulating: Boolean(src.simulating),
    firstOrgName: String(src.firstOrg?.name ?? src.firstOrg?.orgName ?? ''),
    secondOrgName: String(src.secondOrg?.name ?? src.secondOrg?.orgName ?? ''),
    roles,
  });
}

/**
 * 创建 DOP 域通用 HTTP 客户端（仅封装传输与鉴权重试，具体业务 API 由各领域模块封装）。
 *
 * @param {object} options
 */
export function createDopClient(options) {
  const {
    apiBaseUrl,
    requestTimeoutMs = 10000,
    getToken,
    fetchImpl = globalThis.fetch,
    logger,
  } = options;

  async function requestDop({ method = 'GET', path, query = null, body = undefined, signal, routeKey = path, requestId = '' }) {
    if (!apiBaseUrl) {
      throw new WorkbenchError(ERROR_CODES.CONFIG_MISSING, undefined, { upstream: 'dop-api', requestId });
    }
    if (typeof fetchImpl !== 'function') {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, '当前运行时缺少 fetch 支持', { upstream: 'dop-api', requestId });
    }

    let attempt = 0;
    while (attempt < 2) {
      const forceRefresh = attempt > 0;
      const rawToken = await getToken({ forceRefresh });
      if (typeof rawToken !== 'string' || rawToken.trim() === '') {
        throw new WorkbenchError(ERROR_CODES.UNAUTHORIZED, undefined, { upstream: 'dop-api', requestId });
      }
      // DOP 域严格使用裸 token，严禁添加 Bearer 前缀
      const bareToken = rawToken.trim().replace(/^bearer\s+/iu, '');
      const url = buildUrl(apiBaseUrl, path, query);
      const headers = {
        authorization: bareToken,
        accept: 'application/json',
      };
      const init = { method, headers };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      const linked = linkAbortSignals(signal, requestTimeoutMs);
      init.signal = linked.signal;
      const started = Date.now();
      let response;
      try {
        response = await fetchImpl(url, init);
      } catch (err) {
        linked.cleanup();
        if (linked.wasOuterAborted()) {
          throw new WorkbenchError(ERROR_CODES.CONFLICT_BUSY, undefined, {
            upstream: 'dop-api',
            retryable: true,
            requestId,
            cause: err,
          });
        }
        throw new WorkbenchError(
          ERROR_CODES.UNAVAILABLE,
          linked.wasTimedOut() ? `DOP 接口超时（${routeKey}）` : `DOP 接口连接失败（${routeKey}）`,
          { upstream: 'dop-api', retryable: true, requestId, cause: err },
        );
      }

      try {
        const text = await response.text();
        const durationMs = Date.now() - started;

        if (response.status === 403) {
          logger?.('workbench.dop.auth_denied', { routeKey, httpStatus: 403, attempt, durationMs, requestId });
          if (attempt === 0) {
            attempt += 1;
            continue;
          }
          throw new WorkbenchError(ERROR_CODES.UPSTREAM_AUTH_DENIED, undefined, {
            httpStatus: 403,
            upstream: 'dop-api',
            retryable: false,
            requestId,
          });
        }

        if (response.status === 401) {
          throw new WorkbenchError(ERROR_CODES.UNAUTHORIZED, undefined, {
            httpStatus: 401,
            upstream: 'dop-api',
            retryable: false,
            requestId,
          });
        }

        if (response.status === 429) {
          throw new WorkbenchError(ERROR_CODES.RATE_LIMITED, undefined, {
            httpStatus: 429,
            upstream: 'dop-api',
            retryable: true,
            retryAfterSec: parseRetryAfter(response.headers),
            requestId,
          });
        }

        if (response.status >= 500) {
          throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, `DOP 上游返回 HTTP ${response.status}（${routeKey}）`, {
            httpStatus: 503,
            upstream: 'dop-api',
            retryable: true,
            requestId,
          });
        }

        if (response.status === 400 || response.status === 404) {
          throw new WorkbenchError(
            response.status === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.BAD_REQUEST,
            `DOP 请求参数被拒绝（HTTP ${response.status}）`,
            { httpStatus: response.status, upstream: 'dop-api', retryable: false, requestId },
          );
        }

        if (!response.ok) {
          throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, `DOP 返回异常状态 HTTP ${response.status}`, {
            httpStatus: response.status,
            upstream: 'dop-api',
            retryable: false,
            requestId,
          });
        }

        if (HTML_BODY_RE.test(text)) {
          throw new WorkbenchError(ERROR_CODES.UPSTREAM_SCHEMA_DRIFT, undefined, {
            upstream: 'dop-api',
            requestId,
          });
        }

        let parsed;
        try {
          parsed = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          throw new WorkbenchError(ERROR_CODES.UPSTREAM_SCHEMA_DRIFT, undefined, {
            upstream: 'dop-api',
            requestId,
          });
        }

        if (parsed === null || typeof parsed !== 'object') {
          throw new WorkbenchError(ERROR_CODES.UPSTREAM_SCHEMA_DRIFT, undefined, {
            upstream: 'dop-api',
            requestId,
          });
        }

        return parsed;
      } finally {
        linked.cleanup();
      }
    }

    throw new WorkbenchError(ERROR_CODES.UPSTREAM_AUTH_DENIED, undefined, {
      httpStatus: 403,
      upstream: 'dop-api',
      requestId,
    });
  }

  return Object.freeze({
    requestDop,
    async getMyProfile({ signal, requestId } = {}) {
      const raw = await requestDop({
        method: 'GET',
        path: '/uam/api/user/myProfile',
        routeKey: 'uam.myProfile',
        signal,
        requestId,
      });
      return projectMyProfile(raw);
    },
  });
}
