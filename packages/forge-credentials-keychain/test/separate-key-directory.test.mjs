import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const actualKey = (dir) => separateKey(dir);

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

test('native sibling paths remain distinct when process.platform is overridden', (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'platform-spoof');
  const moduleUrl = new URL('../src/credential-store.mjs', import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
    import { createCredentialStore } from ${JSON.stringify(moduleUrl)};
    const original = process.platform;
    const spoofed = original === 'win32' ? 'linux' : 'win32';
    let store;
    try {
      Object.defineProperty(process, 'platform', { value: spoofed, configurable: true });
      store = createCredentialStore({ directory: process.argv[1] });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
    try {
      await store.set(${JSON.stringify(ref)}, 'synthetic');
      assert.equal(await store.get(${JSON.stringify(ref)}), 'synthetic');
    } finally { await store.close(); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, directory], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.equal(existsSync(separateKey(directory)), true);
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
  await assert.rejects(conflict.get(ref), { code: 'CRED_LEGACY_STORE' });
  await assert.rejects(conflict.set(ref, 'replacement'), { code: 'CRED_LEGACY_STORE' });
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

test('a damaged bound historical key blocks reads and writes', async (t) => {
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
  await assert.rejects(damaged.get(ref3), { code: 'CRED_DECRYPT_FAILED' });
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
