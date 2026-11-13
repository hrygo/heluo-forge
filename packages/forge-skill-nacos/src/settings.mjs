/**
 * 用户可调配置覆盖层（PRD §6.4 技能源与凭据设置）。
 *
 * cordis.yml 的插件 config 是管理员域（部署时下发，本层不改）；
 * 用户可在面板里调整连接参数，保存到 `$DSH_HOME/skill-nacos/settings.json`。
 * 运行时取两层合并：cordis.yml 为基线，override 覆盖同名字段。
 */
import { readFile, rename } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { REASONS, SkillNacosError } from './errors.mjs';

/** 用户可覆盖的字段白名单（环境切换模式 + 高级参数微调）。 */
export const OVERRIDABLE_FIELDS = Object.freeze([
  'activeEnvironmentId',
  'catalogMode',
  'configIndexDataId',
  'requestTimeoutMs',
  'catalogRefreshIntervalMs',
  'catalogCacheTtlMs',
  'catalogPageSize',
]);

/**
 * @param {string} settingsPath `$DSH_HOME/skill-nacos/settings.json`
 */
export function createSettingsOverlay(settingsPath) {
  let overrides = {};

  async function load() {
    try {
      const text = await readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        overrides = sanitize(parsed);
      }
    } catch {
      // 文件不存在或损坏 → 空 override（cordis.yml 基线生效）
      overrides = {};
    }
  }

  /** 白名单过滤：只保留允许覆盖的字段。 */
  function sanitize(input) {
    const clean = {};
    for (const key of OVERRIDABLE_FIELDS) {
      if (input[key] !== undefined) clean[key] = input[key];
    }
    return clean;
  }

  /** 原子保存（tmp + rename，同台账模式）。 */
  async function save(next) {
    const tmp = `${settingsPath}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(tmp, settingsPath);
  }

  return {
    load,
    /** 返回当前覆盖层（不含基线）。 */
    get: () => ({ ...overrides }),
    /** 合并基线与覆盖层：覆盖层优先。 */
    merge: (base) => ({ ...base, ...overrides }),
    /** 更新覆盖层（白名单校验 + 持久化）。 */
    async update(patch) {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new SkillNacosError(REASONS.CONFIG_INVALID, '设置必须是对象');
      }
      const unknown = Object.keys(patch).filter((key) => !OVERRIDABLE_FIELDS.includes(key));
      if (unknown.length > 0) {
        throw new SkillNacosError(REASONS.CONFIG_INVALID, `不可覆盖的字段：${unknown.join(', ')}`);
      }
      const next = sanitize({ ...overrides, ...patch });
      await save(next);
      overrides = next;
      return { ...overrides };
    },
  };
}
