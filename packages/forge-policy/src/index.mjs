/**
 * `@heluo/forge-policy`：受控动作目录、command/tool 统一门禁、受保护路径、C3 外发确认、
 * 有限委托与可信确认生命周期。
 *
 * 挂载时编译目录并注册 guard 与 `tools/pre-execute` 监听器；目录无效、策略服务
 * 已被占用或宿主缺少必要 seam 时拒绝挂载（fail closed），不做"降级为只读"。
 * 业务工具插件对该服务声明硬依赖，因此策略不可用时它们的入口根本不存在。
 */
import { installPolicy } from './installer.mjs';

export const name = 'forge-policy';
export const inject = ['tools'];

export { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
export {
  BUILTIN_ACTIONS, CATEGORY, actionsIn, classifyAction, defaultDecision, isWriteAction, relaxes, strictestDecision,
} from './classify.mjs';
export { MAX_RULES, compileContentRules, redactExcerpt, scanPayloads } from './content-rules.mjs';
export { createGate } from './gate.mjs';
export { ORG_ENVELOPE_SCHEMA, effectiveDecision, loadOrgPolicy, verifyEnvelope } from './org-policy.mjs';
export { createScopeLedger } from './scope-ticket.mjs';
export { evaluateProcessRules } from './process-rules.mjs';
export { buildAuditRecord, createAuditBarrier } from './audit.mjs';
export { createConfirmationLedger } from './confirmations.mjs';
export { authorizeDelegation, createDelegation, resumeDelegation, revokeDelegation } from './delegation.mjs';
export { assertNoCanary, confirmationScope, decideEgress, digestContent, renderEgressScope } from './egress.mjs';
export { matchProtected, resolveProtectedRoots } from './paths.mjs';

export { Config, validateConfig, registerCommand } from './installer.mjs';

// Real native bridges; the shared installer never discovers IAM test sources.
export function apply(ctx, rawConfig = {}) {
  return installPolicy(ctx, rawConfig, {
    guard: (callback) => ctx.tools.guard(callback),
    pre: (callback) => ctx.on('tools/pre-execute', callback),
  });
}
