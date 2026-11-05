// Offline outbound boundaries: refresh needs a pre-established issuer context;
// explicit signOut may load discovery before deciding whether to revoke.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const issuerA = 'https://issuer-a.corp.example';
const issuerB = 'https://issuer-b.corp.example';
const now = () => Date.parse('2026-01-01T01:00:00.000Z');
// Omitting issuer and explicit endpoints is a valid discovery-only configuration.
const config = {
  discoveryUrl: 'https://discovery.corp.example/.well-known/openid-configuration',
  clientId: 'same-client',
};

async function fixture(t, discoveredIssuer, overrides = {}, discoveryFails = false) {
  let globalFetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    globalFetchCalls++;
    throw new Error('real network is forbidden in this test');
  });
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, issuer: issuerA, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-expired-access',
    obtainedAt: '2026-01-01T00:00:00.000Z', accessExpiresAt: '2026-01-01T00:59:00.000Z',
    scope: 'openid profile offline_access',
  });
  const initial = structuredClone(await credentials.readRecord(GRANT_KEY));
  let pendingClaims = 0;
  const modify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = (key, mutate) => modify(key, async (current) => {
    const next = await mutate(current);
    if (key === GRANT_KEY && next?.payload?.refreshOperation?.state === 'pending') pendingClaims++;
    return next;
  });
  const requests = [];
  const fetch = async (url, init = {}) => {
    const target = String(url);
    const parsed = new URL(target);
    const form = new URLSearchParams(init.body);
    // Keep only synthetic-token equality flags, never token values in assertion output.
    requests.push({
      url: target, method: init.method ?? 'GET', clientId: form.get('client_id'),
      grantType: form.get('grant_type'), tokenTypeHint: form.get('token_type_hint'),
      authorization: init.headers?.authorization ?? null,
      accessTokenMatches: parsed.searchParams.get('access_token') === initial.payload.accessToken,
      oldRefresh: form.get('refresh_token') === initial.payload.refreshToken
        || form.get('token') === initial.payload.refreshToken,
    });
    if (target === config.discoveryUrl && discoveryFails) throw new Error('synthetic discovery failure');
    if (target === config.discoveryUrl) return Response.json({
      issuer: discoveredIssuer, authorization_endpoint: `${discoveredIssuer}/authorize`,
      token_endpoint: `${discoveredIssuer}/token`, jwks_uri: `${discoveredIssuer}/jwks`,
      revocation_endpoint: `${discoveredIssuer}/revoke`,
    });
    if (target === `${discoveredIssuer}/jwks`) return Response.json({ keys: [] });
    if (target === `${discoveredIssuer}/token` && init.method === 'POST') return Response.json({
      access_token: 'synthetic-new-access', refresh_token: 'synthetic-rotated-refresh',
      token_type: 'Bearer', expires_in: 3600,
    });
    if (target.startsWith(`${discoveredIssuer}/revoke`) && init.method === 'GET') return Response.json({ result: true });
    if (target === `${discoveredIssuer}/revoke` && init.method === 'POST') return new Response(null, { status: 200 });
    throw new Error('unexpected injected mock request');
  };
  const service = createIamService({ ...config, ...overrides }, {
    credentials, fetch, now, getOrigin: () => 'http://127.0.0.1:4567',
    // Explicit trust in this exact in-memory instance, not getCredentials duck typing.
    verifyAtomicStore: (candidate) => candidate === credentials,
  });
  t.after(async () => {
    await service.dispose();
    assert.equal(globalFetchCalls, 0, 'all requests must use the injected fetch');
  });
  return { service, credentials, store, initial, requests, pendingClaims: () => pendingClaims };
}

function posts(f, issuer, endpoint) {
  return f.requests.filter((request) => request.url === `${issuer}/${endpoint}` && request.method === 'POST');
}

function discoveryLoaded(f) {
  return f.requests.some((request) => request.url === config.discoveryUrl && request.method === 'GET');
}

