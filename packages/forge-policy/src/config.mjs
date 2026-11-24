/**
 * 配置模型与装载期校验（D33/D34/D40/D53/D54）。
 *
 * 校验一次性完成：返回全部问题，每条都带键路径（`catalog[3].category`、
 * `rules.confirmPush`），任一失败拒绝挂载，不静默降级。未实现的开关任一置 `true`
 * 即按 fail-closed 拒绝启用并报键名；逐阶段放开时只需把键名加入
 * `IMPLEMENTED_RULES`，默认值与校验保持同源。
 */

import { catalogIssues } from './catalog.mjs';
import { isPathTemplate, resolveProtectedRoots, templateEnv } from './paths.mjs';

export class PolicyConfigError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [String(issues)];
    super(`invalid forge-policy config: ${list.join('; ')}`);
    this.name = 'PolicyConfigError';
    this.code = 'POLICY_CONFIG_INVALID';
    this.issues = Object.freeze([...list]);
  }
}

/** 七个规则开关：代码内禁止任何 `true` 默认。 */
export const RULE_KEYS = Object.freeze([
  'denyUnknownAction',
  'denyHumanRecord',
  'protectPaths',
  'enforceProcessRules',
  'contentGate',
  'confirmPush',
  'confirmDopWrite',
]);

/**
 * 已删除的开关：装载期点名给出迁移说明，既不静默忽略，也不保留会悄悄失效的别名。
 * 删除理由见 docs/design/plugins/forge-policy.md §5.1.4——子代理受控写恒拒，
 * 需要确认的写统一由主会话代问。
 */
export const REMOVED_RULE_KEYS = Object.freeze({
  denyDelegatedWrites: '该开关已删除：子代理发起受控写恒拒，需要确认的写由主会话代问；请从配置中移除',
  denyIamStoreAccess: '该开关已取消：IAM 存档守卫随 credentials-store-location 服务自动生效，不再由规则开关控制；请从配置中移除',
  denyIamTokenAccess: '该开关已取消：IAM 取票守卫随 credentials-store-location 服务自动生效，不再由规则开关控制；请从配置中移除',
});

/**
 * 已实现七键：内容闸、两条逐次确认、流程闸与三个语义开关。
 */
export const IMPLEMENTED_RULES = Object.freeze([
  'contentGate',
  'confirmPush',
  'confirmDopWrite',
  'enforceProcessRules',
  'denyUnknownAction',
  'denyHumanRecord',
  'protectPaths',
]);

/** 逐次确认的默认等待时间：120 秒。超时即拒绝，不再补问。 */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120_000;

/** `confirmation` 段唯一开放的键：未知键在装载期报错，避免写了却没人读。 */
export const CONFIRMATION_KEYS = Object.freeze(['timeoutMs']);

/** `content` 段唯一开放的键：拼错的预算必须报错，而不是静默退回默认值。 */
export const CONTENT_KEYS = Object.freeze(['maxBytes']);

export const DEFAULT_RULES = Object.freeze(Object.fromEntries(RULE_KEYS.map((key) => [key, false])));

