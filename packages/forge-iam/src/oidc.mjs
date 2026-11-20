import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { assertClientAuthEndpoint, buildClientAuthRequest, withCurrentClientAuth } from './client-auth.mjs';
import { IamError } from './errors.mjs';
import { parseHttpUrl } from './http-url.mjs';

export const OAUTH_ERROR_CODES = Object.freeze([
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'unsupported_token_type',
  'access_denied', 'unsupported_response_type', 'server_error', 'temporarily_unavailable',
]);
export const OAUTH_ERROR_RESPONSE_CLASSES = Object.freeze(['empty', 'nonstandard', 'unreadable']);

export class OidcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
    this.details = details;
  }
}

export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function createPkce(verifier = randomToken(32)) {
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

export function parseCallbackUrl(raw) {
  let url;
  try {
    url = new URL(raw, 'http://127.0.0.1');
  } catch {
    throw new OidcError('IAM_CALLBACK_INVALID', 'callback URL is not valid');
  }
  const states = url.searchParams.getAll('state');
  const codes = url.searchParams.getAll('code');
  const errors = url.searchParams.getAll('error');
  const issuers = url.searchParams.getAll('iss');
  if (states.length !== 1 || !states[0] || issuers.length > 1 || (issuers.length === 1 && !issuers[0])
      || codes.length > 1 || errors.length > 1 || codes.length + errors.length !== 1
      || (codes.length === 1 && !codes[0]) || (errors.length === 1 && !errors[0])) {
    throw new OidcError('IAM_CALLBACK_INVALID', 'callback must carry exactly one code or error and one state');
  }
  if (errors.length === 1) {
    throw new OidcError('IAM_AUTHORIZATION_ERROR', 'authorization endpoint returned an error');
  }
  return { code: codes[0], state: states[0], ...(issuers.length === 1 ? { iss: issuers[0] } : {}) };
}

export function decodeJwt(token) {
  if (typeof token !== 'string') throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token is missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token must have three segments');
  // Buffer's base64url decoder is permissive; enforce canonical JWS encoding
  // before decoding, including zero pad bits and no '=' or other characters.
  if (parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)
      || Buffer.from(part, 'base64url').toString('base64url') !== part)) {
    throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token has an invalid JWS encoding');
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { header, payload, signature: Buffer.from(parts[2], 'base64url'), input: `${parts[0]}.${parts[1]}` };
  } catch {
    throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token is not valid JSON');
  }
}

function audienceIncludes(audience, clientId) {
  if (typeof audience === 'string') return audience === clientId;
  return Array.isArray(audience) && audience.length > 0
    && audience.every((value) => typeof value === 'string' && value.length > 0)
    && audience.includes(clientId);
}

/**
 * Verify an RS256/PS256/ES256 ID token against a JWKS document and the OIDC
 * claims this service requires. `none` and HMAC algorithms are rejected. No
 * token value is included in an error.
 */
// Asymmetric algorithms only: `none` and the HMAC family must never be
// accepted, and each supported algorithm fixes the expected key type.
const SIGNING_ALGORITHMS = Object.freeze({
  RS256: {
    kty: 'RSA',
    verify: (key, input, signature) => verifySignature('RSA-SHA256', input, key, signature),
  },
  PS256: {
    kty: 'RSA',
    verify: (key, input, signature) => verifySignature('sha256', input, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }, signature),
  },
  ES256: {
    kty: 'EC',
    crv: 'P-256',
    verify: (key, input, signature) => verifySignature('sha256', input, {
      key,
      dsaEncoding: 'ieee-p1363',
    }, signature),
  },
});

function decodeBase64Any(value) {
  // Base64url (unpadded) and standard Base64 (padded) decode to the same
  // bytes; at_hash only needs byte equality. Anything else is malformed.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) return null;
  let text = value.replaceAll('-', '+').replaceAll('_', '/');
  if (text.length % 4 === 1) return null;
  while (text.length % 4 !== 0) text += '=';
  return Buffer.from(text, 'base64');
}

