import { createServiceClient } from './client.mjs';
import { buildMarketTools } from './market-tools.mjs';
import { createMarketRoutes } from './routes.mjs';

export const name = 'forge-market';

export const inject = { required: ['tools'], optional: ['webServer'] };

export const Config = {
  serviceUrl: { type: 'string', description: '企业市场服务地址', required: true },
  allowedHosts: { type: 'array', items: { type: 'string' }, default: [] },
  timeoutMs: { type: 'integer', default: 5000 },
  cachePath: { type: 'string', description: '离线缓存文件路径；缺省不缓存' },
  targetDir: { type: 'string', description: '安装落盘目录；缺省只校验不落盘' },
};

export function apply(ctx, config = {}) {
  if (!config.serviceUrl) throw new Error('forge-market: serviceUrl is required');

  const client = createServiceClient({ baseUrl: config.serviceUrl, timeoutMs: config.timeoutMs ?? 5000 });
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
