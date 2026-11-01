import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createIamService } from './support/trusted-service.mjs';
import { validateConfig } from '../src/config.mjs';
import { createGatewayCredentialStore, createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

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
  assert.equal(started.view.state, 'authenticating');
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return { started, location: response.headers.get('location') };
}

test('a callback write committed then reported failed is tombstoned and cannot hydrate', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  class CommitThenThrow extends MemoryCredentials {
    first = true;
    async modifyRecord(key, mutate) {
      const result = await super.modifyRecord(key, mutate);
      if (key === 'heluo-iam/session' && this.first) {
        this.first = false;
        throw new Error('synthetic lost commit acknowledgement');
      }
      return result;
    }
  }
  const credentials = new CommitThenThrow();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  await assert.rejects(service.handleCallback(location), { code: 'IAM_CREDENTIALS_CLEAR_FAILED' });
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
  assert.deepEqual(await createGrantStore(credentials).read(), { ok: true, grant: null });
  const restored = createIamService(configFor(mock), { credentials });
  assert.notEqual((await restored.hydrate()).state, 'ready');
});

test('authorization-code + PKCE completes and stores only a validated grant', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  const view = await service.handleCallback(location);
  assert.equal(view.state, 'ready');
  assert.equal(view.principal, 'E1001');
  const record = await credentials.readRecord('heluo-iam/session');
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.subject, 'E1001');
  assert.equal(record.payload.idToken, undefined);
  // V1 no longer derives a model credential from the IAM access token.
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
});

test('resolveToken refreshes a near-expiry access token and rotates the refresh token', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);

  const first = await service.resolveToken();
  assert.equal(first, 'access-2');
  const record = await credentials.readRecord('heluo-iam/session');
  assert.notEqual(record.payload.refreshToken, 'refresh-initial');
  assert.equal(record.payload.accessToken, 'access-2');
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.equal(service.getView().state, 'ready');
});

test('refresh preserves the callback session ID across pending and complete', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && String(init?.body).includes('grant_type=refresh_token')) {
        entered();
        await gate;
      }
      return fetch(url, init);
    },
  });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const initial = (await credentials.readRecord('heluo-iam/session')).payload;
  assert.match(initial.sessionInstanceId, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  const refresh = service.resolveToken();
  await waiting;
  const pending = (await credentials.readRecord('heluo-iam/session')).payload;
  assert.equal(pending.refreshOperation.state, 'pending');
  assert.equal(pending.sessionInstanceId, initial.sessionInstanceId);
  release();
  await refresh;
  const complete = (await credentials.readRecord('heluo-iam/session')).payload;
  assert.equal(complete.refreshOperation.state, 'complete');
  assert.equal(complete.sessionInstanceId, initial.sessionInstanceId);
});

test('a tombstoned pending grant cannot be revived by a late refresh completion', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && String(init?.body).includes('grant_type=refresh_token')) {
        const response = await fetch(url, init);
        entered();
        await gate;
        return response;
      }
      return fetch(url, init);
    },
  });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const original = (await credentials.readRecord('heluo-iam/session')).payload;
  const refresh = service.resolveToken();
  const rejected = assert.rejects(refresh, { code: 'IAM_REAUTH_REQUIRED' });
  await waiting;
  const pending = (await credentials.readRecord('heluo-iam/session')).payload;
  assert.equal(pending.refreshOperation.state, 'pending');
  assert.equal(pending.sessionInstanceId, original.sessionInstanceId);
  assert.equal((await createGrantStore(credentials, { verifyAtomicStore: (instance) => instance === credentials }).discardCallbackGrant(original)).ok, true);
  release();
  await rejected;
  assert.deepEqual(await createGrantStore(credentials).read(), { ok: true, grant: null });
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
});

