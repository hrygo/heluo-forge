import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';
import { createFileBackend, createWindowsBackend, KeychainBackendError } from '../src/backend.mjs';

const SCOPE = Object.freeze({ recordKey: 'heluo-forge/iam/gateway/record', ref: 'heluo-forge/iam/gateway/ref' });
const RECORD = Object.freeze({ kind: 'heluo.gateway.credential', payload: 'placeholder' });

async function tempStore(t, options = {}) {
  const directory = await outsideRepositoryTmpAsync('forge-keychain-atomic-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  const backend = createFileBackend({
    path,
    ...(options.encrypted ? { keyPath: join(directory, 'credentials.key') } : {}),
  });
  return { backend, directory, path };
}

test('an empty document reports an absent pair instead of throwing', async (t) => {
  const { backend } = await tempStore(t);
  assert.deepEqual(await backend.snapshot(SCOPE), { record: undefined, value: undefined });
});

test('a verified swap writes record and ref together and returns the committed pair', async (t) => {
  const { backend, path } = await tempStore(t);
  const expected = await backend.snapshot(SCOPE);
  const next = { record: RECORD, value: 'placeholder-value' };
  const receipt = await backend.compareAndSwap(SCOPE, expected, next, () => true);

  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.snapshot, next);
  assert.deepEqual(await backend.snapshot(SCOPE), next);
  // One document, so both entries commit in the same fsync+rename.
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(document.entries).sort(), [SCOPE.ref, SCOPE.recordKey].sort());
});

test('the same guarantee holds for the encrypted document', async (t) => {
  const { backend, path } = await tempStore(t, { encrypted: true });
  const expected = await backend.snapshot(SCOPE);
  const next = { record: RECORD, value: 'placeholder-value' };
  assert.equal((await backend.compareAndSwap(SCOPE, expected, next, () => true)).ok, true);
  assert.doesNotMatch(await readFile(path, 'utf8'), /placeholder-value/, 'the encrypted document must not store the value in the clear');
});

test('a stale snapshot reports a conflict and writes nothing', async (t) => {
  const { backend } = await tempStore(t);
  const stale = await backend.snapshot(SCOPE);
  await backend.compareAndSwap(SCOPE, stale, { record: RECORD, value: 'first' }, () => true);

  const receipt = await backend.compareAndSwap(SCOPE, stale, { record: RECORD, value: 'second' }, () => true);
  assert.deepEqual(receipt, { ok: false });
  assert.deepEqual(await backend.snapshot(SCOPE), { record: RECORD, value: 'first' });
});

test('a refusing guard throws and leaves the document untouched', async (t) => {
  const { backend } = await tempStore(t);
  const expected = await backend.snapshot(SCOPE);
  let calls = 0;

  await assert.rejects(
    backend.compareAndSwap(SCOPE, expected, { record: RECORD, value: 'never' }, () => { calls += 1; return false; }),
    (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_GUARD_REFUSED',
  );
  assert.equal(calls, 1, 'the guard decides exactly once');
  assert.deepEqual(await backend.snapshot(SCOPE), { record: undefined, value: undefined });
});

test('a guard that throws propagates its own error and writes nothing', async (t) => {
  const { backend } = await tempStore(t);
  const expected = await backend.snapshot(SCOPE);
  const refusal = new Error('changed under the lock');

  await assert.rejects(
    backend.compareAndSwap(SCOPE, expected, { record: RECORD, value: 'never' }, () => { throw refusal; }),
    (error) => error === refusal,
  );
  assert.deepEqual(await backend.snapshot(SCOPE), { record: undefined, value: undefined });
});

test('an asynchronous guard is refused instead of silently committing', async (t) => {
  const { backend } = await tempStore(t);
  const expected = await backend.snapshot(SCOPE);

  await assert.rejects(
    backend.compareAndSwap(SCOPE, expected, { record: RECORD, value: 'never' }, async () => true),
    (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_GUARD_ASYNC',
  );
  assert.deepEqual(await backend.snapshot(SCOPE), { record: undefined, value: undefined });
});

test('a missing guard is refused before any write', async (t) => {
  const { backend } = await tempStore(t);
  const expected = await backend.snapshot(SCOPE);

  await assert.rejects(
    backend.compareAndSwap(SCOPE, expected, { record: RECORD, value: 'never' }, undefined),
    (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_GUARD_REQUIRED',
  );
});

test('scope keys must be two distinct names', async (t) => {
  const { backend } = await tempStore(t);
  for (const scope of [
    { recordKey: SCOPE.recordKey },
    { recordKey: '', ref: SCOPE.ref },
    { recordKey: SCOPE.ref, ref: SCOPE.ref },
  ]) {
    await assert.rejects(
      backend.snapshot(scope),
      (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_SCOPE_INVALID',
      JSON.stringify(scope),
    );
  }
});

test('a record that is not JSON fails closed instead of being compared as text', async (t) => {
  const { backend, path } = await tempStore(t);
  await writeFile(path, JSON.stringify({ version: 1, entries: { [SCOPE.recordKey]: 'not-json' } }), 'utf8');

  await assert.rejects(
    backend.snapshot(SCOPE),
    (error) => error instanceof KeychainBackendError && error.code === 'KEYCHAIN_FILE_CORRUPT',
  );
});

test('the Windows platform backend is an encrypted document under the profile', () => {
  const backend = createWindowsBackend({ directory: '/tmp/heluo-forge-probe' });
  assert.equal(backend.kind, 'file-encrypted');
  assert.equal(backend.encrypted, true);
  // The IAM gate treats a backend with a transaction as cross-process locked.
  assert.equal(typeof backend.transaction, 'function');
  assert.equal(typeof backend.snapshot, 'function');
  assert.equal(typeof backend.compareAndSwap, 'function');
});

test('concurrent swaps from two handles commit exactly one winner', async (t) => {
  const { backend, path } = await tempStore(t);
  const second = createFileBackend({ path });
  const expected = await backend.snapshot(SCOPE);

  const receipts = await Promise.all([
    backend.compareAndSwap(SCOPE, expected, { record: RECORD, value: 'a' }, () => true),
    second.compareAndSwap(SCOPE, expected, { record: RECORD, value: 'b' }, () => true),
  ]);

  assert.equal(receipts.filter((receipt) => receipt.ok).length, 1);
  const committed = await backend.snapshot(SCOPE);
  assert.ok(committed.value === 'a' || committed.value === 'b');
  assert.deepEqual(Object.keys((await backend.snapshot(SCOPE))).sort(), ['record', 'value']);
});
