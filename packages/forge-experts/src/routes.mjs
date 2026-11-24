/**
 * Same-origin HTTP routes and SSE invalidation stream for @heluo/forge-experts (P2 / P5 / P8).
 */
import { ExpertsError, serializeError } from './errors.mjs';

export const API_PREFIX = '/api/forge-experts';
export const REQUEST_HEADER = 'x-forge-experts-request';
export const EDIT_TOKEN_HEADER = 'x-forge-experts-edit-token';
const REQUEST_HEADER_VALUE = '1';
const MAX_BODY_BYTES = 8 * 1024;
// taskText allows up to 32,000 UTF-16 code units; allow up to 4 bytes/char in UTF-8 plus JSON envelope overhead.
const MAX_TASK_BODY_BYTES = 32_000 * 4 + 8 * 1024;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  sendJson(res, 405, {
    error: { code: 'EXPERT_METHOD_NOT_ALLOWED', message: 'Method not allowed', retryable: false },
  });
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new ExpertsError('EXPERT_REQUEST_TOO_LARGE', 'Request body exceeds limit'));
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
        reject(new ExpertsError('EXPERT_REQUEST_INVALID', 'Request body must be valid JSON'));
      }
    });
    req.on('error', () => fail(new ExpertsError('EXPERT_REQUEST_INVALID', 'Request stream error')));
    req.on('close', () => fail(new ExpertsError('EXPERT_REQUEST_INVALID', 'Request closed before completion')));
  });
}

function hasMutationHeader(req) {
  const headers = req?.headers ?? {};
  if (headers[REQUEST_HEADER] !== REQUEST_HEADER_VALUE) return false;
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) return false;
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

