import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryBackend, createUnavailableBackend } from '../src/backend.mjs';
import { isMigratableKey, KeychainMigrationError, migrateLegacyFileToKeychain, redactSecrets } from '../src/migrate.mjs';

const SECRET = 'canary-legacy-refresh-token-9f3a';
const legacyEntries = {
  'heluo-forge/iam/record/session': JSON.stringify({ version: 1, payload: { refreshToken: SECRET } }),
  'heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY': SECRET,
  'other-app/record/session': 'not-ours',
};
const options = (overrides = {}) => ({
  legacyPath: '/tmp/does-not-matter.json',
  backend: createMemoryBackend(),
  readLegacy: async () => ({ ok: true, entries: legacyEntries }),
  removeLegacy: async () => {},
  ...overrides,
});

test('旧记录全部回读一致后才删除旧文件', async () => {
  const order = [];
  const backend = createMemoryBackend();
  const set = backend.set.bind(backend);
  backend.set = async (key, value) => {
    order.push(`set:${key}`);
    return set(key, value);
  };
  const result = await migrateLegacyFileToKeychain(
    options({
      backend,
      removeLegacy: async () => order.push('remove-legacy'),
    }),
  );
  assert.equal(result.migrated, true);
  assert.equal(result.legacyDeleted, true);
  assert.equal(result.plaintextWritten, false);
  assert.deepEqual([...result.migratedKeys], ['heluo-forge/iam/record/session', 'heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY']);
  assert.deepEqual(order, [
    'set:heluo-forge/iam/record/session',
    'set:heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY',
    'remove-legacy',
  ]);
  assert.equal(await backend.get('heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY'), SECRET);
  assert.equal(await backend.get('other-app/record/session'), undefined, '不属于本命名空间的条目不动');
});

