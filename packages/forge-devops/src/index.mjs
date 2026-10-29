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
 *
 * r3（配置页与 CLI 自动发现）在本层只做**装配**：
 * - 装配期构造一次 `cli-access`（有界只读发现 + 三层合并：配置页 > 环境变量 > 自动发现），
 *   合并结果以显式 config 形式交给流程（`normalizeResolution` 的"显式优先"语义一字未改）；
 * - 配置页读写走同源 `/api/forge-devops` 路由；`webServer` / `configEditor` 都是**可选**服务，
 *   缺失、晚到或端点已被占用都只降级（页面只读 / 无端点），绝不塌掉装配与工具面；
 * - 未命中时只读面仍以 `NO_READER` 失败（原因码不加码），细因与页面指引放 `detail`。
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
import { CLI_FIELDS, CLI_ORIGINS, CLI_PAGE_HINT, CLI_REASONS } from './cli-config.mjs';
import { createCliAccess } from './cli-access.mjs';
import { CLI_API_PREFIX, createCliApi, toNodeRoute } from './http.mjs';
import { ConfigStandard } from './runtime-config.mjs';

export const name = 'forge-devops';

/**
 * 插件配置的结构化校验面（standard-schema）：宿主 `config-editor` 与字段级校验共用同一套规则。
 * 与 `cli-config` 的合并、`runtime-config` 的字段规则都不重复实现——这里只交出**入口**。
 */
export const Config = ConfigStandard;
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
 * 键表与配置页六字段同源（`cli-config.CLI_FIELDS`），不另立一份。
 */
export const RUNTIME_CONFIG_KEYS = Object.freeze([...CLI_FIELDS]);

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

/** `config-editor` 的形状判据：只认本包真正用到的那三面，别的一概当"没有写面"。 */
const isEditorLike = (value) =>
  value !== null &&
  typeof value === 'object' &&
  (typeof value.configuration === 'function' || typeof value.edit === 'function');

/**
 * 三层合并结果（装配期快照）→ 流程认识的六字段显式配置。
 *
 * `cli-access` 不直接暴露合并值（回显边界），所以这里从**同一份合并结论**的 entries 里取值：
 * 路径字段取 `path`、其余取 `value`，`missing` 来源跳过。返回值只进流程的显式 config
 * （工具面与页面都拿不到它），不打印、不落盘。
 */
function mergedRuntimeOf(snapshot) {
  const fields = snapshot !== null && typeof snapshot === 'object' ? snapshot.entries : null;
  if (fields === null || typeof fields !== 'object') return null;
  const merged = {};
  let count = 0;
  for (const field of CLI_FIELDS) {
    const item = fields[field];
    if (item === null || typeof item !== 'object') continue;
    if (item.origin === undefined || item.origin === null || item.origin === CLI_ORIGINS.MISSING) continue;
    const value = typeof item.path === 'string' ? item.path : item.value;
    if (value === null || value === undefined || value === '') continue;
    merged[field] = value;
    count += 1;
  }
  return count === 0 ? null : Object.freeze(merged);
}

/**
 * 未命中时的结构化信封：只读面仍以 `NO_READER` 失败（原因码不加码），
 * `detail.reason` 给细因（`CLI_NOT_FOUND` / `CLI_CONFIG_INVALID`），`detail.searched` 只给**类别**，
 * `detail.next` 给配置页入口。整条信封不含盘符、绝对路径或 endpoint（AC-10）。
 */
