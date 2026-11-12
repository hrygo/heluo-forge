// Test-only memory and unavailable backends. Cross-process trust is determined
// by the composition root, never by the methods or flags of an injected object.

import { isDeepStrictEqual } from 'node:util';
import { assertCredentialValue } from './text.mjs';

/**
 * Grammar for a backend's service/namespace segment. Backends and the provider
 * must accept exactly the same names, so it is defined once here.
 */
export const NAMESPACE_PATTERN = /^[A-Za-z0-9._-]+$/;

export class KeychainBackendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeychainBackendError';
    this.code = code;
  }
}

/**
 * @param {Record<string, string> | Map<string, string>} [initial]
 */
export function createMemoryBackend(initial = {}) {
  const store = new Map(initial instanceof Map ? initial : Object.entries(initial));
  let tail = Promise.resolve();
  function locked(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  }
  function pair(scope) {
    if (!scope || typeof scope.recordKey !== 'string' || !scope.recordKey
      || typeof scope.ref !== 'string' || !scope.ref || scope.ref === scope.recordKey) {
      throw new KeychainBackendError('KEYCHAIN_SCOPE_INVALID', 'joint commit requires two distinct keys');
    }
    const raw = store.get(scope.recordKey);
    let record;
    if (raw !== undefined) {
      try { record = JSON.parse(raw); } catch { throw new KeychainBackendError('KEYCHAIN_RECORD_INVALID', 'stored record is invalid'); }
    }
    return { record, value: store.get(scope.ref) };
  }

  return {
    kind: 'memory',
    available: true,
    durable: false,
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      return locked(() => { assertCredentialValue(value); store.set(key, value); });
    },
    async delete(key) {
      return locked(() => { store.delete(key); });
    },
    async list(prefix) {
      return [...store.keys()].filter((key) => key.startsWith(prefix));
    },
    async listEntries(prefix) {
      return [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    },
    async transaction(key, mutate) {
      return locked(async () => {
        let value = store.get(key);
        let changed = false;
        const tx = { get: () => value, set(next) { assertCredentialValue(next); value = next; changed = true; }, delete() { value = undefined; changed = true; } };
        const result = await mutate(tx);
        if (changed) {
          if (value === undefined) store.delete(key); else store.set(key, value);
        }
        return result;
      });
    },
    async snapshot(scope) { return pair(scope); },
    async compareAndSwap(scope, expected, next, guard) {
      if (typeof guard !== 'function') throw new KeychainBackendError('KEYCHAIN_GUARD_REQUIRED', 'joint commit requires a synchronous guard');
      return locked(() => {
        if (!isDeepStrictEqual(pair(scope), expected)) return { ok: false };
        const admitted = guard();
        if (admitted && typeof admitted.then === 'function') {
          Promise.resolve(admitted).catch(() => {});
          throw new KeychainBackendError('KEYCHAIN_GUARD_ASYNC', 'joint commit guard must be synchronous');
        }
        if (admitted !== true) throw new KeychainBackendError('KEYCHAIN_GUARD_REFUSED', 'joint commit guard refused');
        const committed = { record: next?.record, value: next?.value };
        if (committed.value !== undefined) assertCredentialValue(committed.value);
        if (committed.record === undefined) store.delete(scope.recordKey); else store.set(scope.recordKey, JSON.stringify(committed.record));
        if (committed.value === undefined) store.delete(scope.ref); else store.set(scope.ref, committed.value);
        return { ok: true, snapshot: structuredClone(committed) };
      });
    },
    async close() {},
    /** Test-only inspection; never expose this through the provider surface. */
    _snapshot() {
      return new Map(store);
    },
  };
}

function unavailable(method) {
  throw new KeychainBackendError(
    'KEYCHAIN_UNAVAILABLE',
    `keychain backend is not available (${method}); no plaintext fallback is performed`,
  );
}

/**
 * An explicit unavailable backend exercises refusal paths without falling
 * back to another credential store.
 */
export function createUnavailableBackend(reason = 'credential backend is not available') {
  return {
    kind: 'unavailable',
    available: false,
    durable: false,
    reason,
    async get() {
      unavailable('get');
    },
    async set() {
      unavailable('set');
    },
    async delete() {
      unavailable('delete');
    },
    async list() {
      unavailable('list');
    },
    async close() {},
  };
}