export function verifyIdToken(token, { jwks, issuer, clientId, nonce, accessToken, now = Date.now(), skewSeconds = 60 } = {}) {
  const decoded = decodeJwt(token);
  // No critical JWS extensions are implemented, so none may be declared.
  if (decoded.header?.crit !== undefined) {
    throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token uses unsupported critical headers');
  }
  const alg = decoded.header?.alg;
  const algorithm = typeof alg === 'string' && Object.hasOwn(SIGNING_ALGORITHMS, alg)
    ? SIGNING_ALGORITHMS[alg]
    : undefined;
  if (!algorithm) {
    throw new OidcError('IAM_ID_TOKEN_ALGORITHM', 'ID token uses an unsupported signing algorithm');
  }
  if (typeof decoded.header?.kid !== 'string' || decoded.header.kid.length === 0) {
    throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token has no key id');
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const matches = keys.filter((candidate) => candidate?.kid === decoded.header.kid
    && candidate?.kty === algorithm.kty
    && (algorithm.crv === undefined || candidate?.crv === algorithm.crv)
    && (candidate?.alg === undefined || candidate.alg === alg)
    && (candidate?.use === undefined || candidate.use === 'sig')
    && (candidate?.key_ops === undefined || (Array.isArray(candidate.key_ops)
      && candidate.key_ops.includes('verify')
      && candidate.key_ops.every((op) => op === 'verify' || op === 'sign')
      && new Set(candidate.key_ops).size === candidate.key_ops.length)));
  if (matches.length === 0) {
    throw new OidcError('IAM_JWKS_KEY_NOT_FOUND', 'no matching JWKS key for the ID token');
  }
  if (matches.length !== 1) {
    throw new OidcError('IAM_JWKS_INVALID', 'multiple matching JWKS keys for the ID token');
  }
  const [jwk] = matches;
  let key;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new OidcError('IAM_JWKS_INVALID', 'matching JWKS key cannot be imported');
  }
  if (algorithm.kty === 'RSA' && !(key.asymmetricKeyDetails?.modulusLength >= 2048)) {
    throw new OidcError('IAM_JWKS_INVALID', 'matching RSA key is too small');
  }
  let valid = false;
  try {
    valid = algorithm.verify(key, Buffer.from(decoded.input), decoded.signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new OidcError('IAM_ID_TOKEN_SIGNATURE', 'ID token signature is invalid');

  const claims = decoded.payload;
  if (claims?.iss !== issuer) {
    throw new OidcError('IAM_ID_TOKEN_ISSUER', 'ID token issuer does not match');
  }
  if (!audienceIncludes(claims?.aud, clientId)) {
    throw new OidcError('IAM_ID_TOKEN_AUDIENCE', 'ID token audience does not include this client');
  }
  // OIDC Core 3.1.3.7: with multiple audiences `azp` must name this client, and
  // when present it must always match. Without this check a token minted for
  // several clients could be replayed against this one.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audiences.length > 1 && typeof claims.azp !== 'string') {
    throw new OidcError('IAM_ID_TOKEN_AUDIENCE', 'ID token has multiple audiences but no azp');
  }
  if (claims.azp !== undefined && claims.azp !== clientId) {
    throw new OidcError('IAM_ID_TOKEN_AUDIENCE', 'ID token authorized party does not match');
  }
  if (nonce !== undefined && claims?.nonce !== nonce) {
    throw new OidcError('IAM_ID_TOKEN_NONCE', 'ID token nonce does not match this attempt');
  }
  if (typeof claims?.sub !== 'string' || claims.sub.length === 0) {
    throw new OidcError('IAM_ID_TOKEN_SUBJECT', 'ID token has no subject');
  }
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isFinite(claims?.exp) || nowSeconds >= claims.exp + skewSeconds) {
    throw new OidcError('IAM_ID_TOKEN_EXPIRED', 'ID token is expired');
  }
  if (!Number.isFinite(claims?.iat) || claims.iat > nowSeconds + skewSeconds) {
    throw new OidcError('IAM_ID_TOKEN_ISSUED_AT', 'ID token has an invalid issuance time');
  }
  if (claims?.nbf !== undefined && (!Number.isFinite(claims.nbf) || nowSeconds + skewSeconds < claims.nbf)) {
    throw new OidcError('IAM_ID_TOKEN_NOT_BEFORE', 'ID token is not valid yet');
  }
  if (claims.at_hash !== undefined) {
    // All supported signing algorithms use SHA-256; OIDC hashes ASCII access
    // token bytes, then base64url-encodes the left half of the digest.
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)
        || typeof claims.at_hash !== 'string') {
      throw new OidcError('IAM_ID_TOKEN_AT_HASH', 'ID token access token hash is invalid');
    }
    const digest = createHash('sha256').update(accessToken, 'ascii').digest();
    const expectedBytes = digest.subarray(0, digest.length / 2);
    // The enterprise issuer emits at_hash in standard Base64 with padding
    // (`+`, `/`, `==`), not the base64url form OIDC prescribes. Compare the
    // decoded bytes so both encodings bind the same access token; comparing
    // the strings would reject every real token from this issuer.
    const receivedBytes = decodeBase64Any(claims.at_hash);
    if (receivedBytes === null || receivedBytes.length !== expectedBytes.length
        || !timingSafeEqual(expectedBytes, receivedBytes)) {
      throw new OidcError('IAM_ID_TOKEN_AT_HASH', 'ID token access token hash is invalid');
    }
  }
  return claims;
}

