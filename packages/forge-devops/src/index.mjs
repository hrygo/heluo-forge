/**
 * `@heluo/forge-devops` 宿主插件装配层（#15 / D4，设计准入见能力面设计 §6.1；T7 装配）。
 *
 * 只做**装配**，不做业务判定：策略门禁判"能不能做"、固定 argv 白名单判"有没有这条命令"、
 * 纯函数流程判"该不该做、做完能否核对"。本文件把三者接起来，并对外暴露 9 个工具、
 * 一个命令面与一个服务。
 *
 * 端口约定（D-1 起本包自己就是生产者，注入键仍然优先）：
 * - 流程协作者（配置 → runner → dop/gh 适配器 → 门禁 → 动作）由 `flow.mjs` 组合并在装配时创建；
 *   宿主若已通过服务键 `devopsFlow` 提供实现，以宿主为准（企业侧替换点，不允许两套同时跑）。
 * - 只读适配器同理：宿主经 `devopsReader` 注入优先；没有注入且运行时配置可用时，用流程协作者自带的
 *   只读面（同一批固定 argv），否则可见地 `no-reader`/`CONFIG_MISSING`，绝不返回空结果冒充成功。
 * - 策略服务是硬依赖：拿不到就不挂载（入口关闭），不提供"无策略只读"的降级档位。
 * - `commands` 不是硬依赖：没有命令面时 `entryStatus` 报 `no-command-face`，工具面照常注册。
 *
 * 顶层不碰 ctx 与 env：环境在 `apply` 内解析（路径与 endpoint 只经环境注入，不硬编码、不落文档）。
 */
import {
  assertReadRequest,
  DevopsReadError,
  normalizeReadResult,
  READ_ACTIONS,
  READ_REASONS,
} from './read.mjs';
import { buildDevopsTools, FLOW_ACTIONS, FLOW_TOOLS, READ_TOOLS } from './tools.mjs';
import { writeArtifact } from './artifacts.mjs';
import { commandFaceStatus, registerEntry } from './entry.mjs';
import { createDevopsFlow } from './flow.mjs';
import { createPolicyGuard } from './policy-guard.mjs';

export const name = 'forge-devops';
// 依赖必须由 inject 声明，cordis 才会等服务就绪后再运行 apply：
// - 少了 `tools`：`ctx.tools` 不可见，工具**静默不注册**；
// - 少了 `policy`：apply 在策略挂载前运行，直接抛 POLICY_REQUIRED 而整项不激活。
// 两种失败模式都由宿主探针（2026-10-24）实测到。策略不在时本项保持 pending（入口关闭），
// 这正是设计 §6.1 要的"硬依赖、不降级"。`commands` 不进 inject：缺命令面不应让整包不挂载。
export const inject = ['tools', 'policy'];

/** 宿主服务键；提供方（企业 CLI 适配器）用它注入只读端口。 */
export const READER_KEY = 'devopsReader';
/** 流程协作者端口：dop/gh 适配器、门禁适配、写动作与上下文卡的装配体。 */
export const FLOW_KEY = 'devopsFlow';
/** 本插件对外暴露的服务键。 */
export const SERVICE_KEY = 'devops';

/** 本插件自身没有默认配置项；一切来自运行时解析（本文件不复制默认值，避免两处漂移）。 */
export const DEFAULT_CONFIG = Object.freeze({});

/**
 * 运行时配置键：装配方把 env 解析成 `resolveRuntimeConfig` 的输出后传入（路径与 endpoint
 * 由环境注入，不硬编码、不落文档）。这里只声明"允许哪些键"，默认值与校验归属运行时配置模块。
 */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'dopBin',
  'dopEndpoint',
  'ghBin',
  'ghOwner',
  'sourceType',
  'timeoutMs',
]);

/** 装配层的失败原因码（与平台动作四状态、流程态词表分开）。 */
export const FLOW_REASONS = Object.freeze({
  UNAVAILABLE: 'FLOW_UNAVAILABLE',
  COMMAND_NOT_WHITELISTED: 'COMMAND_NOT_WHITELISTED',
  MISSING_CHANGE_ID: 'MISSING_CHANGE_ID',
  MISSING_METHOD: 'FLOW_METHOD_MISSING',
});

