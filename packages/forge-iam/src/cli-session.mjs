// Pure helpers for the `heluo-forge auth` CLI. They read the grant record the
// IAM service already wrote; they never refresh, never write, and never touch
// the network. Keeping the decision logic here (instead of inside the bin)
// makes the "no refresh" rule directly testable.

import { isDeepStrictEqual } from 'node:util';
import { grantIdentity, refreshBaseId } from './session-identity.mjs';
import { sessionView } from './session-read.mjs';
import { isAccessExpired, validateGrant } from './record.mjs';

/** The record key the IAM service uses for its session (see store.mjs). */
export const SESSION_RECORD_KEY = 'heluo-iam/session';

function inspectSessionRecord(record) {
  if (record == null) return { state: 'absent' };
  if (record.kind === 'grant' && record.payload?.version === 1
    && record.payload?.type === 'heluo-iam-session-tombstone'
    && Object.keys(record).length === 2 && Object.keys(record.payload).length === 2) return { state: 'absent' };
  if (record.kind !== 'grant') return { state: 'invalid' };
  const parsed = validateGrant(record.payload);
  if (!parsed.ok) return { state: 'invalid' };
  if (parsed.value.signOutOperation) return { state: 'pending', operation: 'sign-out' };
  if (parsed.value.refreshOperation?.state === 'pending') {
    return { state: 'pending', operation: 'refresh', grant: parsed.value };
  }
  return { state: 'active', grant: parsed.value };
}

/** Interpret the same validated grant format as the Host store. */
export function classifySessionRecord(record) {
  const session = inspectSessionRecord(record);
  if (session.state === 'pending') return { state: session.state, operation: session.operation };
  return session;
}

function canBridge(session) {
  if (session.state === 'active') return true;
  return session.state === 'pending' && session.operation === 'refresh'
    && (typeof session.grant.sessionInstanceId === 'string' || session.grant.version === 1);
}

/** A pending refresh can only be consumed through the Host, never offline. */
export function isBridgeReadableSession(record) {
  return canBridge(inspectSessionRecord(record));
}

function completesObservedRefresh(previous, current) {
  const pending = previous.refreshOperation;
  const complete = current.refreshOperation;
  return pending?.state === 'pending' && complete?.state === 'complete'
    && complete.version === pending.version && complete.id === pending.id && complete.base === pending.base
    && previous.refreshToken !== current.refreshToken;
}

/** Relate the pre-request session to the active session read after the Host responds. */
export function isSameBridgeSession(before, after) {
  const previous = inspectSessionRecord(before);
  const current = inspectSessionRecord(after);
  if (!canBridge(previous) || current.state !== 'active') return false;
  if (isDeepStrictEqual(before, after)) return true;

  const left = previous.grant;
  const right = current.grant;
  if (!isDeepStrictEqual(grantIdentity(left), grantIdentity(right))) return false;
  if (typeof left.sessionInstanceId === 'string') {
    return previous.state !== 'pending' || completesObservedRefresh(left, right);
  }

  // Legacy V1 has no session instance. Associate a changed record with the
  // observed refresh; this does not establish protection against ABA or writers
  // with the same storage permissions.
  if (left.version !== 1 || right.refreshOperation?.state !== 'complete'
    || left.refreshToken === right.refreshToken) return false;
  if (previous.state === 'pending') return completesObservedRefresh(left, right);
  return right.refreshOperation.base === refreshBaseId(left, right.refreshOperation.id);
}

/** Project a validated grant without returning tokens. */
export function sessionFromRecord(record, nowMs = Date.now()) {
  const session = classifySessionRecord(record);
  if (session.state === 'absent') return sessionView(undefined, 'signed-out');
  if (session.state !== 'active') return sessionView(undefined, 'error');
  return sessionView(session.grant, isAccessExpired(session.grant, nowMs) ? 'expired' : 'ready');
}

/** Return only a validated, unexpired access token; never refresh. */
export function accessTokenOf(record, nowMs = Date.now()) {
  const session = classifySessionRecord(record);
  if (session.state === 'absent') return { ok: false, code: 'IAM_NOT_SIGNED_IN' };
  if (session.state === 'invalid' || (session.state === 'pending' && session.operation === 'sign-out')) {
    return { ok: false, code: 'IAM_INVALID_GRANT' };
  }
  if (session.state !== 'active') return { ok: false, code: 'IAM_REAUTH_REQUIRED' };
  const payload = session.grant;
  if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
    return { ok: false, code: 'IAM_NOT_SIGNED_IN' };
  }
  const expires = Date.parse(payload.accessExpiresAt);
  if (Number.isNaN(expires) || expires - 30_000 <= nowMs) return { ok: false, code: 'IAM_REAUTH_REQUIRED' };
  return { ok: true, token: payload.accessToken, expiresAt: payload.accessExpiresAt };
}

/** Process exit codes the CLI documents, so scripts can branch on them. */
export const EXIT = Object.freeze({
  OK: 0,
  NOT_SIGNED_IN: 2,
  REAUTH_REQUIRED: 3,
  UNAVAILABLE: 4,
  USAGE: 64,
});
