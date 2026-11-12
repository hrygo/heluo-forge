import { join } from 'node:path';
import { createAesGcmCipher } from './cipher.mjs';
import { createFileKeyProvider } from './keyring.mjs';
import { createSqliteBackend } from './sqlite-backend.mjs';
import { createEncryptedAdapter } from './encrypted-adapter.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });

/** Compose the built-in SQLite, cipher and file-key adapters. */
export function createCredentialStore({ directory, readOnly = false, lockTimeoutMs = 5000 } = {}) {
  if (typeof directory !== 'string' || !directory || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw error('CRED_STORE_INVALID', 'invalid credential store configuration');
  }
  const keys = createFileKeyProvider({ path: join(directory, 'keyring.json') });
  const cipher = createAesGcmCipher(keys);
  const backend = createSqliteBackend({ directory, readOnly, keyProvider: keys, lockTimeoutMs });
  return createEncryptedAdapter({ backend, cipher, keys, kind: 'sqlite', durable: true });
}