function assertHttpEndpoint(value, name) {
  const url = parseHttpUrl(value);
  if (url) return url;
  throw new OidcError('IAM_CONFIG_INVALID', `${name} must be an absolute HTTP or HTTPS URL`);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OidcError('IAM_CONFIG_INVALID', `${name} is required`);
  }
  return value;
}

function provenPreconnectFailure(cause) {
  if (cause instanceof AggregateError) {
    return cause.errors.length > 0 && cause.errors.every(preconnectSocketError);
  }
  return preconnectSocketError(cause);
}

function preconnectSocketError(cause) {
  if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if (cause?.syscall === 'getaddrinfo') return ['ENOTFOUND', 'EAI_AGAIN'].includes(cause.code);
  return cause?.syscall === 'connect'
    && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(cause.code);
}

export async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 10000, signal, method = 'GET', headers, body, ignoreBody = false, expectedStatus, clientAuthentication, beforeSend } = {}) {
  if (typeof fetchImpl !== 'function') throw new OidcError('IAM_HTTP_UNAVAILABLE', 'fetch is unavailable');
  const endpoint = assertClientAuthEndpoint(url, clientAuthentication);
  // Local invalidation is not a network failure. Nothing awaits between this
  // synchronous check and the actual fetch invocation. Retry only the read.
  let timeout;
  const response = await withCurrentClientAuth(clientAuthentication, async () => {
    if (signal?.aborted) throw new OidcError('IAM_UNREACHABLE', 'IAM endpoint is unreachable');
    beforeSend?.();
    timeout = AbortSignal.timeout(timeoutMs);
    const signals = signal ? [timeout, signal] : [timeout];
    try {
      return await fetchImpl(endpoint, { method, headers, body, redirect: 'error', signal: AbortSignal.any(signals) });
    } catch (cause) {
      // Native fetch can prove a preconnect failure. An injected fetcher cannot.
      const unsent = method === 'POST' && fetchImpl === globalThis.fetch
        && !signal?.aborted && !timeout.aborted && provenPreconnectFailure(cause?.cause);
      throw new OidcError('IAM_UNREACHABLE', 'IAM endpoint is unreachable', {
        ...(unsent ? { requestUnsent: true } : {}),
        ...(timeout.aborted ? { timedOut: true } : {}),
      });
    }
  });
  if (!response.ok) {
    let oauthError;
    let oauthErrorResponse;
    let timedOut = false;
    try {
      let payload;
      if (response.status === 401) {
        // Read once so a missing body is distinguishable from a non-OAuth
        // response. The contents stay local to this error parser.
        oauthErrorResponse = 'unreadable';
        const content = await response.text();
        oauthErrorResponse = content.trim() ? 'nonstandard' : 'empty';
        if (oauthErrorResponse === 'nonstandard') payload = JSON.parse(content);
      } else {
        payload = await response.json();
      }
      const candidate = payload?.error;
      // Copy only exact standard codes, never provider text that may echo credentials.
      if (OAUTH_ERROR_CODES.includes(candidate)) oauthError = candidate;
    } catch {
      // Record a body timeout without including the contents of the error body.
      timedOut = timeout.aborted;
    }
    throw new OidcError('IAM_HTTP_ERROR', `IAM endpoint returned ${response.status}`, {
      status: response.status,
      ...(oauthError ? { oauthError } : oauthErrorResponse ? { oauthErrorResponse } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    });
  }
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    void response.body?.cancel().catch(() => {});
    throw new OidcError('IAM_REVOKE_UNCONFIRMED', 'IAM revocation returned an unexpected success status');
  }
  if (response.status === 204) return null;
  if (ignoreBody) {
    // RFC 7009 §2.2: a successful revocation response body has no meaning.
    // Release it without requiring JSON or retaining provider response data.
    try { await response.body?.cancel(); } catch { /* status already confirms success */ }
    return null;
  }
  try {
    return await response.json();
  } catch {
    throw new OidcError('IAM_INVALID_RESPONSE', 'IAM endpoint returned invalid JSON',
      timeout.aborted ? { timedOut: true } : {});
  }
}

