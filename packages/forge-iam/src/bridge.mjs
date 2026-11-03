// Loopback bridge for local CLIs.
//
// DSH's management routes are guarded by Connection's browser authentication,
// which a CLI process cannot present. The IAM service therefore offers one
// additional, narrowly scoped route: a POST that requires a capability read
// from the same credential store the CLI already reads, and only from a
// loopback peer. The capability proves "this caller can already read the store";
// it is not a second authorization model.

import { timingSafeEqual } from 'node:crypto';

/** Credential ref holding the bridge capability. */
export const BRIDGE_REF = 'HELUO_IAM_BRIDGE_TOKEN';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address) {
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address);
}

export function bearerMatches(header, secret) {
  if (typeof header !== 'string' || typeof secret !== 'string' || secret.length === 0) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  // A length difference is not a secret-dependent branch worth hiding here:
  // the caller already knows the shape of a capability it may hold.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * @param {{ socketAddress?: string, authorization?: string }} request
 * @param {string | undefined} secret
 * @returns {401 | 403 | 503 | undefined} rejection status, or undefined to admit
 */
export function bridgeRejection(request, secret) {
  if (!isLoopbackAddress(request?.socketAddress)) return 403;
  if (typeof secret !== 'string' || secret.length === 0) return 503;
  if (!bearerMatches(request?.authorization, secret)) return 401;
  return undefined;
}
