import { createAesGcmCipher } from './cipher.mjs';
import { createStoreKeyProvider } from './keyring.mjs';
import { createKeyPaths } from './key-paths.mjs';
import { createKeyAuthentication } from './key-auth.mjs';
import { createSqliteBackend } from './sqlite-backend.mjs';
import { createEncryptedAdapter } from './encrypted-adapter.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });

/** Compose the built-in SQLite, cipher and file-key adapters. */
export function createCredentialStore({ directory, readOnly = false, lockTimeoutMs = 5000 } = {}) {
  if (typeof directory !== 'string' || !directory || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw error('CRED_STORE_INVALID', 'invalid credential store configuration');
  }
  const keyPaths = createKeyPaths(directory);
  const keys = createStoreKeyProvider(keyPaths);
  const cipher = createAesGcmCipher(keys);
  const backend = createSqliteBackend({ directory: keyPaths.directory, readOnly, keyProvider: keys, lockTimeoutMs, keyPaths });
  const integrity = createKeyAuthentication({ backend, cipher, keys });
  return createEncryptedAdapter({ backend, cipher, keys, integrity, kind: 'sqlite', durable: true });
}