test('login and refresh ID tokens bind at_hash to their corresponding access tokens', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let wrongHash = false;
  let refreshPhase = false;
  let jwksCalls = 0;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith('/jwks')) {
      jwksCalls += 1;
      return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: refreshPhase ? 'refresh-key' : 'login-key', use: 'sig' }] });
    }
    const response = await fetch(url, init);
    if (!String(url).endsWith('/token') || !response.ok) return response;
    const body = await response.json();
    const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8'));
    const access = wrongHash ? 'different-access-token' : body.access_token;
    claims.at_hash = createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: refreshPhase ? 'refresh-key' : 'login-key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    body.id_token = `${header}.${payload}.${signature}`;
    return Response.json(body);
  };

  const badCredentials = new MemoryCredentials();
  const badLogin = createIamService(configFor(mock), { credentials: badCredentials, fetch: fakeFetch });
  const badCallback = await authorize(badLogin);
  wrongHash = true;
  await assert.rejects(badLogin.handleCallback(badCallback.location), { code: 'IAM_ID_TOKEN_AT_HASH' });
  assert.equal(await badCredentials.readRecord('heluo-iam/session'), undefined);
  assert.equal(mock.counts.revoke, 1, 'a rejected ID token revokes only its issued refresh token once');
  assert.equal(mock.revoked.size, 1);

  wrongHash = false;
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), { credentials, fetch: fakeFetch });
  const { location } = await authorize(service);
  assert.equal((await service.handleCallback(location)).state, 'ready');
  refreshPhase = true;
  assert.equal(await service.resolveToken(), 'access-3');
  assert.equal(jwksCalls, 3, 'refresh retries with the newly rotated signing key');
  wrongHash = true;
  const beforeFailure = structuredClone(await credentials.readRecord('heluo-iam/session'));
  const beforeRequests = mock.counts.token;
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  const pending = await credentials.readRecord('heluo-iam/session');
  assert.equal(pending.payload.refreshOperation.state, 'pending');
  assert.deepEqual({ ...pending.payload, refreshOperation: beforeFailure.payload.refreshOperation }, beforeFailure.payload);
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(mock.counts.token, beforeRequests + 1);
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(mock.counts.token, beforeRequests + 1, 'a pending refresh must not be resent');
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), pending);
});

test('a second service hydrates a stored grant without exposing tokens', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const first = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(first);
  await first.handleCallback(location);

  const second = createIamService(configFor(mock), { credentials });
  const view = await second.hydrate();
  assert.equal(view.state, 'ready');
  assert.equal(view.principal, 'E1001');
  assert.equal('accessToken' in view, false);
  assert.equal('refreshToken' in view, false);
});

test('signOut clears the IAM record and revokes the refresh token', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const refreshToken = (await credentials.readRecord('heluo-iam/session')).payload.refreshToken;

  const result = await service.signOut();
  assert.equal(result.view.state, 'signed-out');
  assert.equal(result.logoutUrl, null);
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
  assert.equal((await createGrantStore(credentials).read()).grant, null);
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.equal(mock.revoked.has(refreshToken), true);
});

test('a mismatched callback state is rejected without signing in', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  await authorize(service);
  await assert.rejects(
    () => service.handleCallback('http://127.0.0.1:4567/iam/callback?code=x&state=wrong'),
    (error) => error.code === 'IAM_STATE_MISMATCH',
  );
  assert.equal(service.getView().state, 'authenticating');
  assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
});

test('callback requires the attempt redirect origin, path and port without consuming it', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  const { location } = await authorize(service);
  for (const mutate of [
    (url) => { url.port = '4568'; },
    (url) => { url.hostname = 'localhost'; },
    (url) => { url.pathname = '/other/callback'; },
    (url) => { url.protocol = 'https:'; },
  ]) {
    const wrong = new URL(location);
    mutate(wrong);
    await assert.rejects(service.handleCallback(wrong.href), { code: 'IAM_CALLBACK_INVALID' });
    assert.equal(service.getView().state, 'authenticating');
  }
  assert.equal(mock.counts.token, 0);
  assert.equal((await service.handleCallback(location)).state, 'ready');
  assert.equal(mock.counts.token, 1);
});

test('callback issuer is optional but must exactly match the metadata issuer if present', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  for (const issuer of [undefined, mock.issuer, `${mock.issuer}/`, 'https://evil.example']) {
    const credentials = new MemoryCredentials();
    const service = createIamService(configFor(mock), { credentials });
    const { location } = await authorize(service);
    const callback = new URL(location);
    if (issuer !== undefined) callback.searchParams.set('iss', issuer);
    const before = mock.counts.token;
    if (issuer === undefined || issuer === mock.issuer) {
      assert.equal((await service.handleCallback(callback.href)).state, 'ready');
      assert.equal(mock.counts.token, before + 1);
    } else {
      await assert.rejects(service.handleCallback(callback.href), { code: 'IAM_CALLBACK_ISSUER' });
      assert.equal(mock.counts.token, before);
      assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
    }
  }
});

