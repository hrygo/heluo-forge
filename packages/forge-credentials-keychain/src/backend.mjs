// Backend contract for the keychain provider. A production adapter must map
// these operations to the OS secret store and report durable=true. The memory
// adapter exists only for tests and local development; the file adapter is an
// explicit, opt-in dev/pilot fallback that is never selected automatically.
// A backend MAY expose transaction(key, fn) to make read-modify-write atomic
// across processes; the provider uses it instead of a plain get/set sequence.

import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

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

/**
 * macOS path. Apple's keychain binds an item's ACL to the code signature of the
 * calling application, so an unsigned build is rejected (or prompts) and a
 * rebuild changes the identity again. macOS is delivered without a signing
 * identity, so the platform backend is an application-level encrypted document
 * instead of the login keychain: same file backend, AES-256-GCM at rest, key in
 * a 0600 file next to it. The guarantee is user-level isolation, not the
 * per-application isolation of a code-signed keychain.
 */
export function createMacosBackend({ directory } = {}) {
  const root = directory ?? join(homedir(), 'Library', 'Application Support', 'HeluoForge');
  return createFileBackend({
    path: join(root, 'credentials.json'),
    keyPath: join(root, 'credentials.key'),
  });
}

/**
 * Windows: the same application-level encrypted document as macOS, rooted in
 * the user profile. The Windows Credential Manager only offers overwrite
 * writes, so it cannot express the read-under-lock, guard, joint-commit
 * sequence the IAM sign-in gate requires; the native keyring adapter stays an
 * opt-in experiment. This backend gives a real single-document transaction and
 * a per-user isolation boundary, with the key file owned by the same profile.
 */
export function createWindowsBackend({ directory } = {}) {
  const root = directory
    ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'HeluoForge');
  return createFileBackend({
    path: join(root, 'credentials.json'),
    keyPath: join(root, 'credentials.key'),
  });
}

export function createPlatformBackend() {
  if (process.platform === 'darwin') return createMacosBackend();
  if (process.platform === 'win32') return createWindowsBackend();
  return createUnavailableBackend(
    `OS keychain adapter is not implemented on this platform (${process.platform}); this profile fails closed. Use a reviewed backend for production, or the documented development override (filePath + allowInsecureFile) in a non-production profile`,
  );
}

const KEY_BYTES = 32;
const KEY_MODE = 0o600;
const CIPHER = 'aes-256-gcm';

async function assertPrivateKeyFile(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'credential key file cannot be inspected');
  }
  // Windows reports synthetic modes and has no POSIX uid; the macOS backend is
  // the only production user of this path, but the contract tests run on every
  // CI platform, so the POSIX checks are applied where they are meaningful.
  if (process.platform === 'win32') return;
  if ((info.mode & 0o777) !== KEY_MODE) {
    throw new KeychainBackendError(
      'KEYCHAIN_KEY_PERMISSIONS',
      `credential key file must be mode 0600, found ${(info.mode & 0o777).toString(8)}; refusing to use it`,
    );
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new KeychainBackendError('KEYCHAIN_KEY_PERMISSIONS', 'credential key file belongs to another user; refusing to use it');
  }
}

/** Read the AES key, creating it with 0600 on first use. */
async function readOrCreateKey(keyPath) {
  try {
    const raw = await readFile(keyPath, 'utf8');
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'credential key file does not hold a 32-byte key');
    }
    await assertPrivateKeyFile(keyPath);
    return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  try {
    const created = await open(keyPath, 'wx', KEY_MODE);
    try {
      await created.writeFile(`${key.toString('base64')}\n`, 'utf8');
      await created.sync();
    } finally {
      await created.close().catch(() => {});
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // Another process created the key between our read and our exclusive
    // create. Use its key: returning the local candidate would decrypt with a
    // key the document was never written with.
    const raw = await readFile(keyPath, 'utf8');
    const existing = Buffer.from(raw.trim(), 'base64');
    if (existing.length !== KEY_BYTES) {
      throw new KeychainBackendError('KEYCHAIN_KEY_INVALID', 'credential key file does not hold a 32-byte key');
    }
    await assertPrivateKeyFile(keyPath);
    return existing;
  }
  await chmod(keyPath, KEY_MODE).catch(() => {});
  await assertPrivateKeyFile(keyPath);
  return key;
}

