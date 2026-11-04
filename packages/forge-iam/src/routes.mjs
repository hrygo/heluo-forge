import { IamError } from './errors.mjs';
import { bridgeRejection } from './bridge.mjs';

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
  IAM_ATOMIC_STORE_UNVERIFIED: 503,
  IAM_CREDENTIALS_CLEAR_FAILED: 503,
  IAM_CALLBACK_UNAVAILABLE: 500,
  IAM_UNREACHABLE: 502,
  IAM_STATE_MISMATCH: 400,
  IAM_ATTEMPT_EXPIRED: 410,
  IAM_CALLBACK_INVALID: 400,
  IAM_CALLBACK_ISSUER: 400,
  IAM_ATTEMPT_IN_PROGRESS: 409,
  IAM_AUTHORIZATION_ERROR: 400,
  IAM_INVALID_GRANT: 401,
  IAM_REAUTH_REQUIRED: 401,
  IAM_NOT_SIGNED_IN: 401,
  IAM_REFRESH_SUBJECT_MISMATCH: 401,
  IAM_GRANT_CONTEXT_MISMATCH: 401,
  IAM_CLIENT_AUTH_UNVERIFIED: 503,
  IAM_CLIENT_AUTH_CHANGED: 409,
  IAM_CLIENT_AUTH_CONTEXT_INVALID: 401,
  IAM_ATTEMPT_CANCELLED: 409,
  IAM_CONFIG_INVALID: 500,
  IAM_DISPOSED: 503,
  IAM_RECORD_KIND_MISMATCH: 409,
  IAM_GATEWAY_KEY_INVALID: 400,
  IAM_GATEWAY_URL_INVALID: 400,
  IAM_GATEWAY_CREDENTIAL_REQUIRED: 401,
  IAM_LOGIN_REQUIRED: 401,
  IAM_MODEL_CONTEXT_CHANGED: 409,
  IAM_MODEL_SELECTION_INVALID: 409,
  IAM_MODEL_SELECTION_UNWRITTEN: 503,
  ENTERPRISE_MODELS_UNAVAILABLE: 503,
  ENTERPRISE_MODEL_CATALOG_INVALID: 502,
  ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED: 401,
  ENTERPRISE_GATEWAY_FORBIDDEN: 403,
  ENTERPRISE_GATEWAY_UNAVAILABLE: 502,
  IAM_GATEWAY_OWNER_MISSING: 400,
  IAM_GATEWAY_ATOMIC_UNVERIFIED: 503,
  IAM_GATEWAY_LEGACY_READ_ONLY: 409,
  IAM_GATEWAY_CHANGED: 409,
  IAM_GATEWAY_WRITE_UNKNOWN: 503,
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
  // The callback runs in a separate browser page and cannot inherit Host CSS.
  // These are the corresponding light/dark DSH theme values, checked against
  // the target Host; they must be rechecked when the DSH theme changes.
  const success = status === 200;
  const symbol = success
    ? '<path d="m5 12 4.5 4.5L19 7"/>'
    : '<path d="M12 7v6m0 4h.01"/>';
  const instruction = success ? '回到应用继续操作。' : '回到应用后重新尝试登录。';
  res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --dsw-alias-bg-base: #fff;
      --dsw-alias-bg-layer-1: #fff;
      --dsw-alias-label-primary: #0f1115;
      --dsw-alias-label-secondary: #61666b;
      --dsw-alias-border-l2: #0000001a;
      --dsw-alias-state-success-tertiary: #e6faed;
      --dsw-alias-state-error-primary: #ec1313;
      --dsw-radius-lg: 16px;
      --dsw-elevation-panel: 0 0 0 .5px #00000029, 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --dsw-alias-bg-base: #151517;
        --dsw-alias-bg-layer-1: #232324;
        --dsw-alias-label-primary: #f9fafb;
        --dsw-alias-label-secondary: #cfd3d6;
        --dsw-alias-border-l2: #ffffff1f;
        --dsw-alias-state-success-tertiary: #233c2c;
        --dsw-alias-state-error-primary: #f25a5a;
        --dsw-elevation-panel: 0 0 0 .5px #fff3, 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100dvh;
      display: grid; place-items: center; padding: 24px;
      background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
      font: 14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
    }
    main {
      width: min(100%, 480px); padding: 40px;
      border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1);
      box-shadow: var(--dsw-elevation-panel);
    }
    .status {
      display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%;
      background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-label-primary);
    }
    .status.error { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 1px var(--dsw-alias-border-l2); }
    svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    h1 { margin: 24px 0 8px; font-size: 24px; line-height: 32px; letter-spacing: -.02em; }
    p { margin: 0; color: var(--dsw-alias-label-secondary); }
    .next { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--dsw-alias-border-l2); }
    .next strong { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-primary); }
    @media (max-width: 480px) { body { padding: 16px; } main { padding: 28px 24px; } }
  </style>
</head>
<body>
  <main>
    <div class="status${success ? '' : ' error'}" aria-hidden="true"><svg viewBox="0 0 24 24">${symbol}</svg></div>
    <h1>${title}</h1>
    <p>${body}</p>
    <div class="next"><strong>返回 DeepSeek Harness</strong><p>${instruction}此页面可以关闭。</p></div>
  </main>
