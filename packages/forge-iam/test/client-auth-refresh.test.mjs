import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { createIamService } from '../src/service.mjs';
import { GRANT_KEY } from '../src/store.mjs';
import { confidentialHarness, signIn, hold } from './support/client-auth-service.mjs';

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
  test(`an unavailable pre-POST client secret read ${rebound ? 'stays pending across rebinding' : 'restores the same SQLite grant'}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-iam-unsent-auth-'));
    const backend = createCredentialStore({ directory });
    const credentials = createKeychainProvider(backend);
    let binding = {};
    const h = await confidentialHarness(t, 'client_secret_basic', {
      credentials,
      config: { refreshSkewSeconds: 7200 },
      getAtomicStoreBinding: (candidate) => candidate === credentials ? binding : null,
    });
    t.after(async () => {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    });
    await signIn(h);
    const before = await h.record();
    const modify = credentials.modifyRecord.bind(credentials);
    let first = true;
    t.mock.method(credentials, 'modifyRecord', async (...args) => {
      const result = await modify(...args);
      if (first && args[0] === GRANT_KEY) {
        first = false;
        h.fixture.setReadBarrier(() => {
          h.fixture.setReadBarrier(null);
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
    assert.equal(h.mock.counts.refresh, 0);
    if (!rebound) {
      assert.notEqual(await h.service.resolveToken(), before.accessToken);
      assert.equal((await h.record()).refreshOperation.state, 'complete');
      assert.equal(h.mock.counts.refresh, 1);
    }
  });
}

for (const changedSource of [false, true]) {
  test(`confidential refresh handoff ${changedSource ? 'retains pending when the source changed' : 'revokes only the confirmed rotated grant'}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-iam-confidential-handoff-'));
    const backend = createCredentialStore({ directory });
    const credentials = createKeychainProvider(backend);
    const gate = hold();
    t.after(gate.release);
    let rotatedToken;
    const revokeRequests = [];
    const h = await confidentialHarness(t, 'client_secret_basic', {
      credentials,
      config: { revocationMode: 'rfc7009', refreshSkewSeconds: 7200 },
      async fetch(url, init) {
        const response = await fetch(url, init);
        const form = new URLSearchParams(init?.body);
        if (form.get('grant_type') === 'refresh_token') {
          rotatedToken = (await response.clone().json()).refresh_token;
          await gate.pause();
        }
        if (new URL(url).pathname === '/revoke') {
          revokeRequests.push({ method: init.method, token: form.get('token'), hint: form.get('token_type_hint') });
        }
        return response;
      },
    });
    t.after(async () => {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    });
    await signIn(h);
    const refresh = h.service.getAccessToken().catch((error) => error);
    await gate.entered;
    const persistedPending = await credentials.readRecord(GRANT_KEY);
    assert.equal(persistedPending.payload.refreshOperation.state, 'pending');
    const signOut = h.service.signOut();
    if (changedSource) h.fixture.replace();
    gate.release();
    assert.equal((await refresh).code, 'IAM_DISPOSED');
    const result = await signOut;
    assert.equal(h.mock.counts.refresh, 1);
    if (changedSource) {
      assert.equal(result.revocation, 'unknown');
      assert.deepEqual(revokeRequests, []);
      assert.deepEqual(await credentials.readRecord(GRANT_KEY), persistedPending);
    } else {
      assert.equal(result.revocation, 'ok');
      assert.equal(result.view.state, 'signed-out');
      assert.deepEqual(revokeRequests, [{ method: 'POST', token: rotatedToken, hint: 'refresh_token' }]);
      assert.equal((await credentials.readRecord(GRANT_KEY)).payload.type, 'heluo-iam-session-tombstone');
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
