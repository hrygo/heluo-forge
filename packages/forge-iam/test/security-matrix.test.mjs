// Security matrix for #13 AC2 / AC5 / AC7 that the existing suites do not pin:
//   1. an authorization code cannot be replayed through a second callback;
//   2. no observable surface (thrown message, view, persisted record) echoes a
//      code, verifier or token, even when the provider echoes them back;
//   3. RP-initiated logout produces the documented URL when the provider
//      advertises an end_session_endpoint;
//   4. every fail-closed path leaves the session non-ready with no grant, never
//      falling back to a static or official key.
// The mock IdP is a test double; nothing here is evidence about a real IAM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/index.mjs';
import { validateConfig } from '../src/config.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const SECRET_MARK = 'LEAKCANARY';

function configFor(mock, overrides = {}) {
  return validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true,
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
    ...overrides,
  }).value;
}

async function authorize(service) {
  const started = await service.startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return { started, location: response.headers.get('location') };
}

/** Wraps the real fetch and lets a test replace or break one endpoint. */
function scriptedFetch(routes) {
  const calls = [];
  const impl = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    for (const [needle, action] of Object.entries(routes)) {
      if (!url.includes(needle)) continue;
      if (action === 'throw') throw new TypeError(`connection refused: ${needle}`);
      if (typeof action === 'function') return action(url, init);
      if (action && typeof action === 'object') {
        return new Response(JSON.stringify(action.body ?? {}), {
          status: action.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return fetch(input, init);
  };
  return { impl, calls };
}

function tokenExchangeCount(calls) {
  return calls.filter((url) => url.includes('/token')).length;
}

function grantRecord(credentials) {
  return credentials.records.get('heluo-iam/session')?.payload;
}

function assertNoSecret(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const secret of secrets) {
    if (!secret) continue;
    assert.equal(
      text.includes(secret),
      false,
      `observable surface echoed a secret: ${text.slice(0, 200)}`,
    );
  }
}

test('a replayed authorization code cannot be exchanged twice', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const { impl, calls } = scriptedFetch({});
  const service = createIamService(configFor(mock), { credentials, fetch: impl });

  const { location } = await authorize(service);
  const view = await service.handleCallback(location);
  assert.equal(view.state, 'ready');
  const stored = grantRecord(credentials);
  const storedRefresh = stored.refreshToken;
  const exchanges = tokenExchangeCount(calls);
  assert.equal(exchanges, 1);

  // A second callback carrying the same code must be refused: the attempt was
  // consumed on success, so there is no verifier or state to match.
  await assert.rejects(() => service.handleCallback(location), (error) => {
    assert.equal(error.code, 'IAM_STATE_MISMATCH');
    return true;
  });
  assert.equal(tokenExchangeCount(calls), exchanges, 'a replay must not reach the token endpoint');
  assert.equal(grantRecord(credentials).refreshToken, storedRefresh, 'a replay must not rotate the grant');
  assert.equal(service.getView().state, 'ready');
});

test('provider responses that echo the code, verifier or tokens never reach a surface', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());

  // 1. The token endpoint rejects with an error body that mirrors the request.
  const credentials = new MemoryCredentials();
  const tokenEcho = scriptedFetch({
    '/token': (url, init) => {
      const body = init?.body?.toString?.() ?? '';
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: `rejected code ${SECRET_MARK}${body}`,
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    },
  });
  const rejecting = createIamService(configFor(mock), { credentials, fetch: tokenEcho.impl });
  const { location } = await authorize(rejecting);
  const verifier = new URL(location).searchParams.get('code') ?? SECRET_MARK;

  await assert.rejects(() => rejecting.handleCallback(location), (error) => {
    assertNoSecret(error.message, [SECRET_MARK, verifier]);
    assert.equal(error.code, 'IAM_INVALID_GRANT');
    return true;
  });
  assert.equal(rejecting.getView().state, 'error');
  assertNoSecret(rejecting.getView(), [SECRET_MARK, verifier]);
  assert.equal(grantRecord(credentials), undefined, 'a failed exchange must not persist a grant');

  // 2. A callback whose error_description carries a token-like value is
  //    sanitized instead of being interpolated into the message.
  const hostile = `http://127.0.0.1:4567/iam/callback?error=access_denied&error_description=${SECRET_MARK}`;
  await assert.rejects(() => rejecting.handleCallback(hostile), (error) => {
    assertNoSecret(error.message, [SECRET_MARK]);
    return true;
  });
});

