import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGatewayCredentialStore, GATEWAY_RECORD_KEY, GATEWAY_REF } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const value = 'synthetic-gateway-key';
const initial = {
  version: 2, ownerSubject: 'synthetic-user', enteredAt: '2026-01-01T00:00:00.000Z',
  baseURL: 'https://gateway.corp.example/v1',
  writeOperationId: '123e4567-e89b-42d3-a456-426614174000',
  valueDigest: createHash('sha256').update(value).digest('hex'),
};
const updated = { ...initial, baseURL: 'https://other.corp.example/v1',
  writeOperationId: '123e4567-e89b-42d3-a456-426614174001' };

function fixture(onResolve = () => {}) {
  const credentials = new MemoryCredentials();
  credentials.records.set(GATEWAY_RECORD_KEY, { kind: 'grant', payload: structuredClone(initial) });
  credentials.refs.set(GATEWAY_REF, value);
  const resolve = credentials.resolve.bind(credentials);
  credentials.resolve = async (ref) => { onResolve(credentials); return resolve(ref); };
  return { credentials, store: createGatewayCredentialStore(credentials) };
}

test('unchanged gateway metadata resolves the matching value', async () => {
  const { store } = fixture();
  assert.deepEqual(await store.resolve(structuredClone(initial)), { value, source: 'keychain' });
});

for (const [name, replacement] of [
  ['a newer generation with the same key', { kind: 'grant', payload: updated }],
  ['legacy metadata with the same key', { kind: 'grant', payload: { version: 1, ownerSubject: initial.ownerSubject, enteredAt: initial.enteredAt } }],
  ['removed metadata', undefined],
]) {
  test(`resolution rejects ${name} introduced during the key read`, async () => {
    const { store } = fixture((credentials) => {
      if (replacement === undefined) credentials.records.delete(GATEWAY_RECORD_KEY);
      else credentials.records.set(GATEWAY_RECORD_KEY, structuredClone(replacement));
    });
    assert.deepEqual(await store.resolve(structuredClone(initial)), { invalid: true });
  });
}

test('a caller cannot redefine the observed metadata while the key is being read', async () => {
  const supplied = structuredClone(initial);
  const { store } = fixture((credentials) => {
    Object.assign(supplied, updated);
    credentials.records.set(GATEWAY_RECORD_KEY, { kind: 'grant', payload: structuredClone(updated) });
  });
  assert.deepEqual(await store.resolve(supplied), { invalid: true });
});

test('a caller cannot alter its metadata while storage remains unchanged', async () => {
  const supplied = structuredClone(initial);
  const { store } = fixture(() => { Object.assign(supplied, updated); });
  assert.deepEqual(await store.resolve(supplied), { invalid: true });
});
