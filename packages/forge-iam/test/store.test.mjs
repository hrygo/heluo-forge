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
  await store.write(grant);
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

test('clear keeps the grant when the mirror cannot be removed', async () => {
  const credentials = fakeCredentials({
    records: [[GRANT_KEY, { kind: 'grant', payload: grant }]],
    refs: [[TOKEN_REF, 'access-placeholder']],
  });
  credentials.unset = async () => {
    throw new Error('locked');
  };
  const store = createGrantStore(credentials);
  const result = await store.clear();
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'unset-mirror');
  assert.equal(credentials.records.has(GRANT_KEY), true);
});

test('clear reports a record deletion failure after removing the mirror', async () => {
  const credentials = fakeCredentials({
    records: [[GRANT_KEY, { kind: 'grant', payload: grant }]],
    refs: [[TOKEN_REF, 'access-placeholder']],
  });
  credentials.deleteRecord = async () => {
    throw new Error('locked');
  };
  const store = createGrantStore(credentials);
  const result = await store.clear();
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'delete-record');
  assert.equal(credentials.refs.has(TOKEN_REF), false);
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
test('an ambient token is not accepted as the IAM mirror', async () => {
  const credentials = fakeCredentials();
  credentials.resolve = async () => ({ value: 'ambient-shell-token', source: 'env' });
  const store = createGrantStore(credentials);
  assert.equal(await store.resolveMirror(), undefined);
});

for (const record of [undefined, { kind: 'grant', payload: { ...grant, accessToken: 'newer-access' } }]) {
  test(`mirror withdraws its token when the grant is ${record ? 'different' : 'missing'}`, async () => {
    const credentials = fakeCredentials({ records: record ? [[GRANT_KEY, record]] : [] });
    const store = createGrantStore(credentials);
    await assert.rejects(
      () => store.mirror(grant.accessToken),
      (error) => error instanceof StoreError && error.code === 'IAM_REAUTH_REQUIRED',
    );
    assert.equal(await store.resolveMirror(), undefined);
  });
}

test('mirror withdraws its token when the grant cannot be reread', async () => {
  const credentials = fakeCredentials({ records: [[GRANT_KEY, { kind: 'grant', payload: grant }]] });
  credentials.readRecord = async () => { throw new Error('synthetic read failure'); };
  const store = createGrantStore(credentials);
  await assert.rejects(
    () => store.mirror(grant.accessToken),
    (error) => error instanceof StoreError && error.code === 'IAM_REAUTH_REQUIRED',
  );
  assert.equal(await store.resolveMirror(), undefined);
});

test('clear removes a mirror published while record deletion was pending', async () => {
  const credentials = fakeCredentials({ records: [[GRANT_KEY, { kind: 'grant', payload: grant }]] });
  const store = createGrantStore(credentials);
  let enterDelete;
  let releaseDelete;
  const entered = new Promise((resolve) => { enterDelete = resolve; });
  const released = new Promise((resolve) => { releaseDelete = resolve; });
  const deleteRecord = credentials.deleteRecord.bind(credentials);
  credentials.deleteRecord = async (key) => {
    enterDelete();
    await released;
    return deleteRecord(key);
  };

  const clearing = store.clear();
  await entered;
  await store.mirror(grant.accessToken);
  releaseDelete();
  assert.equal((await clearing).ok, true);
  assert.equal((await store.read()).grant, null);
  assert.equal(await store.resolveMirror(), undefined);
});

test('clear reports a final mirror cleanup failure after deleting the grant', async () => {
  const credentials = fakeCredentials({ records: [[GRANT_KEY, { kind: 'grant', payload: grant }]] });
  const unset = credentials.unset.bind(credentials);
  let calls = 0;
  credentials.unset = async (ref) => {
    if (++calls === 2) throw new Error('synthetic final cleanup failure');
    return unset(ref);
  };
  const result = await createGrantStore(credentials).clear();
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].step, 'unset-mirror');
  assert.equal(credentials.records.has(GRANT_KEY), false);
});
