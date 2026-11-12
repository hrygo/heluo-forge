import { isDeepStrictEqual } from 'node:util';
import { parseGrant, summarizeGrant } from './record.mjs';

export const SESSION_TOMBSTONE = Object.freeze({
  kind: 'grant', payload: Object.freeze({ version: 1, type: 'heluo-iam-session-tombstone' }),
});

export function isSessionTombstone(record) {
  return isDeepStrictEqual(record, SESSION_TOMBSTONE);
}

/** Interpret a stored session consistently for the Host and offline CLI. */
export function inspectSessionRecord(record) {
  if (record == null || isSessionTombstone(record)) return { state: 'absent' };
  if (record.kind !== 'grant') return { state: 'invalid', reason: 'wrong-kind', kind: record.kind };
  const parsed = parseGrant(record.payload);
  if (!parsed.ok) return { state: 'invalid', reason: 'invalid-grant', errors: parsed.errors };
  if (parsed.value.signOutOperation) return { state: 'pending', operation: 'sign-out' };
  if (parsed.value.refreshOperation?.state === 'pending') {
    return { state: 'pending', operation: 'refresh', grant: parsed.value };
  }
  return { state: 'active', grant: parsed.value };
}

/** Shared token-free session projection for Host and read-only adapters. */
export function sessionView(grant, status) {
  const summary = grant ? summarizeGrant(grant) : {};
  return {
    status,
    signedIn: summary.signedIn === true && Boolean(summary.principal),
    principal: summary.principal
      ? { issuer: summary.issuer ?? null, subject: summary.principal }
      : undefined,
    accessExpiresAt: summary.accessExpiresAt ?? null,
    scope: summary.scope ?? null,
  };
}
