import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { createServiceGrant } from '../src/service-grant.mjs';
import { createGrantStore } from '../src/store.mjs';
import { seedGateway } from './support/atomic-gateway.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

test('a running model call survives the original expiry when the same session can renew', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const deadline = Date.now() + 3000;
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(deadline).toISOString(),
    refreshExpiresAt: new Date(deadline + 60_000).toISOString(),
  });
  seedGateway(credentials, {
    value: `uag-${'a'.repeat(32)}`, ownerSubject: 'E1001', enteredAt: new Date().toISOString(),
  });
  const config = {
    ...oidc.endpoints, clientId: oidc.clientId, redirectUri: 'http://127.0.0.1:4567/iam/callback',
    refreshSkewSeconds: 1, defaultProvider: 'enterprise',
    managedModels: { baseURL: 'https://gateway.corp.example/v1' },
  };
  const service = createIamService(config, { credentials });
  const release = Promise.withResolvers();
  let adapter;
  const host = {
    llm: { registerAdapter(_providers, registered) { adapter = registered; return () => {}; } },
    on() { return () => {}; },
    emit() {},
  };
  await service.hydrate();
  const runtime = createManagedModelRuntime({
    host, iam: service, config,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] })),
    requestHeaders: async () => ({}),
    createAdapter: async ({ resolveKey }) => ({
      async prepareCall(provider, model) {
        return { model: { provider, id: model }, async *stream({ signal }) {
          await resolveKey();
          yield { type: 'text', text: 'started' };
          await release.promise;
          if (signal.aborted) throw new Error('request aborted');
          yield { type: 'finish', reason: { kind: 'stop' } };
        } };
      },
    }),
  });
  t.after(async () => { release.resolve(); await runtime.dispose(); await service.dispose(); await oidc.close(); });
  await runtime.ready;
  const request = { provider: 'enterprise', model: 'enterprise-chat', messages: [] };
  const prepared = await adapter.prepareCall(request.provider, request.model);
  const stream = prepared.stream(request);
  assert.equal((await stream.next()).value.text, 'started');

  await delay(Math.max(0, deadline - 250 - Date.now()));
  const refreshesBeforeExpiry = oidc.counts.refresh;
  await delay(Math.max(0, deadline + 150 - Date.now()));
  // Exercise the post-expiry recovery too: the previous implementation did
  // not renew in the background and then misclassified the prepared call.
  await service.getAccessToken();
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const result = (await stream.next()).value;
  assert.equal(result.reason.kind, 'stop', JSON.stringify(result));
  assert.equal(refreshesBeforeExpiry, 1, 'the running Host must renew before expiry without a view poll');
});

test('a rotated refresh token does not inherit the previous token deadline when the response omits it', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const grants = createServiceGrant({ config: { clientId: 'dsh', gatewayResource: '', scopes: ['openid'] }, now: () => now });
  const previous = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh',
    refreshToken: 'old', accessToken: 'old-access', scope: 'openid', obtainedAt: new Date(now).toISOString(),
    refreshExpiresAt: new Date(now + 1000).toISOString(),
  };
  const next = grants.grantFromToken(previous, { refreshToken: 'new', accessToken: 'new-access', expiresIn: 7200 }, previous.issuer, previous.obtainedAt);
  assert.equal(Object.hasOwn(next, 'refreshExpiresAt'), false);
  const bounded = grants.grantFromToken(previous, {
    refreshToken: 'new', accessToken: 'new-access', expiresIn: 7200, refreshExpiresIn: 7300,
  }, previous.issuer, previous.obtainedAt);
  assert.equal(bounded.refreshExpiresAt, new Date(now + 7_300_000).toISOString());
});

test('successive rotations remain usable when the issuer omits the new refresh-token lifetime', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock - 1).toISOString(),
    refreshExpiresAt: new Date(clock + 1000).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, { credentials, now: () => clock });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  await service.getAccessToken();
  clock += 31_000;
  await service.getAccessToken();
  assert.equal(oidc.counts.refresh, 2);
  assert.equal(service.getView().state, 'ready');
});

