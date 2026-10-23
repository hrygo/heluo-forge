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

test('an orphaned lock times out without unsafe automatic takeover', async (t) => {
  const path = await tempFile(t);
  const backend = createFileBackend({ path });
  const lockPath = `${path}.lock`;
  // A non-existent PID previously triggered an uncoordinated check/rename race.
  const owner = '2147483647:orphaned-placeholder';
  await fs.writeFile(lockPath, owner, { mode: 0o600 });
  let clock = 0;
  const mockedNow = t.mock.method(Date, 'now', () => clock++ === 0 ? 0 : 10001);
  try {
    await assert.rejects(
      backend.set('credential', 'placeholder'),
      (error) => error.code === 'KEYCHAIN_LOCK_TIMEOUT',
    );
  } finally {
    mockedNow.mock.restore();
  }
  assert.equal(await fs.readFile(lockPath, 'utf8'), owner);
  await assert.rejects(fs.access(path), (error) => error.code === 'ENOENT');
});
