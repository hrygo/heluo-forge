/**
 * 受控动作目录：编译与判定。
 *
 * 目录由策略维护者登记，工具自报的读写属性一律不作为依据；未登记、未开放、
 * 目标缺失或错配一律拒绝（fail closed）。
 */

export class PolicyCatalogError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyCatalogError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const KINDS = new Set(['read', 'write', 'confirm']);
const EGRESS_VALUES = new Set(['allow', 'confirm', 'deny']);
const RETRY_VALUES = new Set(['none', 'read_recheck', 'safe_retry']);

function requireString(value, label, code) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PolicyCatalogError(`${label} must be a non-empty string`, code, { label });
  }
  return value;
}

/**
 * Compile the registered catalog. Invalid or duplicated entries throw instead of
 * being dropped: a silently smaller catalog would look like a stricter policy
 * while hiding a configuration error.
 *
 * @param {readonly object[]} entries registered actions
 * @returns {Map<string, object>} frozen entries by action id
 */
export function compileCatalog(entries = []) {
  if (!Array.isArray(entries)) {
    throw new PolicyCatalogError('catalog must be an array of action entries', 'POLICY_CATALOG_INVALID');
  }
  const catalog = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PolicyCatalogError('each catalog entry must be an object', 'POLICY_CATALOG_INVALID');
    }
    const action = requireString(entry.action, 'action', 'POLICY_CATALOG_INVALID');
    if (catalog.has(action)) {
      throw new PolicyCatalogError(`duplicate action "${action}" in catalog`, 'POLICY_CATALOG_DUPLICATE', { action });
    }
    if (!KINDS.has(entry.kind)) {
      throw new PolicyCatalogError(`action "${action}" kind must be read, write or confirm`, 'POLICY_CATALOG_INVALID', { action });
    }
    requireString(entry.target, `action "${action}" target`, 'POLICY_CATALOG_INVALID');
    if (entry.egress !== undefined && !EGRESS_VALUES.has(entry.egress)) {
      throw new PolicyCatalogError(`action "${action}" egress must be allow, confirm or deny`, 'POLICY_CATALOG_INVALID', { action });
    }
    if (entry.retry !== undefined && !RETRY_VALUES.has(entry.retry)) {
      throw new PolicyCatalogError(`action "${action}" retry must be none, read_recheck or safe_retry`, 'POLICY_CATALOG_INVALID', { action });
    }
    catalog.set(action, Object.freeze({
      action,
      kind: entry.kind,
      target: entry.target,
      egress: entry.egress ?? 'confirm',
      retry: entry.retry ?? (entry.kind === 'read' ? 'read_recheck' : 'none'),
      enabled: entry.enabled === true,
    }));
  }
  return catalog;
}

/**
 * Decide one action against the compiled catalog.
 *
 * `claims` carries whatever the caller or tool self-reports (for example
 * `readOnly`); it is deliberately not read by any rule, and the returned
 * decision therefore cannot be widened by it.
 *
 * @param {{catalog: Map<string, object>, action: string, target?: string, egress?: string}} request
 * @returns {{action: 'allow' | 'confirm' | 'deny', reason: string, rule: string}}
 */
export function decideAction({ catalog, action, target, egress }) {
  if (!(catalog instanceof Map)) {
    return { action: 'deny', reason: 'policy catalog is not compiled', rule: 'policy-unavailable' };
  }
  const entry = catalog.get(action);
  if (entry === undefined) {
    return { action: 'deny', reason: `action "${action}" is not registered`, rule: 'unregistered-action' };
  }
  if (entry.enabled !== true) {
    return { action: 'deny', reason: `action "${action}" is not enabled`, rule: 'action-disabled' };
  }
  if (typeof target !== 'string' || target.trim().length === 0) {
    return { action: 'deny', reason: `action "${action}" requires a ${entry.target} target`, rule: 'target-required' };
  }
  if (egress !== undefined && entry.egress === 'deny') {
    return { action: 'deny', reason: `action "${action}" is not allowed to leave the host`, rule: 'egress-denied' };
  }
  if (entry.kind === 'confirm') {
    return { action: 'confirm', reason: `action "${action}" requires an explicit confirmation`, rule: 'confirm-required' };
  }
  if (entry.egress === 'confirm' && egress !== undefined) {
    return { action: 'confirm', reason: `action "${action}" sends data out and requires confirmation`, rule: 'egress-confirm' };
  }
  return { action: 'allow', reason: `action "${action}" is registered as ${entry.kind}`, rule: 'registered-action' };
}
