import { join } from 'node:path';

import { createObservationRuntime } from './observe.mjs';

import { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
import { compileContentRules } from './content-rules.mjs';
import { createConfirmationGateway } from './confirm.mjs';
import { createGate } from './gate.mjs';
import { createDecisionCache } from './reuse.mjs';
import { createAuditBarrier, createFileSink, createMemorySink } from './audit.mjs';
import { loadOrgPolicy } from './org-policy.mjs';
import { canonicalize, judgeProtectedPath, matchProtected, resolveProtectedRoots, templateEnv } from './paths.mjs';
import { STORE_DIRECTORY_ENV, storeRootsFrom } from './store-protection.mjs';
import { buildPipeline, isObserveOnly } from './pipeline.mjs';
import { Config, PolicyConfigError, collectPathTemplates, resolveConfig, validateConfig } from './config.mjs';
import { registerAuditCommand } from './audit-command.mjs';

export { Config, validateConfig };

const SERVICE_KEY = 'policy';
// 宿主若已提供 OTel/OTLP 出口，就挂在这个服务名下；本仓库不发明端点或认证。
const OBSERVATION_SINK_KEY = 'observationSink';
// 流程事实（变更状态、计划确认）由宿主既有服务提供；缺席时判为"未判定"。
const PROCESS_FACTS_KEY = 'processFacts';

const OBSERVE_ONLY_NOTICE = '[forge-policy] 7 项策略开关均为关闭，当前为 observe-only：只记录受控执行的凭据，不拦截内容、路径、流程或确认；IAM 存档/取票守卫不受开关控制，仍随 credentials-store-location 服务生效。';

// 逐次确认需要宿主的 userQuestions 服务；缺席时装载照常成功，每次需要卡片的写都会拒绝。
const CONFIRMATION_UNAVAILABLE_NOTICE = '[forge-policy] 已启用 confirmPush/confirmDopWrite，但宿主没有可用的 userQuestions 服务：需要人工确认的受控写会一律以 POLICY_CONFIRM_UNAVAILABLE 拒绝（不降级为直接放行）。';

/** 宿主确认通道是否可用：只在真正需要卡片时读取，不缓存结论。 */
function hasConfirmationChannel(ctx) {
  const service = typeof ctx?.get === 'function' ? ctx.get('userQuestions') : undefined;
  return isPlainObject(service) && typeof service.ask === 'function';
}

// 受保护路径的默认配置为空：九类名称在会话工作区内恒生效，配置只能追加范围，
// 不能再靠一个默认 `$DSH_HOME/**` 把"工作区内九类"覆盖掉或静默缩小。
const DEFAULT_PROTECTED_PATHS = Object.freeze([]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

  const env = templateEnv(config.env);
  // 两层模板合并后按同一基线展开：九类名称固定生效，配置只能追加受保护范围。
  // 展开失败已在 `validateConfig` 与 L1 问题一起报过；这里保留防御性汇总，避免装配到一半。
  const configuredTemplates = collectPathTemplates(config);
  let protectedRoots;
  try {
    protectedRoots = resolveProtectedRoots([...DEFAULT_PROTECTED_PATHS, ...configuredTemplates], env);
  } catch (error) {
    throw new PolicyConfigError([
      `protectedPaths/paths.append: 模板 ${error?.details?.template ?? 'protectedPaths/paths.append'} 无法展开（${error?.code ?? 'POLICY_CONFIG_INVALID'}）`,
    ]);
  }
  const memorySink = config.audit.sink === 'memory' ? createMemorySink({ buffer: config.audit.buffer }) : undefined;
  const fileSink = config.audit.sink === 'file'
    ? createFileSink({ dir: join(env.DSH_HOME, 'logs'), keepDays: config.audit.keepDays })
    : undefined;
  const audit = createAuditBarrier({
    sink: fileSink ?? memorySink,
    timeoutMs: config.audit.timeoutMs,
  });

  // IAM 存档/取票守卫不绑定规则开关：内置凭据后端提供 `credentials-store-location` 即生效。
  // Cordis 的服务只在声明 inject 的作用域可见，且条目按并行 fiber 装配，因此这里无条件
  // 注册注入回调，服务出现即 arm；服务始终缺席（例如 engineering 单装、没有内置凭据后端）
  // 时守卫不生效，等价于关闭。arm 失败（目录与环境变量不一致）只降级为指纹兜底。
  const storeGuard = { available: false, roots: [] };
  const warnStore = (message) => {
    if (typeof overrides.log === 'function') overrides.log(message);
    else if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message);
  };
  // 每次 arm 递增一个代号：位置服务被替换时新代号生效，旧作用域的清理回调
  // 只回收自己那一次快照，不会把新目录清空（移除 → 替换的时序由调用方决定）。
  let storeEpoch = 0;
  const armStore = (location) => {
    if (location === undefined || location === null) return undefined;
    const epoch = (storeEpoch += 1);
    let roots = [];
    try {
      const declared = process.env[STORE_DIRECTORY_ENV];
      if (typeof declared === 'string' && declared.trim() !== '') {
        if (canonicalize(declared) !== canonicalize(String(location.directory))) {
          throw new PolicyCatalogError(
            'HELUO_FORGE_STORE_DIRECTORY disagrees with the keychain store location',
            'POLICY_STORE_DIRECTORY_CONFLICT',
          );
        }
      } else if (location.isDefault !== true) {
        throw new PolicyCatalogError(
          'the keychain store directory is custom while HELUO_FORGE_STORE_DIRECTORY is unset; the CLI would open the platform default directory',
          'POLICY_STORE_DIRECTORY_CONFLICT',
        );
      }
      roots = storeRootsFrom(location);
    } catch (error) {
      warnStore(`the IAM store location cannot be armed (${error?.code ?? 'POLICY_STORE_LOCATION_INVALID'}); the gate falls back to store file/directory fingerprints`);
    }
    storeGuard.available = true;
    storeGuard.roots = roots;
    return epoch;
  };

  const pipeline = buildPipeline(config.rules);
  const getActor = overrides.getActor ?? (() => readActor(ctx));
  const confirmations = overrides.confirmations ?? createConfirmationGateway({ timeoutMs: config.confirmation.timeoutMs });
  const decisionCache = overrides.decisionCache ?? createDecisionCache();
  // 日志出口：装载诊断与流程规则求值失败共用，走宿主 logger 或覆盖项。
  const warn = overrides.log ?? (typeof ctx.logger?.warn === 'function' ? (message) => ctx.logger.warn(message) : undefined);
  const gate = createGate({
    catalog,
    rules: config.rules,
    pipeline,
    audit,
    tools: config.tools,
    getActor,
    onDecision: config.onDecision,
    warn,
    confirmations,
    decisionCache,
    timeoutMs: config.confirmation.timeoutMs,
    maxContentBytes: config.content.maxBytes,
    protectedRoots,
    storeGuard,
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
    // 卸载顺序：先收掉挂起的确认（不留悬挂 Promise），再清会话内缓存，最后关审计。
    confirmations.dispose();
    decisionCache.clear();
    gate.dispose();
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
    disposeProvide?.();
  };
  // 只读命令：没有 commands 服务时是空操作，不阻断挂载；disposer 跟随卸载顺序回收。
  const disposeAuditCommand = registerAuditCommand(ctx, { audit });
  const disposers = [];
  if (typeof ctx.inject === 'function') {
    // 服务就绪后 arm；服务始终缺席时守卫保持关闭（与 engineering 单装的验收口径一致）。
    // 服务被移除时清理回到未 arm（不判定）；随后以新目录重新提供时按新代号重新 arm。
    const disposeArming = ctx.inject(['credentials-store-location'], (scoped) => {
      const epoch = armStore(scoped.get('credentials-store-location'));
      return () => {
        if (epoch === undefined || storeEpoch !== epoch) return;
        storeGuard.available = false;
        storeGuard.roots = [];
      };
    });
    if (typeof disposeArming === 'function') disposers.push(disposeArming);
  } else {
    armStore(ctx.get('credentials-store-location'));
  }
  if (typeof disposeAuditCommand === 'function') disposers.push(disposeAuditCommand);
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
  if (isObserveOnly(config.rules)) warn?.(OBSERVE_ONLY_NOTICE);
  // 需要卡片的开关已开、宿主却没有确认通道：装载仍成功，但每次需要卡片的写都会拒绝。
  const injectedChannel = overrides.confirmations !== undefined;
  if ((config.rules.confirmPush === true || config.rules.confirmDopWrite === true) && !injectedChannel && !hasConfirmationChannel(ctx)) {
    warn?.(CONFIRMATION_UNAVAILABLE_NOTICE);
  }

  // 路径判定的两副面孔：`checkPath` 保持既往的布尔契约，`judgePath` 给需要区分
  // "不判" 与 "判了但不受保护" 的调用方。两者共用同一份判定，结论不会漂移。
  const judgePathOf = (candidate, workspaceRoot) => {
    if (workspaceRoot === undefined) {
      const result = matchProtected(candidate, protectedRoots);
      if (!result.protected) return Object.freeze({ judged: false, protected: false });
      return Object.freeze({ judged: true, protected: true, category: `root:${result.root}` });
    }
    const result = judgeProtectedPath(candidate, { workspaceRoot, roots: protectedRoots });
    if (!result.judged) return Object.freeze({ judged: false, protected: false });
    return Object.freeze({
      judged: true,
      protected: result.protected === true,
      ...(result.category === undefined ? {} : { category: result.category }),
    });
  };

  const service = Object.freeze({
    catalog,
    actions: () => [...catalog.keys()],
    decide: (request) => decideAction({ catalog, rules: config.rules, ...request }),
    authorize: (toolName, request) => gate.check(toolName, request),
    /** 配置追加的模板（展开前原文）；九类名称在代码里恒开，不出现在这里。 */
    protectedPaths: () => configuredTemplates,
    /** IAM 存档受保护根（库目录与密钥目录）；未启用时为空。 */
    storeDirectories: () => storeGuard.roots.map((entry) => entry.raw),
    /** 存档判定查询（布尔面）：`true` 表示已判定且落在存档根内。 */
    checkStore: (candidate) => matchProtected(candidate, storeGuard.roots).protected === true,
    /**
     * 路径判定查询（布尔面，沿用既有契约）：`true` 表示"已判定且受保护"。
     * 判定不了的路径（工作区外、形状不合法）返回 `false`——查询方拿不到保护依据时
     * 不能把它当"受保护"。需要区分两种 false 请用 `judgePath`。
     */
    checkPath: (candidate, workspaceRoot) => judgePathOf(candidate, workspaceRoot).protected === true,
    /**
     * 路径判定查询（明细面）：给工作区根时按"工作区内九类 + 配置追加根"判定；不给时
     * 只判追加根，因为九类名称只在会话工作区内生效。
     */
    judgePath: (candidate, workspaceRoot) => judgePathOf(candidate, workspaceRoot),
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
    /** 宿主确认通道此刻是否可用（不含"曾经可用"的推断）。 */
    confirmationAvailable: () => injectedChannel || hasConfirmationChannel(ctx),
    /** 会话内决策缓存条目数：复用只活在内存里，卸载即空。 */
    decisionCacheSize: () => decisionCache.size(),
    executeAction: (commandCtx, action, exec, operation) => (owned ? owned.executeAction(gate, commandCtx, action, exec, operation) : gate.executeAction(commandCtx, action, exec, operation)),
    registerCommand: (commandCtx, definition) => registerDefinition(commandCtx, service, definition, owned),
    observations: () => observations,
  });
  const disposeProvide = ctx.provide(SERVICE_KEY, service);

  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect(() => teardown);
  return teardown;
}
