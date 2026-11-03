// Existing-behavior protection, not a red/green fix: RP config requires an
// explicit endSessionEndpoint, which takes precedence over discovery metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY, GATEWAY_RECORD_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const issuerA = 'https://issuer-a.corp.example';
const issuerB = 'https://issuer-b.corp.example';
const discoveryUrl = 'https://discovery.corp.example/.well-known/openid-configuration';
const clientId = 'synthetic-client';
const idToken = 'synthetic-id-token-a';
const refreshToken = 'synthetic-refresh-a';
const clock = Date.parse('2026-11-02T00:00:00.000Z');

async function fixture(t, { discoveredIssuer = issuerA, discoveryFails = false,
  logoutMode = 'rp', postLogoutRedirectUri } = {}) {
  let globalFetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    globalFetchCalls++;
    throw new Error('real network is forbidden in this test');
  });
  let instant = clock;
  let discoveryGate = null;
  let gatewayGate = null;
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, issuer: issuerA, subject: 'synthetic-subject', clientId,
    refreshToken, idToken, accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock - 1000).toISOString(),
    accessExpiresAt: new Date(clock + 24 * 60 * 60 * 1000).toISOString(),
  });
  const original = structuredClone(await credentials.readRecord(GRANT_KEY));
  let mutations = 0;
  const modify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = (...args) => { mutations++; return modify(...args); };
  const read = credentials.readRecord.bind(credentials);
  credentials.readRecord = async (key) => {
    const record = await read(key);
    if (key === GATEWAY_RECORD_KEY && gatewayGate) {
      const gate = gatewayGate;
      gatewayGate = null;
      gate.entered.resolve();
      await gate.released.promise;
    }
    return record;
  };
  const requests = [];
  const service = createIamService({
    discoveryUrl, clientId, logoutMode,
    // A legal RP config pins this endpoint; discovery cannot replace it with B.
    endSessionEndpoint: `${issuerA}/logout`,
    ...(postLogoutRedirectUri ? { postLogoutRedirectUri } : {}),
  }, {
    credentials, now: () => instant, getOrigin: () => 'http://127.0.0.1:4567',
    verifyAtomicStore: (candidate) => candidate === credentials,
    fetch: async (url, init = {}) => {
      const target = String(url);
      if (target === discoveryUrl) {
        const request = { endpoint: 'discovery', method: init.method ?? 'GET', returnedB: false };
        requests.push(request);
        if (discoveryFails) throw new Error('synthetic discovery failure');
        const gate = discoveryGate;
        discoveryGate = null;
        if (gate) {
          gate.entered.resolve();
          await gate.released.promise;
        }
        const issuer = gate?.issuer ?? discoveredIssuer;
        request.returnedB = issuer === issuerB;
        return Response.json({
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke`,
          end_session_endpoint: `${issuer}/logout`,
        });
      }
      for (const [issuer, endpoint] of [[issuerA, 'revoke-a'], [issuerB, 'revoke-b']]) {
        if (target === `${issuer}/revoke`) {
          const form = new URLSearchParams(init.body);
          // Assertion output contains only flags, never URL query strings or tokens.
          requests.push({ endpoint, method: init.method,
            tokenMatches: form.get('token') === refreshToken,
            clientMatches: form.get('client_id') === clientId,
            hintMatches: form.get('token_type_hint') === 'refresh_token' });
          return new Response(null, { status: 200 });
        }
      }
      throw new Error('unexpected injected mock request');
    },
  });
  t.after(async () => {
    await service.dispose();
    assert.equal(globalFetchCalls, 0, 'all requests must use the injected fetch');
  });
  const pause = (issuer) => {
    const gate = { issuer, entered: Promise.withResolvers(), released: Promise.withResolvers() };
    t.after(gate.released.resolve);
    return gate;
  };
  return { service, credentials, store, original, requests, mutations: () => mutations,
    advance: (milliseconds) => { instant += milliseconds; },
    pauseDiscovery: (issuer) => {
      const gate = pause(issuer);
      discoveryGate = gate;
      return { entered: gate.entered.promise, release: gate.released.resolve };
    },
    pauseGatewayRead: () => {
      const gate = pause();
      gatewayGate = gate;
      return { entered: gate.entered.promise, release: gate.released.resolve };
    },
  };
}

function logoutFacts(logoutUrl, redirect) {
  const url = logoutUrl ? new URL(logoutUrl) : null;
  return {
    exists: Boolean(url),
    issuerAEndpoint: url?.origin === issuerA && url?.pathname === '/logout',
    issuerBHint: url?.origin === issuerB && url.searchParams.has('id_token_hint'),
    hintMatches: url?.searchParams.get('id_token_hint') === idToken,
    clientMatches: url?.searchParams.get('client_id') === clientId,
    redirectMatches: Boolean(url) && (redirect
      ? url.searchParams.get('post_logout_redirect_uri') === redirect
      : !url.searchParams.has('post_logout_redirect_uri')),
    parameterCount: url ? [...url.searchParams].length : 0,
  };
}

for (const redirect of [undefined, 'https://app.corp.example/signed-out']) {
  test(`stable issuer A RP logout returns the configured endpoint and hint, redirect=${Boolean(redirect)}`, async (t) => {
    const f = await fixture(t, { postLogoutRedirectUri: redirect });
    const result = await f.service.signOut();
    assert.deepEqual(logoutFacts(result.logoutUrl, redirect), {
      exists: true, issuerAEndpoint: true, issuerBHint: false, hintMatches: true,
      clientMatches: true, redirectMatches: true, parameterCount: redirect ? 3 : 2,
    });
    assert.equal(result.revocation, 'ok');
    assert.equal(result.view.state, 'signed-out');
    assert.equal(result.view.error, null);
    assert.equal((await f.store.read()).grant, null);
    assert.equal(f.requests.filter((request) => request.endpoint === 'revoke-a').length, 1);
    assert.equal(f.requests.filter((request) => request.endpoint === 'revoke-b').length, 0);
    const revoke = f.requests.find((request) => request.endpoint === 'revoke-a');
    assert.equal(revoke.method === 'POST' && revoke.tokenMatches && revoke.clientMatches && revoke.hintMatches, true);
  });
}

for (const discoveryFails of [false, true]) {
  test(`an explicit RP endpoint cannot bypass ${discoveryFails ? 'unknown' : 'wrong'} discovery issuer context`, async (t) => {
    const f = await fixture(t, { discoveredIssuer: issuerB, discoveryFails });
    const result = await f.service.signOut();
    assert.deepEqual({
      noUrl: result.logoutUrl === null,
      revocation: result.revocation,
      error: result.view.error,
      grantPreserved: isDeepStrictEqual(await f.credentials.readRecord(GRANT_KEY), f.original),
      mutations: f.mutations(),
      discoveryGets: f.requests.filter((request) => request.endpoint === 'discovery' && request.method === 'GET').length,
      posts: f.requests.filter((request) => request.method === 'POST').length,
    }, {
      noUrl: true, revocation: 'unknown', error: 'IAM_CREDENTIALS_CLEAR_FAILED',
      grantPreserved: true, mutations: 0, discoveryGets: 1, posts: 0,
    });
  });
}

test('revoke-only logout clears the grant without returning an RP URL even when an ID token is stored', async (t) => {
  const f = await fixture(t, { logoutMode: 'local' });
  const result = await f.service.signOut();
  assert.equal(result.logoutUrl, null);
  assert.equal(result.revocation, 'ok');
  assert.equal(result.view.state, 'signed-out');
  assert.equal(result.view.error, null);
  assert.equal((await f.store.read()).grant, null);
  assert.equal(f.requests.filter((request) => request.endpoint === 'revoke-a').length, 1);
  assert.equal(f.requests.filter((request) => request.endpoint === 'revoke-b').length, 0);
});

test('cancelled discovery B arriving after cleanup cannot replace the configured issuer A RP endpoint', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.service.startSignIn();
  await f.service.cancelSignIn();
  f.advance(5 * 60 * 1000 + 1);
  const lateB = f.pauseDiscovery(issuerB);
  const starting = f.service.startSignIn().then(() => 'accepted', (error) => error.code);
  await Promise.race([lateB.entered, starting.then(() => { throw new Error('expected the old discovery request to pause'); })]);
  await f.service.cancelSignIn();

  const gateway = f.pauseGatewayRead();
  const exiting = f.service.signOut();
  await Promise.race([gateway.entered, exiting.then(() => { throw new Error('expected logout to pause after local cleanup'); })]);
  // Sign-out has fetched A again, revoked only its RT, and committed its tombstone.
  assert.equal((await f.store.read()).grant, null);
  assert.equal(f.requests.filter((request) => request.endpoint === 'discovery').length, 3);
  assert.equal(f.requests.filter((request) => request.endpoint === 'revoke-a').length, 1);
  assert.equal(f.requests.filter((request) => request.endpoint === 'revoke-b').length, 0);

  lateB.release();
  assert.equal(await starting, 'IAM_ATTEMPT_CANCELLED');
  assert.equal(f.requests.some((request) => request.endpoint === 'discovery' && request.returnedB), true);
  gateway.release();
  const result = await exiting;
  assert.deepEqual(logoutFacts(result.logoutUrl), {
    exists: true, issuerAEndpoint: true, issuerBHint: false, hintMatches: true,
    clientMatches: true, redirectMatches: true, parameterCount: 2,
  });
  assert.equal(result.revocation, 'ok');
  assert.equal(result.view.state, 'signed-out');
  assert.equal(result.view.error, null);
  assert.equal((await f.store.read()).grant, null);
});
