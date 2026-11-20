import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareClientAuthentication, buildClientAuthRequest, isClientAuthReadLockTimeout, withCurrentClientAuth } from '../src/client-auth.mjs';
import { exchangeCode, refreshTokens, revokeToken, revokeSessionToken, buildAuthorizationUrl } from '../src/oidc.mjs';
import { createClientSecretFixture } from './support/client-secret-source.mjs';

const endpoint = 'https://iam.corp.example/token';
const clientId = 'c: +é';
const secret = 's: +é ';
const basic = `Basic ${Buffer.from('c%3A+%2B%C3%A9:s%3A+%2B%C3%A9+').toString('base64')}`;
const calls = [
  ['code', (fetchImpl, clientAuthentication, target = endpoint) => exchangeCode({ tokenEndpoint: target, code: 'synthetic-code',
    codeVerifier: 'synthetic-verifier', redirectUri: 'http://127.0.0.1:9/iam/callback', clientId, fetchImpl, clientAuthentication })],
  ['refresh', (fetchImpl, clientAuthentication, target = endpoint) => refreshTokens({ tokenEndpoint: target,
    refreshToken: 'synthetic-refresh', clientId, fetchImpl, clientAuthentication })],
  ['revoke', (fetchImpl, clientAuthentication, target = endpoint) => revokeToken({ revocationEndpoint: target,
    token: 'synthetic-refresh', clientId, fetchImpl, clientAuthentication })],
];

test('cancelling revocation while the pin read waits prevents dispatch', async () => {
  const fixture = createClientSecretFixture({}, { clientId });
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let pause = false;
  const source = {
    ...fixture.source,
    async retryRead(_snapshot, check) {
      if (!pause) return check();
      waiting.resolve();
      await release.promise;
      try { return check(); } finally { finished.resolve(); }
    },
  };
  const clientAuthentication = await prepareClientAuthentication(fixture.config, {
    ...fixture.options,
    getClientSecretSource: () => source,
    verifyClientSecretSource: (credentials, candidate, scope) => candidate === source
      && fixture.options.verifyClientSecretSource(credentials, fixture.source, scope),
  });
  pause = true;
  const controller = new AbortController();
  let posts = 0;
  const pending = revokeSessionToken({ revocationMode: 'rfc7009', revocationEndpoint: endpoint,
    refreshToken: 'synthetic-refresh', clientId, clientAuthentication, signal: controller.signal,
    fetchImpl: async () => { posts++; return new Response(null, { status: 200 }); },
  });
  await waiting.promise;
  controller.abort();
  release.resolve();
  assert.deepEqual(await pending, { state: 'unknown', code: 'IAM_REVOKE_CANCELLED' });
  await finished.promise;
  assert.equal(posts, 0);
});

test('only the exhausted pin read identifies an action as unsent', async () => {
  const fixture = createClientSecretFixture({}, { clientId });
  const timeout = Object.assign(new Error('synthetic private SQLite message'), { code: 'CRED_LOCK_TIMEOUT' });
  let blocked = false;
  let lateCheck;
  const source = {
    ...fixture.source,
    isCurrent(snapshot) {
      if (blocked) throw Object.assign(new Error('synthetic busy'), { errcode: 5 });
      return fixture.source.isCurrent(snapshot);
    },
    async retryRead(_snapshot, check) {
      if (!blocked) return check();
      lateCheck = check;
      try { return check(); } catch (cause) {
        if (cause.errcode === 5) throw timeout;
        throw cause;
      }
    },
  };
  const authentication = await prepareClientAuthentication(fixture.config, {
    ...fixture.options,
    getClientSecretSource: () => source,
    verifyClientSecretSource: (credentials, candidate, scope) => candidate === source
      && fixture.options.verifyClientSecretSource(credentials, fixture.source, scope),
  });
  let starts = 0;
  blocked = true;
  await assert.rejects(withCurrentClientAuth(authentication, () => { starts++; }), (cause) => {
    assert.equal(isClientAuthReadLockTimeout(cause), true);
    assert.equal(cause.constructor, Error);
    assert.equal(cause.code, 'CRED_LOCK_TIMEOUT');
    assert.notEqual(cause.message, timeout.message);
    return true;
  });
  blocked = false;
  assert.throws(lateCheck, { code: 'IAM_CLIENT_AUTH_CHANGED' });
  assert.equal(starts, 0);
  await assert.rejects(withCurrentClientAuth(authentication, () => {
    starts++;
    throw timeout;
  }), (cause) => cause === timeout && !isClientAuthReadLockTimeout(cause));
  assert.equal(starts, 1);
});