export {
  assertReadRequest,
  DevopsReadError,
  normalizeReadResult,
  READ_ACTIONS,
  READ_REASONS,
  READ_STATUSES,
} from './read.mjs';
export { buildDevopsTools, FLOW_ACTIONS, FLOW_TOOLS, READ_TOOLS } from './tools.mjs';
export { ARTIFACT_KINDS, artifactPath, renderFrontMatter, writeArtifact } from './artifacts.mjs';
export { ENTRY_HELP, ENTRY_NAME, parseChangeId, registerEntry } from './entry.mjs';
export { createDevopsFlow, createDevopsReader } from './flow.mjs';

/** 流程协作者与只读适配器的形状判据：形状不对就不当注入，宁可退回自建或显式拒绝。 */
const isFlowLike = (value) =>
  value !== null && typeof value === 'object' && typeof value.startFromChange === 'function';

const isReaderLike = (value) =>
  value !== null && typeof value === 'object' && typeof value.read === 'function';

/**
 * 显式配置项（camelCase）优先于环境：装配层只把调用方给的键原样传下去，
 * 默认值、校验与"未配置"判定都留在 `runtime-config.mjs` / `flow.mjs`（单一真源）。
 */
function runtimeOverrideOf(config) {
  const override = {};
  let count = 0;
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (config[key] === undefined) continue;
    override[key] = config[key];
    count += 1;
  }
  return count === 0 ? null : override;
}

export function validateConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DevopsReadError(READ_REASONS.MALFORMED_RESULT, 'devops 配置必须是对象');
  }
  const unknown = Object.keys(input).filter(
    (key) => !(key in DEFAULT_CONFIG) && !RUNTIME_CONFIG_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw new DevopsReadError(READ_REASONS.MALFORMED_RESULT, `未知配置项：${unknown.join(', ')}`, { unknown });
  }
  return { ...DEFAULT_CONFIG, ...input };
}

/**
 * FIX-02（#21）：已知企业入口的目录绑定在挂载时验证。
 * 空目录、缺目录项、未开放动作都拒绝挂载——登记 ≠ 批准，未登记不得静默
 * 落入 out-of-scope。普通非企业工具仍走门禁原有的 out-of-scope 语义，不误封。
 */
function assertPolicyReadActions(policy) {
  // FIX-08：admission 入口本身缺失时同样拒绝挂载——不能挂上一个"看起来接了策略、
  // 实际调用抛 TypeError"的只读面。
  if (typeof policy.executeAction !== 'function') {
    throw new DevopsReadError(
      READ_REASONS.POLICY_REQUIRED,
      '策略服务没有可用的 admission 入口（executeAction），devops 只读面不开放',
    );
  }
  const missing = READ_ACTIONS.filter((action) => policy.catalog?.get?.(action)?.enabled !== true);
  if (missing.length > 0) {
    throw new DevopsReadError(
      READ_REASONS.POLICY_ACTION_UNREGISTERED,
      `策略目录缺失或未开放只读动作：${missing.join(', ')}（devops 只读面不开放）`,
      { missing },
    );
  }
}

