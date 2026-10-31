// 旧 0600 明文迁移暂时关闭：现有接口无法证明目标事务与所有写入方互斥，
// 也无法排除文件目标与旧文件是同一文件。不得因此读取、修改或删除旧文件。

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
  TARGET_ATOMIC_UNAVAILABLE: 'target-atomic-unavailable',
});

/** 把消息里出现的秘密值替换掉。 */
export function redactSecrets(text, secrets = []) {
  let output = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) output = output.split(secret).join('[redacted]');
  }
  return output;
}

/** 只认本 provider 命名空间下的记录与引用条目。 */
export function isMigratableKey(key, namespace) {
  if (typeof key !== 'string' || typeof namespace !== 'string') return false;
  return key.startsWith(`${namespace}/record/`) || key.startsWith(`${namespace}/ref/`);
}

/**
 * Fail closed：保留原有调用入口，但不调用目标或旧记录注入点。
 * backend.transaction 的存在不能证明跨进程互斥，当前不具备安全迁移契约。
 * legacyDeleted=false 仅表示本次未删除；legacyRetained=null 表示未核实文件是否存在。
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
  const unavailable = backend.available === false;
  return Object.freeze({
    migrated: false,
    legacyDeleted: false,
    legacyRetained: null,
    plaintextWritten: false,
    migratedKeys: Object.freeze([]),
    skippedKeys: Object.freeze([]),
    reason: unavailable ? MIGRATION_REASONS.KEYCHAIN_UNAVAILABLE : MIGRATION_REASONS.TARGET_ATOMIC_UNAVAILABLE,
    notes: Object.freeze([unavailable
      ? 'keychain 不可用；本次未访问或删除旧文件'
      : '无法验证迁移所需的目标互斥与文件隔离；本次未访问目标或旧文件']),
  });
}
