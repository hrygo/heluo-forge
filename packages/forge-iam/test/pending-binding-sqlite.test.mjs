import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { createIamService } from '../src/service.mjs';
import { REFRESH_TIMEOUT_MS } from '../src/service-helpers.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';

const issuer = 'https://iam.corp.example';
const config = {
  issuer, clientId: 'synthetic-client', authorizationEndpoint: `${issuer}/authorize`,
  tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, refreshSkewSeconds: 1,
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

async function openHosts(t, { refreshSkewSeconds = config.refreshSkewSeconds, fetchJwks, monotonic } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-iam-pending-binding-'));
  const backend = createCredentialStore({ directory });
  const peer = createCredentialStore({ directory });
  const observerWrites = [];
  const credentials = createKeychainProvider(backend, { notifyRecord: (key) => observerWrites.push(key) });
  const writer = createGrantStore(createKeychainProvider(peer));
  const pendingObserved = Promise.withResolvers();
  const readingReceipt = Promise.withResolvers();
  const releaseReceipt = Promise.withResolvers();
  const posts = [];
  let trustBinding = {};
  const service = createIamService({ ...config, refreshSkewSeconds }, {
    credentials,
    monotonic,
    verifyAtomicStore: (candidate) => candidate === credentials && trustBinding !== null,
    getAtomicStoreBinding: (candidate) => candidate === credentials ? trustBinding : null,
    logRenewal(event, fields) {
      if (event === 'session-state' && fields.code === 'IAM_REAUTH_REQUIRED') pendingObserved.resolve();
    },
    async fetch(url, init) {
      if (url === config.jwksUri && fetchJwks) return fetchJwks();
      if (init?.method === 'POST') posts.push(url);
      throw new Error('pending receipt observation does not need network I/O');
    },
  });
  t.after(async () => {
    releaseReceipt.resolve();
    await service.dispose();
    await peer.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  });
  const readRecord = credentials.readRecord.bind(credentials);
  t.mock.method(credentials, 'readRecord', async (key) => {
    const record = await readRecord(key);
    if (key === GRANT_KEY && record?.payload?.refreshOperation?.state === 'complete') {
      readingReceipt.resolve();
      await releaseReceipt.promise;
    }
    return record;
  });
  const now = Date.now();
  const original = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer, clientId: config.clientId, subject: 'synthetic-subject', scope: 'openid',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + 300_000).toISOString(),
    refreshExpiresAt: new Date(now + 360_000).toISOString(),
    accessToken: 'synthetic-original-access', refreshToken: 'synthetic-original-refresh',
  };
  const id = Buffer.alloc(32, 9).toString('base64url');
  const operation = { version: 1, state: 'pending', id, base: refreshBaseId(original, id) };
  const pending = { ...original, refreshOperation: operation };
  const complete = {
    ...original, accessToken: 'synthetic-rotated-access', refreshToken: 'synthetic-rotated-refresh',
    accessExpiresAt: new Date(now + 420_000).toISOString(), refreshExpiresAt: new Date(now + 480_000).toISOString(),
    refreshOperation: { ...operation, state: 'complete' },
  };
  return {
    service, writer, posts, observerWrites, original, pending, complete,
    pendingObserved: pendingObserved.promise, readingReceipt: readingReceipt.promise,
    releaseReceipt: releaseReceipt.resolve,
    replaceTrust() { trustBinding = {}; },
  };
}

