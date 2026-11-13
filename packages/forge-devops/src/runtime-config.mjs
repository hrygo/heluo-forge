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
 *     -> { ok: true, value: { dopBin, dopEndpoint, sourceType, timeoutMs } }
 *      | { ok: false, reason: 'CONFIG_MISSING', missing: string[] }
 *      | { ok: false, reason: 'CONFIG_INVALID', invalid: string[] }
 *   describeRuntimeConfig(cfg | result)
 *     -> { dopBin: boolean, dopEndpoint: boolean,
 *          sourceType: string | null, timeoutMs: number | null }
 *   validateConfigField(field, value)
 *     -> { ok: true, value } | { ok: false, message }   // T2 增量：字段级校验唯一实现处
 *   DEFAULT_FIELD_VALUES
 *     -> { sourceType, timeoutMs }   // 非必填项的基线缺省，三层合并与本模块共用同一份
 *   ConfigStandard
 *     -> { '~standard': { version: 1, vendor: 'heluo', validate } }   // T2 增量，见文末
 *
 * **扩展说明**：蓝图只声明了 `CONFIG_MISSING`。这里补一个 `CONFIG_INVALID`：
 * 「配置了但不可用」（endpoint 不是 http(s)、超时不是合法整数）与「没配置」是两种
 * 不同的可见原因，挤进同一个码会让排障与报告把用户配置错误读成环境缺失。
 * 两者的放行语义完全相同——都返回 `ok: false`，调用方一律不得继续。
 *
 * 单值口径：只认字符串，且去掉首尾空白后为空即视为「未配置」（`''`、`'   '`）。
 * 不把 `undefined` 与空串区别对待，也不为任何字段提供主机相关默认值。
 *
 * **一层包裹引号不算值**：Windows 启动脚本里 `set VAR='值'` 会把引号写进值本身，
 * 资源管理器「复制文件地址」给出的也是带双引号的全路径——都是搬运时混进的引号，
 * 在交给字段规则之前剥掉**一对**（见 `scalarText`）。剥完仍带引号的值判非法：
 * 环境变量层不读盘，一个带引号的 `dopBin` 会一路活到 `execFile` 才报 `ENOENT`，
 * 那正是本模块 fail closed 要挡在门外的失败面。
 */

/** 环境变量名 → 逻辑字段名。文档表格与代码同源于此表，别处不再复制一份。 */
export const ENV_KEYS = Object.freeze({
  dopBin: 'FORGE_DEVOPS_DOP_BIN',
  dopEndpoint: 'FORGE_DEVOPS_DOP_ENDPOINT',
  sourceType: 'FORGE_DEVOPS_SOURCE_TYPE',
  timeoutMs: 'FORGE_DEVOPS_TIMEOUT_MS',
});

/**
 * r10 退役键：gh 侧字段已随模块删除。历史 profile 里可能还留着 `ghBin`/`ghOwner`，
 * **必须静默忽略**——若按未知配置项报 issue，宿主装配期会整条 entry 不激活（插件消失），
 * 与「已保存的 ghBin 被忽略且不报错」的契约直接冲突。其余未知键仍按非法处理。
 */
const RETIRED_KEYS = Object.freeze(['ghBin', 'ghOwner']);

/** 失败原因码。`CONFIG_MISSING` 为蓝图声明，`CONFIG_INVALID` 见文件头扩展说明。 */
export const CONFIG_REASONS = Object.freeze({
  MISSING: 'CONFIG_MISSING',
  INVALID: 'CONFIG_INVALID',
});

/** 事实来源类型：mock（企业 dop 的本地模拟）与 enterprise（企业实测）。 */
export const SOURCE_TYPES = Object.freeze(['mock', 'enterprise']);

/** 非机密默认值：来源默认 mock，超时默认 20s（与 cli-runner 默认一致）。dopBin 故意无默认。 */
export const DEFAULT_SOURCE_TYPE = 'mock';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/**
 * 非必填项的基线缺省（非机密）。`cli-config` 的三层合并且同一份：两处各写一遍，
 * 页面显示的缺省与 runner 实际用的超时迟早分叉（`config.test.mjs` 锁了这条）。
 */
