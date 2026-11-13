/**
 * `@heluo/forge-devops` 扩展凭证描述与可选托管解析（CORP-DSH-DESIGN-018 §5 / ADR-0012）。
 *
 * 独立可运行边界：
 * - 描述符纯静态，不依赖 `@heluo/forge-iam` 包；
 * - 宿主存在 `CredentialBroker` 时注册并在运行期优先使用托管加密令牌（owner mismatch 时 fail closed，零子进程）；
 * - 宿主未提供 broker 时退回白名单环境变量 `DEVOPS_API_KEY`（standalone 模式）。
 */

export const DEVOPS_CREDENTIAL_DESCRIPTOR = Object.freeze({
  extensionId: 'devops',
  storageRef: 'HEL_EXT_DEVOPS_TOKEN',
  envKey: 'DEVOPS_API_KEY',
  allowlistedEnvNames: Object.freeze(['DEVOPS_API_KEY']),
});

export function getOptionalBroker(ctx) {
  if (ctx === null || typeof ctx !== 'object') return null;
  if (typeof ctx.get === 'function') {
    return ctx.get('forgeIamCredentialBroker') ?? ctx.get('extTokenBroker') ?? null;
  }
  return ctx.forgeIamCredentialBroker ?? ctx.extTokenBroker ?? null;
}

/**
 * 从宿主 `ctx` 读取可选的 CredentialBroker，并注册 DevOps 凭证描述符。
 *
 * @param {object|null|undefined} ctx
 * @returns {() => void} 卸载函数（未提供 broker 时返回空函数）
 */
export function registerDevopsCredential(ctx) {
  const broker = getOptionalBroker(ctx);
  if (broker === null || typeof broker !== 'object') {
    return () => {};
  }
  if (typeof broker.registerDescriptor === 'function') {
    const dispose = broker.registerDescriptor(DEVOPS_CREDENTIAL_DESCRIPTOR);
    return typeof dispose === 'function' ? dispose : () => {};
  }
  if (typeof broker.register === 'function') {
    const dispose = broker.register(DEVOPS_CREDENTIAL_DESCRIPTOR);
    return typeof dispose === 'function' ? dispose : () => {};
  }
  return () => {};
}

/**
 * 构造供 `createCliRunner({ resolveChildEnv })` 使用的按次环境解析函数。
 *
 * @param {object} [options]
 * @param {object|null} [options.broker]
 * @param {Record<string, string | undefined>} [options.processEnv]
 * @returns {(() => Promise<Record<string, string>>) | null}
 */
export function createDevopsResolveChildEnv({ broker = null, processEnv = process.env } = {}) {
  if (broker === null || typeof broker !== 'object' || typeof broker.resolveChildEnv !== 'function') {
    return null;
  }
  return async () => {
    const resolved = await broker.resolveChildEnv({
      extensionId: DEVOPS_CREDENTIAL_DESCRIPTOR.extensionId,
      processEnv,
    });
    if (resolved !== null && typeof resolved === 'object' && resolved.ok === false) {
      return resolved;
    }
    return resolved?.env && typeof resolved.env === 'object' ? resolved.env : {};
  };
}
