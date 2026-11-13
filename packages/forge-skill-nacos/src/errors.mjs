/**
 * `@heluo/forge-skill-nacos` 的错误分类（设计 §8：错误码即契约）。
 *
 * 每个拒绝路径一个稳定 code，页面/工具/日志共用同一语义；消息面向用户可读，
 * 细节字段 `detail` 供日志与回查，不携带凭据值。
 */
export const REASONS = Object.freeze({
  CONFIG_INVALID: 'SN_CONFIG_INVALID',
  AUTH_MISSING: 'SN_AUTH_MISSING',
  FORBIDDEN: 'SN_FORBIDDEN',
  NOT_FOUND: 'SN_NOT_FOUND',
  NETWORK: 'SN_NETWORK',
  CATALOG_INVALID: 'SN_CATALOG_INVALID',
  CATALOG_MODE_MISMATCH: 'SN_CATALOG_MODE_MISMATCH',
  INVALID_PACKAGE: 'SN_INVALID_PACKAGE',
  NAME_INVALID: 'SN_NAME_INVALID',
  NAME_CONFLICT: 'SN_NAME_CONFLICT',
  VERSION_MISMATCH: 'SN_VERSION_MISMATCH',
  PATH_ESCAPE: 'SN_PATH_ESCAPE',
  QUOTA_EXCEEDED: 'SN_QUOTA_EXCEEDED',
  LOCK_TIMEOUT: 'SN_LOCK_TIMEOUT',
  NO_PROJECT_ROOT: 'SN_NO_PROJECT_ROOT',
  LEDGER_INVALID: 'SN_LEDGER_INVALID',
  NOT_INSTALLED: 'SN_NOT_INSTALLED',
});

export class SkillNacosError extends Error {
  /**
   * @param {string} code REASONS 之一
   * @param {string} message 用户可读消息
   * @param {object} [detail] 供日志的脱敏细节
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'SkillNacosError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 把未知抛出值包装为 SkillNacosError；已是本类型则原样返回。 */
export function toSkillNacosError(error, fallbackCode = REASONS.NETWORK) {
  if (error instanceof SkillNacosError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new SkillNacosError(fallbackCode, message);
  wrapped.cause = error;
  return wrapped;
}
