import { createFileBackend, createPlatformBackend } from './backend.mjs';
import { createKeychainProvider, KeychainProviderError } from './provider.mjs';

export const name = 'forge-credentials-keychain';
export const inject = [];

export { createFileBackend, createMemoryBackend, createPlatformBackend, createUnavailableBackend, KeychainBackendError } from './backend.mjs';
export { createKeychainProvider, KeychainProviderError } from './provider.mjs';

const BACKEND_METHODS = ['get', 'set', 'delete', 'list'];

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

  if (input.backend !== undefined && input.backend !== null) {
    if (typeof input.backend !== 'object' || BACKEND_METHODS.some((method) => typeof input.backend[method] !== 'function')) {
      issues.push({ path: ['backend'], message: 'backend must implement get/set/delete/list' });
    } else {
      value.backend = input.backend;
    }
  }

  return issues.length ? { issues } : { value };
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

  const backend = result.value.backend
    ?? (result.value.filePath ? createFileBackend({ path: result.value.filePath }) : createPlatformBackend());
  if (backend.available === false) {
    throw new KeychainProviderError('KEYCHAIN_UNAVAILABLE', backend.reason ?? 'keychain backend is unavailable');
  }
  if (backend.durable !== true && result.value.allowEphemeral !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_EPHEMERAL_REFUSED',
      'ephemeral backend requires allowEphemeral=true; no plaintext fallback is performed',
    );
  }
  if (backend.requiresExplicitOptIn === true && result.value.allowInsecureFile !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_INSECURE_FILE_REFUSED',
      'file backend requires allowInsecureFile=true; production must use an OS keychain',
    );
  }

  const provider = createKeychainProvider(backend, {
    service: result.value.service,
    accountPrefix: result.value.accountPrefix,
    notifyReference: (ref) => notifyContained(ctx, 'credentials/reference-updated', ref),
    notifyRecord: (key) => notifyContained(ctx, 'credentials/record-updated', key),
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
    await provider.close();
    disposeProvide?.();
  };
  ctx.effect(() => {
    disposeProvide = ctx.provide('credentials', provider);
    return teardown;
  }, 'forge-credentials-keychain');
  return teardown;
}
