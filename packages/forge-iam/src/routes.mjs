import { IamError } from './errors.mjs';

const REQUEST_HEADER = 'x-forge-iam-request';
const REQUEST_VALUE = '1';
const API_PREFIX = '/api/forge-iam';
const MAX_BODY_BYTES = 8 * 1024;

const ERROR_STATUS = {
  IAM_NOT_IMPLEMENTED: 501,
  IAM_UNCONFIGURED: 409,
  IAM_EXCLUSIVE_CONFLICT: 409,
  IAM_INVALID_TRANSITION: 409,
  IAM_CREDENTIALS_UNAVAILABLE: 503,
  IAM_CREDENTIALS_CLEAR_FAILED: 503,
  IAM_CALLBACK_UNAVAILABLE: 500,
  IAM_UNREACHABLE: 502,
  IAM_STATE_MISMATCH: 400,
  IAM_ATTEMPT_EXPIRED: 410,
  IAM_CALLBACK_INVALID: 400,
  IAM_AUTHORIZATION_ERROR: 400,
  IAM_INVALID_GRANT: 401,
  IAM_REAUTH_REQUIRED: 401,
  IAM_NOT_SIGNED_IN: 401,
  IAM_REFRESH_SUBJECT_MISMATCH: 401,
  IAM_GRANT_CONTEXT_MISMATCH: 401,
  IAM_ATTEMPT_CANCELLED: 409,
  IAM_CONFIG_INVALID: 500,
  IAM_DISPOSED: 503,
  IAM_GATEWAY_KEY_INVALID: 400,
  IAM_GATEWAY_OWNER_MISSING: 400,
  IAM_REQUEST_INVALID: 400,
  IAM_REQUEST_TOO_LARGE: 413,
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(payload);
}