export const DEFAULT_FIELD_VALUES = Object.freeze({
  sourceType: DEFAULT_SOURCE_TYPE,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

/** 必填项（没有默认值）：缺失即 `CONFIG_MISSING`，其余字段可缺省或可选。 */
const REQUIRED_FIELDS = Object.freeze(['dopBin']);

/** 一层成对的包裹引号：`'值'` / `"值"`（`VAR='值'` 与「复制文件地址」的现场形态）。 */
const WRAPPED_IN_QUOTES = /^(['"])([\s\S]*)\1$/u;

/** 值两侧残留的引号：成对剥完还剩一层、或只有一侧（`'值`、`值'`）。 */
const EDGE_QUOTE = /^['"]|['"]$/u;

/**
 * 单值归一化：去首尾空白 → 剥掉一层成对包裹引号 → 再判空。
 *
 * 只剥**一层**、且要求两侧引号一致：`''值''` 剥完是 `'值'`，仍然带引号，
 * 由调用方（`validateConfigField`）拒掉，而不是继续猜到用户想写什么。
 * **只在这里剥**：`readText` 只判有没有值，两处都剥会把两层引号一起吃光。
 * 非字符串与空串一律返回 `null`（= 未配置）。
 */
function scalarText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const unwrapped = trimmed.replace(WRAPPED_IN_QUOTES, '$2').trim();
  return unwrapped === '' ? null : unwrapped;
}

/**
 * 该值是否构成「配了值」：去空白、剥一层成对包裹引号后仍非空。
 *
 * 与 `scalarText` 同一实现，供三层合并判断「这一层到没到」用：`VAR=''` 归一化后是空，
 * 就不算配了值——否则它会被算成「压过了下一层」，页面上凭空多一条覆盖提示。
 */
export function hasConfigValue(value) {
  return scalarText(value) !== null;
}

/** 只做「有没有值」的判定（去空白后为空 = 未配置）；引号归一化归 `validateConfigField`。 */
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

/** 路径类字段的长度上限：挡住误粘贴整段日志，同时不限制正常的深目录。 */
const MAX_PATH_LENGTH = 4096;

const fail = (message) => ({ ok: false, message });

/** 去空白后为空一律视为「未配置」。 */
function asText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateText(value, max = MAX_PATH_LENGTH) {
  const text = asText(value);
  if (text === null) return fail('需要一个文本值');
  if (text.length > max) return fail(`长度不能超过 ${max} 个字符`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return fail('不能包含换行或控制字符');
  return { ok: true, value: text };
}

/**
 * 单字段校验的**唯一实现处**（AC-9 / AC-12）。
 *
 * 页面表单（`cli-config.validateCliField`）、环境变量层（`resolveRuntimeConfig`）与
 * 宿主 loader / 配置面（`ConfigStandard`）都走到这里：同一条规则若各写一份，迟早会
 * 分叉成「页面能存、加载即失败」或反过来的两套口径。
 *
 * 这里只做**跨平台语义**的判定（文本形状、endpoint、枚举、区间）；需要 `platform` 与
 * 文件系统的路径类判定（存在性、目录、包装脚本、执行位）由 `cli-config` 在本函数之上
 * 追加一层，因此本模块不读磁盘、不认平台。
 *
 * @param {string} field 四个逻辑字段之一（与 `ENV_KEYS` 同键）
 * @param {unknown} value 字符串/数字/null（null 与空串等价于「未配置」）
 * @returns {{ok: true, value: unknown} | {ok: false, message: string}}
 *   成功时 `value` 是归一化后的值（首尾去空白、剥掉一层包裹引号、`sourceType` 小写、
 *   `timeoutMs` 为数字）；`value: null` 表示该字段未配置，调用方据此回落下一层。
 */
export function validateConfigField(field, value) {
  if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(ENV_KEYS, field)) {
    return fail(`未知配置项：${String(field)}`);
  }
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'string' && value.trim() === '') return { ok: true, value: null };

  // 归一化只对文本做：`timeoutMs` 还接受页面上传的数字，非字符串在下面按各字段自己的规则判。
  if (typeof value === 'string') {
    const text = scalarText(value);
    if (text === null) return { ok: true, value: null }; // 只剩引号 = 空值，等于未配置
    // 成对引号已剥掉；这里剩下的引号是单边或第二层，判非法而不是继续猜。
    if (EDGE_QUOTE.test(text)) {
      return fail('值的两侧不要带引号（从命令行或资源管理器复制整段时，引号会被一起带进来）');
    }
    value = text;
  }

  switch (field) {
    case 'dopBin':
      return validateText(value);
    case 'dopEndpoint': {
      const text = asText(value);
      if (text === null) return fail('需要一个文本值');
      if (!isEndpointLike(text)) return fail('需要 http 或 https 地址，且地址里不能带用户名密码');
      return { ok: true, value: text };
    }
    case 'sourceType': {
      const text = asText(value);
      if (text === null) return fail('需要一个文本值');
      const normalized = text.toLowerCase();
      if (!SOURCE_TYPES.includes(normalized)) return fail(`只能取 ${SOURCE_TYPES.join(' 或 ')}`);
      return { ok: true, value: normalized };
    }
    case 'timeoutMs': {
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^\d+$/.test(value.trim())
            ? Number(value.trim())
            : Number.NaN;
      if (!isPositiveInt(parsed, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) {
        return fail(`请输入 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 之间的整数（毫秒）`);
      }
      return { ok: true, value: parsed };
    }
    default:
      return fail(`未知配置项：${field}`);
  }
}

/**
 * 把 `env` 解析为运行配置。
 *
 * 逐字段调用 `validateConfigField`——**不在本函数另写一套字段规则**：环境变量层少判一条，
 * 就会让「环境变量能过、页面存不了」或者反过来（带引号的 `dopBin` 正是这么活到 `execFile` 的）。
 * 这里只负责三件事：点名必须是哪一个变量（`ENV_KEYS`）、补非必填项的缺省、按
 * 「缺失优先于非法」的顺序收口。
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
  const value = {};

  for (const [field, key] of Object.entries(ENV_KEYS)) {
    const verdict = validateConfigField(field, readText(env, key) ?? null);
    if (verdict.ok !== true) {
      invalid.push(key);
      continue;
    }
    if (verdict.value !== null) {
      value[field] = verdict.value;
      continue;
    }
    // 未配置：`dopBin` 是无默认的必填项，缺失单独点名；其余取基线缺省，`dopEndpoint`
    // 既无缺省也不报缺失（显式给 undefined 占位，让返回值的键集合与字段表一致）。
    if (REQUIRED_FIELDS.includes(field)) missing.push(key);
    value[field] = Object.prototype.hasOwnProperty.call(DEFAULT_FIELD_VALUES, field)
      ? DEFAULT_FIELD_VALUES[field]
      : undefined;
  }

  if (missing.length > 0) {
    return { ok: false, reason: CONFIG_REASONS.MISSING, missing };
  }
  if (invalid.length > 0) {
    return { ok: false, reason: CONFIG_REASONS.INVALID, invalid };
  }

  return { ok: true, value: Object.freeze(value) };
}

/**
 * 配置的「可展示形态」：布尔位 + 两个非机密枚举。任何取值都不外泄。
 *
 * 接受 `resolveRuntimeConfig()` 的返回值或它的 `value`，让调用方不必先解包。
 *
 * @param {object | undefined} config
 * @returns {{dopBin: boolean, dopEndpoint: boolean,
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
    sourceType: typeof value.sourceType === 'string' ? value.sourceType : null,
    timeoutMs: isPositiveInt(value.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ? value.timeoutMs : null,
  });
}

/**
 * Standard Schema v1 的校验入口（无依赖，不引 schemastery）。
 *
 * 只导出 `~standard.validate`，**不**提供 `toJSON()`：宿主的 settings 表单面要求
 * `Config` 同时给出 `toJSON` 与 `volatile`，那会把一个装不上的依赖链拉进交付；
 * 配置写入走 `dsh-config-editor`，它只调用本校验器（TECHNICAL §0 判断 1）。
 *
 * 形状：`validate(input)` 返回 `{ value }` 或 `{ issues: [{ message, path }] }`，
 * **不抛错**——配置写错是用户的正常输入，不是异常路径。
 *
 * **缺省配置等价 `{}`**：宿主 `resolveConfig` 在补丁层那一行没写 `config:` 时传进来的是
 * `undefined`，不是 `{}`。把它判成非法会让整条 entry 在装配期抛 `ValidationError`
 * 后**不激活**（插件与工具面一起消失，`--dump-config` 与存在性检查都看不出来）。
 * 因此 `undefined` / `null` 一律按"零配置"处理；标量与数组仍是非法输入。
 */
function validateConfigObject(input) {
  const candidate = input === undefined || input === null ? {} : input;
  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { issues: [{ message: '配置必须是一个字段对象', path: [] }] };
  }
  const issues = [];
  const value = {};
  for (const key of Object.keys(candidate)) {
    if (RETIRED_KEYS.includes(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(ENV_KEYS, key)) {
      issues.push({ message: `未知配置项：${key}`, path: [key] });
    }
  }
  for (const field of Object.keys(ENV_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(candidate, field)) continue;
    const result = validateConfigField(field, candidate[field]);
    if (result.ok === true) {
      if (result.value !== null) value[field] = result.value;
    } else {
      issues.push({ message: result.message, path: [field] });
    }
  }
  return issues.length > 0 ? { issues } : { value };
}

export const ConfigStandard = Object.freeze({
  '~standard': Object.freeze({ version: 1, vendor: 'heluo', validate: validateConfigObject }),
});
