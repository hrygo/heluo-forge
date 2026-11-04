/**
 * `@heluo/forge-devops` 宿主插件装配层（#15 / D4，设计准入见能力面设计 §6.1；T7 装配）。
 *
 * 只做**装配**，不做业务判定：策略门禁判"能不能做"、固定 argv 白名单判"有没有这条命令"、
 * 纯函数流程判"该不该做、做完能否核对"。本文件把三者接起来，并对外暴露 3 个工具、
 * 一个命令面与一个服务。
 *
 * 端口约定（D-1 起本包自己就是生产者，注入键仍然优先）：
 * - 流程协作者（配置 → runner → dop 适配器 → 只读面 → 上下文卡）由 `flow.mjs` 组合并在装配时创建；
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
import { buildDevopsTools, DEVOPS_TOOLS, FLOW_ACTIONS } from './tools.mjs';
import { writeArtifact } from './artifacts.mjs';
import { displayableChange, normalizeChangeRecord } from './change-context.mjs';
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
/** 流程协作者端口：dop 适配器、只读面与上下文卡的装配体（写动作已归 `@heluo/forge-gitee`）。 */
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
  /** 写回目标与当前会话已读到的变更不一致：写动作只对"读过的那条"开放。 */
  TARGET_NOT_BOUND: 'TARGET_NOT_BOUND',
});

