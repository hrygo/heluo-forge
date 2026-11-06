import assert from 'node:assert/strict';
import test from 'node:test';
import { KeychainBackendError } from '../packages/forge-credentials-keychain/src/backend.mjs';
import { runStoreProbe } from '../scripts/probe/native-keyring-store-probe.mjs';

/** A backend over one shared Map, mirroring the contract the probe assumes. */
function memoryBackend(store = new Map(), overrides = {}) {
  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async listEntries(prefix) {
      return [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
    ...overrides,
  };
}

const KEY = 'heluo-forge/probe/test';

test('a healthy backend produces a full passing report', async () => {
  const store = new Map();
  const report = await runStoreProbe({
    backend: memoryBackend(store),
    service: 'heluo-forge',
    key: KEY,
    enumeration: true,
    readFromChild: ({ key }) => ({ ok: true, found: store.has(key), value: store.get(key) }),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((step) => step.name), [
    'read-absent', 'write-read', 'overwrite-read', 'cross-process-read', 'enumerate', 'delete', 'delete-idempotent',
  ]);
  assert.deepEqual(report.steps.find((step) => step.name === 'enumerate').detail, { matched: 1, includesProbeKey: true });
  assert.equal(store.has(KEY), false, 'the probe must leave the store as it found it');
});

test('a second process reading a different value fails the run and names the step', async () => {
  const store = new Map();
  const report = await runStoreProbe({
    backend: memoryBackend(store),
    service: 'heluo-forge',
    key: KEY,
    readFromChild: () => ({ ok: true, found: true, value: 'something-else' }),
  });
  assert.equal(report.ok, false);
  const failed = report.steps.filter((step) => step.ok === false);
  assert.deepEqual(failed.map((step) => step.name), ['cross-process-read']);
  assert.match(failed[0].error.message, /different value/u);
});

test('a credential that already exists is reported before anything is written', async () => {
  const store = new Map([[KEY, 'pre-existing']]);
  const report = await runStoreProbe({ backend: memoryBackend(store), service: 'heluo-forge', key: KEY, readFromChild: () => ({ ok: true }) });
  assert.equal(report.steps[0].name, 'read-absent');
  assert.equal(report.steps[0].ok, false);
});

test('backend error codes survive into the report', async () => {
  const report = await runStoreProbe({
    backend: memoryBackend(new Map(), {
      async set() {
        throw new KeychainBackendError('KEYCHAIN_OPERATION_FAILED', 'native keyring write failed: store is locked');
      },
    }),
    service: 'heluo-forge',
    key: KEY,
    readFromChild: () => ({ ok: true }),
  });
  const write = report.steps.find((step) => step.name === 'write-read');
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'KEYCHAIN_OPERATION_FAILED');
  assert.match(write.error.message, /locked/u);
});

test('enumeration must include the probed key when it is requested', async () => {
  const report = await runStoreProbe({
    backend: memoryBackend(new Map(), { async listEntries() { return []; } }),
    service: 'heluo-forge',
    key: KEY,
    enumeration: true,
    readFromChild: () => ({ ok: true }),
  });
  const enumerate = report.steps.find((step) => step.name === 'enumerate');
  assert.equal(enumerate.ok, false);
  assert.match(enumerate.error.message, /did not include/u);
});

test('a child that cannot see the entry fails instead of silently passing', async () => {
  const store = new Map();
  const report = await runStoreProbe({
    backend: memoryBackend(store),
    service: 'heluo-forge',
    key: KEY,
    readFromChild: () => ({ ok: true, found: false }),
  });
  const step = report.steps.find((item) => item.name === 'cross-process-read');
  assert.equal(step.ok, false);
  assert.match(step.error.message, /could not see the entry/u);
});

test('keep mode leaves the entry for a reboot check and skips deletion', async () => {
  const store = new Map();
  const report = await runStoreProbe({
    backend: memoryBackend(store),
    service: 'heluo-forge',
    key: KEY,
    keep: true,
    readFromChild: ({ key }) => ({ ok: true, found: store.has(key), value: store.get(key) }),
  });
  assert.equal(report.keep, true);
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((step) => step.name), ['read-absent', 'write-read', 'overwrite-read', 'cross-process-read']);
  assert.equal(store.has(KEY), true, 'keep mode must not delete the entry');
});
