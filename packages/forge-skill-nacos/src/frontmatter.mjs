/**
 * SKILL.md YAML frontmatter 的最小解析（与 DSH skill-filesystem 语义对齐）。
 *
 * 只解析 `key: value` 平面标量；description 允许包含冒号（取首个冒号后的整行）。
 * 完整 YAML（嵌套/多行）不在技能 frontmatter 的使用面内，遇到不支持的形态由
 * 调用方按校验失败拒绝。
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @param {string} raw SKILL.md 原文
 * @returns {{data: Record<string, string>, body: string} | undefined} 无 frontmatter 时返回 undefined
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('---\n')) return undefined;
  const closing = raw.indexOf('\n---', 4);
  if (closing < 0) return undefined;
  const header = raw.slice(4, closing);
  const body = raw.slice(closing + 4).replace(/^\n/, '');
  const data = {};
  for (const line of header.split('\n')) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) return undefined;
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    data[key] = value;
  }
  return { data, body };
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 解析 DSH 调用策略 frontmatter（同 skill-filesystem 语法）。
 * @param {Record<string, string>} data
 * @returns {{modelInvocable: boolean, userInvocable: boolean}}
 */
export function parseInvocationPolicy(data) {
  return {
    modelInvocable: parseBoolean(data['disable-model-invocation']) !== true,
    userInvocable: parseBoolean(data['user-invocable']) !== false,
  };
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  switch (value.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true;
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false;
    default:
      return undefined;
  }
}
