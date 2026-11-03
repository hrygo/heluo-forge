// Non-production `@napi-rs/keyring` backend prototype (plan §3.1 / B1–B2).
//
// Scope and limits, deliberately explicit:
//   - It maps the existing backend contract (get/set/delete/list) onto the OS
//     store; it does NOT implement read-modify-write transactions, so the
//     provider keeps using its in-process queue and never claims a
//     cross-process lock.
//   - It never attests IAM trust. `unvetted: true` makes the composition
//     require `allowUnvettedPlatformAdapter: true`, and no `transaction()` is
//     exported even when the store has its own internal mutex.
//   - Enumeration is opt-in. The release 2.1.2 `findCredentials` differs per
//     platform (Windows filter syntax, macOS silently skipped unreadable
//     items), so the default is an explicit "unsupported" error rather than an
//     empty list. Callers that accept that risk must pass
//     `enumeration: 'find-credentials'`.
//   - Keys are stored verbatim as the full backend key, so the provider's
//     namespace prefixes and any other owner's records keep their meaning.

import { createRequire } from 'node:module';
import { KeychainBackendError, NAMESPACE_PATTERN } from './backend.mjs';

/** Platform packages are resolved by name; this module never installs them. */
const DEFAULT_MODULE = '@napi-rs/keyring';

/** Windows CREDENTIALW blob limit; UTF-16LE means at most half as many code units. */
const WINDOWS_BLOB_LIMIT_BYTES = 2560;

function assertService(service) {
  if (typeof service !== 'string' || !NAMESPACE_PATTERN.test(service)) {
    throw new KeychainBackendError(
      'KEYCHAIN_SERVICE_INVALID',
      'native keyring service must match the credential namespace grammar',
    );
  }
  return service;
}

/**
 * Load the native module lazily so importing this file never needs it, and
 * resolve from this package rather than the process working directory.
 */
function defaultLoad(moduleName) {
  try {
    return createRequire(import.meta.url)(moduleName);
  } catch {
    throw new KeychainBackendError(
      'KEYCHAIN_UNAVAILABLE',
      `native keyring module ${moduleName} cannot be loaded; no plaintext fallback is performed`,
    );
  }
}

/**
 * The backend contract is promise-based but the native module is synchronous,
 * so a loader that returns a promise is a configuration error rather than a
 * silently awaited value.
 */
function resolveModule(loader) {
  const loaded = loader();
  if (loaded !== null && typeof loaded === 'object' && typeof loaded.then === 'function') {
    throw new KeychainBackendError(
      'KEYCHAIN_UNAVAILABLE',
      'native keyring loader must resolve synchronously; pass a resolved module',
    );
  }
  return loaded;
}

function entryOptionsFor(platform) {
  // Pin Linux to Secret Service: the default builder silently falls back to the
  // in-memory keyutils store, which does not survive a reboot and would make
  // `durable: true` a lie. The options bag is ignored on other platforms.
  return platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined;
}

function assertStorable(platform, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KeychainBackendError('KEYCHAIN_VALUE_EMPTY', 'refusing to store an empty credential');
  }
  if (platform === 'win32') {
    // Report sizes only: the value itself must never reach a log or an error.
    const bytes = Buffer.byteLength(value, 'utf16le');
    if (bytes > WINDOWS_BLOB_LIMIT_BYTES) {
      throw new KeychainBackendError(
        'KEYCHAIN_VALUE_TOO_LARGE',
        `credential exceeds the Windows credential blob limit (${bytes} > ${WINDOWS_BLOB_LIMIT_BYTES} bytes as UTF-16LE)`,
      );
    }
  }
}

/**
 * @param {{
 *   service?: string,
 *   load?: () => { Entry: Function, findCredentials?: Function },
 *   platform?: string,
 *   enumeration?: 'unsupported' | 'find-credentials',
 * }} [options]
 */
export function createNativeKeyringBackend(options = {}) {
  const service = assertService(options.service ?? 'heluo-forge');
  const platform = options.platform ?? process.platform;
  const enumeration = options.enumeration ?? 'unsupported';
  if (enumeration !== 'unsupported' && enumeration !== 'find-credentials') {
    throw new KeychainBackendError('KEYCHAIN_ENUMERATION_INVALID', "enumeration must be 'unsupported' or 'find-credentials'");
  }
  const loader = options.load ?? (() => defaultLoad(DEFAULT_MODULE));
  let module;

  function store() {
    if (module !== undefined) return module;
    let loaded;
    try {
      loaded = resolveModule(loader);
    } catch (error) {
      if (error instanceof KeychainBackendError) throw error;
      throw new KeychainBackendError(
        'KEYCHAIN_UNAVAILABLE',
        'native keyring module is unavailable; no plaintext fallback is performed',
      );
    }
    if (loaded === null || typeof loaded !== 'object' || typeof loaded.Entry !== 'function') {
      throw new KeychainBackendError('KEYCHAIN_UNAVAILABLE', 'native keyring module does not export Entry');
    }
    module = loaded;
    return module;
  }

  /** One entry per key, always pinned to the reviewed Linux store. */
  function entry(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'backend key must be a non-empty string');
    }
    const { Entry } = store();
    const bag = entryOptionsFor(platform);
    return bag === undefined ? new Entry(service, key) : new Entry(service, key, bag);
  }

  const backend = {
    kind: 'native-keyring',
    available: true,
    durable: true,
    unvetted: true,
    production: false,
    service,
    enumeration,
    // No `transaction`, no `crossProcessLock`: the provider must not advertise
    // read-modify-write atomicity that this module does not provide.

    async get(key) {
      const value = entry(key).getPassword();
      // 2.1.2 returns null when absent; the provider only understands undefined.
      if (value === null || value === undefined) return undefined;
      if (typeof value !== 'string') {
        throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', 'native keyring returned a non-string value');
      }
      return value;
    },

    async set(key, value) {
      assertStorable(platform, value);
      entry(key).setPassword(value);
    },

    async delete(key) {
      // `deletePassword` returns false for an absent credential and throws when
      // it exists but cannot be removed; a failed delete is never reported as
      // a no-op.
      entry(key).deletePassword();
    },

    async list(prefix) {
      if (typeof prefix !== 'string' || prefix.length === 0) {
        throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'list requires a non-empty prefix');
      }
      if (enumeration === 'unsupported') {
        throw new KeychainBackendError(
          'KEYCHAIN_LIST_UNSUPPORTED',
          'native keyring enumeration is not verified for this platform; refusing to report an empty store',
        );
      }
      const { findCredentials } = store();
      if (typeof findCredentials !== 'function') {
        throw new KeychainBackendError('KEYCHAIN_LIST_UNSUPPORTED', 'native keyring does not export findCredentials');
      }
      // Errors propagate: a locked or unreachable store must not look empty.
      const found = findCredentials(service);
      if (!Array.isArray(found)) {
        throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', 'native keyring enumeration did not return a list');
      }
      const keys = [];
      for (const item of found) {
        const account = item?.account;
        if (typeof account !== 'string') {
          throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', 'native keyring enumeration returned an entry without an account');
        }
        // Accounts only: never surface the password half of a Credential.
        if (account.startsWith(prefix)) keys.push(account);
      }
      return keys;
    },

    async close() {
      // The native module holds no per-instance resources to release.
      module = undefined;
    },
  };

  // Fail at mount, not at the first credential use: an unavailable native
  // module must stop the composition (fail closed) instead of leaving a
  // provider that only breaks later during sign-in.
  store();

  return backend;
}

export { DEFAULT_MODULE as NATIVE_KEYRING_MODULE, WINDOWS_BLOB_LIMIT_BYTES };
