import { createHmac } from 'node:crypto';

export function canonicalRecord(value) {
  if (Array.isArray(value)) return value.map(canonicalRecord);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalRecord(value[key])]));
  }
  return value;
}

/** Bind a refresh operation to the complete grant observed before it began. */
export function refreshBaseId(grant, id) {
  return createHmac('sha256', id).update(JSON.stringify(canonicalRecord(grant))).digest('base64url');
}

export function grantIdentity({ version, issuer, clientId, resource, subject, obtainedAt, sessionInstanceId, authContext }) {
  return { version, issuer, clientId, resource, subject, obtainedAt, sessionInstanceId, ...(authContext ? { authContext } : {}) };
}
