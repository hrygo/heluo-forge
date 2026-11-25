/**
 * Delegra employee-scoped expert API connector (CORP-DSH-EXPERT-001).
 *
 * Consumes single-use opaque credential handles issued by @heluo/forge-iam
 * (RFC 8693 token exchange); never inspects, stores, or logs raw bearer tokens.
 * Enforces fail-closed scope envelope verification, 3xx redirect rejection,
 * and §8 error code normalization.
 */
import { createHash } from 'node:crypto';
import { ERROR_STATUS, ExpertsError } from './errors.mjs';

export const EMPLOYEE_API_PREFIX = '/api/v1/employee';
export const EMPLOYEE_EXCHANGE_BASE_SCOPE = 'employee:experts';
export const MAX_SCOPE_CHECK_EXPERTS = 100;
export const MAX_VERIFY_PAGES = 20;
// OAuth scope token allowlist (RFC 6749 NQCHAR): visible ASCII excluding space, quote, and backslash to prevent scope injection.
const SAFE_SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

const KNOWN_UPSTREAM_CODES = new Set(Object.keys(ERROR_STATUS));
const RETRYABLE_UPSTREAM_CODES = new Set([
  'EXPERT_RATE_LIMITED',
  'EXPERT_DIRECTORY_UNAVAILABLE',
  'EXPERT_ACCEPTANCE_UNKNOWN',
  'EXPERT_CURSOR_STALE',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeScopeEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { instanceId, orgId, issuer, subject } = raw;
  if (!isNonEmptyString(instanceId) || !isNonEmptyString(orgId) || !isNonEmptyString(issuer) || !isNonEmptyString(subject)) {
    return null;
  }
  return Object.freeze({
    instanceId: instanceId.trim(),
    orgId: orgId.trim(),
    issuer: issuer.trim(),
    subject: subject.trim(),
    verifiedAt: isNonEmptyString(raw.verifiedAt) ? raw.verifiedAt.trim() : null,
    validUntil: isNonEmptyString(raw.validUntil) ? raw.validUntil.trim() : null,
  });
}

function assertScopeEnvelope(rawScope, expected) {
  const normalized = normalizeScopeEnvelope(rawScope);
  if (!normalized) {
    throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Delegra response is missing a valid scope envelope');
  }
  if (expected) {
    if (isNonEmptyString(expected.instanceId) && normalized.instanceId !== expected.instanceId.trim()) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Delegra response instanceId does not match active scope');
    }
    if (isNonEmptyString(expected.orgId) && normalized.orgId !== expected.orgId.trim()) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Delegra response orgId does not match active scope');
    }
    if (isNonEmptyString(expected.issuer) && normalized.issuer !== expected.issuer.trim()) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Delegra response issuer does not match active scope');
    }
    if (isNonEmptyString(expected.subject) && normalized.subject !== expected.subject.trim()) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Delegra response subject does not match active scope');
    }
  }
  return normalized;
}

function mapIamExchangeError(error) {
  if (error instanceof ExpertsError) return error;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'IAM_NOT_SIGNED_IN' || code === 'IAM_UNAUTHENTICATED' || code === 'IAM_AUTH_REQUIRED') {
    return new ExpertsError('EXPERT_UNAUTHENTICATED', 'Employee IAM session is required for Delegra access');
  }
  if (code === 'IAM_TOKEN_REVOKED' || code === 'IAM_SESSION_REVOKED') {
    return new ExpertsError('EXPERT_AUTH_REVOKED', 'Employee IAM credential has been revoked');
  }
  if (code === 'IAM_ORG_FORBIDDEN' || code === 'IAM_FORBIDDEN') {
    return new ExpertsError('EXPERT_ORG_FORBIDDEN', 'Employee is not authorized for the target Delegra organization');
  }
  return new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Unable to obtain employee Delegra credential', {
    retryable: true,
  });
}

