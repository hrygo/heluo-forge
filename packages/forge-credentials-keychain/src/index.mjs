import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { KeychainBackendError, createFileBackend, createPlatformBackend, createUnavailableBackend } from './backend.mjs';
import { createNativeKeyringBackend, nativeTargetFor } from './native-keyring.mjs';
import { createSecurityCliBackend } from './security-cli.mjs';
import { createKeychainProvider, KeychainProviderError } from './provider.mjs';

export const name = 'forge-credentials-keychain';
export const inject = [];

export { createFileBackend, createMemoryBackend, createPlatformBackend, createUnavailableBackend, KeychainBackendError } from './backend.mjs';
export { createNativeKeyringBackend, NATIVE_KEYRING_MODULE, nativeAddonPath, nativeTargetFor, WINDOWS_BLOB_LIMIT_BYTES, WINDOWS_KEY_LIMIT_BYTES, WINDOWS_RUNTIME_DLLS, windowsRuntimeStatus } from './native-keyring.mjs';
export { createSecurityCliBackend, probeSecurityCli, SECURITY_CLI_DEFAULT_PATH, SECURITY_ITEM_NOT_FOUND } from './security-cli.mjs';
export { createKeychainProvider, KeychainProviderError } from './provider.mjs';
export { isMigratableKey, KeychainMigrationError, migrateLegacyFileToKeychain, MIGRATION_REASONS, redactSecrets } from './migrate.mjs';

const BACKEND_METHODS = ['get', 'set', 'delete', 'list'];

/**
 * Mark an explicitly permitted non-production backend in the startup log.
 * The message stays generic: a file path or a backend reason could expose
 * local layout or credentials, and a failing logger must never turn a
 * permitted opt-in into a mount failure.
 *
 * @param {object} ctx plugin context
 * @param {object} backend selected backend
 */
/**
 * A credential document that lives inside a git work tree is one `git add -A`
 * away from being published. Refuse it at mount instead of trusting the caller
 * to have picked a directory outside the repository.
 */