/**
 * Resolve discovery metadata, letting explicit config fields win over the
 * document. The issuer is required because ID-token validation must bind it.
 */
export async function loadMetadata(config, { fetchImpl, timeoutMs, signal, optional } = {}) {
  let document = {};
  // Discovery is a fallback for missing explicit fields. When every endpoint and
  // the issuer are configured, a discovery fetch must not gate sign-in: a broken
  // or unreachable well-known URL would otherwise break a fully explicit config.
  const needsOptional = Boolean(optional && !config[optional]);
  const needsDiscovery = Boolean(config.discoveryUrl)
    && (needsOptional || !config.issuer || !config.authorizationEndpoint || !config.tokenEndpoint || !config.jwksUri);
  if (needsDiscovery) {
    const discoveryUrl = assertHttpEndpoint(config.discoveryUrl, 'discoveryUrl');
    if (config.authMode === 'confidential' && discoveryUrl.protocol === 'http:'
      && config.allowInsecureClientAuthHttp !== true) {
      throw new OidcError('IAM_CONFIG_INVALID', 'Confidential IAM Discovery requires HTTPS');
    }
    document = await fetchJson(discoveryUrl, { fetchImpl, timeoutMs, signal });
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new OidcError('IAM_DISCOVERY_INVALID', 'discovery document must be an object');
    }
    if (document.issuer !== undefined) requireString(document.issuer, 'issuer');
    if (config.issuer && (needsOptional || document.issuer) && config.issuer !== document.issuer) {
      throw new OidcError('IAM_DISCOVERY_ISSUER_MISMATCH', 'discovery issuer does not match configured issuer');
    }
  }
  const issuer = config.issuer || document.issuer;
  const authorizationEndpoint = config.authorizationEndpoint || document.authorization_endpoint;
  const tokenEndpoint = config.tokenEndpoint || document.token_endpoint;
  const jwksUri = config.jwksUri || document.jwks_uri;
  const revocationEndpoint = config.revocationEndpoint || (document.issuer ? document.revocation_endpoint : undefined);
  const endSessionEndpoint = config.endSessionEndpoint || (document.issuer && document.end_session_endpoint);
  const userInfoEndpoint = config.userInfoEndpoint || (document.issuer && document.userinfo_endpoint);

  requireString(issuer, 'issuer');
  requireString(authorizationEndpoint, 'authorizationEndpoint');
  requireString(tokenEndpoint, 'tokenEndpoint');
  requireString(jwksUri, 'jwksUri');
  assertHttpEndpoint(issuer, 'issuer');
  const authorizeUrl = assertHttpEndpoint(authorizationEndpoint, 'authorizationEndpoint');
  const tokenUrl = assertHttpEndpoint(tokenEndpoint, 'tokenEndpoint');
  const jwksUrl = assertHttpEndpoint(jwksUri, 'jwksUri');
  const revokeUrl = revocationEndpoint
    ? assertHttpEndpoint(revocationEndpoint, 'revocationEndpoint')
    : undefined;
  const logoutUrl = endSessionEndpoint
    ? assertHttpEndpoint(endSessionEndpoint, 'endSessionEndpoint')
    : undefined;
  const userInfoUrl = userInfoEndpoint
    ? assertHttpEndpoint(userInfoEndpoint, 'userInfoEndpoint')
    : undefined;

  return {
    issuer,
    authorizationEndpoint: authorizeUrl.href,
    tokenEndpoint: tokenUrl.href,
    jwksUri: jwksUrl.href,
    revocationEndpoint: revokeUrl?.href,
    // Core and UserInfo reads still use valid fields from the same document.
    ...(revocationEndpoint !== undefined && !revokeUrl ? { invalidRevocationEndpoint: true } : {}),
    endSessionEndpoint: logoutUrl?.href,
    userInfoEndpoint: userInfoUrl?.href,
  };
}

