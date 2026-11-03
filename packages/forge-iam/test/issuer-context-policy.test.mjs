import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY, GATEWAY_RECORD_KEY, GATEWAY_REF } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { createAtomicGatewayFixture } from './support/atomic-gateway.mjs';

const issuerA = 'https://issuer-a.corp.example';
const issuerB = 'https://issuer-b.corp.example';
const clock = Date.parse('2026-11-02T00:00:00.000Z');
const config = {
  discoveryUrl: `${issuerA}/.well-known/openid-configuration`,
  clientId: 'synthetic-client',
};
const key = `uag-${'a'.repeat(32)}`;

async function fixture(t, { trusted = false, gatewayTrusted = false, pin, grant = {}, discoveredIssuer = issuerA, fetchOther } = {}) {
  let instant = clock;
  let discoveryGate = null;
  const credentials = new MemoryCredentials();
  const atomic = gatewayTrusted ? createAtomicGatewayFixture(credentials) : null;
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, issuer: issuerA, clientId: config.clientId, subject: 'synthetic-subject',
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(clock - 3600000).toISOString(),
    accessExpiresAt: new Date(clock + 3600000).toISOString(), ...grant,
  });
  const original = structuredClone(await credentials.readRecord(GRANT_KEY));
  const requests = [];
  let mutations = 0;
  const modify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = (...args) => { mutations++; return modify(...args); };
  const service = createIamService({ ...config, ...(pin ? { issuer: pin } : {}) }, {
    credentials, now: () => instant, getOrigin: () => 'http://127.0.0.1:4567',
    ...(trusted ? { verifyAtomicStore: (candidate) => candidate === credentials } : {}),
    ...(atomic ? atomic.options : {}),
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method ?? 'GET' });
      if (String(url) === config.discoveryUrl) {
        const gate = discoveryGate;
        discoveryGate = null;
        if (gate) {
          gate.entered.resolve();
          await gate.released.promise;
        }
        const issuer = gate?.issuer ?? discoveredIssuer;
        return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      }
      if (fetchOther) return fetchOther(String(url), init);
      throw new Error('unexpected synthetic request; no real network is permitted');
    },
  });
  t.after(() => service.dispose());
  return { service, credentials, store, original, requests, mutations: () => mutations,
    advance: (milliseconds) => { instant += milliseconds; },
    pauseDiscovery: (issuer) => {
      const gate = { issuer, entered: Promise.withResolvers(), released: Promise.withResolvers() };
      discoveryGate = gate;
      t.after(gate.released.resolve);
      return { entered: gate.entered.promise, release: gate.released.resolve };
    },
  };
}

function assertNoIdentity(service) {
  const view = service.getView();
  assert.notEqual(view.state, 'ready');
  assert.equal(view.principal, null);
}

