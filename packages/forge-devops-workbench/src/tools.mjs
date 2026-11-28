/**
 * `@heluo/forge-devops-workbench` 面向大模型暴露的纯只读工具聚合入口（对齐 CORP-DSH-ENG-003）。
 *
 * 严格约束：
 *   1. 各领域工具独立定义于 `src/domains/<domain>/tools.mjs`，本模块只负责登记与汇总；
 *   2. 默认全为只读工具，零 `@deepseek-ai/*` 源码导入，失败返回脱敏可控错误信封。
 */
import { buildOverviewTools, OVERVIEW_TOOL_NAMES } from './domains/overview/tools.mjs';
import { buildRequirementTools, REQUIREMENT_TOOL_NAMES } from './domains/requirement/tools.mjs';

export const WORKBENCH_TOOLS = Object.freeze([
  ...REQUIREMENT_TOOL_NAMES,
  ...OVERVIEW_TOOL_NAMES,
]);

/**
 * 构造供 DSH `ctx.tools.register` 挂载的只读工具定义列表。
 *
 * @param {ReturnType<import('./service.mjs').createWorkbenchService>} service
 */
export function buildWorkbenchTools(service) {
  return [
    ...buildRequirementTools(service),
    ...buildOverviewTools(service),
  ];
}
