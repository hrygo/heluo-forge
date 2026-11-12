import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';

const recordKey = 'heluo-forge/iam/record/heluo-iam/gateway-credential';
const ref = 'heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY';
const scope = { recordKey, ref };
const record = { kind: 'grant', payload: { version: 2, ownerSubject: 'E1001' } };
const marker = 'secret-marker-0123456789abcdefghi';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'heluo-sqlite-test-'));
  const store = createCredentialStore({ directory, ...options });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store };
}

test('values are individually encrypted and survive a new reader without plaintext in sqlite files', async (t) => {
  const { directory, store } = await fixture(t);
  await store.set(ref, marker);
  await store.set(recordKey, JSON.stringify(record));
  assert.equal(await store.get(ref), marker);
  const reader = createCredentialStore({ directory, readOnly: true });
  assert.equal(await reader.get(ref), marker);
  assert.equal(await reader.get(recordKey), JSON.stringify(record));
  await reader.close();
  for (const name of ['credentials.sqlite', 'credentials.sqlite-wal', 'credentials.sqlite-shm']) {
    const path = join(directory, name);
    if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from(marker)), false, name);
  }
});

test('joint commit returns a matching snapshot and a stale comparison does not invoke the guard', async (t) => {
  const { store } = await fixture(t);
  const empty = await store.snapshot(scope);
  assert.deepEqual(empty, { record: undefined, value: undefined });
  const next = { record, value: marker };
  assert.deepEqual(await store.compareAndSwap(scope, empty, next, () => true), { ok: true, snapshot: next });
  let calls = 0;
  assert.deepEqual(await store.compareAndSwap(scope, empty, next, () => { calls += 1; return true; }), { ok: false });
  assert.equal(calls, 0);
  assert.deepEqual(await store.snapshot(scope), next);
});

test('a rejected guard leaves both values unchanged', async (t) => {
  const { store } = await fixture(t);
  const empty = await store.snapshot(scope);
  let calls = 0;
  await assert.rejects(store.compareAndSwap(scope, empty, { record, value: marker }, () => { calls += 1; return false; }),
    (error) => error.code === 'KEYCHAIN_GUARD_REFUSED');
  assert.equal(calls, 1);
  assert.deepEqual(await store.snapshot(scope), empty);
});

test('the second database write failing rolls back the complete joint commit', async (t) => {
  const { directory, store } = await fixture(t);
  await store.set('heluo-forge/iam/ref/UNRELATED', 'seed');
  const empty = await store.snapshot(scope);
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON secret WHEN new.kind = 'ref' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await assert.rejects(store.compareAndSwap(scope, empty, { record, value: marker }, () => true));
  assert.deepEqual(await store.snapshot(scope), empty);
  db.close();
});

test('owner tampering fails authentication and does not return the old value', async (t) => {
  const { directory, store } = await fixture(t);
  await store.set(recordKey, JSON.stringify(record));
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  db.prepare('UPDATE secret SET owner = ? WHERE id = ?').run('E1002', recordKey);
  db.close();
  await assert.rejects(store.get(recordKey), (error) => error.code === 'CRED_DECRYPT_FAILED');
});

test('async record mutation does not hold a sqlite transaction and another writer waits', async (t) => {
  const { directory, store } = await fixture(t, { lockTimeoutMs: 1500 });
  await store.set(ref, 'before');
  const other = createCredentialStore({ directory, lockTimeoutMs: 1500 });
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const transaction = store.transaction(ref, async (tx) => {
    assert.equal(tx.get(), 'before');
    entered();
    await gate;
    tx.set('after');
  });
  await waiting;
  assert.equal(await other.get(ref), 'before');
  let secondFinished = false;
  const second = other.set(ref, 'last').then(() => { secondFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondFinished, false);
  release();
  await transaction;
  await second;
  assert.equal(await other.get(ref), 'last');
  await other.close();
});

test('close waits for an in-flight mutation and releases its lock before reopening', async (t) => {
  const { directory, store } = await fixture(t, { lockTimeoutMs: 100 });
  await store.set(ref, 'before');
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mutation = store.transaction(ref, async (tx) => {
    enter();
    await gate;
    tx.set('after');
  });
  await entered;
  let finished = false;
  const closing = store.close().then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const finishedBeforeRelease = finished;
  release();
  const results = await Promise.allSettled([mutation, closing]);
  assert.equal(finishedBeforeRelease, false);
  assert.equal(results[0].status, 'fulfilled', results[0].reason?.stack);
  assert.equal(results[1].status, 'fulfilled', results[1].reason?.stack);
  const reopened = createCredentialStore({ directory, lockTimeoutMs: 100 });
  t.after(() => reopened.close());
  assert.equal(await reopened.get(ref), 'after');
  await reopened.set(ref, 'reopened');
  assert.equal(await reopened.get(ref), 'reopened');
});

test('missing keyring or legacy document is rejected without replacing existing data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'heluo-sqlite-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = join(directory, 'credentials.json');
  writeFileSync(legacy, 'legacy-test-data');
  const store = createCredentialStore({ directory });
  await assert.rejects(store.get(ref), (error) => error.code === 'CRED_LEGACY_STORE');
  assert.equal(readFileSync(legacy, 'utf8'), 'legacy-test-data');
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), false);
  await store.close();
});

