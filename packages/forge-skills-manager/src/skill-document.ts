import type { ParsedSkill } from "./types.js";

/** 剥离 UTF-8 BOM（Windows 工具常写入，不剥离会导致开头 --- 失配）。 */
function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解析 SKILL.md 的 frontmatter。返回 { fields, map, body }，map 保留键序。
 *  只识别顶层 key: value；缩进嵌套字段（如 metadata.source）不进入 map。 */
export function parseSkillDoc(text: string): ParsedSkill {
  const src = stripBom(String(text));
  const lines = src.split(/\r?\n/);
  const map: Record<string, string> = Object.create(null);
  const fields = [];
  let body = src;
  let hasFrontmatter = false;
  if (lines.length > 0 && lines[0].trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end >= 0) {
      hasFrontmatter = true;
      for (let i = 1; i < end; i++) {
        const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
        if (m) {
          fields.push({ key: m[1], raw: m[2] });
          const block = /^([>|])(?:([1-9])[-+]?|[-+]([1-9])?)?\s*$/.exec(m[2]);
          if (block) {
            const content = [];
            while (
              i + 1 < end &&
              (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")
            ) {
              i++;
              content.push(lines[i]);
            }
            const explicitIndentation = block[2] || block[3];
            const indentation = explicitIndentation
              ? Number(explicitIndentation)
              : content
                  .filter((line) => line.trim() !== "")
                  .reduce(
                    (min, line) =>
                      Math.min(min, (/^\s*/.exec(line) || [""])[0].length),
                    Infinity,
                  );
            const normalized = content.map((line) =>
              Number.isFinite(indentation)
                ? line.slice(Math.min(indentation, line.length))
                : line,
            );
            map[m[1]] =
              block[1] === ">"
                ? normalized.join(" ").replace(/\s+/g, " ").trim()
                : explicitIndentation
                  ? normalized.join("\n").replace(/^\n+|\n+$/g, "")
                  : normalized.join("\n").trim();
          } else {
            map[m[1]] = decodeYamlScalar(m[2]);
          }
        }
      }
      body = lines.slice(end + 1).join("\n");
    }
  }
  return { fields, map, body, hasFrontmatter };
}

/** 读取 YAML 标量的显示值；不依赖第三方 YAML 解析器。 */
function decodeYamlScalar(v: string) {
  const s = String(v == null ? "" : v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      const value: unknown = JSON.parse(s);
      if (typeof value === "string") return value;
    } catch {
      /* 保留无法解析的原始内容 */
    }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'")
    return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
