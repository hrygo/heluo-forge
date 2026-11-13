import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../src/index.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const issuer = 'https://iam.corp.example';
const config = {
  issuer, authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`,
  jwksUri: `${issuer}/jwks`, clientId: 'dsh', refreshSkewSeconds: 1,
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

function host(initial = {}) {
  const mounted = new Map(Object.entries(initial));
  const injections = new Map();
  const fallback = new Map();
  const ctx = {
    get(name) {
      if (mounted.has(name)) throw new Error('service requires injection');
      return fallback.get(name);
    },
    provide(name, value) { mounted.set(name, value); return () => mounted.delete(name); },
    effect(fn) { return fn(); },
    inject(names, callback) {
      if (names.length !== 1) return () => {};
      const name = names[0];
      const entry = { callback, cleanup: undefined };
      injections.set(name, entry);
      if (mounted.has(name)) entry.cleanup = callback({ [name]: mounted.get(name) });
      return () => {
        entry.cleanup?.();
        if (injections.get(name) === entry) injections.delete(name);
      };
    },
  };
  return {
    ctx,
    service: () => mounted.get('iam'),
    setFallback(name, value) { fallback.set(name, value); },
    mount(name, value) {
      const entry = injections.get(name);
      entry?.cleanup?.();
      mounted.set(name, value);
      if (entry) entry.cleanup = entry.callback({ [name]: value });
    },
    unmount(name) {
      const entry = injections.get(name);
      entry?.cleanup?.();
      if (entry) entry.cleanup = undefined;
      mounted.delete(name);
    },
  };
}

function trustedStore(credentials) {
  const adapter = Object.freeze({
    snapshot: async () => ({ record: undefined, value: undefined }),
    compareAndSwap: async () => ({ ok: false }),
  });
  return Object.freeze({ verify: (candidate) => candidate === credentials, adapter: () => adapter });
}

async function seed(credentials, { subject = 'E1001', expired = true, accessInMs } = {}) {
  const now = Date.now();
  const grant = { version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer, subject, clientId: 'dsh', scope: 'openid',
    refreshToken: `refresh-${subject}`, accessToken: `access-${subject}`,
    obtainedAt: new Date(now - 60_000).toISOString(),
    accessExpiresAt: new Date(now + (accessInMs ?? (expired ? -1000 : 120_000))).toISOString(),
    refreshExpiresAt: new Date(now + 120_000).toISOString() };
  await createGrantStore(credentials).write(grant);
  return grant;
}

function mockIssuer(t, { onJwks, onPost } = {}) {
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/jwks')) {
      if (onJwks) await onJwks();
      return Response.json({ keys: [] });
    }
    if (init?.method === 'POST') {
      posts++;
      if (onPost) await onPost();
      return Response.json({ access_token: 'synthetic-access-new', token_type: 'Bearer',
        expires_in: 60, refresh_token: 'synthetic-refresh-new' });
    }
    throw new Error('unexpected mock issuer request');
  });
  return () => posts;
}

async function waitFor(condition, message) {
  const deadline = Date.now() + 3500;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), message);
}

test('a newly signed-in Host renews while idle before the access token expires', async (t) => {
  const oidc = await startMockOidc({ accessTtl: 3 });
  const credentials = new MemoryCredentials();
  const webServer = { getOrigin: () => 'http://127.0.0.1:4567', register: () => () => {} };
  const ctx = host({ credentials, 'iam-atomic-store': trustedStore(credentials), webServer });
  const dispose = apply(ctx.ctx, { ...config, ...oidc.endpoints, clientId: oidc.clientId });
  t.after(async () => { await dispose(); await oidc.close(); });
  const started = await ctx.service().startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const signedIn = await ctx.service().handleCallback(response.headers.get('location'));
  assert.equal(signedIn.state, 'ready');
  const deadline = Date.parse(signedIn.accessExpiresAt);
  await delay(Math.max(0, deadline - 200 - Date.now()));
  assert.equal(oidc.counts.refresh, 1, 'idle Host must renew before the original access expiry');
});

for (const first of ['credentials', 'iam-atomic-store']) {
  test(`late ${first} binding restores and renews an expired grant without a token request`, async (t) => {
    const credentials = new MemoryCredentials();
    const initial = await seed(credentials);
    const countPosts = mockIssuer(t);
    const ctx = host();
    const dispose = apply(ctx.ctx, config);
    t.after(dispose);
    await delay(25); // Let the initial hydrate finish with no dependencies.
    const trust = trustedStore(credentials);
    ctx.mount(first, first === 'credentials' ? credentials : trust);
    await delay(50);
    assert.equal(countPosts(), 0);
    assert.deepEqual((await createGrantStore(credentials).read()).grant, initial);
    ctx.mount(first === 'credentials' ? 'iam-atomic-store' : 'credentials',
      first === 'credentials' ? trust : credentials);
    await waitFor(() => credentials.records.get(GRANT_KEY)?.payload.refreshOperation?.state === 'complete',
      'the binding must restore and renew the saved session');
    assert.equal(countPosts(), 1);
    assert.equal(ctx.service().getView().state, 'ready');
  });
}

test('credentials available before trust do not refresh or poison an expired session', async (t) => {
  const credentials = new MemoryCredentials();
  const initial = await seed(credentials);
  const countPosts = mockIssuer(t);
  const ctx = host({ credentials });
  const dispose = apply(ctx.ctx, config);
  t.after(dispose);
  await delay(100);
  await ctx.service().syncFromStore();
  assert.notEqual(ctx.service().getView().state, 'error');
  assert.equal(countPosts(), 0);
  assert.deepEqual((await createGrantStore(credentials).read()).grant, initial);
  ctx.mount('iam-atomic-store', trustedStore(credentials));
  await waitFor(() => credentials.records.get(GRANT_KEY)?.payload.refreshOperation?.state === 'complete',
    'the session must recover automatically when trust binds');
  assert.equal(countPosts(), 1);
  assert.equal(ctx.service().getView().state, 'ready');
});

test('a stale ctx.get trust value cannot authorize an unbound provider', async (t) => {
  const credentials = new MemoryCredentials();
  const initial = await seed(credentials);
  const countPosts = mockIssuer(t);
  const ctx = host({ credentials });
  ctx.setFallback('iam-atomic-store', trustedStore(credentials));
  const dispose = apply(ctx.ctx, config);
  t.after(dispose);
  await delay(50);
  await ctx.service().syncFromStore();
  await delay(50);
  assert.equal(countPosts(), 0);
  assert.deepEqual((await createGrantStore(credentials).read()).grant, initial);
  await assert.rejects(() => ctx.service().startSignIn(), { code: 'IAM_ATOMIC_STORE_UNVERIFIED' });
});

test('revoking trust cancels an already scheduled renewal until the pair returns', async (t) => {
  const credentials = new MemoryCredentials();
  const initial = await seed(credentials, { accessInMs: 2600 });
  const countPosts = mockIssuer(t);
  let reads = 0;
  const read = credentials.readRecord.bind(credentials);
  credentials.readRecord = async (key) => { if (key === GRANT_KEY) reads++; return read(key); };
  const trust = trustedStore(credentials);
  const ctx = host({ credentials, 'iam-atomic-store': trust });
  const dispose = apply(ctx.ctx, config);
  t.after(dispose);
  await waitFor(() => ctx.service().getView().state === 'ready', 'the session must hydrate');
  await delay(20);
  const before = reads;
  ctx.unmount('iam-atomic-store');
  await delay(1750);
  assert.equal(reads, before, 'the canceled timer must not enter the resolver');
  assert.equal(countPosts(), 0);
  assert.equal(ctx.service().getView().state, 'ready');
  assert.deepEqual((await createGrantStore(credentials).read()).grant, initial);
  ctx.mount('iam-atomic-store', trust);
  await waitFor(() => credentials.records.get(GRANT_KEY)?.payload.refreshOperation?.state === 'complete',
    'the restored pair must schedule the session again');
  assert.equal(countPosts(), 1);
});

test('trust revoked during preflight preserves the session and a later binding resumes renewal', async (t) => {
  const credentials = new MemoryCredentials();
  const initial = await seed(credentials, { accessInMs: 2500 });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let firstJwks = true;
  const countPosts = mockIssuer(t, { onJwks: async () => {
    if (firstJwks) { firstJwks = false; entered.resolve(); await release.promise; }
  } });
  const trust = trustedStore(credentials);
  const ctx = host({ credentials, 'iam-atomic-store': trust });
  const dispose = apply(ctx.ctx, config);
  t.after(async () => { release.resolve(); await dispose(); });
  await waitFor(() => !firstJwks, 'automatic renewal must reach preflight');
  await entered.promise;
  ctx.unmount('iam-atomic-store');
  release.resolve();
  await delay(50);
  assert.equal(ctx.service().getView().state, 'ready');
  assert.equal(countPosts(), 0);
  assert.deepEqual((await createGrantStore(credentials).read()).grant, initial);
  await assert.rejects(() => ctx.service().getAccessToken(), { code: 'IAM_ATOMIC_STORE_UNVERIFIED' });
  assert.equal(ctx.service().getView().state, 'ready');
  ctx.mount('iam-atomic-store', trust);
  await waitFor(() => credentials.records.get(GRANT_KEY)?.payload.refreshOperation?.state === 'complete',
    'rebinding trust must restore automatic renewal');
  assert.equal(countPosts(), 1);
});

test('trust revoked after a refresh POST leaves pending and never resends it', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const countPosts = mockIssuer(t, { onPost: async () => { entered.resolve(); await release.promise; } });
  const trust = trustedStore(credentials);
  const ctx = host({ credentials, 'iam-atomic-store': trust });
  const dispose = apply(ctx.ctx, config);
  t.after(async () => { release.resolve(); await dispose(); });
  await waitFor(() => countPosts() === 1, 'automatic renewal must send the first request');
  await entered.promise;
  const pending = structuredClone((await createGrantStore(credentials).read()).grant);
  assert.equal(pending.refreshOperation.state, 'pending');
  ctx.unmount('iam-atomic-store');
  release.resolve();
  await delay(50);
  ctx.mount('iam-atomic-store', trust);
  await delay(100);
  assert.equal(countPosts(), 1);
  assert.deepEqual((await createGrantStore(credentials).read()).grant, pending);
  assert.equal(ctx.service().getView().state, 'error');
});

test('repeated binding and provider replacement do not refresh the old session', async (t) => {
  const first = new MemoryCredentials();
  const firstGrant = await seed(first, { expired: false });
  const second = new MemoryCredentials();
  await seed(second, { subject: 'E2002' });
  const countPosts = mockIssuer(t);
  const firstTrust = trustedStore(first);
  const ctx = host({ credentials: first, 'iam-atomic-store': firstTrust });
  const dispose = apply(ctx.ctx, config);
  t.after(dispose);
  await waitFor(() => ctx.service().getView().principal === 'E1001', 'the first session must hydrate');
  ctx.mount('credentials', first);
  ctx.mount('iam-atomic-store', firstTrust);
  ctx.unmount('credentials');
  ctx.mount('credentials', second);
  await delay(50);
  assert.equal(countPosts(), 0);
  ctx.mount('iam-atomic-store', trustedStore(second));
  await waitFor(() => second.records.get(GRANT_KEY)?.payload.refreshOperation?.state === 'complete',
    'the replacement session must renew');
  assert.equal(countPosts(), 1);
  assert.equal(ctx.service().getView().principal, 'E2002');
  assert.deepEqual((await createGrantStore(first).read()).grant, firstGrant);
});

test('unloading before a trusted pair binds prevents later hydration', async () => {
  const credentials = new MemoryCredentials();
  const initial = await seed(credentials);
  const ctx = host();
  const dispose = apply(ctx.ctx, config);
  await dispose();
  ctx.mount('credentials', credentials);
  ctx.mount('iam-atomic-store', trustedStore(credentials));
  await delay(50);
  assert.equal(ctx.service(), undefined);
  assert.deepEqual((await createGrantStore(credentials).read()).grant, initial);
});

test('an embedding without inject retains initial hydration', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials, { expired: false });
  let service;
  const ctx = {
    get: (name) => name === 'credentials' ? credentials : undefined,
    // 只认 `iam` 这一笔：装配点还会 provide 凭据 broker，测试不能把它当成服务本体。
    provide: (name, value) => { if (name === 'iam') service = value; return () => {}; },
    effect: (fn) => fn(),
  };
  const dispose = apply(ctx, config);
  t.after(dispose);
  await waitFor(() => service?.getView().principal === 'E1001', 'the embedding must hydrate');
  assert.equal(service.getView().state, 'ready');
});