/**
 * @param {{ get?: Function, provide?: Function, effect?: Function, tools?: object, commands?: object }} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);
  // 硬依赖：策略服务不在就拒绝挂载（不降级为"只读模式"）。
  const policy = typeof ctx.get === 'function' ? ctx.get('policy') : undefined;
  if (policy === undefined || policy === null) {
    throw new DevopsReadError(READ_REASONS.POLICY_REQUIRED, '策略服务未挂载，devops 只读面不开放');
  }
  assertPolicyReadActions(policy);

  // D-1：流程协作对象在包内生产——配置（显式或环境注入）→ runner → dop/gh → 门禁 → 动作 → 读。
  // 之前只认 `ctx.get(FLOW_KEY)`，仓库里没有生产者，9 个工具中 5 个流程工具恒 FLOW_UNAVAILABLE。
  const injectedFlow = typeof ctx.get === 'function' ? ctx.get(FLOW_KEY) : undefined;
  // 写路径的门禁适配在装配层做一次，流程侧不再各造一份（读路径仍直接用 policy.executeAction）。
  const guard = createPolicyGuard({ policy });
  const flow = isFlowLike(injectedFlow)
    ? injectedFlow
    : createDevopsFlow({ ctx, policy, guard, config: runtimeOverrideOf(config) });
  const described = typeof flow.describe === 'function' ? flow.describe() : null;
  const configured = described !== null && described.configured === true;
  const injectedReader = typeof ctx.get === 'function' ? ctx.get(READER_KEY) : undefined;
  const reader = isReaderLike(injectedReader)
    ? injectedReader
    : configured && isReaderLike(flow.reader)
      ? flow.reader
      : undefined;

  // 命令面是可选的：宿主没装 commands 时不算故障，但状态必须可见。
  const entryStatus = commandFaceStatus(ctx);
  // 会话内写动作台账：只防同一次会话里的重复写，跨会话以平台回查为准（不做第二真源）。
  const ledger = new Map();
  let callSeq = 0;
  let currentChangeId = null;

  /** 按动作调协作者上的同名方法；缺方法同样是显式失败，而不是静默成功。 */
  const callFlow = async (operation, method, input) => {
    if (typeof flow[method] !== 'function') {
      throw new DevopsReadError(
        FLOW_REASONS.MISSING_METHOD,
        `流程协作者缺少 ${method}（${operation} 不执行）`,
        { operation, method },
      );
    }
    return flow[method](input);
  };

  /** 写动作台账：幂等键优先，缺键时退回"动作|目标"，只用于会话内可见。 */
  const record = (action, target, result) => {
    const key = typeof result?.idempotencyKey === 'string'
      ? result.idempotencyKey
      : `${action}|${target}`;
    ledger.set(key, {
      action,
      target,
      status: result?.status ?? 'unknown',
      reason: result?.reason ?? null,
      at: new Date().toISOString(),
    });
    return result;
  };

  const service = {
    /** 只读动作清单（写动作永不出现在这里）。 */
    readActions: () => [...READ_ACTIONS],
    /** 已注册的工具名（模型可见面）：4 只读 + 5 流程工具。 */
    toolNames: () => [...Object.keys(READ_TOOLS), ...Object.keys(FLOW_TOOLS)],
    /** 当前状态：没有可用适配器时为 `no-reader`（可见地 fail closed）。 */
    status: () => (reader === undefined ? 'no-reader' : 'ready'),
    /** 命令面状态：`registered` 或 `no-command-face`（工具面照常可用）。 */
    entryStatus: () => entryStatus,
    /** 会话内写动作台账（只读副本；不持久化、不跨会话）。 */
    ledger: () => [...ledger.values()],
    /** 当前会话绑定的变更号（入口写入；产物落盘依赖它）。 */
    changeId: () => currentChangeId,
    /**
     * 执行一次只读查询。适配器返回什么都由 `normalizeReadResult` 规整：
     * 退出码不算事实，缺结构化状态或缺来源版本一律 `unknown`。
     */
    read: async ({ action, target } = {}) => {
      if (reader === undefined) {
        throw new DevopsReadError(READ_REASONS.NO_READER, '没有可用的只读适配器（按关闭处理）', { action });
      }
      // 先判动作与目标，再碰适配器：未登记动作不得产生任何调用。
      assertReadRequest(action, target);
      // 同一 admission：读也要经过策略门禁与必要审计，拒绝时适配器零调用。
      const admitted = await policy.executeAction(
        ctx,
        action,
        {
          name: 'devops.read',
          arguments: { target },
          agent: undefined,
          callId: `devops-read-${(callSeq += 1)}`,
          signal: undefined,
        },
        async () => normalizeReadResult({ action, target, result: await reader.read({ action, target }) }),
      );
      if (admitted !== null && typeof admitted === 'object' && admitted.kind === 'error') {
        throw new DevopsReadError(
          READ_REASONS.POLICY_DENIED,
          String(admitted.text ?? '策略拒绝了这次只读查询'),
          { action },
        );
      }
      return admitted;
    },
    /** 聚合读：一次取回变更记录、承建判定与关联对象，产出上下文卡（不做多次往返拼事实）。 */
    context: async (input = {}) => callFlow('change.context', 'context', input),
    /** 建/评 Issue（`issue.create_or_update`）：四状态 + 幂等 + 回读确认在流程侧完成。 */
    issueWrite: async (input = {}) => record(
      FLOW_ACTIONS.ISSUE,
      input.target,
      await callFlow('issue.write', 'issueWrite', input),
    ),
    /** 建 PR / 追加审查评论（`pr.create_or_update` / `review.ai.publish`）。 */
    prWrite: async (input = {}) => record(
      input.op === 'comment' ? FLOW_ACTIONS.PR_COMMENT : FLOW_ACTIONS.PR,
      input.target,
      await callFlow('pr.write', 'prWrite', input),
    ),
    /**
     * 澄清回写：dop 命令面没有澄清写命令，因此恒 `denied` 且**零调用**。
     * 拒绝必须可见（澄清单留在本地产物），不能静默跳过，也不能用评论冒充平台字段。
     */
    clarifyWrite: async ({ target, body } = {}) => ({
      status: 'denied',
      reason: FLOW_REASONS.COMMAND_NOT_WHITELISTED,
      action: FLOW_ACTIONS.CLARIFY,
      target: typeof target === 'string' ? target : null,
      detail: 'dop 命令面无澄清写命令；澄清单作为本地产物保留，不回写平台',
      calls: 0,
      body_bytes: typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : 0,
    }),
    /** 产物落盘：唯一出口 `artifacts.mjs`；变更号来自入口（未绑定则拒绝，不猜）。 */
    artifactWrite: async ({ repoRoot, kind, body, meta } = {}) => {
      if (typeof currentChangeId !== 'string') {
        throw new DevopsReadError(
          FLOW_REASONS.MISSING_CHANGE_ID,
          '尚未通过 devops-change 绑定变更号，产物落盘不执行',
          { kind },
        );
      }
      return writeArtifact({ repoRoot, changeId: currentChangeId, kind, body, meta });
    },
    /**
     * 入口：取回上下文卡并**只在成功时**绑定变更号（失败仍要能重试，不留下半绑定的状态）。
     * 注入的协作者形状不完整时返回结构化拒绝，而不是让命令面显示 INTERNAL——原因必须可见。
     */
    startFromChange: async (changeId) => {
      if (typeof flow.startFromChange !== 'function') {
        return {
          ok: false,
          reason: FLOW_REASONS.MISSING_METHOD,
          detail: `流程协作者缺少 startFromChange（${FLOW_KEY}），未取回平台事实`,
          text: '上下文卡未产出：不进入澄清/计划/实现步骤。',
        };
      }
      const card = await flow.startFromChange({ changeId });
      if (card?.ok !== false) currentChangeId = changeId;
      return card;
    },
    config,
  };

  const disposeProvide = ctx.provide(SERVICE_KEY, service);
  // 自建的协作者也提供出去：宿主侧其它插件（或后续 reload）能看到同一个实例，而不是各装配各的。
  const disposeFlowProvide = isFlowLike(injectedFlow) ? null : ctx.provide(FLOW_KEY, flow);
  const disposeReaderProvide =
    reader === undefined || isReaderLike(injectedReader) ? null : ctx.provide(READER_KEY, reader);
  // 工具进模型可见面，走与其它业务工具同一条门禁管线；没有 tools 服务就只暴露服务、
  // 不注册工具（宿主差异显式可见，而不是静默注册到别处）。
  const disposers =
    typeof ctx.tools?.register === 'function'
      ? buildDevopsTools(service).map((definition) => ctx.tools.register(definition))
      : [];
  // 命令面：`commands` 服务缺失时 registerEntry 返回空函数，entryStatus 已报 no-command-face。
  const disposeCommand = registerEntry(ctx, service);
  const teardown = () => {
    disposers.forEach((dispose) => dispose?.());
    disposeCommand?.();
    disposeReaderProvide?.();
    disposeFlowProvide?.();
    disposeProvide?.();
    ledger.clear();
    currentChangeId = null;
  };
  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect?.(() => teardown);
  return teardown;
}
