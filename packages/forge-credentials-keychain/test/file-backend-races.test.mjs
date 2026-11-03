import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBackend } from '../src/backend.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tempFile(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-keychain-races-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return join(directory, 'credentials.json');
}

test('a late unlocked read cannot restore a deleted credential during a write', async (t) => {
  const path = await tempFile(t);
  const backend = createFileBackend({ path });
  const other = createFileBackend({ path });
  await backend.set('deleted', 'old-placeholder');
  await backend.set('kept', 'kept-placeholder');

  const context = new AsyncLocalStorage();
  const staleRead = deferred();
  const allowStaleRead = deferred();
  const freshWrite = deferred();
  const allowFreshWrite = deferred();
  const originalRead = fs.readFile;
  const mockedRead = t.mock.method(fs, 'readFile', async function (file, ...args) {
    const captured = await originalRead.call(this, file, ...args);
    if (file === path && context.getStore() === 'stale-read') {
      staleRead.resolve();
      await allowStaleRead.promise;
    } else if (file === path && context.getStore() === 'fresh-write') {
      freshWrite.resolve();
      await allowFreshWrite.promise;
    }
    return captured;
  });
  syncBuiltinESMExports();

  let reading;
  let writing;
  try {
    reading = context.run('stale-read', () => backend.get('deleted'));
    await staleRead.promise;
    await other.delete('deleted');
    assert.equal(await other.get('deleted'), undefined);

    writing = context.run('fresh-write', () => backend.set('new', 'new-placeholder'));
    await freshWrite.promise;
    allowStaleRead.resolve();
    await reading;
    allowFreshWrite.resolve();
    await writing;
  } finally {
    allowStaleRead.resolve();
    allowFreshWrite.resolve();
    await Promise.allSettled([reading, writing]);
    mockedRead.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(await other.get('deleted'), undefined);
  assert.equal(await other.get('kept'), 'kept-placeholder');
  assert.equal(await other.get('new'), 'new-placeholder');
});

test('a lock whose owner cannot be identified is never taken over', async (t) => {
  const path = await tempFile(t);
  const backend = createFileBackend({ path, lockTimeoutMs: 120 });
  const lockPath = `${path}.lock`;
  // No pid means no way to prove the owner is gone: time out instead of guessing.
  const owner = 'not-a-pid:orphaned-placeholder';
  await fs.writeFile(lockPath, owner, { mode: 0o600 });
  await assert.rejects(
    () => backend.set('credential', 'placeholder'),
    (error) => error.code === 'KEYCHAIN_LOCK_TIMEOUT',
  );
  assert.equal(await fs.readFile(lockPath, 'utf8'), owner);
  await assert.rejects(fs.access(path), (error) => error.code === 'ENOENT');
});

test('a lock left by a dead process is reclaimed instead of blocking forever', async (t) => {
  const path = await tempFile(t);
  await fs.writeFile(`${path}.lock`, '999999:deadbeef', { mode: 0o600 });
  const backend = createFileBackend({ path, lockTimeoutMs: 2000 });
  await backend.set('recovered', 'value');
  assert.equal(await backend.get('recovered'), 'value');
  await assert.rejects(fs.access(`${path}.lock`), '正常完成写入后不应留下锁文件');
});

test('a lock held by a live process is never displaced', async (t) => {
  const path = await tempFile(t);
  await fs.writeFile(`${path}.lock`, `${process.pid}:alive`, { mode: 0o600 });
  const backend = createFileBackend({ path, lockTimeoutMs: 120 });
  await assert.rejects(
    () => backend.set('blocked', 'value'),
    (error) => error.code === 'KEYCHAIN_LOCK_TIMEOUT',
  );
  assert.equal(await fs.readFile(`${path}.lock`, 'utf8'), `${process.pid}:alive`);
});
