/**
 * Failure classification for enterprise model calls.
 *
 * A gateway swap or an SDK upgrade changes the vocabulary of failures, so this
 * module never trusts a single source. It walks the evidence in order — the
 * layer's own code, the response body, the HTTP status, the socket error — and
 * only claims unreachability when the evidence says so.
 *
 * The tables are data: supporting a new gateway means adding a mapping line,
 * not changing the flow.
 */

// Codes the plugin itself emits; they are already the contract.
export const SELF_CODES = new Set([
  'ENTERPRISE_IAM_UNAVAILABLE',
  'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  'ENTERPRISE_GATEWAY_FORBIDDEN',
  'ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED',
  'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED',
  'ENTERPRISE_GATEWAY_CREDENTIAL_SUSPENDED',
  'ENTERPRISE_GATEWAY_IDENTITY_MISMATCH',
  'ENTERPRISE_GATEWAY_CLIENT_NOT_RECOGNIZED',
  'ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED',
  'ENTERPRISE_MODEL_NOT_ALLOWED',
  'ENTERPRISE_GATEWAY_RATE_LIMIT',
  'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  'ENTERPRISE_GATEWAY_UNAVAILABLE',
  'ENTERPRISE_GATEWAY_REQUEST_REJECTED',
  'ENTERPRISE_GATEWAY_CALL_FAILED',
  'ENTERPRISE_MODEL_REASONING_UNSUPPORTED',
]);

/** Map an upstream HTTP status so a rejected request never reads as "cannot connect". */
export const gatewayCode = status => status === 401 ? 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED'
  : status === 403 ? 'ENTERPRISE_GATEWAY_FORBIDDEN'
    : status === 429 ? 'ENTERPRISE_GATEWAY_RATE_LIMIT'
      : typeof status === 'number' && status >= 400 && status < 500 ? 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'
        : 'ENTERPRISE_GATEWAY_UNAVAILABLE';
// Model SDKs disagree on where the HTTP status lives: a plain `status` here, an
// AI SDK `statusCode` there, wrapped one level deeper when the transport retries.
// Reading only `status` reported a 429 quota rejection as "cannot connect".
const STATUS_KEYS = ['status', 'statusCode', 'response.status', 'cause.status', 'cause.statusCode'];
export const statusOf = (cause) => {
  for (const key of STATUS_KEYS) {
    const value = key.split('.').reduce((cursor, name) => (cursor == null ? undefined : cursor[name]), cause);
    if (typeof value === 'number') return value;
  }
  return undefined;
};
// Classification is evidence-first: a gateway or SDK swap can introduce codes no
// table knows, so every layer below may answer, and only real evidence may claim
// unreachability.
// 1. codes the model layer emits (camelCase or snake_case, squashed for lookup)
export const LAYER_CODES = Object.freeze({
  auth: 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  authenticationerror: 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  permission: 'ENTERPRISE_GATEWAY_FORBIDDEN',
  permissionerror: 'ENTERPRISE_GATEWAY_FORBIDDEN',
  forbidden: 'ENTERPRISE_GATEWAY_FORBIDDEN',
  quota: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  ratelimit: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
  ratelimiterror: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
  invalidrequest: 'ENTERPRISE_GATEWAY_REQUEST_REJECTED',
  unsupportedreasoningeffort: 'ENTERPRISE_MODEL_REASONING_UNSUPPORTED',
  network: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  networkerror: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  timeout: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  overloaded: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  servererror: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  apierror: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  serviceunavailable: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
});
// 2. vocabularies found in gateway error bodies: OpenAI `error.code`/`error.type`,
//    RFC 9457 `type` (last URI segment), LiteLLM router cooldowns.
export const BODY_CODES = Object.freeze({
  invalidapikey: 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  invalidapikeyerror: 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  invalidiamtoken: 'ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED',
  credentialrevoked: 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED',
  credentialsuspended: 'ENTERPRISE_GATEWAY_CREDENTIAL_SUSPENDED',
  iamtokenmismatch: 'ENTERPRISE_GATEWAY_IDENTITY_MISMATCH',
  modelnotallowed: 'ENTERPRISE_MODEL_NOT_ALLOWED',
  budgetexhausted: 'ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED',
  budgetexceeded: 'ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED',
  rpmlimitexceeded: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
  tpmlimitexceeded: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
  clientnotrecognized: 'ENTERPRISE_GATEWAY_CLIENT_NOT_RECOGNIZED',
  gatewayoverloaded: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  authenticationerror: 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  unauthorized: 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  permissionerror: 'ENTERPRISE_GATEWAY_FORBIDDEN',
  forbidden: 'ENTERPRISE_GATEWAY_FORBIDDEN',
  insufficientquota: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  quotaexceeded: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  billinghardlimitreached: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  organizationusagelimitexceeded: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  organizationspendlimitexceeded: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  freeusagelimiterror: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  modelcooldown: 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED',
  ratelimitexceeded: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
  ratelimiterror: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
  toomanyrequests: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
  contextlengthexceeded: 'ENTERPRISE_GATEWAY_REQUEST_REJECTED',
  invalidrequesterror: 'ENTERPRISE_GATEWAY_REQUEST_REJECTED',
  invalidrequest: 'ENTERPRISE_GATEWAY_REQUEST_REJECTED',
  badrequest: 'ENTERPRISE_GATEWAY_REQUEST_REJECTED',
  apierror: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  servererror: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  overloaded: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  serviceunavailable: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
});
export const squash = (value) => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
// 3. only a socket-level failure justifies claiming the gateway cannot be reached.
export const UNREACHABLE_SYSCALLS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const parseBody = (text) => {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8192) return undefined;
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  const attempt = (slice) => { try { return JSON.parse(slice); } catch { return undefined; } };
  return attempt(text.slice(start)) ?? attempt(text.slice(start, text.lastIndexOf('}') + 1));
};
const embeddedBody = (failure) => {
  const direct = failure?.responseBody ?? failure?.data ?? failure?.body ?? failure?.cause?.responseBody;
  if (direct && typeof direct === 'object') return direct;
  if (typeof direct === 'string') return parseBody(direct);
  // The model layer sometimes prefixes the body: `429: {"error":{...}}`.
  return parseBody(typeof failure?.message === 'string' ? failure.message : '');
};
const bodyTokens = (failure) => {
  const body = embeddedBody(failure);
  if (!body || typeof body !== 'object') return [];
  const inner = body.error && typeof body.error === 'object' ? body.error : {};
  return [inner.code, inner.type, body.code, body.type, body.status, body.error]
    .filter(value => typeof value === 'string');
};
/**
 * Internal IAM and credential-storage codes answer "what should the person do?".
 * They are emitted while resolving the key, before any request leaves, so each
 * one must reach a registered user code instead of the unknown-failure bucket.
 *
 * The table is a compatibility surface: gateway-failure.test.mjs walks every
 * IAM_/CRED_ code registered in ERROR_STATUS and fails when one is missing.
 */
