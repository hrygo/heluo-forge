// 旧 0600 明文记录 → 系统钥匙串的**迁移协调器**（#13 AC4）。
//
// 规则（fail closed，全部可离线注入验证）：
// 1. keychain backend 不可用 → 不迁移、不留新明文、不动旧文件，报 `keychain-unavailable`；
// 2. 目标条目已存在且值不同 → 不覆盖，报 `target-conflict`（避免把别人的记录改掉）；
// 3. 每条记录写完后**回读比对**；不一致立即停止，旧文件保留，报 `read-back-mismatch`；
// 4. 只有全部记录回读一致后才删除旧文件；删除失败按"已迁移但旧文件仍在"报告缺口；
// 5. 结果与消息里**不出现秘密值**：只给键名、条数与长度。
import { unlink } from 'node:fs/promises';

import { createFileBackend } from './backend.mjs';

export class KeychainMigrationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'KeychainMigrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const MIGRATION_REASONS = Object.freeze({
  MIGRATED: 'migrated',
  NOTHING_TO_MIGRATE: 'nothing-to-migrate',
  KEYCHAIN_UNAVAILABLE: 'keychain-unavailable',
  LEGACY_UNREADABLE: 'legacy-unreadable',
  TARGET_CONFLICT: 'target-conflict',
  KEYCHAIN_WRITE_FAILED: 'keychain-write-failed',
  READ_BACK_MISMATCH: 'read-back-mismatch',
  LEGACY_DELETE_FAILED: 'legacy-delete-failed',
});

/** 把消息里出现的秘密值替换掉，保证结果与日志可安全展示。 */
export function redactSecrets(text, secrets = []) {
  let output = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) output = output.split(secret).join('[redacted]');
  }
  return output;
}

const RECORD_SUFFIX = '/record/';
const REF_SUFFIX = '/ref/';

/** 只认本 provider 命名空间下的记录与引用条目。 */
export function isMigratableKey(key, namespace) {
  if (typeof key !== 'string' || typeof namespace !== 'string') return false;
  return key.startsWith(`${namespace}${RECORD_SUFFIX}`) || key.startsWith(`${namespace}${REF_SUFFIX}`);
}

/**
 * @param {{legacyPath: string, backend: object, service?: string, accountPrefix?: string,
 *   compareEqual?: (a: string, b: string) => boolean,
 *   readLegacy?: () => Promise<{ok: true, entries: Record<string, string>} | {ok: false, reason: string, message?: string}>,
 *   removeLegacy?: () => Promise<void>}} input
 */
