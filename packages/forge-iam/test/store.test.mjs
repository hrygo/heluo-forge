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

const grant = {
  version: 1,
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

test('saving a gateway credential writes the value and its owner metadata', async () => {
  const credentials = fakeCredentials();
  const store = createGatewayCredentialStore(credentials);
  await store.save({
    value: gatewayValue,
    ownerSubject: 'E1001',
    deviceLabel: '工作站-01',
    enteredAt: '2030-01-01T00:00:00.000Z',
    suggestedExpiry: '2030-04-01',
  });
  assert.equal(credentials.refs.get(GATEWAY_REF), gatewayValue);
  const record = credentials.records.get(GATEWAY_RECORD_KEY);
  assert.equal(record.kind, 'gateway-credential');
  assert.equal(record.payload.ownerSubject, 'E1001');
  assert.equal(record.payload.deviceLabel, '工作站-01');
  assert.equal((await store.read()).credential.ownerSubject, 'E1001');
  assert.equal(await store.resolve(), gatewayValue);
});

test('a malformed gateway credential is rejected before any write', async () => {
  const credentials = fakeCredentials();
  const store = createGatewayCredentialStore(credentials);
  await assert.rejects(
    () => store.save({ value: 'not-a-uag-key', ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    (error) => error instanceof StoreError && error.code === 'IAM_GATEWAY_KEY_INVALID',
  );
  assert.equal(credentials.refs.size, 0);
  assert.equal(credentials.records.size, 0);
});

test('a gateway credential needs the signed-in subject', async () => {
  const credentials = fakeCredentials();
  const store = createGatewayCredentialStore(credentials);
  await assert.rejects(
    () => store.save({ value: gatewayValue, ownerSubject: '', enteredAt: '2030-01-01T00:00:00.000Z' }),
    (error) => error instanceof StoreError && error.code === 'IAM_GATEWAY_OWNER_MISSING',
  );
});

test('a failed metadata write never stores the value', async () => {
  const credentials = fakeCredentials();
  const store = createGatewayCredentialStore(credentials);
  credentials.modifyRecord = async () => {
    throw new Error('record write failed');
  };
  await assert.rejects(
    () => store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    /record write failed/,
  );
  assert.equal(credentials.refs.has(GATEWAY_REF), false);
});

test('a failed value write withdraws the metadata', async () => {
  const credentials = fakeCredentials();
  const store = createGatewayCredentialStore(credentials);
  credentials.set = async () => {
    throw new Error('keychain locked');
  };
  await assert.rejects(
    () => store.save({ value: gatewayValue, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' }),
    /keychain locked/,
  );
  assert.equal(credentials.records.has(GATEWAY_RECORD_KEY), false);
  assert.equal(credentials.refs.has(GATEWAY_REF), false);
});

test('an ambient environment value is not treated as the stored gateway credential', async () => {
  const credentials = fakeCredentials();
  credentials.resolve = async () => ({ value: gatewayValue, source: 'env' });
  assert.equal(await createGatewayCredentialStore(credentials).resolve(), undefined);
});

test('clearing a gateway credential removes the value first, then the metadata', async () => {
  const credentials = fakeCredentials({
    records: [[GATEWAY_RECORD_KEY, {
      kind: 'gateway-credential',
      payload: { version: 1, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' },
    }]],
    refs: [[GATEWAY_REF, gatewayValue]],
  });
  const store = createGatewayCredentialStore(credentials);
  const result = await store.clear();
  assert.equal(result.ok, true);
  assert.equal(credentials.refs.has(GATEWAY_REF), false);
  assert.equal(credentials.records.has(GATEWAY_RECORD_KEY), false);
});

test('a failed value removal keeps the metadata that reports the secret', async () => {
  const credentials = fakeCredentials({
    records: [[GATEWAY_RECORD_KEY, {
      kind: 'gateway-credential',
      payload: { version: 1, ownerSubject: 'E1001', enteredAt: '2030-01-01T00:00:00.000Z' },
    }]],
    refs: [[GATEWAY_REF, gatewayValue]],
  });
  credentials.unset = async () => {
    throw new Error('locked');
  };
  const result = await createGatewayCredentialStore(credentials).clear();
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].step, 'unset-ref');
  assert.equal(credentials.records.has(GATEWAY_RECORD_KEY), true);
});

test('a gateway record of another kind is reported, not read as a credential', async () => {
  const credentials = fakeCredentials({
    records: [[GATEWAY_RECORD_KEY, { kind: 'grant', payload: {} }]],
  });
  const read = await createGatewayCredentialStore(credentials).read();
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'wrong-kind');
});