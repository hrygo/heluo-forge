/**
 * 受控写目录：只登记 6 条写动作，字段仅 `action/target/category`。
 *
 * 目录不是权限表：读动作不入目录，走 out-of-scope 放行（D22）。登记本身只声明
 * "这个动作受策略管理"，是否拦截由规则开关在判定期决定；P0 八开关全关时，
 * 登记只带来一条审计，不新增拦截。
 */

import { CATEGORY, PolicyClassifyError, classifyAction } from './classify.mjs';

export class PolicyCatalogError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyCatalogError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const ENTRY_FIELDS = new Set(['action', 'target', 'category']);
const WRITE_CATEGORIES = new Set([CATEGORY.DEV_WRITE, CATEGORY.REVIEW_WRITE, CATEGORY.REMOTE_WRITE, CATEGORY.HUMAN_RECORD]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 六层校验中的目录层：一次性列出全部问题，每条都带键路径（`catalog[3].category`）。
 *
 * @param {unknown} entries
 * @returns {string[]} messages, each prefixed with its key path
 */
export function catalogIssues(entries) {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return ['catalog: must be an array of catalog entries'];
  const issues = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    const at = `catalog[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(`${at}: each entry must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(key)) issues.push(`${at}.${key}: unknown field (only action/target/category are accepted)`);
    }
    if (typeof entry.action !== 'string' || entry.action.trim() === '') {
      issues.push(`${at}.action: an action name is required`);
    }
    if (typeof entry.target !== 'string' || entry.target.trim() === '') {
      issues.push(`${at}.target: a target name is required`);
    }
    if (typeof entry.category !== 'string' || entry.category.trim() === '') {
      issues.push(`${at}.category: a category is required`);
    }
    if (typeof entry.action !== 'string' || entry.action.trim() === '') return;
    if (seen.has(entry.action)) {
      issues.push(`${at}.action: duplicate action "${entry.action}"`);
      return;
    }
    seen.add(entry.action);
    const classified = classifyAction(entry.action);
    if (classified === undefined) {
      issues.push(`${at}.action: "${entry.action}" is not a classified action`);
      return;
    }
    if (!WRITE_CATEGORIES.has(classified.category)) {
      issues.push(`${at}.action: read action "${entry.action}" is out of scope and must not be registered`);
      return;
    }
    if (typeof entry.target === 'string' && entry.target !== classified.target) {
      issues.push(`${at}.target: "${entry.target}" does not match the builtin target "${classified.target}"`);
    }
    if (typeof entry.category === 'string' && entry.category !== classified.category) {
      issues.push(`${at}.category: "${entry.category}" does not match the builtin category "${classified.category}"`);
    }
  });
  return issues;
}

function catalogError(message, code, details = undefined) {
  return new PolicyCatalogError(message, code, details);
}

/**
 * Compile the catalog. Invalid entries throw instead of silently shrinking: a
 * catalog that mounted with fewer actions would silently stop gating them.
 *
 * @param {unknown} entries
 * @returns {Map<string, Readonly<{action: string, target: string, category: string}>>}
 */
export function compileCatalog(entries = []) {
  const issues = catalogIssues(entries);
  if (issues.length > 0) {
    throw catalogError(`invalid policy catalog: ${issues.join('; ')}`, 'POLICY_CATALOG_INVALID', { issues });
  }
  const catalog = new Map();
  for (const entry of entries ?? []) {
    const classified = classifyAction(entry.action);
    catalog.set(entry.action, Object.freeze({
      action: entry.action,
      target: entry.target,
      category: entry.category,
      decision: classified.decision,
    }));
  }
  return catalog;
}

function allow(rule, reason) {
  return Object.freeze({ action: 'allow', rule, reason });
}

function deny(rule, reason) {
  return Object.freeze({ action: 'deny', rule, reason });
}

function confirm(rule, reason) {
  return Object.freeze({ action: 'confirm', rule, reason });
}

/**
 * The decision of the three-state classification (`deny > confirm > allow`).
 *
 * @param {...('allow' | 'confirm' | 'deny')} decisions
 */
export function composeDecision(...decisions) {
  const rank = { allow: 0, confirm: 1, deny: 2 };
  let result = 'allow';
  for (const decision of decisions) {
    if (!Object.hasOwn(rank, decision)) {
      throw new PolicyClassifyError(`unknown decision "${decision}"`, 'POLICY_DECISION_INVALID', { decision });
    }
    if (rank[decision] > rank[result]) result = decision;
  }
  return result;
}

/**
 * 判定一个动作在当前规则下是否受控、以及判定结果。
 *
 * 全关时：未登记 → out-of-scope 放行；登记写 → 放行（只记一条审计）；
 * 人工留痕动作在 `denyHumanRecord` 关闭时同样放行。规则打开后才收紧。
 *
 * @param {{catalog: Map, rules?: object, action: string, target?: string}} request
 * @returns {{action: 'allow' | 'deny' | 'confirm', rule: string, reason: string}}
 */
export function decideAction({ catalog, rules = {}, action, target } = {}) {
  if (!(catalog instanceof Map)) {
    return deny('policy-unavailable', 'no compiled policy catalog is available');
  }
  if (typeof action !== 'string' || action.length === 0) {
    return deny('action-required', 'a policy decision needs an action name');
  }
  const entry = catalog.get(action);
  if (entry === undefined) {
    if (rules.denyUnknownAction === true) {
      return deny('unregistered-action', `action "${action}" is not registered in the policy catalog`);
    }
    return allow('out-of-scope', `action "${action}" is not a controlled write action`);
  }
  if (typeof target !== 'string' || target.trim() === '') {
    return deny('target-required', `action "${action}" needs a business target`);
  }
  const classified = classifyAction(action);
  if (classified === undefined) {
    return deny('unregistered-action', `action "${action}" has no builtin classification`);
  }
  if (classified.category === CATEGORY.HUMAN_RECORD) {
    if (rules.denyHumanRecord === true) {
      return deny('human-record-action', 'a human record can only be written by a human, never by an agent');
    }
    return allow('out-of-scope', 'human record writes are not gated in this phase');
  }
  const confirmRule = action === 'gitee.git.push' ? 'confirmPush'
    : action === 'change.clarification.write' ? 'confirmDopWrite'
      : undefined;
  if (confirmRule !== undefined && rules[confirmRule] === true) {
    return confirm('confirm-required', `action "${action}" requires a per-call confirmation`);
  }
  return allow('registered-write', `action "${action}" is registered and no enabled rule forbids it`);
}
