import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createCredentialStore } from '../src/credential-store.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

test('database, WAL and SHM exist and contain no credential plaintext in WAL mode', async (t) => {
  const root = await outsideRepositoryTmpAsync('forge-wal-scan-');
  const directory = join(root, 'data');
  const database = join(directory, 'credentials.sqlite');
  let store;
  let observer;
  t.after(async () => {
    await store?.close();
    observer?.close();
    await rm(root, { recursive: true, force: true });
  });

  store = createCredentialStore({ directory });
  await store.set('heluo-forge/iam/ref/SEED', 'synthetic-initial-value');
  await store.close();
  store = undefined;

  // Hold a second connection open so SQLite cannot remove the WAL and SHM
  // before their actual bytes have been inspected.
  observer = new DatabaseSync(database);
  assert.equal(observer.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
  store = createCredentialStore({ directory });
  const refMarker = 'synthetic-wal-secret-marker-xxxx';
  const recordMarker = 'synthetic-record-secret-marker-b';
  assert.equal(Buffer.byteLength(refMarker), 32);
  assert.equal(Buffer.byteLength(recordMarker), 32);
  await store.set('heluo-forge/iam/ref/TEST', refMarker);
  await store.set('heluo-forge/iam/record/heluo-iam/session', JSON.stringify({
    kind: 'grant', payload: { subject: 'E1001', accessToken: recordMarker },
  }));

  for (const name of ['credentials.sqlite', 'credentials.sqlite-wal', 'credentials.sqlite-shm']) {
    const path = join(directory, name);
    assert.equal(existsSync(path), true, `${name} must exist for the scan`);
    const contents = readFileSync(path);
    assert.equal(contents.includes(refMarker), false, `${name} contains the synthetic reference value`);
    assert.equal(contents.includes(recordMarker), false, `${name} contains the synthetic record value`);
  }
});
