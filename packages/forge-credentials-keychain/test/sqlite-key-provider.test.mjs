import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAesGcmCipher } from '../src/cipher.mjs';
import { createEncryptedAdapter } from '../src/encrypted-adapter.mjs';
import { createKeyAuthentication } from '../src/key-auth.mjs';
import { createSqliteBackend } from '../src/sqlite-backend.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

const ref = 'heluo-forge/iam/ref/ONE';
const other = 'heluo-forge/iam/ref/TWO';

// A same-process key source, solely for exercising the storage port.
function memoryKeys() {
  let present = false;
  let active;
  const values = new Map();
  const provider = {
    exists: () => present,
    initialize(kid) {
      if (present) throw Object.assign(new Error('already exists'), { code: 'CRED_KEY_EXISTS' });
      present = true;
      active = kid;
      values.set(kid, Buffer.alloc(32, 1));
    },
    byId: (kid) => values.get(kid),
    add(kid) {
      if (values.has(kid)) throw Object.assign(new Error('already exists'), { code: 'CRED_KEY_EXISTS' });
      values.set(kid, Buffer.alloc(32, values.size + 1));
    },
    activate(kid) {
      if (!values.has(kid)) throw Object.assign(new Error('missing key'), { code: 'CRED_KEY_UNAVAILABLE' });
      active = kid;
    },
  };
  return {
    provider,
    remove: (kid) => values.delete(kid),
    replace: (kid, value) => values.set(kid, value),
    setPresent: (value) => { present = value; },
    active: () => active,
  };
}

async function fixture(t) {
  const root = await outsideRepositoryTmpAsync('forge-nonfile-keys-');
  const stores = [];
  t.after(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    open(directory, keys, readOnly = false) {
      const backend = createSqliteBackend({ directory, readOnly, keyProvider: keys, lockTimeoutMs: 100 });
      const cipher = createAesGcmCipher(keys);
      const integrity = createKeyAuthentication({ backend, cipher, keys });
      const store = createEncryptedAdapter({ backend, cipher, keys, integrity });
      stores.push(store);
      return store;
    },
  };
}

test('SQLite can reopen and rotate with a non-file key source', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  const writer = f.open(directory, keys.provider);
  await writer.set(ref, 'synthetic-old');
  assert.equal(await writer.get(ref), 'synthetic-old');
  await writer.rotate('k2');
  await writer.set(other, 'synthetic-new');
  assert.equal(keys.active(), 'k2');
  await writer.close();

  const reader = f.open(directory, keys.provider, true);
  assert.equal(await reader.get(ref), 'synthetic-old');
  assert.equal(await reader.get(other), 'synthetic-new');
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), true);
  assert.equal(existsSync(`${directory}.keys`), false);
  assert.equal(existsSync(join(directory, 'keyring.json')), false);
  keys.remove('k1');
  await assert.rejects(reader.get(ref), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.equal(await reader.get(other), 'synthetic-new');
});

test('missing key material prevents reads and writes even if key bytes remain cached', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  const store = f.open(directory, keys.provider);
  await store.set(ref, 'synthetic-original');
  const before = readFileSync(join(directory, 'credentials.sqlite'));
  keys.setPresent(false);
  await assert.rejects(store.get(ref), { code: 'CRED_KEY_UNAVAILABLE' });
  await assert.rejects(store.set(ref, 'synthetic-replacement'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.deepEqual(readFileSync(join(directory, 'credentials.sqlite')), before);
  keys.setPresent(true);
  assert.equal(await store.get(ref), 'synthetic-original');
});

test('losing key material during an async mutation prevents its later commit', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  const store = f.open(directory, keys.provider);
  await store.set(ref, 'synthetic-original');
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mutation = store.transaction(ref, async (tx) => {
    tx.set('synthetic-replacement');
    enter();
    await gate;
  });
  const refused = assert.rejects(mutation, { code: 'CRED_KEY_UNAVAILABLE' });
  await entered;
  keys.setPresent(false);
  release();
  await refused;
  keys.setPresent(true);
  assert.equal(await store.get(ref), 'synthetic-original');
});

test('key material lost while waiting for the lock prevents the mutator and releases the lock', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  const firstStore = f.open(directory, keys.provider);
  const secondStore = f.open(directory, keys.provider);
  await firstStore.set(ref, 'synthetic-original');
  let entered;
  let release;
  const holding = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = firstStore.transaction(ref, async () => { entered(); await gate; });
  await holding;

  const originalExec = DatabaseSync.prototype.exec;
  let attempted;
  const waitingForLock = new Promise((resolve) => { attempted = resolve; });
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (sql === 'BEGIN IMMEDIATE') attempted();
    return result;
  };
  let called = 0;
  const second = secondStore.transaction(ref, () => { called += 1; });
  const outcome = second.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  try {
    await waitingForLock;
    keys.setPresent(false);
    release();
    await first;
    const result = await outcome;
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'CRED_KEY_UNAVAILABLE');
    assert.equal(called, 0);
    keys.setPresent(true);
    await secondStore.set(ref, 'synthetic-recovered');
    assert.equal(await firstStore.get(ref), 'synthetic-recovered');
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    keys.setPresent(true);
    release();
    await Promise.allSettled([first, second]);
  }
});

