/**
 * `@heluo/forge-policy`：受控动作目录、command/tool 统一门禁、受保护路径与 C3 外发确认。
 *
 * 挂载时编译目录并注册 guard 与 `tools/pre-execute` 监听器；目录无效、策略服务
 * 已被占用或宿主缺少必要 seam 时拒绝挂载（fail closed），不做"降级为只读"。
 * 业务工具插件对该服务声明硬依赖，因此策略不可用时它们的入口根本不存在。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
import { createGate } from './gate.mjs';
import { assertNoCanary, confirmationScope, decideEgress, digestContent, renderEgressScope } from './egress.mjs';
import { matchProtected, resolveProtectedRoots } from './paths.mjs';

export const name = 'forge-policy';
export const inject = ['tools'];

export { compileCatalog, decideAction, PolicyCatalogError } from './catalog.mjs';
export { createGate } from './gate.mjs';
export { assertNoCanary, confirmationScope, decideEgress, digestContent, renderEgressScope } from './egress.mjs';
export { matchProtected, resolveProtectedRoots } from './paths.mjs';

const SERVICE_KEY = 'policy';

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
  if (input.env !== undefined && !isPlainObject(input.env)) {
    issues.push('env must be an object when provided');
  }
  if (issues.length > 0) return { issues };
  return {
    value: {
      catalog,
      tools: input.tools ?? {},
      categories: input.categories ?? {},
      protectedPaths: input.protectedPaths ?? defaultProtectedPaths(),
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
  const env = config.env ?? { ...defaultTemplateValues(), ...process.env };
  const protectedRoots = resolveProtectedRoots(config.protectedPaths, env);
  const gate = createGate({
    catalog,
    tools: config.tools,
    categories: config.categories,
    protectedRoots,
    onDecision: config.onDecision,
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
  }

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
    registerCommand: (commandCtx, definition) => registerCommand(commandCtx, service, definition),
  });
  const disposeProvide = ctx.provide(SERVICE_KEY, service);

  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect(() => teardown);
  return teardown;
}
