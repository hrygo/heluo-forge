import { isDeepStrictEqual } from 'node:util';
import { assertCredentialValue, assertWellFormed } from './text.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });

function kindOf(id) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('|')) throw error('CRED_STORE_INVALID', 'invalid credential key');
  assertWellFormed(id);
  const parts = id.split('/');
  if (parts.some((part) => !part) || !['record', 'ref'].includes(parts[2])
    || (parts[2] === 'record' ? parts.length !== 5 : parts.length !== 4)) {
    throw error('CRED_STORE_INVALID', 'invalid credential key');
  }
  return parts[2];
}

function ownerOf(kind, value) {
  if (kind === 'ref') return '';
  let record;
  try { record = JSON.parse(value); } catch { throw error('CRED_STORE_INVALID', 'invalid credential record'); }
  const owner = record?.payload?.subject ?? record?.payload?.ownerSubject ?? '';
  if (typeof owner !== 'string') throw error('CRED_STORE_INVALID', 'invalid credential owner');
  assertWellFormed(owner);
  return owner;
}

/** Encrypt values while depending only on the supplied storage, cipher and key ports. */
export function createEncryptedAdapter({ backend, cipher, keys, integrity, kind = 'unknown', durable = false }) {
  function read(id) {
    const kind = kindOf(id);
    const row = backend.get(id);
    if (!row) return undefined;
    if (row.id !== id || row.kind !== kind) throw error('CRED_DECRYPT_FAILED', 'credential decryption failed');
    const data = cipher.open({ kind, id, owner: row.owner, kid: row.kid, envelope: row.envelope });
    const value = data.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(data)) throw error('CRED_DECRYPT_FAILED', 'credential decryption failed');
    return value;
  }
  function write(id, value) {
    const kind = kindOf(id);
    assertCredentialValue(value);
    const owner = ownerOf(kind, value);
    read(id);
    const kid = backend.active();
    const envelope = cipher.seal({ kind, id, owner, kid, plaintext: Buffer.from(value, 'utf8') });
    backend.set({ id, kind, owner, kid, envelope });
  }
  function pair(scope) {
    if (!scope || kindOf(scope.recordKey) !== 'record' || kindOf(scope.ref) !== 'ref') throw error('CRED_STORE_INVALID', 'invalid credential scope');
    const raw = read(scope.recordKey);
    let record;
    if (raw !== undefined) {
      try { record = JSON.parse(raw); } catch { throw error('CRED_DECRYPT_FAILED', 'credential decryption failed'); }
    }
    return { record, value: read(scope.ref) };
  }
  function commit(token, action) {
    return backend.commit(token, () => {
      integrity?.ensure();
      return action();
    });
  }
  function withLock(action) {
    return backend.withLock(async (token) => {
      if (integrity) await backend.withRead(() => backend.transaction(() => integrity.verify()), token);
      return action(token);
    }, integrity?.verify);
  }
  return Object.freeze({
    kind,
    durable,
    available: true,
    async get(id) { kindOf(id); return backend.withRead(() => backend.open() ? read(id) : undefined); },
    async set(id, value) { return withLock((token) => commit(token, () => write(id, value))); },
    async delete(id) { return withLock((token) => commit(token, () => { kindOf(id); read(id); backend.delete(id); })); },
    async list(prefix) { return backend.withRead(() => backend.open() ? backend.list().map((row) => row.id).filter((id) => id.startsWith(prefix)) : []); },
    async listEntries(prefix) { return backend.withRead(() => backend.open() ? backend.transaction(() => backend.list().filter((row) => row.id.startsWith(prefix)).map((row) => ({ key: row.id, value: read(row.id) }))) : []); },
    async transaction(id, mutate) {
      return withLock(async (token) => {
        const original = await backend.withRead(() => read(id), token);
        let current = original;
        let changed = false;
        const tx = { get: () => current, set(value) { current = value; changed = true; }, delete() { current = undefined; changed = true; } };
        const result = await mutate(tx);
        if (changed) await commit(token, () => {
          if (!isDeepStrictEqual(read(id), original)) throw error('CRED_STORE_CONFLICT', 'credential changed during mutation');
          if (current === undefined) backend.delete(id); else write(id, current);
        });
        return result;
      });
    },
    async snapshot(scope) {
      if (!scope || kindOf(scope.recordKey) !== 'record' || kindOf(scope.ref) !== 'ref') throw error('CRED_STORE_INVALID', 'invalid credential scope');
      return backend.withRead(() => backend.open() ? backend.transaction(() => pair(scope)) : { record: undefined, value: undefined });
    },
    async compareAndSwap(scope, expected, next, guard) {
      if (typeof guard !== 'function') throw error('KEYCHAIN_GUARD_REQUIRED', 'joint commit requires a synchronous guard');
      return withLock((token) => commit(token, () => {
        const current = pair(scope);
        if (!isDeepStrictEqual(current, expected)) return { ok: false };
        const admitted = guard();
        if (admitted !== null && typeof admitted === 'object' && typeof admitted.then === 'function') {
          Promise.resolve(admitted).catch(() => {});
          throw error('KEYCHAIN_GUARD_ASYNC', 'joint commit guard must be synchronous');
        }
        if (admitted !== true) throw error('KEYCHAIN_GUARD_REFUSED', 'joint commit guard refused');
        const committed = { record: next?.record, value: next?.value };
        if (committed.record === undefined) backend.delete(scope.recordKey); else write(scope.recordKey, JSON.stringify(committed.record));
        if (committed.value === undefined) backend.delete(scope.ref); else write(scope.ref, committed.value);
        return { ok: true, snapshot: structuredClone(committed) };
      }));
    },
    async rotate(kid) {
      return withLock((token) => {
        if (!keys.byId(kid)) keys.add(kid);
        keys.activate(kid);
        return commit(token, () => { backend.setActive(kid); integrity?.bind(kid); });
      });
    },
    async close() { await backend.close(); },
  });
}
