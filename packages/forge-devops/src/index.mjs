/**
 * `@heluo/forge-devops` 宿主插件骨架（#15 / D4，设计准入见能力面设计 §6.1）。
 *
 * 只做**端口 + 门禁接线**：
 * - 只读适配器经服务键 `devopsReader` 注入；仓库内不内置企业 CLI/HTTP 实现。
 * - 策略服务是硬依赖：拿不到就不挂载（入口关闭），不提供"无策略只读"的降级档位。
 * - 无适配器时读请求 fail closed（`NO_READER`），不猜、不伪造事实。
 *
 * 写动作一条都不在此列，也不由本包开放；写按策略设计 §5.1.1 的登记表另行准入。
 */
import { assertReadRequest, normalizeReadResult, READ_ACTIONS, READ_REASONS, DevopsReadError } from './read.mjs';
import { buildDevopsTools, READ_TOOLS } from './tools.mjs';

/** 宿主服务键；提供方（企业 CLI 适配器）用它注入只读端口。 */
export const READER_KEY = 'devopsReader';
/** 本插件对外暴露的服务键。 */
export const SERVICE_KEY = 'devops';
export const DEFAULT_CONFIG = Object.freeze({});

export { assertReadRequest, DevopsReadError, normalizeReadResult, READ_ACTIONS, READ_REASONS, READ_STATUSES } from './read.mjs';
export { buildDevopsTools, READ_TOOLS } from './tools.mjs';

export function validateConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DevopsReadError(READ_REASONS.MALFORMED_RESULT, 'devops 配置必须是对象');
  }
  const unknown = Object.keys(input).filter((key) => !(key in DEFAULT_CONFIG));
  if (unknown.length > 0) {
    throw new DevopsReadError(READ_REASONS.MALFORMED_RESULT, `未知配置项：${unknown.join(', ')}`, { unknown });
  }
  return { ...DEFAULT_CONFIG, ...input };
}

/**
 * @param {{ get?: Function, provide?: Function, effect?: Function }} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);
  // 硬依赖：策略服务不在就拒绝挂载（不降级为"只读模式"）。
  if (typeof ctx.get !== 'function' || ctx.get('policy') === undefined) {
    throw new DevopsReadError(READ_REASONS.POLICY_REQUIRED, '策略服务未挂载，devops 只读面不开放');
  }

  const service = {
    /** 只读动作清单（写动作永不出现在这里）。 */
    readActions: () => [...READ_ACTIONS],
    /** 已注册的只读工具名（模型可见面）。 */
    toolNames: () => Object.keys(READ_TOOLS),
    /** 当前状态：没有适配器时为 `no-reader`（可见地 fail closed）。 */
    status: () => (typeof ctx.get === 'function' && ctx.get(READER_KEY) !== undefined ? 'ready' : 'no-reader'),
    /**
     * 执行一次只读查询。适配器返回什么都由 `normalizeReadResult` 规整：
     * 退出码不算事实，缺结构化状态或缺来源版本一律 `unknown`。
     */
    read: async ({ action, target } = {}) => {
      const reader = typeof ctx.get === 'function' ? ctx.get(READER_KEY) : undefined;
      if (reader === undefined || typeof reader.read !== 'function') {
        throw new DevopsReadError(READ_REASONS.NO_READER, '没有可用的只读适配器（按关闭处理）', { action });
      }
      // 先判动作与目标，再碰适配器：未登记动作不得产生任何调用。
      assertReadRequest(action, target);
      const result = await reader.read({ action, target });
      return normalizeReadResult({ action, target, result });
    },
    config,
  };

  const disposeProvide = ctx.provide(SERVICE_KEY, service);
  // 只读工具进模型可见面，走与其它业务工具同一条门禁管线；没有 tools 服务就只暴露服务、
  // 不注册工具（宿主差异显式可见，而不是静默注册到别处）。
  const disposers =
    typeof ctx.tools?.register === 'function'
      ? buildDevopsTools(service).map((definition) => ctx.tools.register(definition))
      : [];
  const teardown = () => {
    disposers.forEach((dispose) => dispose?.());
    disposeProvide?.();
  };
  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect?.(() => teardown);
  return teardown;
}
