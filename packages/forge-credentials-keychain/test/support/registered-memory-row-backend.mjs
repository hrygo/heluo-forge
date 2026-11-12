// Copied into the isolated test/support directory by backend-registry.test.mjs.
// This is a same-process fixture, not a persistent or cross-process backend.
import { createAesGcmCipher } from '../../src/cipher.mjs';
import { createEncryptedAdapter } from '../../src/encrypted-adapter.mjs';

export const syntheticKey = Buffer.alloc(32, 0x5a);
export const syntheticCalls = [];
const stores = new Map();

export function syntheticRows(directory) {
  return [...(stores.get(directory)?.values() ?? [])]
    .map((row) => ({ ...row, envelope: Buffer.from(row.envelope) }));
}

export function createRegisteredMemoryStore({ directory, readOnly = false }) {
  syntheticCalls.push(readOnly);
  if (!stores.has(directory)) stores.set(directory, new Map());
  const rows = stores.get(directory);
  const keys = { byId: (kid) => kid === 'k1' ? syntheticKey : undefined };
  const backend = {
    open: () => true,
    active: () => 'k1',
    get: (id) => rows.get(id),
    set: (row) => rows.set(row.id, { ...row, envelope: Buffer.from(row.envelope) }),
    delete: (id) => rows.delete(id),
    list: () => [...rows.values()],
    withRead: (run) => run(),
    withLock: (run) => {
      if (readOnly) throw Object.assign(new Error('read only'), { code: 'CRED_STORE_READ_ONLY' });
      return run('synthetic-lock');
    },
    transaction: (run) => run(),
    commit: (_token, run) => run(),
    close: async () => {},
  };
  const cipher = createAesGcmCipher(keys);
  return createEncryptedAdapter({ backend, cipher, keys, kind: 'memory', durable: false });
}