for (const adopted of [true, false]) {
  const entry = adopted ? 'an adopted session observer' : 'a cold token request';
  for (const replaceTrust of [true, false]) {
    const outcome = replaceTrust ? 'rejects a receipt across trust replacement' : 'adopts a receipt under the same trust binding';
    test(`${entry} ${outcome}`, { timeout: 10_000 }, async (t) => {
      const host = await openHosts(t);
      const { service, writer, pending, complete, posts, observerWrites } = host;
      if (adopted) {
        await writer.write(host.original);
        assert.equal((await service.hydrate()).state, 'ready');
      }
      await writer.write(pending);
      if (adopted) assert.equal((await service.syncFromStore()).state, 'ready');
      else assert.equal(service.getSession().signedIn, false);

      const result = service.resolveToken();
      void result.catch(() => {});
      if (!adopted) await host.pendingObserved;
      assert.deepEqual((await writer.read()).grant, pending);
      await writer.write(complete);
      await host.readingReceipt;
      if (replaceTrust) host.replaceTrust();
      host.releaseReceipt();

      if (replaceTrust) {
        await assert.rejects(result, { code: 'IAM_REAUTH_REQUIRED' });
        await assert.rejects(() => service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
        assert.equal(service.getView().error, 'IAM_REAUTH_REQUIRED');
        assert.equal(service.getSession().signedIn, false);
        assert.equal(service.getPrincipal(), undefined);
      } else {
        assert.equal(await result, complete.accessToken);
        assert.equal(service.getView().state, 'ready');
        assert.equal(service.getSession().signedIn, true);
      }
      assert.deepEqual((await writer.read()).grant, complete);
      assert.deepEqual(observerWrites, []);
      assert.deepEqual(posts, []);
    });
  }
}

test('concurrent token requests recover a peer receipt after cold hydration observed pending', { timeout: 10_000 }, async (t) => {
  const host = await openHosts(t);
  const { service, writer, pending, complete, posts, observerWrites } = host;
  await writer.write(pending);
  assert.equal((await service.hydrate()).error, 'IAM_REAUTH_REQUIRED');
  assert.equal(service.getSession().signedIn, false);

  const tokens = Promise.all([service.getAccessToken(), service.resolveToken()]);
  void tokens.catch(() => {});
  assert.deepEqual((await writer.read()).grant, pending);
  await writer.write(complete);
  await Promise.race([
    host.readingReceipt,
    tokens.then(() => assert.fail('token requests must wait for the durable receipt')),
  ]);
  assert.equal(service.getSession().signedIn, false);
  host.releaseReceipt();

  assert.deepEqual(await tokens, [complete.accessToken, complete.accessToken]);
  assert.equal(service.getView().state, 'ready');
  assert.deepEqual((await writer.read()).grant, complete);
  assert.deepEqual(observerWrites, []);
  assert.deepEqual(posts, []);
});

for (const replaceTrust of [false, true]) {
  test(`a cold observer accepts a distinct peer login ${replaceTrust ? 'after rejecting a rebound receipt' : 'during the original observation window'}`, { timeout: 10_000 }, async (t) => {
    const host = await openHosts(t);
    const { service, writer, original, pending, complete, posts, observerWrites } = host;
    await writer.write(pending);
    assert.equal((await service.hydrate()).error, 'IAM_REAUTH_REQUIRED');

    if (replaceTrust) {
      host.replaceTrust();
      host.releaseReceipt();
      await writer.write(complete);
      await assert.rejects(() => service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
      assert.equal(service.getSession().signedIn, false);
    }

    const replacement = {
      ...original,
      sessionInstanceId: Buffer.alloc(32, 11).toString('base64url'),
      obtainedAt: new Date().toISOString(),
      accessToken: 'synthetic-new-login-access',
      refreshToken: 'synthetic-new-login-refresh',
    };
    await writer.write(replacement);

    assert.equal(await service.getAccessToken(), replacement.accessToken);
    assert.equal(service.getView().state, 'ready');
    assert.deepEqual((await writer.read()).grant, replacement);
    assert.deepEqual(observerWrites, []);
    assert.deepEqual(posts, []);
  });
}

test('a token request keeps the original pending observation deadline after cold hydration', { timeout: 10_000 }, async (t) => {
  let elapsed = 0;
  const host = await openHosts(t, { monotonic: () => elapsed });
  const { service, writer, pending, complete, posts, observerWrites } = host;
  await writer.write(pending);
  assert.equal((await service.hydrate()).error, 'IAM_REAUTH_REQUIRED');

  elapsed = REFRESH_TIMEOUT_MS / 2;
  const rejection = assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  void rejection.catch(() => {});
  await writer.write(complete);
  await Promise.race([
    host.readingReceipt,
    rejection.then(() => assert.fail('token request must wait within the original observation window')),
  ]);
  elapsed = REFRESH_TIMEOUT_MS + 1;
  host.releaseReceipt();

  await rejection;
  await assert.rejects(() => service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(service.getSession().signedIn, false);
  assert.deepEqual((await writer.read()).grant, complete);
  assert.deepEqual(observerWrites, []);
  assert.deepEqual(posts, []);
});

test('a wall-clock jump does not spend the original SQLite pending observation budget', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let elapsed = 0;
  const host = await openHosts(t, { monotonic: () => elapsed });
  const { service, writer, pending, complete, posts, observerWrites } = host;
  await writer.write(pending);
  assert.equal((await service.hydrate()).error, 'IAM_REAUTH_REQUIRED');

  t.mock.timers.tick(2 * REFRESH_TIMEOUT_MS);
  elapsed = REFRESH_TIMEOUT_MS / 2;
  await writer.write(complete);
  host.releaseReceipt();
  assert.equal(await service.getAccessToken(), complete.accessToken);
  assert.equal(service.getView().state, 'ready');
  assert.deepEqual(await writer.read(), { ok: true, grant: complete });
  assert.deepEqual(posts, []);
  assert.deepEqual(observerWrites, []);
});

const preflightOutcomes = [
  ['within', 'adopts a receipt within the panel observation window'],
  ['late', 'rejects a receipt after the panel observation window'],
  ['replacement', 'keeps its original login when another Host signs in'],
];
for (const [outcome, description] of preflightOutcomes) {
  test(`a request in preflight ${description}`, { timeout: 10_000 }, async (t) => {
    let elapsed = 0;
    const readingJwks = Promise.withResolvers();
    const releaseJwks = Promise.withResolvers();
    t.after(releaseJwks.resolve);
    const host = await openHosts(t, {
      refreshSkewSeconds: 600,
      monotonic: () => elapsed,
      async fetchJwks() {
        readingJwks.resolve();
        await releaseJwks.promise;
        return Response.json({ keys: [] });
      },
    });
    const { service, writer, original, pending, complete, posts, observerWrites } = host;
    await writer.write(original);
    const result = service.getAccessToken();
    void result.catch(() => {});
    await readingJwks.promise;
    await writer.write(pending);
    assert.equal((await service.syncFromStore()).error, 'IAM_REAUTH_REQUIRED');

    if (outcome === 'late') elapsed = REFRESH_TIMEOUT_MS + 1;
    const saved = outcome === 'replacement' ? {
      ...original,
      sessionInstanceId: Buffer.alloc(32, 12).toString('base64url'),
      accessToken: 'synthetic-peer-login-access',
      refreshToken: 'synthetic-peer-login-refresh',
      accessExpiresAt: new Date(Date.now() + 700_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 760_000).toISOString(),
    } : complete;
    await writer.write(saved);
    host.releaseReceipt();
    releaseJwks.resolve();
    if (outcome === 'within') {
      assert.equal(await result, complete.accessToken);
      assert.equal(service.getSession().signedIn, true);
    } else {
      await assert.rejects(result, { code: 'IAM_REAUTH_REQUIRED' });
      assert.equal(service.getSession().signedIn, false);
    }
    if (outcome === 'replacement') assert.equal(await service.getAccessToken(), saved.accessToken);
    assert.deepEqual((await writer.read()).grant, saved);
    assert.deepEqual(posts, []);
    assert.deepEqual(observerWrites, []);
  });
}
