import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { confidentialHarness, authorization, signIn, hold } from './support/client-auth-service.mjs';

test('reusing a cached authorization URL still validates its original confidential pin', async (t) => {
  const h = await confidentialHarness(t);
  await h.service.startSignIn(); h.fixture.replace();
  await assert.rejects(h.service.startSignIn(), { code: 'IAM_CLIENT_AUTH_CHANGED' });
  assert.equal(h.mock.counts.token, 0);
});

test('public cancellation cannot be lost in a newly introduced source-free await', async (t) => {
  const h = await confidentialHarness(t);
  const config = { ...h.config, authMode: 'public', clientAuthMethod: 'none' }; delete config.clientSecretRef;
  let service; let checks = 0;
  service = createIamService(config, { credentials: h.credentials,
    verifyAtomicStore: () => { if (++checks === 2) queueMicrotask(() => service.cancelSignIn()); return true; },
    get getClientSecretSource() { throw new Error('public must not inspect source'); },
    get verifyClientSecretSource() { throw new Error('public must not inspect verifier'); } });
  t.after(() => service.dispose());
  await assert.rejects(service.startSignIn(), { code: 'IAM_ATTEMPT_CANCELLED' });
  assert.equal(service.getView().state, 'signed-out');
});

test('a source change after the first JWKS await stops even the missing-key retry', async (t) => {
  let h; let reads = 0;
  h = await confidentialHarness(t, 'client_secret_basic', { fetch: async (url, init) => {
    if (String(url).endsWith('/jwks')) {
      reads++;
      if (reads === 1) { h.fixture.replace(); return Response.json({ keys: [] }); }
    }
    return fetch(url, init);
  } });
  const callback = await authorization(h.service);
  await assert.rejects(h.service.handleCallback(callback), { code: 'IAM_CLIENT_AUTH_CHANGED' });
  assert.equal(reads, 1);
  assert.equal(h.mock.counts.token, 1);
  assert.equal(h.mock.counts.revoke, 0);
  assert.equal(await h.record(), undefined);
});

for (const point of ['json', 'jwks', 'commit-entry', 'commit-receipt', 'gateway']) {
  test(`callback source change at ${point} rejects stale success without new-context cleanup`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const credentials = new MemoryCredentials();
    const modify = credentials.modifyRecord.bind(credentials);
    let first = true;
    credentials.modifyRecord = async (key, mutate) => {
      const target = key === GRANT_KEY && first;
      if (target) first = false;
      if (target && point === 'commit-entry') await gate.pause();
      const result = await modify(key, mutate);
      if (target && point === 'commit-receipt') await gate.pause();
      return result;
    };
    if (point === 'gateway') credentials.describe = async () => { await gate.pause(); return { configured: false, writable: true }; };
    const h = await confidentialHarness(t, 'client_secret_basic', { credentials, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (point === 'jwks' && String(url).endsWith('/jwks')) await gate.pause();
      if (point === 'json' && String(url).endsWith('/token')) {
        const json = response.json.bind(response);
        response.json = async () => { const body = await json(); await gate.pause(); return body; };
      }
      return response;
    } });
    const callback = await authorization(h.service);
    const observed = h.service.handleCallback(callback).catch((error) => error);
    await gate.entered; h.fixture.replace(); gate.release();
    assert.equal((await observed) instanceof Error, true);
    assert.equal(h.service.getView().signedIn, false);
    assert.equal(h.mock.counts.token, 1);
    assert.equal(h.mock.counts.revoke, 0);
    const grant = await h.record();
    assert.equal(grant === undefined || grant.type === 'heluo-iam-session-tombstone', true);
  });
}

for (const point of ['hydrate', 'usable-access']) {
  test(`${point} source read cannot authorize after credentials replacement`, async (t) => {
    const h = await confidentialHarness(t); await signIn(h);
    const gate = hold(); t.after(gate.release);
    const original = h.fixture.source;
    const source = { async read(binding) { const snapshot = await original.read(binding); await gate.pause(); return snapshot; },
      isCurrent: original.isCurrent };
    let currentCredentials = h.credentials;
    const options = { ...h.options, getCredentials: () => currentCredentials, getClientSecretSource: () => source,
      verifyClientSecretSource: (credentials, candidate, scope) => candidate === source && credentials === h.credentials
        && scope.issuer === h.mock.issuer && scope.clientId === h.mock.clientId
        && scope.ref === h.config.clientSecretRef && scope.method === h.config.clientAuthMethod };
    const service = createIamService(h.config, options); t.after(() => service.dispose());
    const pending = point === 'hydrate' ? service.hydrate() : service.resolveToken();
    const observed = pending.catch((error) => error);
    await gate.entered; currentCredentials = new MemoryCredentials(); gate.release();
    const result = await observed;
    if (point === 'usable-access') assert.equal(result instanceof Error, true);
    assert.equal(service.getView().signedIn, false);
    assert.equal(h.mock.counts.token, 1);
    assert.equal(h.mock.counts.revoke, 0);
  });
}

for (const field of ['subject', 'sessionInstanceId', 'secretRevision']) {
  test(`sourcegone local logout preserves an unauthenticated replacement ${field}`, async (t) => {
    const h = await confidentialHarness(t); await signIn(h);
    const replacement = structuredClone(await h.record());
    if (field === 'secretRevision') replacement.authContext.secretRevision = 'different';
    else replacement[field] = field === 'sessionInstanceId' ? Buffer.alloc(32, 33).toString('base64url') : 'different';
    await h.credentials.modifyRecord(GRANT_KEY, () => ({ kind: 'grant', payload: replacement }));
    h.fixture.remove();
    const result = await h.service.signOut();
    assert.equal(result.revocation, 'unknown');
    assert.deepEqual(await h.record(), replacement);
    assert.equal(h.mock.counts.revoke, 0);
  });
}

test('client-secret reads stay outside all grant locks, including refresh, revoke and cleanup', async (t) => {
  const h = await confidentialHarness(t, 'client_secret_post', { config: { refreshSkewSeconds: 7200 } });
  let locked = false;
  const modify = h.credentials.modifyRecord.bind(h.credentials);
  h.credentials.modifyRecord = (key, mutate) => modify(key, async (current) => {
    locked = true;
    try { return await mutate(current); } finally { locked = false; }
  });
  const original = h.fixture.source;
  const source = { async read(binding) { assert.equal(locked, false); return original.read(binding); }, isCurrent: original.isCurrent };
  h.options.getClientSecretSource = () => source;
  h.options.verifyClientSecretSource = (credentials, candidate, scope) => credentials === h.credentials && candidate === source
    && scope.issuer === h.mock.issuer && scope.clientId === h.mock.clientId
    && scope.ref === h.config.clientSecretRef && scope.method === h.config.clientAuthMethod;
  await signIn(h); await h.service.resolveToken();
  assert.equal((await h.service.signOut()).revocation, 'ok');
  assert.equal(h.mock.counts.refresh, 1);
  assert.equal(h.mock.counts.revoke, 1);
});
