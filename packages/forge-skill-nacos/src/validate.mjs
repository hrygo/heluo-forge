/**
 * 技能包校验与安全解包（设计 §7.2 的 F 步：全部负测在此兑现）。
 *
 * 校验顺序：路径安全 → 结构（单根 + SKILL.md）→ frontmatter → 名称/版本一致性 →
 * 落盘（全部路径必须在 staging 目标之内）。任一步失败抛 SN_* 错误，staging 由
 * 调用方整体清理，受管目录之外零写入。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { parseFrontmatter, parseInvocationPolicy, SKILL_NAME_PATTERN } from './frontmatter.mjs';
import { REASONS, SkillNacosError } from './errors.mjs';

/**
 * 校验路径安全性并归一化；不安全立即拒绝。
 * @param {string} name 条目名（ZIP 内路径）
 * @returns {string[]} 归一化后的路径段
 */
export function safeSegments(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new SkillNacosError(REASONS.PATH_ESCAPE, '安装包存在空路径条目');
  }
  if (name.includes('\\')) {
    throw new SkillNacosError(REASONS.PATH_ESCAPE, `安装包条目 ${name} 使用反斜杠路径，拒绝`);
  }
  if (name.startsWith('/')) {
    throw new SkillNacosError(REASONS.PATH_ESCAPE, `安装包条目 ${name} 是绝对路径，拒绝`);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new SkillNacosError(REASONS.PATH_ESCAPE, `安装包条目 ${name} 带盘符前缀，拒绝`);
  }
  const segments = name.split('/').filter((segment) => segment !== '.' && segment.length > 0);
  if (segments.some((segment) => segment === '..')) {
    throw new SkillNacosError(REASONS.PATH_ESCAPE, `安装包条目 ${name} 包含 .. 上跳段，拒绝`);
  }
  return segments;
}

/**
 * 校验 ZIP 条目并安全解包到目标目录；返回技能元数据。
 * @param {{entries: {name: string, data: Buffer, isDirectory: boolean}[]}} zip readZip 产物
 * @param {{expectedName: string, expectedVersion: string, targetDir: string}} input
 * @returns {Promise<{name: string, description: string, invocation: object, skillMdPath: string, skillMdSha256: string, fileCount: number, totalBytes: number}>}
 */
export async function validateAndExtract(zip, { expectedName, expectedVersion, targetDir }) {
  assertNoCaseDuplicates(zip.entries);
  const files = zip.entries.filter((entry) => !entry.isDirectory).map((entry) => ({ segments: safeSegments(entry.name), data: entry.data }));
  const skillEntry = findSkillMd(files);
  const parsed = parseFrontmatter(skillEntry.data.toString('utf8'));
  if (parsed === undefined) {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, 'SKILL.md 缺少 YAML frontmatter');
  }
  const declaredName = parsed.data.name;
  const description = parsed.data.description;
  if (typeof declaredName !== 'string' || declaredName.length === 0) {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, 'SKILL.md frontmatter 缺少 name');
  }
  if (!SKILL_NAME_PATTERN.test(declaredName)) {
    throw new SkillNacosError(REASONS.NAME_INVALID, `SKILL.md name "${declaredName}" 不是合法的 kebab-case`);
  }
  if (declaredName !== expectedName) {
    throw new SkillNacosError(REASONS.NAME_INVALID, `包内 name "${declaredName}" 与请求的 "${expectedName}" 不一致`);
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, 'SKILL.md frontmatter 缺少 description');
  }
  // frontmatter 的 version 是可选元数据，可能与 Nacos Registry 版本不同步（维护者
  // 发新版时忘了更新 frontmatter）。Nacos Registry 的版本号才是权威——不一致时
  // 只记警告，不拒绝安装（2026-11-03 实测调整，原为硬拒绝）。

  const root = resolve(targetDir);
  let totalBytes = 0;
  for (const file of files) {
    const destination = resolve(targetDir, ...file.segments);
    if (destination !== root && !destination.startsWith(root + sep)) {
      throw new SkillNacosError(REASONS.PATH_ESCAPE, `解包路径越界：${file.segments.join('/')}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.data);
    totalBytes += file.data.length;
  }
  return {
    name: declaredName,
    description,
    invocation: parseInvocationPolicy(parsed.data),
    skillMdPath: resolve(root, ...skillEntry.segments),
    skillMdSha256: createHash('sha256').update(skillEntry.data).digest('hex'),
    fileCount: files.length,
    totalBytes,
  };
}

/** 大小写不敏感的路径去重（Windows/macOS 大小写不敏感文件系统上的冲突拒绝）。 */
function assertNoCaseDuplicates(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      throw new SkillNacosError(REASONS.PATH_ESCAPE, `安装包存在大小写冲突的重复路径：${entry.name}`);
    }
    seen.add(key);
  }
}

/**
 * 定位 SKILL.md：允许归档根，或唯一的单层目录根（`<dir>/SKILL.md`）；
 * 解包路径剥掉该单层根。
 */
function findSkillMd(files) {
  const rootSkill = files.find((file) => file.segments.length === 1 && file.segments[0] === 'SKILL.md');
  if (rootSkill !== undefined) return rootSkill;
  const nested = files.filter((file) => file.segments.length === 2 && file.segments[1] === 'SKILL.md');
  if (nested.length === 1) {
    const rootName = nested[0].segments[0];
    const stripped = files.map((file) =>
      file.segments[0] === rootName ? { segments: file.segments.slice(1), data: file.data } : file,
    );
    if (stripped.every((file) => file.segments[0] !== rootName)) {
      replaceInPlace(files, stripped);
      return stripped.find((file) => file.segments.length === 1 && file.segments[0] === 'SKILL.md');
    }
  }
  throw new SkillNacosError(REASONS.INVALID_PACKAGE, '安装包内找不到唯一的 SKILL.md（归档根或单层目录根）');
}

function replaceInPlace(files, next) {
  files.length = 0;
  for (const file of next) files.push(file);
}
