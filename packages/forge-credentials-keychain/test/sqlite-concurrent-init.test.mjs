import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

const backendUrl = new URL('../src/sqlite-backend.mjs', import.meta.url).href;
const keyringUrl = new URL('../src/keyring.mjs', import.meta.url).href;
const source = `import { createSqliteBackend } from ${JSON.stringify(backendUrl)};
import { createFileKeyProvider } from ${JSON.stringify(keyringUrl)};
import { existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const dir = process.argv[1], role = process.argv[2], timeout = Number(process.argv[3]);
const keyProvider = createFileKeyProvider({ path: join(dir + '.keys', 'keyring.json') });
const keys = role === 'first' ? { ...keyProvider, initialize(kid) {
  writeSync(1, 'initializing\\n');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(dir, 'release'))) Atomics.wait(wait, 0, 0, 5);
  keyProvider.initialize(kid);
}} : role === 'after-key' ? { ...keyProvider, initialize(kid) {
  keyProvider.initialize(kid);
  writeSync(1, 'key-ready\\n');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(dir, 'release'))) Atomics.wait(wait, 0, 0, 5);
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    try { return originalExec.call(this, sql); }
    catch (error) {
      if ((sql === 'BEGIN EXCLUSIVE' || sql === 'COMMIT') && (error.errcode === 5 || error.errcode === 6)) {
        writeSync(1, 'activation-busy\\n');
      }
      throw error;
    }
  };
}} : keyProvider;
const db = createSqliteBackend({ directory: dir, keyProvider: keys, readOnly: false, lockTimeoutMs: timeout });
try {
  if (role === 'second') writeSync(1, 'started\\n');
  await db.withLock(token => db.commit(token, () => db.set({ id: role, kind:'ref', owner:'', envelope: Buffer.from('synthetic'), kid:'k1' })));
  await db.close();
  writeSync(1, 'success\\n');
} catch (error) { writeSync(1, 'error:' + (error.code || 'unknown') + ':' + (error.errcode ?? 'none') + '\\n'); process.exitCode = 1; }`;

