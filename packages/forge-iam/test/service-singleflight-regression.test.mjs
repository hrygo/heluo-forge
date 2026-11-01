import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { createGrantStore } from '../src/store.mjs';

const config = {
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createService(credentials, options = {}) {
  return createIamService(config, { credentials, verifyAtomicStore: () => true, ...options });
}

async function seed(credentials) {
  await createGrantStore(credentials).write({
    version: 1, issuer: config.issuer, subject: 'synthetic', clientId: config.clientId,
    resource: config.gatewayResource, scope: 'openid', obtainedAt: new Date().toISOString(),
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access',
    accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
}

test('synchronous signOut reentry shares the unknown result', async (t) => {
  const credentials = new MemoryCredentials();
  let service;
  let nested;
  let arm = true;
  service = createService(credentials, {
    verifyAtomicStore: () => false,
    recheckExclusive: () => {
      if (arm) { arm = false; nested = service.signOut(); }
      return { ok: true };
    },
  });
  t.after(() => service.dispose());
  const first = service.signOut();
  const result = await first;
  assert.ok(nested);
  assert.deepEqual(await nested, result);
  assert.equal(result.revocation, 'unknown');
});

for (const shouldFail of [false, true]) {
  test(`concurrent signOut callers share ${shouldFail ? 'clear failure' : 'success'}`, async (t) => {
    const credentials = new MemoryCredentials();
    await seed(credentials);
    const entered = deferred();
    const release = deferred();
    const original = credentials.modifyRecord.bind(credentials);
    let writes = 0;
    credentials.modifyRecord = async (key, mutate) => original(key, async (current) => {
      const next = await mutate(current);
      if (next?.payload?.type === 'heluo-iam-session-tombstone') {
        writes += 1;
        entered.resolve();
        await release.promise;
        if (shouldFail) throw new Error('synthetic commit failure');
      }
      return next;
    });
    const service = createService(credentials);
    t.after(() => service.dispose());
    t.after(() => release.resolve());
    const first = service.signOut();
    await entered.promise;
    const second = service.signOut();
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(b, a);
    assert.equal(writes, 1);
    assert.equal(a.view.error, shouldFail ? 'IAM_CREDENTIALS_CLEAR_FAILED' : null);
    if (shouldFail) {
      credentials.modifyRecord = original;
      const retry = await service.signOut();
      assert.equal(retry.view.error, null);
    }
  });
}

test('signOut invalidates attempt synchronously before deferred work', async (t) => {
  const service = createService(new MemoryCredentials());
  t.after(() => service.dispose());
  const first = await service.startSignIn();
  const pending = service.signOut();
  const restarted = service.startSignIn();
  await assert.rejects(restarted, { code: 'IAM_ATTEMPT_CANCELLED' });
  await pending;
  const next = await service.startSignIn();
  assert.notEqual(next.authorizationUrl, first.authorizationUrl);
});

test('trusted provider replacement invalidates the old authorization attempt', async (t) => {
  const a = new MemoryCredentials();
  const b = new MemoryCredentials();
  let current = a;
  const service = createService(a, { getCredentials: () => current, verifyAtomicStore: (candidate) => candidate === a || candidate === b });
  t.after(() => service.dispose());
  const first = await service.startSignIn();
  current = b;
  const second = await service.startSignIn();
  assert.notEqual(second.authorizationUrl, first.authorizationUrl);
  const callback = new URL(config.redirectUri);
  callback.searchParams.set('state', new URL(first.authorizationUrl).searchParams.get('state'));
  callback.searchParams.set('code', 'synthetic');
  await assert.rejects(service.handleCallback(callback.href), { code: 'IAM_STATE_MISMATCH' });
  assert.equal(service.getView().state, 'authenticating');
});

test('dispose during a read prevents later signOut side effects and new calls', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  const entered = deferred();
  const release = deferred();
  const original = credentials.readRecord.bind(credentials);
  let deleted = 0;
  credentials.readRecord = async (key) => { entered.resolve(); await release.promise; return original(key); };
  credentials.deleteRecord = async () => { deleted += 1; };
  let fetches = 0;
  const service = createService(credentials, { fetch: async () => { fetches += 1; throw new Error('unexpected'); } });
  t.after(() => release.resolve());
  const pending = service.signOut();
  await entered.promise;
  await service.dispose();
  await assert.rejects(service.signOut(), { code: 'IAM_DISPOSED' });
  release.resolve();
  await assert.rejects(pending, { code: 'IAM_DISPOSED' });
  assert.equal(deleted, 0);
  assert.equal(fetches, 0);
  assert.equal(service.getView().state, 'signed-out');
});

test('a rejected signOut clears singleflight state for retry', async (t) => {
  let fail = true;
  const service = createService(new MemoryCredentials(), {
    recheckExclusive: () => {
      if (fail) { fail = false; throw new Error('synthetic notification failure'); }
      return { ok: true };
    },
  });
  t.after(() => service.dispose());
  const first = service.signOut();
  const second = service.signOut();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[0].reason, results[1].reason);
  assert.equal((await service.signOut()).view.error, null);
});

test('dispose while waiting for the provider lock starts no revocation or deletion', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  const entered = deferred();
  const release = deferred();
  const modify = credentials.modifyRecord.bind(credentials);
  credentials.modifyRecord = async (key, fn) => {
    entered.resolve();
    await release.promise;
    return modify(key, fn);
  };
  let deleted = 0;
  credentials.deleteRecord = async () => { deleted += 1; };
  let fetches = 0;
  const service = createIamService({ ...config, revocationEndpoint: 'https://iam.corp.example/revoke' }, {
    credentials, verifyAtomicStore: () => true,
    fetch: async () => { fetches += 1; return new Response(null, { status: 200 }); },
  });
  t.after(() => release.resolve());
  const pending = service.signOut();
  await entered.promise;
  await service.dispose();
  release.resolve();
  await assert.rejects(pending, { code: 'IAM_DISPOSED' });
  assert.equal(fetches, 0);
  assert.equal(deleted, 0);
});

test('dispose before deferred signOut starts produces no provider activity', async () => {
  const credentials = new MemoryCredentials();
  let reads = 0;
  const original = credentials.readRecord.bind(credentials);
  credentials.readRecord = async (key) => { reads += 1; return original(key); };
  const service = createService(credentials);
  const pending = service.signOut();
  await service.dispose();
  await assert.rejects(pending, { code: 'IAM_DISPOSED' });
  assert.equal(reads, 0);
});
