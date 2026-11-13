/**
 * `@heluo/forge-gitee` 扩展凭证描述与可选托管解析（CORP-DSH-DESIGN-018 §5 / ADR-0012）。
 *
 * - 不修改 `runtime-config.mjs`（保留 `authEnv` / `persistentToken` / `ConfigStandard`）；
 * - 宿主存在 `CredentialBroker` 时注册并在运行期优先使用托管加密令牌（owner mismatch 时 fail closed，零子进程）；
 * - `detectRiskAndExternal` 复用 `detectPersistentToken` 检测明文落盘风险，绝不修改 `~/.gitee-cli/config.json`。
 *
 * broker 与插件并发装载：覆盖窗口靠 `ctx.inject` 补注册。窗口内（本插件已 apply、IAM 尚未
 * provide）仍按 standalone 读 `GITEE_TOKEN`——有意的降级，不是安全保证。
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
      // 设计 §5.3：诊断抽屉要能指出**哪个文件**命中了明文令牌，只给计数无法让人处理。
      riskDetails: detected.blocked === true
        ? { reason: detected.reason, fileCount: detected.files.length, files: [...detected.files] }
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
function bindBroker(broker) {
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
 * `ctx.inject` 在真实 Cordis 里返回 Fiber（只有 `dispose()`），不是函数；
 * 夹具若只模拟函数形态，teardown 会抛 TypeError 并让其余回收静默丢失。
 */
function releaseHandle(handle) {
  try {
    if (typeof handle === 'function') {
      handle();
      return;
    }
    const pending = handle?.dispose?.();
    if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') {
      pending.catch(() => {});
    }
  } catch {
    // 卸载链不能因为一个可选服务的句柄异常而中断其余回收。
  }
}

export function registerGiteeCredential(ctx) {
  const broker = getOptionalBroker(ctx);
  if (broker !== null && typeof broker === 'object') {
    return bindBroker(broker);
  }
  // Cordis Loader 并发创建条目：IAM 行可能在本插件之后就绪，一次性 `ctx.get`
  // 会把正常时序误判成 standalone 并一直只用环境变量。
  if (typeof ctx?.inject === 'function') {
    let disposeRegistration = null;
    const bindLate = (late) => {
      if (late === null || typeof late !== 'object') return;
      if (disposeRegistration !== null) return;
      disposeRegistration = bindBroker(late);
    };
    // 别名也要等：只支持同步读到别名等于「宿主用别名时永远 standalone」。
    const offPrimary = ctx.inject(['forgeIamCredentialBroker'], (scope) => bindLate(scope?.forgeIamCredentialBroker));
    const offAlias = ctx.inject(['extTokenBroker'], (scope) => bindLate(scope?.extTokenBroker));
    return () => {
      try {
        releaseHandle(offPrimary);
        releaseHandle(offAlias);
      } finally {
        disposeRegistration?.();
        disposeRegistration = null;
      }
    };
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
