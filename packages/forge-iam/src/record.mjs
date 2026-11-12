// Session payloads contain user tokens, never the client secret. V1 is public;
// V2 is confidential. Parsing either format does not authorize its adoption.
export const GRANT_VERSION = 1;
export const CONFIDENTIAL_GRANT_VERSION = 2;
const AUTH_MARKERS = ['authContext', 'clientAuth', 'authMode', 'clientAuthMethod',
  'clientSecretRef', 'clientSecret', 'client_secret', 'secretRef', 'secretRevision', 'Authorization', 'authorization'];

const REQUIRED_STRINGS = [
  'issuer',
  'subject',
  'clientId',
  'refreshToken',
  'scope',
  'obtainedAt',
];

// `resource` is optional from V1 on: the gateway uses a UAG personal credential
// instead of an IAM audience. Older grants keep their value; it is compared only
// when configuration still asks for one.
const OPTIONAL_STRINGS = ['accessToken', 'accessExpiresAt', 'refreshExpiresAt', 'idToken', 'resource'];

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
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: ['grant must be an object'] };
    }
    // Read each own field once. Validation and output use the same private data,
    // including presence-only markers and V1's unknown extensions.
    const snapshot = Object.fromEntries(Reflect.ownKeys(input).map((key) => [key, input[key]]));
    for (const field of ['refreshOperation', 'signOutOperation']) {
      const marker = snapshot[field];
      if (marker && typeof marker === 'object' && !Array.isArray(marker)) {
        snapshot[field] = Object.freeze(Object.fromEntries(Reflect.ownKeys(marker).map((key) => [key, marker[key]])));
      }
    }
    return validateGrantFields(snapshot);
  } catch { return { ok: false, errors: ['grant fields are invalid'] }; }
}

function validateGrantFields(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['grant must be an object'] };
  }

  const errors = [];
  let authContext;
  if (input.version !== GRANT_VERSION && input.version !== CONFIDENTIAL_GRANT_VERSION) {
    errors.push('grant.version must be 1 or 2');
  } else if (input.version === GRANT_VERSION) {
    if (AUTH_MARKERS.some((key) => Object.hasOwn(input, key))) errors.push('grant V1 must not contain authentication markers');
  } else {
    const allowed = ['version', ...REQUIRED_STRINGS, ...OPTIONAL_STRINGS, 'sessionInstanceId', 'refreshOperation', 'signOutOperation', 'authContext'];
    if (Reflect.ownKeys(input).some((key) => !allowed.includes(key))) errors.push('grant V2 contains unsupported fields');
    const context = input.authContext;
    const fields = ['mode', 'method', 'secretRef', 'secretRevision'];
    if (!context || typeof context !== 'object' || Array.isArray(context)
      || Reflect.ownKeys(context).length !== fields.length || fields.some((key) => !Object.hasOwn(context, key))) {
      errors.push('grant.version 2 requires a complete authContext');
    } else {
      const copy = Object.fromEntries(fields.map((key) => [key, context[key]]));
      if (copy.mode !== 'confidential' || !['client_secret_basic', 'client_secret_post'].includes(copy.method)
        || !isNonEmptyString(copy.secretRef) || !isNonEmptyString(copy.secretRevision)) {
        errors.push('grant.version 2 authContext is invalid');
      } else authContext = Object.freeze(copy);
    }
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

  if (Object.hasOwn(input, 'sessionInstanceId')
    && (typeof input.sessionInstanceId !== 'string'
      || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(input.sessionInstanceId))) {
    errors.push('grant.sessionInstanceId is invalid');
  }

  if (Object.hasOwn(input, 'refreshOperation')) {
    const operation = input.refreshOperation;
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)
      || Object.keys(operation).sort().join(',') !== 'base,id,state,version'
      || operation.version !== 1 || !['pending', 'complete'].includes(operation.state)
      || typeof operation.id !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(operation.id)
      || typeof operation.base !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(operation.base)) {
      errors.push('grant.refreshOperation is invalid');
    }
  }

  if (Object.hasOwn(input, 'signOutOperation')) {
    const operation = input.signOutOperation;
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)
      || Reflect.ownKeys(operation).sort().join(',') !== 'id,state,version'
      || operation.version !== 1 || operation.state !== 'pending'
      || typeof operation.id !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(operation.id)
      || input.refreshOperation?.state === 'pending') {
      errors.push('grant.signOutOperation is invalid');
    }
  }

  const hasAccess = isNonEmptyString(input.accessToken);
  const hasAccessExpiry = isNonEmptyString(input.accessExpiresAt);
  if (hasAccess !== hasAccessExpiry) {
    errors.push('grant.accessToken and grant.accessExpiresAt must be provided together');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { ...input, ...(authContext ? { authContext } : {}) } };
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

/** The earlier known usable deadline is the last chance to renew the session. */
export function renewalDeadline(grant, now = Date.now()) {
  const access = Date.parse(grant?.accessExpiresAt);
  const refresh = Date.parse(grant?.refreshExpiresAt);
  return Number.isFinite(refresh) && refresh > now ? Math.min(access, refresh) : access;
}

export function shouldRefresh(grant, now = Date.now(), skewSeconds = 60) {
  if (!grant?.accessToken || !grant?.accessExpiresAt) return true;
  const deadline = renewalDeadline(grant, now);
  if (!Number.isFinite(deadline)) return true;
  return deadline - skewSeconds * 1000 <= now;
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
