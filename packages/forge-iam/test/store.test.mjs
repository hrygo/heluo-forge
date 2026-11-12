import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRANT_KEY,
  GATEWAY_RECORD_KEY,
  GATEWAY_REF,
  LEGACY_TOKEN_REF,
  StoreError,
  createGatewayCredentialStore,
  createGrantStore,
} from '../src/store.mjs';
import { createAtomicGatewayFixture } from './support/atomic-gateway.mjs';

const grant = {
  version: 1,
  sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
  issuer: 'https://iam.corp.example',
  subject: 'E1001',
  clientId: 'dsh-desktop',
  refreshToken: 'refresh-placeholder',
  scope: 'openid profile offline_access',
  obtainedAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-placeholder',
  accessExpiresAt: '2030-01-01T00:05:00.000Z',
};

const gatewayValue = `uag-${'a1b2c3d4'.repeat(4)}`;

function fakeCredentials(initial = {}) {
  const records = new Map(initial.records ?? []);
  const refs = new Map(initial.refs ?? []);
  return {
    records,
    refs,
    async readRecord(key) {
      return records.get(key);
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
    async deleteRecord(key) {
      records.delete(key);
    },
    async set(ref, value) {
      refs.set(ref, value);
    },
    async unset(ref) {
      refs.delete(ref);
    },
    async resolve(ref) {
      return refs.has(ref) ? { value: refs.get(ref), source: 'keychain' } : undefined;
    },
    async listRecords() {
      return [...records.entries()].map(([key, record]) => ({ key, kind: record.kind }));
    },
  };
}

test('read returns null when no IAM record exists', async () => {
  const store = createGrantStore(fakeCredentials());
  assert.deepEqual(await store.read(), { ok: true, grant: null });
});

test('grant reads preserve the result and details for string, invalid and pending records', async () => {
  const id = Buffer.alloc(32, 1).toString('base64url');
  const read = async (record) => createGrantStore(fakeCredentials({ records: [[GRANT_KEY, record]] })).read();
  assert.deepEqual(await read({ kind: 'grant', payload: JSON.stringify(grant) }), { ok: true, grant });
  assert.deepEqual(await read({ kind: 'grant', payload: '{not valid json' }), {
    ok: false, reason: 'invalid-grant', errors: ['grant payload is not valid JSON'],
  });
  assert.deepEqual(await read({ kind: 'api-key' }), { ok: false, reason: 'wrong-kind', kind: 'api-key' });
  const signout = { ...grant, signOutOperation: { version: 1, state: 'pending', id } };
  assert.deepEqual(await read({ kind: 'grant', payload: JSON.stringify(signout) }), { ok: false, reason: 'sign-out-pending' });
  const refresh = { ...grant, refreshOperation: { version: 1, state: 'pending', id, base: id } };
  assert.deepEqual(await read({ kind: 'grant', payload: JSON.stringify(refresh) }), { ok: true, grant: refresh });
});

test('write then read round-trips the grant and keeps the key stable', async () => {
  const credentials = fakeCredentials();
  const store = createGrantStore(credentials);
  await store.write(grant);
  const read = await store.read();
  assert.equal(read.ok, true);
  assert.deepEqual(read.grant, grant);
  assert.equal(credentials.records.get(GRANT_KEY).kind, 'grant');
  assert.equal(store.key, 'heluo-iam/session');
});

test('guard rejects a delayed grant write inside modifyRecord without reporting success', async () => {
  const credentials = fakeCredentials({ records: [[GRANT_KEY, { kind: 'grant', payload: grant }]] });
  const modify = credentials.modifyRecord;
  let entered;
  let release;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  credentials.modifyRecord = async (key, mutate) => {
    entered();
    await gate;
    return modify(key, mutate);
  };
  let valid = true;
  const store = createGrantStore(credentials);
  const pending = store.write({ ...grant, accessToken: 'stale' }, {
    guard: () => { if (!valid) throw new Error('attempt interrupted'); },
  });
  const rejected = assert.rejects(pending, /attempt interrupted/);
  await waiting;
  valid = false;
  release();
  await rejected;
  assert.deepEqual((await store.read()).grant, grant);
});

test('a guard that does not return true rejects rather than reporting a successful write', async () => {
  for (const guard of [() => false, () => undefined, 'invalid']) {
    const credentials = fakeCredentials({ records: [[GRANT_KEY, { kind: 'grant', payload: grant }]] });
    await assert.rejects(
      createGrantStore(credentials).write({ ...grant, accessToken: 'stale' }, { guard }),
      { code: 'IAM_GRANT_WRITE_REJECTED' },
    );
    assert.deepEqual((await createGrantStore(credentials).read()).grant, grant);
  }
});

test('callback discard atomically tombstones only its identified grant and permits later login', async () => {
  const credentials = fakeCredentials();
  const store = createGrantStore(credentials, { verifyAtomicStore: (instance) => instance === credentials });
  const own = { ...grant, sessionInstanceId: Buffer.alloc(32, 1).toString('base64url') };
  const newer = { ...own, sessionInstanceId: Buffer.alloc(32, 2).toString('base64url') };
  await store.write(own);
  assert.equal((await store.discardCallbackGrant(newer)).ok, true);
  assert.deepEqual((await store.read()).grant, own);
  assert.equal((await store.discardCallbackGrant(own)).ok, true);
  assert.deepEqual(credentials.records.get(GRANT_KEY), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
  assert.deepEqual(await store.read(), { ok: true, grant: null });
  let seen;
  await store.mutate((current) => { seen = current; return undefined; });
  assert.equal(seen, null);
  await store.write(newer);
  assert.deepEqual((await store.read()).grant, newer);
});

test('discard refuses legacy or malformed records and unconfirmed provider results', async () => {
  const own = { ...grant, sessionInstanceId: Buffer.alloc(32, 1).toString('base64url') };
  for (const record of [
    { kind: 'grant', payload: (({ sessionInstanceId, ...rest }) => rest)(grant) },
    { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone', secret: 'x' } },
    { kind: 'api-key', payload: { version: 1, type: 'heluo-iam-session-tombstone' } },
  ]) {
    const credentials = fakeCredentials({ records: [[GRANT_KEY, record]] });
    const store = createGrantStore(credentials, { verifyAtomicStore: (instance) => instance === credentials });
    if (record.payload.type) assert.equal((await store.read()).ok, false);
    assert.equal((await store.discardCallbackGrant(own)).ok, false);
    assert.deepEqual(credentials.records.get(GRANT_KEY), record);
  }
  const credentials = fakeCredentials({ records: [[GRANT_KEY, { kind: 'grant', payload: own }]] });
  credentials.modifyRecord = async (_key, mutator) => { await mutator(credentials.records.get(GRANT_KEY)); return undefined; };
  assert.equal((await createGrantStore(credentials, { verifyAtomicStore: (instance) => instance === credentials }).discardCallbackGrant(own)).ok, false);
  assert.equal((await createGrantStore(credentials).read()).grant.sessionInstanceId, own.sessionInstanceId);
});

test('discard reports unknown if the provider throws after tombstone commit', async () => {
  const own = { ...grant, sessionInstanceId: Buffer.alloc(32, 5).toString('base64url') };
  const credentials = fakeCredentials({ records: [[GRANT_KEY, { kind: 'grant', payload: own }]] });
  const modify = credentials.modifyRecord;
  credentials.modifyRecord = async (key, mutate) => {
    await modify(key, mutate);
    throw new Error('synthetic acknowledgement failure');
  };
  const store = createGrantStore(credentials, { verifyAtomicStore: (instance) => instance === credentials });
  assert.equal((await store.discardCallbackGrant(own)).ok, false);
  assert.deepEqual(await store.read(), { ok: true, grant: null });
  assert.deepEqual(credentials.records.get(GRANT_KEY), { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } });
});

test('a grant without a gateway audience is still valid', async () => {
  const { resource, ...withoutResource } = grant;
  const credentials = fakeCredentials();
  const store = createGrantStore(credentials);
  await store.write(withoutResource);
  assert.deepEqual((await store.read()).grant, withoutResource);
});

test('a non-grant record is reported, not overwritten implicitly', async () => {
  const credentials = fakeCredentials({
    records: [[GRANT_KEY, { kind: 'api-key', key: 'stale' }]],
  });
  const store = createGrantStore(credentials);
  const read = await store.read();
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'wrong-kind');
  await assert.rejects(
    () => store.write(grant),
    (error) => error instanceof StoreError && error.code === 'IAM_RECORD_KIND_MISMATCH',
  );
});

test('a corrupt grant payload is reported as invalid, not treated as signed in', async () => {
  const credentials = fakeCredentials({
    records: [[GRANT_KEY, { kind: 'grant', payload: { version: 2 } }]],
  });
  const store = createGrantStore(credentials);
  const read = await store.read();
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'invalid-grant');
  assert.ok(read.errors.length > 0);
});

