/**
 * 配置模型与装载期校验（D33/D34/D40/D53/D54）。
 *
 * 校验一次性完成：返回全部问题，每条都带键路径（`catalog[3].category`、
 * `rules.confirmPush`），任一失败拒绝挂载，不静默降级。八开关在 P0 均无实现，
 * 任一置 `true` 即按 fail-closed 拒绝启用并报键名；P1–P3 逐个放开时只需把键名
 * 加入 `IMPLEMENTED_RULES`，默认值与校验保持同源。
 */

import { catalogIssues } from './catalog.mjs';

export class PolicyConfigError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [String(issues)];
    super(`invalid forge-policy config: ${list.join('; ')}`);
    this.name = 'PolicyConfigError';
    this.code = 'POLICY_CONFIG_INVALID';
    this.issues = Object.freeze([...list]);
  }
}

/** 八个规则开关：代码内禁止任何 `true` 默认。 */
export const RULE_KEYS = Object.freeze([
  'denyDelegatedWrites',
  'denyUnknownAction',
  'denyHumanRecord',
  'protectPaths',
  'enforceProcessRules',
  'contentGate',
  'confirmPush',
  'confirmDopWrite',
]);

/** P0 无任何已实现规则；P1–P3 只在这里追加键名。 */
export const IMPLEMENTED_RULES = Object.freeze([]);

export const DEFAULT_RULES = Object.freeze(Object.fromEntries(RULE_KEYS.map((key) => [key, false])));

export const DEFAULTS = Object.freeze({
  catalog: Object.freeze([]),
  rules: DEFAULT_RULES,
  confirmation: Object.freeze({ timeoutMs: 120_000 }),
  content: Object.freeze({ maxBytes: 262_144 }),
  paths: Object.freeze({ append: Object.freeze([]) }),
  audit: Object.freeze({ sink: 'memory', buffer: 1_000, keepDays: 7, timeoutMs: 2_000 }),
  tools: Object.freeze({}),
  categories: Object.freeze({}),
  observation: Object.freeze({}),
});

const TOP_LEVEL_KEYS = new Set([
  'catalog', 'rules', 'confirmation', 'content', 'paths', 'audit',
  'tools', 'categories', 'observation', 'env', 'onDecision', 'protectedPaths',
]);

const AUDIT_SINKS = new Set(['memory', 'file']);
const AUDIT_KEYS = new Set(['sink', 'buffer', 'keepDays', 'timeoutMs']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function checkPositiveInteger(issues, value, path) {
  if (value !== undefined && !isPositiveInteger(value)) issues.push(`${path}: must be a positive integer`);
}

function checkRules(issues, rules) {
  if (rules === undefined) return;
  if (!isPlainObject(rules)) {
    issues.push('rules: must be an object of rule switches');
    return;
  }
  for (const [key, value] of Object.entries(rules)) {
    if (!RULE_KEYS.includes(key)) {
      issues.push(`rules.${key}: unknown rule switch`);
      continue;
    }
    if (typeof value !== 'boolean') {
      issues.push(`rules.${key}: must be a boolean`);
      continue;
    }
    if (value === true && !IMPLEMENTED_RULES.includes(key)) {
      issues.push(`rules.${key}: this rule is not implemented in this phase and cannot be enabled`);
    }
  }
}

function checkAudit(issues, audit) {
  if (audit === undefined) return;
  if (!isPlainObject(audit)) {
    issues.push('audit: must be an object when provided');
    return;
  }
  for (const key of Object.keys(audit)) {
    if (!AUDIT_KEYS.has(key)) issues.push(`audit.${key}: unknown config key`);
  }
  if (audit.sink !== undefined && !AUDIT_SINKS.has(audit.sink)) {
    issues.push('audit.sink: must be memory or file');
  }
  checkPositiveInteger(issues, audit.buffer, 'audit.buffer');
  checkPositiveInteger(issues, audit.keepDays, 'audit.keepDays');
  checkPositiveInteger(issues, audit.timeoutMs, 'audit.timeoutMs');
}

function checkPaths(issues, paths) {
  if (paths === undefined) return;
  if (!isPlainObject(paths)) {
    issues.push('paths: must be an object when provided');
    return;
  }
  if (paths.append !== undefined) {
    if (!Array.isArray(paths.append)) issues.push('paths.append: must be an array of path templates');
    else {
      paths.append.forEach((value, index) => {
        if (typeof value !== 'string' || value.trim() === '') issues.push(`paths.append[${index}]: must be a non-empty string`);
      });
    }
  }
}

function checkObservation(issues, observation) {
  // 过程观察只开放"是否启用"：端点、认证与响应格式不由本仓库发明。
  if (observation !== undefined && !isPlainObject(observation)) {
    issues.push('observation: must be an object when provided');
    return;
  }
  if (!isPlainObject(observation)) return;
  if (observation.enums !== undefined) {
    if (!isPlainObject(observation.enums)) issues.push('observation.enums: must be an object');
    else {
      for (const [name, values] of Object.entries(observation.enums)) {
        if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
          issues.push(`observation.enums.${name}: must be an array of non-empty strings`);
        }
      }
    }
  }
  if (observation.export !== undefined) {
    const exportConfig = observation.export;
    if (!isPlainObject(exportConfig)) issues.push('observation.export: must be an object');
    else {
      if (exportConfig.enabled !== undefined && typeof exportConfig.enabled !== 'boolean') {
        issues.push('observation.export.enabled: must be a boolean');
      }
      if (exportConfig.idempotentProvider !== undefined && typeof exportConfig.idempotentProvider !== 'boolean') {
        issues.push('observation.export.idempotentProvider: must be a boolean');
      }
      if (exportConfig.batchSize !== undefined && !isPositiveInteger(exportConfig.batchSize)) {
        issues.push('observation.export.batchSize: must be a positive integer');
      }
    }
  }
}

