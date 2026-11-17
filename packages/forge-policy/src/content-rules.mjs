/**
 * 内容规则：判定"写进去的内容"能不能落盘或外发。
 *
 * 内置集随包编译、不可删除；组织层只能追加规则或提高级别。规则是有上限的
 * 正则集合，不做语义分析，也不宣称能发现所有凭据。HARD 命中一律拒绝，且
 * 不能被任何确认提升；SOFT 命中记录后继续（需要询问时由门禁升级为 confirm）。
 */

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
/** 单次检查的载荷上限；超出的部分不检查，并在结果里标出截断。 */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
const SEVERITIES = new Set(['hard', 'soft']);
const REDACT_HEAD = 4;
const REDACT_TAIL = 4;

/**
 * 内置 HARD 规则：私钥块、云厂商长期密钥、带凭据的连接串、常见令牌、
 * 口令赋值与强制推送。
 */
const BUILTIN_RULES = Object.freeze([
  { id: 'BUILTIN-PRIVATE-KEY', severity: 'hard', pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----' },
  { id: 'BUILTIN-CLOUD-ACCESS-KEY', severity: 'hard', pattern: '(?i)\\b(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|secret[_-]?key)\\b\\s*[:=]\\s*["\']?[A-Za-z0-9/+=]{16,}' },
  { id: 'BUILTIN-CREDENTIAL-URL', severity: 'hard', pattern: '(?i)\\b(?:jdbc|mongodb(?:\\+srv)?|redis|rediss|mysql|postgres(?:ql)?|amqp|ldaps?)://[^\\s:/@]+:[^\\s@]+@' },
  { id: 'BUILTIN-TOKEN', severity: 'hard', pattern: '(?i)\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})' },
  { id: 'BUILTIN-PASSWORD-ASSIGN', severity: 'hard', pattern: '(?i)\\bpassword\\b\\s*[:=]\\s*["\']?[^\\s"\']{6,}' },
  { id: 'BUILTIN-FORCE-PUSH', severity: 'hard', pattern: 'git\\s+push\\b[^\\n]*(?:--force(?!-with-lease)|\\s-f\\b|\\+[^\\s:]+:[^\\s]+)' },
  { id: 'BUILTIN-ENV-COMMIT', severity: 'soft', pattern: '(?m)^\\+\\s*(?:[A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD))=.{8,}' },
  { id: 'BUILTIN-INTERNAL-ADDRESS', severity: 'soft', pattern: '(?i)(?:https?|wss?)://(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d+)?(?:/|$)' },
  { id: 'BUILTIN-ABSOLUTE-HOME', severity: 'soft', pattern: '/(?:Users|home)/[A-Za-z0-9._-]+/' },
  { id: 'BUILTIN-LONG-BASE64', severity: 'soft', pattern: '[A-Za-z0-9+/]{200,}={0,2}' },
  { id: 'BUILTIN-ENV-FILE', severity: 'soft', pattern: '(?:^|[/\\s])\\.env(?:\\.[A-Za-z0-9]+)?\\b' },
]);

function compileOne(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new PolicyContentError('each content rule must be an object', 'POLICY_CONTENT_RULE_INVALID');
  }
  const { id } = rule;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new PolicyContentError('each content rule needs a non-empty id', 'POLICY_CONTENT_RULE_INVALID');
  }
  if (!SEVERITIES.has(rule.severity)) {
    throw new PolicyContentError(`content rule "${id}" severity must be hard or soft`, 'POLICY_CONTENT_RULE_INVALID', { id });
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
 * @param {readonly object[]} rules compiled rules
 * @param {readonly {field: string, text: string}[]} payloads
 * @returns {{findings: object[], hard: object[], soft: object[], skipped: object[]}}
 */
export function scanPayloads(rules, payloads) {
  if (!Array.isArray(rules) || !Array.isArray(payloads)) {
    throw new PolicyContentError('scanPayloads needs compiled rules and payload fields', 'POLICY_CONTENT_RULE_INVALID');
  }
  const findings = [];
  const skipped = [];
  const seen = new Set();
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
    let truncated = false;
    if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
      text = Buffer.from(text, 'utf8').subarray(0, MAX_PAYLOAD_BYTES).toString('utf8');
      truncated = true;
    }
    for (const rule of rules) {
      if (!rule.pathRegexes.some((pathRegex) => pathRegex.test(field))) continue;
      const match = rule.regex.exec(text);
      if (match === null) continue;
      const key = `${rule.id}:${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(Object.freeze({
        rule: rule.id,
        severity: rule.severity,
        source: rule.source,
        field,
        excerpt: redactExcerpt(match[0]),
        ...(truncated ? { truncated: true } : {}),
      }));
    }
    if (truncated) skipped.push({ field, reason: 'truncated' });
  }
  return {
    findings: Object.freeze(findings),
    hard: Object.freeze(findings.filter((finding) => finding.severity === 'hard')),
    soft: Object.freeze(findings.filter((finding) => finding.severity === 'soft')),
    skipped: Object.freeze(skipped),
  };
}

/**
 * Payload fields a tool call writes. Only known text-bearing argument keys are
 * inspected; the gate never guesses at binary or structured content.
 *
 * @param {Record<string, unknown>} args
 * @returns {{field: string, text: string}[]}
 */
export function payloadsFromArguments(args = {}) {
  const payloads = [];
  const textKeys = ['title', 'body', 'description', 'content', 'message', 'comment', 'summary', 'text', 'diff', 'patch'];
  if (args === null || typeof args !== 'object') return payloads;
  for (const key of textKeys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) payloads.push({ field: key, text: value });
    else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (typeof item === 'string' && item.length > 0) payloads.push({ field: `${key}[${index}]`, text: item });
      }
    }
  }
  for (const key of ['path', 'file', 'target']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) payloads.push({ field: key, text: value });
  }
  if (Array.isArray(args.commits)) {
    for (const [index, commit] of args.commits.entries()) {
      if (commit === null || typeof commit !== 'object') continue;
      if (typeof commit.message === 'string' && commit.message.length > 0) {
        payloads.push({ field: `commits[${index}].message`, text: commit.message });
      }
      if (typeof commit.diff === 'string' && commit.diff.length > 0) {
        payloads.push({ field: `commits[${index}].diff`, text: commit.diff });
      }
    }
  }
  return payloads;
}