test('an invalid grant is rejected before modifyRecord is called', async () => {
  const credentials = fakeCredentials();
  const store = createGrantStore(credentials);
  let called = false;
  credentials.modifyRecord = async () => {
    called = true;
  };
  await assert.rejects(
    () => store.write({ ...grant, version: 2 }),
    (error) => error instanceof StoreError && error.code === 'IAM_GRANT_INVALID',
  );
  assert.equal(called, false);
});

test('clear removes the grant and leaves model credentials alone', async () => {
  const credentials = fakeCredentials({
    records: [[GRANT_KEY, { kind: 'grant', payload: grant }]],
    refs: [[GATEWAY_REF, gatewayValue]],
  });
  const store = createGrantStore(credentials);
  const result = await store.clear();
  assert.equal(result.ok, true);
  assert.equal(credentials.records.has(GRANT_KEY), false);
  assert.equal(credentials.refs.get(GATEWAY_REF), gatewayValue);
});

test('clear reports a record deletion failure', async () => {
  const credentials = fakeCredentials({
    records: [[GRANT_KEY, { kind: 'grant', payload: grant }]],
  });
  credentials.deleteRecord = async () => {
    throw new Error('locked');
  };
  const result = await createGrantStore(credentials).clear();
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'delete-record');
});

test('clearLegacyToken removes the V0.3 mirror ref once', async () => {
  const credentials = fakeCredentials({ refs: [[LEGACY_TOKEN_REF, 'old-access-token']] });
  const result = await createGrantStore(credentials).clearLegacyToken();
  assert.equal(result.ok, true);
  assert.equal(credentials.refs.has(LEGACY_TOKEN_REF), false);
  // Idempotent: a second run must not fail.
  assert.equal((await createGrantStore(credentials).clearLegacyToken()).ok, true);
});

