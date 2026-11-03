import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGrant, parseGrant } from '../src/record.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { createIamService } from '../src/service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const config = { issuer: 'https://iam.corp.example', clientId: 'synthetic-client',
  authorizationEndpoint: 'https://iam.corp.example/authorize', tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks', redirectUri: 'http://127.0.0.1:9/iam/callback' };
const context = () => ({ mode: 'confidential', method: 'client_secret_basic', secretRef: 'fixture-client', secretRevision: 'synthetic-revision' });
function grant(version = 2) {
  return { version, issuer: config.issuer, subject: 'synthetic-subject', clientId: config.clientId,
    sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
    ...(version === 2 ? { authContext: context() } : {}) };
}

for (const method of ['client_secret_basic', 'client_secret_post']) {
  test(`V2 ${method} parses with an independent immutable context copy`, () => {
    const original = grant(); original.authContext.method = method;
    const parsed = validateGrant(original);
    assert.equal(parsed.ok, true);
    assert.equal(parseGrant(JSON.stringify(original)).ok, true);
    assert.deepEqual(parsed.value.authContext, original.authContext);
    assert.equal(parsed.value.authContext === original.authContext, false);
    assert.equal(Object.isFrozen(parsed.value.authContext), true);
    original.authContext.secretRevision = 'later-revision';
    assert.equal(parsed.value.authContext.secretRevision, 'synthetic-revision');
  });
}

for (const marker of ['authContext', 'clientAuth', 'authMode', 'clientAuthMethod', 'clientSecretRef', 'clientSecret', 'client_secret']) {
  for (const [name, value] of [['undefined', undefined], ['null', null], ['object', context()]]) {
    test(`V1 cannot disguise an authentication marker as legacy: ${marker} ${name}`, () => {
      const original = { ...grant(1), [marker]: value };
      assert.equal(validateGrant(original).ok, false);
    });
  }
}

for (const [name, change] of [
  ['missing context', (value) => { delete value.authContext; }],
  ['null context', (value) => { value.authContext = null; }],
  ['array context', (value) => { value.authContext = []; }],
  ['public context', (value) => { value.authContext.mode = 'public'; }],
  ['none method', (value) => { value.authContext.method = 'none'; }],
  ['missing method', (value) => { delete value.authContext.method; }],
  ['empty ref', (value) => { value.authContext.secretRef = ''; }],
  ['undefined revision', (value) => { value.authContext.secretRevision = undefined; }],
  ['unknown context', (value) => { value.authContext.extra = undefined; }],
  ['nested secret', (value) => { value.authContext.value = 'SYNTHETIC_STORED_PRIVATE'; }],
  ['nested header', (value) => { value.authContext.authorization = 'SYNTHETIC_STORED_PRIVATE'; }],
  ['nested schema version', (value) => { value.authContext.version = 1; }],
  ['outer secret', (value) => { value.clientSecret = 'SYNTHETIC_STORED_PRIVATE'; }],
  ['outer header', (value) => { value.headers = { authorization: 'SYNTHETIC_STORED_PRIVATE' }; }],
  ['unknown outer', (value) => { value.future = undefined; }],
]) {
  test(`V2 rejects ${name} without copying raw fields into validation errors`, () => {
    const original = grant(); change(original);
    const parsed = validateGrant(original);
    assert.equal(parsed.ok, false);
    assert.equal(JSON.stringify(parsed).includes('SYNTHETIC_STORED_PRIVATE'), false);
  });
}

test('stable snapshots preserve V1 unknown extensions without evaluating their getter again', () => {
  let reads = 0;
  const original = grant(1);
  Object.defineProperty(original, 'futureExtension', { enumerable: true, get() { reads++; return 'synthetic-extension'; } });
  const parsed = validateGrant(original);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.futureExtension, 'synthetic-extension');
  assert.equal(validateGrant(parsed.value).ok, true);
  assert.equal(reads, 1);
});

test('private snapshots do not drop non-enumerable presence-only V1 authentication markers', () => {
  for (const marker of ['authContext', 'clientAuth']) {
    const original = grant(1);
    Object.defineProperty(original, marker, { value: undefined, enumerable: false });
    assert.equal(validateGrant(original).ok, false);
  }
});

test('V2 version getter is sampled once so normalization cannot produce V1 plus confidential context', () => {
  let reads = 0;
  const original = grant();
  Object.defineProperty(original, 'version', { enumerable: true, get() { return ++reads <= 3 ? 2 : 1; } });
  const parsed = validateGrant(original);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.version, 2);
  assert.equal(validateGrant(parsed.value).ok, true);
  assert.equal(reads, 1);
});

test('recognized top-level getters cannot turn validated access data into an invalid output', () => {
  let reads = 0;
  const original = grant();
  Object.defineProperty(original, 'accessToken', { enumerable: true, get() { return ++reads <= 2 ? 'synthetic-access' : undefined; } });
  const parsed = validateGrant(original);
  assert.equal(parsed.ok, true);
  assert.equal(validateGrant(parsed.value).ok, true);
  assert.equal(reads, 1);
});

