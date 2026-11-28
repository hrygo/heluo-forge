/**
 * DOP 工作台外链地址聚合器（合并各领域外链，绝不附加任何 Token/Secret）。
 */
import { createBaseJoiner, sanitizePortalUrl } from './shared/url-safety.mjs';
import { buildOverviewLinks } from './domains/overview/links.mjs';
import { buildRequirementLinks } from './domains/requirement/links.mjs';

export { sanitizePortalUrl };

/**
 * 基于已配置的企业 DOP 服务基准地址构造各业务对象外链。
 *
 * @param {string} apiBaseUrl
 */
export function buildPortalLinks(apiBaseUrl) {
  const { isConfigured, join } = createBaseJoiner(apiBaseUrl);

  return Object.freeze({
    isConfigured,
    ...buildOverviewLinks(join),
    ...buildRequirementLinks(join),
  });
}
