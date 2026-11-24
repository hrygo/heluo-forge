/**
 * Closed error code vocabulary and HTTP status mapping for @heluo/forge-experts.
 * Shared pure constants only (P2 / P5): no runtime state or side effects.
 */

export const ERROR_STATUS = Object.freeze(Object.assign(Object.create(null), {
  EXPERT_MANAGEMENT_DISABLED: 503,
  // A disabled projection or dispatch entry is a closed entry, not a transient
  // dependency failure: 503 is reserved for an unavailable authorization source or storage (§3.5).
  EXPERT_MENTIONS_DISABLED: 404,
  EXPERT_DISPATCH_DISABLED: 404,
  EXPERT_UNAUTHENTICATED: 401,
  EXPERT_AUTH_INVALID: 401,
  EXPERT_AUTH_REVOKED: 401,
  EXPERT_CONNECTION_UNAVAILABLE: 503,
  EXPERT_HOST_UNAVAILABLE: 503,
  EXPERT_ORG_FORBIDDEN: 403,
  EXPERT_CALL_FORBIDDEN: 403,
  EXPERT_POLICY_DENIED: 403,
  EXPERT_REQUEST_HEADER_REQUIRED: 403,
  EXPERT_NOT_FOUND: 404,
  EXPERT_TASK_NOT_FOUND: 404,
  EXPERT_METHOD_NOT_ALLOWED: 405,
  EXPERT_SCOPE_MISMATCH: 409,
  EXPERT_SCOPE_UNVERIFIED: 409,
  EXPERT_SELECTION_INVALID: 409,
  EXPERT_POLICY_CONFIRMATION_REQUIRED: 409,
  EXPERT_CURSOR_STALE: 409,
  EXPERT_NOT_ACCEPTING: 409,
  EXPERT_IDEMPOTENCY_CONFLICT: 409,
  EXPERT_TASK_STATE_CONFLICT: 409,
  EXPERT_EDIT_TOKEN_INVALID: 409,
  EXPERT_EDIT_TOKEN_EXPIRED: 409,
  EXPERT_REVISION_CONFLICT: 409,
  EXPERT_REQUEST_INVALID: 422,
  EXPERT_REQUEST_TOO_LARGE: 413,
  EXPERT_RATE_LIMITED: 429,
  EXPERT_DIRECTORY_UNAVAILABLE: 503,
  EXPERT_STORAGE_UNAVAILABLE: 503,
  EXPERT_PREF_SAVE_UNKNOWN: 503,
  EXPERT_ISOLATION_UNVERIFIED: 503,
  EXPERT_ACCEPTANCE_UNKNOWN: 503,
  EXPERT_INTERNAL_ERROR: 500,
}));

export class ExpertsError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {{ status?: number, retryable?: boolean, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message = code, options = {}) {
    super(message);
    this.name = 'ExpertsError';
    this.code = Object.hasOwn(ERROR_STATUS, code) ? code : 'EXPERT_INTERNAL_ERROR';
    this.status = typeof options.status === 'number' ? options.status : (ERROR_STATUS[this.code] ?? 500);
    this.retryable = Boolean(options.retryable);
    this.details = options.details ?? undefined;
  }
}

const SAFE_DETAIL_KEYS = new Set(['requestId', 'requestTraceId', 'confirmationScope']);

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const out = {};
  let hasAny = false;
  for (const key of SAFE_DETAIL_KEYS) {
    if (typeof details[key] === 'string' && details[key].trim().length > 0) {
      out[key] = details[key].trim();
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

export function serializeError(error) {
  const known = error instanceof ExpertsError && Object.hasOwn(ERROR_STATUS, error.code);
  const code = known ? error.code : 'EXPERT_INTERNAL_ERROR';
  const status = known ? error.status : 500;
  const details = known ? sanitizeDetails(error.details) : undefined;
  return {
    status,
    body: {
      error: {
        code,
        message: known ? error.message : 'Expert service operation failed',
        retryable: known ? error.retryable : false,
        ...(details ? { details } : {}),
      },
    },
  };
}