for (const method of ['none', 'client_secret_basic', 'client_secret_post']) {
  for (const [kind, invoke] of calls) {
    test(`${kind} applies exactly one ${method} authentication and keeps the request protocol`, async () => {
      const f = createClientSecretFixture({}, { clientId, value: secret, method });
      const operation = method === 'none' ? undefined : await prepareClientAuthentication(f.config, f.options);
      let requests = 0;
      await invoke(async (url, init) => {
        requests++;
        assert.equal(String(url), endpoint);
        assert.equal(String(url).includes(secret), false);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.signal instanceof AbortSignal, true);
        const form = new URLSearchParams(init.body);
        assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
        if (method === 'client_secret_basic') {
          assert.equal(init.headers.authorization === basic, true);
          assert.equal(form.has('client_id'), false);
          assert.equal(form.has('client_secret'), false);
        } else {
          assert.equal(init.headers.authorization, undefined);
          assert.equal(form.get('client_id') === clientId, true);
          assert.equal(form.has('client_secret'), method === 'client_secret_post');
          if (method === 'client_secret_post') assert.equal(form.get('client_secret') === secret, true);
        }
        if (kind === 'code') {
          assert.equal(form.get('code_verifier'), 'synthetic-verifier');
          assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:9/iam/callback');
        }
        return kind === 'revoke' ? new Response('', { status: 200 }) : Response.json({
          access_token: 'synthetic-access', refresh_token: 'synthetic-next', token_type: 'Bearer', expires_in: 300,
        });
      }, operation);
      assert.equal(requests, 1);
      if (method === 'none') assert.equal(f.counts.read, 0);
    });
  }
}

for (const [kind, invoke] of calls) {
  test(`${kind} accepts HTTP for public authentication and explicitly opted-in confidential authentication`, async () => {
    const target = endpoint.replace('https:', 'http:');
    for (const method of ['none', 'client_secret_basic', 'client_secret_post']) {
      const f = createClientSecretFixture({}, { clientId, value: secret, method });
      const config = method === 'none' ? { clientId, allowInsecureHttp: true } : { ...f.config, allowInsecureClientAuthHttp: true };
      const operation = await prepareClientAuthentication(config, f.options);
      let requests = 0;
      await invoke(async (url, init) => {
        requests++;
        assert.equal(url, target);
        assert.equal(init.redirect, 'error');
        const form = new URLSearchParams(init.body);
        assert.equal(init.headers.authorization === basic, method === 'client_secret_basic');
        assert.equal(form.get('client_secret') === secret, method === 'client_secret_post');
        return kind === 'revoke' ? new Response(null, { status: 200 })
          : Response.json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 300 });
      }, operation, target);
      assert.equal(requests, 1);
    }
  });

  test(`${kind} refuses raw secret/options pretending to be an authenticated operation`, async () => {
    let requests = 0;
    await assert.rejects(invoke(async () => { requests++; }, { method: 'client_secret_basic', secret, guard: () => true }),
      { code: 'IAM_CLIENT_AUTH_UNVERIFIED' });
    assert.equal(requests, 0);
  });
  test(`${kind} checks source immediately before fetch and does not wrap local change as a network error`, async () => {
    const f = createClientSecretFixture({}, { clientId, value: secret });
    const operation = await prepareClientAuthentication(f.config, f.options);
    f.replace('synthetic-new-secret');
    let requests = 0;
    await assert.rejects(invoke(async () => { requests++; }, operation), { code: 'IAM_CLIENT_AUTH_CHANGED' });
    assert.equal(requests, 0);
  });
}

