import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs, { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCredentialStore } from '../src/credential-store.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

const ref = 'heluo-forge/iam/ref/TEST';
const recordKey = 'heluo-forge/iam/record/heluo-iam/gateway-credential';

function ownDirectory(t, directory) {
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    while (cleanups.length) {
      try { await cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    await rm(directory, { recursive: true, force: true });
  });
  return (cleanup) => cleanups.push(cleanup);
}

async function fixture(t, lockTimeoutMs = 1000) {
  const root = await outsideRepositoryTmpAsync('forge-sqlite-read-contention-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const store = createCredentialStore({ directory, lockTimeoutMs });
  own(() => store.close());
  await store.set(ref, 'before');
  return { directory, store, own };
}

test('a read transaction delays a pending mutation without replaying its callback', async (t) => {
  const { directory, store, own } = await fixture(t);
  let enter;
  let release;
  let calls = 0;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mutation = store.transaction(ref, async (tx) => {
    calls += 1;
    enter();
    await gate;
    tx.set('after');
  });
  const mutationResult = mutation.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  own(async () => { release(); const result = await mutationResult; if (!result.ok) throw result.error; });
  await entered;
  const reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM secret').get();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    reader.exec('COMMIT');
    await mutation;
    assert.equal(calls, 1);
    assert.equal(await store.get(ref), 'after');
  } finally {
    release();
    reader.close();
    await mutation;
  }
});

test('a read after joint commit cannot turn success into failure or strand the lock', async (t) => {
  const { directory, store } = await fixture(t, 100);
  const scope = { recordKey, ref };
  const expected = await store.snapshot(scope);
  const next = { record: { kind: 'grant', payload: {} }, value: 'after' };
  let calls = 0;
  let reader;
  try {
    const result = await store.compareAndSwap(scope, expected, next, () => {
      calls += 1;
      queueMicrotask(() => {
        reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
        reader.exec('BEGIN');
        reader.prepare('SELECT count(*) FROM secret').get();
      });
      return true;
    });
    assert.deepEqual(result, { ok: true, snapshot: next });
    assert.equal(calls, 1);
    assert.ok(reader);
    reader.exec('COMMIT');
    reader.close();
    reader = undefined;
    await store.set(ref, 'later');
    assert.equal(await store.get(ref), 'later');
  } finally {
    reader?.close();
  }
});

test('a timed-out mutation leaves no live lock that prevents a later write', async (t) => {
  const { directory, store, own } = await fixture(t, 80);
  let enter;
  let release;
  let calls = 0;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mutation = store.transaction(ref, async (tx) => {
    calls += 1;
    enter();
    await gate;
    tx.set('not-committed');
  }).then(() => undefined, (error) => error);
  own(async () => { release(); await mutation; });
  await entered;
  const reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM secret').get();
    release();
    const failure = await mutation;
    assert.equal(failure?.code, 'CRED_LOCK_TIMEOUT');
    assert.equal(calls, 1);
    reader.exec('COMMIT');
    await store.set(ref, 'later');
    assert.equal(await store.get(ref), 'later');
  } finally {
    release();
    reader.close();
    await mutation;
  }
});

