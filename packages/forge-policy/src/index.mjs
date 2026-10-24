/**
 * `@heluo/forge-policy`：受控动作目录、command/tool 统一门禁、受保护路径、C3 外发确认、
 * 有限委托与可信确认生命周期。
 *
 * 挂载时编译目录并注册 guard 与 `tools/pre-execute` 监听器；目录无效、策略服务
 * 已被占用或宿主缺少必要 seam 时拒绝挂载（fail closed），不做"降级为只读"。
 * 业务工具插件对该服务声明硬依赖，因此策略不可用时它们的入口根本不存在。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createObservationRuntime } from './observe.mjs';

import { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
import {
  assertEnabledEntriesApproved,
  compileApprovals,
  decideApproval,
  PolicyApprovalError,
} from './approvals.mjs';
import { createGate } from './gate.mjs';
import { createAuditBarrier } from './audit.mjs';
import { createConfirmationLedger } from './confirmations.mjs';
import { authorizeDelegation, createDelegation, resumeDelegation, revokeDelegation } from './delegation.mjs';
import { assertNoCanary, confirmationScope, decideEgress, digestContent, renderEgressScope } from './egress.mjs';
import { matchProtected, resolveProtectedRoots } from './paths.mjs';

export const name = 'forge-policy';
export const inject = ['tools'];

export { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
export {
  APPROVAL_FIELDS,
  APPROVAL_REASONS,
  assertEnabledEntriesApproved,
  compileApprovals,
  decideApproval,
  needsApproval,
  PolicyApprovalError,
} from './approvals.mjs';
export { createGate } from './gate.mjs';
export { buildAuditRecord, createAuditBarrier } from './audit.mjs';
export { createConfirmationLedger } from './confirmations.mjs';
export { authorizeDelegation, createDelegation, resumeDelegation, revokeDelegation } from './delegation.mjs';
export { assertNoCanary, confirmationScope, decideEgress, digestContent, renderEgressScope } from './egress.mjs';
export { matchProtected, resolveProtectedRoots } from './paths.mjs';

const SERVICE_KEY = 'policy';
// 宿主若已提供 OTel/OTLP 出口，就挂在这个服务名下；本仓库不发明端点或认证。
const OBSERVATION_SINK_KEY = 'observationSink';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 宿主自有解析器（`@deepseek-ai/dsh-home-paths`）在插件内不可导入（实测），
 * 因此按宿主契约使用环境变量，并在 `$DSH_HOME` 缺席时回落到宿主默认的 `~/.dsh`。
 */
function defaultProtectedPaths() {
  return ['$DSH_HOME/**'];
}

function defaultTemplateValues() {
  return { DSH_HOME: join(homedir(), '.dsh') };
}

/**
 * @param {unknown} input raw plugin config
 * @returns {{value: object} | {issues: string[]}}
 */
export function validateConfig(input = {}) {
  if (!isPlainObject(input)) return { issues: ['config must be an object'] };
  const issues = [];
  const catalog = input.catalog ?? [];
  if (!Array.isArray(catalog)) issues.push('catalog must be an array');
  for (const [label, mapping] of [['tools', input.tools], ['categories', input.categories]]) {
    if (mapping === undefined) continue;
    if (!isPlainObject(mapping)) {
      issues.push(`${label} must be an object mapping a tool name to an action id`);
      continue;
    }
    for (const [toolName, action] of Object.entries(mapping)) {
      if (typeof action !== 'string' || action.trim().length === 0) {
        issues.push(`${label}.${toolName} must name an action id`);
      }
    }
  }
  if (input.onDecision !== undefined && typeof input.onDecision !== 'function') {
    issues.push('onDecision must be a function');
  }
  if (input.protectedPaths !== undefined && !Array.isArray(input.protectedPaths)) {
    issues.push('protectedPaths must be an array of protected roots');
  }
  if (input.approvals !== undefined && !Array.isArray(input.approvals)) {
    issues.push('approvals must be an array of approval entries');
  }
  if (input.env !== undefined && !isPlainObject(input.env)) {
    issues.push('env must be an object when provided');
  }
  if (input.audit !== undefined && !isPlainObject(input.audit)) {
    issues.push('audit must be an object when provided');
  }
  if (isPlainObject(input.audit) && input.audit.sink !== undefined && !['none', 'memory'].includes(input.audit.sink)) {
    issues.push('audit.sink must be none or memory');
  }
  // 过程观察只开放"是否启用"：端点、认证与响应格式不由本仓库发明（见指标事件契约 §5.1），
  // 发送方必须来自宿主已存在的服务。
  if (input.observation !== undefined && !isPlainObject(input.observation)) {
    issues.push('observation must be an object when provided');
  }
  if (isPlainObject(input.observation) && input.observation.enums !== undefined) {
    // 已登记枚举：只接受"名称 → 非空字符串数组"，避免把自由文本当枚举来源。
    if (!isPlainObject(input.observation.enums)) issues.push('observation.enums must be an object');
    else {
      for (const [name, values] of Object.entries(input.observation.enums)) {
        if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
          issues.push(`observation.enums.${name} must be an array of non-empty strings`);
        }
      }
    }
  }
  if (isPlainObject(input.observation) && input.observation.export !== undefined) {
    const exportConfig = input.observation.export;
    if (!isPlainObject(exportConfig)) issues.push('observation.export must be an object');
    else {
      if (exportConfig.enabled !== undefined && typeof exportConfig.enabled !== 'boolean') {
        issues.push('observation.export.enabled must be a boolean');
      }
      if (exportConfig.idempotentProvider !== undefined && typeof exportConfig.idempotentProvider !== 'boolean') {
        issues.push('observation.export.idempotentProvider must be a boolean');
      }
      if (exportConfig.batchSize !== undefined && !(Number.isInteger(exportConfig.batchSize) && exportConfig.batchSize > 0)) {
        issues.push('observation.export.batchSize must be a positive integer');
      }
    }
  }
  if (issues.length > 0) return { issues };
  return {
    value: {
      catalog,
      approvals: input.approvals ?? [],
      tools: input.tools ?? {},
      categories: input.categories ?? {},
      protectedPaths: input.protectedPaths ?? defaultProtectedPaths(),
      audit: input.audit ?? {},
      observation: input.observation ?? {},
      env: input.env,
      onDecision: input.onDecision,
    },
  };
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'heluo',
    validate: validateConfig,
  },
};

