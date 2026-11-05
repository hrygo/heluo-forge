/**
 * `@heluo/forge-gitee` 运行时配置（TK2，AC-7 / AC-22）。
 *
 * 五个扁平键——`cliPath` / `host` / `timeoutMs` / `authEnv` / `persistentToken`，全部来自
 * 补丁层的 `config:`。r10 的关键变化：**凭据不再是必需品**。`authEnv` 默认为空（不注入
 * 任何变量），`host` 缺省不影响执行，令牌缺失只提示不阻断——「缺令牌」从拒绝理由降级为
 * 诊断信息，受限仓库由 CLI 自己的非零退出说明。四条纪律写死在实现里：
 *
 *   1. **不猜路径与主机**：`cliPath` 只有 `gh` 一个非机密默认值（企业已确认 CLI 名，
 *      PRD T5），`host` 没有默认值——未配置就是未配置，只在诊断里显示「未配置」，既
 *      不进执行路径，也**不**进 `missing` 阻断。
 *   2. **不读隐式环境**：`resolveGiteeConfig({config, env})` 只认显式传入的 `env`，
 *      不去读宿主进程环境；装配层负责把真实环境传进来，因此全部结论可离线复现。
 *   3. **不回显**：`describeGiteeConfig()` 只给枚举、数字与环境变量**名**，路径类值
 *      只留文件名，令牌值在任何返回值里都不存在（AC-22）。
 *   4. **一份规则**：补丁层配置、宿主 loader 的 `ConfigStandard` 与 `resolve` 都走
 *      `validateGiteeConfig()`；不存在第二套字段口径，也就没有"能存不能加载"。
 *
 * 产物契约（蓝图 §3 第 1 行，下游逐字使用）：
 *   validateGiteeConfig(input) -> { value } | { issues: [{ message, path }] }
 *   resolveGiteeConfig({ config, env })
 *     -> { cliPath, host, timeoutMs, authEnv, tokenSource, persistentToken, missing }
 *   describeGiteeConfig(config) -> string
 *   ConfigStandard -> { '~standard': { version: 1, vendor: 'heluo', validate } }
 *
 * `missing` 现在只是**提示清单**：用户显式点名了 `authEnv` 变量、但环境里一个都没值时，
 * 列出这些变量名（默认 `authEnv` 为空时恒为 `[]`）。它不再阻断执行，也不再包含 `host`。
 *
 * `resolveGiteeConfig` **不抛错**：非法值按未配置处理（原因由 `validateGiteeConfig`
 * 给出，装配期先校验并 fail closed，TECHNICAL §3 `apply` 第 1 步），非法值不会
 * 变成"静默放行"，只会回落到默认值。
 */

/** 五个配置键。顺序即文档表格与 issue 输出顺序，别处不再复制一份。 */
export const CONFIG_KEYS = Object.freeze(['cliPath', 'host', 'timeoutMs', 'authEnv', 'persistentToken']);

/** 非机密默认值：CLI 名走 PATH（企业已确认叫 `gh`），超时 20s（与 runner 默认同源）。 */
export const DEFAULT_CLI_PATH = 'gh';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/**
 * 凭据变量默认名：r10 起为空——默认**不**向子进程注入任何凭据变量（AC-22 的「只注入
 * 你点名的」）。需要令牌时由补丁层显式配 `authEnv:`；缺令牌不再阻断只读命令。
 */
export const DEFAULT_AUTH_ENV = Object.freeze([]);

/**
 * 落盘凭据（CLI 配置目录里的令牌文件）的处置策略。
 *
 * - `warn`（默认）：检测到只告警，照常执行——企业环境常由 CLI 自己管理凭据，
 *   落盘凭据自检只是诊断信息；
 * - `block`：检测到即拒绝（合规场景），`GITEE_PERSISTENT_TOKEN` 仍是固定 reason。
 */
export const PERSISTENT_TOKEN_POLICIES = Object.freeze(['warn', 'block']);
export const DEFAULT_PERSISTENT_TOKEN_POLICY = 'warn';

/** block 策略唯一的用户可见拦截文案：适配器预检与 CLI 拒绝共用，避免两处漂移。 */
export const PERSISTENT_TOKEN_BLOCK_MESSAGE = '检测到 CLI 配置目录存在持久令牌：当前策略为 block，已停止执行；请删除该明文令牌，然后在终端运行 gh auth login 存入系统凭据库';

/** 失败原因码（TECHNICAL §8.3 固定枚举，不新增自由文本）。 */
export const CONFIG_REASONS = Object.freeze({
  INVALID: 'GITEE_CONFIG_INVALID',
  PERSISTENT: 'GITEE_PERSISTENT_TOKEN',
});

/** 环境变量名：字母/下划线开头，只含字母数字下划线（避免把别的东西当变量名读）。 */
const AUTH_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 主机名（可带端口）：拒绝协议前缀、路径与 userinfo——那些会把主机配置变成注入面（本 CLI 没有 `--host` 参数，见 gitee-adapter 的 argv 表）。 */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/;