export {
  assertReadRequest,
  DevopsReadError,
  normalizeReadResult,
  READ_ACTIONS,
  READ_REASONS,
  READ_STATUSES,
} from './read.mjs';
export { buildDevopsTools, DEVOPS_TOOLS, FLOW_ACTIONS, FLOW_TOOLS, QUERY_ACTIONS, QUERY_TOOL } from './tools.mjs';
export { ARTIFACT_KINDS, artifactPath, renderFrontMatter, writeArtifact } from './artifacts.mjs';
export { ENTRY_HELP, ENTRY_NAME, parseChangeId, registerEntry } from './entry.mjs';
export { createDevopsFlow } from './flow.mjs';
export { createDevopsReader } from './read.mjs';

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
  // 读面是六个变量的组合体（配置 / 不可用信封 / 流程 / 流程描述 / 就绪 / reader）：
  // r9 起一次性算完再提交——重建抛错时只提交"明确不可用"，绝不留下半新半旧的状态（AC-10）。
  let cliConfig = null;
  let cliUnavailable = null;

  // D-1：流程协作对象在包内生产——配置（三层合并）→ runner → dop → 只读面 → 上下文卡。
  // 之前只认 `ctx.get(FLOW_KEY)`，仓库里没有生产者，3 个工具中 2 个流程工具恒 FLOW_UNAVAILABLE。
  const injectedFlow = typeof ctx.get === 'function' ? ctx.get(FLOW_KEY) : undefined;
  // 策略门禁适配仍在装配层构造一次：本包不再持有写动作，但读路径与流程侧共用同一份策略视图。
  const guard = createPolicyGuard({ policy });
  /** 包内生产的那份流程随配置变化重建；宿主注入的那份归宿主，不重建。 */
  const ownedFlow = !isFlowLike(injectedFlow);
  const buildFlow = ({ config, unavailable }) =>
    createDevopsFlow({
      ctx,
      policy,
      guard,
      config,
      env: config === null ? {} : null,
      unavailable,
    });
  const injectedReader = typeof ctx.get === 'function' ? ctx.get(READER_KEY) : undefined;
  // 读面初值：宿主流入的那份协作者先就位（它不是我们建的，永远不重建）；自建的那份留给第一次
  // `syncFaces()` 一次性换成真实值。降级时自建面被清空，注入面原样保留——所有权不因故障转移。
  let flow = ownedFlow ? null : injectedFlow;
  let flowDescribed = null;
  let configured = false;
  let reader = undefined;
  let flowProvideOff = null;
  let readerProvideOff = null;

  /** 把 `FLOW_KEY` / `READER_KEY` 的提供换成当前这版（重建后旧引用必须撤掉，否则下游读到的是旧流程）。 */
  const provideFaces = () => {
    flowProvideOff?.();
    readerProvideOff?.();
    flowProvideOff = ownedFlow && flow !== null ? ctx.provide(FLOW_KEY, flow) : null;
    readerProvideOff =
      reader === undefined || isReaderLike(injectedReader) ? null : ctx.provide(READER_KEY, reader);
  };

  /**
   * 计算下一份读面（**不提交**）。`rebuild` 只在配置/发现真的换了才传：重建流程会换掉
   * runner 的路径解析，重建本身**不**重扫发现（AC-4）。
   */
  const computeFaces = ({ rebuild = false } = {}) => {
    const described = access.describe();
    const nextConfig = described.ready === true ? mergedRuntimeOf(access.snapshot()) : null;
    const nextUnavailable = nextConfig === null ? unavailableOf(described) : null;
    const nextFlow =
      ownedFlow && (rebuild === true || flow === null)
        ? buildFlow({ config: nextConfig, unavailable: nextUnavailable })
        : flow;
    const nextDescribed =
      nextFlow !== null && typeof nextFlow.describe === 'function' ? nextFlow.describe() : null;
    const nextConfigured = nextDescribed !== null && nextDescribed.configured === true;
    const nextReader = isReaderLike(injectedReader)
      ? injectedReader
      : nextConfigured && isReaderLike(nextFlow.reader)
        ? nextFlow.reader
        : undefined;
    return {
      cliConfig: nextConfig,
      cliUnavailable: nextUnavailable,
      flow: nextFlow,
      flowDescribed: nextDescribed,
      configured: nextConfigured,
      reader: nextReader,
    };
  };

  /** 一次性提交六个变量再换对外引用：任何一步抛错都不会留下半重建的读面。 */
  const commitFaces = (faces) => {
    cliConfig = faces.cliConfig;
    cliUnavailable = faces.cliUnavailable;
    flow = faces.flow;
    flowDescribed = faces.flowDescribed;
    configured = faces.configured;
    reader = faces.reader;
    provideFaces();
    return faces;
  };

  /**
   * 重建失败的**明确不可用**态（AC-10）：不保留"上次看起来还行"的旧读面、不猜路径；
   * 细因 `CLI_REBUILD_FAILED` 与页面指引放 detail，工具信封仍是 `NO_READER`（原因码不加码）。
   */
  const degradedUnavailable = () =>
    Object.freeze({
      code: READ_REASONS.NO_READER,
      message: `刷新失败 · 请到「${CLI_PAGE_HINT}」重试`,
      detail: Object.freeze({ reason: CLI_REASONS.REBUILD_FAILED, next: CLI_PAGE_HINT }),
    });

  const degradeFaces = () => {
    cliConfig = null;
    cliUnavailable = degradedUnavailable();
    // 宿主注入的流程/reader 归宿主：只把包内自建的这份置为不可用，注入的照旧（不越权降级）。
    flow = ownedFlow ? null : injectedFlow;
    flowDescribed = null;
    configured = false;
    reader = isReaderLike(injectedReader) ? injectedReader : undefined;
    provideFaces();
  };

  /** 事务化重算读面：先算后提交（保存后与刷新后走同一条）。 */
  const syncFaces = ({ rebuild = false } = {}) => commitFaces(computeFaces({ rebuild }));

  /**
   * 刷新单点（AC-6 / AC-7 / AC-8）：一次发现 → 重建读面 → 用同一份合并态出响应。
   * HTTP 的 `?refresh=1`、工具侧 `rediscover`、`cliSnapshot({refresh:true})` 全部走这里，
   * 不允许再存在"只重扫不重建"的第二条路径。
   */
  const refreshSnapshot = () => {
    try {
      // ① 唯一一次扫描：发现 + 重新合并（`access` 内部完成）；② 用这份结果事务化重建读面。
      access.snapshot({ refresh: true });
      syncFaces({ rebuild: true });
    } catch {
      degradeFaces();
      throw new DevopsReadError(
        CLI_REASONS.REBUILD_FAILED,
        `刷新失败 · 请到「${CLI_PAGE_HINT}」重试`,
        { reason: CLI_REASONS.REBUILD_FAILED, next: CLI_PAGE_HINT },
      );
    }
    // ③ 响应读的是重建后的缓存合并态：与随后工具调用看到的是同一份（AC-6），且不再扫描（AC-9）。
    return access.snapshot();
  };
  syncFaces();

  // 命令面是可选的：宿主没装 commands 时不算故障，但状态必须可见。
  const entryStatus = commandFaceStatus(ctx);
  let callSeq = 0;
  let currentChangeId = null;

  /** 绑定当前会话变更号（三条路径共用，见 D 方案 §6）：空值不是绑定，不覆盖已有值。 */
  const bindChangeId = (value) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id !== '') currentChangeId = id;
  };

  /**
   * `change.read` 的归一投影（与上下文卡同一映射，不复制第二份）。
   *
   * 读成功但记录归一失败时**不抛**：`normalized=null`、`normalize_error=<原因码>`，
   * `raw` 照常返回——读事实成功了，只是我们解读不了；抛错会把"读到了但格式不认识"
   * 误报成"没读到"。
   */
  const normalizeChangeFacts = (envelope, target) => {
    if (envelope?.action !== 'change.read') return envelope;
    const facts =
      envelope.facts !== null && typeof envelope.facts === 'object' && !Array.isArray(envelope.facts)
        ? envelope.facts
        : {};
    const raw = facts.raw;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...envelope, facts: { normalized: null, raw: raw ?? null, normalize_error: null } };
    }
    let normalized = null;
    let normalizeError = null;
    try {
      normalized = displayableChange(
        normalizeChangeRecord(raw, {
          at: envelope.observed_at,
          sourceRevision: envelope.source_revision,
          sourceType: flowDescribed?.sourceType ?? 'mock',
          expectedId: target,
        }),
      );
    } catch (error) {
      normalizeError = typeof error?.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN_ERROR';
    }
    return { ...envelope, facts: { normalized, raw, normalize_error: normalizeError } };
  };

  // 同源配置页端点（GET 快照 / POST 保存）。`webServer` 是可选服务：缺失、晚到、
  // 或同前缀已被别的实例占用时都只降级——绝不因为"页面挂不上"塌掉工具面与流程面。
  // 注册一步幂等：宿主已就绪时立即挂；未就绪时经 `ctx.inject` 等它就绪再挂（直接读 ctx.get 会拿到 undefined）。
  const cliApi = createCliApi({
    access,
    // 刷新与工具侧共用同一个单点（AC-6）：路由不再自己调 `access.snapshot({refresh})`。
    snapshot: ({ refresh } = {}) => (refresh === true ? refreshSnapshot() : access.snapshot()),
  });
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
    if (flow === null) {
      // 重建失败后的降级态：明确不可用且**零调用**（AC-10），不退回旧流程、不按旧路径 spawn。
      throw new DevopsReadError(
        FLOW_REASONS.UNAVAILABLE,
        `流程协作者当前不可用（上次刷新失败），${operation} 未执行`,
        { operation, reason: CLI_REASONS.REBUILD_FAILED, next: CLI_PAGE_HINT },
      );
    }
    if (typeof flow[method] !== 'function') {
      throw new DevopsReadError(
        FLOW_REASONS.MISSING_METHOD,
        `流程协作者缺少 ${method}（${operation} 不执行）`,
        { operation, method },
      );
    }
    return flow[method](input);
  };

  const service = {
    /** 只读动作清单（写动作永不出现在这里）。 */
    readActions: () => [...READ_ACTIONS],
    /** 已注册的工具名（模型可见面）：3 条 dop 工具，枚举只有 `tools.mjs` 一份。 */
    toolNames: () => [...DEVOPS_TOOLS],
    /** 当前状态：没有可用适配器时为 `no-reader`（可见地 fail closed）。 */
    status: () => (reader === undefined ? 'no-reader' : 'ready'),
    /** 命令行配置的**脱敏**描述（origin / 缺哪一层 / 指引文案，不含路径与 endpoint）。 */
    cliStatus: () =>
      Object.freeze({
        ...access.describe(),
        // 重建失败后读面已明确不可用：状态与下一次工具调用同结论（AC-10），不能还报 ready。
        ...(flow === null
          ? {
              ready: false,
              reason: CLI_REASONS.REBUILD_FAILED,
              guidance: degradedUnavailable().message,
            }
          : {}),
        route: routeState,
      }),
    /** 配置页快照（含命中路径）：只给同源 GET 路由与页面，不进工具信封、不进日志（AC-10）。 */
    cliSnapshot: ({ refresh } = {}) => (refresh === true ? refreshSnapshot() : access.snapshot()),
    /** 保存配置：revision 栅栏、字段校验、写后回读都在 `cli-access`（本层不重算、不猜默认值）。 */
    saveCliConfig: async ({ revision, fields } = {}) => {
      const result = await access.save({ revision, fields });
      // 写成功即重算读面（AC-8「保存后立刻生效」）：重建包内那份流程，注入的那份不碰。
      if (result?.ok === true) syncFaces({ rebuild: true });
      return result;
    },
    /** 页面「重新发现」：走刷新单点（发现 → 重建读面 → 同源出响应；工具调用仍不触发扫描，AC-4）。 */
    rediscover: () => refreshSnapshot(),
    /** 命令面状态：`registered` 或 `no-command-face`（工具面照常可用）。 */
    entryStatus: () => entryStatus,
    /** 当前会话绑定的变更号（入口 / 读成功 / 卡片 ready 三条路径写入；产物落盘依赖它）。 */
    changeId: () => currentChangeId,
    /**
     * 执行一次只读查询（typed runner：`change.read` / `change.list`）。适配器返回什么都由
     * `normalizeReadResult` 规整：退出码不算事实，缺结构化状态或缺来源版本一律 `unknown`。
     *
     * `change.read` 成功后额外做两件事：把原始记录归一成与上下文卡同一份显示形状（失败不抛，
     * 写 `normalize_error`），并把 target 绑定为当前会话变更号——这样 Web 会话不依赖命令面
     * 也能落盘产物。
     */
    read: async ({ action, target, status } = {}) => {
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
      const requestedTarget = typeof target === 'string' ? target.trim() : target;
      // 同一 admission：读也要经过策略门禁与必要审计，拒绝时适配器零调用。
      const admitted = await policy.executeAction(
        ctx,
        action,
        {
          name: 'devops.read',
          arguments: { target: requestedTarget },
          agent: undefined,
          callId: `devops-read-${(callSeq += 1)}`,
          signal: undefined,
        },
        async () =>
          normalizeReadResult({
            action,
            target: requestedTarget,
            result: await reader.read({ action, target: requestedTarget, status }),
          }),
      );
      if (admitted !== null && typeof admitted === 'object' && admitted.kind === 'error') {
        throw new DevopsReadError(
          READ_REASONS.POLICY_DENIED,
          String(admitted.text ?? '策略拒绝了这次只读查询'),
          { action },
        );
      }
      const result = action === 'change.read' ? normalizeChangeFacts(admitted, requestedTarget) : admitted;
      // 只在读成功（envelope status=succeeded）时绑定：失败仍要能重试，不留下半绑定状态。
      if (action === 'change.read' && result?.status === 'succeeded') bindChangeId(requestedTarget);
      return result;
    },
    /** 聚合读：一次取回变更记录与上下文卡（不做多次往返拼事实）；卡片 ready 即绑定变更号。 */
    context: async (input = {}) => {
      const result = await callFlow('change.context', 'context', input);
      if (result?.status === 'ready') bindChangeId(result?.changeId);
      return result;
    },
    /**
     * 受控写：把分析后的标题/描述/验收标准回写到**当前会话已读到的那条变更**。
     *
     * 三层前置：绑定校验（先读再写，目标必须等于 currentChangeId）→ 策略门禁
     * （`change.clarification.write`，默认未登记即拒绝、零子进程）→ 适配器固定 argv + 回读。
     * 返回值是适配器的结果三态（done / failed / unknown），退出码 0 不当成功。
     */
    changeUpdate: async ({ target, summary, description, aiAc } = {}) => {
      const id = typeof target === 'string' ? target.trim() : '';
      if (currentChangeId === null) {
        throw new DevopsReadError(
          FLOW_REASONS.MISSING_CHANGE_ID,
          '尚未读取任何变更，写回不执行（先读该变更再写）',
          { action: FLOW_ACTIONS.CHANGE_UPDATE },
        );
      }
      if (id === '' || id !== currentChangeId) {
        throw new DevopsReadError(
          FLOW_REASONS.TARGET_NOT_BOUND,
          `写回目标 ${id || '(空)'} 与当前会话已读到的变更 ${currentChangeId} 不一致`,
          { target: id, bound: currentChangeId },
        );
      }
      const admitted = await policy.executeAction(
        ctx,
        FLOW_ACTIONS.CHANGE_UPDATE,
        {
          name: 'devops.change.update',
          arguments: { target: id },
          agent: undefined,
          callId: `devops-write-${(callSeq += 1)}`,
          signal: undefined,
        },
        async () => callFlow('change.update', 'changeUpdate', { changeId: id, summary, description, aiAc }),
      );
      if (admitted !== null && typeof admitted === 'object' && admitted.kind === 'error') {
        throw new DevopsReadError(READ_REASONS.POLICY_DENIED, String(admitted.text ?? '策略拒绝了这次写回'), {
          action: FLOW_ACTIONS.CHANGE_UPDATE,
        });
      }
      return admitted;
    },
    /** 产物落盘：唯一出口 `artifacts.mjs`；变更号来自绑定（未绑定则拒绝，不猜）。 */
    artifactWrite: async ({ repoRoot, kind, body, data, meta } = {}) => {
      if (typeof currentChangeId !== 'string') {
        throw new DevopsReadError(
          FLOW_REASONS.MISSING_CHANGE_ID,
          '尚未绑定变更号，产物落盘不执行',
          { kind },
        );
      }
      return writeArtifact({ repoRoot, changeId: currentChangeId, kind, body, data, meta });
    },
    /**
     * 入口：取回上下文卡并**只在成功时**绑定变更号（失败仍要能重试，不留下半绑定的状态）。
     * 注入的协作者形状不完整时返回结构化拒绝，而不是让命令面显示 INTERNAL——原因必须可见。
     */
    startFromChange: async (changeId) => {
      if (flow === null || typeof flow.startFromChange !== 'function') {
        return {
          ok: false,
          reason: flow === null ? FLOW_REASONS.UNAVAILABLE : FLOW_REASONS.MISSING_METHOD,
          detail:
            flow === null
              ? '流程协作者当前不可用（上次刷新失败），未取回平台事实'
              : `流程协作者缺少 startFromChange（${FLOW_KEY}），未取回平台事实`,
          text: '上下文卡未产出：不进入澄清/计划/实现步骤。',
        };
      }
      const card = await flow.startFromChange({ changeId });
      if (card?.ok !== false) bindChangeId(changeId);
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
    currentChangeId = null;
  };
  // Cordis 以 `new` 运行普通函数插件，返回值不当作 effect 收集；显式登记卸载。
  ctx.effect?.(() => teardown);
  return teardown;
}