export const USER_CODE_BY_INTERNAL = Object.freeze({
  // The authentication service itself is out of reach: retry later.
  IAM_UNREACHABLE: 'ENTERPRISE_IAM_UNAVAILABLE',
  IAM_HTTP_ERROR: 'ENTERPRISE_IAM_UNAVAILABLE',
  // Keyring, encrypted record or client-secret storage cannot be used.
  CRED_KEY_UNAVAILABLE: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  CRED_DECRYPT_FAILED: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  IAM_CREDENTIALS_UNAVAILABLE: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  IAM_ATOMIC_STORE_UNVERIFIED: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  IAM_CREDENTIALS_CLEAR_FAILED: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  IAM_CLIENT_AUTH_UNVERIFIED: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  IAM_GATEWAY_ATOMIC_UNVERIFIED: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  IAM_GATEWAY_LEGACY_READ_ONLY: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  IAM_GATEWAY_WRITE_UNKNOWN: 'ENTERPRISE_CREDENTIAL_STORAGE_UNAVAILABLE',
  // The session is gone or cannot be proven current: sign in again.
  IAM_NOT_SIGNED_IN: 'IAM_LOGIN_REQUIRED',
  IAM_REAUTH_REQUIRED: 'IAM_LOGIN_REQUIRED',
  IAM_LOGIN_REQUIRED: 'IAM_LOGIN_REQUIRED',
  IAM_INVALID_GRANT: 'IAM_LOGIN_REQUIRED',
  IAM_REFRESH_SUBJECT_MISMATCH: 'IAM_LOGIN_REQUIRED',
  IAM_GRANT_CONTEXT_MISMATCH: 'IAM_LOGIN_REQUIRED',
  IAM_STATE_MISMATCH: 'IAM_LOGIN_REQUIRED',
  IAM_ATTEMPT_EXPIRED: 'IAM_LOGIN_REQUIRED',
  IAM_ATTEMPT_IN_PROGRESS: 'IAM_LOGIN_REQUIRED',
  IAM_ATTEMPT_CANCELLED: 'IAM_LOGIN_REQUIRED',
  IAM_AUTHORIZATION_ERROR: 'IAM_LOGIN_REQUIRED',
  IAM_CALLBACK_INVALID: 'IAM_LOGIN_REQUIRED',
  IAM_CALLBACK_ISSUER: 'IAM_LOGIN_REQUIRED',
  IAM_CALLBACK_UNAVAILABLE: 'IAM_LOGIN_REQUIRED',
  IAM_CALLBACK_PORT_UNAVAILABLE: 'IAM_LOGIN_REQUIRED',
  IAM_CALLBACK_BIND_FAILED: 'IAM_LOGIN_REQUIRED',
  IAM_CLIENT_AUTH_CHANGED: 'IAM_LOGIN_REQUIRED',
  IAM_CLIENT_AUTH_CONTEXT_INVALID: 'IAM_LOGIN_REQUIRED',
  // The stored gateway credential or its address needs a person to fix it.
  IAM_GATEWAY_CREDENTIAL_REQUIRED: 'IAM_GATEWAY_CREDENTIAL_REQUIRED',
  IAM_GATEWAY_KEY_INVALID: 'IAM_GATEWAY_CREDENTIAL_REQUIRED',
  IAM_GATEWAY_OWNER_MISSING: 'IAM_GATEWAY_CREDENTIAL_REQUIRED',
  IAM_GATEWAY_URL_INVALID: 'IAM_GATEWAY_URL_INVALID',
  // The live context no longer matches what the call was prepared for.
  IAM_MODEL_CONTEXT_CHANGED: 'IAM_MODEL_CONTEXT_CHANGED',
  IAM_GATEWAY_BINDING_CHANGED: 'IAM_MODEL_CONTEXT_CHANGED',
  IAM_GATEWAY_CHANGED: 'IAM_MODEL_CONTEXT_CHANGED',
  // The enterprise model layer needs an administrator.
  IAM_INTERNAL: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_BRIDGE_UNAUTHORIZED: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_BRIDGE_FORBIDDEN: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_NOT_IMPLEMENTED: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_UNCONFIGURED: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_EXCLUSIVE_CONFLICT: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_INVALID_TRANSITION: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_CONFIG_INVALID: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_DISPOSED: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_RECORD_KIND_MISMATCH: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_MODEL_SELECTION_INVALID: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_MODEL_SELECTION_UNWRITTEN: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_REQUEST_INVALID: 'ENTERPRISE_MODELS_UNAVAILABLE',
  IAM_REQUEST_TOO_LARGE: 'ENTERPRISE_MODELS_UNAVAILABLE',
});

