/**
 * Host-internal RFC 8693 OAuth 2.0 Token Exchange service for @heluo/forge-iam.
 *
 * Exchanges the active IAM access token for a short-lived, audience-bound
 * downstream employee credential and returns an opaque in-memory handle.
 * Callers (business plugins / browsers) never receive raw IAM or exchanged tokens.
 */
import { randomBytes } from 'node:crypto';
import { IamError } from './errors.mjs';

export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const MAX_EXCHANGED_TTL_SECONDS = 300;
export const MAX_ACTIVE_HANDLES = 256;
const MIN_REMAINING_MS = 1000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeResourceRoot(resource) {
  const parsed = new URL(resource);
  const cleanPath = parsed.pathname.replace(/\/+$/u, '');
  return {
    origin: parsed.origin,
    basePath: cleanPath,
    href: `${parsed.origin}${cleanPath}`,
  };
}

function resolveScopedUrl(resourceRoot, pathOrUrl) {
  if (!isNonEmptyString(pathOrUrl)) {
    throw new IamError('IAM_TOKEN_EXCHANGE_INVALID', 'Request path or URL is required');
  }
  const input = pathOrUrl.trim();
  let resolved;
  try {
    if (input.startsWith('/')) {
      resolved = new URL(`${resourceRoot.href}${input}`);
    } else if (/^https?:\/\//iu.test(input)) {
      resolved = new URL(input);
    } else {
      resolved = new URL(`${resourceRoot.href}/${input}`);
    }
  } catch {
    throw new IamError('IAM_TOKEN_EXCHANGE_INVALID', 'Invalid target request URL');
  }

  if (resolved.origin !== resourceRoot.origin) {
    throw new IamError('IAM_TOKEN_EXCHANGE_INVALID', 'Request origin does not match exchanged credential resource');
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(resolved.pathname);
  } catch {
    throw new IamError('IAM_TOKEN_EXCHANGE_INVALID', 'Request path contains invalid percent-encoding');
  }
  // Re-normalize after decoding so percent-encoded dot segments (%2e%2e) cannot
  // bypass the resource root prefix check when decoded by an upstream server.
  const normalizedPath = new URL(decodedPath.replace(/\\+/gu, '/'), resourceRoot.origin).pathname;

  if (resourceRoot.basePath) {
    const rawOk = resolved.pathname === resourceRoot.basePath
      || resolved.pathname.startsWith(`${resourceRoot.basePath}/`);
    const decodedOk = normalizedPath === resourceRoot.basePath
      || normalizedPath.startsWith(`${resourceRoot.basePath}/`);
    if (!rawOk || !decodedOk) {
      throw new IamError('IAM_TOKEN_EXCHANGE_INVALID', 'Request path escapes exchanged credential resource root');
    }
  }
  return resolved.toString();
}

function sameSession(before, after) {
  return Boolean(before) && Boolean(after)
    && before.issuer === after.issuer
    && before.subject === after.subject
    && before.epoch === after.epoch;
}

/**
 * @param {{
 *   targets?: Record<string, { endpoint: string, audience: string, resource: string, maxTtlSeconds?: number }> | null,
 *   getSessionRef: () => { issuer: string, subject: string, epoch: string, accessExpiresAt: number } | null,
 *   resolveSubjectToken: () => Promise<string | { accessToken?: string }>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   httpTimeoutMs?: number,
 * }} ports
 */
