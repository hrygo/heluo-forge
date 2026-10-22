import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../src/backend.mjs';
import { createKeychainProvider, KeychainProviderError } from '../src/provider.mjs';

const namespace = 'heluo-forge/iam';

function provider(options = {}) {
  const backend = options.backend ?? createMemoryBackend();
  return { backend, value: createKeychainProvider(backend, options) };
}

test('refs round-trip through the keychain namespace', async () => {
  const { value, backend } = provider();
  await value.set('ENTERPRISE_ACCESS_TOKEN', 'placeholder-token');
  assert.deepEqual(await value.resolve('ENTERPRISE_ACCESS_TOKEN'), {
    value: 'placeholder-token',
    source: 'keychain',
  });
  assert.deepEqual(await value.describe('ENTERPRISE_ACCESS_TOKEN'), {
    configured: true,
    source: 'keychain',
    writable: true,
  });
  assert.equal(backend._snapshot().has(`${namespace}/ref/ENTERPRISE_ACCESS_TOKEN`), true);
  await value.unset('ENTERPRISE_ACCESS_TOKEN');
  assert.equal(await value.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.deepEqual(await value.describe('ENTERPRISE_ACCESS_TOKEN'), { configured: false, writable: true });
});

test('empty values and invalid refs are rejected', async () => {
  const { value } = provider();
  await assert.rejects(
    () => value.set('ENTERPRISE_ACCESS_TOKEN', ''),
    (error) => error instanceof KeychainProviderError && error.code === 'KEYCHAIN_VALUE_EMPTY',
  );
  await assert.rejects(
    () => value.set('not-a-ref', 'x'),
    (error) => error.code === 'KEYCHAIN_REF_INVALID',
  );
});

test('grant records round-trip and are listed', async () => {
  const { value } = provider();
  const record = { kind: 'grant', payload: { version: 1, subject: 'E1001' } };
  const written = await value.modifyRecord('heluo-iam/session', async () => record);
  assert.deepEqual(written, record);
  assert.deepEqual(await value.readRecord('heluo-iam/session'), record);
  assert.deepEqual(await value.describeRecord('heluo-iam/session'), {
    configured: true,
    kind: 'grant',
    writable: true,
  });
  assert.deepEqual(await value.listRecords(), [{ key: 'heluo-iam/session', kind: 'grant' }]);
  await value.deleteRecord('heluo-iam/session');
  assert.equal(await value.readRecord('heluo-iam/session'), undefined);
});

test('api-key records with env survive JSON', async () => {
  const { value } = provider();
  const record = { kind: 'api-key', env: { AWS_PROFILE: 'svc-ci' } };
  await value.modifyRecord('gateway/default', async () => record);
  assert.deepEqual(await value.readRecord('gateway/default'), record);
});

test('a mutator returning undefined leaves the record untouched', async () => {
  const { value } = provider();
  await value.modifyRecord('heluo-iam/session', async () => ({ kind: 'grant', payload: { n: 1 } }));
  const result = await value.modifyRecord('heluo-iam/session', async () => undefined);
  assert.deepEqual(result, { kind: 'grant', payload: { n: 1 } });
});

test('concurrent modifyRecord calls are serialized per key', async () => {
  const { value } = provider();
  const increment = () => value.modifyRecord('heluo-iam/session', async (current) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { kind: 'grant', payload: { n: (current?.payload?.n ?? 0) + 1 } };
  });
  await Promise.all([increment(), increment(), increment()]);
  assert.deepEqual(await value.readRecord('heluo-iam/session'), { kind: 'grant', payload: { n: 3 } });
});

test('corrupt records fail closed instead of reading as empty', async () => {
  const { value, backend } = provider();
  await backend.set(`${namespace}/record/heluo-iam/session`, '{');
  await assert.rejects(
    () => value.readRecord('heluo-iam/session'),
    (error) => error.code === 'KEYCHAIN_RECORD_INVALID',
  );
  await assert.rejects(
    () => value.listRecords(),
    (error) => error.code === 'KEYCHAIN_RECORD_INVALID',
  );
});

test('unknown record kinds and invalid keys are rejected', async () => {
  const { value, backend } = provider();
  await backend.set(`${namespace}/record/heluo-iam/session`, JSON.stringify({ kind: 'other' }));
  await assert.rejects(() => value.readRecord('heluo-iam/session'), /unknown kind/);
  await assert.rejects(() => value.readRecord('not-a-key'), (error) => error.code === 'KEYCHAIN_KEY_INVALID');
  await assert.rejects(() => value.readRecord('Foo/bar'), (error) => error.code === 'KEYCHAIN_KEY_INVALID');
});

test('listRecords ignores other namespaces and reports invalid stored keys', async () => {
  const { value, backend } = provider();
  await backend.set('another/iam/record/foo/bar', JSON.stringify({ kind: 'grant', payload: {} }));
  await value.modifyRecord('heluo-iam/session', async () => ({ kind: 'grant', payload: {} }));
  assert.deepEqual(await value.listRecords(), [{ key: 'heluo-iam/session', kind: 'grant' }]);

  await backend.set(`${namespace}/record/not-a-key`, JSON.stringify({ kind: 'grant', payload: {} }));
  await assert.rejects(() => value.listRecords(), (error) => error.code === 'KEYCHAIN_RECORD_INVALID');
});

test('the provider never claims a cross-process lock or durable memory storage', () => {
  const { value } = provider();
  assert.equal(value.crossProcessLock, false);
  assert.equal(value.durable, false);
});