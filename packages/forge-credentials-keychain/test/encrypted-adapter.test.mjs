import assert from 'node:assert/strict';
import test from 'node:test';
import { createEncryptedAdapter } from '../src/encrypted-adapter.mjs';

test('encryption decorates injected storage, cipher and key ports', async () => {
  const rows = new Map();
  const calls = [];
  const backend = {
    open: () => true,
    withLock: (run) => run('synthetic-lock'),
    withRead: (run) => run(),
    commit: (token, run) => { assert.equal(token, 'synthetic-lock'); return run(); },
    transaction: (run) => run(),
    assertToken: (token) => assert.equal(token, 'synthetic-lock'),
    active: () => 'k1',
    get: (id) => rows.get(id),
    set: (row) => rows.set(row.id, row),
    delete: (id) => rows.delete(id),
    list: () => [...rows.values()],
    close: async () => calls.push('close'),
  };
  const cipher = {
    seal(input) { calls.push({ operation: 'seal', kind: input.kind, kid: input.kid }); return Buffer.from('opaque-envelope'); },
    open(input) { calls.push({ operation: 'open', kind: input.kind, kid: input.kid }); return Buffer.from('synthetic-secret'); },
  };
  const keys = { byId: () => Buffer.alloc(32), activate: () => {}, add: () => {} };
  const store = createEncryptedAdapter({ backend, cipher, keys });
  const id = 'heluo-forge/iam/ref/TEST';
  await store.set(id, 'synthetic-secret');
  assert.equal(rows.get(id).envelope.toString(), 'opaque-envelope');
  assert.equal(rows.get(id).envelope.includes(Buffer.from('synthetic-secret')), false);
  assert.equal(await store.get(id), 'synthetic-secret');
  await store.close();
  assert.deepEqual(calls, [
    { operation: 'seal', kind: 'ref', kid: 'k1' },
    { operation: 'open', kind: 'ref', kid: 'k1' },
    'close',
  ]);
});
