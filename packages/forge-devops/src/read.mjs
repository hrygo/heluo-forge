/**
 * `@heluo/forge-devops` 只读查询的判定核心（#15 / D4，设计准入见能力面设计 §6.1）。
 *
 * 只做三件事：**限定动作**、**限定必需要素**、**把"退出码"与"事实"分开**。
 * 命令面失败（超时／非零退出／spawn 失败）只归一原因码（`normalizeReadError`），
 * 判定语义不变：拿不到结构化事实就是 `unknown`，绝不因为"命令跑完了"就报成功。
 * 不读企业 CLI、不解析平台专有输出——那是提供方适配器的责任，经端口注入。
 *
 * 关键纪律（来自[工程工具契约](../../../docs/contracts/engineering-tools.md)）：
 * - 退出码不是权威事实；没有结构化 `status` 就是 `unknown`，不报成功。
 * - 没有 `source_revision` 就不能声称冻结事实，降级为 `unknown` 并给出原因。
 * - 只读不自动重放；重试语义是 `read_recheck`。
 */

// 失败面单点（r9 / AC-5）：信封 message 是路径泄漏的最后一个入口——`error.message` 里可能带着
// 适配器攒好的证据行，统一经 `failureMessageOf` 去前缀并脱敏；`status`/`error_code` 词表不变。
import { failureMessageOf } from './failure-face.mjs';

/**
 * 只读面动作，与工程工具契约 §3 同源；写动作不在此列，也不得由本包开放。
 *
 * r10（按平台收敛）把仓库 / Issue / PR 的事实交给 `@heluo/forge-gitee` 唯一负责；本包只留
 * dop 变更的两条读动作：`change.read`（单条记录 + 其归一投影）与 `change.list`（当前用户
 * 的变更清单，目标语义只有 `@me`，在工具层判定）。以后若有人想「顺手加回一条」，先回答：
 * 这条事实的主人在哪个包。
 *
 * 动作标识与策略目录同名（`change.read` / `change.list`），不另造一套词表：只读 runner 的
 * 枚举、策略门禁的目录与补丁层的 catalog 三处指同一串字面量。
 */
export const READ_ACTIONS = Object.freeze(['change.read', 'change.list']);

/** 契约 §4.2 允许的结果状态。 */
export const READ_STATUSES = Object.freeze(['succeeded', 'failed', 'partial', 'unknown']);

/**
 * 只读动作的拒绝与降级原因。
 *
 * 既有九项语义不变；末尾两项是本次新增的**命令面**失败原因——只读查询现在跑在真实子进程上
 * （`change view --json` 这类固定命令），"超时"与"非零退出"都是以前不存在的失败形态，
 * 不能折叠成 `MALFORMED_RESULT`（那会把"没跑通"误读成"输出没法解析"）。
 * 适配器自带的原因码优先透传，这里只兜底，不另立第二套词表。
 */
export const READ_REASONS = Object.freeze({
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  MISSING_TARGET: 'MISSING_TARGET',
  NO_READER: 'NO_READER',
  POLICY_REQUIRED: 'POLICY_REQUIRED',
  POLICY_ACTION_UNREGISTERED: 'POLICY_ACTION_UNREGISTERED',
  POLICY_DENIED: 'POLICY_DENIED',
  MALFORMED_RESULT: 'MALFORMED_RESULT',
  NO_STRUCTURED_STATUS: 'NO_STRUCTURED_STATUS',
  MISSING_SOURCE_REVISION: 'MISSING_SOURCE_REVISION',
  COMMAND_FAILED: 'COMMAND_FAILED',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const REGISTERED_REASONS = new Set(Object.values(READ_REASONS));

export class DevopsReadError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'DevopsReadError';
    this.code = code;
    this.detail = detail;
  }
}

export const isReadAction = (action) => typeof action === 'string' && READ_ACTIONS.includes(action);

