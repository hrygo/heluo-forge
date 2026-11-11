import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';
import { createFileBackend } from '../src/backend.mjs';
import { createJointStore, JOINT_STORE_SERVICE } from '../src/joint-store.mjs';
import { namespacePrefixes } from '../src/provider.mjs';

const SCOPE = Object.freeze({ recordKey: 'gateway/record', ref: 'gateway/ref' });

async function tempBackend(t) {
  const directory = await outsideRepositoryTmpAsync('forge-keychain-joint-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createFileBackend({ path: join(directory, 'credentials.json').replace(/\.json$/, '.json'), keyPath: join(directory, 'credentials.key') });
}

test('a backend without a joint commit gets no adapter at all', () => {
  assert.equal(createJointStore({ get: async () => undefined, set: async () => {} }, namespacePrefixes({})), undefined);
  assert.equal(createJointStore(undefined, namespacePrefixes({})), undefined);
});

test('scope keys map into the same namespace the provider reads', async (t) => {
  const backend = await tempBackend(t);
  const prefixes = namespacePrefixes({ service: 'heluo-forge', accountPrefix: 'iam' });
  const store = createJointStore(backend, prefixes);
  assert.equal(typeof store?.compareAndSwap, 'function');

  const expected = await store.snapshot(SCOPE);
  assert.deepEqual(expected, { record: undefined, value: undefined });
  const receipt = await store.compareAndSwap(SCOPE, expected, { record: { kind: 'probe' }, value: 'v' }, () => true);

  assert.equal(receipt.ok, true);
  // The provider must see exactly what the joint store wrote, under its own keys.
  assert.equal(await backend.get(`${prefixes.recordPrefix}gateway/record`), JSON.stringify({ kind: 'probe' }));
  assert.equal(await backend.get(`${prefixes.refPrefix}gateway/ref`), 'v');
});

test('an invalid scope is refused before it can address the wrong key', async (t) => {
  const store = createJointStore(await tempBackend(t), namespacePrefixes({}));
  for (const scope of [{}, { recordKey: 'r' }, { recordKey: '', ref: 'v' }, { recordKey: 'r', ref: '' }]) {
    await assert.rejects(store.snapshot(scope), (error) => error.code === 'KEYCHAIN_SCOPE_INVALID', JSON.stringify(scope));
  }
});

test('the joint store service name is the contract the host composes on', () => {
  assert.equal(JOINT_STORE_SERVICE, 'iam-atomic-store');
});