/**
 * Codes a person can act on. Every internal IAM/CRED failure resolves to one of
 * these before it reaches the failure object, so the interface never shows a
 * code that only names an internal module.
 */
export const USER_FACING_CODES = new Set([
  ...SELF_CODES,
  ...Object.values(USER_CODE_BY_INTERNAL),
  // Model-layer codes that never travel through the key resolver but share the
  // same failure surface.
  'ENTERPRISE_MODELS_UNAVAILABLE',
  'ENTERPRISE_MODEL_CATALOG_INVALID',
  'ENTERPRISE_MODEL_SYNC_CANCELLED',
]);

/**
 * One entry point for the failure object: internal IAM/CRED codes take their
 * registered user code, everything the gateway layer emits keeps the existing
 * evidence-first classification.
 */
export const failureCode = (failure) => {
  const raw = typeof failure?.code === 'string' ? failure.code : undefined;
  if (raw && Object.hasOwn(USER_CODE_BY_INTERNAL, raw)) return USER_CODE_BY_INTERNAL[raw];
  return classifyFailure(failure);
};

export const classifyFailure = (failure) => {
  const raw = typeof failure?.code === 'string' ? failure.code : undefined;
  if (raw && SELF_CODES.has(raw)) return raw;
  const layer = LAYER_CODES[squash(raw)];
  if (layer) return layer;
  for (const token of bodyTokens(failure)) {
    const key = squash(token);
    const tail = squash(token.split('/').pop());
    if (Object.hasOwn(BODY_CODES, key)) return BODY_CODES[key];
    if (Object.hasOwn(BODY_CODES, tail)) return BODY_CODES[tail];
  }
  const status = statusOf(failure);
  if (status !== undefined) return gatewayCode(status);
  const syscall = failure?.cause?.code ?? failure?.errno;
  if (typeof syscall === 'string' && UNREACHABLE_SYSCALLS.has(syscall)) return 'ENTERPRISE_GATEWAY_UNAVAILABLE';
  return 'ENTERPRISE_GATEWAY_CALL_FAILED';
};
