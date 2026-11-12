import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';

const ref = 'heluo-forge/iam/ref/ONE';
const ref2 = 'heluo-forge/iam/ref/TWO';
const ref3 = 'heluo-forge/iam/ref/THREE';
const legacyKey = (dir) => join(dir, 'keyring.json');
const separateKey = (dir) => join(`${dir}.keys`, 'keyring.json');
const actualKey = (dir) => existsSync(separateKey(dir)) ? separateKey(dir) : legacyKey(dir);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-separated-key-'));
  const stores = [];
  const children = [];
  t.after(async () => {
    const errors = [];
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill();
      try { await child.finished; } catch (error) { errors.push(error); }
    }
    while (stores.length) {
      try { await stores.pop().close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'failed to close test resources');
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    stores,
    children,
    open(directory, options = {}) {
      const store = createCredentialStore({ directory, ...options });
      stores.push(store);
      return store;
    },
  };
}

function asLegacy(directory) {
  if (existsSync(separateKey(directory))) renameSync(separateKey(directory), legacyKey(directory));
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try { db.prepare("DELETE FROM meta WHERE key = 'key_auth'").run(); }
  finally { db.close(); }
}

test('new stores separate keys and data-only copies cannot be written', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'store');
  const empty = join(f.root, 'empty');
  const reader = f.open(empty, { readOnly: true });
  await assert.rejects(reader.get(ref));
  assert.equal(existsSync(empty), false);
  assert.equal(existsSync(`${empty}.keys`), false);
  const store = f.open(`${directory}/`);
  await store.set(ref, 'synthetic');
  assert.equal(existsSync(legacyKey(directory)), false);
  assert.equal(existsSync(separateKey(directory)), true);
  await store.close();
  const copy = join(f.root, 'copy');
  await cp(directory, copy, { recursive: true });
  const incomplete = f.open(copy);
  const before = readFileSync(join(copy, 'credentials.sqlite'));
  await assert.rejects(incomplete.get(ref), { code: 'CRED_KEY_UNAVAILABLE' });
  await assert.rejects(incomplete.set(ref, 'replacement'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.deepEqual(readFileSync(join(copy, 'credentials.sqlite')), before);
  assert.equal(existsSync(`${copy}.keys`), false);
});

test('legacy stores stay in place and a stopped manual key move remains readable', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'legacy');
  const original = f.open(directory);
  await original.set(ref, 'old');
  await original.close();
  asLegacy(directory);
  const beforeRead = readFileSync(join(directory, 'credentials.sqlite'));
  const reader = f.open(directory, { readOnly: true });
  assert.equal(await reader.get(ref), 'old');
  await reader.close();
  assert.deepEqual(readFileSync(join(directory, 'credentials.sqlite')), beforeRead);
  const writer = f.open(directory);
  await writer.rotate('k2');
  await writer.set(ref2, 'new');
  await writer.close();
  assert.equal(existsSync(legacyKey(directory)), true);
  assert.equal(existsSync(separateKey(directory)), false);
  mkdirSync(`${directory}.keys`, { mode: 0o700, recursive: true });
  renameSync(legacyKey(directory), separateKey(directory));
  const moved = f.open(directory, { readOnly: true });
  assert.equal(await moved.get(ref), 'old');
  assert.equal(await moved.get(ref2), 'new');
});

test('two keyring locations conflict without changing either file or the database', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'conflict');
  const writer = f.open(directory);
  await writer.set(ref, 'synthetic');
  await writer.close();
  const source = actualKey(directory);
  const other = source === legacyKey(directory) ? separateKey(directory) : legacyKey(directory);
  mkdirSync(`${directory}.keys`, { mode: 0o700, recursive: true });
  copyFileSync(source, other);
  const dbPath = join(directory, 'credentials.sqlite');
  const beforeDb = readFileSync(dbPath);
  const beforeOld = readFileSync(legacyKey(directory));
  const beforeNew = readFileSync(separateKey(directory));
  const conflict = f.open(directory);
  await assert.rejects(conflict.get(ref), { code: 'CRED_KEY_UNAVAILABLE' });
  await assert.rejects(conflict.set(ref, 'replacement'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.deepEqual(readFileSync(dbPath), beforeDb);
  assert.deepEqual(readFileSync(legacyKey(directory)), beforeOld);
  assert.deepEqual(readFileSync(separateKey(directory)), beforeNew);
});