test('invalid issuer and malformed authorization errors leave a valid attempt usable', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  const { location } = await authorize(service);
  const errorCallback = new URL(location);
  errorCallback.searchParams.delete('code');
  errorCallback.searchParams.set('error', 'access_denied');
  errorCallback.searchParams.set('iss', `${mock.issuer}/`);
  await assert.rejects(service.handleCallback(errorCallback.href), { code: 'IAM_CALLBACK_ISSUER' });
  errorCallback.searchParams.delete('iss');
  errorCallback.searchParams.append('state', errorCallback.searchParams.get('state'));
  await assert.rejects(service.handleCallback(errorCallback.href), { code: 'IAM_CALLBACK_INVALID' });
  assert.equal(service.getView().state, 'authenticating');
  assert.equal((await service.handleCallback(location)).state, 'ready');
});

test('an expired attempt rejects a callback without exchanging its code', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let clock = Date.now();
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials(), now: () => clock });
  const { location } = await authorize(service);
  clock += 31000;
  await assert.rejects(service.handleCallback(location), { code: 'IAM_ATTEMPT_EXPIRED' });
  assert.equal(mock.counts.token, 0);
  assert.equal(service.getView().state, 'error');
});

test('an attempt that expires during token exchange cannot persist a late grant', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let clock = Date.now();
  let entered;
  let release;
  const enteredToken = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), {
    credentials, now: () => clock,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token')) { entered(); await gate; }
      return fetch(url, init);
    },
  });
  const { location } = await authorize(service);
  const pending = service.handleCallback(location);
  const rejected = assert.rejects(pending, { code: 'IAM_ATTEMPT_EXPIRED' });
  await enteredToken;
  clock += 31000;
  release();
  await rejected;
  assert.equal(service.getView().state, 'error');
  assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
});

test('an expired attempt rejects an authorization error as expired', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let clock = Date.now();
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials(), now: () => clock });
  const { location } = await authorize(service);
  const callback = new URL(location);
  callback.searchParams.delete('code');
  callback.searchParams.set('error', 'access_denied');
  clock += 31000;
  await assert.rejects(service.handleCallback(callback.href), { code: 'IAM_ATTEMPT_EXPIRED' });
  assert.equal(service.getView().error, 'IAM_ATTEMPT_EXPIRED');
  assert.equal(mock.counts.token, 0);
});

test('a token failure after the attempt deadline is reported as expired', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let clock = Date.now();
  let entered;
  let release;
  const enteredToken = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), {
    credentials, now: () => clock,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token')) {
        entered();
        await gate;
        throw new Error('offline');
      }
      return fetch(url, init);
    },
  });
  const { location } = await authorize(service);
  const rejected = assert.rejects(service.handleCallback(location), { code: 'IAM_ATTEMPT_EXPIRED' });
  await enteredToken;
  clock += 31000;
  release();
  await rejected;
  assert.equal(service.getView().error, 'IAM_ATTEMPT_EXPIRED');
  assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
});

for (const tokenResult of ['success', 'failure']) {
  test(`real attempt timer preserves expired status after late token ${tokenResult}`, async (t) => {
    const mock = await startMockOidc();
    t.after(() => mock.close());
    let entered;
    let release;
    const enteredToken = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const credentials = new MemoryCredentials();
    const service = createIamService(configFor(mock, { attemptTimeoutSeconds: 1 }), {
      credentials,
      fetch: async (url, init) => {
        if (String(url).endsWith('/token')) {
          entered();
          await gate;
          if (tokenResult === 'failure') throw new Error('offline');
        }
        return fetch(url, init);
      },
    });
    const { location } = await authorize(service);
    const rejected = assert.rejects(service.handleCallback(location), { code: 'IAM_ATTEMPT_EXPIRED' });
    await enteredToken;
    const updates = service.watch();
    assert.equal((await updates.next()).value.state, 'authenticating');
    assert.equal((await updates.next()).value.error, 'IAM_ATTEMPT_EXPIRED');
    await updates.return();
    release();
    await rejected;
    assert.equal(service.getView().state, 'error');
    assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
  });
}

