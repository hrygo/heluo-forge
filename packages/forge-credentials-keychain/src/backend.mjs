// Backend contract for the keychain provider. A production adapter must map
// these operations to the OS secret store and report durable=true. The memory
// adapter exists only for tests and local development; the file adapter is an
// explicit, opt-in dev/pilot fallback that is never selected automatically.

import { mkdir, readFile, rename, chmod, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

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

  return {
    kind: 'memory',
    available: true,
    durable: false,
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list(prefix) {
      return [...store.keys()].filter((key) => key.startsWith(prefix));
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
 * The platform backend is deliberately absent in this skeleton. Returning an
 * unavailable backend is safer than silently writing to a file: composition
 * startup fails until a reviewed Windows/Kylin adapter is supplied.
 */
export function createUnavailableBackend(reason = 'OS keychain adapter is not implemented') {
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

export function createPlatformBackend() {
  return createUnavailableBackend(
    `OS keychain adapter is not implemented on this platform (${process.platform}); provide a reviewed backend`,
  );
}

/**
 * Explicit 0600 JSON fallback for local development and pilots. It is not a
 * production keychain: callers must opt in with allowInsecureFile=true and
 * accept that the file is plaintext at rest.
 */
export function createFileBackend({ path, mode = 0o600 } = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new KeychainBackendError('KEYCHAIN_PATH_REQUIRED', 'file backend requires an absolute path');
  }
  let loaded = null;
  const data = new Map();

  async function load() {
    if (loaded) return;
    try {
      const raw = await readFile(path, 'utf8');
      await chmod(path, mode).catch(() => {});
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1 || parsed.entries === null || typeof parsed.entries !== 'object') {
        throw new KeychainBackendError('KEYCHAIN_FILE_CORRUPT', 'keychain file has an unsupported shape');
      }
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (typeof key !== 'string' || typeof value !== 'string') {
          throw new KeychainBackendError('KEYCHAIN_FILE_CORRUPT', 'keychain file has a non-string entry');
        }
        data.set(key, value);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        loaded = true;
        return;
      }
      if (error instanceof KeychainBackendError) throw error;
      throw new KeychainBackendError('KEYCHAIN_FILE_CORRUPT', 'keychain file cannot be read');
    }
    loaded = true;
  }

  async function persist() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(data) });
    await writeFile(temporary, payload, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode).catch(() => {});
  }

  return {
    kind: 'file',
    available: true,
    durable: true,
    secure: false,
    requiresExplicitOptIn: true,
    async get(key) { await load(); return data.get(key); },
    async set(key, value) { await load(); data.set(key, value); await persist(); },
    async delete(key) { await load(); data.delete(key); await persist(); },
    async list(prefix) { await load(); return [...data.keys()].filter((key) => key.startsWith(prefix)); },
    async close() {},
  };
}
