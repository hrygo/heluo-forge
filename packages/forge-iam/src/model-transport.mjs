import { AsyncLocalStorage } from 'node:async_hooks';

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

export function beforeModelSend(attempt) {
  return attempt?.calls === 1 && attempt.status === undefined && attempt.refusedConnection === true;
}

function retryAfterMillis(value) {
  if (!value) return undefined;
  const millis = /^\d{1,6}$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isInteger(millis) && millis >= 0 && millis <= maxRetryAfterMs ? millis : undefined;
}

export function modelFetchOptions(options, baseURL) {
  const attempt = scope.getStore();
  if (!attempt) return options;
  const directFetch = options?.fetch === undefined;
  const fetcher = options?.fetch ?? globalThis.fetch;
  const endpoint = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  return {
    ...options,
    maxRetries: 0,
    async fetch(input, init) {
      attempt.check();
      attempt.calls++;
      attempt.refusedConnection = false;
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : null);
      // Observe one direct bound POST. A followed redirect can have accepted
      // the first request before a later connection is refused.
      try {
        const response = await fetcher(input, { ...init, redirect: 'manual' });
        attempt.status = response.status;
        attempt.retryAfterMs = retryAfterMillis(response.headers.get('retry-after'));
        return response;
      } catch (cause) {
        const socket = cause?.cause ?? cause;
        attempt.fault = transportFaults.has(socket?.code) ? socket.code : undefined;
        attempt.refusedConnection = directFetch && url === endpoint && method === 'POST'
          && socket?.code === 'ECONNREFUSED' && socket.syscall === 'connect';
        throw cause;
      }
    },
  };
}

export function modelTransportDiagnostic(attempt, output, retrying) {
  if (!attempt?.calls) return undefined;
  return {
    phase: attempt.status === undefined ? (beforeModelSend(attempt) ? 'before-send' : 'unknown') : 'response',
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
