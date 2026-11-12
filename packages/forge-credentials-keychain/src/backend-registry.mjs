import { createCredentialStore } from './credential-store.mjs';

// Registration is static and only includes implementations covered by the
// SQLite atomicity and cross-process tests. No capability is read from a backend.
const SQLITE_CAPABILITIES = Object.freeze({ crossProcessLock: true, jointAtomic: true });

function requireSqlite(name) {
  if (name !== 'sqlite') {
    throw Object.assign(new Error('credential backend is not registered'), { code: 'CRED_BACKEND_UNREGISTERED' });
  }
}

export function capabilities(name) {
  requireSqlite(name);
  return SQLITE_CAPABILITIES;
}

export function createRegisteredBackend(name, options) {
  requireSqlite(name);
  return createCredentialStore(options);
}
