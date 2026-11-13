/**
 * `@heluo/forge-skill-nacos` 宿主插件（#97；设计见
 * docs/design/plugins/forge-skill-nacos.md）。
 *
 * 只做接线：目录客户端 + 安装事务 + 台账 + `ctx.skills` Provider + 工具面。
 * - `inject` 三项都是硬依赖：`skills` 缺 Provider 无从注册，`tools` 缺工具面
 *   静默不注册（devops 实测教训），`credentials` 缺凭据 fail closed。
 * - 安装类写动作依赖 forge-policy 受控目录登记；未登记/未批准时由门禁拒绝，
 *   本包不自行放行（fail closed，设计 §2 范围差异声明）。
 * - 目录轮询零安装副作用；插件卸载释放 Provider、工具、定时器与文档锁。
 */
import { createCatalog } from './catalog.mjs';
import { createCredentialReader } from './credentials.mjs';
import { validateConfig } from './config.mjs';
import { REASONS, SkillNacosError } from './errors.mjs';
import { createLedger } from './ledger.mjs';
import { ensureLayout, layout, resolveDshHome } from './paths.mjs';
import { join } from 'node:path';
import { createSkillProvider } from './provider.mjs';
import { registerClientRoutes } from './routes.mjs';
import { createSkillNacosService } from './service.mjs';
import { createSettingsOverlay } from './settings.mjs';
import { createCatalogPoller } from './poll.mjs';
import { buildSkillNacosTools } from './tools.mjs';

export const name = 'forge-skill-nacos';
export const inject = ['skills', 'tools', 'credentials'];

/** 本插件对外暴露的服务键（页面/工具/后续 Client 面板共用）。 */
export const SERVICE_KEY = 'skillNacos';

export { validateConfig } from './config.mjs';
export { REASONS, SkillNacosError } from './errors.mjs';

/**
 * @param {{get?: Function, provide?: Function, effect?: Function,
 *          skills?: {registerProvider?: Function, list?: Function},
 *          tools?: {register?: Function}, logger?: object}} ctx
 * @param {object} rawConfig
 */
export async function apply(ctx, rawConfig = {}) {
  const { value: config } = validateConfig(rawConfig);

  const dirs = layout(resolveDshHome());
  ensureLayout(dirs);
  const ledger = await createLedger({
    statePath: dirs.statePath,
    lockPath: dirs.lockPath,
  }).initialize();

  // 用户可调覆盖层：cordis.yml 基线 + settings.json 覆盖（环境切换 + 高级参数）
  const overlay = createSettingsOverlay(join(dirs.root, 'settings.json'));
  await overlay.load();
  const baseMerged = overlay.merge(config);

  /** 从 environments 数组解析当前生效环境（覆盖 activeEnvironmentId 优先），无环境配置时回落平铺字段。 */
  function resolveEffective(merged) {
    const envs = merged.environments ?? [];
    if (!Array.isArray(envs) || envs.length === 0) return merged;
    const activeId = merged.activeEnvironmentId ?? envs[0]?.id;
    const env = envs.find((e) => e.id === activeId) ?? envs[0];
    if (env === undefined) return merged;
    return {
      ...merged,
      endpoint: env.endpoint,
      consoleEndpoint: env.consoleEndpoint,
      namespaceId: env.namespaceId,
      credentialRecordId: env.credentialRecordId,
      activeEnvironmentId: env.id,
    };
  }

  const effective = resolveEffective(baseMerged);

  // catalog 通过间接引用支持运行时重建（设置变更后重连）
  const rebuildWith = (nextMerged) => {
    const next = resolveEffective(nextMerged);
    return createCatalog({ value: next }, createCredentialReader(ctx, next.credentialRecordId));
  };
  let catalogRef = { current: rebuildWith(baseMerged) };

  let invalidate = () => {};
  const provider = createSkillProvider({
    ledger,
    skillDir: dirs.skillDir,
    providerName: config.providerName,
    logger: ctx.logger,
  });
  const disposeProvider = ctx.skills?.registerProvider?.((control) => {
    invalidate = () => control.invalidate();
    return provider;
  });
  if (typeof disposeProvider !== 'function') {
    throw new SkillNacosError(REASONS.CONFIG_INVALID, '宿主 skills 服务不支持 registerProvider，插件不挂载');
  }

  const service = createSkillNacosService({
    config: { value: effective },
    baseConfig: { value: config },
    catalogRef,
    overlay,
    rebuildCatalog: (nextBase) => {
      catalogRef.current = rebuildWith(nextBase);
    },
    ledger,
    dirs,
    skillsList: (options) => ctx.skills?.list?.(options) ?? Promise.resolve([]),
    invalidate: () => invalidate(),
    logger: ctx.logger,
    providerName: config.providerName,
  });
  await service.cleanStaging();

  const disposers =
    typeof ctx.tools?.register === 'function'
      ? buildSkillNacosTools(service).map((definition) => ctx.tools.register(definition))
      : [];
  if (disposers.length === 0 && typeof ctx.tools?.register !== 'function') {
    ctx.logger?.warn?.('forge-skill-nacos: 宿主无 tools.register，本会话不注册工具面（服务仍可用）');
  }

  const disposeProvide = ctx.provide(SERVICE_KEY, service);

  // 面板 HTTP 路由：ctx.inject 创建子作用域等待 webServer（cordis 约束——不在
  // inject 列表中的服务属性不可直接访问）。sdk/headless 无 Web 宿主时此 inject
  // 永不激活，服务与工具面照常（宿主探针依赖此行为）。
  // 路由注册不走 effect/dispose 包装——在 inject 子作用域中，effect 包装导致
  // 路由被提前清理（2026-10-29 实测）；宿主生命周期结束时 webServer 自身释放。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      registerClientRoutes(webCtx, service);
    });
  }

  // 目录轮询：超时由请求层兜底，失败退避加抖动；刷新零安装副作用（设计 §7.1）。
  // 调度状态机归 poll.mjs 所有（ENG-003 P2：装配点只装配）。
  const poller = createCatalogPoller({
    refresh: () => service.refreshCatalog(),
    intervalMs: config.catalogRefreshIntervalMs,
    pollMaxBackoffMs: config.pollMaxBackoffMs,
    pollJitterMs: config.pollJitterMs,
  });

  const teardown = () => {
    poller.stop();
    for (const dispose of disposers) dispose?.();
    disposeProvide?.();
    disposeProvider?.();
  };
  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect?.(() => teardown);
  return teardown;
}
