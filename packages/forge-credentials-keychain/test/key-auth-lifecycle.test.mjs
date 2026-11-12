import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

test('an unreferenced historical key remains bound and must be restored before writes can resume', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-key-auth-lifecycle-');
  const directory = join(root, 'data');
  let store = createCredentialStore({ directory });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const ref = 'heluo-forge/iam/ref/SYNTHETIC';
  await store.set(ref, 'old-value');
  await store.rotate('k2');
  await store.set(ref, 'new-value');
  await store.close();

  const db = new DatabaseSync(join(directory, 'credentials.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT DISTINCT kid FROM secret').all().map((row) => row.kid), ['k2']);
    const binding = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'key_auth'").get().value);
    assert.deepEqual(Object.keys(binding.keys).sort(), ['k1', 'k2']);
  } finally { db.close(); }

  const keyPath = join(`${directory}.keys`, 'keyring.json');
  const original = readFileSync(keyPath);
  const withoutOldKey = JSON.parse(original);
  delete withoutOldKey.keys.k1;
  writeFileSync(keyPath, JSON.stringify(withoutOldKey));
  store = createCredentialStore({ directory });
  assert.equal(await store.get(ref), 'new-value');
  await assert.rejects(store.set(ref, 'refused'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.equal(await store.get(ref), 'new-value');

  // Recovery uses the exact synthetic backup, not a replacement key.
  writeFileSync(keyPath, original);
  await store.set(ref, 'recovered');
  assert.equal(await store.get(ref), 'recovered');
});

test('a mismatched unreferenced historical key still prevents writes', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-key-auth-mismatch-');
  const directory = join(root, 'data');
  let store = createCredentialStore({ directory });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const ref = 'heluo-forge/iam/ref/SYNTHETIC';
  await store.set(ref, 'old-value');
  await store.rotate('k2');
  await store.set(ref, 'new-value');
  await store.close();

  const keyPath = join(`${directory}.keys`, 'keyring.json');
  const document = JSON.parse(readFileSync(keyPath));
  document.keys.k1 = Buffer.alloc(32, 0x5a).toString('base64');
  writeFileSync(keyPath, JSON.stringify(document));
  store = createCredentialStore({ directory });
  await assert.rejects(store.set(ref, 'refused'), { code: 'CRED_DECRYPT_FAILED' });
  assert.equal(await store.get(ref), 'new-value');
});
