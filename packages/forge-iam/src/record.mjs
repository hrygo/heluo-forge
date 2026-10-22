// IamGrantV1 is the non-secret shape stored in the credentials grant payload.
// It is validated before any write; version mismatch is always a re-login, never
// a best-effort field migration.

export const GRANT_VERSION = 1;

const REQUIRED_STRINGS = [
  'issuer',
  'subject',
  'clientId',
  'refreshToken',
  'scope',
  'resource',
  'obtainedAt',
];

const OPTIONAL_STRINGS = ['accessToken', 'accessExpiresAt', 'refreshExpiresAt', 'idToken'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isIsoDate(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: string[] }}
 */
export function validateGrant(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['grant must be an object'] };
  }

  const errors = [];
  if (input.version !== GRANT_VERSION) {
    errors.push(`grant.version must be ${GRANT_VERSION}`);
  }

  for (const key of REQUIRED_STRINGS) {
    if (!isNonEmptyString(input[key])) errors.push(`grant.${key} must be a non-empty string`);
  }

  for (const key of OPTIONAL_STRINGS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string' || raw.length === 0) {
      errors.push(`grant.${key} must be a non-empty string when present`);
    }
  }

  for (const key of ['obtainedAt', 'accessExpiresAt', 'refreshExpiresAt']) {
    const raw = input[key];
    if (raw !== undefined && raw !== null && !isIsoDate(raw)) {
      errors.push(`grant.${key} must be an ISO date when present`);
    }
  }

  const hasAccess = isNonEmptyString(input.accessToken);
  const hasAccessExpiry = isNonEmptyString(input.accessExpiresAt);
  if (hasAccess !== hasAccessExpiry) {
    errors.push('grant.accessToken and grant.accessExpiresAt must be provided together');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { ...input } };
}

/**
 * Parse a stored payload. Returns a validation error instead of throwing so
 * callers can clear a corrupt record and force re-login.
 *
 * @param {unknown} payload
 */
export function parseGrant(payload) {
  if (typeof payload === 'string') {
    try {
      return validateGrant(JSON.parse(payload));
    } catch {
      return { ok: false, errors: ['grant payload is not valid JSON'] };
    }
  }
  return validateGrant(payload);
}

export function isAccessExpired(grant, now = Date.now()) {
  if (!grant?.accessToken || !grant?.accessExpiresAt) return true;
  const expires = Date.parse(grant.accessExpiresAt);
  return Number.isNaN(expires) || expires <= now;
}

export function shouldRefresh(grant, now = Date.now(), skewSeconds = 60) {
  if (!grant?.accessToken || !grant?.accessExpiresAt) return true;
  const expires = Date.parse(grant.accessExpiresAt);
  if (Number.isNaN(expires)) return true;
  return expires - skewSeconds * 1000 <= now;
}

export function isRefreshUsable(grant, now = Date.now()) {
  if (!grant?.refreshToken) return false;
  if (!grant.refreshExpiresAt) return true;
  const expires = Date.parse(grant.refreshExpiresAt);
  return !Number.isNaN(expires) && expires > now;
}

/**
 * A diagnostics-safe summary; never includes tokens, verifier or ID token.
 */
export function summarizeGrant(grant) {
  return {
    signedIn: Boolean(grant?.refreshToken),
    principal: grant?.subject ?? null,
    issuer: grant?.issuer ?? null,
    accessExpiresAt: grant?.accessExpiresAt ?? null,
    refreshExpiresAt: grant?.refreshExpiresAt ?? null,
    scope: grant?.scope ?? null,
  };
}