import assert from 'node:assert/strict';
import { cp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';
import { outsideRepositoryTmp } from './support/tmp.mjs';

test('separate stopped data and key backups restore rotated records; incomplete copies fail closed', async (t) => {
  const root = outsideRepositoryTmp('forge-key-lifecycle-');
  const stores = [];
  t.after(async () => {
    const errors = [];
    while (stores.length) {
      try { await stores.pop().close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'failed to close test stores');
    await rm(root, { recursive: true, force: true });
  });

  const source = join(root, 'source');
  const backup = join(root, 'backup');
  const restoredDirectory = join(root, 'restored');
  const dataOnly = join(root, 'data-only');
  const keysOnly = join(root, 'keys-only');
  const oldRef = 'heluo-forge/iam/ref/OLD';
  const newRef = 'heluo-forge/iam/ref/NEW';
  const writer = createCredentialStore({ directory: source });
  stores.push(writer);
  await writer.set(oldRef, 'synthetic-old');
  await writer.rotate('k2');
  await writer.set(newRef, 'synthetic-new');
  await writer.close();

  // The store is stopped before separately copying data and all retained keys.
  await assert.rejects(stat(join(source, 'keyring.json')), { code: 'ENOENT' });
  await stat(join(`${source}.keys`, 'keyring.json'));
  await cp(source, backup, { recursive: true, errorOnExist: true, force: false });
  await cp(`${source}.keys`, `${backup}.keys`, { recursive: true, errorOnExist: true, force: false });
  await assert.rejects(stat(join(backup, 'keyring.json')), { code: 'ENOENT' });
  await cp(backup, restoredDirectory, { recursive: true, errorOnExist: true, force: false });
  await cp(`${backup}.keys`, `${restoredDirectory}.keys`, { recursive: true, errorOnExist: true, force: false });
  const restored = createCredentialStore({ directory: restoredDirectory, readOnly: true });
  stores.push(restored);
  assert.equal(await restored.get(oldRef), 'synthetic-old');
  assert.equal(await restored.get(newRef), 'synthetic-new');
  await restored.close();

  await cp(backup, dataOnly, { recursive: true, errorOnExist: true, force: false });
  const database = join(dataOnly, 'credentials.sqlite');
  const before = await readFile(database);
  const withoutKeys = createCredentialStore({ directory: dataOnly });
  stores.push(withoutKeys);
  await assert.rejects(withoutKeys.get(oldRef), { code: 'CRED_KEY_UNAVAILABLE' });
  await assert.rejects(withoutKeys.set(newRef, 'synthetic-replacement'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.deepEqual(await readFile(database), before);
  await assert.rejects(stat(`${dataOnly}.keys`), { code: 'ENOENT' });

  await cp(`${backup}.keys`, `${keysOnly}.keys`, { recursive: true, errorOnExist: true, force: false });
  const keyring = join(`${keysOnly}.keys`, 'keyring.json');
  const keyringBefore = await readFile(keyring);
  const withoutData = createCredentialStore({ directory: keysOnly });
  stores.push(withoutData);
  await assert.rejects(withoutData.get(oldRef), { code: 'CRED_STORE_UNAVAILABLE' });
  await assert.rejects(withoutData.set(newRef, 'synthetic-replacement'), { code: 'CRED_STORE_UNAVAILABLE' });
  assert.deepEqual(await readFile(keyring), keyringBefore);
  await assert.rejects(stat(join(keysOnly, 'credentials.sqlite')), { code: 'ENOENT' });
});