test('expiry while persisting a callback removes the late grant', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let clock = Date.now();
  let entered;
  let release;
  const written = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  class DelayedCredentials extends MemoryCredentials {
    async modifyRecord(key, mutate) {
      const result = await super.modifyRecord(key, mutate);
      if (key === 'heluo-iam/session' && result?.kind === 'grant') {
        entered();
        await gate;
      }
      return result;
    }
  }
  const credentials = new DelayedCredentials();
  const service = createIamService(configFor(mock), { credentials, now: () => clock });
  const { location } = await authorize(service);
  const rejected = assert.rejects(service.handleCallback(location), { code: 'IAM_ATTEMPT_EXPIRED' });
  await written;
  clock += 31000;
  release();
  await rejected;
  assert.deepEqual(await createGrantStore(credentials).read(), { ok: true, grant: null });
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
  assert.equal(service.getView().state, 'error');
});

test('callback preserves another account’s gateway value and metadata', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const value = `uag-${'a'.repeat(32)}`;
  await createGatewayCredentialStore(credentials).save({ value, ownerSubject: 'E1002', enteredAt: '2030-01-01T00:00:00.000Z' });
  const before = structuredClone(await credentials.readRecord('heluo-iam/gateway-credential'));
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  const view = await service.handleCallback(location);
  assert.equal(view.principal, 'E1001');
  assert.equal(view.gatewayCredential.state, 'owner-mismatch');
  assert.equal((await credentials.resolve('ENTERPRISE_STATIC_KEY')).value, value);
  assert.deepEqual(await credentials.readRecord('heluo-iam/gateway-credential'), before);
});

test('cancel during gateway read preserves its value and metadata and discards the callback grant', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let entered;
  let release;
  const reading = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  class DelayedGatewayCredentials extends MemoryCredentials {
    async readRecord(key) {
      if (key === 'heluo-iam/gateway-credential') { entered(); await gate; }
      return super.readRecord(key);
    }
  }
  const credentials = new DelayedGatewayCredentials();
  const value = `uag-${'b'.repeat(32)}`;
  await createGatewayCredentialStore(credentials).save({ value, ownerSubject: 'E1002', enteredAt: '2030-01-01T00:00:00.000Z' });
  const before = structuredClone(credentials.records.get('heluo-iam/gateway-credential'));
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  const rejected = assert.rejects(service.handleCallback(location), { code: 'IAM_ATTEMPT_CANCELLED' });
  await reading;
  const cancelled = await service.cancelSignIn();
  assert.equal(cancelled.state, 'signed-out');
  assert.equal(cancelled.principal, null, 'cancelled view must not expose an uncommitted principal');
  release();
  await rejected;
  assert.deepEqual(await createGrantStore(credentials).read(), { ok: true, grant: null });
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
  assert.equal((await credentials.resolve('ENTERPRISE_STATIC_KEY')).value, value);
  assert.deepEqual(await credentials.readRecord('heluo-iam/gateway-credential'), before);
  assert.equal(service.getView().state, 'signed-out');
});

test('cancelled callback reports a failed grant cleanup instead of signed-out success', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let entered;
  let release;
  const written = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  class FailedCleanupCredentials extends MemoryCredentials {
    calls = 0;
    async modifyRecord(key, mutate) {
      if (key === 'heluo-iam/session' && ++this.calls === 2) throw new Error('disk failure');
      const result = await super.modifyRecord(key, mutate);
      if (key === 'heluo-iam/session' && this.calls === 1) { entered(); await gate; }
      return result;
    }
  }
  const credentials = new FailedCleanupCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  const rejected = assert.rejects(service.handleCallback(location), { code: 'IAM_CREDENTIALS_CLEAR_FAILED' });
  await written;
  await service.cancelSignIn();
  release();
  await rejected;
  assert.equal(service.getView().state, 'error');
  assert.equal(service.getView().error, 'IAM_CREDENTIALS_CLEAR_FAILED');
  assert.ok(await credentials.readRecord('heluo-iam/session'), 'failed cleanup leaves a record');
});

test('a cancelled older callback cannot overwrite a later successful sign-in', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let entered;
  let release;
  const enteredToken = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && ++calls === 1) { entered(); await gate; }
      return fetch(url, init);
    },
  });
  const first = await authorize(service);
  const old = service.handleCallback(first.location);
  const rejected = assert.rejects(old, { code: 'IAM_ATTEMPT_CANCELLED' });
  await enteredToken;
  await service.cancelSignIn();
  const second = await authorize(service);
  assert.equal((await service.handleCallback(second.location)).state, 'ready');
  const stored = await credentials.readRecord('heluo-iam/session');
  release();
  await rejected;
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), stored);
  assert.equal(service.getView().state, 'ready');
});

