// Pure helpers for the `heluo-forge auth` CLI. They read the grant record the
// IAM service already wrote; they never refresh, never write, and never touch
// the network. Keeping the decision logic here (instead of inside the bin)
// makes the "no refresh" rule directly testable.

/** The record key the IAM service uses for its session (see store.mjs). */
export const SESSION_RECORD_KEY = 'heluo-iam/session';

/**
 * Project a stored grant payload onto the same shape `ctx.iam.getSession()`
 * returns. Tokens are dropped here and only surfaced by `accessTokenOf()`.
 *
 * @param {{ kind?: string, payload?: object } | undefined} record
 * @returns {{ status: string, signedIn: boolean, principal?: { issuer: string | null, subject: string }, accessExpiresAt: string | null, scope: string | null }}
 */
export function sessionFromRecord(record) {
  const grant = record?.kind === 'grant' ? record.payload ?? {} : {};
  const subject = typeof grant.subject === 'string' && grant.subject.length > 0 ? grant.subject : undefined;
  return {
    // The CLI is a read-only observer: it can report identity, not live state.
    status: subject ? 'ready' : 'signed-out',
    signedIn: Boolean(subject && typeof grant.refreshToken === 'string'),
    principal: subject ? { issuer: grant.issuer ?? null, subject } : undefined,
    accessExpiresAt: grant.accessExpiresAt ?? null,
    scope: grant.scope ?? null,
  };
}

/**
 * Return the stored access token only while it is unexpired. The CLI must not
 * refresh: the IAM service owns the refresh token, and a second refresher would
 * invalidate the running session under the confirmed rotation rule.
 *
 * @param {{ payload?: { accessToken?: string, accessExpiresAt?: string } } | undefined} record
 * @param {number} nowMs
 * @returns {{ ok: true, token: string, expiresAt: string | null } | { ok: false, code: 'IAM_NOT_SIGNED_IN' | 'IAM_REAUTH_REQUIRED' | 'IAM_EXPIRY_UNKNOWN' }}
 */
export function accessTokenOf(record, nowMs = Date.now()) {
  const payload = record?.kind === 'grant' ? record.payload ?? {} : {};
  if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) {
    return { ok: false, code: 'IAM_NOT_SIGNED_IN' };
  }
  if (typeof payload.accessExpiresAt !== 'string') {
    // An unknown expiry cannot be proven valid; refuse instead of guessing.
    return { ok: false, code: 'IAM_EXPIRY_UNKNOWN' };
  }
  const expires = Date.parse(payload.accessExpiresAt);
  if (Number.isNaN(expires) || expires <= nowMs) {
    return { ok: false, code: 'IAM_REAUTH_REQUIRED' };
  }
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
