import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createMemoryBackend } from '../src/backend.mjs';
import { createCredentialStore } from '../src/credential-store.mjs';
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

  test(`${name}: invalid Unicode cannot silently change a stored credential`, async (t) => {
    const backend = await create(t);
    await backend.set(KEY, '有效 🔐');
    assert.equal(await backend.get(KEY), '有效 🔐');
    const invalid = 'a\ud800b';
    await assert.rejects(backend.set(KEY, invalid), (error) => error.code === 'CRED_STORE_INVALID');
    await assert.rejects(backend.transaction(KEY, (tx) => tx.set(invalid)), (error) => error.code === 'CRED_STORE_INVALID');
    assert.equal(await backend.get(KEY), '有效 🔐');
  });

  test(`${name}: empty or non-string credential values are rejected`, async (t) => {
    const backend = await create(t);
    await backend.set(KEY, 'original');
    for (const invalid of ['', null, 123]) {
      await assert.rejects(backend.set(KEY, invalid), (error) => error.code === 'CRED_STORE_INVALID');
      await assert.rejects(backend.transaction(KEY, (tx) => tx.set(invalid)), (error) => error.code === 'CRED_STORE_INVALID');
      assert.equal(await backend.get(KEY), 'original');
    }
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

  test(`${name}: concurrent writes preserve distinct case-sensitive keys`, async (t) => {
    const backend = await create(t);
    const upper = 'heluo-forge/iam/ref/EXAMPLE';
    const lower = 'heluo-forge/iam/ref/example';
    await Promise.all([backend.set(upper, 'upper'), backend.set(lower, 'lower')]);
    assert.equal(await backend.get(upper), 'upper');
    assert.equal(await backend.get(lower), 'lower');
    await backend.delete(upper);
    assert.equal(await backend.get(lower), 'lower');
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

await runContract('sqlite backend', {
  create: async (t) => {
    const root = await outsideRepositoryTmpAsync('forge-keychain-contract-');
    const directory = join(root, 'data');
    const backend = createCredentialStore({ directory });
    t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
    return backend;
  },
  listing: true,
});
