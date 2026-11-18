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

/**
 * Session identity: the fields that never change while one session lives.
 *
 * `grantIdentity` also carries protocol-level fields (version, resource,
 * authContext). Those may legitimately differ between two observations of the
 * same session — the same reason `sameGrantIgnoringRefreshMarker` drops the
 * refresh marker before comparing grants. A display projection bound to a
 * session must therefore be matched on this quartet alone, so a grant that
 * changes shape never silently drops the projection.
 */
export function sameSessionIdentity(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  // Without a session instance there is nothing that tells two sessions apart.
  if (typeof left.sessionInstanceId !== 'string' || left.sessionInstanceId.length === 0) return false;
  if (typeof right.sessionInstanceId !== 'string' || right.sessionInstanceId.length === 0) return false;
  return left.issuer === right.issuer
    && left.clientId === right.clientId
    && left.subject === right.subject
    && left.sessionInstanceId === right.sessionInstanceId;
}
