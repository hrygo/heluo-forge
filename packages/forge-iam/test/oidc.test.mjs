import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
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