test('same-kid keyring swaps refuse set, delete and rotate without changing the database', async (t) => {
  const f = fixture(t);
  const a = join(f.root, 'a');
  const b = join(f.root, 'b');
  const first = f.open(a);
  const second = f.open(b);
  await first.set(ref, 'first');
  await second.set(ref, 'second');
  await first.close();
  await second.close();
  const keyA = actualKey(a);
  const correct = readFileSync(keyA);
  copyFileSync(actualKey(b), keyA);
  const wrong = readFileSync(keyA);
  const dbPath = join(a, 'credentials.sqlite');
  const before = readFileSync(dbPath);
  const bad = f.open(a);
  for (const operation of [() => bad.set(ref, 'replacement'), () => bad.set(ref2, 'new'), () => bad.delete(ref), () => bad.rotate('k2')]) {
    await assert.rejects(operation(), { code: 'CRED_DECRYPT_FAILED' });
    assert.deepEqual(readFileSync(dbPath), before);
    assert.deepEqual(readFileSync(keyA), wrong);
  }
  await bad.close();
  writeFileSync(keyA, correct);
  const restored = f.open(a, { readOnly: true });
  assert.equal(await restored.get(ref), 'first');
});

test('unbound legacy data refuses a same-kid keyring swap before any callback or write', async (t) => {
  const f = fixture(t);
  const a = join(f.root, 'legacy-a');
  const b = join(f.root, 'legacy-b');
  const first = f.open(a);
  const second = f.open(b);
  await first.set(ref, 'first');
  await second.set(ref, 'second');
  await first.close();
  await second.close();
  asLegacy(a);
  const keyPath = legacyKey(a);
  const correct = readFileSync(keyPath);
  copyFileSync(actualKey(b), keyPath);
  const wrong = readFileSync(keyPath);
  const database = join(a, 'credentials.sqlite');
  const before = readFileSync(database);
  const bad = f.open(a);
  let calls = 0;
  for (const operation of [
    () => bad.set(ref, 'replacement'),
    () => bad.set(ref2, 'new'),
    () => bad.delete(ref),
    () => bad.rotate('k2'),
    () => bad.transaction(ref, async () => { calls += 1; }),
  ]) {
    await assert.rejects(operation(), { code: 'CRED_DECRYPT_FAILED' });
    assert.deepEqual(readFileSync(database), before);
    assert.deepEqual(readFileSync(keyPath), wrong);
  }
  assert.equal(calls, 0);
  await bad.close();
  writeFileSync(keyPath, correct);
  const restored = f.open(a, { readOnly: true });
  assert.equal(await restored.get(ref), 'first');
});

test('unbound legacy data with a missing historical key cannot be changed', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'missing-history');
  const writer = f.open(directory);
  await writer.set(ref, 'one');
  await writer.rotate('k2');
  await writer.set(ref2, 'two');
  await writer.rotate('k3');
  await writer.set(ref3, 'three');
  await writer.close();
  asLegacy(directory);
  const keyPath = legacyKey(directory);
  const saved = readFileSync(keyPath);
  const document = JSON.parse(saved);
  delete document.keys.k1;
  writeFileSync(keyPath, JSON.stringify(document));
  const before = readFileSync(join(directory, 'credentials.sqlite'));
  const damaged = f.open(directory);
  let called = 0;
  await assert.rejects(damaged.transaction(ref3, () => { called += 1; }), { code: 'CRED_KEY_UNAVAILABLE' });
  await assert.rejects(damaged.set(ref3, 'replacement'), { code: 'CRED_KEY_UNAVAILABLE' });
  assert.equal(called, 0);
  assert.deepEqual(readFileSync(join(directory, 'credentials.sqlite')), before);
  await damaged.close();
  writeFileSync(keyPath, saved);
  const restored = f.open(directory, { readOnly: true });
  assert.equal(await restored.get(ref), 'one');
  assert.equal(await restored.get(ref2), 'two');
  assert.equal(await restored.get(ref3), 'three');
});

