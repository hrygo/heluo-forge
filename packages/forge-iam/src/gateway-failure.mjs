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
  'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
  'ENTERPRISE_GATEWAY_FORBIDDEN',
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
