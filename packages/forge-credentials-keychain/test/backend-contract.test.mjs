import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createFileBackend, createMemoryBackend } from '../src/backend.mjs';
import { createNativeKeyringBackend } from '../src/index.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

const KEY = 'heluo-forge/iam/ref/ENTERPRISE_ACCESS_TOKEN';
const OTHER = 'heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY';

/**
 * The behaviors every backend must share. Enumeration is opt-in per backend:
 * the native adapter refuses it until a platform's filter semantics are
 * verified, so the listing case only runs where `listing: true` is declared.
 */
async function runContract(name, { create, listing }) {
  test(`${name}: set → get round-trips the value unchanged`, async (t) => {
    const backend = await create(t);
    await backend.set(KEY, 'synthetic-value');
    assert.equal(await backend.get(KEY), 'synthetic-value');
  });

  test(`${name}: an absent key reads as undefined, never as an error or empty string`, async (t) => {
    const backend = await create(t);
    assert.equal(await backend.get('heluo-forge/iam/ref/ABSENT'), undefined);
  });

  test(`${name}: a second write replaces the value`, async (t) => {
    const backend = await create(t);
    await backend.set(KEY, 'first');
    await backend.set(KEY, 'second');
    assert.equal(await backend.get(KEY), 'second');
  });

  test(`${name}: delete removes the entry and is idempotent`, async (t) => {
    const backend = await create(t);
    await backend.set(KEY, 'synthetic-value');
    await backend.delete(KEY);
    assert.equal(await backend.get(KEY), undefined);
    await backend.delete(KEY);
  });

  if (listing) {
    test(`${name}: list returns only keys under the prefix`, async (t) => {
      const backend = await create(t);
      await backend.set(KEY, 'one');
      await backend.set(OTHER, 'two');
      assert.deepEqual((await backend.list('heluo-forge/iam/')).sort(), [KEY, OTHER].sort());
      assert.deepEqual(await backend.list('heluo-forge/iam/ref/ENTERPRISE_ACCESS'), [KEY]);
    });
  } else {
    test(`${name}: list refuses instead of reporting an empty store`, async (t) => {
      const backend = await create(t);
      await backend.set(KEY, 'one');
      await assert.rejects(() => backend.list('heluo-forge/iam/'), (error) => error.code === 'KEYCHAIN_LIST_UNSUPPORTED');
    });
  }
}

await runContract('memory backend', {
  create: async () => createMemoryBackend(),
  listing: true,
});

await runContract('file backend', {
  create: async (t) => {
    const directory = await outsideRepositoryTmpAsync('forge-keychain-contract-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    return createFileBackend({ path: join(directory, 'credentials.json') });
  },
  listing: true,
});

// The native backend is exercised through an injected store so the contract runs
// on any host: the platform addons only load on their own OS.
const nativeStore = new Map();
class FakeEntry {
  constructor(service, key) {
    this.id = `${service}\u0000${key}`;
    this.account = key;
  }
  async getPassword() {
    return nativeStore.get(this.id)?.password ?? null;
  }
  async setPassword(value) {
    nativeStore.set(this.id, { account: this.account, password: value });
  }
  async deletePassword() {
    return nativeStore.delete(this.id);
  }
}
const fakeModule = {
  Entry: FakeEntry,
  AsyncEntry: FakeEntry,
  findCredentialsAsync: async (service, filter) =>
    [...nativeStore.entries()]
      .filter(([id, credential]) => filter === undefined
        ? id.startsWith(`${service}\u0000`)
        : credential.account.toLowerCase().startsWith(filter.slice(0, -1).toLowerCase()))
      .map(([, credential]) => credential),
};

await runContract('native backend', {
  create: async () =>
    createNativeKeyringBackend({
      service: 'heluo-forge',
      platform: 'win32',
      load: () => fakeModule,
      enumeration: 'find-credentials',
    }),
  listing: true,
});
