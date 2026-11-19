import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { createIamService } from '../src/service.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';

const issuer = 'https://iam.corp.example';
const config = {
  issuer, clientId: 'synthetic-client', authorizationEndpoint: `${issuer}/authorize`,
  tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, refreshSkewSeconds: 1,
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

async function openHosts(t) {
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
  const service = createIamService(config, {
    credentials,
    verifyAtomicStore: (candidate) => candidate === credentials && trustBinding !== null,
    getAtomicStoreBinding: (candidate) => candidate === credentials ? trustBinding : null,
    logRenewal(event, fields) {
      if (event === 'session-state' && fields.code === 'IAM_REAUTH_REQUIRED') pendingObserved.resolve();
    },
    async fetch(url, init) {
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
  let held = false;
  t.mock.method(credentials, 'readRecord', async (key) => {
    const record = await readRecord(key);
    if (!held && key === GRANT_KEY && record?.payload?.refreshOperation?.state === 'complete') {
      held = true;
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
