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
//   - Every call awaits the class the module exports: `AsyncEntry` does the
//     store round-trip off the JS thread, while the synchronous `Entry` blocks
//     the host event loop for the whole D-Bus / Security call. Async is
//     preferred when present; `await` on the synchronous surface is a no-op,
//     so a module that only exports `Entry` keeps working.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { KeychainBackendError, NAMESPACE_PATTERN } from './backend.mjs';

/**
 * Upstream package the staged addons come from. The addons themselves are
 * release resources under `native/<triple>/`, staged by
 * `scripts/fetch-native-keyring.mjs`; this package never declares the upstream
 * package as a dependency, because the enterprise bundle refuses external
 * runtime dependencies and the terminal must never resolve a platform package
 * at install time.
 */
const NATIVE_KEYRING_MODULE = '@napi-rs/keyring';

/** platform-arch → upstream prebuilt triple; anything else stays fail closed. */
const NATIVE_TARGETS = new Map([
  ['win32-x64', 'win32-x64-msvc'],
  ['linux-x64', 'linux-x64-gnu'],
  ['linux-arm64', 'linux-arm64-gnu'],
]);

/** Windows CREDENTIALW blob limit; UTF-16LE means at most half as many code units. */
const WINDOWS_BLOB_LIMIT_BYTES = 2560;

/**
 * Windows credential account limit (`CRED_MAX_USERNAME_LENGTH`). The upstream
 * store compares the UTF-8 byte length of the account before writing, so the
 * guard here uses the same unit to fail early with a stable code instead of
 * surfacing a platform error.
 */
const WINDOWS_KEY_LIMIT_BYTES = 513;

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
 * The staged triple for a platform-arch pair, or `undefined` when this package
 * ships no vetted addon for it. Undefined is not an error here: the caller must
 * fall back to the explicitly unavailable backend, never to plaintext.
 */
export function nativeTargetFor(platform = process.platform, arch = process.arch) {
  return NATIVE_TARGETS.get(`${platform}-${arch}`);
}

/** Absolute path of the staged addon, or `undefined` for an unsupported pair. */
export function nativeAddonPath(platform = process.platform, arch = process.arch) {
  const triple = nativeTargetFor(platform, arch);
  if (triple === undefined) return undefined;
  return fileURLToPath(new URL(`../vendor/${triple}/keyring.node`, import.meta.url));
}

/**
 * Load the staged addon from this package's own `native/` directory.
 *
 * Resolving by path instead of by package name is deliberate: a name lookup
 * would walk up into whatever `node_modules` the host happens to have, which is
 * exactly the "terminal resolves a platform package" behaviour the release
 * rules forbid. A missing file is a mount-time failure with an actionable
 * message, not a silent downgrade.
 */
function defaultLoad(platform = process.platform, arch = process.arch) {
  const triple = nativeTargetFor(platform, arch);
  if (triple === undefined) {
    throw new KeychainBackendError(
      'KEYCHAIN_UNAVAILABLE',
      `this package ships no vetted addon for ${platform}-${arch}; no plaintext fallback is performed`,
    );
  }
  const addon = nativeAddonPath(platform, arch);
  if (!existsSync(addon)) {
    // Same operator contract as the generic unavailable backend: say why, say
    // how to fix it, and name the only non-production escape hatch.
    throw new KeychainBackendError(
      'KEYCHAIN_UNAVAILABLE',
      `staged addon for ${triple} is missing; run node scripts/fetch-native-keyring.mjs before building. This profile fails closed with no plaintext fallback; a non-production profile may use the documented development override (filePath + allowInsecureFile).`,
    );
  }
  try {
    return createRequire(import.meta.url)(addon);
  } catch {
    throw new KeychainBackendError(
      'KEYCHAIN_UNAVAILABLE',
      `staged addon for ${triple} cannot be loaded; no plaintext fallback is performed`,
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

function assertKey(platform, key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'backend key must be a non-empty string');
  }
  // A NUL would terminate the native target string early, so the read would
  // address a different credential than the write; control characters are
  // never part of a legitimate key.
  if (/[\u0000-\u001f\u007f]/u.test(key)) {
    throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'backend key must not contain control characters');
  }
  if (platform === 'win32' && Buffer.byteLength(key, 'utf8') > WINDOWS_KEY_LIMIT_BYTES) {
    throw new KeychainBackendError(
      'KEYCHAIN_KEY_TOO_LONG',
      `backend key exceeds the Windows credential account limit (${Buffer.byteLength(key, 'utf8')} > ${WINDOWS_KEY_LIMIT_BYTES} bytes)`,
    );
  }
  return key;
}

