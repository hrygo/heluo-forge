/**
 * 内容规则：判定"写进去的内容"能不能落盘或外发（P2 内容闸）。
 *
 * 内置集随包编译、不可删除；组织层只能追加规则。规则是有上限的正则集合，
 * 不做语义分析，也不宣称能发现所有凭据。三档判定（D43–D51）：
 *
 * - `hard`（H1 私钥块、H2 云长期密钥）：直接拒绝，任何确认都不能提升；
 * - `confirm`（H3 带凭据连接串、H4 常见令牌）：可以确认后放行，但没有确认通道时拒绝；
 * - `soft`（S1–S5：`.env` 赋值、内网地址、本机绝对路径、超长 base64、`.env` 引用）：
 *   只记账，需要时由门禁升级成分步确认。
 */

import { createHash } from 'node:crypto';

export class PolicyContentError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyContentError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 编译后的规则上限：超过即拒绝装载，避免把"规则很多"当成"更安全"。 */
export const MAX_RULES = 30;
/** 单次调用的扫描载荷上限：各动作字段之和，超出的部分不检查并标出截断。 */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * 受控扫描接口的类别词表（D86）：提供方在脱敏子进程输出时报告被替换内容的类别，
 * 策略把类别映射到同目录规则，判定与直接扫到正文时一致。类别是封闭集合，
 * 未登记类别按"未完整扫描"处理。
 */
export const OBSERVATION_RULES = Object.freeze({
  token: 'BUILTIN-TOKEN',
  'credential-url': 'BUILTIN-CREDENTIAL-URL',
});

/** 三档判定，与 `severity` 一一对应。 */
export const SEVERITY = Object.freeze({ HARD: 'hard', CONFIRM: 'confirm', SOFT: 'soft' });

const SEVERITIES = new Set([SEVERITY.HARD, SEVERITY.CONFIRM, SEVERITY.SOFT]);
const REDACT_HEAD = 4;
const REDACT_TAIL = 4;

/** 稳定序列化：键排序后拼接，保证同一内容得到同一摘要。 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * 内容摘要（D76）：衔接"这次写的是什么"与审计里的一条摘要，不落原文。
 *
 * @param {unknown} content
 * @returns {string} sha256 hex
 */
