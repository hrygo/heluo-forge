import test from 'node:test';
import assert from 'node:assert/strict';
import { revokeAccessToken } from '../src/oidc.mjs';

const endpoint = 'https://iam.example/idp/oauth2/revokeToken';

function respond(body, status = 200) {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('errcode 2002 is revoked whether the provider types it as a number or a string', async () => {
  for (const errcode of [2002, '2002']) {
    const result = await revokeAccessToken({
      revocationEndpoint: endpoint, accessToken: 'synthetic-at', fetchImpl: respond({ result: false, errcode }),
    });
    assert.deepEqual(result, { state: 'ok', code: 'IAM_REVOKE_ALREADY_INVALID' });
  }
});

test('a rejected revocation is failed, a 5xx is unknown, and an empty 200 is unconfirmed', async () => {
  const rejected = await revokeAccessToken({
    revocationEndpoint: endpoint, accessToken: 'synthetic-at',
    fetchImpl: respond({ result: false, errcode: 2001 }),
  });
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.code, 'IAM_REVOKE_REJECTED');

  const unavailable = await revokeAccessToken({
    revocationEndpoint: endpoint, accessToken: 'synthetic-at',
    fetchImpl: respond({ result: false }, 503),
  });
  assert.equal(unavailable.state, 'unknown');
  assert.equal(unavailable.code, 'IAM_REVOKE_HTTP_503');

  const empty = await revokeAccessToken({
    revocationEndpoint: endpoint, accessToken: 'synthetic-at',
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  assert.equal(empty.state, 'unknown');
  assert.equal(empty.code, 'IAM_REVOKE_UNCONFIRMED');
});

test('a hanging endpoint aborts at the timeout and stays unconfirmed', async () => {
  let observed;
  const fetchImpl = async (url, init) => {
    observed = { url: String(url), authorization: init.headers?.authorization ?? null, method: init.method };
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const result = await revokeAccessToken({
    revocationEndpoint: endpoint, accessToken: 'synthetic-at', fetchImpl, timeoutMs: 20,
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.code, 'IAM_REVOKE_UNREACHABLE');
  assert.equal(observed.method, 'GET');
  assert.equal(observed.authorization, null);
  assert.equal(new URL(observed.url).searchParams.get('access_token'), 'synthetic-at');
});
test('explicit RFC 7009 uses one form POST and treats ambiguous or late results as unknown', async () => {
  const { revokeSessionToken } = await import('../src/oidc.mjs');
  for (const [status, state] of [[200, 'ok'], [204, 'unknown'], [400, 'failed'], [408, 'unknown'], [429, 'unknown'], [503, 'unknown']]) {
    let requests = 0;
    const outcome = await revokeSessionToken({
      revocationMode: 'rfc7009', revocationEndpoint: endpoint,
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', clientId: 'synthetic-client',
      fetchImpl: async (url, request) => {
        requests++;
        assert.equal(String(url), endpoint);
        assert.equal(request.method, 'POST');
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('token'), 'synthetic-refresh');
        assert.equal(form.get('token_type_hint'), 'refresh_token');
        return new Response(null, { status });
      },
    });
    assert.equal(requests, 1);
    assert.equal(outcome.state, state, String(status));
  }

  for (const revocationMode of ['access_token_query', 'rfc7009']) {
    let release;
    const late = new Promise((resolve) => { release = resolve; });
    const keepAlive = setInterval(() => {}, 100);
    try {
      const outcome = await revokeSessionToken({
        revocationMode, revocationEndpoint: endpoint, accessToken: 'synthetic-access',
        clientId: 'synthetic-client', timeoutMs: 10, fetchImpl: () => late,
      });
      assert.equal(outcome.state, 'unknown');
      release(Response.json({ result: true }));
    } finally {
      clearInterval(keepAlive);
    }
  }
});
