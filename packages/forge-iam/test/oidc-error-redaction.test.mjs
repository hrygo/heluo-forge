import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { OidcError, fetchJson, exchangeCode, refreshTokens, revokeToken } from '../src/oidc.mjs';
import { createIamService } from '../src/service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const sentinel = 'SYNTHETIC_OIDC_PRIVATE_SENTINEL';
const encoded = Buffer.from(`synthetic-client:${sentinel}`).toString('base64');
const endpoint = 'https://iam.corp.example/token';
const standardErrors = [
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'unsupported_token_type',
  'access_denied', 'unsupported_response_type', 'server_error', 'temporarily_unavailable',
];

function assertNoPrivateOutput(error) {
  for (const value of [sentinel, encoded]) {
    assert.equal(JSON.stringify(error).includes(value), false, 'serialized error must not retain provider private text');
    assert.equal(JSON.stringify(error.details).includes(value), false, 'error details must not retain provider private text');
    assert.equal(String(error).includes(value), false, 'error message must remain fixed');
    assert.equal(String(error.stack).includes(value), false, 'error stack must not echo the provider body');
  }
  assert.equal(Object.hasOwn(error, 'cause'), false);
}

async function httpFailure(operation, { status = 400, oauthError } = {}) {
  const error = await operation().then(() => null, (failure) => failure);
  assert.equal(error instanceof OidcError, true);
  assert.equal(error.code, 'IAM_HTTP_ERROR');
  assert.equal(error.message, `IAM endpoint returned ${status}`);
  assert.equal(error.details.status, status);
  assert.equal(Object.hasOwn(error.details, 'oauthError'), oauthError !== undefined);
  if (oauthError !== undefined) assert.equal(error.details.oauthError === oauthError, true);
  assert.equal(Object.keys(error.details).length, oauthError === undefined ? 1 : 2);
  assertNoPrivateOutput(error);
  return error;
}

for (const [name, value] of [
  ['raw secret', sentinel], ['authorization code', `code-${sentinel}`], ['refresh token', `refresh-${sentinel}`],
  ['Basic value', `Basic ${encoded}`], ['unknown vendor code', 'vendor_custom_error'],
  ['mixed grant code', `invalid_grant ${sentinel}`], ['grant prefix', 'invalid_grant_extra'],
  ['multiple codes', 'invalid_grant,invalid_client'], ['leading whitespace', ' invalid_grant'],
  ['trailing whitespace', 'invalid_grant '], ['wrong case', 'INVALID_GRANT'],
  ['newline suffix', `invalid_client\n${sentinel}`], ['empty', ''], ['whitespace', '  '],
  ['missing', undefined], ['null', null], ['number', 401], ['boolean', true],
  ['object', { code: 'invalid_grant', private: sentinel }], ['array', ['invalid_grant', sentinel]],
]) {
  test(`non-standard OAuth error is omitted rather than copied: ${name}`, async () => {
    let requests = 0;
    await httpFailure(() => fetchJson(endpoint, { fetchImpl: async () => {
      requests++;
      return Response.json({ error: value, error_description: sentinel, private: encoded }, { status: 400 });
    } }));
    assert.equal(requests, 1);
  });
}

for (const oauthError of standardErrors) {
  test(`an exact standard OAuth error remains available for classification: ${oauthError}`, async () => {
    await httpFailure(() => fetchJson(endpoint, { fetchImpl: async () =>
      Response.json({ error: oauthError, error_description: sentinel, extra: encoded }, { status: 400 }) }), { oauthError });
  });
}

for (const [name, invoke] of [
  ['fetchJson', (fetchImpl) => fetchJson(endpoint, { fetchImpl })],
  ['authorization code exchange', (fetchImpl) => exchangeCode({ tokenEndpoint: endpoint, clientId: 'synthetic-client',
    code: `code-${sentinel}`, codeVerifier: `verifier-${sentinel}`, redirectUri: 'http://127.0.0.1:9/iam/callback', fetchImpl })],
  ['refresh', (fetchImpl) => refreshTokens({ tokenEndpoint: endpoint, clientId: 'synthetic-client', refreshToken: `refresh-${sentinel}`, fetchImpl })],
  ['revocation ignoreBody', (fetchImpl) => revokeToken({ revocationEndpoint: endpoint, clientId: 'synthetic-client', token: `refresh-${sentinel}`, fetchImpl })],
]) {
  test(`${name} rejects a private error field without changing transport or retry behavior`, async () => {
    let requests = 0;
    await httpFailure(() => invoke(async (_url, init) => {
      requests++;
      assert.equal(init.redirect, 'error');
      assert.equal(init.signal instanceof AbortSignal, true);
      return Response.json({ error: `invalid_grant ${sentinel} ${encoded}`, error_description: sentinel }, { status: 403 });
    }), { status: 403 });
    assert.equal(requests, 1);
  });
}

