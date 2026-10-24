// 官方行回灌检测（#13 AC8）：DSH 升级或 profile 重建后，`deepseek-account`、
// `ui-settings-account`、`llm-deepseek-account`、`llm-deepseek` 可能重新变为启用状态。
// 判定输入是**实际生效配置**里的行状态（`dsh --dump-config`），不是"补丁文件还在不在"：
// 补丁在而没生效，仍是回灌。
//
// 只做判定，不写配置、不注册插件。缺席的行按 Loader 的 `not found` 语义记入 `absent`
// ——跳过不等于已禁用，所以单独列出而不是并入通过。

export const OFFICIAL_ROWS = Object.freeze([
  'deepseek-account',
  'ui-settings-account',
  'llm-deepseek-account',
  'llm-deepseek',
]);

export class EnterpriseReflowError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EnterpriseReflowError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * @param {Map<string, boolean|null>|Array<{id: string, disabled?: boolean}>|Record<string, boolean|null>} observed
 * @returns {Map<string, boolean|null>}
 */
function normalizeObserved(observed) {
  const rows = new Map();
  if (observed instanceof Map) {
    for (const [id, disabled] of observed) rows.set(String(id), disabled === true ? true : disabled === false ? false : null);
    return rows;
  }
  if (Array.isArray(observed)) {
    for (const entry of observed) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') {
        throw new EnterpriseReflowError('ENTERPRISE_REFLOW_INPUT_INVALID', 'observed rows need a string id');
      }
      rows.set(entry.id, entry.disabled === true ? true : entry.disabled === false ? false : null);
    }
    return rows;
  }
  if (observed !== null && typeof observed === 'object') {
    for (const [id, disabled] of Object.entries(observed)) rows.set(id, disabled === true ? true : disabled === false ? false : null);
    return rows;
  }
  throw new EnterpriseReflowError('ENTERPRISE_REFLOW_INPUT_INVALID', 'observed must be a Map, an array of rows or a record');
}

/**
 * @param {{observed: unknown, expected?: readonly string[], requireAll?: boolean}} [input]
 */
export function detectOfficialRowReflow(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EnterpriseReflowError('ENTERPRISE_REFLOW_INPUT_INVALID', 'reflow input must be an object');
  }
  const expected = input.expected ?? OFFICIAL_ROWS;
  if (!Array.isArray(expected) || expected.some((id) => typeof id !== 'string')) {
    throw new EnterpriseReflowError('ENTERPRISE_REFLOW_INPUT_INVALID', 'expected must be an array of row ids');
  }
  const rows = normalizeObserved(input.observed);
  const reflowed = [];
  const absent = [];
  const disabled = [];
  for (const id of expected) {
    if (!rows.has(id)) {
      absent.push(id);
      continue;
    }
    // 状态未知（无法解析出 disabled）按回灌处理：宁可按启用对待。
    if (rows.get(id) === true) disabled.push(id);
    else reflowed.push(id);
  }
  const requireAll = input.requireAll === true;
  const ok = reflowed.length === 0 && (!requireAll || absent.length === 0);
  return Object.freeze({
    ok,
    reflowed: Object.freeze(reflowed),
    absent: Object.freeze(absent),
    disabled: Object.freeze(disabled),
    checked: expected.length,
    notes: Object.freeze([
      'reflowed = 实际生效配置里仍为启用的官方行；补丁存在但未生效同样算回灌',
      'absent = profile 里不存在的行（Loader 警告跳过）；跳过不等于已禁用',
      requireAll ? 'requireAll=true：缺席行也导致不通过' : 'requireAll=false：缺席行记入 absent 但不单独判失败',
    ]),
  });
}

/**
 * 从 `dsh --dump-config` 输出解析行的 `disabled` 状态。只识别 `- id: <行>` 与其后
 * 缩进行；`#` 注释行结束当前行。
 *
 * @param {string} text
 * @returns {Map<string, boolean|null>}
 */
export function rowsFromDump(text) {
  if (typeof text !== 'string') {
    throw new EnterpriseReflowError('ENTERPRISE_REFLOW_INPUT_INVALID', 'dump text must be a string');
  }
  const rows = new Map();
  let current;
  for (const line of text.split('\n')) {
    const matched = /^- id: (.+?)\s*$/u.exec(line);
    if (matched !== null) {
      current = matched[1];
      if (!rows.has(current)) rows.set(current, null);
      continue;
    }
    if (line.startsWith('#')) {
      current = undefined;
      continue;
    }
    // Only a row-level field counts. A `disabled:` nested inside the row's
    // `config:` block says nothing about whether the row itself is disabled,
    // and treating it as proof would turn a reflow into a false pass.
    if (current !== undefined && /^ {2}disabled: true\s*$/u.test(line)) rows.set(current, true);
    else if (current !== undefined && /^ {2}disabled: false\s*$/u.test(line)) rows.set(current, false);
  }
  return rows;
}
