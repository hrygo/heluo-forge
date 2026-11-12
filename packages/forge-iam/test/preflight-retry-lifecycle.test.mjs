import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrantStore } from '../src/store.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

for (const expired of [false, true]) test(`an adopted rotation does not inherit the old token backoff (${expired ? 'expired' : 'valid'} access)`, async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const time = Date.now();
  let keyRequests = 0;
  const posted = [];
  const original = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'refresh-a', accessToken: 'access-a', scope: 'openid',
    obtainedAt: new Date(time).toISOString(), accessExpiresAt: new Date(time + 10_000).toISOString(),
    refreshExpiresAt: new Date(time + 120_000).toISOString(),
  };
  oidc.refreshTokens.set('refresh-a', { subject: 'E1001' });
  oidc.refreshTokens.set('refresh-b', { subject: 'E1001' });
  await store.write(original);
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 60 }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks') && ++keyRequests === 1) throw new Error('synthetic outage');
      if (String(url).endsWith('/token') && init?.method === 'POST') {
        posted.push(new URLSearchParams(init.body).get('refresh_token'));
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  assert.equal(await service.getAccessToken(), 'access-a', 'a still-valid access token is served while renewal backs off');
  const id = Buffer.alloc(32, 7).toString('base64url');
  const deadline = Date.now() + (expired ? -100 : 2000);
  await store.write({ ...original, refreshToken: 'refresh-b', accessToken: 'access-b',
    accessExpiresAt: new Date(deadline).toISOString(),
    refreshOperation: { version: 1, state: 'complete', id, base: refreshBaseId(original, id) } });
  await service.syncFromStore();
  const timeout = expired ? Date.now() + 1000 : deadline - 100;
  while (posted.length === 0 && Date.now() < timeout) await delay(20);
  assert.deepEqual(posted, ['refresh-b'], 'only the adopted token is renewed without inheriting the old backoff');
});

test('a rotation with unchanged deadlines still schedules its new refresh token', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const time = Date.now();
  const original = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'refresh-a', accessToken: 'access-a', scope: 'openid',
    obtainedAt: new Date(time).toISOString(), accessExpiresAt: new Date(time + 2200).toISOString(),
    refreshExpiresAt: new Date(time + 120_000).toISOString(),
  };
  oidc.refreshTokens.set('refresh-b', { subject: 'E1001' });
  await store.write(original);
  const posted = [];
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/token') && init?.method === 'POST') {
        posted.push(new URLSearchParams(init.body).get('refresh_token'));
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const id = Buffer.alloc(32, 8).toString('base64url');
  await store.write({ ...original, refreshToken: 'refresh-b', accessToken: 'access-b',
    refreshOperation: { version: 1, state: 'complete', id, base: refreshBaseId(original, id) } });
  await service.syncFromStore();
  const timeout = time + 2100;
  while (posted.length === 0 && Date.now() < timeout) await delay(20);
  assert.deepEqual(posted, ['refresh-b'], 'the current token is renewed despite unchanged deadlines');
});

test('a view notification after access expires preserves the scheduled preflight retry', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 30 });
  const credentials = new MemoryCredentials();
  let clock = Date.now();
  let keyRequests = 0;
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + 800).toISOString(),
    refreshExpiresAt: new Date(clock + 10_000).toISOString(),
  });
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials, now: () => clock,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks') && ++keyRequests === 1) throw new Error('synthetic outage');
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  assert.equal(await service.getAccessToken(), 'synthetic-access');
  clock += 850;
  assert.equal(service.notifyView().state, 'expired');
  clock += 250;
  const timeout = Date.now() + 1800;
  while (oidc.counts.refresh === 0 && Date.now() < timeout) await delay(20);
  assert.equal(oidc.counts.refresh, 1, 'the retry still runs after the original access expiry');
  while (service.getView().state !== 'ready' && Date.now() < timeout) await delay(20);
  assert.equal(service.getView().state, 'ready');
  assert.notEqual(await service.getAccessToken(), 'synthetic-access');
});