for (const interruption of ['cancel-and-relogin', 'expire']) {
  test(`callback waiting for record lock rejects on ${interruption} without writing`, async (t) => {
    const mock = await startMockOidc();
    t.after(() => mock.close());
    let clock = Date.now();
    let entered;
    let release;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    class WaitingCredentials extends MemoryCredentials {
      first = true;
      writes = 0;
      async modifyRecord(key, mutate) {
        if (key === 'heluo-iam/session' && this.first) {
          this.first = false;
          entered();
          await gate;
        }
        return super.modifyRecord(key, async (current) => {
          const next = await mutate(current);
          if (key === 'heluo-iam/session' && next !== undefined) this.writes += 1;
          return next;
        });
      }
    }
    const credentials = new WaitingCredentials();
    const service = createIamService(configFor(mock), { credentials, now: () => clock });
    const first = await authorize(service);
    const old = service.handleCallback(first.location);
    const rejected = assert.rejects(old, {
      code: interruption === 'expire' ? 'IAM_ATTEMPT_EXPIRED' : 'IAM_ATTEMPT_CANCELLED',
    });
    await waiting;
    const issuedForOldAttempt = [...mock.refreshTokens.keys()][0];
    let expected;
    if (interruption === 'expire') {
      clock += 31000;
    } else {
      await service.cancelSignIn();
      const second = await authorize(service);
      assert.equal((await service.handleCallback(second.location)).state, 'ready');
      expected = structuredClone(await credentials.readRecord('heluo-iam/session'));
      assert.equal(expected.payload.accessToken, 'access-2');
    }
    release();
    await rejected;
    assert.equal(mock.counts.revoke, 1, 'an interrupted callback must attempt to revoke its own issued refresh token');
    assert.equal(mock.revoked.has(issuedForOldAttempt), true);
    if (expected) assert.equal(mock.revoked.has(expected.payload.refreshToken), false);
    assert.deepEqual(await credentials.readRecord('heluo-iam/session'), expected);
    assert.equal(credentials.writes, interruption === 'expire' ? 0 : 1);
    assert.equal(service.getView().state, interruption === 'expire' ? 'error' : 'ready');
    if (interruption === 'expire') assert.equal(service.getView().error, 'IAM_ATTEMPT_EXPIRED');
    else assert.equal(await service.resolveToken(), 'access-2');
  });
}

test('cancelling while discovery is pending aborts the sign-in', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let delayed = false;
  // Discovery-only config: the fetch is required because the explicit endpoints
  // are intentionally absent (a complete explicit config no longer fetches it).
  const service = createIamService(validateConfig({
    clientId: mock.clientId,
    discoveryUrl: `${mock.issuer}/.well-known/openid-configuration`,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true,
  }).value, {
    credentials: new MemoryCredentials(),
    fetch: async (url, init) => {
      if (!delayed && String(url).includes('.well-known')) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return fetch(url, init);
    },
  });
  const pending = service.startSignIn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const canceled = await service.cancelSignIn();
  assert.equal(canceled.state, 'signed-out');
  await assert.rejects(pending, (error) => error.code === 'IAM_ATTEMPT_CANCELLED');
});

test('a configured redirect URI must match the live web origin', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), {
    credentials: new MemoryCredentials(),
    getOrigin: () => 'http://127.0.0.1:9999',
  });
  await assert.rejects(
    () => service.startSignIn(),
    (error) => error.code === 'IAM_CONFIG_INVALID',
  );
});

test('cancel during the token exchange discards the late grant', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  let delayed = false;
  const service = createIamService(configFor(mock), {
    credentials,
    fetch: async (url, init) => {
      if (!delayed && String(url).endsWith('/token')) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return fetch(url, init);
    },
  });
  const { location } = await authorize(service);
  const pending = service.handleCallback(location);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const canceled = await service.cancelSignIn();
  assert.equal(canceled.state, 'signed-out');
  await assert.rejects(pending, (error) => error.code === 'IAM_ATTEMPT_CANCELLED');
  assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.equal(service.getView().state, 'signed-out');
});