test('keychain 不可用时 fail closed：不迁移、不删旧文件、不写明文', async () => {
  let removed = false;
  const result = await migrateLegacyFileToKeychain(
    options({
      backend: createUnavailableBackend('adapter missing'),
      removeLegacy: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'keychain-unavailable');
  assert.equal(result.legacyRetained, true);
  assert.equal(result.plaintextWritten, false);
  assert.equal(removed, false, '旧文件不得被删除');
});

test('回读不一致立即停止且保留旧文件', async () => {
  const backend = createMemoryBackend();
  const set = backend.set.bind(backend);
  backend.set = async (key, value) => {
    await set(key, 'tampered');
  };
  let removed = false;
  const result = await migrateLegacyFileToKeychain(
    options({
      backend,
      removeLegacy: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'read-back-mismatch');
  assert.equal(result.legacyRetained, true);
  assert.equal(removed, false);
});

test('目标已有不同值时不覆盖', async () => {
  const backend = createMemoryBackend({ 'heluo-forge/iam/record/session': 'someone-elses-record' });
  const result = await migrateLegacyFileToKeychain(options({ backend }));
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'target-conflict');
  assert.equal(await backend.get('heluo-forge/iam/record/session'), 'someone-elses-record');
});

test('目标已有同值时为幂等跳过，仍可完成迁移', async () => {
  const backend = createMemoryBackend({ 'heluo-forge/iam/record/session': legacyEntries['heluo-forge/iam/record/session'] });
  const result = await migrateLegacyFileToKeychain(options({ backend }));
  assert.equal(result.migrated, true);
  assert.deepEqual([...result.skippedKeys], ['heluo-forge/iam/record/session']);
  assert.deepEqual([...result.migratedKeys], ['heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY']);
});

test('写入失败、旧文件删除失败、旧文件不可读分别如实报告', async () => {
  const failing = createMemoryBackend();
  failing.set = async () => {
    throw new Error('keychain locked');
  };
  const writeFailed = await migrateLegacyFileToKeychain(options({ backend: failing }));
  assert.equal(writeFailed.reason, 'keychain-write-failed');
  assert.equal(writeFailed.legacyRetained, true);

  const deleteFailed = await migrateLegacyFileToKeychain(
    options({
      removeLegacy: async () => {
        throw new Error('EPERM');
      },
    }),
  );
  assert.equal(deleteFailed.migrated, true);
  assert.equal(deleteFailed.legacyDeleted, false);
  assert.equal(deleteFailed.reason, 'legacy-delete-failed');
  assert.match(deleteFailed.notes.join(' '), /不谎报已清理/);

  const unreadable = await migrateLegacyFileToKeychain(options({ readLegacy: async () => ({ ok: false, reason: 'legacy-unreadable' }) }));
  assert.equal(unreadable.reason, 'legacy-unreadable');
  assert.equal(unreadable.legacyRetained, true);
});

test('没有本命名空间条目时不动旧文件', async () => {
  const result = await migrateLegacyFileToKeychain(options({ readLegacy: async () => ({ ok: true, entries: { 'other/record/x': 'y' } }) }));
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'nothing-to-migrate');
  assert.equal(result.legacyRetained, true);
});

test('结果与消息里不出现秘密值', async () => {
  const result = await migrateLegacyFileToKeychain(
    options({
      removeLegacy: async () => {
        throw new Error(`cannot delete file holding ${SECRET}`);
      },
    }),
  );
  const text = JSON.stringify(result);
  assert.equal(text.includes(SECRET), false, '结果里不得出现秘密值');
  assert.match(text, /\[redacted\]/);
  assert.equal(redactSecrets(`oops ${SECRET}`, [SECRET]).includes(SECRET), false);
});

test('非法输入直接报错', async () => {
  await assert.rejects(() => migrateLegacyFileToKeychain(null), (error) => error instanceof KeychainMigrationError);
  await assert.rejects(() => migrateLegacyFileToKeychain({ backend: createMemoryBackend() }), (error) => error.code === 'KEYCHAIN_MIGRATION_INVALID');
  await assert.rejects(() => migrateLegacyFileToKeychain({ legacyPath: '/x' }), (error) => error.code === 'KEYCHAIN_MIGRATION_INVALID');
  assert.equal(isMigratableKey('heluo-forge/iam/record/session', 'heluo-forge/iam'), true);
  assert.equal(isMigratableKey('heluo-forge/gateway/record/session', 'heluo-forge/iam'), false);
  assert.equal(isMigratableKey(42, 'heluo-forge/iam'), false);
});

test('默认读取器/删除器直接操作真实 0600 文件', async () => {
  const { mkdtempSync, statSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createFileBackend } = await import('../src/backend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'forge-migrate-test-'));
  const path = join(dir, 'legacy.json');
  const file = createFileBackend({ path });
  await file.set('heluo-forge/iam/record/session', SECRET);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const backend = createMemoryBackend();
  const result = await migrateLegacyFileToKeychain({ legacyPath: path, backend });
  assert.equal(result.migrated, true);
  assert.equal(result.legacyDeleted, true);
  assert.equal(existsSync(path), false, '旧文件已删除');
  assert.equal(await backend.get('heluo-forge/iam/record/session'), SECRET);
});

test('后端读取抛错时按写入失败/回读不一致报告，不删旧文件', async () => {
  const failingGet = createMemoryBackend();
  failingGet.get = async () => {
    throw new Error('keychain query failed');
  };
  const failedRead = await migrateLegacyFileToKeychain(options({ backend: failingGet }));
  assert.equal(failedRead.reason, 'keychain-write-failed');
  assert.equal(failedRead.legacyRetained, true);

  const backend = createMemoryBackend();
  const set = backend.set.bind(backend);
  const get = backend.get.bind(backend);
  let gets = 0;
  backend.set = set;
  backend.get = async (key) => {
    gets += 1;
    if (gets > 1) throw new Error('read-back exploded');
    return get(key);
  };
  const readBackThrew = await migrateLegacyFileToKeychain(options({ backend }));
  assert.equal(readBackThrew.reason, 'read-back-mismatch');
  assert.equal(readBackThrew.legacyRetained, true);
});
