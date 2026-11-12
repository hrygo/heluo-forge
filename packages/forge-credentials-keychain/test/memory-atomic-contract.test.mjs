import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBackend } from '../src/backend.mjs';

const scope = { recordKey: 'namespace/record', ref: 'namespace/ref' };

test('memory backend supports the same atomic record/ref snapshot and guarded compare as sqlite', async () => {
  const backend = createMemoryBackend();
  const expected = await backend.snapshot(scope);
  assert.deepEqual(expected, { record: undefined, value: undefined });
  const next = { record: { kind: 'grant', payload: { subject: 'E1001' } }, value: 'synthetic' };
  assert.deepEqual(await backend.compareAndSwap(scope, expected, next, () => true), { ok: true, snapshot: next });
  let calls = 0;
  assert.deepEqual(await backend.compareAndSwap(scope, expected, next, () => { calls += 1; return true; }), { ok: false });
  assert.equal(calls, 0);
  assert.deepEqual(await backend.snapshot(scope), next);
  await assert.rejects(backend.compareAndSwap(scope, next, expected, () => false),
    (error) => error.code === 'KEYCHAIN_GUARD_REFUSED');
  assert.deepEqual(await backend.snapshot(scope), next);
});

test('an async transaction serializes another writer without exposing its uncommitted value', async () => {
  const backend = createMemoryBackend({ key: 'before' });
  let release;
  let entered;
  const pending = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = backend.transaction('key', async (tx) => { tx.set('middle'); entered(); await gate; });
  await pending;
  assert.equal(await backend.get('key'), 'before');
  const second = backend.set('key', 'after');
  release();
  await Promise.all([first, second]);
  assert.equal(await backend.get('key'), 'after');
});
