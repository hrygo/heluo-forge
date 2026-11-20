import assert from 'node:assert/strict';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { apply, createCredentialStore, openCredentialReader, setIamClientSecret, validateConfig } from '../src/index.mjs';
import { createMemoryBackend } from '../src/backend.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

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

function context() {
  const provided = new Map();
  return {
    provided,
    get(name) { return provided.get(name); },
    provide(name, value) { provided.set(name, value); return () => provided.delete(name); },
    effect(callback) { return callback(); },
  };
}

test('plugin and read-only reader use the same namespace and durable store', async (t) => {
  const root = await outsideRepositoryTmpAsync('heluo-credentials-composition-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const ctx = context();
  const dispose = apply(ctx, { storeDirectory: directory });
  own(dispose);
  const credentials = ctx.provided.get('credentials');
  await credentials.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: { subject: 'E1001' } }));
  await credentials.set('ENTERPRISE_STATIC_KEY', 'synthetic-key');
  const reader = await openCredentialReader({ directory });
  own(() => reader.close());
  assert.deepEqual(await reader.readRecord('heluo-iam/session'), { kind: 'grant', payload: { subject: 'E1001' } });
  assert.deepEqual(await reader.resolve('ENTERPRISE_STATIC_KEY'), { value: 'synthetic-key', source: 'file' });
  assert.deepEqual(await credentials.describe('ENTERPRISE_STATIC_KEY'), { configured: true, source: 'file', writable: true });
  assert.equal(reader.set, undefined);
  assert.equal(ctx.provided.get('iam-atomic-store').verify(credentials), true);
  assert.equal(ctx.provided.get('iam-atomic-store').verify({}), false);
  await reader.close();
});