export function digestContent(content) {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * 内置规则：H1/H2 不可确认，H3/H4 可确认，S1–S5 只记账。
 *
 * 口令赋值（原 H5）与强制推送（原 BUILTIN-FORCE-PUSH）已按 D43/D46 删除：
 * 前者在真实正文里误报太高，后者应由推送语义与流程规则判断，而不是扫正文关键字。
 */
const BUILTIN_RULES = Object.freeze([
  {
    id: 'BUILTIN-PRIVATE-KEY',
    severity: SEVERITY.HARD,
    pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----',
  },
  {
    id: 'BUILTIN-CLOUD-ACCESS-KEY',
    severity: SEVERITY.HARD,
    pattern: '(?i)\\b(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|secret[_-]?key)\\b\\s*[:=]\\s*["\']?[A-Za-z0-9/+=]{16,}',
  },
  {
    id: 'BUILTIN-CREDENTIAL-URL',
    severity: SEVERITY.CONFIRM,
    pattern: '(?i)\\b(?:jdbc|mongodb(?:\\+srv)?|redis|rediss|mysql|postgres(?:ql)?|amqp|ldaps?)://[^\\s:/@]+:[^\\s@]+@',
  },
  {
    id: 'BUILTIN-TOKEN',
    severity: SEVERITY.CONFIRM,
    pattern: '(?i)\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})',
  },
  { id: 'BUILTIN-ENV-COMMIT', severity: SEVERITY.SOFT, pattern: '(?m)^\\+\\s*(?:[A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD))=.{8,}' },
  {
    id: 'BUILTIN-INTERNAL-ADDRESS',
    severity: SEVERITY.SOFT,
    pattern: '(?i)(?:https?|wss?)://(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d+)?(?:/|$)',
  },
  { id: 'BUILTIN-ABSOLUTE-HOME', severity: SEVERITY.SOFT, pattern: '/(?:Users|home)/[A-Za-z0-9._-]+/' },
  { id: 'BUILTIN-LONG-BASE64', severity: SEVERITY.SOFT, pattern: '[A-Za-z0-9+/]{200,}={0,2}' },
  // S5 只认文本里的 `.env` 文件路径引用（D45）：`process.env.FOO_KEY` 这类代码标识不算。
  { id: 'BUILTIN-ENV-FILE', severity: SEVERITY.SOFT, pattern: '(?:^|[/\\s.])\\.env(?:\\.[A-Za-z0-9]+)?\\b' },
]);

/** 内置规则 id 与判定，供文档与测试比对（新增/删除规则必须同步这里）。 */
export const BUILTIN_RULE_SUMMARY = Object.freeze(
  BUILTIN_RULES.map((rule) => Object.freeze({ id: rule.id, severity: rule.severity })),
);

function compileOne(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new PolicyContentError('each content rule must be an object', 'POLICY_CONTENT_RULE_INVALID');
  }
  const { id } = rule;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new PolicyContentError('each content rule needs a non-empty id', 'POLICY_CONTENT_RULE_INVALID');
  }
  if (!SEVERITIES.has(rule.severity)) {
    throw new PolicyContentError(`content rule "${id}" severity must be one of hard, confirm, soft`, 'POLICY_CONTENT_RULE_INVALID', { id });
  }
  if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
    throw new PolicyContentError(`content rule "${id}" needs a pattern`, 'POLICY_CONTENT_RULE_INVALID', { id });
  }
  // 内置规则用 `(?i)`/`(?m)` 前缀表达标志位（JS 正则不支持内联修饰符），
  // 这里把前缀取出来换成构造器标志，pattern 本身保持可读。
  const inline = /^\(\?([imsu]+)\)/.exec(rule.pattern);
  const source = inline === null ? rule.pattern : rule.pattern.slice(inline[0].length);
  const flags = rule.flags ?? (inline === null ? 'u' : `${inline[1]}u`);
  let regex;
  try {
    regex = new RegExp(source, flags);
  } catch (error) {
    throw new PolicyContentError(`content rule "${id}" pattern does not compile (${error?.message ?? error})`, 'POLICY_CONTENT_RULE_INVALID', { id });
  }
  const paths = rule.paths ?? ['.*'];
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new PolicyContentError(`content rule "${id}" paths must be a non-empty array`, 'POLICY_CONTENT_RULE_INVALID', { id });
  }
  const pathRegexes = paths.map((path) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new PolicyContentError(`content rule "${id}" paths must be regular expressions`, 'POLICY_CONTENT_RULE_INVALID', { id });
    }
    try {
      return new RegExp(path, 'u');
    } catch (error) {
      throw new PolicyContentError(`content rule "${id}" path does not compile (${error?.message ?? error})`, 'POLICY_CONTENT_RULE_INVALID', { id });
    }
  });
  // `paths` 是正则而不是 glob：`.*` 匹配所有载荷字段名。
  return Object.freeze({ id, severity: rule.severity, source: rule.source ?? 'org', regex, pathRegexes });
}

/**
 * Compile the builtin set plus organization rules. Duplicate ids are rejected:
 * an org rule may not silently shadow a builtin rule.
 *
 * @param {readonly object[]} [extra] organization rules
 * @param {'org'} [source]
 * @returns {{rules: readonly object[], count: number}}
 */
export function compileContentRules(extra = [], source = 'org') {
  if (!Array.isArray(extra)) {
    throw new PolicyContentError('content rules must be an array', 'POLICY_CONTENT_RULE_INVALID');
  }
  const compiled = [];
  const ids = new Set();
  for (const raw of BUILTIN_RULES) {
    const rule = compileOne({ ...raw, source: 'builtin' });
    ids.add(rule.id);
    compiled.push(rule);
  }
  for (const raw of extra) {
    const rule = compileOne({ ...raw, source });
    if (ids.has(rule.id)) {
      throw new PolicyContentError(`duplicate content rule id "${rule.id}"`, 'POLICY_CONTENT_RULE_DUPLICATE', { id: rule.id });
    }
    ids.add(rule.id);
    compiled.push(rule);
  }
  if (compiled.length > MAX_RULES) {
    throw new PolicyContentError(`content rule set exceeds ${MAX_RULES} rules`, 'POLICY_CONTENT_RULE_LIMIT', { count: compiled.length });
  }
  return { rules: Object.freeze(compiled), count: compiled.length };
}

/**
 * Keep a short, non-reversible excerpt: the matched value is never echoed.
 *
 * @param {string} value
 * @returns {string}
 */
export function redactExcerpt(value) {
  const text = String(value ?? '');
  if (text.length <= REDACT_HEAD + REDACT_TAIL) return '***';
  return `${text.slice(0, REDACT_HEAD)}…${text.slice(-REDACT_TAIL)}`;
}

