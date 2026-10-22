import { createFileBackend, createPlatformBackend } from './backend.mjs';
import { createKeychainProvider, KeychainProviderError } from './provider.mjs';

export const name = 'forge-credentials-keychain';
export const inject = [];

export { createFileBackend, createMemoryBackend, createPlatformBackend, createUnavailableBackend, KeychainBackendError } from './backend.mjs';
export { createKeychainProvider, KeychainProviderError } from './provider.mjs';

const BACKEND_METHODS = ['get', 'set', 'delete', 'list'];

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

  if (input.filePath !== undefined && input.filePath !== null) {
    if (typeof input.filePath !== 'string' || input.filePath.length === 0) {
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
    notifyReference: (ref) => {
      try { ctx.emit?.('credentials/reference-updated', ref); } catch { /* listeners are contained by DSH */ }
    },
    notifyRecord: (key) => {
      try { ctx.emit?.('credentials/record-updated', key); } catch { /* listeners are contained by DSH */ }
    },
  });
  const dispose = ctx.provide('credentials', provider);
  return () => {
    provider.close();
    dispose?.();
  };
}