/**
 * Register one business command whose handler runs only after the same action
 * decision the tool face uses. A refused or unconfirmed action returns an error
 * result without invoking the handler, so the command face has no side effect.
 *
 * @param {object} commandCtx context providing `commands`
 * @param {object} service the mounted policy service
 * @param {{name: string, action: string, description: string, handler: Function}} definition
 * @returns {Function} disposer removing the command
 */
export function registerCommand(commandCtx, service, definition) {
  const { name: commandName, action, description, handler } = definition ?? {};
  if (typeof commandName !== 'string' || commandName.length === 0) {
    throw new PolicyCatalogError('command name is required', 'POLICY_COMMAND_INVALID');
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new PolicyCatalogError(`command "${commandName}" needs a description`, 'POLICY_COMMAND_INVALID');
  }
  if (typeof handler !== 'function') {
    throw new PolicyCatalogError(`command "${commandName}" needs a handler`, 'POLICY_COMMAND_INVALID');
  }
  if (!service.catalog.has(action)) {
    throw new PolicyCatalogError(`command "${commandName}" names unregistered action "${action}"`, 'POLICY_COMMAND_ACTION_UNKNOWN', { action });
  }
  if (service.catalog.get(action).enabled !== true) {
    throw new PolicyCatalogError(`command "${commandName}" names disabled action "${action}"`, 'POLICY_COMMAND_ACTION_DISABLED', { action });
  }
  const commands = typeof commandCtx.get === 'function' ? commandCtx.get('commands') : undefined;
  if (commands === undefined || typeof commands.register !== 'function') {
    throw new PolicyCatalogError('host has no commands service to register this command on', 'POLICY_HOST_UNAVAILABLE');
  }
  return commands.register({
    name: commandName,
    description,
    handler: async (invocation) => {
      const target = typeof invocation?.target === 'string' ? invocation.target : commandName;
      const decision = service.decide({ action, target });
      if (decision.action === 'deny') return { kind: 'error', text: decision.reason };
      if (decision.action === 'confirm') {
        const approval = typeof commandCtx.get === 'function' ? commandCtx.get('approval') : undefined;
        if (approval === undefined || invocation?.agent === undefined) {
          return { kind: 'error', text: `${decision.reason}: no approval channel is available for this command` };
        }
        let outcome;
        try {
          outcome = await approval.request({
            agent: invocation.agent,
            toolName: `/${commandName}`,
            callId: invocation.commandId,
            reason: decision.reason,
            signal: invocation.signal,
          });
        } catch (error) {
          return { kind: 'error', text: `${decision.reason}: approval unavailable (${error?.message ?? error})` };
        }
        if (outcome !== 'allowed-once') return { kind: 'error', text: `${decision.reason}: ${outcome}` };
      }
      return await handler(invocation);
    },
  });
}