</body>
</html>`);
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
    // A client that disconnects before 'end' would otherwise leave the handler
    // awaiting this promise forever.
    req.on('close', () => fail(new IamError('IAM_REQUEST_INVALID', 'request was aborted')));
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
  try {
    if (!connection || typeof connection.requestRejection !== 'function') return 503;
    const result = connection.requestRejection({ headers: req?.headers ?? {} });
    if (result === undefined || result === 401 || result === 403) return result;
    // The Connection seam is synchronous. Only explicit undefined admits;
    // malformed values and async implementations are not an auth decision.
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    return 503;
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
export function createIamRoutes(service, { callbackPath = '/iam/callback', getOrigin, getConnection, getBridgeSecret } = {}) {
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
          // Resolve origin-form requests against the trusted live origin, not
          // the synthetic localhost base used only for routing above.
          const callbackUrl = new URL(req.url ?? '/', expected?.origin || 'http://localhost');
          if (expected && callbackUrl.origin !== expected.origin) {
            sendHtml(res, 403, '登录回调失败', '回调来源不受信任。');
            return;
          }
          await service.handleCallback(callbackUrl.href);
          sendHtml(res, 200, '登录完成', '企业账号已完成登录。');
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          sendHtml(res, status, '登录失败', '企业账号登录未完成。');
        }
        return;
      }

      if (url.pathname === '/api/forge-iam/bridge/token') {
        // Exempt from the Connection guard on purpose: a local CLI cannot hold
        // a browser credential. Loopback plus the store-backed capability are
        // the whole admission rule, and the route only ever reads.
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        let secret;
        try {
          secret = await getBridgeSecret?.();
        } catch {
          secret = undefined;
        }
        const rejected = bridgeRejection(
          { socketAddress: req.socket?.remoteAddress, authorization: req.headers?.authorization },
          secret,
        );
        if (rejected) {
          const code = rejected === 401
            ? 'IAM_BRIDGE_UNAUTHORIZED'
            : rejected === 403 ? 'IAM_BRIDGE_FORBIDDEN' : 'IAM_CREDENTIALS_UNAVAILABLE';
          return sendJson(res, rejected, { error: { code } });
        }
        try {
          const token = typeof service.getAccessToken === 'function'
            ? await service.getAccessToken()
            : await service.resolveToken();
          const session = await service.getSession();
          return sendJson(res, 200, { token, expiresAt: session?.accessExpiresAt ?? null });
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          return sendJson(res, status, errorBody(error));
        }
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

      if (url.pathname === '/api/forge-iam/session') {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        try {
          // Identity only: no store sync and no refresh on this path.
          return sendJson(res, 200, await service.getSession());
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          return sendJson(res, status, errorBody(error));
        }
      }

      if (url.pathname === '/api/forge-iam/token') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!hasMutationHeader(req)) return sendJson(res, 403, { error: { code: 'IAM_REQUEST_HEADER_REQUIRED' } });
        try {
          const token = typeof service.getAccessToken === 'function'
            ? await service.getAccessToken()
            : await service.resolveToken();
          const session = await service.getSession();
          return sendJson(res, 200, { token, expiresAt: session?.accessExpiresAt ?? null });
        } catch (error) {
          const status = ERROR_STATUS[error?.code] ?? 500;
          return sendJson(res, status, errorBody(error));
        }
      }

      if (url.pathname === '/api/forge-iam/events') {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        if (typeof service.watch !== 'function') {
          return sendJson(res, 501, { error: { code: 'IAM_NOT_IMPLEMENTED' } });
        }
        // Read-only state stream: the same non-sensitive view the polling route
        // returns, pushed when it changes. No token ever enters a frame.
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.on?.('close', abort);
        try {
          for await (const view of service.watch(controller.signal)) {
            if (controller.signal.aborted) break;
            res.write(`data: ${JSON.stringify(view)}\n\n`);
          }
        } catch {
          // A dropped connection ends the stream; the client reconnects.
        } finally {
          req.off?.('close', abort);
          controller.abort();
          if (typeof res.end === 'function') res.end();
        }
        return;
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

      if (url.pathname === '/api/forge-iam/models') {
        if (req.method === 'GET') {
          try { return sendJson(res, 200, { ...(await service.refreshGatewayModels()), view: service.getView() }); }
          catch (error) { return sendJson(res, ERROR_STATUS[error?.code] ?? 500, errorBody(error)); }
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          if (!hasMutationHeader(req)) return sendJson(res, 403, { error: { code: 'IAM_REQUEST_HEADER_REQUIRED' } });
          try {
            const body = await readJsonBody(req);
            const result = await service.updateModelOptions(body?.options ?? {});
            return sendJson(res, 200, { ...result, view: service.getView() });
          } catch (error) {
            return sendJson(res, ERROR_STATUS[error?.code] ?? 500, errorBody(error));
          }
        }
        return methodNotAllowed(res, 'GET, PUT, POST');
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
            const view = await service.saveGatewayCredential({ key, deviceLabel: body?.deviceLabel, ...(body?.baseURL !== undefined ? { baseURL: body.baseURL } : {}) });
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
          const result = await service.signOut();
          if (result?.view?.error === 'IAM_CREDENTIALS_CLEAR_FAILED' || result?.revocation === 'unknown') {
            return sendJson(res, 503, { ...result, logoutUrl: null, error: { code: 'IAM_CREDENTIALS_CLEAR_FAILED' } });
          }
          return sendJson(res, 200, result);
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
