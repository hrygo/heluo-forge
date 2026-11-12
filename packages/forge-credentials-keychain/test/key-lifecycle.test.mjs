import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';
import { outsideRepositoryTmp } from './support/tmp.mjs';

test('a stopped store can be restored with both old and current keys; a database-only copy fails closed', async (t) => {
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
  const incomplete = join(root, 'incomplete');
  const oldRef = 'heluo-forge/iam/ref/OLD';
  const newRef = 'heluo-forge/iam/ref/NEW';
  const writer = createCredentialStore({ directory: source });
  stores.push(writer);
  await writer.set(oldRef, 'synthetic-old');
  await writer.rotate('k2');
  await writer.set(newRef, 'synthetic-new');
  await writer.close();

  // The source is stopped before copying: the backup includes the database
  // and every key required by records written before and after rotation.
  await cp(source, backup, { recursive: true, errorOnExist: true, force: false });
  const restored = createCredentialStore({ directory: backup, readOnly: true });
  stores.push(restored);
  assert.equal(await restored.get(oldRef), 'synthetic-old');
  assert.equal(await restored.get(newRef), 'synthetic-new');
  await restored.close();

  await mkdir(incomplete, { mode: 0o700 });
  const database = join(incomplete, 'credentials.sqlite');
  await copyFile(join(backup, 'credentials.sqlite'), database);
  const before = await readFile(database);
  const withoutKeys = createCredentialStore({ directory: incomplete });
  stores.push(withoutKeys);
  await assert.rejects(withoutKeys.get(oldRef), { code: 'CRED_KEY_UNAVAILABLE' });
  await assert.rejects(withoutKeys.set(newRef, 'synthetic-replacement'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.deepEqual(await readFile(database), before);
  await assert.rejects(stat(join(incomplete, 'keyring.json')), { code: 'ENOENT' });
});