test('concurrent startSignIn calls share one attempt', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  let delayed = false;
  // Discovery-only config: the fetch is required because the explicit endpoints
  // are intentionally absent (a complete explicit config no longer fetches it).
  const service = createIamService(validateConfig({
    clientId: mock.clientId,
    discoveryUrl: `${mock.issuer}/.well-known/openid-configuration`,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true,
  }).value, {
    credentials: new MemoryCredentials(),
    fetch: async (url, init) => {
      if (!delayed && String(url).includes('.well-known')) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return fetch(url, init);
    },
  });
  const [first, second] = await Promise.all([service.startSignIn(), service.startSignIn()]);
  assert.equal(first.authorizationUrl, second.authorizationUrl);
  assert.equal(service.getView().state, 'authenticating');
});

test('cancel returns to signed-out and clears the attempt', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const service = createIamService(configFor(mock), { credentials: new MemoryCredentials() });
  await authorize(service);
  const view = await service.cancelSignIn();
  assert.equal(view.state, 'signed-out');
  await assert.rejects(() => service.cancelSignIn().then((value) => {
    assert.equal(value.state, 'signed-out');
    throw new Error('no-op');
  }), /no-op/);
});
test('concurrent resolveToken calls share one refresh rotation', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);

  const [first, second] = await Promise.all([service.resolveToken(), service.resolveToken()]);
  assert.equal(first, 'access-2');
  assert.equal(second, 'access-2');
  const record = await credentials.readRecord('heluo-iam/session');
  assert.equal(record.payload.accessToken, 'access-2');
});

test('a rejected refresh retains pending and requires re-authentication without a retry', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const before = structuredClone(await credentials.readRecord('heluo-iam/session'));
  const beforeRequests = mock.counts.token;
  mock.refreshTokens.clear();

  await assert.rejects(
    () => service.resolveToken(),
    (error) => error.code === 'IAM_REAUTH_REQUIRED',
  );
  const pending = await credentials.readRecord('heluo-iam/session');
  assert.equal(pending.payload.refreshOperation.state, 'pending');
  assert.deepEqual({ ...pending.payload, refreshOperation: undefined }, { ...before.payload, refreshOperation: undefined });
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.notEqual(service.getView().state, 'ready');
  assert.equal(mock.counts.token, beforeRequests + 1);
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(mock.counts.token, beforeRequests + 1, 'invalid_grant must not trigger a retry');
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), pending);
});
test('signOut reports an unconfirmed revocation instead of claiming success', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/revoke')) return new Response('', { status: 500 });
      return fetch(url, init);
    },
  });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const result = await service.signOut();
  assert.equal(result.view.state, 'signed-out');
  assert.equal(result.view.error, 'IAM_REVOCATION_FAILED');
  assert.equal(result.revocation, 'failed');
  assert.equal(mock.revoked.size, 0);
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
  assert.equal((await createGrantStore(credentials).read()).grant, null);
  const afterSync = await service.syncFromStore();
  assert.equal(afterSync.error, 'IAM_REVOCATION_FAILED');
});

test('dispose releases runtime state without clearing the stored session', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const refreshToken = (await credentials.readRecord('heluo-iam/session')).payload.refreshToken;

  await service.dispose();
  assert.equal((await credentials.readRecord('heluo-iam/session')).payload.refreshToken, refreshToken);
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.equal(mock.revoked.has(refreshToken), false);
  assert.equal(service.getView().state, 'signed-out');

  const restored = createIamService(configFor(mock), { credentials });
  assert.equal((await restored.hydrate()).state, 'ready');
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  await service.dispose();
});
test('signOut does not claim success when the record cannot be cleared', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  credentials.modifyRecord = async () => { throw new Error('synthetic storage failure'); };

  const result = await service.signOut();
  assert.equal(result.view.state, 'error');
  assert.equal(result.logoutUrl, null);
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
});

test('a rotated signing key is retried once instead of failing the login', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  let jwksCalls = 0;
  const service = createIamService(configFor(mock), {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks')) {
        jwksCalls += 1;
        if (jwksCalls === 1) return Response.json({ keys: [] });
      }
      return fetch(url, init);
    },
  });
  const { location } = await authorize(service);
  const view = await service.handleCallback(location);
  assert.equal(view.state, 'ready');
  assert.equal(jwksCalls, 2);
});