test('a damaged historical key blocks writes without affecting readable newer values', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'damaged-history');
  const writer = f.open(directory);
  await writer.set(ref, 'one');
  await writer.rotate('k2');
  await writer.set(ref2, 'two');
  await writer.rotate('k3');
  await writer.set(ref3, 'three');
  await writer.close();
  const path = actualKey(directory);
  const saved = readFileSync(path);
  const document = JSON.parse(saved);
  document.keys.k2 = Buffer.alloc(32, 7).toString('base64');
  writeFileSync(path, JSON.stringify(document));
  const before = readFileSync(join(directory, 'credentials.sqlite'));
  const damaged = f.open(directory);
  assert.equal(await damaged.get(ref3), 'three');
  await assert.rejects(damaged.set(ref3, 'replacement'), { code: 'CRED_DECRYPT_FAILED' });
  await assert.rejects(damaged.delete(ref3), { code: 'CRED_DECRYPT_FAILED' });
  assert.deepEqual(readFileSync(join(directory, 'credentials.sqlite')), before);
  await damaged.close();
  writeFileSync(path, saved);
  const restored = f.open(directory, { readOnly: true });
  assert.equal(await restored.get(ref), 'one');
  assert.equal(await restored.get(ref2), 'two');
  assert.equal(await restored.get(ref3), 'three');
});

test('unbound legacy validation checks every historical ciphertext before a write', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'damaged-legacy-row');
  const writer = f.open(directory);
  await writer.set(ref, 'one');
  await writer.rotate('k2');
  await writer.set(ref2, 'two');
  await writer.rotate('k3');
  await writer.set(ref3, 'three');
  await writer.close();
  asLegacy(directory);
  const database = join(directory, 'credentials.sqlite');
  const original = readFileSync(database);
  const db = new DatabaseSync(database);
  try {
    const envelope = Buffer.from(db.prepare('SELECT envelope FROM secret WHERE id = ?').get(ref2).envelope);
    envelope[envelope.length - 1] ^= 1;
    db.prepare('UPDATE secret SET envelope = ? WHERE id = ?').run(envelope, ref2);
  } finally { db.close(); }
  const damagedBytes = readFileSync(database);
  const damaged = f.open(directory);
  await assert.rejects(damaged.set(ref3, 'replacement'), { code: 'CRED_DECRYPT_FAILED' });
  assert.deepEqual(readFileSync(database), damagedBytes);
  await damaged.close();
  writeFileSync(database, original);
  const restored = f.open(directory, { readOnly: true });
  assert.equal(await restored.get(ref), 'one');
  assert.equal(await restored.get(ref2), 'two');
  assert.equal(await restored.get(ref3), 'three');
});

test('an orphan sibling keyring cannot cause a new data directory or database', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'orphan');
  mkdirSync(`${directory}.keys`, { mode: 0o700 });
  const path = separateKey(directory);
  writeFileSync(path, 'synthetic-orphan', { mode: 0o600 });
  const store = f.open(directory);
  await assert.rejects(store.get(ref), { code: 'CRED_STORE_UNAVAILABLE' });
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_STORE_UNAVAILABLE' });
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(path, 'utf8'), 'synthetic-orphan');
});

test('a data directory cannot be used as another store key directory', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'overlap');
  mkdirSync(`${directory}.keys`, { mode: 0o700 });
  const database = join(`${directory}.keys`, 'credentials.sqlite');
  writeFileSync(database, 'synthetic-database', { mode: 0o600 });
  const store = f.open(directory);
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_STORE_PATH_CONFLICT' });
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(database, 'utf8'), 'synthetic-database');
});

