import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

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
export function createSqliteBackend({ directory, readOnly, keyProvider, lockTimeoutMs }) {
  const path = join(directory, 'credentials.sqlite');
  const keyPath = join(directory, 'keyring.json');
  let db;
  let closed = false;
  let closing = false;
  let closePromise;
  let pendingInitialization;
  const operations = new Set();
  const committed = new Set();
  const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 32);
  const abandoned = (pid, digest) => join(directory, `credentials.sqlite.abandoned.${pid}.${digest}`);
  const busy = (cause) => cause?.errcode === 5 || cause?.errcode === 6;
  const meta = (name) => db.prepare('SELECT value FROM meta WHERE key = ?').get(name)?.value;
  const putMeta = (name, value) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, value);
  function transaction(fn, write = false) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }
  function open(create = false) {
    if (closed || closing) throw error('CRED_STORE_UNAVAILABLE', 'credential store is closed');
    if (pendingInitialization) throw error('CRED_KEY_UNAVAILABLE', 'credential store initialization is incomplete');
    if (db) return true;
    for (const legacy of ['credentials.json', 'credentials.key']) {
      if (existsSync(join(directory, legacy))) throw error('CRED_LEGACY_STORE', 'legacy credential store exists');
    }
    if (!existsSync(directory)) {
      if (readOnly) throw error('CRED_STORE_UNAVAILABLE', 'credential store is unavailable');
      if (!create) return false;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    safePath(directory, 'directory', 0o700);
    let created = false;
    if (!existsSync(path)) {
      if (readOnly) throw error('CRED_STORE_UNAVAILABLE', 'credential store is unavailable');
      if (existsSync(keyPath)) throw error('CRED_STORE_UNAVAILABLE', 'orphaned keyring exists');
      if (!create) return false;
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(fd);
      created = true;
    }
    safePath(path, 'file', 0o600);
    if (!created && !existsSync(keyPath)) throw error('CRED_KEY_UNAVAILABLE', 'credential keyring is unavailable');
    try {
      db = new DatabaseSync(path, { readOnly });
      db.exec('PRAGMA busy_timeout = 0');
      if (created) {
        db.exec("CREATE TABLE secret (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', envelope BLOB NOT NULL, kid TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;");
        const token = randomBytes(16).toString('hex');
        transaction(() => putMeta('lock', JSON.stringify({ pid: process.pid, token: fingerprint(token) })), true);
        keyProvider.initialize('k1');
        pendingInitialization = token;
      } else {
        if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw error('CRED_STORE_UNAVAILABLE', 'unknown credential store format');
        db.prepare('SELECT id,kind,owner,envelope,kid,revision,updated_at FROM secret LIMIT 0').all();
        const active = meta('active');
        if (typeof active !== 'string' || !keyProvider.byId(active)) throw error('CRED_KEY_UNAVAILABLE', 'credential key is unavailable');
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
    if (db) return;
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
        if (existsSync(path) && existsSync(keyPath)) {
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
          await commit(token, () => putMeta('active', 'k1'));
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
  async function runWithLock(fn) {
    if (readOnly) throw error('CRED_STORE_READ_ONLY', 'credential store is read only');
    await openForWrite();
    const token = randomBytes(16).toString('hex');
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      let acquired = false;
      let reclaimed;
      try {
        acquired = transaction(() => {
          const raw = meta('lock');
          if (raw !== undefined) {
            let old;
            try { old = JSON.parse(raw); } catch { return false; }
            if (!old || !Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.token !== 'string' || !/^[a-f0-9]{32}$/.test(old.token)) return false;
            if (alive(old.pid) && !isAbandoned(old)) return false;
            // The transaction serializes the token check and replacement.
            if (meta('lock') !== raw) return false;
            reclaimed = old;
          }
          putMeta('lock', JSON.stringify({ pid: process.pid, token: fingerprint(token) }));
          return true;
        }, true);
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
    try { result = await fn(token); }
    catch (cause) { failed = true; actionError = cause; }
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
  async function withLock(fn) {
    if (closed || closing) throw error('CRED_STORE_UNAVAILABLE', 'credential store is closed');
    const operation = runWithLock(fn);
    operations.add(operation);
    try { return await operation; }
    finally { operations.delete(operation); }
  }
  async function withRead(fn) {
    if (closed || closing) throw error('CRED_STORE_UNAVAILABLE', 'credential store is closed');
    const operation = (async () => {
      const deadline = Date.now() + lockTimeoutMs;
      while (true) {
        try { return fn(); }
        catch (cause) {
          if (!busy(cause)) throw cause;
          if (Date.now() >= deadline) throw error('CRED_LOCK_TIMEOUT', 'credential store is busy');
          await sleep(10);
        }
      }
    })();
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
    close,
  };
}
