import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import {
  OidcError,
  buildAuthorizationUrl,
  createPkce,
  loadMetadata,
  parseCallbackUrl,
  revokeToken,
  safeStateEqual,
  verifyIdToken,
} from '../src/oidc.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', kty: 'RSA', alg: 'RS256' };

function idToken(overrides = {}, { key = privateKey, kid = 'k1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://iam.example',
    sub: 'E1001',
    aud: 'dsh-desktop',
    exp: now + 300,
    iat: now,
    nonce: 'n-1',
    ...overrides,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

test('PKCE S256 matches the RFC 7636 example', () => {
  const { challenge } = createPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('callback parsing requires exactly one code and state', () => {
  assert.deepEqual(parseCallbackUrl('/iam/callback?code=c&state=s'), { code: 'c', state: 's' });
  assert.throws(() => parseCallbackUrl('/iam/callback?code=c'), (error) => error instanceof OidcError && error.code === 'IAM_CALLBACK_INVALID');
  assert.throws(() => parseCallbackUrl('/iam/callback?code=c&code=d&state=s'), /exactly one/);
  assert.throws(() => parseCallbackUrl('/iam/callback?error=access_denied&state=s'), (error) => error.code === 'IAM_AUTHORIZATION_ERROR');
});

test('state comparison is length-safe and constant-time', () => {
  assert.equal(safeStateEqual('abc', 'abc'), true);
  assert.equal(safeStateEqual('abc', 'abd'), false);
  assert.equal(safeStateEqual('abc', 'abcd'), false);
  assert.equal(safeStateEqual('abc', null), false);
});

test('a valid ID token verifies and returns claims', () => {
  const claims = verifyIdToken(idToken(), {
    jwks: { keys: [jwk] }, issuer: 'https://iam.example', clientId: 'dsh-desktop', nonce: 'n-1',
  });
  assert.equal(claims.sub, 'E1001');
});

test('signature, audience, nonce and expiry failures are rejected', () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cases = [
    [idToken({}, { key: other.privateKey }), 'IAM_ID_TOKEN_SIGNATURE'],
    [idToken({ aud: 'other-client' }), 'IAM_ID_TOKEN_AUDIENCE'],
    [idToken({ nonce: 'other' }), 'IAM_ID_TOKEN_NONCE'],
    [idToken({ exp: Math.floor(Date.now() / 1000) - 120 }), 'IAM_ID_TOKEN_EXPIRED'],
    [idToken({ iss: 'https://other.example' }), 'IAM_ID_TOKEN_ISSUER'],
    [idToken({ sub: '' }), 'IAM_ID_TOKEN_SUBJECT'],
  ];
  for (const [token, code] of cases) {
    assert.throws(() => verifyIdToken(token, {
      jwks: { keys: [jwk] }, issuer: 'https://iam.example', clientId: 'dsh-desktop', nonce: 'n-1',
    }), (error) => error.code === code, code);
  }
});

const verifyOptions = { jwks: { keys: [jwk] }, issuer: 'https://iam.example', clientId: 'dsh-desktop', nonce: 'n-1' };

function tokenWithRawNumber(claim, number) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const json = JSON.stringify({ iss: 'https://iam.example', sub: 'E1001', aud: 'dsh-desktop', exp: now + 300, iat: now, nonce: 'n-1', [claim]: 'NUMBER' });
  const body = Buffer.from(json.replace('"NUMBER"', number)).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

test('compact JWS segments must be nonempty canonical unpadded base64url', async (t) => {
  const [header, payload, signature] = idToken().split('.');
  const resign = (head, body) => `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonicalSignature = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)) | 1];
  assert.deepEqual(Buffer.from(noncanonicalSignature, 'base64url'), Buffer.from(signature, 'base64url'));
  const cases = [
    ['signature junk', `${header}.${payload}.${signature}!`],
    ['signature padding', `${header}.${payload}.${signature}=`],
    ['noncanonical signature pad bits', `${header}.${payload}.${noncanonicalSignature}`],
    ['empty signature', `${header}.${payload}.`],
    ['header padding', resign(`${header}=`, payload)],
    ['payload padding', resign(header, `${payload}=`)],
    ['header junk', resign(`${header}!`, payload)],
    ['payload junk', resign(header, `${payload}!`)],
  ];
  for (const [name, token] of cases) await t.test(name, () => {
    assert.throws(() => verifyIdToken(token, verifyOptions), (error) => error.code === 'IAM_ID_TOKEN_INVALID');
  });
});

test('unsupported critical JWS headers are rejected', async (t) => {
  const [, payload] = idToken().split('.');
  for (const crit of [['unknown'], [], 'unknown', null]) await t.test(JSON.stringify(crit), () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', crit, unknown: true })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    assert.throws(() => verifyIdToken(`${header}.${payload}.${signature}`, verifyOptions), (error) => error.code === 'IAM_ID_TOKEN_INVALID');
  });
});

test('expiry is exclusive at the clock-skew boundary', () => {
  const token = idToken({ iat: 1999999900, exp: 2000000000 });
  assert.equal(verifyIdToken(token, { ...verifyOptions, now: 2000000059 * 1000, skewSeconds: 60 }).sub, 'E1001');
  assert.throws(() => verifyIdToken(token, { ...verifyOptions, now: 2000000060 * 1000, skewSeconds: 60 }), (error) => error.code === 'IAM_ID_TOKEN_EXPIRED');
  assert.throws(() => verifyIdToken(token, { ...verifyOptions, now: 2000000000 * 1000, skewSeconds: 0 }), (error) => error.code === 'IAM_ID_TOKEN_EXPIRED');
});

test('RSA ID token signing keys must have at least 2048 bits', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const weakJwk = { ...weak.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  assert.throws(() => verifyIdToken(idToken({}, { key: weak.privateKey }), { ...verifyOptions, jwks: { keys: [weakJwk] } }), (error) => error.code === 'IAM_JWKS_INVALID');
  assert.equal(verifyIdToken(idToken(), verifyOptions).sub, 'E1001');
});

test('JWKS selection requires one compatible key with valid metadata', async (t) => {
  const cases = [
    ['duplicate compatible keys', [jwk, jwk], 'IAM_JWKS_INVALID'],
    ['conflicting alg', [{ ...jwk, alg: 'PS256' }], 'IAM_JWKS_KEY_NOT_FOUND'],
    ['non-string alg', [{ ...jwk, alg: 42 }], 'IAM_JWKS_KEY_NOT_FOUND'],
    ['non-string use', [{ ...jwk, use: ['sig'] }], 'IAM_JWKS_KEY_NOT_FOUND'],
    ['string key_ops', [{ ...jwk, key_ops: 'verify' }], 'IAM_JWKS_KEY_NOT_FOUND'],
    ['null key_ops', [{ ...jwk, key_ops: null }], 'IAM_JWKS_KEY_NOT_FOUND'],
    ['mixed key_ops', [{ ...jwk, key_ops: ['verify', 1] }], 'IAM_JWKS_KEY_NOT_FOUND'],
    ['conflicting key_ops', [{ ...jwk, key_ops: ['verify', 'encrypt'] }], 'IAM_JWKS_KEY_NOT_FOUND'],
  ];
  for (const [name, keys, code] of cases) await t.test(name, () => {
    assert.throws(() => verifyIdToken(idToken(), { ...verifyOptions, jwks: { keys } }), (error) => error.code === code);
  });
  assert.equal(verifyIdToken(idToken(), { ...verifyOptions, jwks: { keys: [{ ...jwk, use: 'sig', key_ops: ['verify'] }] } }).sub, 'E1001');
});

test('ID token time claims must be finite and required where applicable', async (t) => {
  const cases = [
    ['missing iat', idToken({ iat: undefined }), 'IAM_ID_TOKEN_ISSUED_AT'],
    ['string iat', idToken({ iat: '123' }), 'IAM_ID_TOKEN_ISSUED_AT'],
    ['infinite iat', tokenWithRawNumber('iat', '1e400'), 'IAM_ID_TOKEN_ISSUED_AT'],
    ['negative infinite iat', tokenWithRawNumber('iat', '-1e400'), 'IAM_ID_TOKEN_ISSUED_AT'],
    ['future iat', idToken({ iat: Math.floor(Date.now() / 1000) + 120 }), 'IAM_ID_TOKEN_ISSUED_AT'],
    ['missing exp', idToken({ exp: undefined }), 'IAM_ID_TOKEN_EXPIRED'],
    ['infinite exp', tokenWithRawNumber('exp', '1e400'), 'IAM_ID_TOKEN_EXPIRED'],
    ['infinite nbf', tokenWithRawNumber('nbf', '-1e400'), 'IAM_ID_TOKEN_NOT_BEFORE'],
    ['string nbf', idToken({ nbf: '0' }), 'IAM_ID_TOKEN_NOT_BEFORE'],
    ['future nbf', idToken({ nbf: Math.floor(Date.now() / 1000) + 120 }), 'IAM_ID_TOKEN_NOT_BEFORE'],
  ];
  for (const [name, token, code] of cases) await t.test(name, () => {
    assert.throws(() => verifyIdToken(token, verifyOptions), (error) => error.code === code);
  });
});

test('audience is a nonempty string or array of nonempty strings', async (t) => {
  for (const aud of [['dsh-desktop', 1], ['dsh-desktop', ''], [], '', null]) await t.test(JSON.stringify(aud), () => {
    assert.throws(() => verifyIdToken(idToken({ aud, azp: 'dsh-desktop' }), verifyOptions), (error) => error.code === 'IAM_ID_TOKEN_AUDIENCE');
  });
});

test('at_hash binds the provided access token and cannot be ignored', async (t) => {
  const accessToken = 'access-token-placeholder';
  const hash = createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url');
  assert.equal(verifyIdToken(idToken({ at_hash: hash }), { ...verifyOptions, accessToken }).sub, 'E1001');
  const cases = [
    ['no access token', hash, undefined],
    ['empty access token', hash, ''],
    ['different access token', hash, 'different'],
    ['bad hash', 'wrong', accessToken],
    ['invalid type', 42, accessToken],
    ['null hash', null, accessToken],
  ];
  for (const [name, atHash, token] of cases) await t.test(name, () => {
    assert.throws(() => verifyIdToken(idToken({ at_hash: atHash }), { ...verifyOptions, accessToken: token }), (error) => error.code === 'IAM_ID_TOKEN_AT_HASH');
  });
  assert.equal(verifyIdToken(idToken(), verifyOptions).sub, 'E1001');
});

test('callback rejects ambiguous and empty response parameters without leaking provider error', async (t) => {
  const invalid = [
    '?code=c&state=s&iss=a&iss=b', '?code=c&state=s&error=denied',
    '?error=denied&error=other&state=s', '?error=denied', '?error=&state=s',
    '?code=c&state=s&iss=', '?code=&state=s', '?code=c&state=',
    '?error=denied&state=s&state=t', '?error=denied&state=s&iss=a&iss=b',
  ];
  for (const query of invalid) await t.test(query, () => {
    assert.throws(() => parseCallbackUrl(`/iam/callback${query}`), (error) => error.code === 'IAM_CALLBACK_INVALID');
  });
  assert.deepEqual(parseCallbackUrl('/iam/callback?code=c&state=s&iss=https%3A%2F%2Fiam.example'), { code: 'c', state: 's', iss: 'https://iam.example' });
  assert.throws(() => parseCallbackUrl('/iam/callback?error=private-provider-value&state=s'), (error) => {
    assert.equal(error.code, 'IAM_AUTHORIZATION_ERROR');
    assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes('private-provider-value'), false);
    return true;
  });
});

test('authorization URL carries PKCE, state, nonce and resource', () => {
  const url = new URL(buildAuthorizationUrl({
    authorizationEndpoint: 'https://iam.example/authorize',
    clientId: 'dsh-desktop',
    redirectUri: 'http://127.0.0.1:1234/iam/callback',
    scopes: ['openid', 'offline_access'],
    state: 's',
    nonce: 'n',
    codeChallenge: 'c',
    resource: 'https://gateway.example',
  }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), 'https://gateway.example');
  assert.equal(url.searchParams.get('scope'), 'openid offline_access');
});

test('metadata requires allowInsecureHttp even for loopback HTTP', async () => {
  await assert.rejects(
    () => loadMetadata({
      issuer: 'http://iam.example', authorizationEndpoint: 'http://iam.example/authorize',
      tokenEndpoint: 'http://iam.example/token', jwksUri: 'http://iam.example/jwks',
    }),
    (error) => error.code === 'IAM_CONFIG_INVALID',
  );
  await assert.rejects(
    () => loadMetadata({
      issuer: 'http://127.0.0.1:9', authorizationEndpoint: 'http://127.0.0.1:9/authorize',
      tokenEndpoint: 'http://127.0.0.1:9/token', jwksUri: 'http://127.0.0.1:9/jwks',
    }),
    (error) => error.code === 'IAM_CONFIG_INVALID',
  );
  const meta = await loadMetadata({
    issuer: 'http://127.0.0.1:9', authorizationEndpoint: 'http://127.0.0.1:9/authorize',
    tokenEndpoint: 'http://127.0.0.1:9/token', jwksUri: 'http://127.0.0.1:9/jwks',
  }, { allowInsecureHttp: true });
  assert.equal(meta.issuer, 'http://127.0.0.1:9');
});

test('revocation accepts an empty 200 response', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
  const result = await revokeToken({
    revocationEndpoint: 'https://iam.example/revoke',
    token: 'refresh-placeholder',
    clientId: 'dsh-desktop',
    fetchImpl,
  });
  assert.equal(result, null);
});

test('revocation ignores every successful response body per RFC 7009', async () => {
  for (const body of ['OK', '{', '{"ignored":true}']) {
    const result = await revokeToken({
      revocationEndpoint: 'https://iam.example/revoke', token: 'refresh-placeholder',
      clientId: 'dsh-desktop', fetchImpl: async () => new Response(body, { status: 200 }),
    });
    assert.equal(result, null);
  }
});

test('revocation still rejects failed responses', async () => {
  await assert.rejects(() => revokeToken({
    revocationEndpoint: 'https://iam.example/revoke', token: 'refresh-placeholder',
    clientId: 'dsh-desktop', fetchImpl: async () => new Response('unavailable', { status: 503 }),
  }), (error) => error.code === 'IAM_HTTP_ERROR' && error.details.status === 503);
});

test('discovery issuer must match the configured issuer', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      issuer: 'https://other.example',
      authorization_endpoint: 'https://other.example/authorize',
      token_endpoint: 'https://other.example/token',
      jwks_uri: 'https://other.example/jwks',
    }),
  });
  await assert.rejects(
    () => loadMetadata({
      discoveryUrl: 'https://iam.example/.well-known/openid-configuration',
      issuer: 'https://iam.example',
    }, { fetchImpl }),
    (error) => error.code === 'IAM_DISCOVERY_ISSUER_MISMATCH',
  );
});

test('multi-audience ID tokens must name this client as the authorized party', () => {
  const options = {
    jwks: { keys: [jwk] }, issuer: 'https://iam.example', clientId: 'dsh-desktop', nonce: 'n-1',
  };
  assert.throws(
    () => verifyIdToken(idToken({ aud: ['dsh-desktop', 'other-client'] }), options),
    (error) => error.code === 'IAM_ID_TOKEN_AUDIENCE',
  );
  assert.throws(
    () => verifyIdToken(idToken({ aud: ['dsh-desktop', 'other-client'], azp: 'other-client' }), options),
    (error) => error.code === 'IAM_ID_TOKEN_AUDIENCE',
  );
  const claims = verifyIdToken(idToken({ aud: ['dsh-desktop', 'other-client'], azp: 'dsh-desktop' }), options);
  assert.equal(claims.azp, 'dsh-desktop');
  assert.throws(
    () => verifyIdToken(idToken({ azp: 'other-client' }), options),
    (error) => error.code === 'IAM_ID_TOKEN_AUDIENCE',
  );
});

test('PS256 and ES256 verify, while none and HS256 stay rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://iam.example', sub: 'E1001', aud: 'dsh-desktop', exp: now + 300, iat: now, nonce: 'n-1',
  };
  const build = (header, key, options) => {
    const head = Buffer.from(JSON.stringify(header)).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, ...options }).toString('base64url');
    return `${head}.${body}.${signature}`;
  };
  const options = { issuer: 'https://iam.example', clientId: 'dsh-desktop', nonce: 'n-1' };

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'p1', kty: 'RSA', alg: 'PS256' };
  const ps = build({ alg: 'PS256', kid: 'p1' }, rsa.privateKey, {
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  });
  assert.equal(verifyIdToken(ps, { ...options, jwks: { keys: [rsaJwk] } }).sub, 'E1001');

  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'e1', kty: 'EC', crv: 'P-256', alg: 'ES256' };
  const es = build({ alg: 'ES256', kid: 'e1' }, ec.privateKey, { dsaEncoding: 'ieee-p1363' });
  assert.equal(verifyIdToken(es, { ...options, jwks: { keys: [ecJwk] } }).sub, 'E1001');

  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'e1' })).toString('base64url')}.`
    + `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.AA`;
  assert.throws(() => verifyIdToken(none, { ...options, jwks: { keys: [ecJwk] } }),
    (error) => error.code === 'IAM_ID_TOKEN_ALGORITHM');

  const hsHead = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'e1' })).toString('base64url');
  const hsBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hs = `${hsHead}.${hsBody}.${createHmac('sha256', 'shared-secret').update(`${hsHead}.${hsBody}`).digest('base64url')}`;
  assert.throws(() => verifyIdToken(hs, { ...options, jwks: { keys: [ecJwk] } }),
    (error) => error.code === 'IAM_ID_TOKEN_ALGORITHM');

  for (const alg of ['constructor', '__proto__', 'toString']) {
    const head = Buffer.from(JSON.stringify({ alg, kid: 'e1' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    assert.throws(() => verifyIdToken(`${head}.${body}.sig`, { ...options, jwks: { keys: [ecJwk] } }),
      (error) => error.code === 'IAM_ID_TOKEN_ALGORITHM');
  }

  // A key of the wrong type for the declared algorithm cannot verify.
  assert.throws(() => verifyIdToken(ps, { ...options, jwks: { keys: [ecJwk] } }),
    (error) => error.code === 'IAM_JWKS_KEY_NOT_FOUND');
});

test('a JWKS key marked for encryption cannot verify an ID token', () => {
  assert.throws(() => verifyIdToken(idToken(), {
    jwks: { keys: [{ ...jwk, use: 'enc' }] },
    issuer: 'https://iam.example',
    clientId: 'dsh-desktop',
    nonce: 'n-1',
  }), (error) => error.code === 'IAM_JWKS_KEY_NOT_FOUND');
  assert.throws(() => verifyIdToken(idToken(), {
    jwks: { keys: [{ ...jwk, key_ops: ['encrypt'] }] },
    issuer: 'https://iam.example',
    clientId: 'dsh-desktop',
    nonce: 'n-1',
  }), (error) => error.code === 'IAM_JWKS_KEY_NOT_FOUND');
});

test('a complete explicit configuration does not depend on discovery', async () => {
  const metadata = await loadMetadata({
    discoveryUrl: 'https://unreachable.example/.well-known/openid-configuration',
    issuer: 'https://iam.example',
    authorizationEndpoint: 'https://iam.example/authorize',
    tokenEndpoint: 'https://iam.example/token',
    jwksUri: 'https://iam.example/jwks',
  }, { fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(metadata.issuer, 'https://iam.example');
  assert.equal(metadata.tokenEndpoint, 'https://iam.example/token');
});

test('allowInsecureHttp only permits loopback, never a remote host', async () => {
  const config = {
    issuer: 'http://iam.corp.example',
    authorizationEndpoint: 'http://iam.corp.example/authorize',
    tokenEndpoint: 'http://iam.corp.example/token',
    jwksUri: 'http://iam.corp.example/jwks',
  };
  await assert.rejects(() => loadMetadata(config, { allowInsecureHttp: true }),
    (error) => error.code === 'IAM_CONFIG_INVALID');
  const loopback = await loadMetadata({
    ...config,
    issuer: 'http://127.0.0.1:8080',
    authorizationEndpoint: 'http://127.0.0.1:8080/authorize',
    tokenEndpoint: 'http://127.0.0.1:8080/token',
    jwksUri: 'http://127.0.0.1:8080/jwks',
  }, { allowInsecureHttp: true });
  assert.equal(loopback.issuer, 'http://127.0.0.1:8080');
});
