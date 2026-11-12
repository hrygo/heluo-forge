import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMemoryBackend } from '../src/backend.mjs';
import { createCredentialStore } from '../src/credential-store.mjs';
import { createKeychainProvider } from '../src/provider.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

async function sqlite(t) {
  const root = await outsideRepositoryTmpAsync('forge-provider-contract-');
  const directory = join(root, 'data');
  const backend = createCredentialStore({ directory });
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  return { backend, directory };
}

for (const [name, create] of [
  ['memory', async () => ({ backend: createMemoryBackend() })],
  ['sqlite', sqlite],
]) {
  test(`${name}: the provider round-trips opaque JSON grant payloads`, async (t) => {
    const { backend } = await create(t);
    const provider = createKeychainProvider(backend);
    for (const payload of [null, 42, 'text', [1, 'two'], { subject: 123 },
      { subject: false, ownerSubject: 'owner-2' }, { subject: { value: 'opaque' } },
      { subject: '\ud800' }]) {
      const expected = { kind: 'grant', payload };
      assert.deepEqual(await provider.modifyRecord('generic/session', () => expected), expected);
      assert.deepEqual(await provider.readRecord('generic/session'), expected);
    }
  });

  test(`${name}: rejected provider records and keys do not alter a previous record`, async (t) => {
    const { backend } = await create(t);
    const provider = createKeychainProvider(backend);
    const original = { kind: 'grant', payload: { subject: 'owner-1', token: 'synthetic-secret' } };
    await provider.modifyRecord('generic/session', () => original);
    for (const invalid of [{ kind: 'grant' }, { kind: 'api-key', key: '' }, { kind: 'unknown' }]) {
      await assert.rejects(provider.modifyRecord('generic/session', () => invalid), { code: 'KEYCHAIN_RECORD_INVALID' });
      assert.deepEqual(await provider.readRecord('generic/session'), original);
    }
    await assert.rejects(provider.modifyRecord('invalid', () => original), { code: 'KEYCHAIN_KEY_INVALID' });
    assert.deepEqual(await provider.readRecord('generic/session'), original);
  });

}

test('sqlite binds IAM owners in authenticated data without storing grant secrets in plaintext', async (t) => {
  const { backend, directory } = await sqlite(t);
  const provider = createKeychainProvider(backend);
  const recordKey = 'heluo-forge/iam/record/generic/session';
  const secret = 'synthetic-grant-secret-4815162342';
  const dbPath = join(directory, 'credentials.sqlite');
  await provider.modifyRecord('generic/session', () => ({ kind: 'grant', payload: { subject: 'owner-1', token: secret } }));
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare('SELECT owner FROM secret WHERE id = ?').get(recordKey).owner, 'owner-1');
    db.prepare('UPDATE secret SET owner = ? WHERE id = ?').run('owner-2', recordKey);
    await assert.rejects(provider.readRecord('generic/session'), { code: 'CRED_DECRYPT_FAILED' });
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) assert.equal(readFileSync(`${dbPath}${suffix}`).includes(Buffer.from(secret)), false);
    }
  } finally { db.close(); }
});

test('sqlite binds a string ownerSubject even when an opaque subject has another type', async (t) => {
  const { backend, directory } = await sqlite(t);
  const provider = createKeychainProvider(backend);
  await provider.modifyRecord('generic/session', () => ({ kind: 'grant', payload: { subject: 123, ownerSubject: 'owner-2' } }));
  const db = new DatabaseSync(join(directory, 'credentials.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT owner FROM secret').get().owner, 'owner-2'); }
  finally { db.close(); }
});

test('sqlite retains valid subject precedence and represents a malformed Unicode subject without an owner', async (t) => {
  const { backend, directory } = await sqlite(t);
  const provider = createKeychainProvider(backend);
  const cases = [
    [{ subject: 'owner-1', ownerSubject: 'owner-2' }, 'owner-1'],
    [{ subject: '', ownerSubject: 'owner-2' }, ''],
    [{ subject: '\ud800' }, ''],
    [{ subject: '\ud800', ownerSubject: 'owner-2' }, 'owner-2'],
  ];
  for (const [payload, owner] of cases) {
    const expected = { kind: 'grant', payload };
    await provider.modifyRecord('generic/session', () => expected);
    assert.deepEqual(await provider.readRecord('generic/session'), expected);
    const db = new DatabaseSync(join(directory, 'credentials.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT owner FROM secret').get().owner, owner); }
    finally { db.close(); }
  }
});
