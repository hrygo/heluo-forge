/**
 * `ctx.skills` Provider（设计 §7.3）：list/get 纯本地，永不回源网络。
 *
 * rank 700 低于 skill-filesystem 全部本地来源（100–600），同层同名必让本地
 * 技能胜出——"企业技能不覆盖个人/项目技能"。作用域过滤：`project:<root>`
 * 记录仅当会话 cwd 位于该项目根之内时产出。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter, parseInvocationPolicy } from './frontmatter.mjs';
import { isInsideProject } from './paths.mjs';

export const SKILL_SOURCE = 'nacos';
export const SKILL_RANK = 700;

/**
 * @param {{ledger: object, skillDir: (name: string, version: string) => string,
 *          providerName?: string, logger?: {warn: Function}}} input
 * @returns DSH `SkillProvider` 形态
 */
export function createSkillProvider({ ledger, skillDir, providerName = 'nacos', logger }) {
  /** 解析缓存：key `${name}@${version}:${sha}`；正文不缓存（get 每次读盘）。 */
  const parsedCache = new Map();

  function warn(message) {
    logger?.warn?.(message);
  }

  function scopeVisible(record, cwd) {
    if (record.scope?.kind === 'project') {
      return isInsideProject(cwd, record.scope.root);
    }
    return true;
  }

  async function readSkillMd(dir) {
    try {
      return await readFile(join(dir, 'SKILL.md'), 'utf8');
    } catch {
      return undefined;
    }
  }

  async function parsedOf(record) {
    const dir = skillDir(record.name, record.version);
    const raw = await readSkillMd(dir);
    if (raw === undefined) return undefined;
    const sha = createHash('sha256').update(raw).digest('hex');
    if (sha !== record.skillMdSha256) {
      warn(`skill-nacos: ${record.name}@${record.version} 的 SKILL.md 摘要与台账不符，跳过（可能被外部改动）`);
      return undefined;
    }
    const key = `${record.name}@${record.version}:${sha}`;
    let parsed = parsedCache.get(key);
    if (parsed === undefined) {
      parsed = parseFrontmatter(raw);
      if (parsed === undefined || typeof parsed.data.name !== 'string') return undefined;
      parsedCache.set(key, parsed);
    }
    return { parsed, dir, sha };
  }

  return {
    name: providerName,

    /** 只读本地台账与 store；仅产出 enabled 且作用域可见的候选。 */
    async list(options = {}) {
      const cwd = options?.cwd;
      const candidates = [];
      for (const record of ledger.list()) {
        if (!record.enabled) continue;
        if (!scopeVisible(record, cwd)) continue;
        const loaded = await parsedOf(record);
        if (loaded === undefined) continue;
        const { parsed, dir } = loaded;
        candidates.push({
          name: parsed.data.name,
          description: parsed.data.description,
          ...(parsed.data['when-to-use'] !== undefined ? { whenToUse: parsed.data['when-to-use'] } : {}),
          invocation: parseInvocationPolicy(parsed.data),
          source: SKILL_SOURCE,
          provider: providerName,
          resourceBase: { kind: 'directory', path: dir },
          path: join(dir, 'SKILL.md'),
          rank: SKILL_RANK,
          locator: { name: record.name, version: record.version },
          metadata: { version: record.version, scope: record.scope },
        });
      }
      // 项目级先于全局级（同名时项目级优先的语义入口；台账按 name 唯一，正常不会同名）。
      candidates.sort((left, right) => Number(right.metadata.scope?.kind === 'project') - Number(left.metadata.scope?.kind === 'project'));
      return candidates;
    },

    /** 加载精确版本的完整指令；文件缺失或被改动返回 undefined（registry 语义：不可加载）。 */
    async get(candidate) {
      const locator = candidate?.locator;
      if (locator === null || typeof locator !== 'object') return undefined;
      const record = ledger.get(locator.name);
      if (record === undefined || record.version !== locator.version) return undefined;
      const dir = skillDir(record.name, record.version);
      const raw = await readSkillMd(dir);
      if (raw === undefined) return undefined;
      const parsed = parseFrontmatter(raw);
      if (parsed === undefined || typeof parsed.data.name !== 'string') return undefined;
      return {
        name: parsed.data.name,
        description: parsed.data.description,
        ...(parsed.data['when-to-use'] !== undefined ? { whenToUse: parsed.data['when-to-use'] } : {}),
        invocation: parseInvocationPolicy(parsed.data),
        source: SKILL_SOURCE,
        provider: providerName,
        resourceBase: { kind: 'directory', path: dir },
        path: join(dir, 'SKILL.md'),
        metadata: { version: record.version, scope: record.scope },
        content: parsed.body.trim(),
      };
    },
  };
}