function mapUpstreamError(status, body, { transportUnknownOn5xx = false } = {}) {
  const rawCode = typeof body?.error?.code === 'string' ? body.error.code.trim() : '';
  const message = typeof body?.error?.message === 'string' && body.error.message.trim()
    ? body.error.message.trim()
    : `Delegra request failed with HTTP ${status}`;
  const requestTraceId = typeof body?.error?.requestTraceId === 'string' ? body.error.requestTraceId : undefined;
  const details = requestTraceId ? { requestTraceId } : undefined;

  if (KNOWN_UPSTREAM_CODES.has(rawCode)) {
    // §8.2: fold upstream 403 EXPERT_SCOPE_MISMATCH to 409 in Host vocabulary
    // and derive retryable authoritatively rather than trusting upstream flags.
    const mappedStatus = rawCode === 'EXPERT_SCOPE_MISMATCH' ? 409 : ERROR_STATUS[rawCode];
    const retryable = RETRYABLE_UPSTREAM_CODES.has(rawCode) || mappedStatus === 429 || mappedStatus >= 500;
    return new ExpertsError(rawCode, message, { status: mappedStatus, retryable, details });
  }

  if (status === 401) {
    return new ExpertsError('EXPERT_AUTH_INVALID', message, { status: 401, retryable: false, details });
  }
  if (status === 403) {
    return new ExpertsError('EXPERT_ORG_FORBIDDEN', message, { status: 403, retryable: false, details });
  }
  if (status === 404) {
    return new ExpertsError('EXPERT_NOT_FOUND', message, { status: 404, retryable: false, details });
  }
  if (status === 422) {
    return new ExpertsError('EXPERT_REQUEST_INVALID', message, { status: 422, retryable: false, details });
  }
  if (status === 429) {
    return new ExpertsError('EXPERT_RATE_LIMITED', message, { status: 429, retryable: true, details });
  }
  if (status === 503) {
    const code = transportUnknownOn5xx ? 'EXPERT_ACCEPTANCE_UNKNOWN' : 'EXPERT_DIRECTORY_UNAVAILABLE';
    return new ExpertsError(code, message, { status: 503, retryable: true, details });
  }
  if (transportUnknownOn5xx && status >= 500) {
    return new ExpertsError('EXPERT_ACCEPTANCE_UNKNOWN', 'Task acceptance outcome is unknown; reconcile via by-request', {
      status: 503,
      retryable: true,
      details,
    });
  }
  return new ExpertsError('EXPERT_INTERNAL_ERROR', 'Unexpected Delegra upstream error', {
    status: 500,
    retryable: false,
    details,
  });
}

