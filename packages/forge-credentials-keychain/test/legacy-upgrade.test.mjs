import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';
import { createKeychainProvider } from '../src/provider.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

const ref = 'heluo-forge/iam/ref/EXISTING';
const session = { kind: 'grant', payload: { subject: 'synthetic-user', version: 2 } };
const connection = { kind: 'api-key', key: 'synthetic-connection' };

test('old encrypted-document files do not block creation of a separate SQLite store', async (t) => {
  for (const names of [['credentials.json'], ['credentials.key'], ['credentials.json', 'credentials.key']]) {
    await t.test(names.join(' + '), async (t) => {
      const root = await outsideRepositoryTmpAsync('forge-upgrade-old-');
      t.after(() => rm(root, { recursive: true, force: true }));
      const directory = join(root, 'data');
      mkdirSync(directory, { mode: 0o700 });
      for (const name of names) writeFileSync(join(directory, name), `synthetic-${name}`);

      const backend = createCredentialStore({ directory });
      const provider = createKeychainProvider(backend);
      try {
        assert.equal(await backend.get(ref), undefined);
        assert.equal(existsSync(join(directory, 'credentials.sqlite')), false);
        assert.deepEqual(await provider.modifyRecord('connection/default', () => connection), connection);
        await backend.set(ref, 'synthetic-new');
      } finally { await provider.close(); }

      for (const name of names) assert.equal(readFileSync(join(directory, name), 'utf8'), `synthetic-${name}`);
      const reader = createCredentialStore({ directory, readOnly: true });
      const reopened = createKeychainProvider(reader);
      try {
        assert.equal(await reader.get(ref), 'synthetic-new');
        assert.deepEqual(await reopened.readRecord('connection/default'), connection);
      } finally { await reopened.close(); }
      assert.equal(existsSync(join(`${directory}.keys`, 'keyring.json')), true);
    });
  }
});

test('existing SQLite credentials and key remain usable when old files are present', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-upgrade-existing-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'data');
  const original = createCredentialStore({ directory });
  const originalProvider = createKeychainProvider(original);
  await original.set(ref, 'synthetic-existing');
  await originalProvider.modifyRecord('heluo-iam/session', () => session);
  await originalProvider.close();
  const keyPath = join(`${directory}.keys`, 'keyring.json');
  const originalKey = readFileSync(keyPath);
  for (const name of ['credentials.json', 'credentials.key']) writeFileSync(join(directory, name), `synthetic-${name}`);

  const backend = createCredentialStore({ directory });
  const provider = createKeychainProvider(backend);
  try {
    assert.equal(await backend.get(ref), 'synthetic-existing');
    assert.deepEqual(await provider.readRecord('heluo-iam/session'), session);
    assert.deepEqual(await provider.modifyRecord('connection/default', () => connection), connection);
  } finally { await provider.close(); }
  assert.deepEqual(readFileSync(keyPath), originalKey);
  for (const name of ['credentials.json', 'credentials.key']) {
    assert.equal(readFileSync(join(directory, name), 'utf8'), `synthetic-${name}`);
  }
  const reader = createCredentialStore({ directory, readOnly: true });
  const reopened = createKeychainProvider(reader);
  try {
    assert.equal(await reader.get(ref), 'synthetic-existing');
    assert.deepEqual(await reopened.readRecord('heluo-iam/session'), session);
    assert.deepEqual(await reopened.readRecord('connection/default'), connection);
  } finally { await reopened.close(); }
});


test('legacy documents never cause an existing SQLite store to be reinitialized when its key is missing', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-upgrade-missing-key-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'data');
  const original = createCredentialStore({ directory });
  await original.set(ref, 'synthetic-existing');
  await original.close();
  const database = join(directory, 'credentials.sqlite');
  const before = readFileSync(database);
  const savedKeys = join(root, 'saved-keys');
  renameSync(`${directory}.keys`, savedKeys);
  writeFileSync(join(directory, 'credentials.json'), 'synthetic-old-document');
  writeFileSync(join(directory, 'credentials.key'), 'synthetic-old-key');

  const store = createCredentialStore({ directory });
  try {
    await assert.rejects(store.get(ref), { code: 'CRED_KEY_UNAVAILABLE' });
    await assert.rejects(store.set(ref, 'replacement'), { code: 'CRED_KEY_UNAVAILABLE' });
  } finally { await store.close(); }
  assert.deepEqual(readFileSync(database), before);
  assert.equal(existsSync(`${directory}.keys`), false);
  assert.equal(existsSync(join(savedKeys, 'keyring.json')), true);
  assert.equal(readFileSync(join(directory, 'credentials.json'), 'utf8'), 'synthetic-old-document');
  assert.equal(readFileSync(join(directory, 'credentials.key'), 'utf8'), 'synthetic-old-key');
});