test('discovery-only refresh rejects issuer B before claiming or sending issuer A refresh token', async (t) => {
  const f = await fixture(t, issuerB);
  await f.service.startSignIn();
  await f.service.cancelSignIn();
  const outcome = await f.service.resolveToken().then(() => 'accepted', (error) => error.code);
  const persisted = await f.credentials.readRecord(GRANT_KEY);
  assert.deepEqual({
    discoveryLoaded: discoveryLoaded(f),
    tokenPostsToB: posts(f, issuerB, 'token').length,
    pendingClaims: f.pendingClaims(),
    issuerPreserved: persisted?.payload?.issuer === issuerA,
    grantPreserved: isDeepStrictEqual(persisted, f.initial),
    outcome,
    notReady: f.service.getView().state !== 'ready',
  }, {
    discoveryLoaded: true, tokenPostsToB: 0, pendingClaims: 0,
    issuerPreserved: true, grantPreserved: true,
    outcome: 'IAM_GRANT_CONTEXT_MISMATCH', notReady: true,
  });
});

test('discovery-only signOut rejects issuer B revocation and retains issuer A persistent grant', async (t) => {
  const f = await fixture(t, issuerB);
  const result = await f.service.signOut();
  assert.deepEqual({
    discoveryLoaded: discoveryLoaded(f),
    revocationPostsToB: posts(f, issuerB, 'revoke').length,
    revocation: result.revocation,
    grantPreserved: isDeepStrictEqual(await f.credentials.readRecord(GRANT_KEY), f.initial),
    state: result.view.state,
    error: result.view.error,
  }, {
    discoveryLoaded: true, revocationPostsToB: 0, revocation: 'unknown',
    grantPreserved: true, state: 'error', error: 'IAM_CREDENTIALS_CLEAR_FAILED',
  });
});

for (const discoveryFails of [false, true]) {
  test(`an explicit revocation endpoint does not bypass issuer verification, discoveryFails=${discoveryFails}`, async (t) => {
    const f = await fixture(t, issuerB, { revocationEndpoint: `${issuerB}/revoke` }, discoveryFails);
    const result = await f.service.signOut();
    assert.equal(discoveryLoaded(f), true);
    assert.equal(posts(f, issuerB, 'revoke').length, 0);
    assert.equal(result.revocation, 'unknown');
    assert.equal(isDeepStrictEqual(await f.credentials.readRecord(GRANT_KEY), f.initial), true);
  });
}

test('discovery-only matching issuer refresh accepts a rotated refresh token after explicit metadata preparation', async (t) => {
  const f = await fixture(t, issuerA);
  await f.service.startSignIn();
  await f.service.cancelSignIn();
  assert.equal(await f.service.resolveToken() === 'synthetic-new-access', true);
  const [request] = posts(f, issuerA, 'token');
  const persisted = await f.credentials.readRecord(GRANT_KEY);
  assert.deepEqual({
    discoveryLoaded: discoveryLoaded(f),
    tokenPosts: posts(f, issuerA, 'token').length,
    correctForm: request?.oldRefresh && request.clientId === config.clientId && request.grantType === 'refresh_token',
    pendingClaims: f.pendingClaims(),
    issuerPreserved: persisted?.payload?.issuer === issuerA,
    rotated: persisted?.payload?.refreshToken === 'synthetic-rotated-refresh',
    marker: persisted?.payload?.refreshOperation?.state,
    state: f.service.getView().state,
  }, {
    discoveryLoaded: true, tokenPosts: 1, correctForm: true, pendingClaims: 1,
    issuerPreserved: true, rotated: true, marker: 'complete', state: 'ready',
  });
});

test('discovery-only matching issuer signOut revokes the access token with a GET and clears the grant', async (t) => {
  const f = await fixture(t, issuerA);
  const result = await f.service.signOut();
  const [request] = f.requests.filter((entry) => entry.url.startsWith(`${issuerA}/revoke`));
  assert.deepEqual({
    discoveryLoaded: discoveryLoaded(f),
    revocationGets: f.requests.filter((entry) => entry.url.startsWith(`${issuerA}/revoke`)).length,
    revocationPosts: posts(f, issuerA, 'revoke').length,
    correctForm: request?.method === 'GET' && request.accessTokenMatches === true
      && request.authorization === null && request.clientId === null && request.tokenTypeHint === null,
    revocation: result.revocation,
    grantCleared: (await f.store.read()).grant === null,
    state: result.view.state,
    error: result.view.error,
  }, {
    discoveryLoaded: true, revocationGets: 1, revocationPosts: 0, correctForm: true,
    revocation: 'ok', grantCleared: true, state: 'signed-out', error: null,
  });
});