test('a key source error after lock acquisition is preserved and the lock is released', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  const failure = Object.assign(new Error('synthetic key source error'), { code: 'EACCES' });
  let armed = false;
  let checks = 0;
  const provider = { ...keys.provider, exists() {
    if (armed && ++checks === 2) throw failure;
    return keys.provider.exists();
  } };
  const store = f.open(directory, provider);
  await store.set(ref, 'synthetic-original');
  armed = true;
  let called = 0;
  await assert.rejects(store.transaction(ref, () => { called += 1; }), (error) => error === failure);
  assert.equal(called, 0);
  armed = false;
  await store.set(ref, 'synthetic-recovered');
  assert.equal(await store.get(ref), 'synthetic-recovered');
});

test('a replacement key with the same identifier cannot modify a non-file store', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  const store = f.open(directory, keys.provider);
  await store.set(ref, 'synthetic-original');
  await store.close();
  keys.replace('k1', Buffer.alloc(32, 7));
  const reopened = f.open(directory, keys.provider);
  await assert.rejects(reopened.get(ref), { code: 'CRED_DECRYPT_FAILED' });
  for (const action of [() => reopened.set(ref, 'synthetic-replacement'), () => reopened.delete(ref), () => reopened.rotate('k2')]) {
    await assert.rejects(action(), { code: 'CRED_DECRYPT_FAILED' });
  }
  keys.replace('k1', Buffer.alloc(32, 1));
  assert.equal(await reopened.get(ref), 'synthetic-original');
});

test('orphaned non-file key material does not create a database', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  keys.provider.initialize('k1');
  const store = f.open(directory, keys.provider);
  await assert.rejects(store.get(ref), { code: 'CRED_STORE_UNAVAILABLE' });
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_STORE_UNAVAILABLE' });
  assert.equal(existsSync(directory), false);
  assert.equal(keys.provider.exists(), true);
});

test('unknown key material state fails closed without creating storage', async (t) => {
  const f = await fixture(t);
  for (const [name, result] of [
    ['undefined', undefined], ['null', null], ['zero', 0], ['one', 1],
    ['string', 'true'], ['object', {}], ['promise', Promise.resolve(true)],
  ]) {
    const directory = join(f.root, name);
    const keys = { ...memoryKeys().provider, exists: () => result };
    const store = f.open(directory, keys);
    await assert.rejects(store.get(ref), { code: 'CRED_KEY_INVALID' });
    await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_KEY_INVALID' });
    assert.equal(existsSync(directory), false);
  }
});

test('an exception checking key material is not treated as absence', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const failure = Object.assign(new Error('synthetic inaccessible key source'), { code: 'EACCES' });
  const keys = { ...memoryKeys().provider, exists() { throw failure; } };
  const store = f.open(directory, keys);
  await assert.rejects(store.get(ref), (error) => error === failure);
  await assert.rejects(store.set(ref, 'synthetic'), (error) => error === failure);
  assert.equal(existsSync(directory), false);
});

test('a rejected async existence check is invalid and does not create storage', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const provider = { ...memoryKeys().provider, async exists() { throw new Error('synthetic async failure'); } };
  const store = f.open(directory, provider);
  await assert.rejects(store.get(ref), { code: 'CRED_KEY_INVALID' });
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_KEY_INVALID' });
  assert.equal(existsSync(directory), false);
});

test('an accidental async key source cannot initialize a store', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = memoryKeys();
  const provider = { ...keys.provider, async initialize(kid) { keys.provider.initialize(kid); } };
  const store = f.open(directory, provider);
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_KEY_INVALID' });
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), true);
  assert.equal(keys.provider.exists(), true);
  await assert.rejects(store.get(ref), { code: 'CRED_KEY_UNAVAILABLE' });
});

test('failed key initialization preserves the partial database and is not retried', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const failure = Object.assign(new Error('synthetic initialization failure'), { code: 'EACCES' });
  let attempts = 0;
  const provider = { ...memoryKeys().provider, initialize() { attempts += 1; throw failure; } };
  const store = f.open(directory, provider);
  await assert.rejects(store.set(ref, 'synthetic'), (error) => error === failure);
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), true);
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.equal(attempts, 1);
});

test('a non-function exists member fails closed instead of falling back to a file', async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, 'store');
  const keys = { ...memoryKeys().provider, exists: false };
  const store = f.open(directory, keys);
  await assert.rejects(store.get(ref), { code: 'CRED_KEY_INVALID' });
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_KEY_INVALID' });
  assert.equal(existsSync(directory), false);
});

test('a non-file key source still rejects a database in a repository', async (t) => {
  const f = await fixture(t);
  const repository = join(f.root, 'repository');
  mkdirSync(join(repository, '.git'), { recursive: true });
  const directory = join(repository, 'store');
  const store = f.open(directory, memoryKeys().provider);
  await assert.rejects(store.get(ref), { code: 'CRED_STORE_PATH_CONFLICT' });
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_STORE_PATH_CONFLICT' });
  assert.equal(existsSync(directory), false);
});

test('a non-file key source rejects a repository reached through a symlink', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const repository = join(f.root, 'repository');
  mkdirSync(join(repository, '.git'), { recursive: true });
  const alias = join(f.root, 'alias');
  symlinkSync(repository, alias);
  const directory = join(alias, 'store');
  const store = f.open(directory, memoryKeys().provider);
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_STORE_PATH_CONFLICT' });
  assert.equal(existsSync(directory), false);
});