test('a refresh marker is an independent stable data snapshot, not mutable source getters', () => {
  let reads = 0;
  const original = grant();
  const marker = { version: 1, state: 'pending', base: Buffer.alloc(32, 9).toString('base64url') };
  Object.defineProperty(marker, 'id', { enumerable: true,
    get() { return ++reads <= 2 ? Buffer.alloc(32, 8).toString('base64url') : 'invalid'; } });
  original.refreshOperation = marker;
  const parsed = validateGrant(original);
  assert.equal(parsed.ok, true);
  assert.equal(validateGrant(parsed.value).ok, true);
  assert.equal(parsed.value.refreshOperation === marker, false);
  assert.equal(Object.isFrozen(parsed.value.refreshOperation), true);
  assert.equal(reads, 1);
});

test('the public service cannot adopt a V2 getter that changes version only during normalization', async (t) => {
  const credentials = new MemoryCredentials();
  let reads = 0;
  const original = grant();
  Object.defineProperty(original, 'version', { enumerable: true, get() { return ++reads <= 3 ? 2 : 1; } });
  const record = { kind: 'grant', payload: original };
  credentials.records.set(GRANT_KEY, record);
  const service = createIamService(config, { credentials, now: () => now });
  t.after(() => service.dispose());
  await service.hydrate();
  assert.equal(service.getView().signedIn, false);
  assert.equal(service.getPrincipal(), undefined);
  assert.equal(await credentials.readRecord(GRANT_KEY) === record, true);
  assert.equal(reads, 1);
});

test('store can round-trip V2 without changing its context or interpreting it as authentication', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const original = grant();
  await store.write(original);
  assert.deepEqual((await store.read()).grant, original);
  assert.equal(credentials.refs.size, 0);
});

for (const field of ['method', 'secretRef', 'secretRevision', 'version']) {
  test(`callback discard cannot tombstone the same session under another ${field}`, async () => {
    const credentials = new MemoryCredentials();
    const expected = grant(); const current = grant();
    if (field === 'version') { current.version = 1; delete current.authContext; }
    else current.authContext[field] = field === 'method' ? 'client_secret_post' : 'different';
    const record = { kind: 'grant', payload: current };
    credentials.records.set(GRANT_KEY, record);
    const store = createGrantStore(credentials, { verifyAtomicStore: (candidate) => candidate === credentials });
    const result = await store.discardCallbackGrant(expected);
    assert.equal(result.ok, false);
    assert.deepEqual(await credentials.readRecord(GRANT_KEY), record);
  });
}

test('callback discard and exact logout preserve the complete V2 identity', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials, { verifyAtomicStore: (candidate) => candidate === credentials });
  const original = grant();
  await store.write(original);
  assert.deepEqual(await store.discardCallbackGrant(original), { ok: true, decision: 'discarded' });
  assert.equal((await store.read()).grant, null);
  await store.write(original);
  const another = grant(); another.authContext.secretRevision = 'another';
  let revoked = 0;
  const result = await store.signOutSnapshot(another, async () => { revoked++; });
  assert.equal(result.decision, 'replaced');
  assert.equal(revoked, 0);
  assert.deepEqual((await store.read()).grant, original);
});

for (const action of ['hydrate', 'sync', 'token', 'expired-token', 'pending-sync', 'shared-token', 'signout', 'save-gateway']) {
  test(`the public service refuses a valid same-issuer V2 grant during ${action} without secret I/O, POST or deletion`, async (t) => {
    const credentials = new MemoryCredentials();
    const original = { kind: 'grant', payload: grant() };
    if (action === 'expired-token') original.payload.accessExpiresAt = new Date(now - 1000).toISOString();
    if (action === 'pending-sync') original.payload.refreshOperation = { version: 1, state: 'pending',
      id: Buffer.alloc(32, 8).toString('base64url'), base: Buffer.alloc(32, 9).toString('base64url') };
    credentials.records.set(GRANT_KEY, structuredClone(original));
    let requests = 0; let secretReads = 0;
    credentials.resolve = async (ref) => {
      // The pre-existing gateway-status read is not a client-secret source.
      if (ref === 'ENTERPRISE_STATIC_KEY') return undefined;
      secretReads++; throw new Error('must not resolve a client secret');
    };
    const service = createIamService(config, { credentials, now: () => now,
      verifyAtomicStore: (candidate) => candidate === credentials,
      fetch: async () => { requests++; throw new Error('must not send'); },
      getClientSecretSource: () => { secretReads++; throw new Error('must not discover'); },
    });
    t.after(() => service.dispose());
    if (action === 'hydrate') await service.hydrate();
    else if (action === 'sync' || action === 'pending-sync') await service.syncFromStore();
    else if (action === 'token' || action === 'expired-token') await assert.rejects(service.resolveToken(), { code: 'IAM_CLIENT_AUTH_CONTEXT_INVALID' });
    else if (action === 'shared-token') {
      const outcomes = await Promise.allSettled([service.resolveToken(), service.resolveToken()]);
      assert.equal(outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason.code === 'IAM_CLIENT_AUTH_CONTEXT_INVALID'), true);
    } else if (action === 'signout') {
      const result = await service.signOut(); assert.equal(result.revocation, 'unknown');
    } else await assert.rejects(service.saveGatewayCredential({ key: `uag-${'a'.repeat(32)}` }), { code: 'IAM_CLIENT_AUTH_CONTEXT_INVALID' });
    assert.equal(service.getView().signedIn, false);
    assert.equal(service.getPrincipal(), undefined);
    assert.deepEqual(await credentials.readRecord(GRANT_KEY), original);
    assert.equal(requests, 0);
    assert.equal(secretReads, 0);
  });
}
