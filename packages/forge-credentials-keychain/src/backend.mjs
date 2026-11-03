// Backend contract for the keychain provider. A production adapter must map
// these operations to the OS secret store and report durable=true. The memory
// adapter exists only for tests and local development; the file adapter is an
// explicit, opt-in dev/pilot fallback that is never selected automatically.
// A backend MAY expose transaction(key, fn) to make read-modify-write atomic
// across processes; the provider uses it instead of a plain get/set sequence.

import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

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
    async listEntries(prefix) {
      return [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
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
    `OS keychain adapter is not implemented on this platform (${process.platform}); this profile fails closed. Use a reviewed backend for production, or the documented development override (filePath + allowInsecureFile) in a non-production profile`,
  );
}

/**
 * Local dev/pilot document lock for the whole JSON document: per-key locks
 * would still clobber other keys because every writer persists the complete
 * document.
 *
 * A lock left behind by a crashed process is reclaimed only when its recorded
 * owner pid is gone, and the reclaim itself is an atomic rename: exactly one
 * waiter can move the stale lock away, the others see ENOENT and retry the
 * exclusive create. A live owner is never displaced — contention times out.
 */

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

function lockOwnerPid(token) {
  const parsed = Number.parseInt(String(token).split(':')[0] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function withFileLock(path, fn, timeoutMs) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new KeychainBackendError('KEYCHAIN_LOCK_FAILED', 'keychain lock cannot be created');
      const token = await readFile(lockPath, 'utf8').catch(() => null);
      const owner = lockOwnerPid(token ?? '');
      if (owner !== undefined && !isProcessAlive(owner)) {
        const graveyard = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        try {
          await rename(lockPath, graveyard);
          await unlink(graveyard).catch(() => {});
          continue;
        } catch {
          // Another waiter reclaimed it first; retry the exclusive create.
        }
      }
      if (Date.now() > deadline) {
        throw new KeychainBackendError('KEYCHAIN_LOCK_TIMEOUT', 'keychain lock is held by another process');
      }
      await sleep(25);
    }
  }
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
  try {
    await handle.writeFile(token, 'utf8');
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    const current = await readFile(lockPath, 'utf8').catch(() => null);
    if (current === token) await unlink(lockPath).catch(() => {});
  }
}

/**
 * Explicit 0600 JSON fallback for local development and pilots. It is not a
 * production keychain: callers must opt in with allowInsecureFile=true and
 * accept that the file is plaintext at rest.
 */
export function createFileBackend({ path, mode = 0o600, lockTimeoutMs = 10000 } = {}) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    throw new KeychainBackendError('KEYCHAIN_PATH_REQUIRED', 'file backend requires an absolute path');
  }
  async function load() {
    // Reads do not take the document lock. Each operation must own its Map
    // from the start, not just copy shared mutable state after an await.
    const data = new Map();
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
      if (error?.code === 'ENOENT') return data;
      if (error instanceof KeychainBackendError) throw error;
      throw new KeychainBackendError('KEYCHAIN_FILE_CORRUPT', 'keychain file cannot be read');
    }
    return data;
  }

  async function persist(entries) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) });
    try {
      // fsync before rename: without it a power loss can leave the new name
      // pointing at an empty or truncated document, which would lose every
      // credential instead of only the in-flight write.
      const created = await open(temporary, 'wx', mode);
      try {
        await created.writeFile(payload, 'utf8');
        await created.sync();
      } finally {
        await created.close().catch(() => {});
      }
      await chmod(temporary, mode);
      await rename(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      // The temporary document holds the same plaintext credentials as the
      // store; a failed or interrupted write must not leave a copy behind in
      // the same directory.
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await chmod(path, mode).catch(() => {});
  }

  /**
   * Persist the directory entry itself. Windows cannot open a directory as a
   * file descriptor; there the rename is still atomic, so a failed directory
   * sync is not a write failure.
   */
  async function syncDirectory(directory) {
    let handle;
    try {
      handle = await open(directory, 'r');
      await handle.sync();
    } catch {
      // Best effort: the file content is already durable.
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return {
    kind: 'file',
    available: true,
    durable: true,
    secure: false,
    requiresExplicitOptIn: true,
    async get(key) { return (await load()).get(key); },
    async set(key, value) {
      await withFileLock(path, async () => {
        const snapshot = await load();
        snapshot.set(key, value);
        await persist(snapshot);
      }, lockTimeoutMs);
    },
    async delete(key) {
      await withFileLock(path, async () => {
        const snapshot = await load();
        snapshot.delete(key);
        await persist(snapshot);
      }, lockTimeoutMs);
    },
    async list(prefix) { return [...(await load()).keys()].filter((key) => key.startsWith(prefix)); },
    async listEntries(prefix) {
      // One document read for the whole listing: the provider must not issue a
      // separate read per record when the store already has every value.
      return [...(await load()).entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    },
    async transaction(key, fn) {
      return withFileLock(path, async () => {
        const snapshot = await load();
        let changed = false;
        const tx = {
          get() { return snapshot.get(key); },
          set(value) { snapshot.set(key, value); changed = true; },
          delete() { snapshot.delete(key); changed = true; },
        };
        const result = await fn(tx);
        if (changed) await persist(snapshot);
        return result;
      }, lockTimeoutMs);
    },
    async close() {},
  };
}
