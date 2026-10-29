/**
 * `@heluo/forge-devops` 运行时配置（T1，AC-22 / §5.4）。
 *
 * 三条底线，本模块就是它们的唯一实现处：
 *   1. **fail closed**：外部工具路径与 endpoint 一律由环境注入，未配置时不猜默认值，
 *      也不放行——调用方拿到 `ok: false` 必须拒绝启动流程（denied），不得降级。
 *   2. **不回显值**：`describeRuntimeConfig()` 只给出「已配/未配」与安全枚举，
 *      绝不把路径、endpoint 或任何凭据写进状态、日志或报告。
 *   3. **可离线断言**：入参是显式 `env` 对象，不读磁盘、不读网络、不碰 `process.env`
 *      以外的隐式状态——装配层（`src/index.mjs`）负责把真实环境传进来。
 *
 * 产物契约（蓝图声明 + 一处显式扩展）：
 *   resolveRuntimeConfig(env)
 *     -> { ok: true, value: { dopBin, dopEndpoint, ghBin, ghOwner, sourceType, timeoutMs } }
 *      | { ok: false, reason: 'CONFIG_MISSING', missing: string[] }
 *      | { ok: false, reason: 'CONFIG_INVALID', invalid: string[] }
 *   describeRuntimeConfig(cfg | result)
 *     -> { dopBin: boolean, dopEndpoint: boolean, ghBin: boolean, ghOwner: boolean,
 *          sourceType: string | null, timeoutMs: number | null }
 *
 * **扩展说明**：蓝图只声明了 `CONFIG_MISSING`。这里补一个 `CONFIG_INVALID`：
 * 「配置了但不可用」（endpoint 不是 http(s)、超时不是合法整数）与「没配置」是两种
 * 不同的可见原因，挤进同一个码会让排障与报告把用户配置错误读成环境缺失。
 * 两者的放行语义完全相同——都返回 `ok: false`，调用方一律不得继续。
 *
 * 单值口径：只认字符串，且去掉首尾空白后为空即视为「未配置」（`''`、`'   '`）。
 * 不把 `undefined` 与空串区别对待，也不为任何字段提供主机相关默认值。
 */

/** 环境变量名 → 逻辑字段名。文档表格与代码同源于此表，别处不再复制一份。 */
export const ENV_KEYS = Object.freeze({
  dopBin: 'FORGE_DEVOPS_DOP_BIN',
  dopEndpoint: 'FORGE_DEVOPS_DOP_ENDPOINT',
  ghBin: 'FORGE_DEVOPS_GH_BIN',
  ghOwner: 'FORGE_DEVOPS_GH_OWNER',
  sourceType: 'FORGE_DEVOPS_SOURCE_TYPE',
  timeoutMs: 'FORGE_DEVOPS_TIMEOUT_MS',
});

/** 失败原因码。`CONFIG_MISSING` 为蓝图声明，`CONFIG_INVALID` 见文件头扩展说明。 */
export const CONFIG_REASONS = Object.freeze({
  MISSING: 'CONFIG_MISSING',
  INVALID: 'CONFIG_INVALID',
});

/** 事实来源类型：mock（企业 dop 的本地模拟）与 enterprise（企业实测）。 */
export const SOURCE_TYPES = Object.freeze(['mock', 'enterprise']);

/** 非机密默认值：`gh` 走 PATH，来源默认 mock，超时默认 20s（与 cli-runner 默认一致）。 */
export const DEFAULT_GH_BIN = 'gh';
export const DEFAULT_SOURCE_TYPE = 'mock';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** 组织/用户名：字母数字与连字符，不以连字符开头（挡掉 `--flag` 形状的注入）。 */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function readText(env, key) {
  const raw = env === null || env === undefined ? undefined : env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * endpoint 只接受绝对 http(s) URL，且不接受内嵌 userinfo——
 * 凭据走 header/凭据存储，不写进地址（AGENTS.md §1：不写凭据）。
 */
function isEndpointLike(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.username === '' && url.password === '';
}

function isPositiveInt(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * 把 `env` 解析为运行配置。
 *
 * 缺失优先于非法：先点名「必须配置却没配置」的字段，再报格式问题——一次只让用户
 * 修一类错误，避免来回试。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ok: true, value: Readonly<object>} | {ok: false, reason: string, missing: string[]}
 *   | {ok: false, reason: string, invalid: string[]}}
 */
export function resolveRuntimeConfig(env = {}) {
  const missing = [];
  const invalid = [];

  const dopBin = readText(env, ENV_KEYS.dopBin);
  if (dopBin === undefined) missing.push(ENV_KEYS.dopBin);

  const dopEndpoint = readText(env, ENV_KEYS.dopEndpoint);
  if (dopEndpoint !== undefined && !isEndpointLike(dopEndpoint)) invalid.push(ENV_KEYS.dopEndpoint);

  const ghBin = readText(env, ENV_KEYS.ghBin) ?? DEFAULT_GH_BIN;

  const ghOwner = readText(env, ENV_KEYS.ghOwner);
  if (ghOwner !== undefined && !OWNER_PATTERN.test(ghOwner)) invalid.push(ENV_KEYS.ghOwner);

  const sourceType = (readText(env, ENV_KEYS.sourceType) ?? DEFAULT_SOURCE_TYPE).toLowerCase();
  if (!SOURCE_TYPES.includes(sourceType)) invalid.push(ENV_KEYS.sourceType);

  const rawTimeout = readText(env, ENV_KEYS.timeoutMs);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const parsed = /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
    if (isPositiveInt(parsed, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) {
      timeoutMs = parsed;
    } else {
      invalid.push(ENV_KEYS.timeoutMs);
    }
  }

  if (missing.length > 0) {
    return { ok: false, reason: CONFIG_REASONS.MISSING, missing };
  }
  if (invalid.length > 0) {
    return { ok: false, reason: CONFIG_REASONS.INVALID, invalid };
  }

  return {
    ok: true,
    value: Object.freeze({ dopBin, dopEndpoint, ghBin, ghOwner, sourceType, timeoutMs }),
  };
}

/**
 * 配置的「可展示形态」：布尔位 + 两个非机密枚举。任何取值都不外泄。
 *
 * 接受 `resolveRuntimeConfig()` 的返回值或它的 `value`，让调用方不必先解包。
 *
 * @param {object | undefined} config
 * @returns {{dopBin: boolean, dopEndpoint: boolean, ghBin: boolean, ghOwner: boolean,
 *   sourceType: string | null, timeoutMs: number | null}}
 */
export function describeRuntimeConfig(config) {
  const value = config !== null && typeof config === 'object' && config.ok === true
    ? (config.value ?? {})
    : (config ?? {});
  const configured = (key) => typeof value[key] === 'string' && value[key].length > 0;
  return Object.freeze({
    dopBin: configured('dopBin'),
    dopEndpoint: configured('dopEndpoint'),
    ghBin: configured('ghBin'),
    ghOwner: configured('ghOwner'),
    sourceType: typeof value.sourceType === 'string' ? value.sourceType : null,
    timeoutMs: isPositiveInt(value.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ? value.timeoutMs : null,
  });
}
