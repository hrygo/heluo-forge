import { createHmac, timingSafeEqual } from 'node:crypto';

const error = (code, message) => Object.assign(new Error(message), { code });
const KID = /^[A-Za-z0-9._-]{1,255}$/;

function proof(keys, kid) {
  if (typeof kid !== 'string' || !KID.test(kid)) throw error('CRED_KEY_INVALID', 'invalid key identifier');
  const key = keys.byId(kid);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw error('CRED_KEY_UNAVAILABLE', 'credential key is unavailable');
  return createHmac('sha256', key).update('HeluoForge credential key binding v1\0').update(kid).digest('base64');
}

function serialize(entries) {
  return JSON.stringify({ v: 1, keys: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) });
}

function parse(value) {
  if (value === undefined) throw error('CRED_LEGACY_STORE', 'credential key binding is missing');
  let doc;
  try { doc = JSON.parse(value); } catch { throw error('CRED_DECRYPT_FAILED', 'credential authentication failed'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).sort().join(',') !== 'keys,v'
      || doc.v !== 1 || !doc.keys || typeof doc.keys !== 'object' || Array.isArray(doc.keys)) {
    throw error('CRED_DECRYPT_FAILED', 'credential authentication failed');
  }
  const entries = Object.create(null);
  for (const [kid, value] of Object.entries(doc.keys)) {
    if (!KID.test(kid) || typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)
        || Buffer.from(value, 'base64').toString('base64') !== value) {
      throw error('CRED_DECRYPT_FAILED', 'credential authentication failed');
    }
    entries[kid] = value;
  }
  return entries;
}

export function initialKeyBinding(keys, kid) {
  return serialize({ [kid]: proof(keys, kid) });
}

function checkProof(kid, expected, key) {
  const actual = createHmac('sha256', key).update('HeluoForge credential key binding v1\0').update(kid).digest();
  if (!timingSafeEqual(Buffer.from(expected, 'base64'), actual)) {
    throw error('CRED_DECRYPT_FAILED', 'credential authentication failed');
  }
}

/** Existing stores must already contain a binding for every referenced key. */
export function validateKeyBinding(value, active, used, keys, { requireAll = false } = {}) {
  const entries = parse(value);
  if (typeof active !== 'string' || !Object.hasOwn(entries, active)
      || used.some((kid) => !Object.hasOwn(entries, kid))) {
    throw error('CRED_DECRYPT_FAILED', 'credential key binding is incomplete');
  }
  for (const [kid, expected] of Object.entries(entries)) {
    const key = keys.byId(kid);
    if (key === undefined && kid !== active && !requireAll) continue;
    if (!Buffer.isBuffer(key) || key.length !== 32) throw error('CRED_KEY_UNAVAILABLE', 'credential key is unavailable');
    checkProof(kid, expected, key);
  }
  return entries;
}

/** Validate known keys without adopting or changing previously unbound stores. */
export function createKeyAuthentication({ backend, keys }) {
  function inspect() {
    validateKeyBinding(backend.keyAuth(), backend.active(), backend.keyIds(), keys, { requireAll: true });
  }
  return Object.freeze({
    verify: inspect,
    ensure: inspect,
    bind(kid) {
      const entries = parse(backend.keyAuth());
      entries[kid] = proof(keys, kid);
      backend.setKeyAuth(serialize(entries));
    },
  });
}
