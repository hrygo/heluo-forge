#!/usr/bin/env node
/**
 * Agent Skills 标准检查器（issue #222 工作项 ⑧）。
 *
 * 只做离线静态检查：发现 `.agents/skills/*` 与 `packages/*\/skills/*` 下的每个
 * `SKILL.md`，核对 frontmatter、命名、描述、单一 H1 与正文相对链接。不执行技能、
 * 不联网、不写文件；任何发现都以非零退出码交给调用方，不自动修复。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 1024;
const SKIP_DIRECTORIES = new Set(['node_modules', '.git']);

/**
 * 判断目录是否落在检查器应当忽略的位置。`tests/fixtures` 只用于测试负例，
 * 不参与真实技能树的标准检查。
 *
 * @param {string} root 检查根目录
 * @param {string} directory 待判断目录
 * @returns {boolean}
 */
function ignored(root, directory) {
  const path = relative(root, directory).split(sep).join('/');
  if (path.split('/').some((segment) => SKIP_DIRECTORIES.has(segment))) return true;
  return path === 'tests/fixtures' || path.startsWith('tests/fixtures/') || path.includes('/tests/fixtures/');
}

/**
 * 递归收集目录下的 `SKILL.md`，跳过依赖、版本库与测试夹具目录。
 *
 * @param {string} root 检查根目录
 * @param {string} directory 当前目录
 * @param {string[]} found 收集结果
 */
function walk(root, directory, found) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') {
      found.push(path);
      continue;
    }
    if (!entry.isDirectory() || ignored(root, path)) continue;
    walk(root, path, found);
  }
}

/**
 * Discover every `SKILL.md` under `.agents/skills/` and `packages/*\/skills/`.
 *
 * @param {string} root repository root
 * @returns {string[]} absolute paths, sorted for deterministic findings
 */
export function discoverSkills(root) {
  const roots = [];
  const agentSkills = join(root, '.agents', 'skills');
  if (existsSync(agentSkills)) roots.push(agentSkills);
  const packages = join(root, 'packages');
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored(root, join(packages, entry.name))) continue;
      const skills = join(packages, entry.name, 'skills');
      if (existsSync(skills)) roots.push(skills);
    }
  }
  const found = [];
  for (const skillsRoot of roots) walk(root, skillsRoot, found);
  return found.sort();
}

/**
 * Strip matching single or double quotes from a scalar, mirroring the clause
 * loader. Only the flat subset is supported, so no escape processing is done.
 *
 * @param {string} value trimmed scalar
 * @returns {string}
 */
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse the leading YAML frontmatter block. Only flat `key: value` lines are
 * supported; unknown keys are kept and ignored by the caller.
 *
 * @param {string} text
 * @returns {{fields?: Map<string, string>, body?: string, error?: string}}
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { error: 'missing YAML frontmatter (the file must start with "---")' };
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  if (close === -1) return { error: 'frontmatter is not closed by a "---" line' };
  const fields = new Map();
  for (let index = 1; index < close; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u.exec(line);
    if (match === null) return { error: `frontmatter line ${index + 1} is not a simple "key: value" pair` };
    fields.set(match[1], unquote(match[2].trim()));
  }
  return { fields, body: lines.slice(close + 1).join('\n') };
}

/**
 * Count level-one headings outside fenced code blocks.
 *
 * @param {string} body
 * @returns {number}
 */
function countH1(body) {
  let fence = undefined;
  let count = 0;
  for (const line of body.split('\n')) {
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (opening !== null) {
      const marker = opening[1][0];
      if (fence === undefined) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (/^#[ \t]+\S/u.test(line)) count += 1;
  }
  return count;
}

/**
 * Resolve a markdown link target to a relative file path, skipping URLs,
 * anchors, absolute paths and mail links.
 *
 * @param {string} target raw link target
 * @returns {string | undefined} relative path, or undefined when not checked
 */
function relativeTarget(target) {
  let value = target.trim();
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    if (end === -1) return undefined;
    value = value.slice(1, end).trim();
  } else {
    value = value.split(/\s+/u)[0];
  }
  value = value.split('#')[0].split('?')[0].trim();
  if (value.length === 0) return undefined;
  if (value.startsWith('/') || value.startsWith('\\')) return undefined;
  if (value.startsWith('//')) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * List relative link targets in the body.
 *
 * @param {string} body
 * @returns {string[]}
 */
function relativeLinks(body) {
  const links = [];
  for (const match of body.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
    const target = relativeTarget(match[1]);
    if (target !== undefined) links.push(target);
  }
  return links;
}

/**
 * Check every Agent Skill under the given repository root.
 *
 * @param {string} root repository root
 * @returns {{errors: string[], counts: {skills: number}}}
 */
export function checkSkills(root) {
  const repositoryRoot = resolve(root);
  const files = discoverSkills(repositoryRoot);
  const errors = [];
  const names = new Map();
  for (const file of files) {
    const label = relative(repositoryRoot, file).split(sep).join('/');
    const skillDirectory = dirname(file);
    const directoryName = basename(skillDirectory);
    const parsed = parseFrontmatter(readFileSync(file, 'utf8'));
    if (parsed.error !== undefined) {
      errors.push(`${label}: ${parsed.error}`);
      continue;
    }
    const name = parsed.fields.get('name');
    const description = parsed.fields.get('description');
    if (typeof name !== 'string' || name.length === 0) {
      errors.push(`${label}: frontmatter requires a non-empty "name"`);
    } else if (name.length > SKILL_NAME_MAX) {
      errors.push(`${label}: name is ${name.length} characters, above the ${SKILL_NAME_MAX} limit`);
    } else if (!SKILL_NAME_PATTERN.test(name)) {
      errors.push(`${label}: name "${name}" must be lowercase kebab-case`);
    } else if (name !== directoryName) {
      errors.push(`${label}: name "${name}" does not match its directory "${directoryName}"`);
    } else if (names.has(name)) {
      errors.push(`${label}: duplicate skill name "${name}" (also defined in ${names.get(name)})`);
    } else {
      names.set(name, label);
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      errors.push(`${label}: frontmatter requires a non-empty "description"`);
    } else if (description.length > SKILL_DESCRIPTION_MAX) {
      errors.push(`${label}: description is ${description.length} characters, above the ${SKILL_DESCRIPTION_MAX} limit`);
    } else if (/^[>|][+-]?$/u.test(description)) {
      errors.push(`${label}: description must be a single logical line, not a YAML block scalar`);
    }
    const headings = countH1(parsed.body);
    if (headings !== 1) errors.push(`${label}: expected exactly one H1 heading in the body, found ${headings}`);
    for (const target of relativeLinks(parsed.body)) {
      if (!existsSync(resolve(skillDirectory, target))) {
        errors.push(`${label}: referenced path "${target}" does not exist`);
      }
    }
  }
  return { errors, counts: { skills: files.length } };
}

function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { errors, counts } = checkSkills(root);
  console.log(`skills: ${counts.skills} files`);
  for (const error of errors) console.error(`- ${error}`);
  if (errors.length > 0) {
    console.error(`skills: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log('skills: ok');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