test('hydration renews a refresh-only grant without a token request', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', scope: 'openid', obtainedAt: new Date().toISOString(),
    refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && init?.method === 'POST') {
        entered.resolve();
        await release.promise;
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { release.resolve(); await service.dispose(); await oidc.close(); });
  assert.equal((await service.hydrate()).state, 'expired');
  let timer;
  await Promise.race([entered.promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('background refresh did not start')), 3000);
  })]).finally(() => clearTimeout(timer));
  release.resolve();
  const timeout = Date.now() + 3000;
  while (service.getView().state !== 'ready' && Date.now() < timeout) await delay(20);
  assert.equal(oidc.counts.refresh, 1);
  assert.equal(service.getView().state, 'ready');
});

test('a failed refresh claim is shared and can be retried after storage recovers', { timeout: 5000 }, async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + 120_000).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 60 }, { credentials, now: () => clock });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await service.dispose(); await oidc.close(); });
  assert.equal((await service.hydrate()).state, 'ready');
  clock += 100_000;
  const modify = credentials.modifyRecord.bind(credentials);
  let claims = 0;
  credentials.modifyRecord = async () => {
    claims += 1;
    entered.resolve();
    await release.promise;
    throw Object.assign(new Error('synthetic lock timeout'), { code: 'CRED_LOCK_TIMEOUT' });
  };
  const first = service.getAccessToken();
  await entered.promise;
  const second = service.getAccessToken();
  const pending = Promise.allSettled([first, second]);
  release.resolve();
  const results = await pending;
  assert.equal(claims, 1);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(results[0].reason.code, 'IAM_REAUTH_REQUIRED');
  assert.ok(results[0].reason === results[1].reason, 'both callers share the failed flight');
  assert.equal((await store.read()).grant.refreshOperation, undefined);
  assert.equal(oidc.counts.refresh, 0);

  credentials.modifyRecord = modify;
  assert.equal(typeof await service.getAccessToken(), 'string');
  assert.equal(oidc.counts.refresh, 1);
  assert.equal(service.getView().state, 'ready');
});

test('a refresh token that expires first is renewed before its own deadline', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 2400).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 }, { credentials });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const timeout = Date.now() + 2000;
  while (oidc.counts.refresh === 0 && Date.now() < timeout) await delay(20);
  assert.equal(oidc.counts.refresh, 1);
  assert.equal(service.getView().state, 'ready');
});

test('disposing the Host cancels scheduled renewal without changing the stored session', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const grant = { version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 1200).toISOString() };
  const store = createGrantStore(credentials);
  await store.write(grant);
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 }, { credentials });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  await service.dispose();
  await delay(800);
  assert.equal(oidc.counts.refresh, 0);
  assert.deepEqual((await store.read()).grant, grant);
});

test('a temporary preflight outage does not discard a valid session and is retried before expiry', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 5000).toISOString(),
  });
  let keyRequests = 0;
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 3 }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks') && ++keyRequests === 1) throw new Error('synthetic outage');
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const timeout = Date.now() + 5500;
  while (keyRequests === 0 && Date.now() < timeout) await delay(20);
  await delay(30);
  assert.equal(keyRequests, 1);
  assert.equal(oidc.counts.refresh, 0, 'no refresh request was sent during preflight');
  assert.equal(service.getView().state, 'ready');
  while (oidc.counts.refresh === 0 && Date.now() < timeout) await delay(20);
  assert.equal(oidc.counts.refresh, 1);
  assert.equal(service.getView().state, 'ready');
});

