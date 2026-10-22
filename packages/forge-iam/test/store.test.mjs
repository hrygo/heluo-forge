import test from 'node:test';
import assert from 'node:assert/strict';
import { GRANT_KEY, TOKEN_REF, StoreError, createGrantStore } from '../src/store.mjs';

const grant = {
  version: 1,
  issuer: 'https://iam.corp.example',
  subject: 'E1001',
  clientId: 'dsh-desktop',
  refreshToken: 'refresh-placeholder',
  scope: 'openid profile offline_access',
  resource: 'https://gateway.corp.example',
  obtainedAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-placeholder',
  accessExpiresAt: '2030-01-01T00:05:00.000Z',
};

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
      return refs.has(ref) ? { value: refs.get(ref), source: 'test' } : undefined;
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

test('write then read round-trips the grant and keeps the key stable', async () => {
  const credentials = fakeCredentials();
  const store = createGrantStore(credentials);
  await store.write(grant);
  const read = await store.read();
  assert.equal(read.ok, true);
  assert.deepEqual(read.grant, grant);
  assert.equal(credentials.records.get(GRANT_KEY).kind, 'grant');
  assert.equal(store.key, 'heluo-iam/session');
  assert.equal(store.ref, 'ENTERPRISE_ACCESS_TOKEN');
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

test('mirror set and resolve use the dedicated ref', async () => {
  const credentials = fakeCredentials();
  const store = createGrantStore(credentials);
  await store.mirror('access-placeholder');
  assert.equal(await store.resolveMirror(), 'access-placeholder');
  assert.equal(credentials.refs.get(TOKEN_REF), 'access-placeholder');
  await assert.rejects(
    () => store.mirror(''),
    (error) => error instanceof StoreError && error.code === 'IAM_TOKEN_EMPTY',
  );
});

test('clear removes both the record and the mirror', async () => {
  const credentials = fakeCredentials({
    records: [[GRANT_KEY, { kind: 'grant', payload: grant }]],
    refs: [[TOKEN_REF, 'access-placeholder']],
  });
  const store = createGrantStore(credentials);
  const result = await store.clear();
  assert.equal(result.ok, true);
  assert.equal(credentials.records.has(GRANT_KEY), false);
  assert.equal(credentials.refs.has(TOKEN_REF), false);
});

test('clear attempts both deletions and reports partial failure', async () => {
  const credentials = fakeCredentials();
  credentials.deleteRecord = async () => {
    throw new Error('locked');
  };
  const store = createGrantStore(credentials);
  const result = await store.clear();
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'delete-record');
});

test('legacy official records are discoverable without being deleted', async () => {
  const credentials = fakeCredentials({
    records: [
      ['deepseek-account/default', { kind: 'grant', payload: {} }],
      ['deepseek-account-platform/default', { kind: 'grant', payload: {} }],
      [GRANT_KEY, { kind: 'grant', payload: grant }],
    ],
  });
  const store = createGrantStore(credentials);
  const legacy = await store.findLegacyRecords();
  assert.deepEqual(legacy.sort(), ['deepseek-account-platform/default', 'deepseek-account/default']);
  assert.equal(credentials.records.size, 3);
});

test('a credentials object missing a required method is rejected', () => {
  assert.throws(
    () => createGrantStore({ readRecord: async () => undefined }),
    (error) => error instanceof StoreError && error.code === 'IAM_CREDENTIALS_UNAVAILABLE',
  );
});