for (const trusted of [false, true]) {
  for (const operation of ['hydrate', 'syncFromStore', 'resolveToken']) {
    test(`cold discovery-only ${operation} refuses legacy V1 without issuer context, atomicTrusted=${trusted}`, async (t) => {
      const f = await fixture(t, { trusted });
      if (operation === 'resolveToken') {
        await assert.rejects(f.service.resolveToken(), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
      } else await f.service[operation]();
      assertNoIdentity(f.service);
      assert.equal(f.requests.length, 0);
      assert.equal(f.mutations(), 0);
      assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
    });
  }
  for (const state of ['expired', 'pending']) {
    for (const operation of ['hydrate', 'syncFromStore', 'resolveToken']) {
      test(`cold discovery-only ${state} ${operation} cannot trigger refresh or claim, atomicTrusted=${trusted}`, async (t) => {
        const f = await fixture(t, { trusted, grant: {
          accessExpiresAt: new Date(clock - 60000).toISOString(),
          ...(state === 'pending' ? { refreshOperation: {
            version: 1, state: 'pending', id: 'a'.repeat(42) + 'A', base: 'b'.repeat(42) + 'A',
          } } : {}),
        } });
        if (operation === 'resolveToken') {
          await assert.rejects(f.service.resolveToken(), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
        } else await f.service[operation]();
        assertNoIdentity(f.service);
        assert.equal(f.requests.length, 0);
        assert.equal(f.mutations(), 0);
        assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
      });
    }
  }
  test(`gateway save cannot adopt an unbound legacy V1 subject, atomicTrusted=${trusted}`, async (t) => {
    const f = await fixture(t, { trusted, gatewayTrusted: true });
    await assert.rejects(f.service.saveGatewayCredential({ key }), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
    assert.equal(await f.credentials.resolve(GATEWAY_REF), undefined);
    assert.equal(await f.credentials.readRecord(GATEWAY_RECORD_KEY), undefined);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
  });
}

for (const operation of ['hydrate', 'syncFromStore', 'resolveToken']) {
  test(`explicit matching issuer preserves offline legacy V1 ${operation} without session ID or atomic verifier`, async (t) => {
    const f = await fixture(t, { pin: issuerA });
    if (operation === 'resolveToken') assert.equal(await f.service.resolveToken() === 'synthetic-access', true);
    else await f.service[operation]();
    assert.equal(f.service.getView().state, 'ready');
    assert.equal(f.service.getView().principal, 'synthetic-subject');
    assert.equal(f.requests.length, 0);
    assert.equal(f.mutations(), 0);
    assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
  });
  test(`explicit wrong issuer rejects legacy V1 ${operation} offline`, async (t) => {
    const f = await fixture(t, { pin: issuerB });
    if (operation === 'resolveToken') {
      await assert.rejects(f.service.resolveToken(), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
    } else await f.service[operation]();
    assertNoIdentity(f.service);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
  });
  test(`this instance's verified discovery issuer permits legacy V1 ${operation}`, async (t) => {
    const f = await fixture(t, { trusted: true });
    await f.service.startSignIn();
    await f.service.cancelSignIn();
    assert.equal(f.requests.length, 1);
    if (operation === 'resolveToken') assert.equal(await f.service.resolveToken() === 'synthetic-access', true);
    else await f.service[operation]();
    assert.equal(f.service.getView().state, 'ready');
    assert.equal(f.service.getView().principal, 'synthetic-subject');
    assert.equal(f.requests.length, 1);
    assert.equal(f.mutations(), 0);
    assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
  });
}

test('gateway save accepts a bound legacy IAM subject with exact gateway capability and no grant verifier', async (t) => {
  const f = await fixture(t, { pin: issuerA, gatewayTrusted: true });
  await f.service.saveGatewayCredential({ key });
  assert.equal((await f.credentials.readRecord(GATEWAY_RECORD_KEY)).payload.ownerSubject, 'synthetic-subject');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
});

test('verified metadata context is instance-local, not inherited by another service over the same record', async (t) => {
  const f = await fixture(t, { trusted: true });
  await f.service.startSignIn();
  await f.service.cancelSignIn();
  assert.equal(await f.service.resolveToken() === 'synthetic-access', true);
  const cold = createIamService(config, { credentials: f.credentials, now: () => clock,
    fetch: async () => { throw new Error('cold instance must not fetch'); } });
  t.after(() => cold.dispose());
  await assert.rejects(cold.resolveToken(), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
  assertNoIdentity(cold);
  assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
});

for (const discoveredIssuer of [issuerA, issuerB]) {
  test(`gateway save requires matching verified metadata issuer, discovered=${discoveredIssuer === issuerA ? 'matching' : 'wrong'}`, async (t) => {
    const f = await fixture(t, { trusted: true, gatewayTrusted: true, discoveredIssuer });
    await f.service.startSignIn();
    await f.service.cancelSignIn();
    if (discoveredIssuer === issuerA) {
      await f.service.saveGatewayCredential({ key });
      assert.equal((await f.credentials.readRecord(GATEWAY_RECORD_KEY)).payload.ownerSubject, 'synthetic-subject');
    } else {
      await assert.rejects(f.service.saveGatewayCredential({ key }), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
      assert.equal(await f.credentials.resolve(GATEWAY_REF), undefined);
    }
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
  });
}

function pauseGrantRead(t, credentials) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const original = credentials.readRecord.bind(credentials);
  let armed = true;
  credentials.readRecord = async (recordKey) => {
    const record = await original(recordKey);
    if (armed && recordKey === GRANT_KEY) {
      armed = false;
      entered.resolve();
      await released.promise;
    }
    return record;
  };
  t.after(released.resolve);
  return { entered: entered.promise, release: released.resolve };
}

async function beginLateDiscovery(f, issuer) {
  f.advance(5 * 60 * 1000 + 1);
  const gate = f.pauseDiscovery(issuer);
  const cancelled = f.service.startSignIn().then(() => 'accepted', (error) => error.code);
  await gate.entered;
  await f.service.cancelSignIn();
  // loadMetadata can still validate its result after cancellation. This models
  // an earlier request publishing a new cache without changing the later epoch.
  return async () => {
    gate.release();
    assert.equal(await cancelled, 'IAM_ATTEMPT_CANCELLED');
  };
}

for (const operation of ['syncFromStore', 'saveGatewayCredential', 'resolveToken']) {
  for (const contextAtStart of ['unknown', 'issuer-a']) {
    test(`${operation} fixes its ${contextAtStart} context before awaiting a grant read`, async (t) => {
      const f = await fixture(t, { trusted: true, gatewayTrusted: operation === 'saveGatewayCredential' });
      if (contextAtStart === 'issuer-a') {
        await f.service.startSignIn();
        await f.service.cancelSignIn();
      }
      const finishDiscovery = await beginLateDiscovery(f, contextAtStart === 'unknown' ? issuerA : issuerB);
      const readGate = pauseGrantRead(t, f.credentials);
      const pending = (operation === 'saveGatewayCredential'
        ? f.service.saveGatewayCredential({ key }) : f.service[operation]())
        .then((value) => ({ value }), (error) => ({ error: error.code }));
      await readGate.entered;
      await finishDiscovery();
      readGate.release();
      const result = await pending;
      if (contextAtStart === 'unknown') {
        if (operation === 'syncFromStore') assertNoIdentity(f.service);
        else assert.equal(result.error, 'IAM_GRANT_CONTEXT_MISMATCH');
        assert.equal(await f.credentials.resolve(GATEWAY_REF), undefined);
        // A new operation may use the metadata now known to this instance.
        assert.equal(await f.service.resolveToken() === 'synthetic-access', true);
      } else {
        assert.equal(result.error, undefined);
        if (operation === 'saveGatewayCredential') {
          assert.equal((await f.credentials.readRecord(GATEWAY_RECORD_KEY)).payload.ownerSubject, 'synthetic-subject');
        } else {
          assert.equal(f.service.getView().state, 'ready');
          if (operation === 'resolveToken') assert.equal(result.value === 'synthetic-access', true);
        }
        // The newer issuer B context must not authorize the issuer A record.
        await assert.rejects(f.service.resolveToken(), { code: 'IAM_GRANT_CONTEXT_MISMATCH' });
      }
      assert.deepEqual(await f.credentials.readRecord(GRANT_KEY), f.original);
      assert.equal(f.requests.length, contextAtStart === 'unknown' ? 1 : 2);
    });
  }
}

test('an issuer B caller cannot join an issuer A refresh promise after late metadata publication', async (t) => {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  t.after(released.resolve);
  const f = await fixture(t, { trusted: true,
    grant: { accessExpiresAt: new Date(clock + 60000).toISOString() },
    fetchOther: async (url, init) => {
      if (url === `${issuerA}/jwks`) return Response.json({ keys: [] });
      if (url === `${issuerA}/token` && init.method === 'POST') {
        entered.resolve();
        await released.promise;
        return Response.json({ access_token: 'synthetic-rotated-access',
          refresh_token: 'synthetic-rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      throw new Error('unexpected synthetic issuer endpoint');
    },
  });
  await f.service.startSignIn();
  await f.service.cancelSignIn();
  const finishDiscoveryB = await beginLateDiscovery(f, issuerB);
  const first = f.service.resolveToken().then((token) => ({ accepted: token === 'synthetic-rotated-access' }),
    (error) => ({ error: error.code }));
  await entered.promise;
  await finishDiscoveryB();
  const second = f.service.resolveToken().then(() => 'accepted', (error) => error.code);
  released.resolve();
  assert.deepEqual(await first, { accepted: true });
  assert.equal(await second, 'IAM_GRANT_CONTEXT_MISMATCH');
  const persisted = await f.credentials.readRecord(GRANT_KEY);
  assert.equal(persisted.payload.issuer, issuerA);
  assert.equal(persisted.payload.refreshToken === 'synthetic-rotated-refresh', true);
  assert.equal(persisted.payload.refreshOperation.state, 'complete');
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 1);
});