function assertFileOutsideRepository(path) {
  let current = dirname(resolve(path));
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      throw new KeychainProviderError(
        'KEYCHAIN_FILE_INSIDE_REPOSITORY',
        'filePath points inside a git work tree; keep the plaintext credential document outside any repository',
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function warnNonProduction(ctx, backend) {
  const notice = backend?.requiresExplicitOptIn === true
    ? 'credentials: 非生产凭据后端（明文文件）已启用；仅限开发/试点，不得用于生产'
    : backend?.unvetted === true
      ? 'credentials: 未取证的原生凭据适配器已启用；仅限试点，不得用于生产'
      : backend?.durable === false && backend?.available !== false
        ? 'credentials: 临时内存凭据后端已启用；进程退出即失效'
        : undefined;
  if (notice === undefined) return;
  try {
    ctx.logger?.warn?.(notice);
  } catch {
    // Diagnostics must not change the already permitted mount.
  }
}

/**
 * Report a committed credentials change through `ctx.events.dispatch` so one
 * broken observer cannot affect the others or the durable write. Cordis
 * `ctx.emit()` runs every listener in one synchronous `map`, so a single throw
 * aborts the remaining listeners and an async rejection escapes unhandled;
 * the seam requires both to be contained and logged.
 *
 * @param {object} ctx plugin context
 * @param {string} event `credentials/reference-updated` or `credentials/record-updated`
 * @param {string} subject the changed ref or record key
 */
function notifyContained(ctx, event, subject) {
  const warn = (error) => {
    try {
      ctx.logger?.warn?.(`credentials: a ${event} listener for "${subject}" failed`, error);
    } catch {
      // Diagnostics must never turn a committed write into a failure.
    }
  };
  const dispatch = ctx.events?.dispatch;
  if (typeof dispatch === 'function') {
    let listeners;
    try {
      listeners = dispatch.call(ctx.events, 'emit', [event, subject]);
    } catch (error) {
      warn(error);
      return;
    }
    for (const listener of listeners ?? []) {
      try {
        const returned = listener(subject);
        if (returned != null && typeof returned.then === 'function') {
          Promise.resolve(returned).catch(warn);
        }
      } catch (error) {
        warn(error);
      }
    }
    return;
  }
  try {
    ctx.emit?.(event, subject);
  } catch (error) {
    warn(error);
  }
}

export function validateConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ path: [''], message: 'config must be an object' }] };
  }
  const issues = [];
  const value = {
    service: 'heluo-forge',
    accountPrefix: 'iam',
    allowEphemeral: false,
    allowInsecureFile: false,
    allowUnvettedPlatformAdapter: false,
    allowUnverifiedEnumeration: false,
    platformAdapter: undefined,
    filePath: '',
    backend: undefined,
  };

  for (const key of ['service', 'accountPrefix']) {
    if (input[key] === undefined || input[key] === null) continue;
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      issues.push({ path: [key], message: `${key} must be a non-empty string` });
    } else {
      value[key] = input[key];
    }
  }

  if (input.filePath !== undefined && input.filePath !== null && input.filePath !== '') {
    if (typeof input.filePath !== 'string') {
      issues.push({ path: ['filePath'], message: 'filePath must be a non-empty string' });
    } else {
      value.filePath = input.filePath;
    }
  }

  if (input.allowInsecureFile !== undefined && input.allowInsecureFile !== null) {
    if (typeof input.allowInsecureFile !== 'boolean') {
      issues.push({ path: ['allowInsecureFile'], message: 'allowInsecureFile must be a boolean' });
    } else {
      value.allowInsecureFile = input.allowInsecureFile;
    }
  }

  if (input.allowEphemeral !== undefined && input.allowEphemeral !== null) {
    if (typeof input.allowEphemeral !== 'boolean') {
      issues.push({ path: ['allowEphemeral'], message: 'allowEphemeral must be a boolean' });
    } else {
      value.allowEphemeral = input.allowEphemeral;
    }
  }

  if (input.allowUnvettedPlatformAdapter !== undefined && input.allowUnvettedPlatformAdapter !== null) {
    if (typeof input.allowUnvettedPlatformAdapter !== 'boolean') {
      issues.push({ path: ['allowUnvettedPlatformAdapter'], message: 'allowUnvettedPlatformAdapter must be a boolean' });
    } else {
      value.allowUnvettedPlatformAdapter = input.allowUnvettedPlatformAdapter;
    }
  }

  if (input.platformAdapter !== undefined && input.platformAdapter !== null) {
    if (input.platformAdapter !== 'security-cli' && input.platformAdapter !== 'native-keyring') {
      issues.push({ path: ['platformAdapter'], message: "platformAdapter must be 'security-cli' or 'native-keyring' (both unvetted)" });
    } else {
      value.platformAdapter = input.platformAdapter;
    }
  }

  if (input.allowUnverifiedEnumeration !== undefined && input.allowUnverifiedEnumeration !== null) {
    if (typeof input.allowUnverifiedEnumeration !== 'boolean') {
      issues.push({ path: ['allowUnverifiedEnumeration'], message: 'allowUnverifiedEnumeration must be a boolean' });
    } else {
      value.allowUnverifiedEnumeration = input.allowUnverifiedEnumeration;
    }
  }

  if (input.backend !== undefined && input.backend !== null) {
    if (typeof input.backend !== 'object' || BACKEND_METHODS.some((method) => typeof input.backend[method] !== 'function')) {
      issues.push({ path: ['backend'], message: 'backend must implement get/set/delete/list' });
    } else {
      value.backend = input.backend;
    }
  }

  return issues.length ? { issues } : { value };
}

/**
 * Whether the staged native addon is treated as vetted. It stays `false` until
 * the target-machine evidence exists (issue #182 P4); while false the provider
 * refuses to mount it without `allowUnvettedPlatformAdapter: true`. Flipping
 * this flag is the release step, and it must ship together with that evidence.
 */
const NATIVE_ADAPTER_VETTED = false;

/**
 * Pick the default backend for this platform without weakening fail closed:
 * a platform-arch with a staged addon gets the native backend, everything else
 * keeps the explicitly unavailable backend. No branch here can reach plaintext.
 *
 * @param {{ platform?: string, arch?: string, service?: string, enumeration?: string, vetted?: boolean }} [options]
 */
export function resolvePlatformBackend(options = {}) {
  const explicit = options.platform !== undefined || options.arch !== undefined;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (nativeTargetFor(platform, arch) === undefined) {
    // An explicitly requested platform-arch must never resolve against this
    // host: on a machine that has an addon that would silently mount the wrong
    // architecture. Only the host default (no explicit arguments) may ask the
    // host's platform backend.
    if (!explicit) return createPlatformBackend();
    return createUnavailableBackend(
      `OS keychain adapter is not implemented for ${platform}-${arch}; this profile fails closed. Use a reviewed backend for production, or the documented development override (filePath + allowInsecureFile) in a non-production profile`,
    );
  }
  return createNativeKeyringBackend({
    service: options.service,
    platform,
    arch,
    load: options.load,
    vetted: options.vetted ?? NATIVE_ADAPTER_VETTED,
    enumeration: options.enumeration === 'find-credentials' ? 'find-credentials' : 'unsupported',
  });
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'heluo',
    validate: validateConfig,
  },
};

