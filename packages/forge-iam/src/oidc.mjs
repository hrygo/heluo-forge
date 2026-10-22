import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

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
  if (url.searchParams.has('error')) {
    throw new OidcError('IAM_AUTHORIZATION_ERROR', 'authorization endpoint returned an error', {
      error: url.searchParams.get('error') ?? 'unknown',
    });
  }
  if (states.length !== 1 || codes.length !== 1 || !states[0] || !codes[0]) {
    throw new OidcError('IAM_CALLBACK_INVALID', 'callback must carry exactly one code and one state');
  }
  return { code: codes[0], state: states[0] };
}

export function decodeJwt(token) {
  if (typeof token !== 'string') throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token is missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token must have three segments');
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
  return Array.isArray(audience) && audience.includes(clientId);
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

export function verifyIdToken(token, { jwks, issuer, clientId, nonce, now = Date.now(), skewSeconds = 60 } = {}) {
  const decoded = decodeJwt(token);
  const algorithm = SIGNING_ALGORITHMS[decoded.header?.alg];
  if (!algorithm) {
    throw new OidcError('IAM_ID_TOKEN_ALGORITHM', 'ID token uses an unsupported signing algorithm');
  }
  if (!decoded.header?.kid) {
    throw new OidcError('IAM_ID_TOKEN_INVALID', 'ID token has no key id');
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const jwk = keys.find((candidate) => candidate?.kid === decoded.header.kid
    && candidate?.kty === algorithm.kty
    && (algorithm.crv === undefined || candidate?.crv === algorithm.crv));
  if (!jwk) {
    throw new OidcError('IAM_JWKS_KEY_NOT_FOUND', 'no matching JWKS key for the ID token');
  }
  let key;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new OidcError('IAM_JWKS_INVALID', 'matching JWKS key cannot be imported');
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
  if (typeof claims?.exp !== 'number' || nowSeconds > claims.exp + skewSeconds) {
    throw new OidcError('IAM_ID_TOKEN_EXPIRED', 'ID token is expired');
  }
  if (typeof claims?.iat === 'number' && claims.iat > nowSeconds + skewSeconds) {
    throw new OidcError('IAM_ID_TOKEN_ISSUED_AT', 'ID token was issued in the future');
  }
  if (claims?.nbf !== undefined && (typeof claims.nbf !== 'number' || nowSeconds + skewSeconds < claims.nbf)) {
    throw new OidcError('IAM_ID_TOKEN_NOT_BEFORE', 'ID token is not valid yet');
  }
  return claims;
}

function assertSafeEndpoint(value, name, allowInsecureHttp) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OidcError('IAM_CONFIG_INVALID', `${name} is not a valid URL`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && allowInsecureHttp === true) return url;
  throw new OidcError('IAM_CONFIG_INVALID', `${name} must use HTTPS unless allowInsecureHttp is explicitly true`);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OidcError('IAM_CONFIG_INVALID', `${name} is required`);
  }
  return value;
}

export async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 10000, signal, method = 'GET', headers, body, ignoreBody = false } = {}) {
  if (typeof fetchImpl !== 'function') throw new OidcError('IAM_HTTP_UNAVAILABLE', 'fetch is unavailable');
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.any(signals),
    });
  } catch {
    throw new OidcError('IAM_UNREACHABLE', 'IAM endpoint is unreachable');
  }
  if (!response.ok) {
    let oauthError;
    try {
      const payload = await response.json();
      oauthError = typeof payload?.error === 'string' ? payload.error : undefined;
    } catch {
      // Non-JSON error bodies are intentionally not surfaced.
    }
    throw new OidcError('IAM_HTTP_ERROR', `IAM endpoint returned ${response.status}`, {
      status: response.status,
      ...(oauthError ? { oauthError } : {}),
    });
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
    throw new OidcError('IAM_INVALID_RESPONSE', 'IAM endpoint returned invalid JSON');
  }
}