export function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, scopes, state, nonce, codeChallenge, resource }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (resource) url.searchParams.set('resource', resource);
  return url.href;
}

function normalizeTokenResponse(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new OidcError('IAM_TOKEN_RESPONSE_INVALID', 'token response must be an object');
  }
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new OidcError('IAM_TOKEN_RESPONSE_INVALID', 'token response has no access token');
  }
  if (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer') {
    throw new OidcError('IAM_TOKEN_RESPONSE_INVALID', 'token response is not a Bearer token');
  }
  if (!Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new OidcError('IAM_TOKEN_RESPONSE_INVALID', 'token response has no positive expires_in');
  }
  return {
    accessToken: payload.access_token,
    tokenType: 'Bearer',
    expiresIn: payload.expires_in,
    refreshExpiresIn: Number.isFinite(payload.refresh_expires_in) && payload.refresh_expires_in > 0 ? payload.refresh_expires_in : undefined,
    idToken: typeof payload.id_token === 'string' && payload.id_token.length > 0 ? payload.id_token : undefined,
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0 ? payload.refresh_token : undefined,
    scope: typeof payload.scope === 'string' && payload.scope.length > 0 ? payload.scope : undefined,
  };
}

async function postForm(endpoint, form, { clientId, clientAuthentication, fetchImpl, timeoutMs, signal, ignoreBody = false, expectedStatus, beforeSend }) {
  const request = buildClientAuthRequest(clientId, form, clientAuthentication);
  return fetchJson(endpoint, {
    fetchImpl, timeoutMs, signal, clientAuthentication, ignoreBody, expectedStatus, beforeSend,
    method: 'POST',
    headers: ignoreBody ? request.headers : { ...request.headers, accept: 'application/json' },
    body: request.body,
  });
}

export async function exchangeCode({ tokenEndpoint, code, codeVerifier, redirectUri, clientId, resource, fetchImpl, timeoutMs, signal, clientAuthentication }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier,
  });
  if (resource) form.set('resource', resource);
  return normalizeTokenResponse(await postForm(tokenEndpoint, form, { clientId, clientAuthentication, fetchImpl, timeoutMs, signal }));
}

export async function refreshTokens({ tokenEndpoint, refreshToken, clientId, resource, fetchImpl, timeoutMs, signal, clientAuthentication, beforeSend }) {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (resource) form.set('resource', resource);
  return normalizeTokenResponse(await postForm(tokenEndpoint, form, { clientId, clientAuthentication, fetchImpl, timeoutMs, signal, beforeSend }));
}

export async function revokeToken({ revocationEndpoint, token, tokenTypeHint = 'refresh_token', clientId, fetchImpl, timeoutMs, signal, clientAuthentication }) {
  const form = new URLSearchParams({ token, token_type_hint: tokenTypeHint });
  return postForm(revocationEndpoint, form, {
    clientId, clientAuthentication, fetchImpl, timeoutMs, signal, ignoreBody: true, expectedStatus: 200,
  });
}

function revokeHttpOutcome(status) {
  return {
    state: status >= 500 || status === 408 || status === 429 ? 'unknown' : 'failed',
    code: `IAM_REVOKE_HTTP_${status}`,
  };
}