for (const [accessState, outage] of [['missing', 'network'], ['expired', 'network'], ['expired', 'HTTP 503']]) {
  test(`preflight failure after access expiry is retried automatically (${accessState} access, ${outage})`, async (t) => {
    const oidc = await startMockOidc({ accessTtl: 30 });
    const credentials = new MemoryCredentials();
    oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
    const grant = {
      version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
      refreshToken: 'synthetic-refresh', scope: 'openid', obtainedAt: new Date().toISOString(),
      refreshExpiresAt: new Date(Date.now() + 5000).toISOString(),
      ...(accessState === 'expired' ? {
        accessToken: 'expired-access', accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      } : {}),
    };
    const store = createGrantStore(credentials);
    await store.write(grant);
    let keyRequests = 0;
    const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
      redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 }, {
      credentials,
      fetch: async (url, init) => {
        if (String(url).endsWith('/jwks') && ++keyRequests === 1) {
          if (outage === 'HTTP 503') return Response.json({}, { status: 503 });
          throw new Error('synthetic outage');
        }
        return fetch(url, init);
      },
    });
    t.after(async () => { await service.dispose(); await oidc.close(); });
    await service.hydrate();
    const timeout = Date.now() + 4500;
    while (keyRequests === 0 && Date.now() < timeout) await delay(20);
    await delay(30);
    assert.equal(keyRequests, 1);
    assert.equal(oidc.counts.refresh, 0, 'the failed preflight did not send a refresh request');
    assert.equal(service.getView().state, 'expired');
    assert.deepEqual((await store.read()).grant, grant, 'the unconsumed refresh grant remains intact');
    while (oidc.counts.refresh === 0 && Date.now() < timeout) await delay(20);
    assert.equal(oidc.counts.refresh, 1, 'the Host retries without a view poll');
    while (service.getView().state !== 'ready' && Date.now() < timeout) await delay(20);
    assert.equal(service.getView().state, 'ready');
    assert.notEqual(await service.getAccessToken(), 'expired-access');
  });
}

for (const accessDeadline of ['later', 'same']) test(`a refresh token expiring ${accessDeadline === 'same' ? 'with' : 'before'} access is renewed when configured skew is zero`, async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  const now = Date.now();
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + (accessDeadline === 'same' ? 2400 : 30_000)).toISOString(),
    refreshExpiresAt: new Date(now + 2400).toISOString(),
  });
  let refreshSentAt;
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 0 }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && init?.method === 'POST') refreshSentAt = Date.now();
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const timeout = Date.now() + 2700;
  while (oidc.counts.refresh === 0 && Date.now() < timeout) await delay(20);
  assert.equal(oidc.counts.refresh, 1, 'refresh begins before the refresh token expires');
  assert.ok(refreshSentAt < now + 2400, 'the request was sent before the refresh token expired');
  while (service.getView().state !== 'ready' && Date.now() < timeout) await delay(20);
  assert.equal(service.getView().state, 'ready');
});

test('disposing an expired session cancels its scheduled preflight retry', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', scope: 'openid', obtainedAt: new Date().toISOString(),
    refreshExpiresAt: new Date(Date.now() + 2400).toISOString(),
  });
  let keyRequests = 0;
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks')) { keyRequests += 1; throw new Error('synthetic outage'); }
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const timeout = Date.now() + 1000;
  while (keyRequests === 0 && Date.now() < timeout) await delay(20);
  assert.equal(keyRequests, 1);
  await service.dispose();
  await delay(1400);
  assert.equal(keyRequests, 1);
  assert.equal(oidc.counts.refresh, 0);
});

test('view reconciliation does not bypass preflight backoff when access expires during the request', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  let keyRequests = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + 1000).toISOString(),
    refreshExpiresAt: new Date(clock + 60_000).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials, now: () => clock,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks')) {
        keyRequests += 1;
        started.resolve();
        await release.promise;
        throw new Error('synthetic outage');
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { release.resolve(); await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const attempt = service.getAccessToken();
  await started.promise;
  clock += 1500;
  release.resolve();
  await assert.rejects(attempt, { code: 'IAM_UNREACHABLE' });
  assert.equal(service.getView().state, 'expired');
  await service.syncFromStore();
  await delay(60);
  assert.equal(keyRequests, 1, 'background reconciliation honors the retry delay');
  assert.equal(oidc.counts.refresh, 0);
});

