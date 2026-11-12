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
  if (value === undefined) return Object.create(null);
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

/** Validate known keys and authenticate every row for any previously unbound key. */
export function createKeyAuthentication({ backend, cipher, keys }) {
  function inspect() {
    const entries = parse(backend.keyAuth());
    for (const [kid, expected] of Object.entries(entries)) {
      const actual = proof(keys, kid);
      if (!timingSafeEqual(Buffer.from(expected, 'base64'), Buffer.from(actual, 'base64'))) {
        throw error('CRED_DECRYPT_FAILED', 'credential authentication failed');
      }
    }
    const used = backend.keyIds();
    const unbound = new Set(used.filter((kid) => !Object.hasOwn(entries, kid)));
    if (unbound.size) {
      for (const row of backend.list()) {
        if (!unbound.has(row.kid)) continue;
        const value = cipher.open({ kind: row.kind, id: row.id, owner: row.owner, kid: row.kid, envelope: row.envelope });
        if (!Buffer.from(value.toString('utf8'), 'utf8').equals(value)) throw error('CRED_DECRYPT_FAILED', 'credential decryption failed');
      }
      for (const kid of unbound) entries[kid] = proof(keys, kid);
    }
    const active = backend.active();
    if (!Object.hasOwn(entries, active)) entries[active] = proof(keys, active);
    return serialize(entries);
  }
  return Object.freeze({
    verify: inspect,
    ensure() {
      const binding = inspect();
      if (backend.keyAuth() !== binding) backend.setKeyAuth(binding);
    },
    bind(kid) {
      const entries = parse(backend.keyAuth());
      entries[kid] = proof(keys, kid);
      backend.setKeyAuth(serialize(entries));
    },
  });
}
