import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBackend, createMemoryBackend } from '../src/backend.mjs';
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
test('a rejected mutator does not persist a corrupt record', async () => {
  const { value, backend } = provider();
  await assert.rejects(
    () => value.modifyRecord('heluo-iam/session', async () => ({ kind: 'grant' })),
    (error) => error.code === 'KEYCHAIN_RECORD_INVALID',
  );
  assert.equal(await value.readRecord('heluo-iam/session'), undefined);
  assert.deepEqual(await value.listRecords(), []);
  assert.equal([...backend._snapshot().keys()].some((key) => key.includes('/record/')), false);
});
for (const failure of ['throw', 'reject']) {
  test(`notification ${failure} cannot disguise successful reference writes or deletes`, async (t) => {
    const secret = 'synthetic-reference-canary';
    const output = [];
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => output.push(args));
    const notifyReference = () => {
      if (failure === 'throw') throw new Error(secret);
      return Promise.reject(new Error(secret));
    };
    const { value, backend } = provider({ notifyReference });
    let setError;
    try { await value.set('EXAMPLE_REF', secret); } catch (error) { setError = error; }
    assert.equal(await backend.get(`${namespace}/ref/EXAMPLE_REF`), secret);
    assert.equal(setError === undefined, true, 'committed set must succeed despite notification failure');
    let unsetError;
    try { await value.unset('EXAMPLE_REF'); } catch (error) { unsetError = error; }
    assert.equal(await backend.get(`${namespace}/ref/EXAMPLE_REF`), undefined);
    assert.equal(unsetError === undefined, true, 'committed unset must succeed despite notification failure');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(output).includes(secret), false);
  });

  for (const transactional of [false, true]) {
    test(`notification ${failure} cannot disguise successful ${transactional ? 'transactional' : 'non-transactional'} record writes or deletes`, async (t) => {
      const secret = 'synthetic-record-canary';
      const output = [];
      for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => output.push(args));
      const notifyRecord = () => {
        if (failure === 'throw') throw new Error(secret);
        return Promise.reject(new Error(secret));
      };
      let backend = createMemoryBackend();
      if (transactional) {
        const dir = await mkdtemp(join(tmpdir(), 'forge-notify-test-'));
        t.after(() => rm(dir, { recursive: true, force: true }));
        backend = createFileBackend({ path: join(dir, 'records.json') });
      }
      const { value } = provider({ backend, notifyRecord });
      const record = { kind: 'grant', payload: { refreshToken: secret } };
      let result;
      let writeError;
      try { result = await value.modifyRecord('heluo-iam/session', () => record); } catch (error) { writeError = error; }
      assert.equal((await value.readRecord('heluo-iam/session')).payload.refreshToken, secret);
      assert.equal(writeError === undefined, true, 'committed write must succeed despite notification failure');
      assert.equal(result.payload.refreshToken, secret);
      let deleteError;
      try { await value.deleteRecord('heluo-iam/session'); } catch (error) { deleteError = error; }
      assert.equal(await value.readRecord('heluo-iam/session'), undefined);
      assert.equal(deleteError === undefined, true, 'committed delete must succeed despite notification failure');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(JSON.stringify(output).includes(secret), false);
    });
  }
}

test('backend write and delete failures still propagate without notification', async () => {
  const backend = createMemoryBackend();
  const failure = new Error('backend failed');
  backend.set = async () => { throw failure; };
  backend.delete = async () => { throw failure; };
  let notified = 0;
  const { value } = provider({ backend, notifyRecord: () => { notified += 1; }, notifyReference: () => { notified += 1; } });
  await assert.rejects(() => value.set('EXAMPLE_REF', 'synthetic'), (error) => error === failure);
  await assert.rejects(() => value.unset('EXAMPLE_REF'), (error) => error === failure);
  await assert.rejects(() => value.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: {} })), (error) => error === failure);
  await assert.rejects(() => value.deleteRecord('heluo-iam/session'), (error) => error === failure);
  assert.equal(notified, 0);
});

test('a backend transaction failure propagates without notification', async () => {
  const backend = createMemoryBackend();
  const failure = new Error('transaction failed');
  backend.transaction = async () => { throw failure; };
  let notified = false;
  const { value } = provider({ backend, notifyRecord: () => { notified = true; } });
  await assert.rejects(() => value.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: {} })), (error) => error === failure);
  assert.equal(notified, false);
});

test('committed changes notify reference and record listeners', async () => {
  const calls = [];
  const { value } = provider({
    notifyReference: (ref) => calls.push(['ref', ref]),
    notifyRecord: (key) => calls.push(['record', key]),
  });
  await value.set('ENTERPRISE_ACCESS_TOKEN', 'token');
  await value.unset('ENTERPRISE_ACCESS_TOKEN');
  await value.modifyRecord('heluo-iam/session', async () => ({ kind: 'grant', payload: { version: 1 } }));
  await value.deleteRecord('heluo-iam/session');
  assert.deepEqual(calls, [
    ['ref', 'ENTERPRISE_ACCESS_TOKEN'],
    ['ref', 'ENTERPRISE_ACCESS_TOKEN'],
    ['record', 'heluo-iam/session'],
    ['record', 'heluo-iam/session'],
  ]);
});
