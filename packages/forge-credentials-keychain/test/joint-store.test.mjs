import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';
import { createCredentialStore } from '../src/credential-store.mjs';
import { createJointStore, JOINT_STORE_SERVICE } from '../src/joint-store.mjs';
import { namespacePrefixes } from '../src/provider.mjs';

const SCOPE = Object.freeze({ recordKey: 'gateway/record', ref: 'GATEWAY_TOKEN' });

async function tempBackend(t) {
  const directory = await outsideRepositoryTmpAsync('forge-keychain-joint-');
  const backend = createCredentialStore({ directory });
  t.after(async () => { await backend.close(); await rm(directory, { recursive: true, force: true }); });
  return backend;
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
  assert.equal(await backend.get(`${prefixes.refPrefix}GATEWAY_TOKEN`), 'v');
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

test('guard exceptions, asynchronous and missing guards never commit', async (t) => {
  const backend = await tempBackend(t);
  const store = createJointStore(backend, namespacePrefixes({}));
  const expected = await store.snapshot(SCOPE);
  const next = { record: { kind: 'probe' }, value: 'synthetic' };
  const failure = new Error('synthetic refusal');
  for (const [guard, check] of [
    [() => { throw failure; }, (error) => error === failure],
    [async () => true, (error) => error.code === 'KEYCHAIN_GUARD_ASYNC'],
    [undefined, (error) => error.code === 'KEYCHAIN_GUARD_REQUIRED'],
  ]) {
    await assert.rejects(store.compareAndSwap(SCOPE, expected, next, guard), check);
    assert.deepEqual(await store.snapshot(SCOPE), expected);
  }
});

test('concurrent swaps through separate sqlite handles commit one winner', async (t) => {
  const directory = await outsideRepositoryTmpAsync('forge-keychain-joint-race-');
  const one = createCredentialStore({ directory });
  const two = createCredentialStore({ directory });
  t.after(async () => { await one.close(); await two.close(); await rm(directory, { recursive: true, force: true }); });
  const first = createJointStore(one, namespacePrefixes({}));
  const second = createJointStore(two, namespacePrefixes({}));
  const initial = await first.snapshot(SCOPE);
  const results = await Promise.all([
    first.compareAndSwap(SCOPE, initial, { record: { kind: 'probe' }, value: 'a' }, () => true),
    second.compareAndSwap(SCOPE, initial, { record: { kind: 'probe' }, value: 'b' }, () => true),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.ok(['a', 'b'].includes((await first.snapshot(SCOPE)).value));
});