/**
 * @param {object} ctx host plugin context
 * @param {unknown} rawConfig plugin config
 */
export function apply(ctx, rawConfig = {}) {
  const result = validateConfig(rawConfig);
  if ('issues' in result) {
    throw new PolicyCatalogError('policy config is invalid', 'POLICY_CONFIG_INVALID', { issues: result.issues });
  }
  for (const method of ['get', 'provide', 'effect']) {
    if (typeof ctx?.[method] !== 'function') {
      throw new PolicyCatalogError(`ctx.${method} is required`, 'POLICY_HOST_UNAVAILABLE');
    }
  }
  if (typeof ctx.tools?.guard !== 'function') {
    throw new PolicyCatalogError('ctx.tools.guard is required to install the hard gate', 'POLICY_HOST_UNAVAILABLE');
  }
  const existing = ctx.get(SERVICE_KEY);
  if (existing !== undefined && existing !== null) {
    throw new PolicyCatalogError('another policy service is already mounted', 'POLICY_SERVICE_CONFLICT');
  }

  const config = result.value;
  const catalog = compileCatalog(config.catalog);
  // 登记 ≠ 批准：没有有效台账条目的写/确认动作不许被置为 enabled（挂载即拒绝）。
  const approvals = compileApprovals(config.approvals);
  assertEnabledEntriesApproved(catalog, approvals);
  const env = config.env ?? { ...defaultTemplateValues(), ...process.env };
  const protectedRoots = resolveProtectedRoots(config.protectedPaths, env);
  const auditRecords = [];
  const auditSink =
    config.audit.sink === 'memory'
      ? { durable: false, append: (record) => void auditRecords.push(record) }
      : undefined;
  const audit = createAuditBarrier({
    sink: auditSink,
    timeoutMs: config.audit.timeoutMs,
    allowNonDurable: config.audit.allowNonDurable === true,
    onGap: (gap) => auditRecords.push({ ...gap, phase: 'gap' }),
  });
  const gate = createGate({
    catalog,
    tools: config.tools,
    categories: config.categories,
    protectedRoots,
    audit,
    onDecision: config.onDecision,
  });

  // 过程观察默认关闭：未显式启用时不建缓冲、不查发送方、不发送任何事件。
  const observations = createObservationRuntime({
    config: config.observation,
    getSink: () => (typeof ctx.get === 'function' ? ctx.get(OBSERVATION_SINK_KEY) : undefined),
    sourceVersion: config.observation.sourceVersion,
  });

  let disposed = false;
  const teardown = () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
    disposeProvide?.();
  };
  const disposers = [];
  disposers.push(ctx.tools.guard((exec) => gate.guard(exec)));
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('tools/pre-execute', (exec, next) => gate.preExecute(ctx, exec, next)));
    // 宿主签名：`tools/post-execute` waterfall 为 (exec, result, next)，默认决议 `{ kind: 'accept' }`。
    disposers.push(
      ctx.on('tools/post-execute', async (exec, result, next) => {
        await gate.postExecute(exec, result);
        return typeof next === 'function' ? await next() : { kind: 'accept' };
      }),
    );
  }

  const confirmations = createConfirmationLedger();
  const service = Object.freeze({
    catalog,
    actions: () => [...catalog.keys()],
    decide: (request) => decideAction({ catalog, ...request }),
    authorize: (toolName, request) => gate.check(toolName, request),
    protectedPaths: () => protectedRoots.map((entry) => entry.raw),
    checkPath: (candidate) => matchProtected(candidate, protectedRoots),
    decideEgress,
    confirmationScope,
    renderEgressScope,
    digestContent,
    assertNoCanary,
    createDelegation,
    revokeDelegation,
    resumeDelegation: (input) => resumeDelegation(input),
    authorizeDelegation: (request) => authorizeDelegation({ catalog, ...request }),
    issueConfirmation: (input) => confirmations.issue(input),
    consumeConfirmation: (input) => confirmations.consume(input),
    confirmations: () => confirmations.pending(),
    setAuditSink: (sink) => audit.setSink(sink),
    auditRecords: () => [...auditRecords],
    auditGaps: () => audit.gaps(),
    acknowledgeAuditGaps: () => audit.acknowledgeGaps(),
    auditDegraded: () => audit.isDegraded(),
    registerCommand: (commandCtx, definition) => registerCommand(commandCtx, service, definition),
    observations: () => observations,
    approvals: () => [...approvals.values()],
    approvalFor: (action, query = {}) => decideApproval({ approvals, action, ...query }),
  });
  const disposeProvide = ctx.provide(SERVICE_KEY, service);

  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect(() => teardown);
  return teardown;
}