function decodePathSegment(rawSegment, label) {
  if (!rawSegment || rawSegment.includes('/') || /%2f/i.test(rawSegment)) {
    throw new ExpertsError('EXPERT_REQUEST_INVALID', `Invalid ${label}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    throw new ExpertsError('EXPERT_REQUEST_INVALID', `Invalid ${label} encoding`);
  }
  if (!decoded || decoded.includes('/')) {
    throw new ExpertsError('EXPERT_REQUEST_INVALID', `Invalid ${label}`);
  }
  return decoded;
}

function connectionRejection(req, getConnection) {
  let conn;
  try {
    conn = typeof getConnection === 'function' ? getConnection() : undefined;
  } catch {
    conn = undefined;
  }
  if (!conn || typeof conn.requestRejection !== 'function') return 503;
  try {
    const result = conn.requestRejection({ headers: req?.headers ?? {} });
    if (result === undefined || result === 401 || result === 403) return result;
    return 503;
  } catch {
    return 503;
  }
}

function requireRoutePort(req, res, { method, mutation = false, portFn, disabledCode, disabledMessage }) {
  if (req.method !== method) {
    methodNotAllowed(res, method);
    return null;
  }
  if (mutation) {
    if (!hasMutationHeader(req)) {
      throw new ExpertsError('EXPERT_REQUEST_HEADER_REQUIRED', 'Missing required same-origin request header');
    }
  }
  if (typeof portFn !== 'function') {
    throw new ExpertsError(disabledCode, disabledMessage);
  }
  return portFn;
}

export function createExpertsRoutes(ports) {
  const sseClients = new Set();

  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function closeAllStreams() {
    for (const res of sseClients) {
      try { res.end(); } catch { /* closing */ }
    }
    sseClients.clear();
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
        return false;
      }

      if (!ports.isManagementEnabled()) {
        throw new ExpertsError('EXPERT_MANAGEMENT_DISABLED', 'Expert agent management is disabled');
      }

      const rejected = connectionRejection(req, ports.getConnection);
      if (rejected) {
        const code = rejected === 503 ? 'EXPERT_CONNECTION_UNAVAILABLE' : 'EXPERT_UNAUTHENTICATED';
        throw new ExpertsError(code, 'Connection authentication rejected', { status: rejected });
      }

      if (url.pathname === `${API_PREFIX}/events`) {
        if (req.method !== 'GET') {
          methodNotAllowed(res, 'GET');
          return true;
        }
        const scope = await ports.resolveScope();
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: 'ready', scopeEpoch: scope.scopeEpoch, viewVersion: ports.getViewVersion() })}\n\n`);
        const cleanup = () => sseClients.delete(res);
        req.on?.('close', cleanup);
        res.on?.('close', cleanup);
        return true;
      }

      if (url.pathname === `${API_PREFIX}/catalog`) {
        if (req.method !== 'GET') {
          methodNotAllowed(res, 'GET');
          return true;
        }
        const view = url.searchParams.get('view') ?? 'directory';
        const query = url.searchParams.get('query') ?? '';
        const cursor = url.searchParams.get('cursor');
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ExpertsError('EXPERT_REQUEST_INVALID', 'limit must be an integer between 1 and 100');
        }
        const page = await ports.listCatalog({ view, query, cursor, limit });
        const enriched = [];
        for (const item of page.items) {
          if (item.access.callableInOrg) {
            const pref = await ports.getPreference({
              scope: page.scope,
              scopeEpoch: page.scopeEpoch,
              expertId: item.expertId,
              authContinuityDigest: item.access.authContinuityDigest,
            });
            enriched.push({ ...item, preference: pref });
          } else {
            enriched.push({ ...item, preference: null });
          }
        }
        sendJson(res, 200, { ...page, items: enriched });
        return true;
      }

      if (url.pathname === `${API_PREFIX}/mentions`) {
        if (req.method !== 'GET') {
          methodNotAllowed(res, 'GET');
          return true;
        }
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const query = url.searchParams.get('query') ?? '';
        const projection = await ports.listMentions({ sessionId, query });
        sendJson(res, 200, projection);
        return true;
      }

      if (url.pathname === `${API_PREFIX}/selections`) {
        const prepareSelection = requireRoutePort(req, res, {
          method: 'POST',
          mutation: true,
          portFn: ports.prepareSelection,
          disabledCode: 'EXPERT_DISPATCH_DISABLED',
          disabledMessage: 'Expert dispatch is disabled',
        });
        if (!prepareSelection) return true;
        const rawBody = await readJsonBody(req, MAX_TASK_BODY_BYTES);
        sendJson(res, 201, await prepareSelection(rawBody));
        return true;
      }

      if (url.pathname === `${API_PREFIX}/tasks`) {
        const dispatchTask = requireRoutePort(req, res, {
          method: 'POST',
          mutation: true,
          portFn: ports.dispatchTask,
          disabledCode: 'EXPERT_DISPATCH_DISABLED',
          disabledMessage: 'Expert dispatch is disabled',
        });
        if (!dispatchTask) return true;
        const rawBody = await readJsonBody(req, MAX_TASK_BODY_BYTES);
        const receipt = await dispatchTask(rawBody);
        sendJson(res, receipt?.idempotentReplay ? 200 : 201, receipt);
        return true;
      }

      if (url.pathname.startsWith(`${API_PREFIX}/tasks/by-request/`)) {
        const reconcileTaskByRequest = requireRoutePort(req, res, {
          method: 'GET',
          portFn: ports.reconcileTaskByRequest,
          disabledCode: 'EXPERT_TASK_NOT_FOUND',
          disabledMessage: 'Task reconciliation is unavailable',
        });
        if (!reconcileTaskByRequest) return true;
        const requestId = decodePathSegment(url.pathname.slice(`${API_PREFIX}/tasks/by-request/`.length), 'requestId');
        sendJson(res, 200, await reconcileTaskByRequest({ requestId }));
        return true;
      }

      if (url.pathname.startsWith(`${API_PREFIX}/tasks/`)) {
        const tail = url.pathname.slice(`${API_PREFIX}/tasks/`.length);
        const parts = tail.split('/');
        if (parts.length === 1) {
          const getTask = requireRoutePort(req, res, {
            method: 'GET',
            portFn: ports.getTask,
            disabledCode: 'EXPERT_TASK_NOT_FOUND',
            disabledMessage: 'Task lookup is unavailable',
          });
          if (!getTask) return true;
          sendJson(res, 200, await getTask({ taskId: decodePathSegment(parts[0], 'taskId') }));
          return true;
        }
        if (parts.length === 2 && parts[1] === 'result') {
          const getTaskResult = requireRoutePort(req, res, {
            method: 'GET',
            portFn: ports.getTaskResult,
            disabledCode: 'EXPERT_TASK_NOT_FOUND',
            disabledMessage: 'Task result lookup is unavailable',
          });
          if (!getTaskResult) return true;
          sendJson(res, 200, await getTaskResult({ taskId: decodePathSegment(parts[0], 'taskId') }));
          return true;
        }
        if (parts.length === 2 && parts[1] === 'followups') {
          const followupTask = requireRoutePort(req, res, {
            method: 'POST',
            mutation: true,
            portFn: ports.followupTask,
            disabledCode: 'EXPERT_DISPATCH_DISABLED',
            disabledMessage: 'Expert dispatch is disabled',
          });
          if (!followupTask) return true;
          const taskId = decodePathSegment(parts[0], 'taskId');
          const rawBody = await readJsonBody(req, MAX_TASK_BODY_BYTES);
          sendJson(res, 201, await followupTask({ taskId, ...rawBody }));
          return true;
        }
        if (parts.length === 2 && parts[1] === 'cancel') {
          const cancelTask = requireRoutePort(req, res, {
            method: 'POST',
            mutation: true,
            portFn: ports.cancelTask,
            disabledCode: 'EXPERT_TASK_NOT_FOUND',
            disabledMessage: 'Task cancellation is unavailable',
          });
          if (!cancelTask) return true;
          sendJson(res, 200, await cancelTask({ taskId: decodePathSegment(parts[0], 'taskId') }));
          return true;
        }
        throw new ExpertsError('EXPERT_NOT_FOUND', 'Unknown expert task route');
      }

      if (url.pathname.startsWith(`${API_PREFIX}/preferences/`)) {
        const expertId = decodePathSegment(url.pathname.slice(`${API_PREFIX}/preferences/`.length), 'expertId');
        const scope = await ports.resolveScope();
        const known = ports.getKnownExpert(scope.scopeEpoch, expertId);
        if (!known || !known.access.readable) {
          throw new ExpertsError('EXPERT_NOT_FOUND', 'Expert is not accessible in current scope');
        }
        if (!known.access.callableInOrg) {
          throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Expert is view-only in current organization');
        }

        if (req.method === 'GET') {
          const rawEditToken = req?.headers?.[EDIT_TOKEN_HEADER];
          const editToken = typeof rawEditToken === 'string' && rawEditToken.trim().length > 0
            ? rawEditToken.trim()
            : null;
          const result = editToken
            ? await ports.getEditSettlement({
              scope,
              scopeEpoch: scope.scopeEpoch,
              expertId,
              editToken,
              authContinuityDigest: known.access.authContinuityDigest,
            })
            : await ports.getPreference({
              scope,
              scopeEpoch: scope.scopeEpoch,
              expertId,
              authContinuityDigest: known.access.authContinuityDigest,
            });
          sendJson(res, result.pending ? 202 : 200, result);
          return true;
        }

        if (req.method === 'PUT') {
          if (!hasMutationHeader(req)) {
            throw new ExpertsError('EXPERT_REQUEST_HEADER_REQUIRED', 'Missing required same-origin request header');
          }
          const rawBody = await readJsonBody(req);
          const parsed = ports.validatePutBody(rawBody);
          if (!parsed.success) {
            throw new ExpertsError('EXPERT_REQUEST_INVALID', parsed.error);
          }
          const saved = await ports.setPreference({
            scope,
            scopeEpoch: scope.scopeEpoch,
            expertId,
            enabled: parsed.data.enabled,
            editToken: parsed.data.editToken,
          });
          sendJson(res, saved.status === 'pending' ? 202 : 200, saved);
          return true;
        }

        methodNotAllowed(res, 'GET, PUT');
        return true;
      }

      throw new ExpertsError('EXPERT_NOT_FOUND', 'Unknown expert route');
    } catch (error) {
      const { status, body } = serializeError(error);
      if (!res.headersSent) sendJson(res, status, body);
      return true;
    }
  }

  return Object.freeze({
    handle,
    broadcast,
    closeAllStreams,
    clientCount: () => sseClients.size,
  });
}