export function createTokenExchangeService(ports) {
  if (!ports || typeof ports.getSessionRef !== 'function' || typeof ports.resolveSubjectToken !== 'function') {
    throw new IamError('IAM_INTERNAL', 'token exchange service requires session and subject token ports');
  }

  const targets = ports.targets && typeof ports.targets === 'object' ? ports.targets : Object.freeze({});
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;
  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  const httpTimeoutMs = Number.isInteger(ports.httpTimeoutMs) && ports.httpTimeoutMs > 0
    ? ports.httpTimeoutMs
    : 10_000;

  // Private in-memory vault: raw exchanged tokens never leave this closure.
  const activeHandles = new Map();

  function revokeAll() {
    for (const entry of activeHandles.values()) {
      entry.disposed = true;
      entry.token = null;
    }
    activeHandles.clear();
  }

  function pruneExpired() {
    const at = now();
    for (const [id, entry] of activeHandles.entries()) {
      if (entry.disposed || at >= entry.expiresAt) {
        entry.disposed = true;
        entry.token = null;
        activeHandles.delete(id);
      }
    }
  }

  function listTargets() {
    return Object.freeze(
      Object.entries(targets).map(([id, spec]) => Object.freeze({
        id,
        audience: spec.audience,
        resource: spec.resource,
        maxTtlSeconds: Math.min(spec.maxTtlSeconds ?? MAX_EXCHANGED_TTL_SECONDS, MAX_EXCHANGED_TTL_SECONDS),
      })),
    );
  }

  function readActiveSession() {
    const ref = ports.getSessionRef();
    if (!ref || typeof ref !== 'object') return null;
    if (!isNonEmptyString(ref.issuer) || !isNonEmptyString(ref.subject) || !isNonEmptyString(ref.epoch)) return null;
    if (!Number.isFinite(ref.accessExpiresAt)) return null;
    return ref;
  }

  function buildHandle({ handleId, target, spec, session, scope, expiresAt, resourceRoot }) {
    const isEntryUsable = () => {
      const entry = activeHandles.get(handleId);
      if (!entry || entry.disposed || !entry.token) return false;
      if (entry.singleUse && entry.used) return false;
      if (now() >= entry.expiresAt) {
        entry.disposed = true;
        entry.token = null;
        activeHandles.delete(handleId);
        return false;
      }
      const current = readActiveSession();
      if (!sameSession(session, current)) {
        entry.disposed = true;
        entry.token = null;
        activeHandles.delete(handleId);
        return false;
      }
      return true;
    };

    const dispose = () => {
      const entry = activeHandles.get(handleId);
      if (entry) {
        entry.disposed = true;
        entry.token = null;
        activeHandles.delete(handleId);
      }
    };

    const scopedFetch = async (pathOrUrl, init = {}) => {
      if (!isEntryUsable()) {
        throw new IamError('IAM_TOKEN_EXCHANGE_REJECTED', 'Exchanged credential handle is expired, used, or revoked');
      }
      const entry = activeHandles.get(handleId);
      const targetUrl = resolveScopedUrl(resourceRoot, pathOrUrl);
      const token = entry.token;
      // Always consume before dispatch so a single-use bearer credential cannot
      // be replayed concurrently; callers re-exchange on transient errors.
      entry.used = true;
      entry.disposed = true;
      entry.token = null;
      activeHandles.delete(handleId);

      const headers = new Headers(init?.headers ?? undefined);
      headers.delete('cookie');
      headers.delete('proxy-authorization');
      headers.set('authorization', `Bearer ${token}`);

      return fetchImpl(targetUrl, {
        ...init,
        headers,
        redirect: 'manual',
      });
    };

    return Object.freeze({
      handleId,
      target,
      audience: spec.audience,
      resource: spec.resource,
      issuer: session.issuer,
      subject: session.subject,
      scope,
      expiresAt,
      isValid: isEntryUsable,
      fetch: scopedFetch,
      dispose,
    });
  }

  async function exchange({ target, scope = undefined } = {}) {
    pruneExpired();
    if (activeHandles.size >= MAX_ACTIVE_HANDLES) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Too many active exchanged credential handles; dispose unused handles first');
    }
    if (!isNonEmptyString(target)) {
      throw new IamError('IAM_TOKEN_EXCHANGE_INVALID', 'target is required for token exchange');
    }
    const targetId = target.trim();
    const spec = Object.hasOwn(targets, targetId) ? targets[targetId] : null;
    if (!spec) {
      throw new IamError('IAM_TOKEN_EXCHANGE_UNCONFIGURED', `Token exchange target "${targetId}" is not configured`);
    }
    if (scope !== undefined && !isNonEmptyString(scope)) {
      throw new IamError('IAM_TOKEN_EXCHANGE_INVALID', 'scope must be a non-empty string when provided');
    }
    if (typeof fetchImpl !== 'function') {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'HTTP transport is unavailable for token exchange');
    }

    const beforeSession = readActiveSession();
    if (!beforeSession) {
      throw new IamError('IAM_NOT_SIGNED_IN', 'Sign in to enterprise IAM before exchanging audience credentials');
    }
    if (beforeSession.accessExpiresAt - now() < MIN_REMAINING_MS) {
      throw new IamError('IAM_REAUTH_REQUIRED', 'Active IAM access token has expired');
    }

    let resolvedSubject;
    try {
      resolvedSubject = await ports.resolveSubjectToken();
    } catch (error) {
      if (error instanceof IamError) throw error;
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Unable to resolve active IAM access token');
    }

    const subjectToken = typeof resolvedSubject === 'string'
      ? resolvedSubject
      : resolvedSubject?.accessToken;
    if (!isNonEmptyString(subjectToken)) {
      throw new IamError('IAM_NOT_SIGNED_IN', 'No active IAM access token is available for token exchange');
    }

    const afterResolveSession = readActiveSession();
    if (!sameSession(beforeSession, afterResolveSession)) {
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed while resolving subject token');
    }

    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      audience: spec.audience,
      resource: spec.resource,
    });
    if (scope !== undefined) {
      body.set('scope', scope.trim());
    }

    let response;
    try {
      response = await fetchImpl(spec.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'cache-control': 'no-store',
        },
        body: body.toString(),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(httpTimeoutMs) : undefined,
      });
    } catch {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange endpoint is unreachable');
    }

    const afterFetchSession = readActiveSession();
    if (!sameSession(beforeSession, afterFetchSession)) {
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session ended while token exchange was in flight');
    }

    if (response.status === 401 || response.status === 403) {
      throw new IamError('IAM_TOKEN_EXCHANGE_REJECTED', 'Token exchange was rejected by upstream authorization server');
    }
    if (!response.ok) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange failed with an unexpected upstream status');
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response was not valid JSON');
    }

    // Re-verify session identity after reading the asynchronous response body
    // so a concurrent sign-out or session replacement cannot adopt the token.
    const afterBodySession = readActiveSession();
    if (!sameSession(beforeSession, afterBodySession)) {
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed while reading token exchange response');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response payload is invalid');
    }
    if (!isNonEmptyString(payload.access_token)) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response omitted access_token');
    }
    if (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer') {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response must return a Bearer token');
    }
    // RFC 8693 §2.2.1 & contract §2.3: issued_token_type must be an access token.
    if (payload.issued_token_type !== ACCESS_TOKEN_TYPE) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response must declare issued_token_type as access_token');
    }
    const rawExpiresIn = Number(payload.expires_in);
    if (!Number.isFinite(rawExpiresIn) || rawExpiresIn <= 0) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response omitted a valid expires_in');
    }

    // §2.3 hard bound: upstream expires_in itself must satisfy
    // expires_in <= min(300, target.maxTtlSeconds, remaining IAM token TTL).
    // Reject non-compliant tokens instead of locally shortening handle lifetime.
    const at = now();
    const iamRemainingSec = Math.floor((afterBodySession.accessExpiresAt - at) / 1000);
    if (iamRemainingSec <= 0) {
      throw new IamError('IAM_REAUTH_REQUIRED', 'Active IAM access token expired during token exchange');
    }
    const targetCapSec = Math.min(spec.maxTtlSeconds ?? MAX_EXCHANGED_TTL_SECONDS, MAX_EXCHANGED_TTL_SECONDS);
    if (rawExpiresIn > targetCapSec) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response expires_in exceeds configured maximum TTL');
    }
    if (rawExpiresIn > iamRemainingSec) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response expires_in exceeds remaining IAM token lifetime');
    }
    const effectiveTtlSec = Math.floor(rawExpiresIn);
    if (effectiveTtlSec <= 0) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Token exchange response expires_in must be at least 1 second');
    }

    pruneExpired();
    if (activeHandles.size >= MAX_ACTIVE_HANDLES) {
      throw new IamError('IAM_TOKEN_EXCHANGE_FAILED', 'Too many active exchanged credential handles; dispose unused handles first');
    }
    const expiresAt = at + effectiveTtlSec * 1000;
    const handleId = randomBytes(16).toString('hex');
    const resourceRoot = normalizeResourceRoot(spec.resource);
    activeHandles.set(handleId, {
      token: payload.access_token.trim(),
      expiresAt,
      resource: spec.resource,
      singleUse: true,
      used: false,
      disposed: false,
    });

    const grantedScope = isNonEmptyString(payload.scope) ? payload.scope.trim() : (scope?.trim() ?? null);
    return buildHandle({
      handleId,
      target: targetId,
      spec,
      session: afterBodySession,
      scope: grantedScope,
      expiresAt,
      resourceRoot,
    });
  }

  return Object.freeze({
    exchange,
    listTargets,
    revokeAll,
    activeHandleCount: () => activeHandles.size,
  });
}