test('a provisioned IAM client secret is confined to its dedicated storage port', async (t) => {
  const root = await outsideRepositoryTmpAsync('heluo-iam-client-secret-isolation-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const namespace = { service: 'forge-fixture', accountPrefix: 'employee' };
  const options = { directory, ...namespace };
  const scope = { issuer: 'https://iam.corp.example', clientId: 'fixture', method: 'client_secret_basic', ref: 'oidc' };
  const recordKey = 'iam-client-secret/oidc';
  const prefix = 'forge-fixture/employee/record/';
  const id = `${prefix}${recordKey}`;
  const normalKey = 'iam-client-secret-notes/item';
  const normalRecord = { kind: 'grant', payload: { status: 'fixture' } };

  await setIamClientSecret(scope, 'synthetic-secret-for-isolation', options);
  const ctx = context();
  own(apply(ctx, { storeDirectory: directory, ...namespace }));
  const credentials = ctx.provided.get('credentials');
  const source = ctx.provided.get('iam-client-secret-source');
  const pinned = await source.read(scope);
  assert.equal(pinned?.value, 'synthetic-secret-for-isolation');
  await credentials.modifyRecord(normalKey, () => normalRecord);

  const reader = await openCredentialReader(options);
  own(() => reader.close());
  const backend = createCredentialStore({ directory });
  own(() => backend.close());
  const joint = ctx.provided.get('iam-atomic-store').adapter();
  const jointScope = { recordKey, ref: 'FIXTURE_REF' };

  await t.test('ordinary reads and listings exclude the reserved domain', async () => {
    assert.deepEqual(await credentials.readRecord(normalKey), normalRecord);
    assert.deepEqual(await reader.readRecord(normalKey), normalRecord);
    assert.deepEqual(await credentials.listRecords(), [{ key: normalKey, kind: 'grant' }]);
    await assert.rejects(credentials.describeRecord(recordKey), { code: 'KEYCHAIN_KEY_INVALID' });
    await assert.rejects(credentials.readRecord(recordKey), { code: 'KEYCHAIN_KEY_INVALID' });
    await assert.rejects(reader.readRecord(recordKey), { code: 'KEYCHAIN_KEY_INVALID' });
    await assert.rejects(joint.snapshot(jointScope), { code: 'KEYCHAIN_SCOPE_INVALID' });
  });

  await t.test('ordinary mutations and joint writes cannot change the dedicated record', async () => {
    let calls = 0;
    await assert.rejects(credentials.modifyRecord(recordKey, () => { calls += 1; }), { code: 'KEYCHAIN_KEY_INVALID' });
    await assert.rejects(credentials.deleteRecord(recordKey), { code: 'KEYCHAIN_KEY_INVALID' });
    await assert.rejects(joint.compareAndSwap(jointScope, {}, { record: normalRecord }, () => { calls += 1; return true; }),
      { code: 'KEYCHAIN_SCOPE_INVALID' });
    assert.equal(calls, 0);
    assert.equal(source.isCurrent(pinned), true);
  });

  await t.test('the exported backend excludes the reserved domain from generic operations', async () => {
    assert.equal(backend.iamClientSecrets, undefined);
    assert.deepEqual(await backend.list(prefix), [`${prefix}${normalKey}`]);
    assert.deepEqual(await backend.listEntries(prefix), [{ key: `${prefix}${normalKey}`, value: JSON.stringify(normalRecord) }]);
    await assert.rejects(backend.get(id), { code: 'CRED_STORE_INVALID' });
    await assert.rejects(backend.transaction(id, () => assert.fail('reserved mutator must not run')), { code: 'CRED_STORE_INVALID' });
    await assert.rejects(backend.set(id, JSON.stringify(normalRecord)), { code: 'CRED_STORE_INVALID' });
    await assert.rejects(backend.delete(id), { code: 'CRED_STORE_INVALID' });
    const storageScope = { recordKey: id, ref: 'forge-fixture/employee/ref/FIXTURE_REF' };
    await assert.rejects(backend.snapshot(storageScope), { code: 'CRED_STORE_INVALID' });
    await assert.rejects(backend.compareAndSwap(storageScope, {}, {}, () => true), { code: 'CRED_STORE_INVALID' });
    assert.equal(source.isCurrent(pinned), true);
  });

  await t.test('offline session reads reveal only whether the reserved record matches', async () => {
    const binding = { ...scope, revision: pinned.revision };
    const session = { kind: 'grant', payload: binding };
    await credentials.modifyRecord('heluo-iam/session', () => session);
    assert.deepEqual(await reader.readIamSession((record) => record.payload), { record: session, clientSecretCurrent: true });
    for (const change of [{ clientId: 'other-client' }, { method: 'client_secret_post' }, { ref: 'absent' }, { revision: 'old-revision' }]) {
      assert.deepEqual(await reader.readIamSession((record) => ({ ...record.payload, ...change })),
        { record: session, clientSecretCurrent: false });
    }
  });
});

test('a pinned IAM client secret is unavailable while its keyring cannot be read', async (t) => {
  const root = await outsideRepositoryTmpAsync('heluo-iam-client-secret-pin-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const scope = { issuer: 'https://iam.corp.example', clientId: 'fixture', method: 'client_secret_post', ref: 'fixture-oidc' };
  const provision = () => setIamClientSecret(scope, 'synthetic-secret', { directory });
  await provision();
  const ctx = context();
  own(apply(ctx, { storeDirectory: directory }));
  const source = ctx.provided.get('iam-client-secret-source');
  const pinned = await source.read(scope);
  assert.equal(source.isCurrent(pinned), true);

  const keyring = join(`${directory}.keys`, 'keyring.json');
  const savedKeyring = join(root, 'saved-keyring.json');
  await rename(keyring, savedKeyring);
  try {
    await assert.rejects(() => source.read(scope), { code: 'CRED_KEY_UNAVAILABLE' });
    assert.equal(source.isCurrent(pinned), false);
    await writeFile(keyring, '{', { mode: 0o600, flag: 'wx' });
    await assert.rejects(() => source.read(scope), { code: 'CRED_KEY_INVALID' });
    assert.equal(source.isCurrent(pinned), false);
  } finally {
    await rm(keyring, { force: true });
    await rename(savedKeyring, keyring);
  }

  assert.equal(source.isCurrent(pinned), true);
  assert.equal((await source.read(scope)).revision, pinned.revision);

  const store = createCredentialStore({ directory });
  try { await store.rotate('k2'); }
  finally { await store.close(); }
  const activeScope = { ...scope, ref: 'fixture-with-current-key' };
  await setIamClientSecret(activeScope, 'synthetic-secret', { directory });
  const activePin = await source.read(activeScope);
  const restoredKeyring = await readFile(keyring, 'utf8');
  const withoutOldKey = JSON.parse(restoredKeyring);
  delete withoutOldKey.keys.k1;
  await writeFile(keyring, JSON.stringify(withoutOldKey));
  try {
    assert.equal(source.isCurrent(activePin), true);
    await assert.rejects(() => source.read(scope), { code: 'CRED_KEY_UNAVAILABLE' });
    assert.equal(source.isCurrent(pinned), false);
  } finally {
    await writeFile(keyring, restoredKeyring);
  }
  assert.equal(source.isCurrent(pinned), true);

  await provision();
  assert.equal(source.isCurrent(pinned), false);
  const current = await source.read(scope);
  assert.notEqual(current.revision, pinned.revision);
  assert.equal(source.isCurrent(current), true);
});

test('a backend cannot grant itself trust by claiming atomic capabilities', async (t) => {
  const ctx = context();
  const backend = Object.assign(createMemoryBackend(), {
    durable: true,
    transaction: async () => {},
    snapshot: async () => ({}),
    compareAndSwap: async () => ({ ok: true }),
  });
  const dispose = apply(ctx, { backend, allowEphemeral: true });
  t.after(dispose);
  assert.equal(ctx.provided.has('iam-atomic-store'), false);
  await dispose();
});

test('legacy backend configuration is rejected instead of silently changing its meaning', () => {
  for (const config of [
    { filePath: '/tmp/legacy-test.json', allowInsecureFile: true },
    { platformAdapter: 'native-keyring', allowUnvettedPlatformAdapter: true },
  ]) assert.ok('issues' in validateConfig(config));
});

test('CLI reopens the same sqlite session in a fresh process without changing it', async (t) => {
  const root = await outsideRepositoryTmpAsync('heluo-cli-sqlite-');
  const directory = join(root, 'data');
  const own = ownDirectory(t, root);
  const ctx = context();
  const dispose = apply(ctx, { storeDirectory: directory });
  own(dispose);
  const credentials = ctx.provided.get('credentials');
  await credentials.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: {
    version: 1, sessionInstanceId: Buffer.alloc(32, 1).toString('base64url'),
    clientId: 'fixture', scope: 'openid', obtainedAt: '2026-01-01T00:00:00.000Z',
    subject: 'E1001', issuer: 'https://iam.corp.example', refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access-token', accessExpiresAt: '2099-01-01T00:00:00.000Z',
  } }));
  await dispose();
  const executable = fileURLToPath(new URL('../../forge-iam/bin/heluo-forge.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [executable, 'auth', 'token'], {
    encoding: 'utf8', env: { HELUO_FORGE_STORE_DIRECTORY: directory },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'synthetic-access-token\n');
});