export async function migrateLegacyFileToKeychain(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new KeychainMigrationError('KEYCHAIN_MIGRATION_INVALID', 'migration input must be an object');
  }
  const { legacyPath, backend } = input;
  if (typeof legacyPath !== 'string' || legacyPath.length === 0) {
    throw new KeychainMigrationError('KEYCHAIN_MIGRATION_INVALID', 'legacyPath is required');
  }
  if (backend === null || typeof backend !== 'object' || typeof backend.get !== 'function' || typeof backend.set !== 'function') {
    throw new KeychainMigrationError('KEYCHAIN_MIGRATION_INVALID', 'backend with get/set is required');
  }
  const service = input.service ?? 'heluo-forge';
  const accountPrefix = input.accountPrefix ?? 'iam';
  const namespace = `${service}/${accountPrefix}`;
  const compareEqual = input.compareEqual ?? ((a, b) => a === b);
  const secrets = [];

  const legacyReader =
    input.readLegacy ??
    (async () => {
      try {
        const file = createFileBackend({ path: legacyPath });
        const keys = await file.list('');
        const entries = {};
        for (const key of keys) entries[key] = await file.get(key);
        return { ok: true, entries };
      } catch (error) {
        return { ok: false, reason: 'legacy-unreadable', message: String(error?.message ?? error) };
      }
    });
  const removeLegacy = input.removeLegacy ?? (() => unlink(legacyPath));

  const result = (fields) =>
    Object.freeze({
      plaintextWritten: false,
      legacyRetained: fields.legacyRetained === true,
      migratedKeys: Object.freeze([...(fields.migratedKeys ?? [])]),
      skippedKeys: Object.freeze([...(fields.skippedKeys ?? [])]),
      ...fields,
      notes: Object.freeze((fields.notes ?? []).map((note) => redactSecrets(note, secrets))),
    });

  // 1. keychain 不可用：先看后端，再碰旧文件，绝不留下新明文。
  if (backend.available === false) {
    return result({
      migrated: false,
      legacyDeleted: false,
      legacyRetained: true,
      reason: MIGRATION_REASONS.KEYCHAIN_UNAVAILABLE,
      notes: ['keychain 不可用，按 fail closed 处理：不迁移、不写明文、不动旧文件'],
    });
  }

  const legacy = await legacyReader();
  if (legacy?.ok !== true) {
    return result({
      migrated: false,
      legacyDeleted: false,
      legacyRetained: true,
      reason: MIGRATION_REASONS.LEGACY_UNREADABLE,
      notes: [`旧记录不可读：${legacy?.message ?? legacy?.reason ?? 'unknown'}`],
    });
  }
  const entries = legacy.entries ?? {};
  for (const value of Object.values(entries)) if (typeof value === 'string') secrets.push(value);
  const keys = Object.keys(entries).filter((key) => isMigratableKey(key, namespace));
  if (keys.length === 0) {
    return result({
      migrated: false,
      legacyDeleted: false,
      legacyRetained: true,
      reason: MIGRATION_REASONS.NOTHING_TO_MIGRATE,
      notes: [`旧文件里没有 ${namespace} 命名空间下的记录/引用条目，不动旧文件`],
    });
  }

  const migratedKeys = [];
  const skippedKeys = [];
  for (const key of keys) {
    const value = entries[key];
    let existing;
    try {
      existing = await backend.get(key);
    } catch (error) {
      return result({
        migrated: false,
        legacyDeleted: false,
        legacyRetained: true,
        reason: MIGRATION_REASONS.KEYCHAIN_WRITE_FAILED,
        migratedKeys,
        skippedKeys,
        notes: [`读取目标条目失败：${String(error?.message ?? error)}`],
      });
    }
    // 2. 目标已存在且值不同：绝不覆盖。
    if (existing !== undefined && existing !== null && !compareEqual(String(existing), String(value))) {
      return result({
        migrated: false,
        legacyDeleted: false,
        legacyRetained: true,
        reason: MIGRATION_REASONS.TARGET_CONFLICT,
        migratedKeys,
        skippedKeys,
        notes: [`目标条目 ${key} 已有不同值，拒绝覆盖；旧文件保留`],
      });
    }
    // 同值即已迁移：跳过写入（幂等）。
    if (existing !== undefined && existing !== null && compareEqual(String(existing), String(value))) {
      skippedKeys.push(key);
      continue;
    }
    try {
      await backend.set(key, value);
    } catch (error) {
      return result({
        migrated: false,
        legacyDeleted: false,
        legacyRetained: true,
        reason: MIGRATION_REASONS.KEYCHAIN_WRITE_FAILED,
        migratedKeys,
        skippedKeys,
        notes: [`写入 ${key} 失败：${String(error?.message ?? error)}`],
      });
    }
    // 3. 回读比对，不一致立刻停止且不删旧文件。
    let readBack;
    try {
      readBack = await backend.get(key);
    } catch (error) {
      return result({
        migrated: false,
        legacyDeleted: false,
        legacyRetained: true,
        reason: MIGRATION_REASONS.READ_BACK_MISMATCH,
        migratedKeys,
        skippedKeys,
        notes: [`写入后回读 ${key} 失败：${String(error?.message ?? error)}`],
      });
    }
    if (readBack === undefined || readBack === null || !compareEqual(String(readBack), String(value))) {
      return result({
        migrated: false,
        legacyDeleted: false,
        legacyRetained: true,
        reason: MIGRATION_REASONS.READ_BACK_MISMATCH,
        migratedKeys,
        skippedKeys,
        notes: [`回读 ${key} 与旧值不一致，旧文件保留，目标条目留待人工核查`],
      });
    }
    migratedKeys.push(key);
  }

  // 4. 全部核实后才删旧文件。
  try {
    await removeLegacy();
  } catch (error) {
    return result({
      migrated: true,
      legacyDeleted: false,
      legacyRetained: true,
      reason: MIGRATION_REASONS.LEGACY_DELETE_FAILED,
      migratedKeys,
      skippedKeys,
      notes: [`钥匙串已写入并核对，但旧文件删除失败：${String(error?.message ?? error)}（按缺口报告，不谎报已清理）`],
    });
  }
  return result({
    migrated: true,
    legacyDeleted: true,
    legacyRetained: false,
    reason: MIGRATION_REASONS.MIGRATED,
    migratedKeys,
    skippedKeys,
    notes: [`${migratedKeys.length} 条写入并回读一致、${skippedKeys.length} 条已存在同值，旧文件已删除`],
  });
}