test('a prefetch failure before a refresh claim does not send a POST or serve the old access token', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const before = structuredClone(await credentials.readRecord('heluo-iam/session'));
  const beforeRequests = mock.counts.token;
  let prefetchFailures = 0;
  let refreshPosts = 0;
  const gated = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && init?.method === 'POST') refreshPosts += 1;
      if (String(url).endsWith('/jwks')) {
        prefetchFailures += 1;
        throw new Error('offline');
      }
      return fetch(url, init);
    },
  });
  await gated.hydrate();
  await assert.rejects(gated.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(prefetchFailures, 1);
  assert.equal(refreshPosts, 0, 'prefetch failure precedes any refresh POST attempt');
  assert.equal(mock.counts.token, beforeRequests, 'prefetch failure precedes the refresh POST');
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), before);
  assert.equal(before.payload.refreshOperation, undefined);
  assert.notEqual(gated.getView().state, 'ready');
});

test('a lost refresh response leaves pending and cannot resend the token request', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const before = structuredClone(await credentials.readRecord('heluo-iam/session'));
  const beforeRequests = mock.counts.token;
  mock.control.dropRefreshResponse = true;

  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  const pending = await credentials.readRecord('heluo-iam/session');
  assert.equal(pending.payload.refreshOperation.state, 'pending');
  assert.deepEqual({ ...pending.payload, refreshOperation: undefined }, { ...before.payload, refreshOperation: undefined });
  assert.equal(mock.counts.token, beforeRequests + 1);
  assert.equal(mock.counts.refresh, 1, 'the server rotated before dropping the response');
  assert.notEqual(service.getView().state, 'ready');
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(mock.counts.token, beforeRequests + 1, 'an unknown result must not be retried');
  assert.deepEqual(await credentials.readRecord('heluo-iam/session'), pending);
});

test('the view poll refreshes an expired but refreshable session', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);

  // Force the access token past expiry while keeping the rotated refresh token usable.
  await createGrantStore(credentials).mutate((grant) => ({
    ...grant,
    accessExpiresAt: '2000-01-01T00:00:00.000Z',
  }));
  await service.syncFromStore();
  for (let attempt = 0; attempt < 100 && service.getView().state !== 'ready'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const view = service.getView();
  assert.equal(view.state, 'ready');
  const record = await credentials.readRecord('heluo-iam/session');
  assert.notEqual(record.payload.accessToken, 'access-1');
  assert.ok(record.payload.accessExpiresAt > '2020-01-01');
});

test('a failed refresh claim preserves the grant without a POST or old access token fallback', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  class FailingWriteCredentials extends MemoryCredentials {
    constructor() {
      super();
      this.failWrites = false;
    }

    async modifyRecord(key, mutate) {
      if (this.failWrites && key === 'heluo-iam/session') {
        const error = new Error('disk full');
        error.code = 'EIO';
        throw error;
      }
      return super.modifyRecord(key, mutate);
    }
  }
  const credentials = new FailingWriteCredentials();
  let refreshPosts = 0;
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), {
    credentials,
    fetch: async (url, init) => {
      const isRefresh = String(init?.body ?? '').includes('grant_type=refresh_token');
      if (isRefresh && String(url).endsWith('/token')) refreshPosts += 1;
      const response = await fetch(url, init);
      if (isRefresh && String(url).endsWith('/token')) {
        const body = await response.json();
        delete body.refresh_token;
        return { ok: true, status: 200, json: async () => body };
      }
      return response;
    },
  });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  const before = structuredClone(await credentials.readRecord('heluo-iam/session'));
  const beforeRequests = mock.counts.token;
  credentials.failWrites = true;
  await assert.rejects(service.resolveToken(), { code: 'IAM_REAUTH_REQUIRED' });
  const record = await credentials.readRecord('heluo-iam/session');
  assert.ok(record, 'the still-valid grant must not be cleared');
  assert.deepEqual(record, before, 'the failed claim did not write pending');
  assert.equal(record.payload.refreshOperation, undefined);
  assert.equal(refreshPosts, 0, 'an unconfirmed claim must not attempt a refresh POST');
  assert.equal(mock.counts.token, beforeRequests, 'an unconfirmed claim must not send a refresh POST');
  assert.notEqual(service.getView().state, 'ready');
});
