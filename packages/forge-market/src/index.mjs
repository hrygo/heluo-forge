import { createServiceClient } from './client.mjs';
import { createLocalCatalog } from './local-catalog.mjs';
import { buildMarketTools } from './market-tools.mjs';
import { createMarketRoutes } from './routes.mjs';

export const name = 'forge-market';

export const inject = { required: ['tools'], optional: ['webServer'] };

export const Config = {
  serviceUrl: { type: 'string', description: '企业市场服务地址；与 catalogFile 二选一' },
  catalogFile: { type: 'string', description: '离线目录 JSON；设置后不访问服务' },
  allowedHosts: { type: 'array', items: { type: 'string' }, default: [] },
  timeoutMs: { type: 'integer', default: 5000 },
  cachePath: { type: 'string', description: '离线缓存文件路径；缺省不缓存' },
  targetDir: { type: 'string', description: '安装落盘目录；缺省只校验不落盘' },
};

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
    registration: {
      serviceUrl: config.serviceUrl,
      allowedHosts: config.allowedHosts ?? [],
      timeoutMs: config.timeoutMs ?? 5000,
      targetDir: config.targetDir,
    },
  };
  const disposers = buildMarketTools(client, shared).map((definition) => ctx.tools.register(definition));

  if (ctx.webServer) {
    disposers.push(
      ctx.webServer.register({
        kind: 'prefix',
        path: '/api/forge-market',
        handler: createMarketRoutes({ client, cachePath: config.cachePath }),
      }),
    );
  }

  return () => disposers.forEach((dispose) => dispose());
}