test('an unrelated view notification cannot shorten the preflight retry delay', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const requests = [];
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 1200).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks')) { requests.push(performance.now()); throw new Error('synthetic outage'); }
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  assert.equal(await service.getAccessToken(), 'synthetic-access');
  assert.equal(service.getView().state, 'ready');
  service.notifyView();
  await delay(1250);
  assert.ok(requests.length === 1 || requests[1] - requests[0] >= 950, 'notifications must not shorten the one-second retry delay');
  assert.equal(oidc.counts.refresh, 0);
});

test('zero skew does not make a still-valid access token expire with an older refresh token', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock - 5000).toISOString(), accessExpiresAt: new Date(clock + 500).toISOString(),
    refreshExpiresAt: new Date(clock - 1).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 0 }, { credentials, now: () => clock });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  assert.equal(await service.getAccessToken(), 'synthetic-access');
  clock += 501;
  await assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(oidc.counts.refresh, 0);
});

test('successive refreshes honor the discovery metadata cache lifetime', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  let discoveryRequests = 0;
  let newTokenEndpoint = false;
  const tokenPaths = [];
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + 10_000).toISOString(),
  });
  const service = createIamService({ issuer: oidc.issuer,
    discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials, now: () => clock,
    fetch: async (url, init) => {
      const address = String(url);
      if (address.endsWith('/.well-known/openid-configuration')) {
        discoveryRequests += 1;
        const document = await (await fetch(url, init)).json();
        if (newTokenEndpoint) document.token_endpoint = `${oidc.issuer}/token-new`;
        return Response.json(document);
      }
      if (address.endsWith('/token') || address.endsWith('/token-new')) {
        tokenPaths.push(new URL(address).pathname);
        const response = await fetch(`${oidc.issuer}/token`, init);
        const payload = await response.json();
        delete payload.id_token; // The test advances the local clock, not the mock issuer's clock.
        return Response.json(payload, { status: response.status });
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  await service.getAccessToken();
  clock += 31_000;
  await service.getAccessToken();
  assert.equal(discoveryRequests, 1, 'fresh metadata is reused');
  newTokenEndpoint = true;
  clock += 270_000;
  await service.getAccessToken();
  assert.equal(discoveryRequests, 2, 'expired metadata is fetched again before claiming the token');
  assert.deepEqual(tokenPaths, ['/token', '/token', '/token-new']);
});

test('a discovery outage after the cache expires does not claim or consume the refresh token', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 600 });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  let discoveries = 0;
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + 10_000).toISOString(),
  });
  const service = createIamService({ issuer: oidc.issuer,
    discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials, now: () => clock,
    fetch: async (url, init) => {
      if (String(url).endsWith('/.well-known/openid-configuration') && ++discoveries === 2) {
        throw new Error('synthetic outage');
      }
      if (String(url).endsWith('/token')) {
        const response = await fetch(url, init);
        const payload = await response.json();
        delete payload.id_token;
        return Response.json(payload, { status: response.status });
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  await service.getAccessToken();
  const previous = structuredClone((await store.read()).grant);
  clock += 541_000;
  assert.equal(await service.getAccessToken(), previous.accessToken, 'a still-valid access token is served while discovery backs off');
  assert.equal(oidc.counts.refresh, 1, 'the failed preflight made no refresh POST');
  assert.deepEqual((await store.read()).grant, previous);
  assert.equal(service.getView().state, 'ready');
  await service.getAccessToken();
  assert.equal(oidc.counts.refresh, 2);
  assert.equal(discoveries, 3);
});

test('a lost refresh response leaves pending and is never retried automatically', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30, dropRefreshResponse: true });
  const credentials = new MemoryCredentials();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 1800).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 }, { credentials });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const timeout = Date.now() + 2500;
  while ((oidc.counts.refresh === 0 || service.getView().state !== 'error') && Date.now() < timeout) await delay(20);
  assert.equal(service.getView().state, 'error');
  assert.equal((await credentials.readRecord('heluo-iam/session')).payload.refreshOperation.state, 'pending');
  await delay(600);
  assert.equal(oidc.counts.refresh, 1);
});

