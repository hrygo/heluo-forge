import { homedir } from 'node:os';
import { join } from 'node:path';

import { createObservationRuntime } from './observe.mjs';

import { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
import { compileContentRules } from './content-rules.mjs';
import { createGate } from './gate.mjs';
import { createAuditBarrier, createFileSink, createMemorySink } from './audit.mjs';
import { loadOrgPolicy } from './org-policy.mjs';
import { matchProtected, resolveProtectedRoots } from './paths.mjs';
import { buildPipeline, isObserveOnly } from './pipeline.mjs';
import { Config, resolveConfig, validateConfig } from './config.mjs';

export { Config, validateConfig };

const SERVICE_KEY = 'policy';
// 宿主若已提供 OTel/OTLP 出口，就挂在这个服务名下；本仓库不发明端点或认证。
const OBSERVATION_SINK_KEY = 'observationSink';
// 流程事实（变更状态、计划确认）由宿主既有服务提供；缺席时判为"未判定"。
const PROCESS_FACTS_KEY = 'processFacts';

const OBSERVE_ONLY_NOTICE = '[forge-policy] 8 项策略开关均为关闭，当前为 observe-only：只记录受控执行的凭据，不拦截内容、路径、流程或确认。';

// 路径规则的默认受保护根（9 类，按宿主占位符展开）。P0 只保留配置面与展示。
const DEFAULT_PROTECTED_PATHS = Object.freeze(['$DSH_HOME/**']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 宿主自有解析器（`@deepseek-ai/dsh-home-paths`）在插件内不可导入（实测），
 * 因此按宿主契约使用环境变量，并在 `$DSH_HOME` 缺席时回落到宿主默认的 `~/.dsh`。
 */
function defaultTemplateValues() {
  return { DSH_HOME: join(homedir(), '.dsh') };
}

/**
 * 已认证身份来自 IAM 的只读视图。视图缺席、未登录或状态异常时返回 undefined：
 * 受控写随之拒绝，未登记动作不受影响（不回退到"匿名但放行"）。
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
  const value = service.read(request);
  return isPlainObject(value) ? value : {};
}

/**
 * Register one business command whose handler runs only after the same action
 * decision the tool face uses. A refused action returns an error result without
 * invoking the handler, so the command face has no side effect.
 *
 * @param {object} commandCtx context providing `commands`
 * @param {object} service the mounted policy service
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
  if (service.catalog.get(action).category === 'human-record') {
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
 * @param {{orgPolicy?: object, getActor?: Function, log?: Function}} [overrides]
 *   `overrides` 只用于测试装配：生产调用不传，组织信封从包内 `policy/` 读取。
 */
export function installPolicy(ctx, rawConfig, native, owned, overrides = {}) {
  const config = resolveConfig(rawConfig);
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

  const catalog = compileCatalog(config.catalog);
  const org = overrides.orgPolicy ?? loadOrgPolicy();
  // 组织信封里的内容规则在 P0 不参与判定，只作为受控配置的展示位保留。
  let contentRules;
  try {
    contentRules = compileContentRules(org.state === 'verified' ? org.contentRules : []).rules;
  } catch (error) {
    throw new PolicyCatalogError('content rules cannot be compiled', 'POLICY_CONTENT_RULE_LIMIT', { reason: error?.message ?? String(error) });
  }
  // 组织信封可强制持久审计：`require_durable_audit` 为真时只接受文件 sink。
  if (org.state === 'verified' && org.processRules?.require_durable_audit === true && config.audit.sink !== 'file') {
    throw new PolicyCatalogError('organization policy requires a durable audit sink: set audit.sink to "file"', 'POLICY_AUDIT_NOT_DURABLE');
  }

  const env = { ...defaultTemplateValues(), ...process.env, ...(config.env ?? {}) };
  // 受保护路径在 P0 不参与判定（protectPaths 未实现），这里只解出默认根供服务上的
  // `checkPath` 查询用；配置层的 `protectedPaths` 与 `paths.append` 已在装载期拒绝。
  const protectedRoots = resolveProtectedRoots(DEFAULT_PROTECTED_PATHS, env);
  const memorySink = config.audit.sink === 'memory' ? createMemorySink({ buffer: config.audit.buffer }) : undefined;
  const fileSink = config.audit.sink === 'file'
    ? createFileSink({ dir: join(env.DSH_HOME, 'logs'), keepDays: config.audit.keepDays })
    : undefined;
  const audit = createAuditBarrier({
    sink: fileSink ?? memorySink,
    timeoutMs: config.audit.timeoutMs,
  });

  const pipeline = buildPipeline(config.rules);
  const getActor = overrides.getActor ?? (() => readActor(ctx));
  const gate = createGate({
    catalog,
    rules: config.rules,
    pipeline,
    audit,
    tools: config.tools,
    getActor,
    onDecision: config.onDecision,
  });

  // 过程观察默认关闭：未显式启用时不建缓冲、不查发送方、不发送任何事件。
  const observations = createObservationRuntime({
    config: config.observation,
    getSink: () => (typeof ctx.get === 'function' ? ctx.get(OBSERVATION_SINK_KEY) : undefined),
    sourceVersion: config.observation?.sourceVersion,
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
  disposers.push(native.guard((exec) => (owned ? owned.guard(gate, exec) : gate.guard(exec))));
  if (typeof ctx.on === 'function') {
    disposers.push(native.pre((exec, next) => (owned ? owned.preExecute(gate, ctx, exec, next) : gate.preExecute(ctx, exec, next))));
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

  // 全关后只留一条 observe-only 诊断：不是拦截，也不写盘。
  if (isObserveOnly(config.rules)) {
    const warn = overrides.log ?? (typeof ctx.logger?.warn === 'function' ? (message) => ctx.logger.warn(message) : undefined);
    warn?.(OBSERVE_ONLY_NOTICE);
  }

  const service = Object.freeze({
    catalog,
    actions: () => [...catalog.keys()],
    decide: (request) => decideAction({ catalog, rules: config.rules, ...request }),
    authorize: (toolName, request) => gate.check(toolName, request),
    protectedPaths: () => protectedRoots.map((entry) => entry.raw),
    checkPath: (candidate) => matchProtected(candidate, protectedRoots),
    orgPolicy: () => (org.state === 'verified'
      ? { state: org.state, policyVersion: org.policyVersion, issuedBy: org.issuedBy, issuedAt: org.issuedAt, digest: org.digest, keyId: org.keyId }
      : { state: org.state, reason: org.reason }),
    policyVersion: () => (org.state === 'verified' ? org.policyVersion : 'builtin'),
    mode: () => (org.state === 'verified' ? 'managed' : 'personal'),
    contentRuleIds: () => contentRules.map((rule) => rule.id),
    setAuditSink: (sink) => audit.setSink(sink),
    auditRecords: () => (memorySink === undefined ? [] : memorySink.records()),
    auditGaps: () => audit.gaps(),
    acknowledgeAuditGaps: () => audit.acknowledgeGaps(),
    auditDegraded: () => audit.isDegraded(),
    executeAction: (commandCtx, action, exec, operation) => (owned ? owned.executeAction(gate, commandCtx, action, exec, operation) : gate.executeAction(commandCtx, action, exec, operation)),
    registerCommand: (commandCtx, definition) => registerDefinition(commandCtx, service, definition, owned),
    observations: () => observations,
  });
  const disposeProvide = ctx.provide(SERVICE_KEY, service);

  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect(() => teardown);
  return teardown;
}
