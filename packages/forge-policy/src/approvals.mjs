/**
 * 批准台账：把"登记 ≠ 批准"从文字变成可校验的结构（#15 / D1，责任方 2026-10-24）。
 *
 * 登记表（设计 §5.1.1）说明"哪些动作允许被评审"；台账说明"谁在何时批准了哪个动作、
 * 哪个资源、哪个版本范围、到什么时候失效"。本模块只做两件事：
 * 1. 编译并校验台账条目；
 * 2. 拒绝任何**没有有效台账条目却想 `enabled: true`** 的写/确认动作。
 *
 * 本模块不产生批准，也不替安全团队裁定；缺台账条目时唯一结果是拒绝。
 */

export const APPROVAL_FIELDS = Object.freeze([
  'approval_id',
  'action',
  'resource',
  'approved_by',
  'approved_at',
  'revision_range',
  'expires_at',
]);

export const APPROVAL_REASONS = Object.freeze({
  NO_APPROVAL: 'no-approval',
  ACTION_MISMATCH: 'action-mismatch',
  RESOURCE_MISMATCH: 'resource-mismatch',
  REVISION_OUT_OF_RANGE: 'revision-out-of-range',
  NOT_YET_VALID: 'not-yet-valid',
  EXPIRED: 'expired',
});

export class PolicyApprovalError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyApprovalError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireText(value, label, approvalId) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PolicyApprovalError(`${label} must be a non-empty string`, 'POLICY_APPROVAL_INVALID', { approvalId, label });
  }
  return value;
}

function requireInstant(value, label, approvalId) {
  requireText(value, label, approvalId);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new PolicyApprovalError(`${label} must be an ISO date-time`, 'POLICY_APPROVAL_INVALID', { approvalId, label });
  }
  return ms;
}

/** 编译台账：无效或重复条目直接报错，不静默丢弃（少一条批准项看起来更严，实则掩盖配置错误）。 */
export function compileApprovals(entries = []) {
  if (!Array.isArray(entries)) {
    throw new PolicyApprovalError('approvals must be an array', 'POLICY_APPROVAL_INVALID');
  }
  const approvals = new Map();
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      throw new PolicyApprovalError('each approval must be an object', 'POLICY_APPROVAL_INVALID');
    }
    const approvalId = requireText(entry.approval_id, 'approval_id', undefined);
    if (approvals.has(approvalId)) {
      throw new PolicyApprovalError(`duplicate approval_id "${approvalId}"`, 'POLICY_APPROVAL_DUPLICATE', { approvalId });
    }
    const unknown = Object.keys(entry).filter((key) => !APPROVAL_FIELDS.includes(key));
    if (unknown.length > 0) {
      throw new PolicyApprovalError(`unknown approval field(s): ${unknown.join(', ')}`, 'POLICY_APPROVAL_INVALID', {
        approvalId,
        unknown,
      });
    }
    const action = requireText(entry.action, 'action', approvalId);
    const resource = requireText(entry.resource, 'resource', approvalId);
    const approvedBy = requireText(entry.approved_by, 'approved_by', approvalId);
    const approvedAt = requireInstant(entry.approved_at, 'approved_at', approvalId);
    const expiresAt = requireInstant(entry.expires_at, 'expires_at', approvalId);
    if (expiresAt <= approvedAt) {
      throw new PolicyApprovalError('expires_at must be after approved_at', 'POLICY_APPROVAL_INVALID', { approvalId });
    }
    let revisionRange = [];
    if (entry.revision_range !== undefined) {
      if (!Array.isArray(entry.revision_range) || entry.revision_range.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
        throw new PolicyApprovalError('revision_range must be an array of non-empty strings', 'POLICY_APPROVAL_INVALID', {
          approvalId,
        });
      }
      revisionRange = [...entry.revision_range];
    }
    approvals.set(approvalId, Object.freeze({ approvalId, action, resource, approvedBy, approvedAt, expiresAt, revisionRange }));
  }
  return approvals;
}

/** 需要台账支撑的条目：`enabled: true` 的写/确认动作（只读不需批准）。 */
export const needsApproval = (entry) => entry.kind !== 'read' && entry.enabled === true;

/**
 * 判定某动作当前是否被有效批准。
 * @returns {{allowed: boolean, reason: string|null, approvalId: string|null}}
 */
export function decideApproval({ approvals, action, resource = undefined, revision = undefined, now = Date.now() }) {
  const rows = [...approvals.values()].filter((row) => row.action === action);
  if (rows.length === 0) return { allowed: false, reason: APPROVAL_REASONS.NO_APPROVAL, approvalId: null };
  let mismatch = null;
  for (const row of rows) {
    if (resource !== undefined && row.resource !== '*' && row.resource !== resource) {
      mismatch ??= APPROVAL_REASONS.RESOURCE_MISMATCH;
      continue;
    }
    if (revision !== undefined && row.revisionRange.length > 0 && !row.revisionRange.includes(revision)) {
      mismatch ??= APPROVAL_REASONS.REVISION_OUT_OF_RANGE;
      continue;
    }
    if (now < row.approvedAt) {
      mismatch ??= APPROVAL_REASONS.NOT_YET_VALID;
      continue;
    }
    if (now >= row.expiresAt) {
      mismatch ??= APPROVAL_REASONS.EXPIRED;
      continue;
    }
    return { allowed: true, reason: null, approvalId: row.approvalId };
  }
  return { allowed: false, reason: mismatch ?? APPROVAL_REASONS.NO_APPROVAL, approvalId: null };
}

/**
 * 挂载时的硬约束：`enabled: true` 的写/确认动作必须能找到一条**当前有效**的台账条目。
 * 找不到就拒绝挂载——不降级为"仅告警"。
 */
export function assertEnabledEntriesApproved(catalog, approvals, now = Date.now()) {
  const offenders = [];
  for (const entry of catalog.values()) {
    if (!needsApproval(entry)) continue;
    const decision = decideApproval({ approvals, action: entry.action, now });
    if (decision.allowed !== true) offenders.push({ action: entry.action, reason: decision.reason });
  }
  if (offenders.length > 0) {
    throw new PolicyApprovalError(
      'enabled write/confirm actions require a valid approval entry',
      'POLICY_APPROVAL_REQUIRED',
      { offenders },
    );
  }
  return true;
}