test('read-only open on absent storage creates no files', async (t) => {
  const { directory, store } = await fixture(t, { readOnly: true });
  await assert.rejects(store.get(ref), (error) => error.code === 'CRED_STORE_UNAVAILABLE');
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), false);
  assert.equal(existsSync(join(directory, 'keyring.json')), false);
});

test('ordinary reads on an uninitialized writable store do not create a database or keyring', async (t) => {
  const { directory, store } = await fixture(t);
  assert.equal(await store.get(ref), undefined);
  assert.deepEqual(await store.snapshot(scope), { record: undefined, value: undefined });
  assert.deepEqual(await store.list('heluo-forge/'), []);
  assert.equal(existsSync(join(directory, 'credentials.sqlite')), false);
  assert.equal(existsSync(join(directory, 'keyring.json')), false);
  await store.set(ref, 'first');
  assert.equal(await store.get(ref), 'first');
});

test('record names and owner subjects may contain ordinary non-secret text without being confused with storage namespaces', async (t) => {
  const { store } = await fixture(t);
  const key = 'heluo-forge/iam/record/ref/record';
  const value = JSON.stringify({ kind: 'grant', payload: { subject: 'employee|123' } });
  await store.set(key, value);
  assert.equal(await store.get(key), value);
});

test('a failed rotation after writing a key can be resumed with the same kid', async (t) => {
  const { directory, store } = await fixture(t);
  await store.set(ref, 'first');
  const { createFileKeyProvider } = await import('../src/keyring.mjs');
  createFileKeyProvider({ path: join(directory, 'keyring.json') }).add('k2');
  await store.rotate('k2');
  await store.set(ref, 'second');
  assert.equal(await store.get(ref), 'second');
});

test('rotation never activates a key while directory durability fails, including on retry', { skip: process.platform === 'win32' }, async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { directory } = await fixture(t);
  const moduleUrl = new URL('../src/credential-store.mjs', import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { createCredentialStore } from ${JSON.stringify(moduleUrl)};
    const store = createCredentialStore({ directory: process.argv[1] });
    await store.set(${JSON.stringify(ref)}, 'first');
    const original = fs.fsyncSync;
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' });
      return original(fd);
    };
    syncBuiltinESMExports();
    for (let i = 0; i < 2; i++) {
      await assert.rejects(store.rotate('k2'), (error) => error.code === 'CRED_KEY_DURABILITY');
      const db = new DatabaseSync(join(process.argv[1], 'credentials.sqlite'), { readOnly: true });
      assert.equal(db.prepare("SELECT value FROM meta WHERE key='active'").get().value, 'k1');
      db.close();
    }
    fs.fsyncSync = original;
    syncBuiltinESMExports();
    await store.rotate('k2');
    await store.set(${JSON.stringify(ref)}, 'second');
    assert.equal(await store.get(${JSON.stringify(ref)}), 'second');
    await store.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, directory], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});

test('an interrupted metadata switch keeps the database key authoritative until rotation resumes', async (t) => {
  const { directory, store } = await fixture(t);
  await store.set(ref, 'first');
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_activation BEFORE UPDATE ON meta WHEN new.key = 'active' BEGIN SELECT RAISE(ABORT, 'synthetic activation failure'); END");
    await assert.rejects(store.rotate('k2'));
    assert.equal(JSON.parse(readFileSync(join(directory, 'keyring.json'), 'utf8')).active, 'k2');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='active'").get().value, 'k1');
    assert.equal(await store.get(ref), 'first');
    await store.set(ref, 'still-old-key');
    db.exec('DROP TRIGGER fail_activation');
    await store.rotate('k2');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='active'").get().value, 'k2');
    assert.equal(await store.get(ref), 'still-old-key');
  } finally {
    db.close();
  }
});