function buildUrl(baseUrl, path, query) {
  const cleanBase = baseUrl.replace(/\/+$/u, '');
  const effectivePath = cleanBase.endsWith(EMPLOYEE_API_PREFIX) && path.startsWith(`${EMPLOYEE_API_PREFIX}/`)
    ? path.slice(EMPLOYEE_API_PREFIX.length)
    : path;
  const url = new URL(`${cleanBase}${effectivePath}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export function computeTaskPayloadDigest({ expertId, delegationScope, taskText, reuseRefs = [] }) {
  const canonical = JSON.stringify({
    expertId: String(expertId ?? '').trim(),
    delegationScope: String(delegationScope ?? '').trim(),
    taskText: String(taskText ?? ''),
    reuseRefs: Array.isArray(reuseRefs) ? [...reuseRefs] : [],
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function computeFollowupPayloadDigest({ taskId, taskText, reuseRefs = [] }) {
  const canonical = JSON.stringify({
    kind: 'followup',
    taskId: String(taskId ?? '').trim(),
    taskText: String(taskText ?? ''),
    reuseRefs: Array.isArray(reuseRefs) ? [...reuseRefs] : [],
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * @param {{
 *   exchangeCredential: (params: { target: string, orgId?: string }) => Promise<{ fetch: Function, resource?: string, dispose?: Function }>,
 *   target?: string,
 *   baseUrl?: string,
 *   orgId?: string,
 *   timeoutMs?: number,
 * }} options
 */
export function createDelegraClient(options) {
  if (!options || typeof options.exchangeCredential !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'Delegra client requires exchangeCredential port');
  }
  const target = isNonEmptyString(options.target) ? options.target.trim() : 'delegra';
  const configuredBaseUrl = isNonEmptyString(options.baseUrl) ? options.baseUrl.trim() : null;
  const defaultOrgId = isNonEmptyString(options.orgId) ? options.orgId.trim() : null;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000;

  async function requestJson({ method, path, query, body, orgId, expectedScope, transportUnknownOnFailure = false }) {
    const resolvedOrgId = orgId ?? expectedScope?.orgId ?? defaultOrgId ?? undefined;
    const cleanOrgId = isNonEmptyString(resolvedOrgId) ? resolvedOrgId.trim() : undefined;
    const exchangeScope = cleanOrgId && SAFE_SCOPE_TOKEN_RE.test(cleanOrgId)
      ? `${EMPLOYEE_EXCHANGE_BASE_SCOPE} org:${cleanOrgId}`
      : EMPLOYEE_EXCHANGE_BASE_SCOPE;
    let handle;
    try {
      handle = await options.exchangeCredential({
        target,
        orgId: cleanOrgId,
        scope: exchangeScope,
      });
    } catch (error) {
      throw mapIamExchangeError(error);
    }

    if (!handle || typeof handle.fetch !== 'function') {
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'IAM did not return a usable Delegra credential handle', {
        retryable: true,
      });
    }

    const baseUrl = configuredBaseUrl ?? (isNonEmptyString(handle.resource) ? handle.resource.trim() : null);
    if (!baseUrl) {
      try { await handle.dispose?.(); } catch { /* ignore cleanup error */ }
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra API base URL is not configured');
    }

    const url = buildUrl(baseUrl, path, query);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let status = 0;
    let parsed = null;
    try {
      const headers = { Accept: 'application/json' };
      const init = {
        method,
        headers,
        redirect: 'manual',
        ...(controller ? { signal: controller.signal } : {}),
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      let response;
      try {
        response = await handle.fetch(url, init);
      } catch (error) {
        if (error instanceof ExpertsError) throw error;
        const timedOut = Boolean(controller?.signal?.aborted) || error?.name === 'AbortError';
        if (transportUnknownOnFailure) {
          throw new ExpertsError(
            'EXPERT_ACCEPTANCE_UNKNOWN',
            timedOut
              ? `Task submission timed out after ${timeoutMs}ms; reconcile via by-request`
              : 'Task submission outcome is unknown after transport failure',
            { status: 503, retryable: true },
          );
        }
        throw new ExpertsError(
          'EXPERT_DIRECTORY_UNAVAILABLE',
          timedOut ? `Delegra request timed out after ${timeoutMs}ms` : 'Delegra upstream request failed',
          { retryable: true },
        );
      }

      status = Number(response?.status ?? 0);
      // Fail closed on any 3xx redirect (non-retryable security boundary) so
      // bearer credentials are never forwarded across origins.
      if (status >= 300 && status < 400) {
        const code = transportUnknownOnFailure ? 'EXPERT_ACCEPTANCE_UNKNOWN' : 'EXPERT_DIRECTORY_UNAVAILABLE';
        throw new ExpertsError(code, 'Delegra upstream returned an unexpected redirect', {
          status: 503,
          retryable: false,
        });
      }

      // Read the response body BEFORE disposing the handle in finally so
      // handle implementations that tie stream/connection lifetime to dispose()
      // do not truncate or abort body reads.
      try {
        const text = typeof response?.text === 'function'
          ? await response.text()
          : (typeof response?.json === 'function' ? JSON.stringify(await response.json()) : '');
        if (text && text.trim().length > 0) {
          parsed = JSON.parse(text);
        }
      } catch {
        if (transportUnknownOnFailure) {
          throw new ExpertsError('EXPERT_ACCEPTANCE_UNKNOWN', 'Delegra task acceptance response could not be parsed', {
            status: 503,
            retryable: true,
          });
        }
        throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'Delegra returned a malformed JSON response');
      }
    } finally {
      if (timer) clearTimeout(timer);
      try { await handle.dispose?.(); } catch { /* ensure single-use handle cleanup */ }
    }

    if (status < 200 || status >= 300) {
      throw mapUpstreamError(status, parsed, { transportUnknownOn5xx: transportUnknownOnFailure });
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'Delegra returned an empty response payload');
    }

    const verifiedScope = assertScopeEnvelope(parsed.scope, expectedScope);
    return { status, data: parsed, scope: verifiedScope };
  }

  async function resolveDelegraScope(session) {
    if (!session || !isNonEmptyString(session.issuer) || !isNonEmptyString(session.subject)) {
      throw new ExpertsError('EXPERT_UNAUTHENTICATED', 'Valid IAM session is required to resolve Delegra scope');
    }
    const orgId = isNonEmptyString(session.orgId) ? session.orgId.trim() : defaultOrgId;
    if (!orgId) {
      throw new ExpertsError('EXPERT_ORG_FORBIDDEN', 'Target Delegra orgId is not configured');
    }
    const { scope } = await requestJson({
      method: 'GET',
      path: `${EMPLOYEE_API_PREFIX}/experts`,
      query: { orgId, view: 'directory', limit: 1 },
      orgId,
      expectedScope: {
        orgId,
        issuer: session.issuer,
        subject: session.subject,
      },
    });
    return scope;
  }

  async function fetchDelegraCatalog({ scope, view = 'directory', query, cursor, limit = 50 }) {
    if (!scope || !isNonEmptyString(scope.orgId)) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Active scope with orgId is required for catalog lookup');
    }
    const { data, scope: verifiedScope } = await requestJson({
      method: 'GET',
      path: `${EMPLOYEE_API_PREFIX}/experts`,
      query: {
        orgId: scope.orgId,
        view,
        query: isNonEmptyString(query) ? query.trim() : undefined,
        cursor: isNonEmptyString(cursor) ? cursor.trim() : undefined,
        limit,
      },
      orgId: scope.orgId,
      expectedScope: scope,
    });
    return Object.freeze({
      scope: verifiedScope,
      catalogVersion: typeof data.catalogVersion === 'string' ? data.catalogVersion : null,
      completeness: typeof data.completeness === 'string' ? data.completeness : 'unknown',
      coveredScopes: Array.isArray(data.coveredScopes) ? Object.freeze([...data.coveredScopes]) : Object.freeze([]),
      items: Array.isArray(data.items) ? Object.freeze([...data.items]) : Object.freeze([]),
      page: Object.freeze({
        nextCursor: typeof data.page?.nextCursor === 'string' ? data.page.nextCursor : null,
        hasMore: data.page?.hasMore === true,
      }),
    });
  }

  async function scanCallablePages(scope, expertId, query) {
    let cursor = undefined;
    for (let pageIndex = 0; pageIndex < MAX_VERIFY_PAGES; pageIndex += 1) {
      const page = await fetchDelegraCatalog({
        scope,
        view: 'callable',
        query,
        cursor,
        limit: 100,
      });
      const match = page.items.find((item) => item?.expertId === expertId);
      if (match) {
        return {
          found: true,
          result: Object.freeze({
            callableInOrg: match.access?.callableInOrg === true,
            authContinuityDigest: isNonEmptyString(match.access?.authContinuityDigest)
              ? match.access.authContinuityDigest.trim()
              : null,
          }),
        };
      }
      if (!page.page.hasMore || !page.page.nextCursor) {
        return { found: false, exhausted: true };
      }
      cursor = page.page.nextCursor;
    }
    // Fail closed when pagination cap is reached with unread pages remaining
    // instead of misclassifying an unread expert as not callable.
    throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Callable expert verification exceeded pagination limit', {
      retryable: true,
    });
  }

  async function verifyOrgCallable(scope, expertId) {
    if (!scope || !isNonEmptyString(scope.orgId) || !isNonEmptyString(expertId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'scope and expertId are required for authorization verification');
    }
    const cleanId = expertId.trim();
    const targeted = await scanCallablePages(scope, cleanId, cleanId);
    if (targeted.found) return targeted.result;
    // Some directory servers only match displayName/responsibility in `query`,
    // so fall back once to an unfiltered callable scan before concluding false.
    const fullScan = await scanCallablePages(scope, cleanId, undefined);
    if (fullScan.found) return fullScan.result;
    return Object.freeze({ callableInOrg: false, authContinuityDigest: null });
  }

  async function checkDelegraSessionScope({ scope, delegationScope, expertIds }) {
    if (!scope || !isNonEmptyString(scope.orgId)) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Active scope with orgId is required for scope-check');
    }
    if (!isNonEmptyString(delegationScope)) {
      throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'delegationScope is required for scope-check');
    }
    if (!Array.isArray(expertIds)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'expertIds must be an array');
    }
    if (expertIds.length > MAX_SCOPE_CHECK_EXPERTS) {
      throw new ExpertsError('EXPERT_REQUEST_TOO_LARGE', `scope-check accepts at most ${MAX_SCOPE_CHECK_EXPERTS} expertIds`);
    }
    const { data, scope: verifiedScope } = await requestJson({
      method: 'POST',
      path: `${EMPLOYEE_API_PREFIX}/experts/scope-check`,
      body: {
        orgId: scope.orgId,
        delegationScope: delegationScope.trim(),
        expertIds,
      },
      orgId: scope.orgId,
      expectedScope: scope,
    });
    if (data.scopeVerified !== true) {
      throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Delegra did not verify session delegation scope');
    }
    return Object.freeze({
      scope: verifiedScope,
      scopeVerified: true,
      validUntil: verifiedScope.validUntil,
      results: Array.isArray(data.results) ? Object.freeze([...data.results]) : Object.freeze([]),
    });
  }

  async function createTask({ scope, expertId, delegationScope, requestId, originSessionRef, taskText, reuseRefs, payloadDigest }) {
    if (!scope || !isNonEmptyString(scope.orgId)) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Active scope is required to create an expert task');
    }
    if (!isNonEmptyString(expertId) || !isNonEmptyString(delegationScope) || !isNonEmptyString(requestId) || !isNonEmptyString(taskText)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'expertId, delegationScope, requestId, and taskText are required');
    }
    const digest = isNonEmptyString(payloadDigest)
      ? payloadDigest.trim()
      : computeTaskPayloadDigest({ expertId, delegationScope, taskText, reuseRefs });

    const { status, data, scope: verifiedScope } = await requestJson({
      method: 'POST',
      path: `${EMPLOYEE_API_PREFIX}/expert-tasks`,
      body: {
        orgId: scope.orgId,
        expertId: expertId.trim(),
        delegationScope: delegationScope.trim(),
        requestId: requestId.trim(),
        originSessionRef: isNonEmptyString(originSessionRef) ? originSessionRef.trim() : undefined,
        taskText,
        payloadDigest: digest,
        ...(Array.isArray(reuseRefs) && reuseRefs.length > 0 ? { reuseRefs } : {}),
      },
      orgId: scope.orgId,
      expectedScope: scope,
      transportUnknownOnFailure: true,
    });

    if (!isNonEmptyString(data.taskId) || !isNonEmptyString(data.requestId) || !isNonEmptyString(data.acceptedAt) || !isNonEmptyString(data.status)) {
      throw new ExpertsError('EXPERT_ACCEPTANCE_UNKNOWN', 'Task acceptance receipt is incomplete; reconcile via by-request', {
        status: 503,
        retryable: true,
      });
    }

    return Object.freeze({
      scope: verifiedScope,
      taskId: data.taskId.trim(),
      requestId: data.requestId.trim(),
      status: data.status.trim(),
      acceptedAt: data.acceptedAt.trim(),
      runGeneration: Number.isInteger(data.runGeneration) ? data.runGeneration : 0,
      resultVersion: Number.isInteger(data.resultVersion) ? data.resultVersion : 0,
      idempotentReplay: status === 200 || data.idempotentReplay === true,
    });
  }

  async function getTaskByRequest({ scope, requestId }) {
    if (!scope || !isNonEmptyString(scope.orgId) || !isNonEmptyString(requestId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'scope and requestId are required');
    }
    const { data, scope: verifiedScope } = await requestJson({
      method: 'GET',
      path: `${EMPLOYEE_API_PREFIX}/expert-tasks/by-request/${encodeURIComponent(requestId.trim())}`,
      query: { orgId: scope.orgId },
      orgId: scope.orgId,
      expectedScope: scope,
    });
    return Object.freeze({ ...data, scope: verifiedScope });
  }

  async function getTask({ scope, taskId }) {
    if (!scope || !isNonEmptyString(scope.orgId) || !isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'scope and taskId are required');
    }
    const { data, scope: verifiedScope } = await requestJson({
      method: 'GET',
      path: `${EMPLOYEE_API_PREFIX}/expert-tasks/${encodeURIComponent(taskId.trim())}`,
      query: { orgId: scope.orgId },
      orgId: scope.orgId,
      expectedScope: scope,
    });
    return Object.freeze({ ...data, scope: verifiedScope });
  }

  async function getTaskResult({ scope, taskId }) {
    if (!scope || !isNonEmptyString(scope.orgId) || !isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'scope and taskId are required');
    }
    const { data, scope: verifiedScope } = await requestJson({
      method: 'GET',
      path: `${EMPLOYEE_API_PREFIX}/expert-tasks/${encodeURIComponent(taskId.trim())}/result`,
      query: { orgId: scope.orgId },
      orgId: scope.orgId,
      expectedScope: scope,
    });
    return Object.freeze({ ...data, scope: verifiedScope });
  }

  async function createFollowup({ scope, taskId, requestId, taskText, reuseRefs, payloadDigest }) {
    if (!scope || !isNonEmptyString(scope.orgId) || !isNonEmptyString(taskId) || !isNonEmptyString(requestId) || !isNonEmptyString(taskText)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'scope, taskId, requestId, and taskText are required');
    }
    const digest = isNonEmptyString(payloadDigest)
      ? payloadDigest.trim()
      : computeFollowupPayloadDigest({ taskId, taskText, reuseRefs });

    const { data, scope: verifiedScope } = await requestJson({
      method: 'POST',
      path: `${EMPLOYEE_API_PREFIX}/expert-tasks/${encodeURIComponent(taskId.trim())}/followups`,
      body: {
        orgId: scope.orgId,
        requestId: requestId.trim(),
        taskText,
        payloadDigest: digest,
        ...(Array.isArray(reuseRefs) && reuseRefs.length > 0 ? { reuseRefs } : {}),
      },
      orgId: scope.orgId,
      expectedScope: scope,
      transportUnknownOnFailure: true,
    });
    return Object.freeze({ ...data, scope: verifiedScope });
  }

  async function cancelTask({ scope, taskId }) {
    if (!scope || !isNonEmptyString(scope.orgId) || !isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'scope and taskId are required');
    }
    const { data, scope: verifiedScope } = await requestJson({
      method: 'POST',
      path: `${EMPLOYEE_API_PREFIX}/expert-tasks/${encodeURIComponent(taskId.trim())}/cancel`,
      body: { orgId: scope.orgId },
      orgId: scope.orgId,
      expectedScope: scope,
    });
    return Object.freeze({ ...data, scope: verifiedScope });
  }

  return Object.freeze({
    resolveDelegraScope,
    fetchDelegraCatalog,
    verifyOrgCallable,
    checkDelegraSessionScope,
    createTask,
    getTaskByRequest,
    getTask,
    getTaskResult,
    createFollowup,
    cancelTask,
  });
}
