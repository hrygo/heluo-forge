import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createGatewayCredentialStore, GATEWAY_RECORD_KEY, GATEWAY_REF } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const originalValue = `uag-${'a'.repeat(32)}`;
const input = { value: `uag-${'b'.repeat(32)}`, ownerSubject: 'synthetic-user', issuer: 'https://iam.corp.example', baseURL: 'https://gateway.corp.example/v1', enteredAt: '2026-11-02T00:00:00.000Z' };

function fixture({ seeded = true } = {}) {
  const credentials = new MemoryCredentials();
  if (seeded) {
    credentials.records.set(GATEWAY_RECORD_KEY, { kind: 'grant', payload: { version: 1,
      ownerSubject: 'synthetic-user', enteredAt: input.enteredAt, deviceLabel: 'synthetic-device' } });
    credentials.refs.set(GATEWAY_REF, originalValue);
  }
  const before = structuredClone({ records: credentials.records, refs: credentials.refs });
  const mutations = [];
  for (const name of ['modifyRecord', 'set', 'unset', 'deleteRecord']) {
    const original = credentials[name].bind(credentials);
    credentials[name] = (...args) => { mutations.push(name); return original(...args); };
  }
  return { credentials, mutations, unchanged() {
    return isDeepStrictEqual(before, { records: credentials.records, refs: credentials.refs });
  } };
}

const cases = [
  ['default', () => ({})],
  ['single-record verifier alone', () => ({ verifyAtomicStore: () => true })],
  ['provider flags alone', (credentials) => { credentials.crossProcessLock = true; credentials.durable = true; return {}; }],
  ['joint adapter shape without verifier', (_credentials, adapter) => ({ getGatewayAtomicStore: () => adapter })],
  ['false verifier', (_credentials, adapter) => ({ getGatewayAtomicStore: () => adapter, verifyGatewayAtomicStore: () => false })],
  ['truthy descriptor verifier', (_credentials, adapter) => ({ getGatewayAtomicStore: () => adapter, verifyGatewayAtomicStore: () => ({ atomic: true }) })],
  ['throwing verifier', (_credentials, adapter) => ({ getGatewayAtomicStore: () => adapter, verifyGatewayAtomicStore: () => { throw new Error('synthetic private verifier detail'); } })],
  ['async true verifier', (_credentials, adapter) => ({ getGatewayAtomicStore: () => adapter, verifyGatewayAtomicStore: async () => true })],
  ['rejected verifier', (_credentials, adapter) => ({ getGatewayAtomicStore: () => adapter, verifyGatewayAtomicStore: () => Promise.reject(new Error('synthetic private verifier detail')) })],
  ['throwing adapter resolver', () => ({ getGatewayAtomicStore: () => { throw new Error('synthetic private resolver detail'); }, verifyGatewayAtomicStore: () => true })],
  ['missing joint methods', () => ({ getGatewayAtomicStore: () => ({}), verifyGatewayAtomicStore: () => true })],
];

for (const [name, optionsFor] of cases) {
  for (const operation of ['save', 'clear']) {
    test(`${operation} rejects ${name} without invoking any mutation or joint I/O`, async () => {
      const f = fixture(); let jointCalls = 0;
      const adapter = { snapshot() { jointCalls++; throw new Error('must not be reached'); },
        compareAndSwap() { jointCalls++; throw new Error('must not be reached'); } };
      const store = createGatewayCredentialStore(f.credentials, optionsFor(f.credentials, adapter));
      await assert.rejects(() => operation === 'save' ? store.save(input) : store.clear(), (error) => {
        assert.equal(error.code, 'IAM_GATEWAY_ATOMIC_UNVERIFIED');
        assert.doesNotMatch(error.message, /synthetic private/);
        return true;
      });
      await new Promise(setImmediate);
      assert.equal(jointCalls, 0);
      assert.deepEqual(f.mutations, []);
      assert.equal(f.unchanged(), true);
    });
  }
}

for (const operation of ['save', 'clear']) {
  test(`${operation} cannot create records on an unverified empty provider`, async () => {
    const f = fixture({ seeded: false });
    const store = createGatewayCredentialStore(f.credentials);
    await assert.rejects(() => operation === 'save' ? store.save(input) : store.clear(), { code: 'IAM_GATEWAY_ATOMIC_UNVERIFIED' });
    assert.deepEqual(f.mutations, []);
    assert.equal(f.unchanged(), true);
  });
}

test('legacy gateway metadata and values cannot be read or replaced', async () => {
  const f = fixture();
  const store = createGatewayCredentialStore(f.credentials);
  const result = await store.read();
  assert.equal(result.ok, false);
  const legacy = (await f.credentials.readRecord(GATEWAY_RECORD_KEY)).payload;
  const forged = { ...legacy, version: 2, writeOperationId: '123e4567-e89b-42d3-a456-426614174000',
    valueDigest: createHash('sha256').update(originalValue).digest('hex') };
  for (const supplied of [undefined, null, {}, legacy, forged]) {
    assert.equal((await store.resolve(supplied))?.value, undefined);
  }
  assert.deepEqual(f.mutations, []);
  assert.equal(f.unchanged(), true);
});
