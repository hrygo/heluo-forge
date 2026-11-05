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
