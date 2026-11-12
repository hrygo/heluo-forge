import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { createIamService } from './support/trusted-service.mjs';

const issuer = 'https://iam.corp.example';
const config = {
  issuer, authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`,
  jwksUri: `${issuer}/jwks`, clientId: 'fixture',
  redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 60,
};

function grant() {
  const now = Date.now();
  return { version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + 4000).toISOString(),
    refreshExpiresAt: new Date(now + 20_000).toISOString() };
}

function network() {
  let posts = 0;
  return {
    get posts() { return posts; },
    async fetch(url, init) {
      if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
      if (String(url).endsWith('/token') && init?.method === 'POST') {
        posts += 1;
        return Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh',
          token_type: 'Bearer', expires_in: 30 });
      }
      throw new Error('unexpected request');
    },
  };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.equal(predicate(), true, 'the expected background transition did not occur');
}

test('a real SQLite lock timeout before the claim callback recovers in the background', { timeout: 8000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'iam-claim-lock-'));
  const directory = join(root, 'store');
  const backend = createCredentialStore({ directory, lockTimeoutMs: 80 });
  const blockerBackend = createCredentialStore({ directory, lockTimeoutMs: 80 });
  const credentials = createKeychainProvider(backend);
  const store = createGrantStore(credentials);
  const initial = grant();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requests = network();
  const service = createIamService(config, { credentials, fetch: requests.fetch });
  let blocking;
  t.after(async () => {
    release.resolve();
    await blocking;
    await service.dispose();
    await blockerBackend.close();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.write(initial);
  assert.equal((await service.hydrate()).state, 'ready');
  const modify = credentials.modifyRecord.bind(credentials);
  let callbacks = 0;
  credentials.modifyRecord = (key, mutate) => modify(key, (current) => { callbacks += 1; return mutate(current); });
  blocking = blockerBackend.transaction('heluo-forge/iam/ref/LOCK_TEST', async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  await assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(callbacks, 0, 'the claim did not enter its mutator');
  assert.equal(requests.posts, 0);
  assert.deepEqual((await store.read()).grant, initial);
  release.resolve();
  await blocking;
  await waitUntil(() => requests.posts === 1 && service.getView().state === 'ready'
    && service.getView().accessExpiresAt !== initial.accessExpiresAt);
  assert.equal((await store.read()).grant.refreshOperation.state, 'complete');
});

test('a claim callback arriving after a timeout cannot produce a pending record', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const initial = grant();
  await store.write(initial);
  const requests = network();
  const service = createIamService(config, { credentials, fetch: requests.fetch });
  t.after(() => service.dispose());
  assert.equal((await service.hydrate()).state, 'ready');
  let late;
  credentials.modifyRecord = async (_key, mutate) => {
    late = mutate;
    throw Object.assign(new Error('synthetic claim timeout'), { code: 'CRED_LOCK_TIMEOUT' });
  };
  await assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(typeof late, 'function');
  const replacement = { ...initial, subject: 'synthetic-replacement', refreshToken: 'replacement-refresh' };
  credentials.records.set(GRANT_KEY, { kind: 'grant', payload: replacement });
  const result = await late({ kind: 'grant', payload: structuredClone(initial) }).catch(() => undefined);
  if (result !== undefined) credentials.records.set(GRANT_KEY, result);
  assert.equal(result === undefined, true, 'a late callback must not return a write candidate');
  assert.deepEqual((await store.read()).grant, replacement);
  assert.equal(requests.posts, 0);
});

test('a timeout after observing another pending claim fails closed', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const initial = grant();
  await store.write(initial);
  const requests = network();
  const service = createIamService(config, { credentials, fetch: requests.fetch });
  t.after(() => service.dispose());
  assert.equal((await service.hydrate()).state, 'ready');
  const id = 'A'.repeat(43);
  const pending = { kind: 'grant', payload: { ...initial, refreshOperation: {
    version: 1, state: 'pending', id, base: refreshBaseId(initial, id),
  } } };
  credentials.modifyRecord = async (key, mutate) => {
    credentials.records.set(key, pending);
    assert.equal(await mutate(pending), undefined);
    throw Object.assign(new Error('synthetic lock release timeout'), { code: 'CRED_LOCK_TIMEOUT' });
  };
  await assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(service.getView().state, 'error');
  assert.equal((await store.read()).grant.refreshOperation.state, 'pending');
  assert.equal(requests.posts, 0);
});

test('a claim timeout after producing a candidate never retries or sends a refresh', { timeout: 6000 }, async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const initial = grant();
  await store.write(initial);
  const requests = network();
  const service = createIamService(config, { credentials, fetch: requests.fetch });
  t.after(() => service.dispose());
  assert.equal((await service.hydrate()).state, 'ready');
  const modify = credentials.modifyRecord.bind(credentials);
  let candidate;
  let attempts = 0;
  credentials.modifyRecord = async (key, mutate) => {
    attempts += 1;
    if (attempts !== 1) return modify(key, mutate);
    candidate = await mutate(await credentials.readRecord(key));
    throw Object.assign(new Error('synthetic uncertain commit'), { code: 'CRED_LOCK_TIMEOUT' });
  };
  await assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(candidate?.payload?.refreshOperation?.state, 'pending');
  credentials.records.set(GRANT_KEY, candidate); // The unknown write commits after the error.
  await delay(2300);
  assert.equal(attempts, 1);
  assert.equal(requests.posts, 0);
  assert.equal(service.getView().state, 'error');
  assert.equal((await store.read()).grant.refreshOperation.state, 'pending');
});