test('clearLegacyToken reports a storage failure without throwing', async () => {
  const credentials = fakeCredentials({ refs: [[LEGACY_TOKEN_REF, 'old-access-token']] });
  credentials.unset = async () => {
    throw new Error('locked');
  };
  const result = await createGrantStore(credentials).clearLegacyToken();
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'locked');
});

test('legacy official records are discoverable without being deleted', async () => {
  const credentials = fakeCredentials({
    records: [
      ['deepseek-account/default', { kind: 'grant', payload: {} }],
      ['deepseek-account-platform/default', { kind: 'grant', payload: {} }],
      ['deepseek-account-platform/device', { kind: 'api-key', key: 'device' }],
      [GRANT_KEY, { kind: 'grant', payload: grant }],
    ],
  });
  const store = createGrantStore(credentials);
  const legacy = await store.findLegacyRecords();
  assert.deepEqual(legacy.sort(), ['deepseek-account-platform/default', 'deepseek-account/default']);
  assert.equal(credentials.records.size, 4);
  assert.equal(legacy.includes('deepseek-account-platform/device'), false);
});

test('a credentials object missing a required method is rejected', () => {
  assert.throws(
    () => createGrantStore({ readRecord: async () => undefined }),
    (error) => error instanceof StoreError && error.code === 'IAM_CREDENTIALS_UNAVAILABLE',
  );
});

