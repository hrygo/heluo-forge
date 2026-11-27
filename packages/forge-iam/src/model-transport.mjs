import { AsyncLocalStorage } from 'node:async_hooks';
import { IamError } from './errors.mjs';
import { gatewayResponseAuthFailure } from './gateway-failure.mjs';

const scope = new AsyncLocalStorage();
const transportFaults = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const maxRetryAfterMs = 86_400_000;

export function trackModelAttempt(dispatch, attempt) {
  const iterator = scope.run(attempt, () => dispatch()[Symbol.asyncIterator]());
  // The lazy SDK runs at each pull, after the adapter's stream was created.
  return {
    [Symbol.asyncIterator]() { return this; },
    next: () => scope.run(attempt, () => iterator.next()),
    return: () => scope.run(attempt, () => iterator.return?.() ?? { done: true }),
  };
}

export function modelPreconnectFault(attempt) {
  if (attempt?.calls === 1 && attempt.status === undefined && attempt.failedBeforeSend) return attempt.fault;
  return undefined;
}

function isConnectFailure(error) {
  switch (error?.code) {
    case 'EAI_AGAIN': return error.syscall === 'getaddrinfo';
    case 'ECONNREFUSED':
    case 'ETIMEDOUT': return error.syscall === 'connect';
    case 'UND_ERR_CONNECT_TIMEOUT': return true;
    default: return false;
  }
}

export function retryAfterMillis(value) {
  if (!value) return undefined;
  const millis = /^\d{1,6}$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isInteger(millis) && millis >= 0 && millis <= maxRetryAfterMs ? millis : undefined;
}

/**
 * Unbounded form used by callers that decide their own ceiling: a valid but very
 * long wait must stay distinguishable from "no hint at all", otherwise it would
 * silently fall back to a short local backoff.
 */
export function retryAfterHint(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const millis = /^\d{1,12}$/u.test(text) ? Number(text) * 1000 : Date.parse(text) - Date.now();
  if (!Number.isFinite(millis) || millis < 0) return undefined;
  return Math.round(millis);
}

/**
 * @param {Record<string, unknown>} options
 * @param {string} baseURL
 * @param {() => Promise<string>} resolveIamToken
 * @param {{ tokenHeader?: string, consumerHeader?: string, consumerType?: string }} [identity]
 *   Header names stay configurable so a gateway change is a config change rather
 *   than a code change; the defaults are what the deployed gateway accepts.
 */
export function modelFetchOptions(options, baseURL, resolveIamToken, identity = {}) {
  const tokenHeader = identity.tokenHeader ?? 'X-IAM-Token';
  const consumerHeader = identity.consumerHeader ?? 'X-Consumer-Type';
  const consumerType = identity.consumerType ?? 'personal';
  const attempt = scope.getStore();
  const directFetch = options?.fetch === undefined;
  const fetcher = options?.fetch ?? globalThis.fetch;
  const endpoint = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  return {
    ...options,
    maxRetries: 0,
    async fetch(input, init) {
      const requestInput = input instanceof Request;
      const url = requestInput ? input.url : String(input);
      const method = init?.method ?? (requestInput ? input.method : null);
      const signal = init?.signal ?? (requestInput ? input.signal : undefined);
      const send = async (token) => {
        attempt?.check();
        signal?.throwIfAborted();
        if (typeof token !== 'string' || !token.trim()) {
          throw new IamError('IAM_LOGIN_REQUIRED', 'Model IAM access token is unavailable');
        }
        const outgoing = new Headers(init?.headers ?? (requestInput ? input.headers : undefined));
        outgoing.set(tokenHeader, token);
        outgoing.set(consumerHeader, consumerType);
        // Following a redirect could disclose the credentials or send a second
        // request after the gateway accepted the first one.
        const request = { ...init, headers: outgoing, redirect: 'manual' };
        if (!attempt) return fetcher(input, request);
        attempt.calls++;
        attempt.sent?.();
        attempt.failedBeforeSend = false;
        try {
          const response = await fetcher(input, request);
          attempt.status = response.status;
          attempt.retryAfterMs = retryAfterMillis(response.headers.get('retry-after'));
          if (response.ok) attempt.accept?.();
          if (response.status === 401) {
            attempt.authFailure = await gatewayResponseAuthFailure(response);
            if (attempt.authFailure === 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED') attempt.revoke?.();
          }
          return response;
        } catch (cause) {
          const socket = cause?.cause ?? cause;
          const connectErrors = socket instanceof AggregateError ? socket.errors : [socket];
          // A Request can carry a dispatcher even when init does not supply one.
          attempt.failedBeforeSend = directFetch && !requestInput
            && request.dispatcher === undefined && !signal?.aborted
            && Array.isArray(connectErrors) && connectErrors.length > 0 && connectErrors.every(isConnectFailure);
          const fault = (attempt.failedBeforeSend ? connectErrors[0] : socket)?.code;
          attempt.fault = transportFaults.has(fault) ? fault : undefined;
          throw cause;
        }
      };
      try {
        signal?.throwIfAborted();
        if (url !== endpoint || method !== 'POST') throw new IamError('IAM_MODEL_CONTEXT_CHANGED', 'Model transport binding changed');
        if (attempt?.withDispatchAccessToken) return await attempt.withDispatchAccessToken(send, signal);
        attempt?.check();
        return await send(await resolveIamToken?.());
      } catch (cause) {
        // SDKs may wrap this failure. Preserve a verified local refusal before
        // the first network call, without reclassifying a transport error.
        if (attempt?.calls === 0) attempt.refuse?.(cause);
        throw cause;
      }
    },
  };
}

export function modelTransportDiagnostic(attempt, output, retrying) {
  if (!attempt?.calls) return undefined;
  return {
    phase: attempt.status === undefined ? (modelPreconnectFault(attempt) ? 'before-send' : 'unknown') : 'response',
    status: attempt.status, retryAfterMs: attempt.retryAfterMs, fault: attempt.fault, output, retrying,
  };
}

export function sanitizeModelTransport(transport) {
  if (!['before-send', 'response', 'unknown'].includes(transport?.phase)) return undefined;
  const { phase, fault, status, retryAfterMs, output, retrying } = transport;
  return {
    phase,
    ...(transportFaults.has(fault) ? { fault } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(Number.isInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= maxRetryAfterMs ? { retryAfterMs } : {}),
    output: output === true,
    retrying: retrying === true,
  };
}
