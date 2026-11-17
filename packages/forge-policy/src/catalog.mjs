/**
 * 受控动作目录：编译与判定。
 *
 * 目录只能登记随包分类中已有的动作，并声明目标类型与显式开放标记；分类、
 * 默认决策、内容与流程规则来自 `classify.mjs`，不从工具自报属性推导。未登记、
 * 未开放、目标缺失或错配一律拒绝（fail closed）。
 */
import { PolicyClassifyError, classifyAction, strictestDecision } from './classify.mjs';

export class PolicyCatalogError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyCatalogError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const ENTRY_FIELDS = new Set(['action', 'target', 'revision', 'enabled']);

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
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(key)) {
        throw new PolicyCatalogError(`catalog entry has unknown field "${key}"`, 'POLICY_CATALOG_UNKNOWN_FIELD', { field: key });
      }
    }
    const action = requireString(entry.action, 'action', 'POLICY_CATALOG_INVALID');
    if (catalog.has(action)) {
      throw new PolicyCatalogError(`duplicate action "${action}" in catalog`, 'POLICY_CATALOG_DUPLICATE', { action });
    }
    let classified;
    try {
      classified = classifyAction(action);
    } catch (error) {
      if (error instanceof PolicyClassifyError) {
        throw new PolicyCatalogError(`action "${action}" is not classified by this policy version`, 'POLICY_CATALOG_UNKNOWN_ACTION', { action });
      }
      throw error;
    }
    if (classified === undefined) {
      throw new PolicyCatalogError(`action "${action}" is not classified by this policy version`, 'POLICY_CATALOG_UNKNOWN_ACTION', { action });
    }
    if (entry.target === undefined) {
      throw new PolicyCatalogError(
        `action "${action}" must declare target "${classified.target}"`,
        'POLICY_CATALOG_TARGET_MISMATCH',
        { action, expected: classified.target },
      );
    }
    const target = requireString(entry.target, `action "${action}" target`, 'POLICY_CATALOG_INVALID');
    if (target !== classified.target) {
      throw new PolicyCatalogError(
        `action "${action}" declares target "${target}" but is classified as "${classified.target}"`,
        'POLICY_CATALOG_TARGET_MISMATCH',
        { action, target, expected: classified.target },
      );
    }
    if (entry.revision !== undefined && typeof entry.revision !== 'boolean') {
      throw new PolicyCatalogError(`action "${action}" revision must be a boolean`, 'POLICY_CATALOG_INVALID', { action });
    }
    // `enabled` 必须显式写布尔：省略或写字符串会让"登记了却没开"静默发生，
    // 与旧实现 `entry.enabled === true` 的坑相对。
    if (typeof entry.enabled !== 'boolean') {
      throw new PolicyCatalogError(`action "${action}" enabled must be an explicit boolean`, 'POLICY_CATALOG_INVALID', { action });
    }
    catalog.set(action, Object.freeze({
      action,
      target,
      revision: entry.revision === true || classified.revision === true,
      enabled: entry.enabled,
      category: classified.category,
      decision: classified.decision,
      contentGate: classified.contentGate,
      processRules: classified.processRules,
      confirmation: classified.confirmation,
    }));
  }
  return catalog;
}

/**
 * Decide one action against the compiled catalog.
 *
 * `claims` carries whatever the caller or tool self-reports (for example
 * `readOnly`); it is deliberately not read by any rule, and the returned
 * decision therefore cannot be widened by it. Content and process rules are
 * applied by the gate; this decision is the action-level default only.
 *
 * @param {{catalog: Map<string, object>, action: string, target?: string, egress?: string}} request
 * @returns {{action: 'allow' | 'confirm' | 'deny', reason: string, rule: string}}
 */
export function decideAction({ catalog, action, target }) {
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
  if (entry.decision === 'deny') {
    return { action: 'deny', reason: `action "${action}" is reserved for human-written records and cannot be started by an agent`, rule: 'human-record-action' };
  }
  if (typeof target !== 'string' || target.trim().length === 0) {
    return { action: 'deny', reason: `action "${action}" requires a ${entry.target} target`, rule: 'target-required' };
  }
  if (entry.decision === 'confirm') {
    return { action: 'confirm', reason: `action "${action}" requires an explicit confirmation`, rule: 'confirm-required' };
  }
  return { action: 'allow', reason: `action "${action}" is registered`, rule: 'registered-action' };
}

/**
 * Compose the final decision from every axis that spoke.
 *
 * @param {...string} decisions
 * @returns {'allow' | 'confirm' | 'deny'}
 */
export function composeDecision(...decisions) {
  return strictestDecision(...decisions);
}