/**
 * 只读动作 → 端口方法的唯一映射（r10：只剩 dop 变更两条）。
 *
 * 映射留在这里而不是工具层：工具层只认 `target` 与失败信封，谁去取事实必须能逐条核对。
 * 端口形状是 `{ dop: { readChange, listChanges } }`——本包不再持有 gh 端口。
 * `change.list` 的 `target` 语义（只接受 `@me`）在工具层判定，适配器只收 `status`：
 * 读层若也判一次，就会与工具层形成两套 `@me` 规则。
 */
export const READ_ROUTES = Object.freeze({
  'change.read': (ports, { target }) => ports.dop.readChange({ changeId: target }),
  'change.list': (ports, { target, status }) => ports.dop.listChanges({ status }),
});

/**
 * 把适配器返回值规整成契约结果。
 *
 * 拒绝（抛错，零副作用）：未登记动作、缺目标、没有适配器。
 * 降级（返回 `unknown` 而不是成功）：结果不是对象、没有结构化 `status`、缺 `source_revision`。
 */
/** 先判请求合法性：未登记动作与缺目标都拒绝，且不得触碰适配器。 */
export function assertReadRequest(action, target) {
  if (!isReadAction(action)) {
    throw new DevopsReadError(READ_REASONS.UNKNOWN_ACTION, `"${String(action)}" 不是只读动作`, { action });
  }
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new DevopsReadError(READ_REASONS.MISSING_TARGET, `${action} 缺少目标`, { action });
  }
}

/**
 * 按动作把适配器结果投影成给调用方看的 `facts`（单点：工具层不再各写一遍投影）。
 *
 * 投影保留 **适配器原样**（`raw`）而不是重新拼一遍：字段映射与归一属于
 * `change-context.mjs` 的 `normalizeChangeRecord`，读层只负责"哪些字段交出去"。
 * 没有可投影的形状时返回 `undefined`（调用方按"没有 facts"处理，而不是拿到空对象
 * 误以为读到了事实）。
 */
export function projectFacts(action, result) {
  const source = isPlainObject(result) ? result : null;
  if (action === 'change.read') {
    return source !== null && isPlainObject(source.raw) ? { raw: source.raw } : undefined;
  }
  if (action === 'change.list') {
    if (source === null) return undefined;
    return {
      user: source?.user ?? null,
      total: source?.total ?? null,
      count: source?.count ?? null,
      filter: source?.filter ?? null,
      items: Array.isArray(source?.items) ? [...source.items] : [],
      raw: source?.raw ?? null,
    };
  }
  return undefined;
}

/** `command` 只在非空字符串时透传，否则显式 `null`（"没有命令可核对"必须可见）。 */
const commandOf = (result) =>
  typeof result?.command === 'string' && result.command.trim().length > 0 ? result.command : null;

export function normalizeReadResult({ action, target, result }) {
  assertReadRequest(action, target);
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return unknownResult(action, target, READ_REASONS.MALFORMED_RESULT);
  }
  if (typeof result.status !== 'string' || !READ_STATUSES.includes(result.status)) {
    // 只给退出码/自由文本的适配器走到这里：没有结构化状态就不许报成功。
    return unknownResult(action, target, READ_REASONS.NO_STRUCTURED_STATUS, result);
  }
  if (typeof result.source_revision !== 'string' || result.source_revision.trim().length === 0) {
    return unknownResult(action, target, READ_REASONS.MISSING_SOURCE_REVISION, result);
  }
  return {
    action,
    target_ref: typeof result.target_ref === 'string' && result.target_ref.trim().length > 0 ? result.target_ref : target,
    status: result.status,
    source_revision: result.source_revision,
    result_refs: Array.isArray(result.result_refs) ? [...result.result_refs] : [],
    observed_at: typeof result.observed_at === 'string' ? result.observed_at : null,
    error_code: result.status === 'succeeded' ? null : (result.error_code ?? null),
    retry_policy: 'read_recheck',
    // 透传层：命令标签（可核对"这条事实由哪条命令产出"）与按动作投影的事实。
    command: commandOf(result),
    facts: projectFacts(action, result),
    truncated: result.truncated === true,
  };
}