test('rotation changes only future writes while older kid remains readable', async (t) => {
  const { store } = await fixture(t);
  await store.set(ref, 'first');
  await store.rotate('k2');
  assert.equal(await store.get(ref), 'first');
  await store.set(recordKey, JSON.stringify(record));
  assert.equal(await store.get(recordKey), JSON.stringify(record));
});

test('removing an old key after rotation leaves new-key values readable across restart', async (t) => {
  const { directory, store } = await fixture(t);
  await store.set(ref, 'old-key-value');
  await store.rotate('k2');
  await store.set(recordKey, JSON.stringify(record));
  await store.close();
  const keyPath = join(directory, 'keyring.json');
  const keyring = JSON.parse(readFileSync(keyPath, 'utf8'));
  delete keyring.keys.k1;
  writeFileSync(keyPath, JSON.stringify(keyring));
  const reopened = createCredentialStore({ directory });
  t.after(() => reopened.close());
  assert.equal(await reopened.get(recordKey), JSON.stringify(record));
  await assert.rejects(reopened.get(ref), (error) => error.code === 'CRED_KEY_UNAVAILABLE');
});

test('dead process lock is recovered without claiming its unfinished mutation succeeded', async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { directory, store } = await fixture(t, { lockTimeoutMs: 2000 });
  await store.set(ref, 'committed');
  const moduleUrl = new URL('../src/credential-store.mjs', import.meta.url).href;
  const source = `import { createCredentialStore } from ${JSON.stringify(moduleUrl)};
    const store = createCredentialStore({directory: process.argv[1]});
    await store.transaction(${JSON.stringify(ref)}, async (tx) => {
      tx.set('not-committed'); process.send('locked'); await new Promise(() => {});
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.equal((await once(child, 'message'))[0], 'locked');
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(await store.get(ref), 'committed');
  await store.set(ref, 'recovered');
  assert.equal(await store.get(ref), 'recovered');
});

test('live or malformed persistent locks time out without being stolen', async (t) => {
  const { directory, store } = await fixture(t, { lockTimeoutMs: 30 });
  await store.set(ref, 'original');
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const lock = db.prepare("INSERT INTO meta(key,value) VALUES('lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const value of [JSON.stringify({ pid: process.pid, token: 'a'.repeat(32) }), '{broken']) {
    lock.run(value);
    await assert.rejects(store.set(ref, 'changed'), (error) => error.code === 'CRED_LOCK_TIMEOUT');
    assert.equal(await store.get(ref), 'original');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='lock'").get().value, value);
  }
  db.prepare("DELETE FROM meta WHERE key='lock'").run();
  db.close();
});

test('missing keyring after database creation never causes regeneration', async (t) => {
  const { unlinkSync } = await import('node:fs');
  const { directory, store } = await fixture(t);
  await store.set(ref, marker);
  await store.close();
  const keyPath = join(directory, 'keyring.json');
  unlinkSync(keyPath);
  const replacement = createCredentialStore({ directory });
  await assert.rejects(replacement.get(ref), (error) => error.code === 'CRED_KEY_UNAVAILABLE');
  assert.equal(existsSync(keyPath), false);
  await replacement.close();
});

test('POSIX rejects unsafe directory and database modes without repairing them', { skip: process.platform === 'win32' }, async (t) => {
  const { chmodSync, statSync } = await import('node:fs');
  const { directory, store } = await fixture(t);
  await store.set(ref, 'original');
  await store.close();
  const path = join(directory, 'credentials.sqlite');
  chmodSync(path, 0o644);
  const unsafeFile = createCredentialStore({ directory });
  await assert.rejects(unsafeFile.get(ref), (error) => error.code === 'CRED_STORE_PERMISSIONS');
  assert.equal(statSync(path).mode & 0o777, 0o644);
  await unsafeFile.close();
  chmodSync(path, 0o600);
  chmodSync(directory, 0o755);
  const unsafeDir = createCredentialStore({ directory });
  await assert.rejects(unsafeDir.get(ref), (error) => error.code === 'CRED_STORE_PERMISSIONS');
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  await unsafeDir.close();
});