function unavailableOf(described) {
  const reason = typeof described?.reason === 'string' && described.reason !== '' ? described.reason : CLI_REASONS.NOT_FOUND;
  const guidance =
    typeof described?.guidance === 'string' && described.guidance !== ''
      ? described.guidance
      : `未找到命令行工具 · 请到「${CLI_PAGE_HINT}」指定位置`;
  return Object.freeze({
    code: READ_REASONS.NO_READER,
    message: guidance,
    detail: Object.freeze({
      reason,
      searched: Array.isArray(described?.searched) ? [...described.searched] : [],
      next: CLI_PAGE_HINT,
    }),
  });
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

  // r3：装配期做**一次**三层合并（配置页 > 环境变量 > 自动发现），此后只有页面显式刷新会重扫（AC-4）。
  // `configEditor` 是可选服务：缺失时读面照常工作（页面降级只读），不影响工具面与流程面。
  const configEditor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
  const access = createCliAccess({
    config,
    configEditor: isEditorLike(configEditor) ? configEditor : null,
  });
  // 合并结果只以**显式 config** 的形式交给流程（`normalizeResolution` 的"显式优先"语义不变）：
  // 解析不到就显式给空环境，流程侧不得再自己读一次进程环境（单一真源，避免两处各合并一次）。
  // 这两项必须可重算：页面保存成功后 `access` 会重新合并，闭包里冻住"装配那一刻"的值会让
  // 「保存后立刻生效」（AC-8）变成"重启后才生效"。
  let cliConfig = null;
  let cliUnavailable = null;
  const readCli = () => {
    const described = access.describe();
    cliConfig = described.ready === true ? mergedRuntimeOf(access.snapshot()) : null;
    cliUnavailable = cliConfig === null ? unavailableOf(described) : null;
  };
  readCli();

  // D-1：流程协作对象在包内生产——配置（三层合并）→ runner → dop/gh → 门禁 → 动作 → 读。
  // 之前只认 `ctx.get(FLOW_KEY)`，仓库里没有生产者，9 个工具中 5 个流程工具恒 FLOW_UNAVAILABLE。
  const injectedFlow = typeof ctx.get === 'function' ? ctx.get(FLOW_KEY) : undefined;
  // 写路径的门禁适配在装配层做一次，流程侧不再各造一份（读路径仍直接用 policy.executeAction）。
  const guard = createPolicyGuard({ policy });
  /** 包内生产的那份流程随配置变化重建；宿主注入的那份归宿主，不重建。 */
  const ownedFlow = !isFlowLike(injectedFlow);
  const buildFlow = () =>
    createDevopsFlow({
      ctx,
      policy,
      guard,
      config: cliConfig,
      env: cliConfig === null ? {} : null,
      unavailable: cliUnavailable,
    });
  let flow = ownedFlow ? buildFlow() : injectedFlow;
  const injectedReader = typeof ctx.get === 'function' ? ctx.get(READER_KEY) : undefined;
  let flowDescribed = null;
  let configured = false;
  let reader = undefined;
  let flowProvideOff = null;
  let readerProvideOff = null;

  /** 把 `FLOW_KEY` / `READER_KEY` 的提供换成当前这版（重建后旧引用必须撤掉，否则下游读到的是旧流程）。 */
  const provideFaces = () => {
    flowProvideOff?.();
    readerProvideOff?.();
    flowProvideOff = ownedFlow ? ctx.provide(FLOW_KEY, flow) : null;
    readerProvideOff =
      reader === undefined || isReaderLike(injectedReader) ? null : ctx.provide(READER_KEY, reader);
  };

  /**
   * 重算读面（配置/发现变了之后调用）。
   * `rebuild` 只在配置真的换了才传：重建流程会换掉 runner 的路径解析，重建本身**不**重扫发现（AC-4）。
   */
  const syncFaces = ({ rebuild = false } = {}) => {
    readCli();
    if (rebuild === true && ownedFlow) flow = buildFlow();
    flowDescribed = typeof flow.describe === 'function' ? flow.describe() : null;
    configured = flowDescribed !== null && flowDescribed.configured === true;
    reader = isReaderLike(injectedReader)
      ? injectedReader
      : configured && isReaderLike(flow.reader)
        ? flow.reader
        : undefined;
    provideFaces();
  };
  syncFaces();

  // 命令面是可选的：宿主没装 commands 时不算故障，但状态必须可见。
  const entryStatus = commandFaceStatus(ctx);
  // 会话内写动作台账：只防同一次会话里的重复写，跨会话以平台回查为准（不做第二真源）。
  const ledger = new Map();
  let callSeq = 0;
  let currentChangeId = null;

  // 同源配置页端点（GET 快照 / POST 保存）。`webServer` 是可选服务：缺失、晚到、
  // 或同前缀已被别的实例占用时都只降级——绝不因为"页面挂不上"塌掉工具面与流程面。
  // 注册一步幂等：宿主已就绪时立即挂；未就绪时经 `ctx.inject` 等它就绪再挂（直接读 ctx.get 会拿到 undefined）。
  const cliApi = createCliApi({ access });
  const cliRoute = toNodeRoute(cliApi);
  let routeState = 'no-webserver';
  let disposeRoute = null;
  const mountCliRoute = (scope) => {
    if (disposeRoute !== null) return;
    const server = (scope ?? ctx)?.get?.('webServer') ?? null;
    if (server === null || server === undefined || typeof server.register !== 'function') return;
    try {
      const off = server.register({
        kind: 'prefix',
        path: CLI_API_PREFIX,
        handler: cliRoute,
        description: 'forge-devops 命令行配置（只读快照 / 保存）',
      });
      disposeRoute = typeof off === 'function' ? off : () => {};
      routeState = 'registered';
    } catch {
      // 前缀冲突（别的插件已占了同一段）不抛：状态可见地记成 conflict，页面显示"端点不可用"。
      routeState = 'conflict';
    }
  };
  mountCliRoute(ctx);
  const disposeInject =
    typeof ctx.inject === 'function' ? ctx.inject(['webServer'], (host) => mountCliRoute(host)) : null;

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
    /** 命令行配置的**脱敏**描述（origin / 缺哪一层 / 指引文案，不含路径与 endpoint）。 */
    cliStatus: () => Object.freeze({ ...access.describe(), route: routeState }),
    /** 配置页快照（含命中路径）：只给同源 GET 路由与页面，不进工具信封、不进日志（AC-10）。 */
    cliSnapshot: ({ refresh } = {}) => access.snapshot({ refresh: refresh === true }),
    /** 保存配置：revision 栅栏、字段校验、写后回读都在 `cli-access`（本层不重算、不猜默认值）。 */
    saveCliConfig: async ({ revision, fields } = {}) => {
      const result = await access.save({ revision, fields });
      // 写成功即重算读面（AC-8「保存后立刻生效」）：重建包内那份流程，注入的那份不碰。
      if (result?.ok === true) syncFaces({ rebuild: true });
      return result;
    },
    /** 页面「重新发现」：重扫一次并重新合并（工具调用永远不会触发扫描，AC-4）。 */
    rediscover: () => {
      const snapshot = access.snapshot({ refresh: true });
      syncFaces({ rebuild: true });
      return snapshot;
    },
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
        // 原因码不加码（仍是 NO_READER，工具信封与既有用例一致）：细因、已查类别与页面指引放 detail。
        if (cliUnavailable !== null) {
          throw new DevopsReadError(cliUnavailable.code, cliUnavailable.message, {
            action,
            ...cliUnavailable.detail,
          });
        }
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
  // `FLOW_KEY` / `READER_KEY` 的当前引用由 `provideFaces()` 维护（保存/刷新后会换成新实例）。
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
    disposeRoute?.();
    disposeInject?.();
    flowProvideOff?.();
    readerProvideOff?.();
    disposeProvide?.();
    ledger.clear();
    currentChangeId = null;
  };
  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect?.(() => teardown);
  return teardown;
}
