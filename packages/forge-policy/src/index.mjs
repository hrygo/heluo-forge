/**
 * `@heluo/forge-policy`：受控动作目录、统一门禁、受保护路径与恒开审计。
 *
 * 挂载时先做一次性配置校验，再编译目录并注册 guard 与 `tools/pre-execute`
 * 监听器；目录无效、配置无效、策略服务已被占用或宿主缺少必要 seam 时拒绝挂载
 * （fail closed），不做"降级为只读"。业务工具插件对该服务声明硬依赖，因此策略
 * 不可用时它们的入口根本不存在。
 */
import { installPolicy } from './installer.mjs';

export const name = 'forge-policy';
export const inject = ['tools'];

export { PolicyCatalogError, catalogIssues, compileCatalog, decideAction } from './catalog.mjs';
export {
  BUILTIN_ACTIONS, CATEGORY, actionsIn, classifyAction, defaultDecision, isWriteAction, relaxes, strictestDecision,
} from './classify.mjs';
export {
  CONFIRMATION_KEYS, DEFAULT_CONFIRMATION_TIMEOUT_MS, DEFAULT_RULES, IMPLEMENTED_RULES, RULE_KEYS,
  Config, collectPathTemplates, resolveConfig, validateConfig,
} from './config.mjs';
export { MAX_RULES, compileContentRules, digestContent, redactExcerpt, scanPayloads } from './content-rules.mjs';
export { PERSONA, agentKindOf, personaOf } from './delegation.mjs';
export {
  CONFIRM_CODES, CONFIRM_LABELS, CONFIRM_REASONS, buildConfirmationCard, createConfirmationGateway, readConfirmationAnswer,
} from './confirm.mjs';
export { DECISION_CACHE_LIMIT, createDecisionCache, reuseKeyOf } from './reuse.mjs';
export { createGate } from './gate.mjs';
export { ORG_ENVELOPE_SCHEMA, effectiveDecision, loadOrgPolicy, verifyEnvelope } from './org-policy.mjs';
export { STAGE, activeRules, buildPipeline, isObserveOnly } from './pipeline.mjs';
export {
  CLI_NAMES,
  STORE_ARTIFACT,
  extractStoreTargets,
  judgeStoreAccess,
  judgeTokenInvocation,
  parseCommandTargets,
  storeDeniedCopy,
  storeRootsFrom,
  tokenDeniedCopy,
} from './store-protection.mjs';
export { evaluateProcessRules } from './process-rules.mjs';
export { buildAuditRecord, createAuditBarrier, createFileSink, createMemorySink } from './audit.mjs';
export {
  AUDIT_COLUMNS, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT, formatAuditReport, formatAuditRow, formatAuditTime, parseAuditCount,
} from './audit-query.mjs';
export { AUDIT_COMMAND_DESCRIPTION, AUDIT_COMMAND_HINT, AUDIT_COMMAND_NAME, registerAuditCommand } from './audit-command.mjs';
export { collectPathCandidates, targetAsPath } from './path-sources.mjs';
export {
  PROTECTED_NAME_PATTERNS, isPathTemplate, judgeProtectedPath, matchProtected, matchProtectedName, resolveProtectedRoots,
} from './paths.mjs';

export { installPolicy, registerCommand } from './installer.mjs';

// Real native bridges; the shared installer never discovers IAM test sources.
export function apply(ctx, rawConfig = {}) {
  return installPolicy(ctx, rawConfig, {
    guard: (callback) => ctx.tools.guard(callback),
    pre: (callback) => ctx.on('tools/pre-execute', callback),
  });
}