test('pure construction neither mutates the caller form nor permits duplicate credential parameters', async () => {
  const f = createClientSecretFixture({}, { clientId, value: secret });
  const operation = await prepareClientAuthentication(f.config, f.options);
  const form = new URLSearchParams({ grant_type: 'refresh_token', resource: 'https://gateway.corp.example' });
  const before = form.toString();
  const request = buildClientAuthRequest(clientId, form, operation);
  assert.equal(form.toString(), before);
  assert.equal(request.headers.authorization === basic, true);
  for (const field of ['client_id', 'client_secret']) {
    assert.throws(() => buildClientAuthRequest(clientId, new URLSearchParams({ [field]: 'override' }), operation),
      { code: 'IAM_CONFIG_INVALID' });
  }
  assert.throws(() => buildClientAuthRequest('other-client', form, operation), { code: 'IAM_CLIENT_AUTH_CONTEXT_INVALID' });
});

test('a refused HTTP revocation is reported as failed locally and never attempts transport', async () => {
  const f = createClientSecretFixture({}, { clientId, value: secret });
  const operation = await prepareClientAuthentication(f.config, f.options);
  let requests = 0;
  const result = await revokeSessionToken({ revocationEndpoint: endpoint.replace('https:', 'http:'),
    revocationMode: 'rfc7009', refreshToken: 'synthetic-refresh', clientId, clientAuthentication: operation,
    fetchImpl: async () => { requests++; return new Response(null, { status: 200 }); },
  });
  assert.deepEqual(result, { state: 'failed', code: 'IAM_REVOKE_ENDPOINT_INVALID' });
  assert.equal(requests, 0);
});

for (const change of ['issuer', 'clientId', 'ref', 'revision', 'value', 'source', 'credentials']) {
  test(`dispatch refuses ${change} mutation even when source isCurrent claims true`, async () => {
    const f = createClientSecretFixture({}, { clientId, value: secret });
    const original = { ...f.snapshot() };
    const source = { read: async () => original, isCurrent: () => true };
    let currentSource = source;
    let currentCredentials = f.options.credentials;
    const options = { ...f.options, getClientSecretSource: () => currentSource,
      getCredentials: () => currentCredentials,
      verifyClientSecretSource: (credentials, candidate, scope) => credentials === f.options.credentials && candidate === source
        && scope.issuer === f.binding.issuer && scope.clientId === clientId && scope.ref === f.binding.ref
        && scope.method === 'client_secret_basic' };
    const operation = await prepareClientAuthentication(f.config, options);
    if (change === 'source') currentSource = { ...source };
    else if (change === 'credentials') currentCredentials = {};
    else original[change] += '-changed';
    let requests = 0;
    await assert.rejects(refreshTokens({ tokenEndpoint: endpoint, refreshToken: 'synthetic-refresh', clientId,
      clientAuthentication: operation, fetchImpl: async () => { requests++; } }), { code: 'IAM_CLIENT_AUTH_CHANGED' });
    assert.equal(requests, 0);
  });
}

test('Chinese client id and secret use independent UTF-8 form encoding before Basic', async () => {
  const f = createClientSecretFixture({}, { clientId: '客 户:+', value: '密 码:+' });
  const operation = await prepareClientAuthentication(f.config, f.options);
  const request = buildClientAuthRequest(f.config.clientId, new URLSearchParams({ grant_type: 'refresh_token' }), operation);
  const expected = Buffer.from('%E5%AE%A2+%E6%88%B7%3A%2B:%E5%AF%86+%E7%A0%81%3A%2B', 'utf8').toString('base64');
  assert.equal(request.headers.authorization === `Basic ${expected}`, true);
  assert.equal(new URLSearchParams(request.body).has('client_secret'), false);
});

test('an authenticated helper still leaves the authorization URL secret-free and mandatory S256', () => {
  const url = new URL(buildAuthorizationUrl({ authorizationEndpoint: 'https://iam.corp.example/authorize', clientId,
    redirectUri: 'http://127.0.0.1:9/iam/callback', scopes: ['openid'], state: 'synthetic-state', nonce: 'synthetic-nonce',
    codeChallenge: 'synthetic-challenge' }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.href.includes(basic), false);
});
