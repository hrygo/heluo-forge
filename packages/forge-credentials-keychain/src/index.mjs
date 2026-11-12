import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { capabilities, createRegisteredBackend } from './backend-registry.mjs';
import { createKeychainProvider, KeychainProviderError, namespacePrefixes } from './provider.mjs';
import { createJointStore, JOINT_STORE_SERVICE } from './joint-store.mjs';

export const name = 'forge-credentials-keychain';
export const inject = [];

export { createMemoryBackend } from './backend.mjs';
export { createCredentialStore } from './credential-store.mjs';
export { createKeychainProvider, KeychainProviderError, namespacePrefixes } from './provider.mjs';
export { createJointStore, JOINT_STORE_SERVICE } from './joint-store.mjs';

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
function assertDirectoryOutsideRepository(path) {
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  current = realpathSync(current);
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      throw new KeychainProviderError(
        'KEYCHAIN_FILE_INSIDE_REPOSITORY',
        'credential storage must be outside a git work tree',
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function warnNonProduction(ctx, backend) {
  const notice = backend?.durable === false && backend?.available !== false
    ? 'credentials: 临时内存凭据后端已启用；进程退出即失效' : undefined;
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
    storeDirectory: '',
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

  if (input.storeDirectory !== undefined && input.storeDirectory !== null && input.storeDirectory !== '') {
    if (typeof input.storeDirectory !== 'string' || input.storeDirectory.trim().length === 0) {
      issues.push({ path: ['storeDirectory'], message: 'storeDirectory must be a non-empty string' });
    } else {
      value.storeDirectory = input.storeDirectory;
    }
  }

  if (input.allowEphemeral !== undefined && input.allowEphemeral !== null) {
    if (typeof input.allowEphemeral !== 'boolean') {
      issues.push({ path: ['allowEphemeral'], message: 'allowEphemeral must be a boolean' });
    } else {
      value.allowEphemeral = input.allowEphemeral;
    }
  }

  for (const key of ['filePath', 'allowInsecureFile', 'platformAdapter', 'allowUnvettedPlatformAdapter', 'allowUnverifiedEnumeration']) {
    if (Object.hasOwn(input, key)) {
      issues.push({ path: [key], message: `${key} is not supported by the new credential store` });
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

/** One directory resolver is shared by the Host and the read-only CLI. */
export function defaultStoreDirectory() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'HeluoForge');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'HeluoForge');
  return join(homedir(), '.local', 'share', 'HeluoForge');
}

function storeDirectory(directory) {
  const selected = resolve(directory || defaultStoreDirectory());
  assertDirectoryOutsideRepository(selected);
  return selected;
}

/** Open only the read operations needed by offline CLI clients. */
export async function openCredentialReader({ directory, service, accountPrefix } = {}) {
  const backend = createRegisteredBackend('sqlite', { directory: storeDirectory(directory), readOnly: true });
  const provider = createKeychainProvider(backend, { service, accountPrefix });
  return Object.freeze({
    readRecord: (key) => provider.readRecord(key),
    resolve: (ref) => provider.resolve(ref),
    close: () => provider.close(),
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

  const builtinBackend = result.value.backend === undefined;
  if (!builtinBackend && result.value.allowEphemeral !== true) {
    throw new KeychainProviderError('KEYCHAIN_EPHEMERAL_REFUSED', 'an injected test backend requires allowEphemeral=true');
  }
  const backend = result.value.backend ?? createRegisteredBackend('sqlite', { directory: storeDirectory(result.value.storeDirectory) });
  if (backend.available === false) {
    throw new KeychainProviderError('KEYCHAIN_UNAVAILABLE', backend.reason ?? 'keychain backend is unavailable');
  }
  if (backend.durable !== true && result.value.allowEphemeral !== true) {
    throw new KeychainProviderError(
      'KEYCHAIN_EPHEMERAL_REFUSED',
      'ephemeral backend requires allowEphemeral=true; no plaintext fallback is performed',
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
  // A trusted composition may only commit record+ref jointly through an
  // adapter bound to this exact provider instance. The trust object is a
  // separate host service, so a credentials impostor has to mount it too, and
  // it disappears together with the provider on unload.
  // Only the registered, built-in implementation is eligible for the trust
  // service. An injected backend cannot grant itself trust by exposing methods.
  const registeredCapabilities = builtinBackend ? capabilities('sqlite') : undefined;
  const jointStore = registeredCapabilities?.crossProcessLock === true && registeredCapabilities?.jointAtomic === true
    ? createJointStore(backend, namespacePrefixes(result.value)) : undefined;
  const trust = jointStore === undefined ? undefined : Object.freeze({
    verify: (candidate) => candidate === provider,
    adapter: () => jointStore,
  });

  let closed = false;
  let disposeProvide;
  let disposeTrust;
  const teardown = async () => {
    if (closed) return;
    closed = true;
    try {
      await provider.close();
    } finally {
      // Unprovide even when the backend fails to close: leaving a provider that
      // points at a half-closed backend behind is worse than the close error.
      disposeTrust?.();
      disposeProvide?.();
    }
  };
  ctx.effect(() => {
    disposeProvide = ctx.provide('credentials', provider);
    if (trust) disposeTrust = ctx.provide(JOINT_STORE_SERVICE, trust);
    return teardown;
  }, 'forge-credentials-keychain');
  return teardown;
}