const BINARY_SNIFF_BYTES = 8 * 1024;

function isBinary(text) {
  const head = text.slice(0, BINARY_SNIFF_BYTES);
  return head.includes('\u0000');
}

/**
 * Scan one call's payload fields. `paths` are matched against the field name,
 * so a rule can restrict itself to, for example, `diff` or `body`.
 *
 * The byte budget is shared by every field of the call (D50): once it is spent,
 * the remaining fields are reported as `truncated` instead of scanned.
 *
 * @param {readonly object[]} rules compiled rules
 * `options.observations` carries classifications reported by the provider's
 * controlled scan interface (D86): a field whose text was redacted before the
 * policy saw it is judged by the category of what was removed, not by the
 * redacted text. Unregistered categories count as "not fully scanned".
 *
 * @param {readonly object[]} rules compiled rules
 * @param {readonly {field: string, text: string}[]} payloads
 * @param {{maxBytes?: number, observations?: readonly {field: string, kind: string}[]}} [options]
 * @returns {{findings: object[], hard: object[], confirm: object[], soft: object[], skipped: object[], truncated: boolean}}
 */
export function scanPayloads(rules, payloads, options = {}) {
  if (!Array.isArray(rules) || !Array.isArray(payloads)) {
    throw new PolicyContentError('scanPayloads needs compiled rules and payload fields', 'POLICY_CONTENT_RULE_INVALID');
  }
  const findings = [];
  const skipped = [];
  const seen = new Set();
  const budget = Number.isSafeInteger(options?.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_PAYLOAD_BYTES;
  let remaining = budget;
  for (const payload of payloads) {
    if (payload === null || typeof payload !== 'object') continue;
    const field = typeof payload.field === 'string' && payload.field.length > 0 ? payload.field : 'content';
    if (payload.text === undefined || payload.text === null) continue;
    let text = String(payload.text);
    if (text.length === 0) continue;
    if (isBinary(text)) {
      skipped.push({ field, reason: 'binary-skipped' });
      continue;
    }
    if (remaining <= 0) {
      skipped.push({ field, reason: 'truncated' });
      continue;
    }
    let truncated = false;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > remaining) {
      text = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
      remaining = 0;
      truncated = true;
    } else {
      remaining -= bytes;
    }
    let matched = false;
    for (const rule of rules) {
      if (!rule.pathRegexes.some((pathRegex) => pathRegex.test(field))) continue;
      // 组织规则可以带 `g`/`y` 这类有状态标志：复用一个表达式前必须归零位置，
      // 否则同一段内容第二次出现时会从上次的 lastIndex 继续匹配而漏检。
      rule.regex.lastIndex = 0;
      const match = rule.regex.exec(text);
      if (match === null) continue;
      const key = `${rule.id}:${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched = true;
      findings.push(Object.freeze({
        rule: rule.id,
        severity: rule.severity,
        source: rule.source,
        field,
        excerpt: redactExcerpt(match[0]),
        ...(truncated ? { truncated: true } : {}),
      }));
    }
    if (truncated) skipped.push({ field, reason: 'truncated', ...(matched ? {} : {}) });
  }
  // 受控扫描接口（D86）：提供方报告"被脱敏内容的类别"，策略据此复用同一套规则判定。
  // 内容已经过公共脱敏，这里只认类别，不再看正文；未登记类别视为"未完整扫描"。
  for (const observation of Array.isArray(options?.observations) ? options.observations : []) {
    if (observation === null || typeof observation !== 'object') continue;
    const field = typeof observation.field === 'string' && observation.field.length > 0 ? observation.field : 'content';
    const ruleId = Object.hasOwn(OBSERVATION_RULES, observation.kind) ? OBSERVATION_RULES[observation.kind] : undefined;
    if (ruleId === undefined) {
      skipped.push({ field, reason: 'redaction-unknown' });
      continue;
    }
    const rule = rules.find((item) => item.id === ruleId);
    if (rule === undefined) continue;
    const key = `${rule.id}:${field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(Object.freeze({ rule: rule.id, severity: rule.severity, source: rule.source, field, excerpt: '***' }));
  }
  const bySeverity = (severity) => Object.freeze(findings.filter((finding) => finding.severity === severity));
  return {
    findings: Object.freeze(findings),
    hard: bySeverity(SEVERITY.HARD),
    confirm: bySeverity(SEVERITY.CONFIRM),
    soft: bySeverity(SEVERITY.SOFT),
    skipped: Object.freeze(skipped),
    truncated: skipped.some((item) => item.reason === 'truncated'),
  };
}

/**
 * 每个受控写动作扫哪些字段（D47）。字段路径支持 `a.b` 与 `arr[].key`。
 *
 * 目录之外的动作（不该走到这里）退回全局白名单，宁可多扫也不要漏扫。
 */
export const CONTENT_FIELDS = Object.freeze({
  'gitee.issue.write': Object.freeze(['title', 'body']),
  'gitee.pr.write': Object.freeze(['title', 'body']),
  'gitee.review.publish': Object.freeze(['body', 'comment']),
  'change.clarification.write': Object.freeze(['summary', 'description', 'aiAc']),
  'gitee.git.push': Object.freeze(['commits[].message', 'commits[].diff']),
  'gitee.review.record': Object.freeze([]),
});

/** 全局白名单：目录外动作与 `exec.arguments` 兜底时使用。 */
const FALLBACK_FIELDS = Object.freeze([
  'title', 'body', 'description', 'content', 'message', 'comment', 'review', 'summary', 'text', 'diff', 'patch',
]);

function expandField(args, path) {
  const segments = path.split('.');
  const out = [];
  const walk = (value, index, label) => {
    if (index === segments.length) {
      if (typeof value === 'string' && value.length > 0) out.push({ field: label, text: value });
      return;
    }
    const segment = segments[index];
    // `commits[]` 与 `commits[*]` 都表示"这个数组的每一项"。
    const spread = /^([A-Za-z0-9_-]+)\[(?:\*)?\]$/.exec(segment);
    if (spread !== null) {
      if (value === null || typeof value !== 'object') return;
      const list = value[spread[1]];
      if (!Array.isArray(list)) return;
      for (const [position, item] of list.entries()) walk(item, index + 1, `${label === '' ? spread[1] : `${label}.${spread[1]}`}[${position}]`);
      return;
    }
    if (segment === '*') {
      if (!Array.isArray(value)) return;
      for (const [position, item] of value.entries()) walk(item, index + 1, `${label}[${position}]`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    walk(value[segment], index + 1, label === '' ? segment : `${label}.${segment}`);
  };
  walk(args, 0, '');
  return out;
}

/**
 * 按动作声明挑选待扫字段（D47）。未知动作退回全局白名单。
 *
 * @param {string} action
 * @param {Record<string, unknown>} args
 * @returns {{field: string, text: string}[]}
 */
export function payloadsForAction(action, args = {}) {
  if (args === null || typeof args !== 'object') return [];
  const declared = Object.hasOwn(CONTENT_FIELDS, action) ? CONTENT_FIELDS[action] : undefined;
  const payloads = [];
  if (declared !== undefined) {
    for (const path of declared) payloads.push(...expandField(args, path));
    return payloads;
  }
  for (const key of FALLBACK_FIELDS) {
    if (typeof args[key] === 'string' && args[key].length > 0) payloads.push({ field: key, text: args[key] });
  }
  // 提交集合在动作解析之前也要能扫到：推送的正文既可能在 message，也可能在 diff。
  payloads.push(...expandField(args, 'commits[].message'), ...expandField(args, 'commits[].diff'));
  return payloads;
}

/**
 * Payload fields a tool call writes when the action is not known up front.
 * Kept for callers that scan raw arguments before action resolution.
 *
 * @param {Record<string, unknown>} args
 * @returns {{field: string, text: string}[]}
 */
export function payloadsFromArguments(args = {}) {
  if (args === null || typeof args !== 'object') return [];
  const payloads = payloadsForAction('', args);
  for (const key of ['path', 'file', 'target']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) payloads.push({ field: key, text: value });
  }
  return payloads;
}

/**
 * Read the classifications a provider's controlled scan interface reports
 * (D86). The shape is `{redactions: [{field, kind}]}`; anything malformed is
 * reported as an unregistered category so it still lands in the audit instead
 * of silently passing.
 *
 * @param {unknown} value
 * @returns {{field: string, kind: string}[]}
 */
export function observationsFromContent(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.redactions)) return [];
  const observations = [];
  for (const item of value.redactions) {
    const field = typeof item?.field === 'string' && item.field.length > 0 ? item.field : 'content';
    const kind = typeof item?.kind === 'string' && item.kind.length > 0 ? item.kind : 'unknown';
    observations.push({ field, kind });
  }
  return observations;
}