function encryptDocument(key, path, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`heluo-forge:${path}`));
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    alg: CIPHER,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function decryptDocument(key, path, envelope) {
  if (envelope.alg !== CIPHER || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
    throw new KeychainBackendError('KEYCHAIN_FILE_CORRUPT', 'encrypted credential document has an unsupported shape');
  }
  try {
    const decipher = createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`heluo-forge:${path}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new KeychainBackendError(
      'KEYCHAIN_FILE_TAMPERED',
      'encrypted credential document cannot be decrypted with the stored key; it was modified or the key does not match',
    );
  }
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
function normalizeScope(scope) {
  const recordKey = scope?.recordKey;
  const ref = scope?.ref;
  if (typeof recordKey !== 'string' || recordKey.length === 0
    || typeof ref !== 'string' || ref.length === 0) {
    throw new KeychainBackendError('KEYCHAIN_SCOPE_INVALID', 'joint commit requires recordKey and ref');
  }
  if (recordKey === ref) {
    throw new KeychainBackendError('KEYCHAIN_SCOPE_INVALID', 'joint commit requires two distinct keys');
  }
  return { recordKey, ref };
}

function decodeRecord(raw, key) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new KeychainBackendError('KEYCHAIN_FILE_CORRUPT', `stored record ${key} is not JSON`);
  }
}

export function createFileBackend({ path, mode = 0o600, lockTimeoutMs = 10000, keyPath } = {}) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    throw new KeychainBackendError('KEYCHAIN_PATH_REQUIRED', 'file backend requires an absolute path');
  }
  const encrypted = keyPath !== undefined;
  if (encrypted && (typeof keyPath !== 'string' || keyPath.length === 0 || !isAbsolute(keyPath))) {
    throw new KeychainBackendError('KEYCHAIN_KEY_REQUIRED', 'encrypted file backend requires an absolute keyPath');
  }
  async function load() {
    // Reads do not take the document lock. Each operation must own its Map
    // from the start, not just copy shared mutable state after an await.
    const data = new Map();
    try {
      let raw = await readFile(path, 'utf8');
      await chmod(path, mode).catch(() => {});
      if (encrypted) {
        const envelope = JSON.parse(raw);
        if (envelope === null || typeof envelope !== 'object' || envelope.alg === undefined) {
          throw new KeychainBackendError(
            'KEYCHAIN_FILE_CORRUPT',
            'a plaintext credential document exists where an encrypted one is expected; refusing to read it',
          );
        }
        raw = decryptDocument(await readOrCreateKey(keyPath), path, envelope);
      }
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
    const document = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) });
    const payload = encrypted ? encryptDocument(await readOrCreateKey(keyPath), path, document) : document;
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
    kind: encrypted ? 'file-encrypted' : 'file',
    available: true,
    durable: true,
    secure: false,
    encrypted,
    requiresExplicitOptIn: !encrypted,
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
    /**
     * Joint record/ref read. Both entries live in one document, so a caller gets
     * a consistent pair instead of two independent reads that another process
     * may straddle.
     */
    async snapshot(scope) {
      const { recordKey, ref } = normalizeScope(scope);
      const entries = await load();
      return { record: decodeRecord(entries.get(recordKey), recordKey), value: entries.get(ref) };
    },
    /**
     * Joint record/ref commit: compare the pair, run exactly one synchronous
     * guard, write both entries, then one fsync+rename. A stale snapshot
     * returns { ok: false }; a refusing guard writes nothing. The guard runs
     * inside the document lock, so no other process can slip between the guard
     * decision and the commit.
     */
    async compareAndSwap(scope, expected, next, guard) {
      const { recordKey, ref } = normalizeScope(scope);
      if (typeof guard !== 'function') {
        throw new KeychainBackendError('KEYCHAIN_GUARD_REQUIRED', 'joint commit requires a synchronous guard');
      }
      return withFileLock(path, async () => {
        const entries = await load();
        const current = { record: decodeRecord(entries.get(recordKey), recordKey), value: entries.get(ref) };
        if (!isDeepStrictEqual(current, expected)) return { ok: false };
        const admitted = guard();
        if (admitted !== null && typeof admitted === 'object' && typeof admitted.then === 'function') {
          Promise.resolve(admitted).catch(() => {});
          throw new KeychainBackendError('KEYCHAIN_GUARD_ASYNC', 'the joint-commit guard must decide synchronously');
        }
        if (admitted !== true) {
          throw new KeychainBackendError('KEYCHAIN_GUARD_REFUSED', 'the joint-commit guard refused the swap');
        }
        const committed = { record: next?.record, value: next?.value };
        if (committed.record === undefined) entries.delete(recordKey);
        else entries.set(recordKey, JSON.stringify(committed.record));
        if (committed.value === undefined) entries.delete(ref);
        else entries.set(ref, committed.value);
        await persist(entries);
        return { ok: true, snapshot: structuredClone(committed) };
      }, lockTimeoutMs);
    },
    async close() {},
  };
}