function assertStorable(platform, value) {
  if (typeof value !== 'string') {
    throw new KeychainBackendError('KEYCHAIN_VALUE_INVALID', 'native keyring only stores strings');
  }
  if (value.length === 0) {
    throw new KeychainBackendError('KEYCHAIN_VALUE_EMPTY', 'refusing to store an empty credential');
  }
  // Both target platforms transport the value as UTF (UTF-16LE through the
  // Windows blob, UTF-8 through D-Bus), so a lone surrogate has no encoding.
  if (!value.isWellFormed()) {
    throw new KeychainBackendError('KEYCHAIN_VALUE_INVALID', 'credential value is not well-formed Unicode (lone surrogate)');
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
 * Upstream errors carry no stable code across platforms (napi turns them into
 * plain `Error`s), so they are normalized here: the operation is named, the
 * platform message is kept for diagnosis, and nothing else from the store is
 * copied into the error.
 */
function describeStoreError(error) {
  const raw = typeof error?.message === 'string' ? error.message : String(error);
  return raw.replace(/\s+/gu, ' ').trim().slice(0, 240) || 'no diagnostic message';
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
  // `vetted` stays false until the target machine evidence exists; the
  // provider then refuses to mount without an explicit opt-in.
  const vetted = options.vetted === true;
  const loader = options.load ?? (() => defaultLoad(platform, options.arch ?? process.arch));
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
    // `AsyncEntry` is optional; `Entry` stays required so a module that cannot
    // do async work is still usable (it just blocks).
    module = loaded;
    return module;
  }

  /**
   * Prefer `AsyncEntry`: the synchronous class blocks the host event loop for
   * the whole store round-trip, and a locked store can stall the process that
   * serves the UI.
   */
  function EntryClass() {
    const loaded = store();
    return typeof loaded.AsyncEntry === 'function' ? loaded.AsyncEntry : loaded.Entry;
  }

  /** One entry per key, always pinned to the reviewed Linux store. */
  function entry(key) {
    assertKey(platform, key);
    const Entry = EntryClass();
    const bag = entryOptionsFor(platform);
    return bag === undefined ? new Entry(service, key) : new Entry(service, key, bag);
  }

  async function call(operation, run) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof KeychainBackendError) throw error;
      throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', `native keyring ${operation} failed: ${describeStoreError(error)}`);
    }
  }

  async function enumerate(prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) {
      throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'list requires a non-empty prefix');
    }
    if (enumeration === 'unsupported') {
      throw new KeychainBackendError(
        'KEYCHAIN_LIST_UNSUPPORTED',
        'native keyring enumeration is not verified for this platform; refusing to report an empty store',
      );
    }
    const loaded = store();
    const list = typeof loaded.findCredentialsAsync === 'function'
      ? loaded.findCredentialsAsync
      : loaded.findCredentials;
    if (typeof list !== 'function') {
      throw new KeychainBackendError('KEYCHAIN_LIST_UNSUPPORTED', 'native keyring does not export findCredentials');
    }
    // Errors propagate: a locked or unreachable store must not look empty.
    //
    // Researched upstream semantics (keyring-node 2.1.2, keyring-core 1.0.1,
    // windows-native-keyring-store 1.1.0, dbus-secret-service-keyring-store
    // 1.0.1): Windows enumerates by the target suffix `*.<service>` and reads
    // `UserName` as the account, so foreign credentials whose target ends with
    // the service name are returned too; Linux searches the `service`
    // attribute and reads the `username` attribute, skipping items without it.
    // Both surfaces are therefore filtered here by the requested prefix, and
    // accounts that cannot be keys are dropped instead of failing the scan.
    const found = await call('enumeration', () => list.call(loaded, service));
    if (!Array.isArray(found)) {
      throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', 'native keyring enumeration did not return a list');
    }
    const entries = [];
    for (const item of found) {
      const account = item?.account;
      if (typeof account !== 'string') {
        throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', 'native keyring enumeration returned an entry without an account');
      }
      if (account.length === 0 || /[\u0000-\u001f\u007f]/u.test(account)) continue;
      if (!account.startsWith(prefix)) continue;
      const password = item?.password;
      entries.push(typeof password === 'string' ? { key: account, value: password } : { key: account });
    }
    return entries;
  }

  const backend = {
    kind: 'native-keyring',
    available: true,
    durable: true,
    unvetted: !vetted,
    production: vetted,
    service,
    enumeration,
    // No `transaction`, no `crossProcessLock`: the provider must not advertise
    // read-modify-write atomicity that this module does not provide.

    async get(key) {
      const value = await call('read', () => entry(key).getPassword());
      // 2.1.2 returns null when absent; the provider only understands undefined.
      if (value === null || value === undefined) return undefined;
      if (typeof value !== 'string') {
        throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', 'native keyring returned a non-string value');
      }
      return value;
    },

    async set(key, value) {
      assertStorable(platform, value);
      await call('write', () => entry(key).setPassword(value));
    },

    async delete(key) {
      // `deletePassword` resolves true when something was removed, false when
      // nothing was there, and rejects when removal failed. Do not take `false`
      // on faith: if the store still answers a value afterwards, the credential
      // survived and the caller must not believe it was deleted.
      const deleted = await call('delete', () => entry(key).deletePassword());
      if (deleted !== true) {
        const survivor = await call('read', () => entry(key).getPassword());
        if (survivor !== null && survivor !== undefined) {
          throw new KeychainBackendError(
            'KEYCHAIN_OPERATION_FAILED',
            'native keyring reported no credential to delete, but the entry can still be read',
          );
        }
      }
    },

    async list(prefix) {
      // Accounts only: never surface the password half of a Credential here.
      return (await enumerate(prefix)).map((item) => item.key);
    },

    async listEntries(prefix) {
      // The native enumeration already carries both halves, so the provider can
      // decode every record without one store round-trip per record.
      return enumerate(prefix);
    },

    async close() {
      // The native module holds no per-instance resources to release.
      module = undefined;
    },
  };

  // Module-level failures stop the composition at mount (fail closed) instead of
  // leaving a provider that only breaks during sign-in. Store-level failures
  // (locked or unreachable Secret Service, denied access) cannot be told apart
  // from a normal empty read here, so they surface on first use as operation
  // errors — the mount check is about the module, not the store.
  store();

  return backend;
}

export { NATIVE_KEYRING_MODULE, WINDOWS_BLOB_LIMIT_BYTES, WINDOWS_KEY_LIMIT_BYTES };
