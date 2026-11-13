import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { initialKeyBinding, validateKeyBinding } from './key-auth.mjs';
import { assertOutsideRepository, createKeyPaths } from './key-paths.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });

function safePath(path, type, mode) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (type === 'file' ? !stat.isFile() : !stat.isDirectory())) {
    throw error('CRED_STORE_UNAVAILABLE', 'invalid credential store path');
  }
  if (process.platform !== 'win32' && ((stat.mode & 0o7777) !== mode
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) {
    throw error('CRED_STORE_PERMISSIONS', 'credential store permissions or owner are invalid');
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

/** SQLite stores only opaque envelopes; lock and read contention waits are async. */
export function createSqliteBackend({ directory, readOnly, keyProvider, lockTimeoutMs, keyPaths }) {
  // Existing internal file-provider callers predate the existence port. Keep
  // their original path checks and initialization without applying them to a
  // provider that implements the port.
  const legacy = !('exists' in Object(keyProvider));
  directory = resolve(legacy && keyPaths ? keyPaths.directory : directory);
  const legacyPaths = legacy ? (keyPaths ?? createKeyPaths(directory)) : undefined;
  const path = join(directory, 'credentials.sqlite');
  let db;
  let closed = false;
  let closing = false;
  let closePromise;
  let pendingInitialization;
  const operations = new Set();
  const activeTokens = new Set();
  const committed = new Set();
  const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 32);
  const abandoned = (pid, digest) => join(directory, `credentials.sqlite.abandoned.${pid}.${digest}`);
  const busy = (cause) => cause?.errcode === 5 || cause?.errcode === 6;
  const meta = (name) => db.prepare('SELECT value FROM meta WHERE key = ?').get(name)?.value;
  const putMeta = (name, value) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, value);
  function keyExists() {
    if (legacyPaths) {
      const path = legacyPaths.inspect();
      if (path === undefined) return false;
      if (typeof path === 'string' && path.length > 0) return true;
      throw error('CRED_KEY_INVALID', 'invalid credential key material state');
    }
    if (typeof keyProvider.exists !== 'function') throw error('CRED_KEY_INVALID', 'invalid credential key material state');
    const present = keyProvider.exists();
    if (typeof present !== 'boolean') {
      // An accidental async implementation is invalid, including on rejection.
      if (present instanceof Promise) void present.catch(() => {});
      throw error('CRED_KEY_INVALID', 'invalid credential key material state');
    }
    return present;
  }
  function transaction(fn, write = false) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }
  function validateBinding() {
    const active = meta('active');
    if (typeof active !== 'string' || !keyProvider.byId(active)) throw error('CRED_KEY_UNAVAILABLE', 'credential key is unavailable');
    const used = db.prepare('SELECT DISTINCT kid FROM secret').all().map((row) => row.kid);
    validateKeyBinding(meta('key_auth'), active, used, keyProvider);
  }
  function open(create = false) {
    // Admitted operations may still need to open or retry while close drains them.
    if (closed) throw error('CRED_STORE_UNAVAILABLE', 'credential store is closed');
    if (pendingInitialization) throw error('CRED_KEY_UNAVAILABLE', 'credential store initialization is incomplete');
    assertOutsideRepository(directory);
    const keyPresent = keyExists();
    if (db) {
      if (!keyPresent) throw error('CRED_KEY_UNAVAILABLE', 'credential keyring is unavailable');
      validateBinding();
      return true;
    }
    // Legacy encrypted documents have separate filenames. Leave them untouched;
    // only the authenticated SQLite database and keyring determine this store.
    if (!existsSync(directory)) {
      if (keyPresent) throw error('CRED_STORE_UNAVAILABLE', 'orphaned keyring exists');
      if (readOnly) throw error('CRED_STORE_UNAVAILABLE', 'credential store is unavailable');
      if (!create) return false;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    safePath(directory, 'directory', 0o700);
    let created = false;
    if (!existsSync(path)) {
      if (readOnly) throw error('CRED_STORE_UNAVAILABLE', 'credential store is unavailable');
      if (keyPresent) throw error('CRED_STORE_UNAVAILABLE', 'orphaned keyring exists');
      if (!create) return false;
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(fd);
      created = true;
    }
    safePath(path, 'file', 0o600);
    if (!created && !keyPresent) throw error('CRED_KEY_UNAVAILABLE', 'credential keyring is unavailable');
    try {
      db = new DatabaseSync(path, { readOnly });
      db.exec('PRAGMA busy_timeout = 0');
      if (created) {
        db.exec("CREATE TABLE secret (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', envelope BLOB NOT NULL, kid TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;");
        const token = randomBytes(16).toString('hex');
        transaction(() => putMeta('lock', JSON.stringify({ pid: process.pid, token: fingerprint(token) })), true);
        if (legacyPaths) legacyPaths.prepareNew();
        const initialized = keyProvider.initialize('k1');
        if (initialized && typeof initialized.then === 'function') {
          Promise.resolve(initialized).catch(() => {});
          throw error('CRED_KEY_INVALID', 'credential key initialization must be synchronous');
        }
        pendingInitialization = token;
      } else {
        if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw error('CRED_STORE_UNAVAILABLE', 'unknown credential store format');
        db.prepare('SELECT id,kind,owner,envelope,kid,revision,updated_at FROM secret LIMIT 0').all();
        validateBinding();
      }
    } catch (e) { if (db) { try { db.close(); } catch {} db = undefined; } throw e; }
    return true;
  }
  function assertToken(token) {
    let lock;
    try { lock = JSON.parse(meta('lock')); } catch { throw error('CRED_LOCK_LOST', 'credential lock is unavailable'); }
    if (lock?.pid !== process.pid || lock?.token !== fingerprint(token)) throw error('CRED_LOCK_LOST', 'credential lock is unavailable');
  }
  // A live process's lock is reclaimable only after its owner publishes the
  // original token. SQLite stores just the token's digest, so an unrelated
  // process cannot forge a completion marker from the metadata alone.
  function isAbandoned(lock) {
    const path = abandoned(lock.pid, lock.token);
    let fd;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > 128 || stat.dev !== opened.dev || stat.ino !== opened.ino) return false;
      if (process.platform !== 'win32' && ((opened.mode & 0o7777) !== 0o600
        || (typeof process.getuid === 'function' && opened.uid !== process.getuid()))) return false;
      const marker = JSON.parse(readFileSync(fd, 'utf8'));
      return marker && Object.keys(marker).sort().join(',') === 'pid,token'
        && marker.pid === lock.pid && typeof marker.token === 'string'
        && /^[a-f0-9]{32}$/.test(marker.token) && fingerprint(marker.token) === lock.token;
    } catch { return false; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function markAbandoned(token) {
    const path = abandoned(process.pid, fingerprint(token));
    const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    let fd;
    let created = false;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      created = true;
      const info = fstatSync(fd);
      if (process.platform !== 'win32' && ((info.mode & 0o7777) !== 0o600
        || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
        throw error('CRED_LOCK_RECOVERY_FAILED', 'credential lock recovery could not be recorded');
      }
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      linkSync(temporary, path);
    } catch {
      throw error('CRED_LOCK_RECOVERY_FAILED', 'credential lock recovery could not be recorded');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) { try { unlinkSync(temporary); } catch {} }
    }
  }
  // Admit the entire synchronous write before invoking its callback. A reader
  // may delay BEGIN EXCLUSIVE, but cannot make COMMIT replay the callback.
  async function commit(token, action) {
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      try { db.exec('BEGIN EXCLUSIVE'); break; }
      catch (cause) {
        if (!busy(cause)) throw cause;
        if (Date.now() >= deadline) throw error('CRED_LOCK_TIMEOUT', 'credential store is busy');
        await sleep(10);
      }
    }
    try {
      assertToken(token);
      // An async mutator or a busy database can outlive key material access.
      if (!keyExists()) throw error('CRED_KEY_UNAVAILABLE', 'credential keyring is unavailable');
      const result = action();
      assertToken(token);
      db.prepare("DELETE FROM meta WHERE key='lock'").run();
      db.exec('COMMIT');
      committed.add(token);
      return result;
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  }
  // Coordinate the cold-open window before the SQLite metadata lock exists.
  // Unknown markers are preserved. An already initialized store may proceed
  // only after its database schema and active key have both been verified.
  async function openForWrite() {
    if (pendingInitialization) {
      const deadline = Date.now() + lockTimeoutMs;
      while (pendingInitialization) {
        if (Date.now() >= deadline) throw error('CRED_LOCK_TIMEOUT', 'credential initialization is busy');
        await sleep(10);
      }
    }
    if (db) { await retryRead(() => open()); return; }
    assertOutsideRepository(directory);
    const keyPresent = keyExists();
    if (!existsSync(path) && keyPresent) {
      throw error('CRED_STORE_UNAVAILABLE', 'orphaned keyring exists');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    safePath(directory, 'directory', 0o700);
    const marker = join(directory, 'credentials.sqlite.init');
    const token = randomBytes(16).toString('hex');
    const deadline = Date.now() + lockTimeoutMs;
    let fd;
    while (fd === undefined) {
      try { fd = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // The creator may have finished the durable initialization and died
        // before removing its marker. Never bypass for partial initialization.
        if (existsSync(path) && keyExists()) {
          try { if (open(false)) return; } catch (cause) {
            // A creator may not have committed its active key yet. Only that
            // incomplete state and SQLite contention are temporary; a corrupt
            // database or invalid permissions must surface immediately.
            if (cause.code !== 'CRED_KEY_UNAVAILABLE' && cause.errcode !== 5 && cause.errcode !== 6) throw cause;
          }
        }
        if (Date.now() >= deadline) throw error('CRED_LOCK_TIMEOUT', 'credential initialization is busy');
        await sleep(10);
      }
    }
    try {
      writeFileSync(fd, token);
      closeSync(fd);
      fd = undefined;
      // Opening an existing database reads its schema and metadata. A different
      // process may briefly hold SQLite's exclusive commit lock at this point,
      // even though this process owns the initialization marker. Retrying is
      // safe only for an already existing database: an interrupted creation
      // must remain untouched and fail closed.
      const existing = existsSync(path);
      while (true) {
        try { open(true); break; }
        catch (e) {
          if (!existing || (e.errcode !== 5 && e.errcode !== 6)) throw e;
          if (Date.now() >= deadline) throw error('CRED_LOCK_TIMEOUT', 'credential store is busy');
          await sleep(10);
        }
      }
      if (pendingInitialization) {
        const token = pendingInitialization;
        try {
          // The keyring is created exactly once. Wait for exclusive admission
          // before activating it, so readers cannot make COMMIT fail busy.
          await commit(token, () => {
            putMeta('active', 'k1');
            putMeta('key_auth', initialKeyBinding(keyProvider, 'k1'));
          });
          committed.delete(token);
          pendingInitialization = undefined;
        } catch (cause) {
          try { db.close(); } catch {}
          db = undefined;
          pendingInitialization = undefined;
          throw cause;
        }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      // Never unlink a different owner's marker.
      try { if (readFileSync(marker, 'utf8') === token) unlinkSync(marker); } catch { /* fail closed if ownership is uncertain */ }
    }
  }
  async function runWithLock(fn, preflight) {
    if (readOnly) throw error('CRED_STORE_READ_ONLY', 'credential store is read only');
    await openForWrite();
    if (preflight) await retryRead(() => transaction(preflight));
    const token = randomBytes(16).toString('hex');
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      let acquired = false;
      let reclaimed;
      try {
        const raw = meta('lock');
        let old;
        if (raw !== undefined) {
          try { old = JSON.parse(raw); } catch { /* A corrupt lock cannot be reclaimed. */ }
          if (!old || !Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.token !== 'string' || !/^[a-f0-9]{32}$/.test(old.token)
            || (alive(old.pid) && !isAbandoned(old))) old = undefined;
        }
        // Filesystem checks happen before write admission. Replace only the
        // exact lock examined above, while SQLite serializes other writers.
        acquired = transaction(() => {
          if (meta('lock') !== raw || (raw !== undefined && !old)) return false;
          putMeta('lock', JSON.stringify({ pid: process.pid, token: fingerprint(token) }));
          return true;
        }, true);
        if (acquired) reclaimed = old;
      } catch (e) {
        if (e.errcode !== 5 && e.errcode !== 6) throw e;
      }
      if (acquired) {
        if (reclaimed) { try { unlinkSync(abandoned(reclaimed.pid, reclaimed.token)); } catch {} }
        break;
      }
      if (Date.now() >= deadline) throw error('CRED_LOCK_TIMEOUT', 'credential store is busy');
      await sleep(10);
    }
    let result;
    let actionError;
    let failed = false;
    activeTokens.add(token);
    try {
      if (!keyExists()) throw error('CRED_KEY_UNAVAILABLE', 'credential keyring is unavailable');
      result = await fn(token);
    }
    catch (cause) { failed = true; actionError = cause; }
    finally { activeTokens.delete(token); }
    if (!committed.delete(token)) {
      const releaseDeadline = Date.now() + lockTimeoutMs;
      try {
        while (true) {
          try {
            transaction(() => { assertToken(token); db.prepare("DELETE FROM meta WHERE key='lock'").run(); }, true);
            break;
          } catch (cause) {
            if (!busy(cause)) throw cause;
            if (Date.now() >= releaseDeadline) throw error('CRED_LOCK_TIMEOUT', 'credential store is busy');
            await sleep(10);
          }
        }
      } catch (cause) {
        // The operation has ended and can no longer use this token. If SQLite
        // remains busy, publish that fact independently of its read lock so a
        // subsequent writer can safely reclaim the otherwise live-PID lock.
        markAbandoned(token);
        throw failed ? actionError : cause;
      }
    }
    if (failed) throw actionError;
    return result;
  }
  async function withLock(fn, preflight) {
    if (closed || closing) throw error('CRED_STORE_UNAVAILABLE', 'credential store is closed');
    const operation = runWithLock(fn, preflight);
    operations.add(operation);
    try { return await operation; }
    finally { operations.delete(operation); }
  }
  async function retryRead(fn) {
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      try { return fn(); }
      catch (cause) {
        if (!busy(cause)) throw cause;
        if (Date.now() >= deadline) throw error('CRED_LOCK_TIMEOUT', 'credential store is busy');
        await sleep(10);
      }
    }
  }
  async function withRead(fn, token) {
    // A transaction's internal read belongs to its already admitted lock holder.
    if (closed || (closing && !activeTokens.has(token))) throw error('CRED_STORE_UNAVAILABLE', 'credential store is closed');
    const operation = retryRead(fn);
    operations.add(operation);
    try { return await operation; }
    finally { operations.delete(operation); }
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await Promise.allSettled([...operations]);
      closed = true;
      if (db) { db.close(); db = undefined; }
    })();
    return closePromise;
  }
  return {
    open, transaction, withLock, withRead, commit, assertToken,
    get(id) { return db.prepare('SELECT * FROM secret WHERE id = ?').get(id); },
    list() { return db.prepare('SELECT * FROM secret ORDER BY id').all(); },
    set(row) { db.prepare('INSERT INTO secret(id,kind,owner,envelope,kid,revision,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,owner=excluded.owner,envelope=excluded.envelope,kid=excluded.kid,revision=secret.revision+1,updated_at=excluded.updated_at').run(row.id, row.kind, row.owner, row.envelope, row.kid, new Date().toISOString()); },
    delete(id) { db.prepare('DELETE FROM secret WHERE id = ?').run(id); },
    active() { return meta('active'); },
    setActive(kid) { putMeta('active', kid); },
    keyAuth() { return meta('key_auth'); },
    setKeyAuth(value) { putMeta('key_auth', value); },
    keyIds() { return db.prepare('SELECT DISTINCT kid FROM secret').all().map((row) => row.kid); },
    close,
  };
}