/**
 * 命令面失败的降级信封：适配器/运行器抛错时把错误归一成一张 `unknown` 读信封，
 * 让上下文卡的"未知项"有 field/reason/command 可展示，而不是让异常穿透到工具层。
 * 语义与 `normalizeReadResult` 的失败分支一致（unknown + read_recheck 可复核），
 * 且**永不抛错**——错误处理路径上再抛错会盖掉真正的原因。
 *
 * 原因码优先级：适配器自带且已登记的原因 > 超时 > 非零退出 > 系统错误（spawn 失败）
 * > MALFORMED_RESULT 兜底；未登记的 code 只留在 message/detail 里，不污染词表。
 */
export function normalizeReadError({ action = null, target = null, error = null } = {}) {
  const detail = asObject(error?.detail);
  const explicit = text(error?.code);
  const reason = REGISTERED_REASONS.has(explicit)
    ? explicit
    : detail.timedOut === true
      ? READ_REASONS.COMMAND_TIMEOUT
      : Number.isInteger(detail.exitCode) && detail.exitCode !== 0
        ? READ_REASONS.COMMAND_FAILED
        : explicit !== ''
          ? READ_REASONS.COMMAND_FAILED
          : READ_REASONS.MALFORMED_RESULT;
  return {
    action: typeof action === 'string' ? action : null,
    target_ref: typeof target === 'string' ? target : null,
    status: 'unknown',
    source_revision: null,
    result_refs: [],
    observed_at: typeof detail.observedAt === 'string' ? detail.observedAt : null,
    error_code: reason,
    retry_policy: 'read_recheck',
    message: failureMessageOf(error) || null,
    detail: { ...detail },
  };
}

function unknownResult(action, target, reason, result = undefined) {
  return {
    action,
    target_ref: typeof result?.target_ref === 'string' ? result.target_ref : target,
    status: 'unknown',
    source_revision: null,
    result_refs: [],
    observed_at: typeof result?.observed_at === 'string' ? result.observed_at : null,
    error_code: reason,
    retry_policy: 'read_recheck',
    // 降级时同样透传：拿到的命令标签与投影照常给（读失败了，但"跑了哪条命令"仍可核对）。
    command: commandOf(result),
    facts: projectFacts(action, result),
  };
}

/** 不可用信封的形状判据：只有带非空字符串 `code` 的对象才算，别的原样当普通值处理。 */
const isUnavailableEnvelope = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof value.code === 'string' &&
  value.code.trim() !== '';

/**
 * 只读面适配器（r10 从 `flow.mjs` 迁到本模块：读面与它的判定核心在同一处，flow 只管流程组合）。
 *
 * 只做两件事：**动作 → 固定方法**（未登记的动作在发子进程之前就被拒绝）、
 * **配置缺失时 fail closed**（保留同一个对象，读取以原因码失败，绝不返回空结果冒充成功）。
 *
 * `unavailable` 是装配层给的**结构化石封**：`{ code, message, detail }`。它优先于 `reason`——
 * 只读原因码不加码（仍是 NO_READER），细因（CLI_NOT_FOUND + 已查类别 + 页面指引）放 `detail`。
 * 没有信封时行为与基线一字不差（旧 `reason` 字符串路径保留）。
 */
export function createDevopsReader({
  ports = null,
  reason = 'CONFIG_MISSING',
  unavailable = null,
} = {}) {
  const envelope = isUnavailableEnvelope(unavailable) ? unavailable : null;
  return Object.freeze({
    async read({ action, target, status } = {}) {
      const route = READ_ROUTES[action];
      if (route === undefined) {
        throw new DevopsReadError(READ_REASONS.UNKNOWN_ACTION, `只读动作未登记：${String(action)}`, { action });
      }
      if (ports === null) {
        if (envelope !== null) {
          const detail = envelope.detail !== null && typeof envelope.detail === 'object' ? envelope.detail : {};
          throw new DevopsReadError(envelope.code, String(envelope.message ?? reason), {
            action,
            target,
            ...detail,
          });
        }
        throw new DevopsReadError(reason, `运行时配置不可用（${reason}），未发起 ${action}`, { action, target });
      }
      return route(ports, { target, status });
    },
  });
}
