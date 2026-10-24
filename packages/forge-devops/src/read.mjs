/**
 * `@heluo/forge-devops` 只读查询的判定核心（#15 / D4，设计准入见能力面设计 §6.1）。
 *
 * 只做三件事：**限定动作**、**限定必需要素**、**把"退出码"与"事实"分开**。
 * 不读企业 CLI、不解析平台专有输出——那是提供方适配器的责任，经端口注入。
 *
 * 关键纪律（来自[工程工具契约](../../../docs/contracts/engineering-tools.md)）：
 * - 退出码不是权威事实；没有结构化 `status` 就是 `unknown`，不报成功。
 * - 没有 `source_revision` 就不能声称冻结事实，降级为 `unknown` 并给出原因。
 * - 只读不自动重放；重试语义是 `read_recheck`。
 */

/** 只读面动作，与工程工具契约 §3 同源；写动作不在此列，也不得由本包开放。 */
export const READ_ACTIONS = Object.freeze(['change.read', 'repository.read', 'issue.read', 'pr.read']);

/** 契约 §4.2 允许的结果状态。 */
export const READ_STATUSES = Object.freeze(['succeeded', 'failed', 'partial', 'unknown']);

/** 只读动作的拒绝与降级原因。 */
export const READ_REASONS = Object.freeze({
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  MISSING_TARGET: 'MISSING_TARGET',
  NO_READER: 'NO_READER',
  POLICY_REQUIRED: 'POLICY_REQUIRED',
  MALFORMED_RESULT: 'MALFORMED_RESULT',
  NO_STRUCTURED_STATUS: 'NO_STRUCTURED_STATUS',
  MISSING_SOURCE_REVISION: 'MISSING_SOURCE_REVISION',
});

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
  };
}
