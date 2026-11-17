import { homedir } from 'node:os';
import { join } from 'node:path';

import { createObservationRuntime } from './observe.mjs';

import { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
import { strictestDecision } from './classify.mjs';
import { compileContentRules } from './content-rules.mjs';
import { createGate } from './gate.mjs';
import { createAuditBarrier } from './audit.mjs';
import { createConfirmationLedger } from './confirmations.mjs';
import { authorizeDelegation, createDelegation, resumeDelegation, revokeDelegation } from './delegation.mjs';
import { assertNoCanary, confirmationScope, decideEgress, digestContent, renderEgressScope } from './egress.mjs';
import { effectiveDecision, loadOrgPolicy } from './org-policy.mjs';
import { matchProtected, resolveProtectedRoots } from './paths.mjs';
import { createScopeLedger } from './scope-ticket.mjs';

const SERVICE_KEY = 'policy';
// 宿主若已提供 OTel/OTLP 出口，就挂在这个服务名下；本仓库不发明端点或认证。
const OBSERVATION_SINK_KEY = 'observationSink';
// 流程事实（变更状态、计划确认）由宿主既有服务提供；缺席时判为"未判定"。
const PROCESS_FACTS_KEY = 'processFacts';

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
  // 逐动作审批台账已被策略级批准取代：旧配置直接拒绝挂载，连同旧语义一起停止。
  if (input.approvals !== undefined) {
    issues.push('approvals is no longer accepted; approval is bound to the signed policy envelope (see docs/design/plugins/forge-policy.md §5.1.2)');
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
 * 已认证身份来自 IAM 的只读视图。视图缺席、未登录或状态异常时返回 undefined：
 * 写动作随之拒绝，只读动作不受影响（不回退到"匿名但放行"）。
 */
function readActor(ctx) {
  const iam = typeof ctx?.get === 'function' ? ctx.get('iam') : undefined;
  if (iam === undefined || iam === null) return undefined;
  let view;
  try {
    view = typeof iam.getView === 'function' ? iam.getView() : undefined;
  } catch {
    return undefined;
  }
  if (!isPlainObject(view)) return undefined;
  if (view.signedIn === false || view.state === 'error' || view.state === 'signed-out') return undefined;
  const principal = view.principal;
  if (typeof principal === 'string' && principal.trim().length > 0) return principal;
  if (isPlainObject(principal) && typeof principal.subject === 'string' && principal.subject.length > 0) return principal.subject;
  return undefined;
}

/**
 * 流程事实源：宿主既有服务给出的变更状态与计划确认。缺席即"未判定"，
 * 不阻止动作；只有断言"不可用"的事实才被当作未判定而非否定。
 */
function readFactSources(ctx, request = {}) {
  const service = typeof ctx?.get === 'function' ? ctx.get(PROCESS_FACTS_KEY) : undefined;
  if (service === undefined || service === null) return {};
  if (typeof service.read !== 'function') return {};
  try {
    const value = service.read(request);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Register one business command whose handler runs only after the same action
 * decision the tool face uses. A refused or unconfirmed action returns an error
 * result without invoking the handler, so the command face has no side effect.
 *
 * @param {object} commandCtx context providing `commands`
 * @param {object} service the mounted policy service
 * Simple commands use their explicit raw-input target. Structured/path-bearing
 * commands supply a trusted resolveArguments(invocation) parser; the normalized
 * arguments are also passed to the body as its second argument. A command name
 * never substitutes for a missing business resource.
 *
 * @param {{name: string, action: string, description: string, handler: Function, resolveArguments?: Function}} definition
 * @returns {Function} disposer removing the command
 */
export function registerCommand(commandCtx, service, definition) {
  return registerDefinition(commandCtx, service, definition);
}

function registerDefinition(commandCtx, service, definition, owned) {
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
  if (service.catalog.get(action).decision === 'deny') {
    throw new PolicyCatalogError(`command "${commandName}" names action "${action}" that is reserved for human-written records`, 'POLICY_COMMAND_ACTION_RESERVED', { action });
  }
  const commands = typeof commandCtx.get === 'function' ? commandCtx.get('commands') : undefined;
  if (commands === undefined || typeof commands.register !== 'function') {
    throw new PolicyCatalogError('host has no commands service to register this command on', 'POLICY_HOST_UNAVAILABLE');
  }
  return commands.register({
    name: commandName,
    description,
    handler: async (invocation) => {
      let args;
      try {
        args = typeof definition.resolveArguments === 'function'
          ? await definition.resolveArguments(invocation)
          : { target: invocation?.target ?? invocation?.rawInput?.trim(), egress: invocation?.egress, revision: invocation?.revision };
        if (!isPlainObject(args)) return owned?.commandFailure(definition) ?? { kind: 'error', text: 'command arguments cannot be verified' };
      } catch {
        return owned?.commandFailure(definition) ?? { kind: 'error', text: 'command arguments cannot be verified' };
      }
      const exec = {
        name: `/${commandName}`,
        arguments: args,
        agent: invocation?.agent,
        callId: invocation?.commandId,
        signal: invocation?.signal,
      };
      const operation = owned?.commandOperation(definition, exec, invocation, args) ?? (() => handler(invocation, args));
      return await service.executeAction(commandCtx, action, exec, operation);
    },
  });
}

/**
 * @param {object} ctx host plugin context
 * @param {unknown} rawConfig plugin config
 * @param {{guard: Function, pre: Function}} native host hooks
 * @param {object} [owned] optional host-specific wiring
 * @param {{orgPolicy?: object, getActor?: Function, getFactSources?: Function, scopeLedger?: object}} [overrides]
 *   `overrides` 只用于测试装配：生产调用不传，组织信封从包内 `policy/` 读取。
 */
export function installPolicy(ctx, rawConfig, native, owned, overrides = {}) {
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
  const org = overrides.orgPolicy ?? loadOrgPolicy();
  // 验签失败只降级写：只读动作仍可用，写动作在 gate 里逐次拒绝并记原因。
  let contentRules;
  try {
    contentRules = compileContentRules(org.state === 'verified' ? org.contentRules : []).rules;
  } catch (error) {
    throw new PolicyCatalogError('content rules cannot be compiled', 'POLICY_CONTENT_RULE_LIMIT', { reason: error?.message ?? String(error) });
  }
  const env = config.env ?? { ...defaultTemplateValues(), ...process.env };
  const protectedRoots = resolveProtectedRoots(config.protectedPaths, env);
  const auditRecords = [];
  const auditSink =
    config.audit.sink === 'memory'
      ? { durable: false, append: (record) => void auditRecords.push(record) }
      : undefined;
  // 组织信封可强制持久审计：要求 durable 时非持久 sink 不再被接受。
  const requireDurable = org.state === 'verified' && org.processRules?.require_durable_audit === 'hard';
  const audit = createAuditBarrier({
    sink: auditSink,
    timeoutMs: config.audit.timeoutMs,
    allowNonDurable: config.audit.allowNonDurable === true && !requireDurable,
    onGap: (gap) => auditRecords.push({ ...gap, phase: 'gap' }),
  });
  const scopeLedger = overrides.scopeLedger ?? createScopeLedger();
  const getActor = overrides.getActor ?? (() => readActor(ctx));
  const getFactSources = overrides.getFactSources ?? ((request) => readFactSources(ctx, request));
  const gate = createGate({
    catalog,
    tools: config.tools,
    categories: config.categories,
    protectedRoots,
    audit,
    onDecision: config.onDecision,
    contentRules,
    org,
    getActor,
    getFactSources,
    scope: scopeLedger,
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
    owned?.dispose();
    gate.dispose();
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
    disposeProvide?.();
  };
  const disposers = [];
  disposers.push(native.guard((exec) => owned ? owned.guard(gate, exec) : gate.guard(exec)));
  if (typeof ctx.on === 'function') {
    disposers.push(native.pre((exec, next) => owned ? owned.preExecute(gate, ctx, exec, next) : gate.preExecute(ctx, exec, next)));
    // 宿主签名：`tools/post-execute` waterfall 为 (exec, result, next)，默认决议 `{ kind: 'accept' }`。
    disposers.push(
      ctx.on('tools/post-execute', async (exec, result, next) => {
        await gate.postExecute(exec, result);
        return typeof next === 'function' ? await next() : { kind: 'accept' };
      }),
    );
    // Final result cannot be short-circuited like the post waterfall. This
    // callback remains synchronous; the gate tracks its settlement promise and
    // blocks the next protected action until it has finished.
    disposers.push(ctx.on('tools/result', (exec, result) => { void gate.postExecute(exec, result); owned?.release(exec); }));
  }

  const confirmations = createConfirmationLedger();
  /** 动作级判定再叠组织上限（只收紧），与 gate 的合成顺序一致。 */
  const composeAction = (request) => {
    const base = decideAction({ catalog, ...request });
    if (base.action === 'deny') return base;
    let capped;
    try {
      capped = effectiveDecision({ action: request?.action, org });
    } catch {
      return { action: 'deny', reason: `action "${request?.action}" cannot be classified`, rule: 'policy-unavailable' };
    }
    const merged = strictestDecision(base.action, capped);
    return merged === base.action
      ? base
      : { ...base, action: merged, rule: 'org-policy-ceiling', reason: `the organization policy holds ${request?.action} at ${capped}` };
  };
  const service = Object.freeze({
    catalog,
    actions: () => [...catalog.keys()],
    decide: (request) => composeAction(request),
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
    scopeTickets: () => scopeLedger.list(),
    revokeScopeTicket: (id) => scopeLedger.revoke(id),
    orgPolicy: () => (org.state === 'verified'
      ? { state: org.state, policyVersion: org.policyVersion, issuedBy: org.issuedBy, issuedAt: org.issuedAt, digest: org.digest, keyId: org.keyId }
      : { state: org.state, reason: org.reason }),
    policyVersion: () => (org.state === 'verified' ? org.policyVersion : 'builtin'),
    mode: () => (org.state === 'verified' ? 'managed' : 'personal'),
    contentRuleIds: () => contentRules.map((rule) => rule.id),
    setAuditSink: (sink) => audit.setSink(sink),
    auditRecords: () => [...auditRecords],
    auditGaps: () => audit.gaps(),
    acknowledgeAuditGaps: () => audit.acknowledgeGaps(),
    auditDegraded: () => audit.isDegraded(),
    executeAction: (commandCtx, action, exec, operation) => owned ? owned.executeAction(gate, commandCtx, action, exec, operation) : gate.executeAction(commandCtx, action, exec, operation),
    registerCommand: (commandCtx, definition) => registerDefinition(commandCtx, service, definition, owned),
    observations: () => observations,
  });
  const disposeProvide = ctx.provide(SERVICE_KEY, service);

  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect(() => teardown);
  return teardown;
}
