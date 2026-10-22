// Backend contract for the keychain provider. A production adapter must map
// these operations to the OS secret store and report durable=true. The memory
// adapter exists only for tests and local development; the file adapter is an
// explicit, opt-in dev/pilot fallback that is never selected automatically.
// A backend MAY expose transaction(key, fn) to make read-modify-write atomic
// across processes; the provider uses it instead of a plain get/set sequence.

import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

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
 * Best-effort cross-process lock for the dev file backend. O_EXCL is atomic on
 * the supported platforms; stale locks are reclaimed after 30s. This is not a
 * substitute for an OS keychain provider lock, but it prevents two DSH
 * processes from silently losing a refresh-token rotation in local pilots.
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function withFileLock(path, key, fn) {
  void key;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // One file lock for the whole JSON document: per-key locks would still
  // clobber other keys because every writer persists the complete document.
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 10000;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new KeychainBackendError('KEYCHAIN_LOCK_FAILED', 'keychain lock cannot be created');
      try {
        const info = await stat(lockPath);
        const ownerText = await readFile(lockPath, 'utf8').catch(() => '');
        const ownerPid = Number.parseInt(ownerText.split(':')[0], 10);
        const hasOwnerPid = Number.isInteger(ownerPid) && ownerPid > 0;
        const ownerAlive = hasOwnerPid && pidAlive(ownerPid);
        if (hasOwnerPid ? !ownerAlive : Date.now() - info.mtimeMs > 30000) {
          // Move the stale lock aside first. A plain unlink could remove a
          // lock that another waiter created between the read and the unlink.
          const stale = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
          try {
            // Re-read before moving: another waiter may already have replaced
            // the stale lock with a fresh one.
            const latest = await readFile(lockPath, 'utf8').catch(() => null);
            if (latest !== ownerText) continue;
            await rename(lockPath, stale);
            await unlink(stale);
          } catch {
            // Another process won the reclaim race; retry normally.
          }
          continue;
        }
      } catch {
        continue;
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
export function createFileBackend({ path, mode = 0o600 } = {}) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
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

  async function reload() {
    loaded = false;
    data.clear();
    await load();
  }

  async function persist(entries = data) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) });
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
    async get(key) { await reload(); return data.get(key); },
    async set(key, value) {
      await withFileLock(path, key, async () => {
        await reload();
        const snapshot = new Map(data);
        snapshot.set(key, value);
        await persist(snapshot);
      });
    },
    async delete(key) {
      await withFileLock(path, key, async () => {
        await reload();
        const snapshot = new Map(data);
        snapshot.delete(key);
        await persist(snapshot);
      });
    },
    async list(prefix) { await reload(); return [...data.keys()].filter((key) => key.startsWith(prefix)); },
    async transaction(key, fn) {
      return withFileLock(path, key, async () => {
        await reload();
        // Work on a private snapshot: an unlocked get()/list() in another
        // request must not clear a pending transaction's changes.
        const snapshot = new Map(data);
        let changed = false;
        const tx = {
          get() { return snapshot.get(key); },
          set(value) { snapshot.set(key, value); changed = true; },
          delete() { snapshot.delete(key); changed = true; },
        };
        const result = await fn(tx);
        if (changed) await persist(snapshot);
        return result;
      });
    },
    async close() {},
  };
}