function checkMappings(issues, label, mapping) {
  if (mapping === undefined) return;
  if (!isPlainObject(mapping)) {
    issues.push(`${label}: must be an object mapping a name to an action id`);
    return;
  }
  for (const [name, action] of Object.entries(mapping)) {
    if (typeof action !== 'string' || action.trim() === '') issues.push(`${label}.${name}: must name an action id`);
  }
}

/**
 * 六层校验：一次返回全部问题，每条带键路径。
 *
 * @param {unknown} input
 * @returns {{value: object} | {issues: string[]}}
 */
export function validateConfig(input = {}) {
  if (!isPlainObject(input)) return { issues: ['config: must be an object'] };
  const issues = [];

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      issues.push(`${key}: unknown config key`);
    }
  }

  issues.push(...catalogIssues(input.catalog));
  checkRules(issues, input.rules);

  if (input.confirmation !== undefined) {
    if (!isPlainObject(input.confirmation)) issues.push('confirmation: must be an object when provided');
    else checkPositiveInteger(issues, input.confirmation.timeoutMs, 'confirmation.timeoutMs');
  }
  if (input.content !== undefined) {
    if (!isPlainObject(input.content)) issues.push('content: must be an object when provided');
    else checkPositiveInteger(issues, input.content.maxBytes, 'content.maxBytes');
  }
  checkPaths(issues, input.paths);
  checkAudit(issues, input.audit);
  checkObservation(issues, input.observation);
  checkMappings(issues, 'tools', input.tools);
  checkMappings(issues, 'categories', input.categories);

  if (input.onDecision !== undefined && typeof input.onDecision !== 'function') {
    issues.push('onDecision: must be a function');
  }
  if (input.protectedPaths !== undefined) {
    if (!Array.isArray(input.protectedPaths)) issues.push('protectedPaths: must be an array of protected roots');
    else {
      input.protectedPaths.forEach((value, index) => {
        if (typeof value !== 'string' || value.trim() === '') issues.push(`protectedPaths[${index}]: must be a non-empty string`);
      });
    }
  }
  if (input.env !== undefined && !isPlainObject(input.env)) {
    issues.push('env: must be an object when provided');
  }

  if (issues.length > 0) return { issues };

  return {
    value: {
      catalog: input.catalog ?? [],
      rules: Object.freeze({ ...DEFAULT_RULES, ...(input.rules ?? {}) }),
      confirmation: Object.freeze({ ...DEFAULTS.confirmation, ...(input.confirmation ?? {}) }),
      content: Object.freeze({ ...DEFAULTS.content, ...(input.content ?? {}) }),
      paths: Object.freeze({ append: Object.freeze([...(input.paths?.append ?? [])]) }),
      audit: Object.freeze({ ...DEFAULTS.audit, ...(input.audit ?? {}) }),
      tools: input.tools ?? {},
      categories: input.categories ?? {},
      observation: input.observation ?? {},
      env: input.env,
      onDecision: input.onDecision,
      protectedPaths: input.protectedPaths,
    },
  };
}

/**
 * Validate and throw once, so assembly never proceeds on a partial config.
 *
 * @param {unknown} rawConfig
 * @returns {object} the frozen-by-sections resolved config
 */
export function resolveConfig(rawConfig = {}) {
  const result = validateConfig(rawConfig);
  if (result.issues !== undefined) throw new PolicyConfigError(result.issues);
  return result.value;
}

export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'heluo',
    validate: validateConfig,
  }),
});
