import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { IamError } from './errors.mjs';
import { OidcError } from './oidc.mjs';
import { StoreError } from './store.mjs';

export const SAFE_MESSAGES = Object.freeze({
  IAM_UNCONFIGURED: 'IAM configuration is incomplete',
  IAM_CLIENT_AUTH_CONTEXT_INVALID: 'IAM client authentication context is invalid',
  IAM_CLIENT_AUTH_UNVERIFIED: 'IAM client authentication is not verified',
  IAM_CLIENT_AUTH_CHANGED: 'IAM client authentication changed',
  IAM_CREDENTIALS_UNAVAILABLE: 'credential storage is unavailable',
  IAM_ATOMIC_STORE_UNVERIFIED: 'credential storage atomicity is not trusted by this composition',
  IAM_GATEWAY_ATOMIC_UNVERIFIED: 'joint gateway credential storage is not trusted by this composition',
  IAM_GATEWAY_LEGACY_READ_ONLY: 'existing gateway credential data is read-only and was not changed',
  IAM_GATEWAY_CHANGED: 'gateway credential changed before this operation could commit',
  IAM_GATEWAY_WRITE_UNKNOWN: 'gateway credential write outcome is unknown; no automatic retry was attempted',
  IAM_CREDENTIALS_CLEAR_FAILED: 'credential storage could not be cleared',
  IAM_CALLBACK_UNAVAILABLE: 'IAM callback origin is unavailable',
  IAM_CALLBACK_PORT_UNAVAILABLE: 'the registered IAM callback port is not available',
  IAM_CALLBACK_BIND_FAILED: 'the IAM callback listener could not start',
  IAM_UNREACHABLE: 'IAM endpoint is unreachable',
  IAM_INVALID_GRANT: 'IAM authorization is no longer valid',
  IAM_REAUTH_REQUIRED: 'IAM sign-in is required again',
  IAM_STATE_MISMATCH: 'IAM callback state does not match this attempt',
  IAM_ATTEMPT_EXPIRED: 'IAM sign-in attempt expired',
  IAM_ID_TOKEN_INVALID: 'IAM ID token is invalid',
  IAM_ID_TOKEN_SIGNATURE: 'IAM ID token signature is invalid',
  IAM_ID_TOKEN_AUDIENCE: 'IAM ID token audience does not match',
  IAM_ID_TOKEN_ISSUER: 'IAM ID token issuer does not match',
  IAM_DISCOVERY_ISSUER_MISMATCH: 'IAM discovery issuer does not match configuration',
  IAM_GRANT_CONTEXT_MISMATCH: 'IAM grant issuer context is unverified or does not match the configured issuer, client or resource',
  IAM_REVOCATION_FAILED: 'IAM local session ended but token revocation was rejected',
  IAM_REVOCATION_UNKNOWN: 'IAM local session ended but token revocation is unconfirmed',
  IAM_ID_TOKEN_NONCE: 'IAM ID token nonce does not match',
  IAM_ID_TOKEN_EXPIRED: 'IAM ID token is expired',
  IAM_REFRESH_TOKEN_MISSING: 'IAM token response has no refresh token',
  IAM_REFRESH_SUBJECT_MISMATCH: 'IAM refresh response changed the subject',
});

export function canonicalRecord(value) {
  if (Array.isArray(value)) return value.map(canonicalRecord);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalRecord(value[key])]));
  }
  return value;
}

export function refreshBaseId(grant, id) {
  return createHmac('sha256', id).update(JSON.stringify(canonicalRecord(grant))).digest('base64url');
}

export function sameGrantIgnoringRefreshMarker(left, right) {
  const { refreshOperation: ignoredLeft, ...leftBase } = left;
  const { refreshOperation: ignoredRight, ...rightBase } = right;
  return isDeepStrictEqual(leftBase, rightBase);
}

export function grantIdentity({ version, issuer, clientId, resource, subject, obtainedAt, sessionInstanceId, authContext }) {
  return { version, issuer, clientId, resource, subject, obtainedAt, sessionInstanceId, ...(authContext ? { authContext } : {}) };
}

export function nowIso(now) {
  return new Date(now).toISOString();
}

// ID tokens are minted by another clock; both the verification path and the
// callback path must tolerate the same skew.
export const ID_TOKEN_CLOCK_SKEW_SECONDS = 60;

// One refresh may take this long before it must be treated as unknown; the same
// bound applies where a pending marker's deadline is computed and where a
// revoke call is capped.
export const REFRESH_TIMEOUT_MS = 5000;

// A background refresh that just ran must not be retried by the next sync.
export const AUTO_REFRESH_BACKOFF_MS = 30000;

export function addSeconds(now, seconds) {
  return new Date(now + seconds * 1000).toISOString();
}

export function tokenErrorMessage(error) {
  if (error instanceof OidcError) {
    if (error.code === 'IAM_HTTP_ERROR' && error.details?.oauthError === 'invalid_grant') {
      return 'IAM_INVALID_GRANT';
    }
    return error.code;
  }
  if (error instanceof IamError) return error.code;
  if (error instanceof StoreError) return error.code;
  return 'IAM_INTERNAL';
}

export function safeMessage(code) {
  return SAFE_MESSAGES[code] ?? 'IAM operation failed';
}
