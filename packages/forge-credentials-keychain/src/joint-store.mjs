// Joint record/ref store for IAM credentials: comparison and both writes occur
// in one backend transaction.
//
// This adapter only exists when the backend supports snapshot() and
// compareAndSwap(); it never degrades into two independent writes.

import { KeychainProviderError } from './provider.mjs';

/** Host service a trusted composition reads the adapter from. */
export const JOINT_STORE_SERVICE = 'iam-atomic-store';

/**
 * @param {object} backend a backend exposing snapshot() and compareAndSwap()
 * @param {{ recordPrefix: string, refPrefix: string }} prefixes
 * @returns {{ snapshot(scope: object): Promise<object>, compareAndSwap(scope: object, expected: object, next: object, guard: Function): Promise<object> } | undefined}
 */
export function createJointStore(backend, prefixes) {
  if (typeof backend?.snapshot !== 'function' || typeof backend?.compareAndSwap !== 'function') return undefined;
  if (typeof prefixes?.recordPrefix !== 'string' || typeof prefixes?.refPrefix !== 'string') {
    throw new KeychainProviderError('KEYCHAIN_SCOPE_INVALID', 'joint store requires the provider namespace prefixes');
  }

  // Scope keys arrive unprefixed from the IAM gateway store; the backend sees
  // the same namespaced keys the provider uses for reads and writes.
  function storageScope(scope) {
    const recordKey = scope?.recordKey;
    const ref = scope?.ref;
    if (typeof recordKey !== 'string' || recordKey.length === 0
      || typeof ref !== 'string' || ref.length === 0) {
      throw new KeychainProviderError('KEYCHAIN_SCOPE_INVALID', 'joint store requires recordKey and ref');
    }
    return { recordKey: `${prefixes.recordPrefix}${recordKey}`, ref: `${prefixes.refPrefix}${ref}` };
  }

  return Object.freeze({
    async snapshot(scope) {
      return backend.snapshot(storageScope(scope));
    },
    async compareAndSwap(scope, expected, next, guard) {
      return backend.compareAndSwap(storageScope(scope), expected, next, guard);
    },
  });
}