test('a replacement session does not inherit the previous session preflight backoff', async (t) => {
  const oidc = await startMockOidc({ subject: 'E2002', accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const now = Date.now();
  let keyRequests = 0;
  oidc.refreshTokens.set('refresh-a', { subject: 'E1001' });
  oidc.refreshTokens.set('refresh-b', { subject: 'E2002' });
  const grant = (subject, refreshToken) => ({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject, clientId: oidc.clientId, refreshToken, scope: 'openid',
    obtainedAt: new Date(now).toISOString(), refreshExpiresAt: new Date(now + 10_000).toISOString(),
  });
  await store.write(grant('E1001', 'refresh-a'));
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks') && ++keyRequests === 1) throw new Error('synthetic outage');
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const failureDeadline = Date.now() + 1000;
  while (keyRequests === 0 && Date.now() < failureDeadline) await delay(20);
  await delay(30);
  assert.equal(keyRequests, 1);
  assert.equal(service.getView().state, 'expired');
  await store.write(grant('E2002', 'refresh-b'));
  await service.syncFromStore();
  const recoveryDeadline = Date.now() + 1000;
  while (oidc.counts.refresh === 0 && Date.now() < recoveryDeadline) await delay(20);
  assert.equal(oidc.counts.refresh, 1, 'the newly adopted session starts its own recovery');
  while (service.getView().state !== 'ready' && Date.now() < recoveryDeadline) await delay(20);
  assert.equal(service.getView().principal, 'E2002');
  assert.equal(service.getView().state, 'ready');
});

test('an old recovery timer does not refresh a replacement session in the same store', async (t) => {
  const oidc = await startMockOidc({ subject: 'E2002', accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const now = Date.now();
  let keyRequests = 0;
  oidc.refreshTokens.set('refresh-a', { subject: 'E1001' });
  oidc.refreshTokens.set('refresh-b', { subject: 'E2002' });
  const grant = (subject, refreshToken, ttl) => ({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject, clientId: oidc.clientId, refreshToken, scope: 'openid',
    obtainedAt: new Date(now).toISOString(), refreshExpiresAt: new Date(now + ttl).toISOString(),
  });
  await store.write(grant('E1001', 'refresh-a', 2400));
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks') && ++keyRequests === 1) throw new Error('synthetic outage');
      return fetch(url, init);
    },
  });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  await service.hydrate();
  const failureDeadline = Date.now() + 1000;
  while (keyRequests === 0 && Date.now() < failureDeadline) await delay(20);
  await delay(30);
  const replacement = grant('E2002', 'refresh-b', 10_000);
  await store.write(replacement);
  await delay(1600);
  assert.equal(oidc.counts.refresh, 0, 'the old timer must not claim the replacement session');
  assert.deepEqual((await store.read()).grant, replacement);
  await service.syncFromStore();
  const recoveryDeadline = Date.now() + 1000;
  while (oidc.counts.refresh === 0 && Date.now() < recoveryDeadline) await delay(20);
  assert.equal(oidc.counts.refresh, 1, 'the replacement session can recover after adoption');
});

test('replacing a session during retry preflight does not strand the replacement', async (t) => {
  const oidc = await startMockOidc({ subject: 'E2002', accessTtl: 30 });
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const now = Date.now();
  let keyRequests = 0;
  const retryStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  oidc.refreshTokens.set('refresh-a', { subject: 'E1001' });
  oidc.refreshTokens.set('refresh-b', { subject: 'E2002' });
  const grant = (subject, refreshToken, ttl) => ({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: oidc.issuer, subject, clientId: oidc.clientId, refreshToken, scope: 'openid',
    obtainedAt: new Date(now).toISOString(), refreshExpiresAt: new Date(now + ttl).toISOString(),
  });
  await store.write(grant('E1001', 'refresh-a', 2400));
  const service = createIamService({ ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks')) {
        keyRequests += 1;
        if (keyRequests === 1) throw new Error('synthetic outage');
        if (keyRequests === 2) { retryStarted.resolve(); await release.promise; }
      }
      return fetch(url, init);
    },
  });
  t.after(async () => { release.resolve(); await service.dispose(); await oidc.close(); });
  await service.hydrate();
  await retryStarted.promise;
  const replacement = grant('E2002', 'refresh-b', 10_000);
  await store.write(replacement);
  release.resolve();
  await delay(100);
  assert.equal(oidc.counts.refresh, 0);
  assert.deepEqual((await store.read()).grant, replacement);
  assert.notEqual(service.getView().state, 'error');
  await service.syncFromStore();
  const timeout = Date.now() + 1000;
  while (oidc.counts.refresh === 0 && Date.now() < timeout) await delay(20);
  assert.equal(oidc.counts.refresh, 1);
});