/**
 * Resolve discovery metadata, letting explicit config fields win over the
 * document. The issuer is required because ID-token validation must bind it.
 */
export async function loadMetadata(config, { fetchImpl, timeoutMs, signal, allowInsecureHttp = false } = {}) {
  let document = {};
  if (config.discoveryUrl) {
    const discoveryUrl = assertSafeEndpoint(config.discoveryUrl, 'discoveryUrl', allowInsecureHttp);
    document = await fetchJson(discoveryUrl, { fetchImpl, timeoutMs, signal });
    if (document === null || typeof document !== 'object') {
      throw new OidcError('IAM_DISCOVERY_INVALID', 'discovery document must be an object');
    }
    if (document.issuer !== undefined) requireString(document.issuer, 'issuer');
    if (config.issuer && document.issuer && config.issuer !== document.issuer) {
      throw new OidcError('IAM_DISCOVERY_ISSUER_MISMATCH', 'discovery issuer does not match configured issuer');
    }
  }
  const issuer = config.issuer || document.issuer;
  const authorizationEndpoint = config.authorizationEndpoint || document.authorization_endpoint;
  const tokenEndpoint = config.tokenEndpoint || document.token_endpoint;
  const jwksUri = config.jwksUri || document.jwks_uri;
  const revocationEndpoint = config.revocationEndpoint || document.revocation_endpoint;
  const endSessionEndpoint = config.endSessionEndpoint || document.end_session_endpoint;

  requireString(issuer, 'issuer');
  requireString(authorizationEndpoint, 'authorizationEndpoint');
  requireString(tokenEndpoint, 'tokenEndpoint');
  requireString(jwksUri, 'jwksUri');
  assertSafeEndpoint(issuer, 'issuer', allowInsecureHttp);
  const authorizeUrl = assertSafeEndpoint(authorizationEndpoint, 'authorizationEndpoint', allowInsecureHttp);
  const tokenUrl = assertSafeEndpoint(tokenEndpoint, 'tokenEndpoint', allowInsecureHttp);
  const jwksUrl = assertSafeEndpoint(jwksUri, 'jwksUri', allowInsecureHttp);
  const revokeUrl = revocationEndpoint
    ? assertSafeEndpoint(revocationEndpoint, 'revocationEndpoint', allowInsecureHttp)
    : undefined;
  const logoutUrl = endSessionEndpoint
    ? assertSafeEndpoint(endSessionEndpoint, 'endSessionEndpoint', allowInsecureHttp)
    : undefined;

  return {
    issuer,
    authorizationEndpoint: authorizeUrl.href,
    tokenEndpoint: tokenUrl.href,
    jwksUri: jwksUrl.href,
    revocationEndpoint: revokeUrl?.href,
    endSessionEndpoint: logoutUrl?.href,
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

async function postToken(endpoint, form, { fetchImpl, timeoutMs, signal }) {
  return fetchJson(endpoint, {
    fetchImpl,
    timeoutMs,
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  });
}

export async function exchangeCode({ tokenEndpoint, code, codeVerifier, redirectUri, clientId, resource, fetchImpl, timeoutMs, signal }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (resource) form.set('resource', resource);
  return normalizeTokenResponse(await postToken(tokenEndpoint, form, { fetchImpl, timeoutMs, signal }));
}

export async function refreshTokens({ tokenEndpoint, refreshToken, clientId, resource, fetchImpl, timeoutMs, signal }) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (resource) form.set('resource', resource);
  return normalizeTokenResponse(await postToken(tokenEndpoint, form, { fetchImpl, timeoutMs, signal }));
}

export async function revokeToken({ revocationEndpoint, token, tokenTypeHint = 'refresh_token', clientId, fetchImpl, timeoutMs, signal }) {
  const form = new URLSearchParams({ token, token_type_hint: tokenTypeHint, client_id: clientId });
  return fetchJson(revocationEndpoint, {
    fetchImpl,
    timeoutMs,
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    ignoreBody: true,
  });
}

export function safeStateEqual(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}