import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { confidentialHarness, signIn, hold } from './support/client-auth-service.mjs';
import { createClientSecretFixture } from './support/client-secret-source.mjs';

const sqliteTestOptions = { timeout: 60_000 };

async function sqliteConfidentialHarness(t, { beforeRefreshResponse, getAtomicStoreBinding } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-iam-confidential-'));
  const backend = createCredentialStore({ directory });
  const credentials = createKeychainProvider(backend);
  const fixture = createClientSecretFixture(credentials);
  const { issuer, clientId } = fixture.binding;
  const { revision, value } = fixture.snapshot();
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const initial = {
    version: 2,
    sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer,
    clientId,
    subject: 'synthetic-user',
    scope: 'openid',
    obtainedAt: new Date(now).toISOString(),
    accessExpiresAt: new Date(now + 3_600_000).toISOString(),
    accessToken: 'synthetic-original-access',
    refreshToken: 'synthetic-original-refresh',
    authContext: {
      mode: 'confidential', method: fixture.config.clientAuthMethod,
      secretRef: fixture.config.clientSecretRef, secretRevision: revision,
    },
  };
  const rotated = {
    access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh',
    token_type: 'Bearer', expires_in: 10_800,
  };
  const config = {
    ...fixture.config,
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`,
    revocationEndpoint: `${issuer}/revoke`,
    revocationMode: 'rfc7009',
    refreshSkewSeconds: 7200,
  };
  const requests = { refresh: 0, revoke: [] };
  const authorization = `Basic ${Buffer.from(`${clientId}:${value}`).toString('base64')}`;
  const verifyAtomicStore = (candidate) => candidate === credentials;
  let service;
  t.after(async () => {
    try {
      await service?.dispose();
    } finally {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  service = createIamService(config, {
    ...fixture.options,
    verifyAtomicStore,
    getAtomicStoreBinding,
    now: () => now,
    async fetch(url, init) {
      const endpoint = String(url);
      if (endpoint === config.jwksUri) {
        assert.equal(init.method, 'GET');
        return Response.json({ keys: [] });
      }
      const form = new URLSearchParams(init.body);
      const refreshing = endpoint === config.tokenEndpoint;
      if (refreshing) {
        requests.refresh++;
      } else {
        assert.equal(endpoint, config.revocationEndpoint);
        requests.revoke.push({ method: init.method, token: form.get('token'), hint: form.get('token_type_hint') });
      }
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, authorization);
      assert.equal(form.has('client_secret'), false);
      assert.equal(form.has('client_id'), false);
      if (!refreshing) return new Response(null, { status: 200 });
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), initial.refreshToken);
      await beforeRefreshResponse?.();
      return Response.json(rotated);
    },
  });
  await createGrantStore(credentials, { verifyAtomicStore }).write(initial);
  await service.hydrate();
  assert.equal(service.getView().state, 'ready');
  return { service, credentials, fixture, requests, rotated, record: async () => (await credentials.readRecord(GRANT_KEY)).payload };
}

for (const method of ['client_secret_basic', 'client_secret_post']) {
  test(`${method} cross-instance pending/complete shares one rotation with the whole authContext`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = await confidentialHarness(t, method, { config: { refreshSkewSeconds: 7200 }, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (new URLSearchParams(init?.body).get('grant_type') === 'refresh_token') await gate.pause();
      return response;
    } });
    await signIn(h);
    const before = structuredClone(await h.record());
    const owner = h.service.resolveToken(); const ownerResult = owner.catch((error) => error);
    await gate.entered;
    const read = h.credentials.readRecord.bind(h.credentials);
    const seen = Promise.withResolvers();
    h.credentials.readRecord = async (key) => { const result = await read(key); if (key === GRANT_KEY && result?.payload.refreshOperation?.state === 'pending') seen.resolve(); return result; };
    const peer = createIamService(h.config, h.options); t.after(() => peer.dispose());
    const waiter = peer.resolveToken(); const waiterResult = waiter.catch((error) => error);
    await seen.promise; gate.release();
    const tokens = await Promise.all([ownerResult, waiterResult]);
    assert.equal(typeof tokens[0], 'string'); assert.equal(tokens[0], tokens[1]);
    assert.equal(h.mock.counts.refresh, 1);
    assert.deepEqual((await h.record()).authContext, before.authContext);
    assert.equal((await h.record()).refreshOperation.state, 'complete');
  });
}

for (const change of ['sourcegone', 'same-revision-source']) {
  test(`already shared success cannot return a token after ${change} at the final await sink`, async (t) => {
    const h = await confidentialHarness(t, 'client_secret_basic', { config: { refreshSkewSeconds: 7200 } });
    let current = h.fixture.source;
    const accepted = new Set([current]);
    h.options.getClientSecretSource = () => current;
    h.options.verifyClientSecretSource = (credentials, source, scope) => credentials === h.credentials && accepted.has(source)
      && scope.issuer === h.mock.issuer && scope.clientId === h.mock.clientId
      && scope.ref === h.config.clientSecretRef && scope.method === h.config.clientAuthMethod;
    await signIn(h);
    let fired = false;
    h.options.recheckExclusive = () => {
      if (!fired && h.credentials.records.get(GRANT_KEY)?.payload.refreshOperation?.state === 'complete') {
        fired = true;
        queueMicrotask(() => {
          if (change === 'sourcegone') h.fixture.remove();
          else { current = Object.freeze({ ...current }); accepted.add(current); }
        });
      }
      return { ok: true };
    };
    const outcomes = await Promise.allSettled([h.service.resolveToken(), h.service.resolveToken()]);
    assert.equal(fired, true);
    assert.equal(outcomes.every((result) => result.status === 'rejected'), true);
    assert.equal(h.mock.counts.refresh, 1);
    assert.equal(h.mock.counts.revoke, 0);
    assert.equal((await h.record()).refreshOperation.state, 'complete');
  });
}

for (const point of ['claim-receipt', 'http', 'final-entry', 'final-receipt']) {
  test(`refresh source change at ${point} never returns AT, resets pending or resends RT`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = await confidentialHarness(t, 'client_secret_post', { config: { refreshSkewSeconds: 7200 }, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (point === 'http' && new URLSearchParams(init?.body).get('grant_type') === 'refresh_token') await gate.pause();
      return response;
    } });
    await signIn(h);
    const modify = h.credentials.modifyRecord.bind(h.credentials);
    let writes = 0;
    h.credentials.modifyRecord = async (key, mutator) => {
      if (key === GRANT_KEY) writes++;
      const write = writes;
      if (point === 'final-entry' && write === 2) await gate.pause();
      const result = await modify(key, mutator);
      if ((point === 'claim-receipt' && write === 1) || (point === 'final-receipt' && write === 2)) await gate.pause();
      return result;
    };
    const pending = h.service.resolveToken(); const observed = pending.catch((error) => error);
    await gate.entered; h.fixture.replace(); gate.release();
    assert.equal((await observed) instanceof Error, true);
    const after = structuredClone(await h.record());
    assert.equal(after.refreshOperation.state, point === 'final-receipt' ? 'complete' : 'pending');
    await assert.rejects(h.service.resolveToken());
    assert.deepEqual(await h.record(), after);
    assert.equal(h.mock.counts.refresh, point === 'claim-receipt' ? 0 : 1);
    assert.equal(h.mock.counts.revoke, 0);
    assert.equal(h.service.getView().signedIn, false);
  });
}

for (const rebound of [false, true]) {
  test(`an unavailable pre-POST client secret read ${rebound ? 'stays pending across rebinding' : 'restores the same SQLite grant'}`, sqliteTestOptions, async (t) => {
    let binding = {};
    const h = await sqliteConfidentialHarness(t, { getAtomicStoreBinding: () => binding });
    const before = await h.record();
    const modify = h.credentials.modifyRecord.bind(h.credentials);
    let readFailed = false;
    t.mock.method(h.credentials, 'modifyRecord', async (key, mutator) => {
      const result = await modify(key, mutator);
      if (!readFailed && key === GRANT_KEY && result?.payload.refreshOperation?.state === 'pending') {
        h.fixture.setReadBarrier(() => {
          h.fixture.setReadBarrier(null);
          readFailed = true;
          if (rebound) binding = {};
          throw new Error('synthetic client secret source read unavailable');
        });
      }
      return result;
    });
    if (rebound) {
      await assert.rejects(h.service.resolveToken());
      assert.equal((await h.record()).refreshOperation.state, 'pending');
      assert.equal(h.service.getView().signedIn, false);
    } else {
      assert.equal(await h.service.resolveToken(), before.accessToken);
      assert.deepEqual(await h.record(), before);
      assert.equal(h.service.getView().state, 'ready');
    }
    assert.equal(readFailed, true);
    assert.equal(h.requests.refresh, 0);
    if (!rebound) {
      assert.equal(await h.service.resolveToken(), h.rotated.access_token);
      assert.equal((await h.record()).refreshOperation.state, 'complete');
      assert.equal(h.requests.refresh, 1);
    }
  });
}

for (const changedSource of [false, true]) {
  test(`confidential refresh handoff ${changedSource ? 'retains pending when the source changed' : 'revokes only the confirmed rotated grant'}`, sqliteTestOptions, async (t) => {
    const gate = hold();
    t.after(gate.release);
    const h = await sqliteConfidentialHarness(t, { beforeRefreshResponse: gate.pause });
    const refresh = h.service.getAccessToken().catch((error) => error);
    await Promise.race([
      gate.entered,
      refresh.then(() => assert.fail('refresh settled before the handoff barrier')),
    ]);
    const persistedPending = await h.credentials.readRecord(GRANT_KEY);
    assert.equal(persistedPending.payload.refreshOperation.state, 'pending');
    const signOut = h.service.signOut();
    if (changedSource) h.fixture.replace();
    gate.release();
    const [refreshResult, result] = await Promise.all([refresh, signOut]);
    assert.equal(refreshResult.code, 'IAM_DISPOSED');
    assert.equal(h.requests.refresh, 1);
    if (changedSource) {
      assert.equal(result.revocation, 'unknown');
      assert.deepEqual(h.requests.revoke, []);
      assert.deepEqual(await h.credentials.readRecord(GRANT_KEY), persistedPending);
    } else {
      assert.equal(result.revocation, 'ok');
      assert.equal(result.view.state, 'signed-out');
      assert.deepEqual(h.requests.revoke, [{ method: 'POST', token: h.rotated.refresh_token, hint: 'refresh_token' }]);
      assert.equal((await h.record()).type, 'heluo-iam-session-tombstone');
    }
  });
}

for (const field of ['method', 'secretRef', 'secretRevision']) {
  test(`a foreign shared completion with changed ${field} cannot be adopted`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = await confidentialHarness(t, 'client_secret_basic', { config: { refreshSkewSeconds: 7200 }, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (new URLSearchParams(init?.body).get('grant_type') === 'refresh_token') await gate.pause();
      return response;
    } });
    await signIn(h);
    const owner = h.service.resolveToken(); const ownerResult = owner.catch((error) => error);
    await gate.entered;
    const marker = structuredClone((await h.record()).refreshOperation);
    const replacement = structuredClone(await h.record());
    replacement.authContext[field] = field === 'method' ? 'client_secret_post' : 'different';
    replacement.refreshToken = 'synthetic-foreign-refresh';
    replacement.refreshOperation = { ...marker, state: 'complete' };
    const peer = createIamService(h.config, h.options); t.after(() => peer.dispose());
    const peerPending = peer.resolveToken(); const peerResult = peerPending.catch((error) => error);
    await h.credentials.modifyRecord(GRANT_KEY, () => ({ kind: 'grant', payload: replacement }));
    gate.release();
    assert.equal((await ownerResult) instanceof Error, true);
    assert.equal((await peerResult) instanceof Error, true);
    assert.deepEqual(await h.record(), replacement);
    assert.equal(h.mock.counts.refresh, 1);
  });
}
