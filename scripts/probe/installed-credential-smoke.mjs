#!/usr/bin/env node
// Exercise the installed package using synthetic values and a temporary store.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('usage: installed-credential-smoke.mjs <package-directory>');
const { createCredentialStore } = await import(pathToFileURL(join(resolve(process.argv[2]), 'src/index.mjs')).href);
const root = await mkdtemp(join(tmpdir(), 'forge-installed-credential-'));
const directory = join(root, 'store');
const backup = join(root, 'backup');
const dataOnly = join(root, 'data-only');
const keysOnly = join(root, 'keys-only');
const oldRef = 'heluo-forge/iam/ref/OLD';
const newRef = 'heluo-forge/iam/ref/NEW';
let store;
try {
  store = createCredentialStore({ directory });
  await store.set(oldRef, 'synthetic-old');
  await store.rotate('k2');
  await store.set(newRef, 'synthetic-new');
  assert.equal(await store.get(oldRef), 'synthetic-old');
  assert.equal(await store.get(newRef), 'synthetic-new');
  await store.close();
  store = undefined;

  const databasePath = join(directory, 'credentials.sqlite');
  const keyringPath = join(`${directory}.keys`, 'keyring.json');
  assert.ok((await stat(databasePath)).isFile());
  assert.ok((await stat(keyringPath)).isFile());
  await assert.rejects(stat(join(directory, 'keyring.json')), { code: 'ENOENT' });
  const keyring = JSON.parse(await readFile(keyringPath, 'utf8'));
  assert.equal(keyring.active, 'k2', 'rotation did not activate the synthetic keyring');

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const keyFor = database.prepare('SELECT kid FROM secret WHERE id = ?');
    const oldKid = keyFor.get(oldRef)?.kid;
    const newKid = keyFor.get(newRef)?.kid;
    assert.ok(typeof oldKid === 'string' && oldKid !== newKid, 'rotation did not preserve a distinct old key');
    assert.equal(newKid, 'k2', 'rotation did not activate the synthetic database key');
    assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'active'").get()?.value, 'k2');
  } finally {
    database.close();
  }

  // Copy only after all writers and database handles have closed.
  await cp(directory, backup, { recursive: true, errorOnExist: true, force: false });
  await cp(`${directory}.keys`, `${backup}.keys`, { recursive: true, errorOnExist: true, force: false });
  store = createCredentialStore({ directory: backup, readOnly: true });
  assert.equal(await store.get(oldRef), 'synthetic-old');
  assert.equal(await store.get(newRef), 'synthetic-new');
  await assert.rejects(store.set(oldRef, 'synthetic-replacement'), { code: 'CRED_STORE_READ_ONLY' });
  assert.equal(await store.get(oldRef), 'synthetic-old');
  await store.close();
  store = undefined;

  await cp(backup, dataOnly, { recursive: true, errorOnExist: true, force: false });
  store = createCredentialStore({ directory: dataOnly, readOnly: true });
  await assert.rejects(store.get(oldRef), { code: 'CRED_KEY_UNAVAILABLE' });
  await store.close();
  store = undefined;

  await cp(`${backup}.keys`, `${keysOnly}.keys`, { recursive: true, errorOnExist: true, force: false });
  store = createCredentialStore({ directory: keysOnly, readOnly: true });
  await assert.rejects(store.get(oldRef), { code: 'CRED_STORE_UNAVAILABLE' });
  await store.close();
  store = undefined;
  console.log('synthetic SQLite round trip passed (rotation and backup verified)');
} finally {
  try { await store?.close(); } finally { await rm(root, { recursive: true, force: true }); }
}