test('an existing key directory cannot become another store data directory', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'owner');
  const owner = f.open(directory);
  await owner.set(ref, 'synthetic');
  await owner.close();
  const keyring = readFileSync(separateKey(directory));
  const mistaken = f.open(`${directory}.keys`);
  await assert.rejects(mistaken.set(ref, 'other'), { code: 'CRED_STORE_PATH_CONFLICT' });
  assert.equal(existsSync(join(`${directory}.keys`, 'credentials.sqlite')), false);
  assert.deepEqual(readFileSync(separateKey(directory)), keyring);
});

test('path permission errors are not treated as missing directories', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'denied');
  const original = fs.lstatSync;
  const store = f.open(directory);
  try {
    fs.lstatSync = (path, ...args) => {
      if (path === `${directory}.keys`) throw Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' });
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(store.get(ref), { code: 'EACCES' });
    await assert.rejects(store.set(ref, 'synthetic'), { code: 'EACCES' });
    assert.equal(existsSync(directory), false);
  } finally {
    fs.lstatSync = original;
    syncBuiltinESMExports();
  }
});

test('symlinked or unsafe key directories fail closed', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'link');
  mkdirSync(directory, { mode: 0o700 });
  symlinkSync(directory, `${directory}.keys`);
  const linked = f.open(directory);
  await assert.rejects(linked.set(ref, 'synthetic'), { code: 'CRED_STORE_UNAVAILABLE' });
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), false);
  const unsafe = join(f.root, 'unsafe');
  mkdirSync(`${unsafe}.keys`, { mode: 0o700 });
  chmodSync(`${unsafe}.keys`, 0o755);
  const bad = f.open(unsafe);
  await assert.rejects(bad.set(ref, 'synthetic'), { code: 'CRED_STORE_PERMISSIONS' });
  assert.equal(existsSync(unsafe), false);
});

test('direct stores reject repositories reached through a symlinked parent', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const repository = join(f.root, 'repository');
  mkdirSync(join(repository, '.git'), { recursive: true });
  const alias = join(f.root, 'alias');
  symlinkSync(repository, alias);
  const directory = join(alias, 'credentials');
  const store = f.open(directory);
  await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_STORE_PATH_CONFLICT' });
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(`${directory}.keys`), false);
});

test('an existing data directory inside a repository is rejected before any marker is opened', async (t) => {
  const f = fixture(t);
  const repository = join(f.root, 'existing-repository');
  const directory = join(repository, 'data');
  mkdirSync(join(repository, '.git'), { recursive: true });
  mkdirSync(directory, { mode: 0o700 });
  const marker = join(directory, 'credentials.sqlite.init');
  const original = fs.openSync;
  const store = f.open(directory);
  let markerOpened = false;
  try {
    fs.openSync = (path, ...args) => {
      if (path === marker) markerOpened = true;
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(store.set(ref, 'synthetic'), { code: 'CRED_STORE_PATH_CONFLICT' });
    assert.equal(markerOpened, false);
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(existsSync(`${directory}.keys`), false);
  } finally {
    fs.openSync = original;
    syncBuiltinESMExports();
  }
});

test('concurrent first writers share a separated keyring and rotated backups preserve all keys', { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'concurrent');
  const moduleUrl = new URL('../src/credential-store.mjs', import.meta.url).href;
  const source = `import { createCredentialStore } from ${JSON.stringify(moduleUrl)};
    const store = createCredentialStore({ directory: process.argv[1], lockTimeoutMs: 5000 });
    try { await store.set(process.argv[2], 'synthetic'); } finally { await store.close(); }`;
  const launch = (key) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, key], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const finished = once(child, 'close').then(([code]) => ({ code, stderr }));
    f.children.push({ process: child, finished });
    return finished;
  };
  const results = await Promise.all([launch(ref), launch(ref2)]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const store = f.open(directory);
  await store.rotate('k2');
  await store.set(ref3, 'new-key');
  await store.close();
  const backup = join(f.root, 'backup');
  await cp(directory, backup, { recursive: true });
  await cp(`${directory}.keys`, `${backup}.keys`, { recursive: true });
  const restored = f.open(backup, { readOnly: true });
  assert.equal(await restored.get(ref), 'synthetic');
  assert.equal(await restored.get(ref2), 'synthetic');
  assert.equal(await restored.get(ref3), 'new-key');
});