test('non-JSON error bodies and failing error getters remain fixed HTTP failures', async () => {
  for (const response of [
    new Response(sentinel, { status: 502 }),
    Response.json({}, { status: 502 }),
  ]) {
    if (response.headers.get('content-type')?.includes('application/json')) {
      response.json = async () => Object.defineProperty({}, 'error', { get() { throw new Error(sentinel); } });
    }
    await httpFailure(() => fetchJson(endpoint, { fetchImpl: async () => response }), { status: 502 });
  }
});

test('failed JSON parsing never attaches its thrown value as a cause', async () => {
  const response = Response.json({}, { status: 500 });
  response.json = async () => { throw new Error(sentinel); };
  await httpFailure(() => fetchJson(endpoint, { fetchImpl: async () => response }), { status: 500 });
});

test('successful JSON bodies are not filtered as though they were HTTP errors', async () => {
  const payload = { error: sentinel, nested: { business: encoded }, access_token: `access-${sentinel}` };
  const result = await fetchJson(endpoint, { fetchImpl: async () => Response.json(payload) });
  assert.equal(isDeepStrictEqual(result, payload), true);
});

test('successful ignoreBody keeps its existing no-JSON-read behavior', async () => {
  let reads = 0;
  const response = new Response(sentinel, { status: 200 });
  response.json = async () => { reads++; throw new Error(sentinel); };
  const result = await fetchJson(endpoint, { ignoreBody: true, fetchImpl: async () => response });
  assert.equal(result, null);
  assert.equal(reads, 0);
});

test('normal token success still returns its business token fields', async () => {
  const result = await exchangeCode({ tokenEndpoint: endpoint, code: 'synthetic-code', codeVerifier: 'synthetic-verifier',
    redirectUri: 'http://127.0.0.1:9/iam/callback', clientId: 'synthetic-client', fetchImpl: async () =>
      Response.json({ access_token: `access-${sentinel}`, refresh_token: `refresh-${sentinel}`, token_type: 'Bearer', expires_in: 300 }) });
  assert.equal(result.accessToken === `access-${sentinel}`, true);
  assert.equal(result.refreshToken === `refresh-${sentinel}`, true);
});

test('exact invalid_grant retains the existing IAM callback classification without leaking provider text', async (t) => {
  const credentials = new MemoryCredentials();
  const issuer = 'https://iam.corp.example';
  let requests = 0;
  const service = createIamService({ issuer, clientId: 'synthetic-client', authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: endpoint, jwksUri: `${issuer}/jwks`, redirectUri: 'http://127.0.0.1:9/iam/callback' }, {
    credentials, verifyAtomicStore: (candidate) => candidate === credentials,
    getOrigin: () => 'http://127.0.0.1:9', fetch: async (url) => {
      requests++;
      assert.equal(String(url), endpoint);
      return Response.json({ error: 'invalid_grant', error_description: sentinel, private: encoded }, { status: 400 });
    },
  });
  t.after(() => service.dispose());
  const started = await service.startSignIn();
  const callback = new URL('http://127.0.0.1:9/iam/callback');
  callback.searchParams.set('state', new URL(started.authorizationUrl).searchParams.get('state'));
  callback.searchParams.set('code', `code-${sentinel}`);
  const error = await service.handleCallback(callback.href).then(() => null, (failure) => failure);
  assert.equal(error?.code, 'IAM_INVALID_GRANT');
  assertNoPrivateOutput(error);
  assert.equal(requests, 1);
  assert.equal(service.getView().error, 'IAM_INVALID_GRANT');
  assert.equal(JSON.stringify(service.getView()).includes(sentinel), false);
  assert.equal(credentials.records.size, 0);
});