/** 带协议的写法（`scheme://…`）：`cliPath` 是可执行文件标识，不是 URL。 */
const SCHEME_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** 与 r3 `cli-discovery.WRAPPER_SUFFIXES` 同口径：包装脚本一律不接受（execFile 起不来）。 */
const WRAPPER_SUFFIXES = Object.freeze(['.cmd', '.bat', '.ps1', '.com', '.vbs']);

const MAX_PATH_LENGTH = 4096;
const MAX_HOST_LENGTH = 253;
const MAX_AUTH_ENV = 8;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const fail = (message) => ({ ok: false, message });

/** 去空白后为空一律视为"未配置"；非字符串（含数字、对象）原样返回给调用方判非法。 */
function asText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 只读显式 env 里的字符串值；空白字符串等价于未设置。 */
function readText(env, key) {
  const raw = env === null || env === undefined ? undefined : env[key];
  if (typeof raw !== 'string') return undefined;
  return raw.trim() === '' ? undefined : raw.trim();
}

function validateCliPath(value) {
  const text = asText(value);
  if (text === null) return fail('需要一个可执行文件标识（PATH 名或绝对路径）');
  if (text.length > MAX_PATH_LENGTH) return fail(`长度不能超过 ${MAX_PATH_LENGTH} 个字符`);
  if (CONTROL_CHARS.test(text)) return fail('不能包含换行或控制字符');
  if (text.startsWith('-')) return fail('不能以连字符开头（会被当成命令行开关）');
  if (SCHEME_LIKE.test(text)) return fail('需要一个可执行文件标识，不是 URL');
  const lower = text.toLowerCase();
  const suffix = WRAPPER_SUFFIXES.find((item) => lower.endsWith(item));
  if (suffix !== undefined) {
    return fail(`不接受 ${suffix} 包装脚本：execFile 只启动真正的可执行文件（与 r3 同口径）`);
  }
  return { ok: true, value: text };
}

function validateHost(value) {
  const text = asText(value);
  if (text === null) return fail('需要一个主机名（例如企业 Gitee 域名）');
  if (text.length > MAX_HOST_LENGTH) return fail(`长度不能超过 ${MAX_HOST_LENGTH} 个字符`);
  const normalized = text.toLowerCase();
  if (!HOST_NAME.test(normalized)) {
    return fail('只能是主机名（字母、数字、点和连字符），可带端口；不要带协议、路径或用户名密码');
  }
  return { ok: true, value: normalized };
}

function validateTimeoutMs(value) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    return fail(`请输入 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 之间的整数（毫秒）`);
  }
  return { ok: true, value: parsed };
}

/**
 * `authEnv` 接受单个变量名或名称数组；去重保序（先配先生效），不回显输入。
 *
 * 空数组是合法意图（r10）：默认就是空，表示"不向子进程注入任何凭据变量"；缺令牌
 * 不再阻断只读命令，所以"一个都不点名"不是配置错误。
 */
function validateAuthEnv(value) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_AUTH_ENV) return fail(`最多 ${MAX_AUTH_ENV} 个候选变量`);
  const names = [];
  for (const entry of list) {
    if (typeof entry !== 'string') return fail('只接受环境变量名（字符串，或字符串数组）');
    const name = entry.trim();
    if (name.length === 0) return fail('环境变量名不能为空');
    if (!AUTH_ENV_NAME.test(name)) {
      return fail('不是合法的环境变量名（只允许字母、数字与下划线，且不能以数字开头）');
    }
    if (!names.includes(name)) names.push(name);
  }
  return { ok: true, value: names };
}

/** 落盘凭据的处置策略：只认固定枚举，自由文本会让"到底拦不拦"变成猜的。 */
function validatePersistentToken(value) {
  const text = asText(value);
  if (text === null) {
    return fail(`需要一个策略值（${PERSISTENT_TOKEN_POLICIES.join(' / ')}）`);
  }
  if (!PERSISTENT_TOKEN_POLICIES.includes(text)) {
    return fail(`只接受 ${PERSISTENT_TOKEN_POLICIES.join(' / ')}`);
  }
  return { ok: true, value: text };
}

const FIELD_VALIDATORS = Object.freeze({
  cliPath: validateCliPath,
  host: validateHost,
  timeoutMs: validateTimeoutMs,
  authEnv: validateAuthEnv,
  persistentToken: validatePersistentToken,
});

/**
 * 字段级校验的**唯一实现处**：补丁层配置、`ConfigStandard`（宿主 loader）与
 * `resolveGiteeConfig` 全走这里。
 *
 * 形状与 Standard Schema v1 一致：`{ value }` 或 `{ issues: [{ message, path }] }`，
 * **不抛错**——配置写错是用户的正常输入。`undefined` / `null` 等价零配置（宿主
 * `resolveConfig` 在补丁层那一行没写 `config:` 时传的就是 `undefined`，判成非法会让
 * 整条 entry 不激活、插件整体消失）。
 *
 * 空串/纯空白/`null` 视为"该字段缺席"（清空是合法意图），保留默认值或进 `missing`。
 */
