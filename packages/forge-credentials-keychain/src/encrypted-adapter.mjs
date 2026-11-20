import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertCredentialValue, assertWellFormed, IAM_CLIENT_SECRET_RECORD_SCOPE } from './text.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });
const PIN_READ_FAILURES = new Set([
  'CRED_DECRYPT_FAILED', 'CRED_KEY_INVALID', 'CRED_KEY_PERMISSIONS', 'CRED_KEY_UNAVAILABLE',
  'CRED_LEGACY_STORE', 'CRED_STORE_PATH_CONFLICT', 'CRED_STORE_PERMISSIONS', 'CRED_STORE_UNAVAILABLE',
  'EACCES', 'EIO', 'ELOOP', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOTDIR', 'EPERM',
]);
const iamClientSecretRecords = new WeakMap();

// The backend registry takes this capability by identity. The public backend
// returned by createCredentialStore() never exposes the port.
export function getIamClientSecretRecords(backend) {
  return iamClientSecretRecords.get(backend);
}

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

function isIamClientSecretId(id) {
  const [, , kind, scope] = id.split('/', 4);
  return kind === 'record' && scope === IAM_CLIENT_SECRET_RECORD_SCOPE;
}

function publicKindOf(id) {
  const kind = kindOf(id);
  if (isIamClientSecretId(id)) throw error('CRED_STORE_INVALID', 'credential record scope is reserved');
  return kind;
}

function publicScope(scope) {
  const { recordKey, ref } = scope ?? {};
  if (publicKindOf(recordKey) !== 'record' || publicKindOf(ref) !== 'ref') {
    throw error('CRED_STORE_INVALID', 'invalid credential scope');
  }
  return { recordKey, ref };
}

function assertIamClientSecretId(id) {
  if (kindOf(id) !== 'record' || !isIamClientSecretId(id)) {
    throw error('CRED_STORE_INVALID', 'expected an IAM client secret record key');
  }
}

function ownerOf(kind, value) {
  if (kind === 'ref') return '';
  let record;
  try { record = JSON.parse(value); } catch { throw error('CRED_STORE_INVALID', 'invalid credential record'); }
  const subject = record?.payload?.subject;
  const fallback = record?.payload?.ownerSubject;
  if (typeof subject === 'string' && subject.isWellFormed()) return subject;
  if (typeof fallback === 'string' && fallback.isWellFormed()) return fallback;
  return '';
}

/** Encrypt values while depending only on the supplied storage, cipher and key ports. */
export function createEncryptedAdapter({ backend, cipher, keys, integrity, kind = 'unknown', durable = false }) {
  function read(id, row) {
    const kind = kindOf(id);
    row ??= backend.get(id);
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
  function transact(id, mutate) {
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
  }
  function listPublicRows(prefix) {
    return backend.list().filter(({ id }) => id.startsWith(prefix) && !isIamClientSecretId(id));
  }

  function readPin(id, row) {
    if (!row) return undefined;
    const value = read(id, row);
    // A fresh GCM envelope distinguishes identical rewrites without hashing the secret itself.
    const revision = createHash('sha256').update(row.envelope).digest('base64url');
    return { value, revision };
  }

  // Keep the stored row and its authenticated envelope compatible with existing pins.
  // Only this port can address the reserved IAM client secret scope.
  const iamClientSecrets = Object.freeze({
    async withRecordAndPin(id, inspect) {
      if (publicKindOf(id) !== 'record') throw error('CRED_STORE_INVALID', 'expected a credential record key');
      const pin = (secretId) => {
        assertIamClientSecretId(secretId);
        return readPin(secretId, backend.get(secretId));
      };
      // `inspect` is synchronous and read-only so contention can retry the whole snapshot.
      return backend.withRead(() => backend.open()
        ? backend.transaction(() => inspect(read(id), pin))
        : inspect(undefined, () => undefined));
    },
    async pin(id) {
      assertIamClientSecretId(id);
      return backend.withRead(() => {
        if (!backend.open()) return undefined;
        const row = backend.get(id);
        if (!row) return undefined;
        const envelope = Buffer.from(row.envelope);
        return {
          ...readPin(id, row),
          retryRead: (check) => backend.withRead(check),
          isCurrent() {
            try {
              if (!backend.open()) return false;
              const current = backend.get(id);
              // A retained row does not prove its historical key is still available.
              return current?.kind === row.kind && current.owner === row.owner && current.kid === row.kid
                && current.revision === row.revision && envelope.equals(current.envelope)
                && read(id, current) !== undefined;
            } catch (cause) {
              if (PIN_READ_FAILURES.has(cause?.code)) return false;
              throw cause;
            }
          },
        };
      });
    },
    async modify(id, mutate) {
      assertIamClientSecretId(id);
      return transact(id, mutate);
    },
  });

  const store = Object.freeze({
    kind,
    durable,
    available: true,
    async get(id) { publicKindOf(id); return backend.withRead(() => backend.open() ? read(id) : undefined); },
    async set(id, value) {
      publicKindOf(id);
      return withLock((token) => commit(token, () => write(id, value)));
    },
    async delete(id) {
      publicKindOf(id);
      return withLock((token) => commit(token, () => { read(id); backend.delete(id); }));
    },
    async list(prefix) {
      return backend.withRead(() => backend.open() ? listPublicRows(prefix).map(({ id }) => id) : []);
    },
    async listEntries(prefix) {
      return backend.withRead(() => backend.open()
        ? backend.transaction(() => listPublicRows(prefix).map(({ id }) => ({ key: id, value: read(id) }))) : []);
    },
    async transaction(id, mutate) {
      publicKindOf(id);
      return transact(id, mutate);
    },
    async snapshot(scope) {
      const checked = publicScope(scope);
      return backend.withRead(() => backend.open() ? backend.transaction(() => pair(checked)) : { record: undefined, value: undefined });
    },
    async compareAndSwap(scope, expected, next, guard) {
      if (typeof guard !== 'function') throw error('KEYCHAIN_GUARD_REQUIRED', 'joint commit requires a synchronous guard');
      const checked = publicScope(scope);
      return withLock((token) => commit(token, () => {
        const current = pair(checked);
        if (!isDeepStrictEqual(current, expected)) return { ok: false };
        const admitted = guard();
        if (admitted !== null && typeof admitted === 'object' && typeof admitted.then === 'function') {
          Promise.resolve(admitted).catch(() => {});
          throw error('KEYCHAIN_GUARD_ASYNC', 'joint commit guard must be synchronous');
        }
        if (admitted !== true) throw error('KEYCHAIN_GUARD_REFUSED', 'joint commit guard refused');
        const committed = { record: next?.record, value: next?.value };
        if (committed.record === undefined) backend.delete(checked.recordKey); else write(checked.recordKey, JSON.stringify(committed.record));
        if (committed.value === undefined) backend.delete(checked.ref); else write(checked.ref, committed.value);
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
  iamClientSecretRecords.set(store, iamClientSecrets);
  return store;
}
