import { createServiceClient } from './client.mjs';
import { createLocalCatalog } from './local-catalog.mjs';
import { buildMarketTools } from './market-tools.mjs';
import { createMarketRoutes } from './routes.mjs';

export const name = 'forge-market';

// cordis 的 inject 对象是按服务名索引的映射，写 { required, optional } 会被当成
// 两个叫 required/optional 的服务，插件永远 pending。可选依赖用 ctx.get。
export const inject = ['tools'];

export { Config } from './config.mjs';

export function apply(ctx, config = {}) {
  if (!config.serviceUrl && !config.catalogFile) {
    throw new Error('forge-market: serviceUrl or catalogFile is required');
  }

  const client = config.catalogFile
    ? createLocalCatalog(config.catalogFile)
    : createServiceClient({
        baseUrl: config.serviceUrl,
        timeoutMs: config.timeoutMs ?? 5000,
        // 令牌只从环境读：不写配置文件，不落日志，也不进 patch。
        token: process.env.HELUO_MARKET_TOKEN ?? '',
      });
  const shared = {
    allowedHosts: config.allowedHosts ?? [],
    cachePath: config.cachePath,
    targetDir: config.targetDir,
    // 宿主版本用于 engines.dsh 门槛；拿不到就不拦，文档已写明该降级。
    // cordis 禁止直接读未 inject 的属性（ctx.app 会抛错）；ctx.get 是安全读取。
    dshVersion: ctx?.get?.('app')?.version ?? process.env.DSH_VERSION,
    registration: {
      serviceUrl: config.serviceUrl,
      allowedHosts: config.allowedHosts ?? [],
      timeoutMs: config.timeoutMs ?? 5000,
      targetDir: config.targetDir,
    },
  };
  const disposers = buildMarketTools(client, shared).map((definition) => ctx.tools.register(definition));

  // webServer 是可选的：激活顺序上它可能还没就绪。直接读 ctx.get 只会拿到
  // undefined 并静默不注册路由，所以用 ctx.inject 等到它就绪再挂。
  if (typeof ctx.inject === 'function') {
    disposers.push(
      ctx.inject(['webServer'], (host) => {
        const off = host.webServer.register({
          kind: 'prefix',
          path: '/api/forge-market',
          handler: createMarketRoutes({ client, cachePath: config.cachePath }),
        });
        host.effect?.(() => off);
      }),
    );
  }

  return () => disposers.forEach((dispose) => dispose());
}