test('two running Hosts share one automatic refresh', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30, refreshDelayMs: 150 });
  const credentials = new MemoryCredentials();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 2400).toISOString(),
  });
  const config = { ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 };
  const first = createIamService(config, { credentials });
  const second = createIamService(config, { credentials });
  t.after(async () => { await first.dispose(); await second.dispose(); await oidc.close(); });
  await first.hydrate();
  await second.hydrate();
  const timeout = Date.now() + 3000;
  let stored;
  while (Date.now() < timeout) {
    stored = (await createGrantStore(credentials).read()).grant;
    if (stored?.refreshOperation?.state === 'complete'
      && first.getView().state === 'ready' && second.getView().state === 'ready'
      && first.getView().accessExpiresAt === stored.accessExpiresAt
      && second.getView().accessExpiresAt === stored.accessExpiresAt) break;
    await delay(20);
  }
  assert.equal(oidc.counts.refresh, 1);
  assert.equal(first.getView().state, 'ready');
  assert.equal(second.getView().state, 'ready');
  assert.equal(stored.refreshOperation.state, 'complete');
  assert.equal(first.getView().accessExpiresAt, stored.accessExpiresAt);
  assert.equal(second.getView().accessExpiresAt, stored.accessExpiresAt);
});

test('a view read joins this Host\'s own refresh without exposing a temporary sign-out', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 2500).toISOString(),
  });
  const config = { ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 };
  const service = createIamService(config, { credentials, fetch: async (url, init) => {
    if (String(url).endsWith('/token') && init?.method === 'POST') {
      entered.resolve();
      await release.promise;
    }
    return fetch(url, init);
  } });
  const observer = createIamService(config, { credentials });
  t.after(async () => { release.resolve(); await observer.dispose(); await service.dispose(); await oidc.close(); });
  await service.hydrate();
  let timer;
  await Promise.race([entered.promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('refresh did not start')), 4000);
  })]).finally(() => clearTimeout(timer));
  assert.notEqual((await observer.hydrate()).state, 'ready', 'another Host cannot assume the pending operation succeeded');
  let settled = false;
  const view = service.syncFromStore().finally(() => { settled = true; });
  await delay(50);
  assert.equal(settled, false, 'a view must wait for this Host\'s pending rotation');
  release.resolve();
  assert.equal((await view).state, 'ready');
  assert.equal(oidc.counts.refresh, 1);
});

test('adopting another process\'s renewed grant publishes its new deadline', async (t) => {
  const credentials = new MemoryCredentials();
  const config = { issuer: 'https://iam.corp.example', authorizationEndpoint: 'https://iam.corp.example/authorize',
    tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
    clientId: 'dsh', redirectUri: 'http://127.0.0.1:4567/iam/callback' };
  const grant = { version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, subject: 'E1001', clientId: config.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 120_000).toISOString() };
  const store = createGrantStore(credentials);
  await store.write(grant);
  const service = createIamService(config, { credentials });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await service.dispose(); });
  await service.hydrate();
  const events = service.watch(controller.signal);
  await events.next();
  const next = events.next();
  const newDeadline = new Date(Date.now() + 240_000).toISOString();
  await store.write({ ...grant, refreshToken: 'rotated-refresh', accessToken: 'rotated-access', accessExpiresAt: newDeadline });
  await service.syncFromStore();
  const result = await Promise.race([next, delay(100).then(() => null)]);
  assert.equal(result?.value?.accessExpiresAt, newDeadline);
  await events.return();
});