function child(directory, role, timeout) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source, directory, role, String(timeout)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let stderr = '';
  process.stdout.on('data', (chunk) => { output += chunk; });
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = once(process, 'close').then(([code, signal]) => ({ code, signal, output, stderr }));
  void exit.catch(() => {});
  return { process, exit, async waitFor(text) {
    const limit = Date.now() + 3000;
    while (!output.includes(text)) {
      if (process.exitCode !== null || Date.now() > limit) throw Error(`child did not reach ${text}: ${output} ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } };
}

async function setup(t) {
  const root = await outsideRepositoryTmpAsync('forge-init-race-');
  const directory = join(root, 'data');
  const children = [];
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    for (const c of children) {
      if (c.process.exitCode === null && c.process.signalCode === null) {
        try { if (!c.process.kill('SIGKILL')) throw new Error('could not stop test child'); }
        catch (error) { errors.push(error); }
      }
    }
    for (const result of await Promise.allSettled(children.map((c) => c.exit))) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    while (cleanups.length) {
      try { await cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    await rm(root, { recursive: true, force: true });
  });
  const start = (role, timeout = 5000) => { const c = child(directory, role, timeout); children.push(c); return c; };
  const own = (resource) => {
    let closing;
    const close = () => closing ??= Promise.resolve().then(() => resource.close());
    cleanups.push(close);
    return close;
  };
  return { directory, start, own };
}

test('two processes safely write during the first initialization', async (t) => {
  const { directory, start, own } = await setup(t);
  const first = start('first');
  await first.waitFor('initializing');
  const second = start('second');
  await second.waitFor('started');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(join(directory, 'release'), 'go');
  const [a, b] = await Promise.all([first.exit, second.exit]);
  assert.equal(a.code, 0, a.output + a.stderr);
  assert.equal(b.code, 0, b.output + b.stderr);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'), { readOnly: true });
  const closeDb = own(db);
  assert.deepEqual(db.prepare('SELECT id FROM secret ORDER BY id').all().map((row) => row.id), ['first', 'second']);
  await closeDb();
});

test('initialization waits for a reader before activating the single generated key', async (t) => {
  const { directory, start, own } = await setup(t);
  const first = start('after-key');
  await first.waitFor('key-ready');
  const originalKeyring = await readFile(join(`${directory}.keys`, 'keyring.json'));
  const { DatabaseSync } = await import('node:sqlite');
  const reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const closeReader = own(reader);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT value FROM meta').all();
    await writeFile(join(directory, 'release'), 'go');
    await first.waitFor('activation-busy');
    reader.exec('COMMIT');
    const result = await first.exit;
    assert.equal(result.code, 0, result.output + result.stderr);
    assert.deepEqual(await readFile(join(`${directory}.keys`, 'keyring.json')), originalKeyring);
    const db = new DatabaseSync(join(directory, 'credentials.sqlite'), { readOnly: true });
    const closeDb = own(db);
    try {
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'active'").get().value, 'k1');
      assert.deepEqual(db.prepare('SELECT id FROM secret').all().map((row) => row.id), ['after-key']);
    } finally { await closeDb(); }
  } finally { await closeReader(); }
});

test('writers sharing one backend wait until initialization activates the key', async (t) => {
  const { directory, own } = await setup(t);
  const { createSqliteBackend } = await import('../src/sqlite-backend.mjs');
  const { createFileKeyProvider } = await import('../src/keyring.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const keys = createFileKeyProvider({ path: join(`${directory}.keys`, 'keyring.json') });
  let reader;
  let closeReader;
  let calls = 0;
  const backend = createSqliteBackend({ directory, readOnly: false, lockTimeoutMs: 5000,
    keyProvider: { ...keys, initialize(kid) {
      calls += 1;
      keys.initialize(kid);
      reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
      closeReader = own(reader);
      reader.exec('BEGIN');
      reader.prepare('SELECT value FROM meta').all();
    } },
  });
  const closeBackend = own(backend);
  const write = (id) => backend.withLock((token) => backend.commit(token, () => {
    backend.set({ id, kind: 'ref', owner: '', envelope: Buffer.from('synthetic'), kid: backend.active() });
  }));
  const first = write('first');
  const second = write('second');
  try {
    assert.throws(() => backend.open(), { code: 'CRED_KEY_UNAVAILABLE' });
    reader.exec('COMMIT');
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(backend.list().map((row) => row.id), ['first', 'second']);
    assert.equal(backend.active(), 'k1');
  } finally {
    await closeReader?.();
    await Promise.allSettled([first, second]);
    await closeBackend();
  }
});

test('initialization contention timeout preserves the generated key and fails closed', async (t) => {
  const { directory, start, own } = await setup(t);
  const first = start('after-key', 100);
  await first.waitFor('key-ready');
  const originalKeyring = await readFile(join(`${directory}.keys`, 'keyring.json'));
  const { DatabaseSync } = await import('node:sqlite');
  const reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const closeReader = own(reader);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT value FROM meta').all();
    await writeFile(join(directory, 'release'), 'go');
    await first.waitFor('activation-busy');
    const result = await first.exit;
    assert.notEqual(result.code, 0);
    assert.match(result.output, /error:CRED_LOCK_TIMEOUT/);
    reader.exec('COMMIT');
    assert.deepEqual(await readFile(join(`${directory}.keys`, 'keyring.json')), originalKeyring);
    const { createCredentialStore } = await import('../src/credential-store.mjs');
    const store = createCredentialStore({ directory, lockTimeoutMs: 100 });
    const closeStore = own(store);
    try {
      await assert.rejects(store.get('heluo-forge/iam/ref/TEST'), { code: 'CRED_KEY_UNAVAILABLE' });
      await assert.rejects(store.set('heluo-forge/iam/ref/TEST', 'synthetic'), { code: 'CRED_KEY_UNAVAILABLE' });
      assert.deepEqual(await readFile(join(`${directory}.keys`, 'keyring.json')), originalKeyring);
    } finally { await closeStore(); }
  } finally { await closeReader(); }
});

test('interrupted initialization never regenerates a key or overwrites the database', async (t) => {
  const { directory, start } = await setup(t);
  const first = start('first');
  await first.waitFor('initializing');
  first.process.kill('SIGKILL');
  await first.exit;
  const before = await readFile(join(directory, 'credentials.sqlite'));
  const second = start('second', 300);
  const result = await second.exit;
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(join(`${directory}.keys`, 'keyring.json')), false);
  assert.deepEqual(await readFile(join(directory, 'credentials.sqlite')), before);
});

test('read-only writes refuse without creating a directory or marker', async (t) => {
  const { directory, own } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const missing = join(directory, 'not-created');
  const store = createCredentialStore({ directory: missing, readOnly: true, lockTimeoutMs: 50 });
  const closeStore = own(store);
  await assert.rejects(store.set('heluo-forge/iam/ref/TEST', 'synthetic'), { code: 'CRED_STORE_READ_ONLY' });
  assert.equal(existsSync(missing), false);
  await closeStore();
});

test('a verified complete store can be written with an untouched leftover marker', async (t) => {
  const { directory, own } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const key = 'heluo-forge/iam/ref/TEST';
  const first = createCredentialStore({ directory, lockTimeoutMs: 50 });
  const closeFirst = own(first);
  await first.set(key, 'before');
  await closeFirst();
  const marker = join(directory, 'credentials.sqlite.init');
  await writeFile(marker, 'unknown-owner');
  const next = createCredentialStore({ directory, lockTimeoutMs: 50 });
  const closeNext = own(next);
  await next.set(key, 'after');
  assert.equal(await next.get(key), 'after');
  assert.equal(await readFile(marker, 'utf8'), 'unknown-owner');
  await closeNext();
});

test('leftover marker with a missing keyring cannot bypass initialization safety', async (t) => {
  const { directory, own } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const { unlink } = await import('node:fs/promises');
  const key = 'heluo-forge/iam/ref/TEST';
  const first = createCredentialStore({ directory, lockTimeoutMs: 30 });
  const closeFirst = own(first);
  await first.set(key, 'before');
  await closeFirst();
  const database = join(directory, 'credentials.sqlite');
  const before = await readFile(database);
  const marker = join(directory, 'credentials.sqlite.init');
  await writeFile(marker, 'unknown-owner');
  await unlink(join(`${directory}.keys`, 'keyring.json'));
  const next = createCredentialStore({ directory, lockTimeoutMs: 30 });
  const closeNext = own(next);
  await assert.rejects(next.set(key, 'after'), { code: 'CRED_LOCK_TIMEOUT' });
  assert.equal(existsSync(join(`${directory}.keys`, 'keyring.json')), false);
  assert.deepEqual(await readFile(database), before);
  assert.equal(await readFile(marker, 'utf8'), 'unknown-owner');
  await closeNext();
});

test('a transient SQLite exclusive lock during opening is retried', async (t) => {
  const { directory, own } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const key = 'heluo-forge/iam/ref/TEST';
  const first = createCredentialStore({ directory });
  const closeFirst = own(first);
  await first.set(key, 'before');
  await closeFirst();
  const blocker = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const closeBlocker = own(blocker);
  blocker.exec('BEGIN EXCLUSIVE');
  const second = createCredentialStore({ directory, lockTimeoutMs: 700 });
  const closeSecond = own(second);
  try {
    const verify = new DatabaseSync(join(directory, 'credentials.sqlite'));
    const closeVerify = own(verify);
    try {
      verify.exec('PRAGMA busy_timeout=0');
      assert.throws(() => verify.prepare('PRAGMA user_version').get(), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    } finally { await closeVerify(); }
    const write = second.set(key, 'after').then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    blocker.exec('COMMIT');
    const result = await write;
    assert.equal(result.ok, true, result.error?.stack);
    assert.equal(await second.get(key), 'after');
  } finally {
    await closeBlocker();
    await closeSecond();
  }
});

test('an invalid database fails immediately instead of being treated as contention', async (t) => {
  const { directory, own } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const key = 'heluo-forge/iam/ref/TEST';
  const initial = createCredentialStore({ directory });
  const closeInitial = own(initial);
  await initial.set(key, 'before');
  await closeInitial();
  await writeFile(join(directory, 'credentials.sqlite'), 'invalid sqlite database');
  const store = createCredentialStore({ directory, lockTimeoutMs: 700 });
  own(store);
  await assert.rejects(store.set(key, 'after'), (error) => error.code === 'ERR_SQLITE_ERROR' && error.errcode !== 5 && error.errcode !== 6);
});


test('a leftover marker does not mask a corrupted database as contention', async (t) => {
  const { directory, own } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const key = 'heluo-forge/iam/ref/TEST';
  const initial = createCredentialStore({ directory });
  const closeInitial = own(initial);
  await initial.set(key, 'before');
  await closeInitial();
  await writeFile(join(directory, 'credentials.sqlite'), 'invalid sqlite database');
  await writeFile(join(directory, 'credentials.sqlite.init'), 'unknown-owner');
  const store = createCredentialStore({ directory, lockTimeoutMs: 80 });
  own(store);
  await assert.rejects(store.set(key, 'after'), (error) => error.code === 'ERR_SQLITE_ERROR' && error.errcode !== 5 && error.errcode !== 6);
});

test('persistent SQLite contention times out without changing committed credentials', async (t) => {
  const { directory, own } = await setup(t);
  const { createCredentialStore } = await import('../src/credential-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const key = 'heluo-forge/iam/ref/TEST';
  const initial = createCredentialStore({ directory });
  const closeInitial = own(initial);
  await initial.set(key, 'before');
  await closeInitial();
  const blocker = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const closeBlocker = own(blocker);
  blocker.exec('BEGIN EXCLUSIVE');
  const store = createCredentialStore({ directory, lockTimeoutMs: 40 });
  const closeStore = own(store);
  try {
    await assert.rejects(store.set(key, 'after'), { code: 'CRED_LOCK_TIMEOUT' });
    assert.equal(existsSync(join(directory, 'credentials.sqlite.init')), false);
    blocker.exec('COMMIT');
    assert.equal(await store.get(key), 'before');
  } finally {
    await closeBlocker();
    await closeStore();
  }
});
