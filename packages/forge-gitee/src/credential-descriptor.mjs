/**
 * `@heluo/forge-gitee` 扩展凭证描述与可选托管解析（CORP-DSH-DESIGN-018 §5 / ADR-0012）。
 *
 * - 不修改 `runtime-config.mjs`（保留 `authEnv` / `persistentToken` / `ConfigStandard`）；
 * - 宿主存在 `CredentialBroker` 时注册并在运行期优先使用托管加密令牌（owner mismatch 时 fail closed，零子进程）；
 * - `detectRiskAndExternal` 复用 `detectPersistentToken` 检测明文落盘风险，绝不修改 `~/.gitee-cli/config.json`。
 */

import { detectPersistentToken } from './gitee-cli.mjs';

export const GITEE_CREDENTIAL_DESCRIPTOR = Object.freeze({
  extensionId: 'gitee',
  storageRef: 'HEL_EXT_GITEE_TOKEN',
  envKey: 'GITEE_TOKEN',
  allowlistedEnvNames: Object.freeze(['GITEE_TOKEN']),
  detectRiskAndExternal({ processEnv = process.env, readFile } = {}) {
    const envHitNames = typeof processEnv?.GITEE_TOKEN === 'string' && processEnv.GITEE_TOKEN.length > 0
      ? ['GITEE_TOKEN']
      : [];
    const detected = detectPersistentToken({
      env: processEnv,
      ...(typeof readFile === 'function' ? { readFile } : {}),
    });
    return {
      envHitNames,
      plaintextRisk: detected.blocked === true,
      riskDetails: detected.blocked === true
        ? { reason: detected.reason, fileCount: detected.files.length }
        : null,
    };
  },
});

export function getOptionalBroker(ctx) {
  if (ctx === null || typeof ctx !== 'object') return null;
  if (typeof ctx.get === 'function') {
    return ctx.get('forgeIamCredentialBroker') ?? ctx.get('extTokenBroker') ?? null;
  }
  return ctx.forgeIamCredentialBroker ?? ctx.extTokenBroker ?? null;
}

/**
 * 从宿主 `ctx` 读取可选的 CredentialBroker，并注册 Gitee 凭证描述符。
 *
 * @param {object|null|undefined} ctx
 * @returns {() => void} 卸载函数（未提供 broker 时返回空函数）
 */
export function registerGiteeCredential(ctx) {
  const broker = getOptionalBroker(ctx);
  if (broker === null || typeof broker !== 'object') {
    return () => {};
  }
  if (typeof broker.registerDescriptor === 'function') {
    const dispose = broker.registerDescriptor(GITEE_CREDENTIAL_DESCRIPTOR);
    return typeof dispose === 'function' ? dispose : () => {};
  }
  if (typeof broker.register === 'function') {
    const dispose = broker.register(GITEE_CREDENTIAL_DESCRIPTOR);
    return typeof dispose === 'function' ? dispose : () => {};
  }
  return () => {};
}

/**
 * 构造供 `createGiteeRunner({ resolveChildEnv })` 使用的按次环境解析函数。
 *
 * @param {object} [options]
 * @param {object|null} [options.broker]
 * @param {Record<string, string | undefined>} [options.processEnv]
 * @returns {(() => Promise<Record<string, string>>) | null}
 */
export function createGiteeResolveChildEnv({ broker = null, processEnv = process.env } = {}) {
  if (broker === null || typeof broker !== 'object' || typeof broker.resolveChildEnv !== 'function') {
    return null;
  }
  return async () => {
    const resolved = await broker.resolveChildEnv({
      extensionId: GITEE_CREDENTIAL_DESCRIPTOR.extensionId,
      processEnv,
    });
    if (resolved !== null && typeof resolved === 'object' && resolved.ok === false) {
      return resolved;
    }
    return resolved?.env && typeof resolved.env === 'object' ? resolved.env : {};
  };
}