function sendHtml(res, status, title, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>`
    + '<body style="font-family:system-ui,sans-serif;padding:2rem"><h1>' + title + '</h1><p>' + body + '</p></body></html>');
}

function errorBody(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('IAM_') ? error.code : 'IAM_INTERNAL';
  return {
    error: {
      code,
      message: error instanceof IamError ? error.message : 'IAM operation failed',
      ...(error?.details?.missing ? { missing: error.details.missing } : {}),
    },
  };
}

/**
 * Read a small JSON body. The credential endpoint is the only consumer, and a
 * pasted key stays in memory: the buffer is bounded before parsing and never
 * logged.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Reject without destroying the socket: the response still has to be
        // written, and resuming drains whatever the client is sending.
        fail(new IamError('IAM_REQUEST_TOO_LARGE', 'request body is too large'));
        req.resume?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new IamError('IAM_REQUEST_INVALID', 'request body must be JSON'));
      }
    });
    req.on('error', (error) => fail(error));
  });
}

function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  return sendJson(res, 405, { error: { code: 'IAM_METHOD_NOT_ALLOWED' } });
}

function expectedOriginOf(getOrigin) {
  if (typeof getOrigin !== 'function') return null;
  try {
    return new URL(getOrigin());
  } catch {
    // A configured resolver failing is not permission to accept any Host.
    return false;
  }
}

function hostMatches(req, expected) {
  if (expected === false) return false;
  if (expected === null) return true;
  const headers = req?.headers ?? {};
  const host = String(headers.host ?? '').toLowerCase();
  if (host !== expected.host.toLowerCase()) return false;
  const origin = headers.origin;
  if (origin && String(origin).toLowerCase() !== expected.origin.toLowerCase()) return false;
  return true;
}

function hasMutationHeader(req) {
  const headers = req?.headers ?? {};
  if (headers[REQUEST_HEADER] !== REQUEST_VALUE) return false;
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) return false;
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

/**
 * Apply DSH Connection's browser/API authentication to the management API.
 * The custom header above proves same-origin intent, not identity, so an
 * unauthenticated caller must not reach the service. A composition without
 * `ctx.connection` fails closed instead of exposing the API.
 *
 * @param {object} req
 * @param {(() => object | undefined) | undefined} getConnection
 * @returns {401 | 403 | 503 | undefined}
 */
function connectionRejection(req, getConnection) {
  let connection;
  try {
    connection = typeof getConnection === 'function' ? getConnection() : undefined;
  } catch {
    connection = undefined;
  }
  if (!connection || typeof connection.requestRejection !== 'function') return 503;
  try {
    return connection.requestRejection({ headers: req?.headers ?? {} }) ?? undefined;
  } catch {
    return 503;
  }
}

/**
 * Same-origin API plus the OIDC loopback callback. Every API request must pass
 * DSH Connection's Host/Origin policy and browser/API authentication; the
 * custom header below only adds CSRF intent (a cross-site form cannot set it
 * without a preflight) and never substitutes for identity. The callback keeps
 * its own Host check and relies on state/PKCE instead: it opens in the system
 * browser, which holds no DSH browser cookie.
 *
 * @param {{ getView: Function, startSignIn: Function, signOut: Function, handleCallback: Function }} service
 * @param {{ callbackPath?: string, getOrigin?: () => string | undefined, getConnection?: () => object | undefined }} [options]
 */
export function createIamRoutes(service, { callbackPath = '/iam/callback', getOrigin, getConnection } = {}) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const expected = expectedOriginOf(getOrigin);

      if (url.pathname === callbackPath) {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET');
          sendHtml(res, 405, '登录回调失败', '回调只接受 GET。');
          return;
        }
        if (!hostMatches(req, expected)) {
          sendHtml(res, 403, '登录回调失败', '回调来源不受信任。');
          return;
        }
        try {
          await service.handleCallback(url.href);
          sendHtml(res, 200, '登录完成', '企业 IAM 登录已完成，可以关闭此页面并返回应用。');
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          sendHtml(res, status, '登录失败', '企业 IAM 登录未完成，请返回应用重试。');
        }
        return;
      }

      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        const rejected = connectionRejection(req, getConnection);
        if (rejected) {
          return sendJson(res, rejected, {
            error: {
              code: rejected === 503 ? 'IAM_CONNECTION_UNAVAILABLE' : 'IAM_UNAUTHENTICATED',
            },
          });
        }
      }

      if (url.pathname === '/api/forge-iam/view') {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        if (typeof service.syncFromStore === 'function') {
          await service.syncFromStore().catch(() => {});
        }
        if (typeof service.loadGatewayCredential === 'function') {
          await service.loadGatewayCredential().catch(() => {});
        }
        return sendJson(res, 200, service.getView());
      }

      if (url.pathname === '/api/forge-iam/credential') {
        if (req.method === 'GET') {
          try {
            if (typeof service.loadGatewayCredential === 'function') await service.loadGatewayCredential();
            return sendJson(res, 200, { credential: service.getView().gatewayCredential });
          } catch (error) {
            const status = ERROR_STATUS[error?.code] ?? 500;
            return sendJson(res, status, errorBody(error));
          }
        }
        if (req.method === 'PUT') {
          if (!hasMutationHeader(req)) return sendJson(res, 403, { error: { code: 'IAM_REQUEST_HEADER_REQUIRED' } });
          try {
            const body = await readJsonBody(req);
            const key = typeof body?.key === 'string' ? body.key.trim() : '';
            if (!key) return sendJson(res, 400, { error: { code: 'IAM_REQUEST_INVALID' } });
            const view = await service.saveGatewayCredential({ key, deviceLabel: body?.deviceLabel });
            return sendJson(res, 200, { view });
          } catch (error) {
            const status = ERROR_STATUS[error?.code] ?? 500;
            // Never echo the submitted value, whatever the failure.
            return sendJson(res, status, errorBody(error));
          }
        }
        if (req.method === 'DELETE') {
          if (!hasMutationHeader(req)) return sendJson(res, 403, { error: { code: 'IAM_REQUEST_HEADER_REQUIRED' } });
          try {
            return sendJson(res, 200, { view: await service.clearGatewayCredential() });
          } catch (error) {
            const status = ERROR_STATUS[error?.code] ?? 500;
            return sendJson(res, status, errorBody(error));
          }
        }
        return methodNotAllowed(res, 'GET, PUT, DELETE');
      }

      if (url.pathname === '/api/forge-iam/sign-in') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!hasMutationHeader(req)) return sendJson(res, 403, { error: { code: 'IAM_REQUEST_HEADER_REQUIRED' } });
        try {
          return sendJson(res, 200, await service.startSignIn());
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          return sendJson(res, status, errorBody(error));
        }
      }

      if (url.pathname === '/api/forge-iam/cancel') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!hasMutationHeader(req)) return sendJson(res, 403, { error: { code: 'IAM_REQUEST_HEADER_REQUIRED' } });
        try {
          return sendJson(res, 200, { view: await service.cancelSignIn() });
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          return sendJson(res, status, errorBody(error));
        }
      }

      if (url.pathname === '/api/forge-iam/sign-out') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!hasMutationHeader(req)) return sendJson(res, 403, { error: { code: 'IAM_REQUEST_HEADER_REQUIRED' } });
        try {
          return sendJson(res, 200, await service.signOut());
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          return sendJson(res, status, errorBody(error));
        }
      }

      return sendJson(res, 404, { error: { code: 'IAM_NOT_FOUND' } });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, errorBody(error));
    }
  };
}
