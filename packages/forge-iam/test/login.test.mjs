import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/index.mjs';
import { validateConfig } from '../src/config.mjs';
import { createGrantStore } from '../src/store.mjs';
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
  assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
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

test('a rejected refresh clears credentials and requires re-authentication', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  mock.refreshTokens.clear();

  await assert.rejects(
    () => service.resolveToken(),
    (error) => error.code === 'IAM_REAUTH_REQUIRED',
  );
  assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.equal(service.getView().state, 'signed-out');
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
  assert.equal(await credentials.readRecord('heluo-iam/session'), undefined);
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
  credentials.deleteRecord = async () => { throw new Error('disk failure'); };

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

test('a failed refresh keeps serving an access token that has not expired yet', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const service = createIamService(configFor(mock), { credentials });
  const { location } = await authorize(service);
  await service.handleCallback(location);
  let failNetwork = false;
  const original = globalThis.fetch;
  const gated = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), {
    credentials,
    fetch: async (url, init) => {
      if (failNetwork) throw new Error('offline');
      return original(url, init);
    },
  });
  await gated.hydrate();
  failNetwork = true;
  const token = await gated.resolveToken();
  assert.equal(typeof token, 'string');
  assert.equal(gated.getView().state, 'unreachable');
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

test('a non-rotating refresh response does not discard the session when persistence fails', async (t) => {
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
  const service = createIamService(configFor(mock, { refreshSkewSeconds: 7200 }), {
    credentials,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      const isRefresh = String(init?.body ?? '').includes('grant_type=refresh_token');
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
  credentials.failWrites = true;
  const token = await service.resolveToken();
  assert.equal(token, 'access-1');
  const record = await credentials.readRecord('heluo-iam/session');
  assert.ok(record, 'the still-valid grant must not be cleared');
  assert.equal(service.getView().state, 'ready');
});
