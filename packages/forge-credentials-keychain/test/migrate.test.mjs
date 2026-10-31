import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFileBackend, createMemoryBackend, createUnavailableBackend } from '../src/backend.mjs';
import { isMigratableKey, KeychainMigrationError, migrateLegacyFileToKeychain, redactSecrets } from '../src/migrate.mjs';

async function fixture(t, entries) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-migrate-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.json');
  const raw = JSON.stringify({ version: 1, entries });
  await writeFile(path, raw, { mode: 0o600 });
  return { dir, path, raw };
}

function assertClosed(result) {
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'target-atomic-unavailable');
  assert.equal(result.legacyDeleted, false);
  assert.equal(result.legacyRetained, null, '旧文件可能被其他进程修改或删除，不能断言存在');
  assert.equal(result.plaintextWritten, false);
  assert.deepEqual(result.migratedKeys, []);
  assert.deepEqual(result.skippedKeys, []);
}

test('混合命名空间内容和权限不被修改', async (t) => {
  const { path, raw } = await fixture(t, {
    'heluo-forge/iam/record/session': 'placeholder',
    'other-app/record/session': 'other-placeholder',
  });
  await chmod(path, 0o640);
  assertClosed(await migrateLegacyFileToKeychain({ legacyPath: path, backend: createMemoryBackend() }));
  assert.equal(await readFile(path, 'utf8'), raw);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});

test('未经验证的事务不访问目标或删除器', async (t) => {
  const { path, raw } = await fixture(t, { 'heluo-forge/iam/record/session': 'placeholder' });
  let accessed = 0;
  const fail = async () => { accessed += 1; throw new Error('must not call'); };
  const backend = { get: fail, set: fail, transaction: fail };
  const result = await migrateLegacyFileToKeychain({ legacyPath: path, backend, removeLegacy: fail });
  assertClosed(result);
  assert.equal(accessed, 0);
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('注入读取器和删除器均不调用，错误和用户键中的秘密不输出', async (t) => {
  const secret = 'CANARY-INNER-SECRET';
  const { path, raw } = await fixture(t, { [`heluo-forge/iam/record/${secret}`]: JSON.stringify({ secret }) });
  let accessed = 0;
  const fail = async () => { accessed += 1; throw new Error(secret); };
  const backend = { get: fail, set: fail, transaction: fail };
  const result = await migrateLegacyFileToKeychain({ legacyPath: path, backend, readLegacy: fail, removeLegacy: fail });
  assertClosed(result);
  assert.equal(accessed, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('目标文件为旧文件或其符号链接时拒绝访问目标', async (t) => {
  const { dir, path, raw } = await fixture(t, { 'heluo-forge/iam/record/session': 'placeholder' });
  const alias = join(dir, 'alias.json');
  await symlink(path, alias);
  for (const target of [path, alias, join(dir, 'not-yet-created.json')]) {
    assertClosed(await migrateLegacyFileToKeychain({ legacyPath: path, backend: createFileBackend({ path: target }) }));
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.deepEqual((await readdir(dir)).sort(), ['alias.json', 'legacy.json']);
  }
});

test('缺失旧文件不会被报告为已确认保留', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-migrate-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await migrateLegacyFileToKeychain({ legacyPath: join(dir, 'missing.json'), backend: createMemoryBackend() });
  assertClosed(result);
  assert.deepEqual(await readdir(dir), []);
});

test('不可用目标在不访问旧文件时如实报告', async (t) => {
  const { path, raw } = await fixture(t, { 'heluo-forge/iam/record/session': 'placeholder' });
  const result = await migrateLegacyFileToKeychain({ legacyPath: path, backend: createUnavailableBackend() });
  assert.equal(result.reason, 'keychain-unavailable');
  assert.equal(result.legacyDeleted, false);
  assert.equal(result.legacyRetained, null);
  assert.equal(result.plaintextWritten, false);
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('非法输入、命名空间匹配与脱敏工具维持既有契约', async () => {
  await assert.rejects(() => migrateLegacyFileToKeychain(null), (error) => error instanceof KeychainMigrationError);
  await assert.rejects(() => migrateLegacyFileToKeychain({ backend: createMemoryBackend() }), (error) => error.code === 'KEYCHAIN_MIGRATION_INVALID');
  await assert.rejects(() => migrateLegacyFileToKeychain({ legacyPath: '/x' }), (error) => error.code === 'KEYCHAIN_MIGRATION_INVALID');
  assert.equal(isMigratableKey('heluo-forge/iam/record/session', 'heluo-forge/iam'), true);
  assert.equal(isMigratableKey('heluo-forge/gateway/record/session', 'heluo-forge/iam'), false);
  assert.equal(isMigratableKey(42, 'heluo-forge/iam'), false);
  assert.equal(redactSecrets('oops placeholder', ['placeholder']), 'oops [redacted]');
});
