import { createCredentialStore } from './credential-store.mjs';

// Add only implementations whose claimed capabilities are independently
// covered by contract and cross-process tests. Never trust backend self-reports.
const DEFAULT_BACKEND = 'sqlite';
const BACKENDS = Object.freeze({
  sqlite: Object.freeze({
    create: createCredentialStore,
    capabilities: Object.freeze({ crossProcessLock: true, jointAtomic: true }),
  }),
});

function registration(name) {
  if (typeof name !== 'string' || !Object.hasOwn(BACKENDS, name)) {
    throw Object.assign(new Error('credential backend is not registered'), { code: 'CRED_BACKEND_UNREGISTERED' });
  }
  return BACKENDS[name];
}

export function capabilities(name) {
  return registration(name).capabilities;
}

export function createRegisteredBackend(name, options) {
  return registration(name).create(options);
}

// Bind trust metadata to the same registration that constructs the instance.
// This selection is static; injected backends never pass through this function.
export function createDefaultBackend(options) {
  const selected = registration(DEFAULT_BACKEND);
  return Object.freeze({ backend: selected.create(options), capabilities: selected.capabilities });
}