/**
 * @param {{ provide?: Function, get?: Function }} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const result = validateConfig(rawConfig);
  if ('issues' in result) {
    throw new KeychainProviderError('KEYCHAIN_CONFIG_INVALID', 'keychain provider config is invalid', {
      issues: result.issues,
    });
  }

  if (typeof ctx?.provide !== 'function') {
    throw new KeychainProviderError('KEYCHAIN_HOST_UNAVAILABLE', 'ctx.provide is required');
  }
  if (typeof ctx?.get !== 'function') {
    throw new KeychainProviderError('KEYCHAIN_CREDENTIALS_CHECK_UNAVAILABLE', 'ctx.get is required to check for an existing credentials provider');
  }
  if (typeof ctx?.effect !== 'function') {
    throw new KeychainProviderError('KEYCHAIN_HOST_UNAVAILABLE', 'ctx.effect is required to own the provider lifecycle');
  }

  const existing = ctx.get('credentials');
  if (existing !== undefined && existing !== null) {
    throw new KeychainProviderError(
      'KEYCHAIN_CREDENTIALS_CONFLICT',
      'another credentials provider is already mounted; disable dsh-credentials-local before enabling the keychain provider',
    );
  }

  if (result.value.platformAdapter === 'security-cli' && result.value.allowUnvettedPlatformAdapter !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_UNVETTED_ADAPTER_REFUSED',
      'platformAdapter=security-cli is a non-production spike adapter; set allowUnvettedPlatformAdapter=true only for local experiments',
    );
  }
  if (result.value.platformAdapter === 'native-keyring' && result.value.allowUnvettedPlatformAdapter !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_UNVETTED_ADAPTER_REFUSED',
      'platformAdapter=native-keyring is an unvetted prototype; set allowUnvettedPlatformAdapter=true only for local experiments',
    );
  }
  let backend;
  try {
    backend = result.value.backend
      ?? (result.value.platformAdapter === 'security-cli'
        ? createSecurityCliBackend({ service: result.value.service })
        : result.value.platformAdapter === 'native-keyring'
          ? createNativeKeyringBackend({
            service: result.value.service,
            enumeration: result.value.allowUnverifiedEnumeration === true ? 'find-credentials' : 'unsupported',
          })
          : result.value.filePath
            ? (assertFileOutsideRepository(result.value.filePath), createFileBackend({ path: result.value.filePath }))
            : resolvePlatformBackend({
              service: result.value.service,
              enumeration: result.value.allowUnverifiedEnumeration === true ? 'find-credentials' : 'unsupported',
            }));
  } catch (error) {
    // A backend that cannot be constructed is a mount failure, never a reason
    // to try a different (plaintext) backend.
    if (error instanceof KeychainBackendError) throw new KeychainProviderError(error.code, error.message);
    throw error;
  }
  if (backend.available === false) {
    throw new KeychainProviderError('KEYCHAIN_UNAVAILABLE', backend.reason ?? 'keychain backend is unavailable');
  }
  if (backend.durable !== true && result.value.allowEphemeral !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_EPHEMERAL_REFUSED',
      'ephemeral backend requires allowEphemeral=true; no plaintext fallback is performed',
    );
  }
  if (backend.unvetted === true && result.value.allowUnvettedPlatformAdapter !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_UNVETTED_ADAPTER_REFUSED',
      'an unvetted platform adapter requires allowUnvettedPlatformAdapter=true; production must use a reviewed OS keychain adapter',
    );
  }
  if (backend.requiresExplicitOptIn === true && result.value.allowInsecureFile !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_INSECURE_FILE_REFUSED',
      'file backend requires allowInsecureFile=true; production must use an OS keychain',
    );
  }
  warnNonProduction(ctx, backend);

  const provider = createKeychainProvider(backend, {
    service: result.value.service,
    accountPrefix: result.value.accountPrefix,
    notifyReference: (ref) => notifyContained(ctx, 'credentials/reference-updated', ref),
    notifyRecord: (key) => notifyContained(ctx, 'credentials/record-updated', key),
    onForeignKeys: ({ count }) => {
      // Count only: the key text belongs to whoever wrote it and need not be echoed.
      try {
        ctx.logger?.warn?.(`credentials: 存储里有 ${count} 个不属于本命名空间的记录键，已跳过`);
      } catch {
        // Diagnostics must not change the listing result.
      }
    },
  });

  // Cordis runs a normal function plugin with `new`, so a returned cleanup is
  // not collected as an effect. Register teardown explicitly: unload must
  // unprovide ctx.credentials and close the backend even for the default
  // (non-Cordis) call path that invokes the returned function directly.
  let closed = false;
  let disposeProvide;
  const teardown = async () => {
    if (closed) return;
    closed = true;
    try {
      await provider.close();
    } finally {
      // Unprovide even when the backend fails to close: leaving a provider that
      // points at a half-closed backend behind is worse than the close error.
      disposeProvide?.();
    }
  };
  ctx.effect(() => {
    disposeProvide = ctx.provide('credentials', provider);
    return teardown;
  }, 'forge-credentials-keychain');
  return teardown;
}