export async function revokeSessionToken({
  revocationMode = 'access_token_query', revocationEndpoint, accessToken, refreshToken,
  clientId, clientAuthentication, fetchImpl, timeoutMs = 5000, signal,
}) {
  const endpoint = parseHttpUrl(revocationEndpoint);
  if (!endpoint) return { state: 'failed', code: 'IAM_REVOKE_ENDPOINT_INVALID' };
  if (revocationMode !== 'access_token_query' && revocationMode !== 'rfc7009') {
    return { state: 'failed', code: 'IAM_CONFIG_INVALID' };
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const boundSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (boundSignal.aborted) return { state: 'unknown', code: 'IAM_REVOKE_CANCELLED' };
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(boundSignal.reason);
    boundSignal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const transport = { revocationEndpoint: endpoint.href, fetchImpl, timeoutMs, signal: boundSignal };
    if (revocationMode === 'access_token_query') {
      return await Promise.race([aborted, revokeAccessToken({ ...transport, accessToken })]);
    }
    const token = refreshToken || accessToken;
    if (!token) return { state: 'failed', code: 'IAM_REVOKE_TOKEN_MISSING' };
    await Promise.race([aborted, revokeToken({
      ...transport, token, tokenTypeHint: refreshToken ? 'refresh_token' : 'access_token',
      clientId, clientAuthentication,
    })]);
    return { state: 'ok' };
  } catch (error) {
    if (boundSignal.aborted) {
      return { state: 'unknown', code: timeout.aborted ? 'IAM_REVOKE_TIMEOUT' : 'IAM_REVOKE_CANCELLED' };
    }
    if (error?.code === 'IAM_HTTP_ERROR') return revokeHttpOutcome(error.details.status);
    if (error?.code === 'IAM_REVOKE_UNCONFIRMED') return { state: 'unknown', code: error.code };
    if (error instanceof IamError && error.code === 'IAM_CONFIG_INVALID') {
      return { state: 'failed', code: 'IAM_REVOKE_ENDPOINT_INVALID' };
    }
    return { state: 'unknown', code: 'IAM_REVOKE_UNREACHABLE' };
  } finally {
    boundSignal.removeEventListener('abort', onAbort);
  }
}

/**
 * Revoke one access token through the provider's token-as-credential endpoint
 * (D1, 2026-11-04): `GET <revocationEndpoint>?access_token=…`, no client
 * authentication, idempotent. Returns a three-way state instead of throwing so
 * sign-out can report "revoked", "failed" or "unconfirmed" without inventing a
 * success. The token stays in the query string, so no caller may log the URL.
 *
 * @returns {Promise<{state: 'ok'|'failed'|'unknown', code?: string}>}
 */
export async function revokeAccessToken({ revocationEndpoint, accessToken, fetchImpl = globalThis.fetch, timeoutMs = 5000, signal }) {
  if (typeof fetchImpl !== 'function') return { state: 'unknown', code: 'IAM_HTTP_UNAVAILABLE' };
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { state: 'failed', code: 'IAM_REVOKE_TOKEN_MISSING' };
  }
  let endpoint;
  try {
    endpoint = new URL(revocationEndpoint);
    endpoint.searchParams.set('access_token', accessToken);
  } catch {
    return { state: 'failed', code: 'IAM_REVOKE_ENDPOINT_INVALID' };
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response;
  try {
    response = await fetchImpl(endpoint.href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any(signals),
    });
  } catch {
    return { state: 'unknown', code: 'IAM_REVOKE_UNREACHABLE' };
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    return revokeHttpOutcome(response.status);
  }
  if (payload?.result === true) return { state: 'ok' };
  if (payload?.result === false) {
    // 2002 means the token is already unusable; revocation is idempotent.
    // The provider's JSON type is not part of the contract: accept 2002 or "2002".
    return Number(payload.errcode) === 2002
      ? { state: 'ok', code: 'IAM_REVOKE_ALREADY_INVALID' }
      : { state: 'failed', code: 'IAM_REVOKE_REJECTED' };
  }
  return { state: 'unknown', code: 'IAM_REVOKE_UNCONFIRMED' };
}

export function safeStateEqual(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}
