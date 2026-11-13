/**
 * `@heluo/forge-devops` 扩展凭证描述与可选托管解析（CORP-DSH-DESIGN-018 §5 / ADR-0012）。
 *
 * 独立可运行边界：
 * - 描述符纯静态，不依赖 `@heluo/forge-iam` 包；
 * - 宿主存在 `CredentialBroker` 时注册并在运行期优先使用托管加密令牌（owner mismatch 时 fail closed，零子进程）；
 * - 宿主未提供 broker 时退回白名单环境变量 `DEVOPS_API_KEY`（standalone 模式）。
 *
 * broker 与插件并发装载，行序不是加载顺序语义：覆盖窗口靠 `ctx.inject` 补注册。
 * 窗口内（本插件已 apply、IAM 尚未 provide）仍按 standalone 读环境变量——这是有意的降级，
 * 不是安全保证；要求「配了 IAM 就绝不读环境变量」的部署必须让 IAM 条目先就绪。
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
function bindBroker(broker) {
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
 * `ctx.inject` 的返回值在真实 Cordis 里是 Fiber（只有 `dispose()`），并非函数；
 * 测试夹具若只模拟函数形态，teardown 会抛 TypeError 并中断整个卸载流程。
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

export function registerDevopsCredential(ctx) {
  const broker = getOptionalBroker(ctx);
  if (broker !== null && typeof broker === 'object') {
    return bindBroker(broker);
  }
  // Cordis Loader 并发创建条目，行序不构成加载顺序语义：IAM 行可能在本插件之后完成。
  // 一次性 `ctx.get` 会把这种正常时序误判成 standalone 并一直用环境变量。
  if (typeof ctx?.inject === 'function') {
    let disposeRegistration = null;
    const bindLate = (late) => {
      if (late === null || typeof late !== 'object') return;
      if (disposeRegistration !== null) return;
      disposeRegistration = bindBroker(late);
    };
    // 两个候选服务名都要等：别名只有同步读到才有用，等不到就与「没装 IAM」无异。
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
 * 构造供 `createCliRunner({ resolveChildEnv })` 使用的按次环境解析函数。
 *
 * @param {object} [options]
 * @param {object|null} [options.broker]
 * @param {Record<string, string | undefined>} [options.processEnv]
 * @returns {(() => Promise<Record<string, string>>) | null}
 */
export function createDevopsResolveChildEnv({ broker = null, getBroker = null, processEnv = process.env } = {}) {
  const readBroker = typeof getBroker === 'function' ? getBroker : () => broker;
  if (typeof getBroker !== 'function' && (broker === null || typeof broker !== 'object')) {
    return null;
  }
  return async () => {
    // 每次解析都重新取 broker：IAM 行可能在本流程构造之后才就绪，
    // 构造期捕获的 null 会让整个会话静默停在 standalone。
    const active = readBroker();
    if (active === null || typeof active !== 'object' || typeof active.resolveChildEnv !== 'function') {
      return {};
    }
    const resolved = await active.resolveChildEnv({
      extensionId: DEVOPS_CREDENTIAL_DESCRIPTOR.extensionId,
      processEnv,
    });
    if (resolved !== null && typeof resolved === 'object' && resolved.ok === false) {
      return resolved;
    }
    return resolved?.env && typeof resolved.env === 'object' ? resolved.env : {};
  };
}