test('an ordinary read waits for a short exclusive writer instead of reporting busy', async (t) => {
  const { directory, store } = await fixture(t);
  const writer = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try {
    writer.exec('BEGIN EXCLUSIVE');
    const read = store.get(ref).then((value) => ({ value }), (error) => ({ error }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    writer.exec('COMMIT');
    const result = await read;
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.value, 'before');
  } finally {
    writer.close();
  }
});

test('an already open joint store waits for a short exclusive writer before committing', async (t) => {
  const { directory, store } = await fixture(t);
  const scope = { recordKey, ref };
  const expected = await store.snapshot(scope);
  const next = { record: { kind: 'grant', payload: {} }, value: 'after' };
  let guardCalls = 0;
  const writer = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try {
    writer.exec('BEGIN EXCLUSIVE');
    const write = store.compareAndSwap(scope, expected, next, () => { guardCalls += 1; return true; })
      .then((result) => ({ result }), (error) => ({ error }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(guardCalls, 0);
    writer.exec('COMMIT');
    const outcome = await write;
    assert.equal(outcome.error, undefined, outcome.error?.stack);
    assert.deepEqual(outcome.result, { ok: true, snapshot: next });
    assert.equal(guardCalls, 1);
    assert.deepEqual(await store.snapshot(scope), next);
  } finally {
    writer.close();
  }
});

test('an already open joint store times out without committing under a persistent exclusive writer', async (t) => {
  const { directory, store } = await fixture(t, 80);
  const scope = { recordKey, ref };
  const expected = await store.snapshot(scope);
  let guardCalls = 0;
  const writer = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try {
    writer.exec('BEGIN EXCLUSIVE');
    await assert.rejects(store.compareAndSwap(scope, expected, { record: undefined, value: 'after' }, () => {
      guardCalls += 1;
      return true;
    }), { code: 'CRED_LOCK_TIMEOUT' });
    assert.equal(guardCalls, 0);
    writer.exec('COMMIT');
    assert.deepEqual(await store.snapshot(scope), expected);
  } finally {
    writer.close();
  }
});

test('close drains an accepted read while it waits for an exclusive writer', async (t) => {
  const { directory, store } = await fixture(t);
  const writer = new DatabaseSync(join(directory, 'credentials.sqlite'));
  let closing;
  let read;
  try {
    writer.exec('BEGIN EXCLUSIVE');
    read = store.get(ref).then((value) => ({ value }), (error) => ({ error }));
    closing = store.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    writer.exec('COMMIT');
    const result = await read;
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.value, 'before');
    await closing;
  } finally {
    writer.close();
    if (read) await read;
    if (closing) await closing;
  }
});

test('close preserves the timeout of an accepted read under persistent contention', async (t) => {
  const { directory, store } = await fixture(t, 80);
  const writer = new DatabaseSync(join(directory, 'credentials.sqlite'));
  let closing;
  try {
    writer.exec('BEGIN EXCLUSIVE');
    const read = store.get(ref).then(() => undefined, (error) => error);
    closing = store.close();
    assert.equal((await read)?.code, 'CRED_LOCK_TIMEOUT');
    await closing;
  } finally {
    writer.close();
    if (closing) await closing;
  }
});

test('another process reclaims a finished live owner after a read blocks release', { timeout: 5000 }, async (t) => {
  const { directory, store, own } = await fixture(t, 1000);
  const moduleUrl = new URL('../src/credential-store.mjs', import.meta.url).href;
  const source = `import { createCredentialStore } from ${JSON.stringify(moduleUrl)};
const store = createCredentialStore({ directory: process.argv[1], lockTimeoutMs: 80 });
try {
  await store.transaction(${JSON.stringify(ref)}, async (tx) => {
    process.send('entered');
    await new Promise((resolve) => process.once('message', resolve));
    tx.set('not-committed');
  });
  process.send({ result: 'unexpected success' });
} catch (error) { process.send({ code: error?.code }); }
await new Promise((resolve) => process.once('message', resolve));
await store.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], {
    env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = once(child, 'close').then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  own(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const result = await closed;
    if (!result.ok) throw result.error;
  });
  const exit = once(child, 'exit').then(([code]) => ({ ok: true, code }), (error) => ({ ok: false, error }));
  assert.equal((await once(child, 'message', { signal: AbortSignal.timeout(3000) }))[0], 'entered');
  const reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
  try {
    reader.exec('BEGIN');
    const lock = JSON.parse(reader.prepare("SELECT value FROM meta WHERE key='lock'").get().value);
    const failure = once(child, 'message', { signal: AbortSignal.timeout(3000) });
    child.send('continue');
    assert.deepEqual((await failure)[0], { code: 'CRED_LOCK_TIMEOUT' });
    assert.equal(child.exitCode, null);
    const name = `credentials.sqlite.abandoned.${lock.pid}.${lock.token}`;
    const markerPath = join(directory, name);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(marker.pid, child.pid);
    assert.equal(createHash('sha256').update(marker.token).digest('hex').slice(0, 32), lock.token);
    if (process.platform !== 'win32') assert.equal(statSync(markerPath).mode & 0o777, 0o600);
    reader.exec('COMMIT');
    await store.set(ref, 'recovered');
    assert.equal(await store.get(ref), 'recovered');
    assert.equal(readdirSync(directory).includes(name), false);
    child.send('stop');
    const result = await exit;
    if (!result.ok) throw result.error;
    assert.equal(result.code, 0);
  } finally {
    reader.close();
  }
});

test('checking a completion marker does not hold a SQLite write transaction', async (t) => {
  const { directory, store } = await fixture(t);
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const token = 'a'.repeat(32);
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 32);
  const markerName = `credentials.sqlite.abandoned.${process.pid}.${digest}`;
  const marker = join(directory, markerName);
  const originalLstat = fs.lstatSync;
  let observed;
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.prepare("INSERT INTO meta(key,value) VALUES('lock',?)").run(JSON.stringify({ pid: process.pid, token: digest }));
    writeFileSync(marker, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    fs.lstatSync = (...args) => {
      if (args[0] === marker && observed === undefined) {
        try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); observed = 'available'; }
        catch (error) { observed = error.errcode; }
      }
      return originalLstat(...args);
    };
    syncBuiltinESMExports();
    await store.set(ref, 'recovered');
    assert.equal(observed, 'available');
    assert.equal(await store.get(ref), 'recovered');
    assert.equal(readdirSync(directory).includes(markerName), false);
  } finally {
    fs.lstatSync = originalLstat;
    syncBuiltinESMExports();
    db.close();
  }
});

test('a changed lock is not reclaimed using an earlier completion marker', async (t) => {
  const { directory, store } = await fixture(t, 60);
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const token = 'a'.repeat(32);
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 32);
  const marker = join(directory, `credentials.sqlite.abandoned.${process.pid}.${digest}`);
  const replacement = JSON.stringify({ pid: process.pid, token: 'b'.repeat(32) });
  const originalLstat = fs.lstatSync;
  let replaced = false;
  let calls = 0;
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.prepare("INSERT INTO meta(key,value) VALUES('lock',?)").run(JSON.stringify({ pid: process.pid, token: digest }));
    writeFileSync(marker, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    fs.lstatSync = (...args) => {
      if (args[0] === marker && !replaced) {
        try { db.prepare("UPDATE meta SET value=? WHERE key='lock'").run(replacement); replaced = true; }
        catch { /* The assertion below reports whether another writer could run. */ }
      }
      return originalLstat(...args);
    };
    syncBuiltinESMExports();
    const result = store.transaction(ref, (tx) => { calls += 1; tx.set('intruder'); });
    await assert.rejects(result, { code: 'CRED_LOCK_TIMEOUT' });
    assert.equal(replaced, true);
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='lock'").get().value, replacement);
    assert.equal(await store.get(ref), 'before');
  } finally {
    fs.lstatSync = originalLstat;
    syncBuiltinESMExports();
    db.close();
  }
});

test('forged and stale markers do not steal a live operation', async (t) => {
  const { directory, store, own } = await fixture(t, 60);
  const other = createCredentialStore({ directory, lockTimeoutMs: 60 });
  own(() => other.close());
  let enter;
  let release;
  let calls = 0;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mutation = store.transaction(ref, async (tx) => {
    calls += 1;
    enter();
    await gate;
    tx.set('owner');
  });
  const mutationResult = mutation.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  own(async () => { release(); const result = await mutationResult; if (!result.ok) throw result.error; });
  await entered;
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'));
  let lock;
  try { lock = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='lock'").get().value); }
  finally { db.close(); }
  const markerPath = join(directory, `credentials.sqlite.abandoned.${lock.pid}.${lock.token}`);
  const staleToken = 'a'.repeat(32);
  const staleDigest = createHash('sha256').update(staleToken).digest('hex').slice(0, 32);
  const stalePath = join(directory, `credentials.sqlite.abandoned.${lock.pid}.${staleDigest}`);
  try {
    writeFileSync(stalePath, JSON.stringify({ pid: lock.pid, token: staleToken }), { mode: 0o600 });
    for (const marker of [
      { pid: lock.pid + 1, token: lock.token },
      { pid: lock.pid, token: lock.token },
      { pid: lock.pid, token: staleToken },
    ]) {
      writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
      await assert.rejects(other.set(ref, 'intruder'), { code: 'CRED_LOCK_TIMEOUT' });
      unlinkSync(markerPath);
    }
    assert.equal(calls, 1);
    release();
    await mutation;
    assert.equal(await store.get(ref), 'owner');
    await other.set(ref, 'later');
    assert.equal(await other.get(ref), 'later');
  } finally {
    release();
    await mutation;
  }
});

test('failure to publish a completion marker leaves the live lock fail closed', async (t) => {
  const { directory, store, own } = await fixture(t, 60);
  const other = createCredentialStore({ directory, lockTimeoutMs: 60 });
  own(() => other.close());
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mutation = store.transaction(ref, async (tx) => { enter(); await gate; tx.set('not-committed'); })
    .then(() => undefined, (error) => error);
  own(async () => { release(); await mutation; });
  await entered;
  const reader = new DatabaseSync(join(directory, 'credentials.sqlite'));
  const originalLink = fs.linkSync;
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM secret').get();
    fs.linkSync = (from, to) => {
      if (String(to).includes('credentials.sqlite.abandoned.')) throw Object.assign(new Error('synthetic failure'), { code: 'EACCES' });
      return originalLink(from, to);
    };
    syncBuiltinESMExports();
    release();
    assert.equal((await mutation)?.code, 'CRED_LOCK_RECOVERY_FAILED');
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    reader.exec('COMMIT');
    await assert.rejects(other.set(ref, 'intruder'), { code: 'CRED_LOCK_TIMEOUT' });
    assert.equal(await other.get(ref), 'before');
    assert.equal(readdirSync(directory).some((name) => name.includes('.abandoned.')), false);
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    release();
    reader.close();
    await mutation;
  }
});