export const DEFAULTS = Object.freeze({
  catalog: Object.freeze([]),
  rules: DEFAULT_RULES,
  confirmation: Object.freeze({ timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS }),
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

function checkContent(issues, content) {
  if (content === undefined) return;
  if (!isPlainObject(content)) {
    issues.push('content: must be an object when provided');
    return;
  }
  for (const [key] of Object.entries(content)) {
    if (!CONTENT_KEYS.includes(key)) issues.push(`content.${key}: unknown config key`);
  }
  // 与内容扫描器的预算判定保持一致（`Number.isSafeInteger` 且为正），
  // 避免装载期接受一个扫描器不会采用的数值、再静默退回 256 KiB 默认值。
  if (content.maxBytes !== undefined && !(Number.isSafeInteger(content.maxBytes) && content.maxBytes > 0)) {
    issues.push('content.maxBytes: must be a positive safe integer');
  }
}

function checkRules(issues, rules) {
  if (rules === undefined) return;
  if (!isPlainObject(rules)) {
    issues.push('rules: must be an object of rule switches');
    return;
  }
  for (const [key, value] of Object.entries(rules)) {
    if (!RULE_KEYS.includes(key)) {
      const guidance = Object.hasOwn(REMOVED_RULE_KEYS, key) ? `（${REMOVED_RULE_KEYS[key]}）` : '';
      issues.push(`rules.${key}: unknown rule switch${guidance}`);
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

/**
 * 两层路径模板共用的语法校验：数组、非空字符串、绝对路径或 `$VAR` 模板。
 * 两处一次报全，不因第一个非法项就停下。
 */
function checkTemplateList(issues, value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push(`${label}: must be an array of path templates`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(`${label}[${index}]: must be a non-empty string`);
      return;
    }
    if (!isPathTemplate(entry)) {
      issues.push(`${label}[${index}]: must be an absolute path or a $VAR template`);
    }
  });
}

function checkPaths(issues, paths) {
  if (paths === undefined) return;
  if (!isPlainObject(paths)) {
    issues.push('paths: must be an object when provided');
    return;
  }
  checkTemplateList(issues, paths.append, 'paths.append');
}

function checkProtectedPaths(issues, protectedPaths) {
  checkTemplateList(issues, protectedPaths, 'protectedPaths');
}

function checkTemplateExpansion(issues, input) {
  // 逐面逐项报：报错要指出是哪一个配置项，配置多了也分得清来源，
  // 与 L1（语法）一面的 `label[i]` 口径保持一致。
  const faces = [
    ['protectedPaths', Array.isArray(input.protectedPaths) ? input.protectedPaths : []],
    ['paths.append', Array.isArray(input.paths?.append) ? input.paths.append : []],
  ];
  const env = templateEnv(input.env);
  for (const [label, values] of faces) {
    values.forEach((template, index) => {
      if (!isPathTemplate(template)) return;
      try {
        resolveProtectedRoots([template], env);
      } catch (error) {
        issues.push(`${label}[${index}]: 模板 ${template} 无法展开（${error?.code ?? 'POLICY_CONFIG_INVALID'}）`);
      }
    });
  }
}

/**
 * 两层配置的稳定并集：`protectedPaths` 在前、`paths.append` 在后，按字符串去重保序。
 * 门禁的判定顺序与展示都读这一份，避免两个入口各拼一次。
 *
 * @param {{protectedPaths?: readonly string[], paths?: {append?: readonly string[]}}} [input]
 * @returns {readonly string[]}
 */
export function collectPathTemplates(input = {}) {
  const direct = Array.isArray(input?.protectedPaths) ? input.protectedPaths : [];
  const append = Array.isArray(input?.paths?.append) ? input.paths.append : [];
  const seen = new Set();
  const templates = [];
  for (const value of [...direct, ...append]) {
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    templates.push(value);
  }
  return Object.freeze(templates);
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

/**
 * 未接入判定链路的配置面在装载期拒绝，避免"配了却静默不生效"。
 *
 * 取默认值等同于没有设置：宿主 loader 会把 `Config` 的规范化结果再交给插件一次，
 * 那份结果里带着默认值，必须原样通过，否则正常装载也会被判非法。
 */
function checkUnwiredSurfaces(issues, input) {
  if (isPlainObject(input.categories) && Object.keys(input.categories).length > 0 && !sameAsDefault(input.categories, DEFAULTS.categories)) {
    issues.push('categories: not implemented in this phase; setting it would be silently ignored');
  }
}

/** 结构相等的默认值判定；只用于纯 JSON 面（数字/字符串/数组/普通对象）。 */
function sameAsDefault(value, fallback) {
  if (value === fallback) return true;
  if (Array.isArray(value) || Array.isArray(fallback)) {
    if (!Array.isArray(value) || !Array.isArray(fallback) || value.length !== fallback.length) return false;
    return value.every((item, index) => sameAsDefault(item, fallback[index]));
  }
  if (isPlainObject(value) && isPlainObject(fallback)) {
    const keys = Object.keys(value);
    if (keys.length !== Object.keys(fallback).length) return false;
    return keys.every((key) => Object.hasOwn(fallback, key) && sameAsDefault(value[key], fallback[key]));
  }
  return false;
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
    else {
      for (const key of Object.keys(input.confirmation)) {
        if (!CONFIRMATION_KEYS.includes(key)) issues.push(`confirmation.${key}: unknown config key`);
      }
      checkPositiveInteger(issues, input.confirmation.timeoutMs, 'confirmation.timeoutMs');
    }
  }
  checkContent(issues, input.content);
  checkPaths(issues, input.paths);
  checkProtectedPaths(issues, input.protectedPaths);
  checkAudit(issues, input.audit);
  checkObservation(issues, input.observation);
  checkMappings(issues, 'tools', input.tools);
  checkUnwiredSurfaces(issues, input);

  if (input.onDecision !== undefined && typeof input.onDecision !== 'function') {
    issues.push('onDecision: must be a function');
  }
  if (input.env !== undefined && !isPlainObject(input.env)) {
    issues.push('env: must be an object when provided');
  }
  checkTemplateExpansion(issues, input);

  if (issues.length > 0) return { issues };

  return {
    value: {
      catalog: input.catalog ?? [],
      rules: Object.freeze({ ...DEFAULT_RULES, ...(input.rules ?? {}) }),
      // 已接入判定链路（P1）：`confirmation.timeoutMs` 真的会传给确认通道。
      confirmation: Object.freeze({ ...DEFAULTS.confirmation, ...(input.confirmation ?? {}) }),
      // 已接入内容闸（P2）：`content.maxBytes` 会作为单次调用的扫描预算传下去。
      content: Object.freeze({ ...DEFAULTS.content, ...(input.content ?? {}) }),
      // `paths` 保留宿主写入的原值（含追加根）；`protectedPaths` 是判定用的稳定并集。
      paths: Object.freeze({
        append: Object.freeze(Array.isArray(input.paths?.append) ? [...input.paths.append] : []),
      }),
      protectedPaths: collectPathTemplates(input),
      audit: Object.freeze({ ...DEFAULTS.audit, ...(input.audit ?? {}) }),
      tools: input.tools ?? {},
      categories: DEFAULTS.categories,
      observation: input.observation ?? {},
      env: input.env,
      onDecision: input.onDecision,
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