test('saving a gateway credential atomically writes its value and bound V2 owner metadata', async () => {
  const atomic = createAtomicGatewayFixture();
  const { credentials } = atomic;
  const store = createGatewayCredentialStore(credentials, atomic.options);
  await store.save({
    value: gatewayValue,
    ownerSubject: 'E1001',
    deviceLabel: '工作站-01',
    enteredAt: '2030-01-01T00:00:00.000Z',
    suggestedExpiry: '2030-04-01',
  });
  assert.equal(credentials.refs.get(GATEWAY_REF), gatewayValue);
  const record = credentials.records.get(GATEWAY_RECORD_KEY);
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.version, 2);
  assert.equal(typeof record.payload.writeOperationId, 'string');
  assert.equal(typeof record.payload.valueDigest, 'string');
  assert.equal(record.payload.ownerSubject, 'E1001');
  assert.equal(record.payload.deviceLabel, '工作站-01');
  assert.equal(JSON.stringify(record).includes(gatewayValue), false);
  assert.equal(atomic.adapter.commits, 1);
  assert.equal((await store.read()).credential.ownerSubject, 'E1001');
  assert.deepEqual(await store.resolve(record.payload), { value: gatewayValue, source: 'keychain' });
});

test('an empty gateway credential is rejected before any write', async () => {
  const atomic = createAtomicGatewayFixture();
  const { credentials } = atomic;
  const store = createGatewayCredentialStore(credentials, atomic.options);
  await assert.rejects(
    () => store.save({ value: '', ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    (error) => error instanceof StoreError && error.code === 'IAM_GATEWAY_KEY_INVALID',
  );
  assert.equal(credentials.refs.size, 0);
  assert.equal(credentials.records.size, 0);
});

test('a V2.1-format credential saves and can be replaced without an address', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  const first = `uag-sk-u-${'A'.repeat(43)}`;
  const second = `uag-sk-a-${'B'.repeat(43)}`;
  await store.save({ value: first, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(atomic.credentials.refs.get(GATEWAY_REF), first);
  const replaced = await store.save({ value: second, ownerSubject: 'E1001', enteredAt: '2030-01-02T00:00:00.000Z' });
  assert.equal(replaced.ok, true);
  assert.equal(atomic.credentials.refs.get(GATEWAY_REF), second);
  assert.deepEqual(await store.resolve(replaced.credential), { value: second, source: 'keychain' });
});

test('a V2.1-format credential clears without tripping the legacy guard', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  await store.save({ value: `uag-sk-u-${'C'.repeat(43)}`, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' });
  assert.equal((await store.clear()).ok, true);
  assert.equal(atomic.credentials.refs.has(GATEWAY_REF), false);
});

test('credential values are opaque: punctuation, spaces and non-ASCII are stored verbatim', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  for (const value of ['gpt-4o@2024 key', '凭据-示例', `uag-sk-u-${'Z'.repeat(43)}`]) {
    const saved = await store.save({ value, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' });
    assert.deepEqual(await store.resolve(saved.credential), { value, source: 'keychain' });
  }
});

test('a gateway credential needs the signed-in subject', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  await assert.rejects(
    () => store.save({ value: gatewayValue, ownerSubject: '', enteredAt: '2030-01-01T00:00:00.000Z' }),
    (error) => error instanceof StoreError && error.code === 'IAM_GATEWAY_OWNER_MISSING',
  );
});

test('a failed gateway snapshot never changes either member of the pair', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  const before = atomic.pair();
  let snapshots = 0;
  atomic.adapter.snapshot = async () => { snapshots++; throw new Error('synthetic snapshot failure'); };
  await assert.rejects(store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
  assert.equal(snapshots, 1);
  assert.deepEqual(atomic.pair(), before);
  assert.equal(atomic.adapter.attempts, 0);
  assert.equal(atomic.adapter.commits, 0);
});

test('a rejected gateway CAS leaves both value and metadata unchanged', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  const before = atomic.pair();
  atomic.adapter.compareAndSwap = async () => ({ ok: false });
  await assert.rejects(store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    { code: 'IAM_GATEWAY_CHANGED' });
  assert.deepEqual(atomic.pair(), before);
  assert.equal(atomic.adapter.commits, 0);
});

test('a gateway commit failure before updating either map leaves the pair unchanged', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  const before = atomic.pair();
  atomic.adapter.beforeCommit = async () => { throw new Error('synthetic transaction failure'); };
  await assert.rejects(store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
  assert.deepEqual(atomic.pair(), before);
  assert.equal(atomic.adapter.commits, 0);
});

test('an unknown gateway commit receipt never compensates by deleting the committed pair', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  atomic.adapter.afterCommit = async () => { throw new Error('synthetic lost receipt'); };
  await assert.rejects(store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
  const after = atomic.pair();
  assert.equal(after.value === gatewayValue, true);
  assert.equal(after.record?.payload?.ownerSubject === 'E1001', true);
  assert.equal(after.record?.payload?.version, 2);
  assert.equal(atomic.adapter.commits, 1);
});

test('resolve reports the provider source so ambient values stay distinguishable', async () => {
  const { credentials, options } = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(credentials, options);
  const saved = await store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' });
  credentials.resolve = async () => ({ value: gatewayValue, source: 'env' });
  assert.deepEqual(await store.resolve(saved.credential), { value: gatewayValue, source: 'env' });
});

test('clearing a modern gateway pair atomically removes the value and writes a fresh tombstone nonce', async () => {
  const atomic = createAtomicGatewayFixture();
  const { credentials } = atomic;
  const store = createGatewayCredentialStore(credentials, atomic.options);
  await store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' });
  const savedNonce = atomic.pair().record.payload.writeOperationId;
  assert.equal((await store.clear()).ok, true);
  assert.equal(credentials.refs.has(GATEWAY_REF), false);
  assert.equal((await store.read()).credential, null);
  const firstNonce = atomic.pair().record.payload.writeOperationId;
  assert.equal(typeof firstNonce, 'string');
  assert.notEqual(firstNonce, savedNonce);
  assert.equal((await store.clear()).ok, true);
  assert.notEqual(atomic.pair().record.payload.writeOperationId, firstNonce);
  assert.equal(atomic.adapter.commits, 3);
});

test('legacy V1 gateway pairs stay read-only even with exact atomic capability', async () => {
  const credentials = fakeCredentials({
    records: [[GATEWAY_RECORD_KEY, { kind: 'grant',
      payload: { version: 1, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' } }]],
    refs: [[GATEWAY_REF, gatewayValue]],
  });
  const atomic = createAtomicGatewayFixture(credentials);
  const store = createGatewayCredentialStore(credentials, atomic.options);
  const before = atomic.pair();
  await assert.rejects(store.clear(), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  await assert.rejects(store.save({ value: gatewayValue, ownerSubject: 'E1002', enteredAt: '2030-01-01T00:00:00.000Z' }),
    { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  assert.deepEqual(atomic.pair(), before);
  assert.equal(atomic.adapter.commits, 0);
});

test('a failed modern gateway clear keeps the entire bound pair unchanged', async () => {
  const atomic = createAtomicGatewayFixture();
  const store = createGatewayCredentialStore(atomic.credentials, atomic.options);
  await store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' });
  const before = atomic.pair();
  atomic.adapter.beforeCommit = async () => { throw new Error('synthetic clear transaction failure'); };
  await assert.rejects(store.clear(), { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
  assert.deepEqual(atomic.pair(), before);
  assert.equal(atomic.adapter.commits, 1);
});

test('a gateway record of another kind is reported, not read as a credential', async () => {
  const credentials = fakeCredentials({
    records: [[GATEWAY_RECORD_KEY, { kind: 'api-key', key: 'stale' }]],
  });
  const read = await createGatewayCredentialStore(credentials).read();
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'wrong-kind');
});
