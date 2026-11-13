import { IamError } from './errors.mjs';
import { safeMessage } from './service-helpers.mjs';
import { createGatewayCredentialStore, createGrantStore, createModelSelectionStore } from './store.mjs';

/**
 * The credentials provider and everything derived from it.
 *
 * One owner for the provider handles and their caches: revoking the provider,
 * reopening it after a swap, and the atomic-write verification all mutate the
 * same nine fields, and splitting that across call sites is what let a stale
 * gateway summary survive a revocation in the first place.
 */
export function createServiceStore({ options }) {
  let store = null;
  let storeCredentials = null;
  let storeError = null;
  let gatewayStore = null;
  let modelSelectionStore = null;
  let gatewaySummary = null;
  let gatewayLoadedAt = 0;
  let gatewayLoading = null;
  // Bumped whenever the credentials provider changes, so an in-flight read from
  // the previous provider cannot repopulate the summary after revocation.
  let gatewayEpoch = 0;

  function ensure() {
    let credentials;
    try {
      credentials = typeof options.getCredentials === 'function'
        ? options.getCredentials()
        : options.credentials;
    } catch {
      credentials = undefined;
    }
    if (!credentials) {
      // The provider fiber was revoked: never keep reading gateway state (and
      // possibly resolving the secret) through the previous provider.
      store = null;
      gatewayStore = null;
      modelSelectionStore = null;
      gatewaySummary = null;
      gatewayLoading = null;
      gatewayLoadedAt = 0;
      gatewayEpoch += 1;
      storeCredentials = null;
      storeError = new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      return null;
    }
    if (store && storeCredentials === credentials) return store;
    try {
      let targetStore;
      targetStore = createGrantStore(credentials, { verifyAtomicStore: (instance) => {
        try { assertAtomic(targetStore, instance); return true; } catch { return false; }
      } });
      store = targetStore;
      gatewayStore = createGatewayCredentialStore(credentials, {
        getGatewayAtomicStore: options.getGatewayAtomicStore,
        verifyGatewayAtomicStore: options.verifyGatewayAtomicStore,
      });
      // No secret and no joint transaction: the plain provider lock is enough.
      modelSelectionStore = createModelSelectionStore(credentials);
      gatewaySummary = null;
      gatewayLoadedAt = 0;
      gatewayLoading = null;
      gatewayEpoch += 1;
      storeCredentials = credentials;
      storeError = null;
      return store;
    } catch (cause) {
      store = null;
      gatewayStore = null;
      modelSelectionStore = null;
      gatewaySummary = null;
      gatewayLoadedAt = 0;
      gatewayLoading = null;
      gatewayEpoch += 1;
      storeCredentials = null;
      storeError = cause;
      return null;
    }
  }

  function atomicVerified(credentials) {
    try {
      if (!credentials || typeof options.verifyAtomicStore !== 'function') return false;
      const value = options.verifyAtomicStore(credentials);
      if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
      return value === true;
    } catch { return false; }
  }

  function assertAtomic(target, credentials) {
    if (ensure() !== target || storeCredentials !== credentials || !atomicVerified(credentials)) {
      throw new IamError('IAM_ATOMIC_STORE_UNVERIFIED', safeMessage('IAM_ATOMIC_STORE_UNVERIFIED'));
    }
  }

  function require() {
    const current = ensure();
    if (current) return current;
    throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
  }

  /**
   * 动态凭据端口：把「provider 何时就绪」这一层留在本模块里，装配点只拿端口。
   *
   * `ExtTokenStore` 需要 `readRecord/modifyRecord/deleteRecord/set/unset/resolve`
   * 六个方法；provider 在注入前可能还没就绪，所以这里每次调用都现取，绝不在装配时
   * 缓存某个 provider 的 store（否则换绑 provider 后仍会读到旧凭据）。
   */
  function credentialsPort() {
    const target = () => (ensure() ? storeCredentials : null);
    const unavailable = () => {
      const error = new Error('credentials storage is unavailable');
      error.code = 'KEYCHAIN_UNAVAILABLE';
      return error;
    };
    return Object.freeze({
      readRecord: (key) => {
        const port = target();
        return port && typeof port.readRecord === 'function' ? port.readRecord(key) : Promise.resolve(null);
      },
      modifyRecord: (key, mutate) => {
        const port = target();
        if (!port || typeof port.modifyRecord !== 'function') return Promise.reject(unavailable());
        return port.modifyRecord(key, mutate);
      },
      deleteRecord: (key) => {
        const port = target();
        if (!port || typeof port.deleteRecord !== 'function') return Promise.reject(unavailable());
        return port.deleteRecord(key);
      },
      set: (ref, value) => {
        const port = target();
        if (!port || typeof port.set !== 'function') return Promise.reject(unavailable());
        return port.set(ref, value);
      },
      unset: (ref) => {
        const port = target();
        if (!port || typeof port.unset !== 'function') return Promise.reject(unavailable());
        return port.unset(ref);
      },
      resolve: (ref) => {
        const port = target();
        if (!port || typeof port.resolve !== 'function') return Promise.reject(unavailable());
        return port.resolve(ref);
      },
    });
  }

  return {
    credentialsPort,
    get store() { return store; },
    set store(next) { store = next; },
    get storeCredentials() { return storeCredentials; },
    set storeCredentials(next) { storeCredentials = next; },
    get storeError() { return storeError; },
    set storeError(next) { storeError = next; },
    get gatewayStore() { return gatewayStore; },
    set gatewayStore(next) { gatewayStore = next; },
    get modelSelectionStore() { return modelSelectionStore; },
    set modelSelectionStore(next) { modelSelectionStore = next; },
    get gatewaySummary() { return gatewaySummary; },
    set gatewaySummary(next) { gatewaySummary = next; },
    get gatewayLoadedAt() { return gatewayLoadedAt; },
    set gatewayLoadedAt(next) { gatewayLoadedAt = next; },
    get gatewayLoading() { return gatewayLoading; },
    set gatewayLoading(next) { gatewayLoading = next; },
    get gatewayEpoch() { return gatewayEpoch; },
    set gatewayEpoch(next) { gatewayEpoch = next; },

    ensure,
    require,
    atomicVerified,
    assertAtomic,
  };
}