export function validateGiteeConfig(input) {
  const candidate = input === undefined || input === null ? {} : input;
  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { issues: [{ message: '配置必须是一个字段对象', path: [] }] };
  }

  const issues = [];
  for (const key of Object.keys(candidate)) {
    if (!CONFIG_KEYS.includes(key)) {
      issues.push({ message: `未知配置项：${key}`, path: [key] });
    }
  }

  const value = {};
  for (const field of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(candidate, field)) continue;
    const raw = candidate[field];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const verdict = FIELD_VALIDATORS[field](raw);
    if (verdict.ok === true) {
      value[field] = verdict.value;
    } else {
      issues.push({ message: verdict.message, path: [field] });
    }
  }

  return issues.length > 0 ? { issues } : { value };
}

/**
 * 把补丁层配置 + 显式 env 解析成运行配置。
 *
 * r10 起 `missing` **不阻断**：`host` 缺省只是"未配置主机"，`authEnv` 默认就是空。
 * 只有用户显式点名了令牌变量、而环境里一个都没值时，才把那些变量名列进 `missing`——
 * 这是"你可能忘了注入"的提示，不是错误。
 *
 * @param {{config?: object, env?: Record<string, string | undefined>}} [input]
 * @returns {Readonly<{cliPath: string, host: string | null, timeoutMs: number,
 *   authEnv: readonly string[], tokenSource: string | null,
 *   persistentToken: string, missing: readonly string[]}>}
 */
export function resolveGiteeConfig({ config, env } = {}) {
  const verified = validateGiteeConfig(config ?? {});
  const accepted = verified.value ?? {};

  const cliPath = accepted.cliPath ?? DEFAULT_CLI_PATH;
  const host = accepted.host ?? null;
  const timeoutMs = accepted.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authEnv = [...(accepted.authEnv ?? DEFAULT_AUTH_ENV)];
  const persistentToken = accepted.persistentToken ?? DEFAULT_PERSISTENT_TOKEN_POLICY;

  const source = env === null || env === undefined ? {} : env;
  const missing = [];

  let tokenSource = null;
  for (const name of authEnv) {
    if (readText(source, name) !== undefined) {
      tokenSource = name;
      break;
    }
  }
  if (tokenSource === null) missing.push(...authEnv);

  return Object.freeze({
    cliPath,
    host,
    timeoutMs,
    authEnv: Object.freeze(authEnv),
    tokenSource,
    persistentToken,
    missing: Object.freeze(missing),
  });
}

/** 路径类值只留文件名：绝对路径与内网目录结构都不进描述（AC-22 不回显）。 */
function maskPath(value) {
  const separators = /[\\/]/;
  if (!separators.test(value)) return value;
  const parts = value.split(separators).filter((part) => part.length > 0);
  const base = parts.length > 0 ? parts[parts.length - 1] : value;
  return `…/${base}`;
}

/**
 * 配置的"可展示形态"：一行、无令牌值、无绝对路径。
 *
 * 接受 `resolveGiteeConfig()` 的返回值、裸配置对象，或不传（装配期排障用）。
 * 不做解析——`missing` 之类派生结论只呈现 `resolve` 已经算好的结果，避免第二套口径。
 *
 * @param {object | undefined} config
 * @returns {string}
 */
export function describeGiteeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const value = raw.value !== null && typeof raw.value === 'object' ? raw.value : raw;

  const cliPath = typeof value.cliPath === 'string' && value.cliPath.length > 0
    ? maskPath(value.cliPath)
    : DEFAULT_CLI_PATH;
  const host = typeof value.host === 'string' && value.host.length > 0 ? value.host : '未配置';
  const timeoutMs = Number.isSafeInteger(value.timeoutMs) ? value.timeoutMs : DEFAULT_TIMEOUT_MS;
  const authEnv = Array.isArray(value.authEnv) && value.authEnv.length > 0
    ? value.authEnv.join(',')
    : '未配置';
  const persistentToken = PERSISTENT_TOKEN_POLICIES.includes(value.persistentToken)
    ? value.persistentToken
    : DEFAULT_PERSISTENT_TOKEN_POLICY;
  const tokenSource = typeof value.tokenSource === 'string' && value.tokenSource.length > 0
    ? `已注入(${value.tokenSource})`
    : '未注入';
  const missing = Array.isArray(value.missing) && value.missing.length > 0
    ? value.missing.join(',')
    : '-';

  return `forge-gitee 配置：cliPath=${cliPath} host=${host} timeoutMs=${timeoutMs} `
    + `authEnv=${authEnv} persistentToken=${persistentToken} token=${tokenSource} missing=${missing}`;
}

/**
 * Standard Schema v1 的校验入口（无依赖，不引 schemastery）。
 *
 * 只导出 `~standard.validate`，**不**提供 `toJSON()`：宿主的 settings 表单面要求
 * `Config` 同时给出 `toJSON` 与 `volatile`，而本轮配置只走补丁层 `config:`
 * （PRD T5：不做 Web 配置页），把整条依赖链拉进安装单元没有收益。
 */
export const ConfigStandard = Object.freeze({
  '~standard': Object.freeze({ version: 1, vendor: 'heluo', validate: validateGiteeConfig }),
});
