import { randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, lstatSync, linkSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const KID = /^[A-Za-z0-9._-]{1,255}$/;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function validKid(kid) {
  if (typeof kid !== 'string' || !KID.test(kid)) throw failure('CRED_KEY_INVALID', 'invalid key identifier');
}

function parseDocument(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw failure('CRED_KEY_INVALID', 'invalid keyring document'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || Object.keys(doc).sort().join(',') !== 'active,keys,v' || doc.v !== 1
      || typeof doc.keys !== 'object' || doc.keys === null || Array.isArray(doc.keys)) {
    throw failure('CRED_KEY_INVALID', 'invalid keyring document');
  }
  validKid(doc.active);
  for (const [kid, value] of Object.entries(doc.keys)) {
    validKid(kid);
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
      throw failure('CRED_KEY_INVALID', 'invalid keyring key');
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) {
      throw failure('CRED_KEY_INVALID', 'invalid keyring key');
    }
  }
  if (!Object.hasOwn(doc.keys, doc.active)) throw failure('CRED_KEY_UNAVAILABLE', 'active key is unavailable');
  return doc;
}

function readDocument(path) {
  let fd;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('CRED_KEY_INVALID', 'keyring is not a regular file');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw failure('CRED_KEY_INVALID', 'keyring changed during open');
    }
    // Windows mode bits do not validate NTFS ACLs; that boundary requires platform verification.
    if (process.platform !== 'win32' && ((opened.mode & 0o7777) !== 0o600
        || (typeof process.getuid === 'function' && opened.uid !== process.getuid()))) {
      throw failure('CRED_KEY_PERMISSIONS', 'keyring permissions or owner are invalid');
    }
    return parseDocument(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw failure('CRED_KEY_UNAVAILABLE', 'keyring is unavailable');
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function syncDirectory(dir) {
  // Windows directory handles require a different API; durability there is not yet verified.
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    throw failure('CRED_KEY_DURABILITY', 'keyring directory could not be synchronized');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomic(path, doc, create) {
  const dir = dirname(path);
  const temporary = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  let created = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(doc));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (create) {
      // Hard-link creation fails if the destination already exists; it cannot replace it.
      linkSync(temporary, path);
    } else {
      renameSync(temporary, path);
      created = false;
    }
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) { try { unlinkSync(temporary); } catch { /* best effort */ } }
  }
}

/** The caller holds the store-wide lock during initialize and add. */
export function createFileKeyProvider({ path } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw failure('CRED_KEY_INVALID', 'keyring path is required');
  return Object.freeze({
    initialize(kid) {
      validKid(kid);
      const keys = Object.create(null);
      keys[kid] = randomBytes(32).toString('base64');
      writeAtomic(path, { v: 1, active: kid, keys }, true);
    },
    active() {
      const doc = readDocument(path);
      return { kid: doc.active, key: Buffer.from(doc.keys[doc.active], 'base64') };
    },
    byId(kid) {
      validKid(kid);
      const doc = readDocument(path);
      return Object.hasOwn(doc.keys, kid) ? Buffer.from(doc.keys[kid], 'base64') : undefined;
    },
    activate(kid) {
      validKid(kid);
      const doc = readDocument(path);
      if (!Object.hasOwn(doc.keys, kid)) throw failure('CRED_KEY_UNAVAILABLE', 'key is unavailable');
      if (doc.active === kid) {
        syncDirectory(dirname(path));
      } else {
        doc.active = kid;
        writeAtomic(path, doc, false);
      }
    },
    add(kid) {
      validKid(kid);
      const doc = readDocument(path);
      if (Object.hasOwn(doc.keys, kid)) throw failure('CRED_KEY_EXISTS', 'key identifier already exists');
      Object.defineProperty(doc.keys, kid, { value: randomBytes(32).toString('base64'), enumerable: true, writable: true, configurable: true });
      writeAtomic(path, doc, false);
    },
  });
}
