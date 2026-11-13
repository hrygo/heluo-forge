import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';
import { selectDefaultStoreDirectory } from '../src/default-store-directory.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

const ref = 'heluo-forge/iam/ref/ONE';
const recordKey = 'heluo-forge/iam/record/session/ONE';

test('a dangling legacy document link does not block or change the new store', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks require platform privileges');
  const root = await outsideRepositoryTmpAsync('forge-old-link-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'data');
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'credentials.json');
  symlinkSync(join(root, 'missing'), path);
  const store = createCredentialStore({ directory });
  try {
    assert.equal(await store.get(ref), undefined);
    await store.set(ref, 'synthetic');
    assert.equal(await store.get(ref), 'synthetic');
  } finally { await store.close(); }
  assert.equal(lstatSync(path).isSymbolicLink(), true);
});

test('a same-directory keyring is rejected without changing existing storage', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-reject-old-keyring-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'data');
  const original = createCredentialStore({ directory });
  await original.set(ref, 'synthetic');
  await original.close();
  const database = join(directory, 'credentials.sqlite');
  const oldKey = join(directory, 'keyring.json');
  renameSync(join(`${directory}.keys`, 'keyring.json'), oldKey);
  const beforeDb = readFileSync(database);
  const beforeKey = readFileSync(oldKey);
  const reader = createCredentialStore({ directory, readOnly: true });
  const writer = createCredentialStore({ directory });
  try {
    await assert.rejects(reader.get(ref), { code: 'CRED_LEGACY_STORE' });
    await assert.rejects(writer.set(ref, 'replacement'), { code: 'CRED_LEGACY_STORE' });
    await assert.rejects(writer.rotate('k2'), { code: 'CRED_LEGACY_STORE' });
  } finally { await reader.close(); await writer.close(); }
  assert.deepEqual(readFileSync(database), beforeDb);
  assert.deepEqual(readFileSync(oldKey), beforeKey);
  assert.equal(existsSync(join(`${directory}.keys`, 'keyring.json')), false);
});

test('a SQLite store with missing or damaged key binding is rejected on all operations', async (t) => {
  for (const condition of ['missing', 'invalid-json', 'missing-active', 'wrong-proof']) await t.test(condition, async (t) => {
    const root = await outsideRepositoryTmpAsync('forge-reject-old-binding-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'data');
    const store = createCredentialStore({ directory });
    await store.set(ref, 'synthetic');
    const database = join(directory, 'credentials.sqlite');
    const db = new DatabaseSync(database);
    const current = db.prepare("SELECT value FROM meta WHERE key='key_auth'").get().value;
    if (condition === 'missing') db.prepare("DELETE FROM meta WHERE key='key_auth'").run();
    else {
      const doc = JSON.parse(current);
      if (condition === 'missing-active') delete doc.keys.k1;
      if (condition === 'wrong-proof') doc.keys.k1 = Buffer.alloc(32, 7).toString('base64');
      db.prepare("UPDATE meta SET value=? WHERE key='key_auth'").run(condition === 'invalid-json' ? '{' : JSON.stringify(doc));
    }
    db.close();
    const beforeDb = readFileSync(database);
    const keyFile = join(`${directory}.keys`, 'keyring.json');
    const beforeKey = readFileSync(keyFile);
    const reader = createCredentialStore({ directory, readOnly: true });
    let called = false;
    try {
      for (const operation of [
        () => reader.get(ref), () => reader.list('heluo-forge/'), () => reader.listEntries('heluo-forge/'),
        () => reader.snapshot({ ref, recordKey }), () => store.get(ref), () => store.set(ref, 'replacement'),
        () => store.delete(ref), () => store.rotate('k2'),
        () => store.transaction(ref, () => { called = true; }),
      ]) await assert.rejects(operation(), (error) => ['CRED_LEGACY_STORE', 'CRED_DECRYPT_FAILED'].includes(error.code));
      assert.equal(called, false);
    } finally { await reader.close(); await store.close(); }
    assert.deepEqual(readFileSync(database), beforeDb);
    assert.deepEqual(readFileSync(keyFile), beforeKey);
  });
});

test('Linux honors an absolute XDG directory without falling back to existing old data', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-xdg-current-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const old = join(home, '.local', 'share', 'HeluoForge');
  const xdg = join(root, 'xdg');
  mkdirSync(old, { recursive: true });
  const sentinel = join(old, 'credentials.json');
  writeFileSync(sentinel, 'synthetic-old-data');
  assert.equal(selectDefaultStoreDirectory({ platform: 'linux', home, xdgDataHome: xdg }), join(xdg, 'HeluoForge'));
  assert.equal(selectDefaultStoreDirectory({ platform: 'linux', home }), old);
  assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic-old-data');
});