test('RP-initiated logout builds the documented URL when the provider advertises one', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock, {
    logoutMode: 'rp',
    endSessionEndpoint: `${mock.issuer}/logout`,
    postLogoutRedirectUri: 'http://127.0.0.1:4567/iam/logged-out',
  }), { credentials });

  const { location } = await authorize(service);
  await service.handleCallback(location);
  assert.equal(service.getView().state, 'ready');
  const idToken = grantRecord(credentials).idToken;

  const result = await service.signOut();
  assert.equal(result.revocation, 'ok');
  assert.equal(result.view.state, 'signed-out');
  assert.ok(result.logoutUrl, 'a configured RP logout must produce a URL');
  const logout = new URL(result.logoutUrl);
  assert.equal(`${logout.origin}${logout.pathname}`, `${mock.issuer}/logout`);
  assert.equal(logout.searchParams.get('client_id'), mock.clientId);
  assert.equal(logout.searchParams.get('id_token_hint'), idToken);
  assert.equal(logout.searchParams.get('post_logout_redirect_uri'), 'http://127.0.0.1:4567/iam/logged-out');
  assert.equal(grantRecord(credentials), undefined, 'sign-out must clear the grant');
});

test('local logout still completes and stays attributable when revocation fails', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const { impl } = scriptedFetch({ '/revoke': { status: 503, body: { error: 'temporarily_unavailable' } } });
  const service = createIamService(configFor(mock, { logoutMode: 'local' }), { credentials, fetch: impl });

  const { location } = await authorize(service);
  await service.handleCallback(location);
  const result = await service.signOut();

  assert.equal(result.revocation, 'failed');
  assert.equal(result.revocationError, 'IAM_HTTP_ERROR');
  assert.equal(result.view.state, 'signed-out', 'local logout completes even when revocation fails');
  assert.equal(result.view.error, 'IAM_REVOCATION_FAILED', 'the unconfirmed revocation stays visible');
  assert.equal(grantRecord(credentials), undefined, 'the local grant is still cleared');
});

// Each fail-closed path must land on a non-ready state with no grant. None of
// them has a fallback to a static key or the official login: the plugin only
// ever reads the configured IAM endpoints, so a failure is a closed session.
const failClosedCases = [
  {
    name: 'IAM endpoint unreachable during the token exchange',
    routes: { '/token': 'throw' },
    expected: 'IAM_UNREACHABLE',
  },
  {
    name: 'JWKS does not publish the signing key',
    routes: { '/jwks': { status: 200, body: { keys: [] } } },
    expected: 'IAM_JWKS_KEY_NOT_FOUND',
  },
  {
    name: 'token endpoint answers 403',
    routes: { '/token': { status: 403, body: { error: 'invalid_client' } } },
    expected: 'IAM_HTTP_ERROR',
  },
  {
    name: 'token endpoint answers 429',
    routes: { '/token': { status: 429, body: { error: 'slow_down' } } },
    expected: 'IAM_HTTP_ERROR',
  },
];

for (const testCase of failClosedCases) {
  test(`fail closed: ${testCase.name}`, async (t) => {
    const mock = await startMockOidc();
    t.after(() => mock.close());
    const credentials = new MemoryCredentials();
    const { impl } = scriptedFetch(testCase.routes);
    const service = createIamService(configFor(mock), { credentials, fetch: impl });
    const { location } = await authorize(service);

    await assert.rejects(() => service.handleCallback(location), (error) => {
      assert.equal(error.code, testCase.expected);
      return true;
    });
    const view = service.getView();
    assert.notEqual(view.state, 'ready');
    assert.equal(view.principal, null, 'a failed sign-in must not report a principal');
    assert.equal(grantRecord(credentials), undefined, 'a failed sign-in must not persist a grant');
  });
}

test('fail closed: a storage write failure leaves the session signed out', async (t) => {
  const mock = await startMockOidc({ subject: 'E2002' });
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  credentials.modifyRecord = async () => {
    throw new Error('disk full');
  };
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);

  await assert.rejects(() => service.handleCallback(location));
  const view = service.getView();
  assert.notEqual(view.state, 'ready');
  assert.equal(view.principal, null);
  assert.equal(credentials.records.get('heluo-iam/session'), undefined);
});

test('fail closed: an unavailable callback origin refuses to start a sign-in', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const config = validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    allowInsecureHttp: true,
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
  }).value;
  const service = createIamService(config, { credentials, getOrigin: () => undefined });

  await assert.rejects(() => service.startSignIn(), (error) => {
    assert.equal(error.code, 'IAM_CALLBACK_UNAVAILABLE');
    return true;
  });
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(service.getView().principal, null);
});
