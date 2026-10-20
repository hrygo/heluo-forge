import { createServiceClient } from './client.mjs';
import { buildMarketTools } from './market-tools.mjs';

export const name = 'forge-market';

export const inject = ['tools'];

export const Config = {
  serviceUrl: { type: 'string', description: '企业市场服务地址', required: true },
  allowedHosts: { type: 'array', items: { type: 'string' }, default: [] },
  timeoutMs: { type: 'integer', default: 5000 },
};

export function apply(ctx, config = {}) {
  if (!config.serviceUrl) throw new Error('forge-market: serviceUrl is required');

  const client = createServiceClient({ baseUrl: config.serviceUrl, timeoutMs: config.timeoutMs ?? 5000 });
  const disposers = buildMarketTools(client, { allowedHosts: config.allowedHosts ?? [] }).map((definition) =>
    ctx.tools.register(definition),
  );

  return () => disposers.forEach((dispose) => dispose());
}
