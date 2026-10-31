import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const config = { issuer: 'https://iam.example', authorizationEndpoint: 'https://iam.example/authorize', tokenEndpoint: 'https://iam.example/token', jwksUri: 'https://iam.example/jwks', clientId: 'test', redirectUri: 'http://127.0.0.1:4567/iam/callback', allowInsecureHttp: true, refreshSkewSeconds: 7200 };
const grant = { version: 1, issuer: 'https://iam.example', subject: 'subject', clientId: 'test', refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid', obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(), sessionInstanceId: Buffer.alloc(32, 1).toString('base64url') };

function fake() {
  const credentials = new MemoryCredentials();
  credentials.crossProcessLock = true;
  credentials.durable = true;
  credentials.kind = 'keychain';
  credentials.transaction = async (fn) => fn();
  return credentials;
}

test('self-attested provider cannot expose authorization URL or write', async () => {
  const credentials = fake();
  let writes = 0;
  credentials.modifyRecord = async () => { writes++; };
  const service = createIamService(config, { credentials });
  await assert.rejects(service.startSignIn(), { code: 'IAM_ATOMIC_STORE_UNVERIFIED' });
  assert.equal(writes, 0);
});

test('self-attested provider cannot claim refresh or send a POST', async () => {
  const credentials = fake();
  await createGrantStore(credentials).write(grant);
  let writes = 0; let posts = 0;
  credentials.modifyRecord = async () => { writes++; };
  const service = createIamService(config, { credentials, fetch: async (_url, init) => { if (init?.method === 'POST') posts++; throw Error('unexpected network'); } });
  await assert.rejects(service.resolveToken(), { code: 'IAM_ATOMIC_STORE_UNVERIFIED' });
  assert.equal(writes, 0); assert.equal(posts, 0);
});

test('direct cleanup refuses before modifyRecord when capability is absent', async () => {
  const credentials = fake();
  let writes = 0;
  credentials.modifyRecord = async () => { writes++; };
  const result = await createGrantStore(credentials).discardCallbackGrant(grant);
  assert.equal(result.ok, false); assert.equal(writes, 0);
});

test('only literal true from a synchronous verifier authorizes exact instance', async () => {
  for (const verifyAtomicStore of [undefined, () => 1, () => 'true', () => Promise.resolve(true), () => Promise.reject(Error('asynchronous rejection')), () => { throw Error('no'); }]) {
    const service = createIamService(config, { credentials: fake(), verifyAtomicStore });
    await assert.rejects(service.startSignIn(), { code: 'IAM_ATOMIC_STORE_UNVERIFIED' });
  }
});

test('untrusted existing non-refreshing V1 access remains readable', async () => {
  const credentials = fake();
  const { sessionInstanceId, ...legacy } = grant;
  await createGrantStore(credentials).write(legacy);
  const service = createIamService({ ...config, refreshSkewSeconds: 0 }, { credentials });
  assert.equal((await service.hydrate()).state, 'ready');
  assert.equal(await service.resolveToken(), legacy.accessToken);
});

test('provider replacement after read prevents refresh claim or post', async () => {
  const original = fake(); const replacement = fake();
  await createGrantStore(original).write(grant);
  let current = original; let release; let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const read = original.readRecord.bind(original);
  original.readRecord = async (key) => { const result = await read(key); entered(); await gate; return result; };
  let writes = 0; let posts = 0;
  original.modifyRecord = async () => { writes++; };
  replacement.modifyRecord = async () => { writes++; };
  const service = createIamService(config, { getCredentials: () => current, verifyAtomicStore: (candidate) => candidate === original, fetch: async (_url, init) => { if (init?.method === 'POST') posts++; throw Error('unexpected'); } });
  const pending = service.resolveToken();
  await waiting; current = replacement; release();
  // Provider identity now fails before the atomicity verifier is consulted.
  await assert.rejects(pending, { code: 'IAM_CREDENTIALS_UNAVAILABLE' });
  assert.equal(writes, 0); assert.equal(posts, 0);
});

test('signOut after provider replacement reports unknown without writes or revoke', async () => {
  const original = fake(); const replacement = fake();
  await createGrantStore(original).write(grant);
  let current = original; let entered; let release; let effects = 0;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const read = original.readRecord.bind(original);
  original.readRecord = async (key) => { const result = await read(key); entered(); await gate; return result; };
  for (const item of [original, replacement]) {
    item.modifyRecord = async () => { effects++; };
    item.deleteRecord = async () => { effects++; };
  }
  const service = createIamService({ ...config, revocationEndpoint: 'https://iam.example/revoke' }, { getCredentials: () => current, verifyAtomicStore: (candidate) => candidate === original, fetch: async () => { effects++; throw Error('unexpected'); } });
  const pending = service.signOut();
  await waiting; current = replacement; release();
  const result = await pending;
  assert.equal(effects, 0); assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
});

test('untrusted signOut does not mutate or delete stored record', async () => {
  const credentials = fake();
  await createGrantStore(credentials).write(grant);
  let mutations = 0; let requests = 0;
  credentials.modifyRecord = async () => { mutations++; };
  credentials.deleteRecord = async () => { mutations++; };
  const result = await createIamService({ ...config, revocationEndpoint: 'https://iam.example/revoke' }, { credentials, fetch: async () => { requests++; throw Error('unexpected'); } }).signOut();
  assert.equal(mutations, 0); assert.equal(requests, 0);
  assert.equal((await credentials.readRecord('heluo-iam/session')).payload.refreshToken, grant.refreshToken);
  assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
});
