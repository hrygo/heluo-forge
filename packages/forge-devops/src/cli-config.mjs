/**
 * `@heluo/forge-devops` 命令行配置（T2）：三层合并、来源归属、逐字段校验、脱敏描述。
 *
 * 这个模块回答三个问题，且是它们的**唯一**回答处：
 *   1. **当前生效哪一层**：逐字段 `配置 > 环境变量 > 自动发现`，`ghBin`/`sourceType`/`timeoutMs`
 *      另有基线缺省（`default`）。`dopBin` 永不给默认值——fail closed 不能被一个猜测的路径掩盖。
 *   2. **值能不能存**：字段规则只有一份（`runtime-config.validateConfigField`），本模块只在其上
 *      追加需要平台与文件系统的**路径类**判定（存在性、目录、包装脚本、执行位）。
 *   3. **能不能说出去**：带路径的 `Access` 只留在主机内；对外的 `describeCliAccess()` 结构上
 *      不读 `value`，只给 origin/布尔/枚举。两者是两个函数，故意不合并成一个带 `reveal` 开关的
 *      函数——开关迟早会被顺手传 true（TECHNICAL §0 判断 3 / §5 回显边界）。
 *
 * 无 IO、无宿主依赖、无子进程：`fs` 由调用方注入（`validateCliField`/`buildCliPatch`），
 * `resolveCliAccess` 连 `fs` 都不需要——装配期解析只做形状判定，读盘只在"发现"与"保存校验"两处。
 *
 * 产物契约（蓝图 §3.2）：
 *   CLI_FIELDS / CLI_ORIGINS / CLI_REASONS / CLI_ORIGIN_LABELS / CLI_SEARCH_CATEGORIES
 *   resolveCliAccess({ config, env, discovery, platform }) -> Access
 *   describeCliAccess(access) -> 脱敏描述（无 path、无 endpoint 值）
 *   validateCliField({ field, value, platform, fs }) -> { ok:true, value } | { ok:false, message }
 *   buildCliPatch({ current, patch, platform, fs }) -> { ok:true, next } | { ok:false, errors }
 *   cliGuidance(access) -> 类别名 + 配置页指引（页面 / 工具 / 状态面共用同一句）
 *
 * `Access`（主机内，含路径与 endpoint 值）：
 *   { ready, reason, entries: { <field>: { origin, value, overrides, tool? } },
 *     value: { 六字段 } | null, invalid: [{ field, origin, message }], searched: string[], guidance }
 *   `overrides` 是"被本层压过的下层"（如 `['env']` = 配置覆盖了环境变量），页面据此显示
 *   「覆盖环境变量」Tag；环境变量/自动发现/缺省被压过时同样记录，绝不静默。
 */
import {
  DEFAULT_GH_BIN,
  DEFAULT_SOURCE_TYPE,
  DEFAULT_TIMEOUT_MS,
  ENV_KEYS,
  validateConfigField,
} from './runtime-config.mjs';
// 包装脚本判定与发现侧共用同一份实现（P2-1：不允许两处各写一张后缀表）。
import { wrapperSuffixOf } from './cli-discovery.mjs';

/** 六个逻辑字段，顺序即页面字段顺序（与 `ENV_KEYS` 同键，不另立词表）。 */
export const CLI_FIELDS = Object.freeze([
  'dopBin',
  'dopEndpoint',
  'ghBin',
  'ghOwner',
  'sourceType',
  'timeoutMs',
]);

/** 来源枚举（AC-3）。`default` 是终值而非第四层：只有带基线缺省的字段会出现。 */
export const CLI_ORIGINS = Object.freeze({
  CONFIG: 'config',
  ENV: 'env',
  DISCOVERED: 'discovered',
  DEFAULT: 'default',
  MISSING: 'missing',
});

/** 原因码（AC-5 / AC-9 / AC-15）。http 层原样透传，页面按码选文案。 */
export const CLI_REASONS = Object.freeze({
  NOT_FOUND: 'CLI_NOT_FOUND',
  INVALID: 'CLI_CONFIG_INVALID',
  CONFLICT: 'CLI_CONFIG_CONFLICT',
  UNAVAILABLE: 'CLI_CONFIG_UNAVAILABLE',
});

/**
 * origin 的中文标签：页面 Tag、`cliGuidance`、`cliStatus` 三处共用这一份。
 * 页面侧用同名 i18n 键（`origin.*`），键与值一一对应——任一处写中文字面量就会漂移。
 */
export const CLI_ORIGIN_LABELS = Object.freeze({
  [CLI_ORIGINS.CONFIG]: '配置',
  [CLI_ORIGINS.ENV]: '环境变量',
  [CLI_ORIGINS.DISCOVERED]: '自动发现',
  [CLI_ORIGINS.DEFAULT]: '基线缺省',
  [CLI_ORIGINS.MISSING]: '未找到',
});

/** "找过哪几类位置"的类别词（AC-5）：工具侧与页面共用同一套措辞。 */
export const CLI_SEARCH_CATEGORIES = Object.freeze({
  CONFIG: 'config',
  ENV: 'env',
  PATH: 'PATH',
  CANDIDATE_DIRS: 'candidate-dirs',
});

const CATEGORY_LABELS = Object.freeze({
  [CLI_SEARCH_CATEGORIES.CONFIG]: '配置',
  [CLI_SEARCH_CATEGORIES.ENV]: '环境变量',
  [CLI_SEARCH_CATEGORIES.PATH]: 'PATH',
  [CLI_SEARCH_CATEGORIES.CANDIDATE_DIRS]: '候选目录',
});

/** 修复指引的唯一一句话：README、页面、工具失败文案都指向这里（AC-12）。 */
export const CLI_PAGE_HINT = '设置 → DevOps 变更流程';

/**
 * 包装脚本拒收（AC-2）：`dop.cmd` 长得像可执行文件，但 `execFile` 在不带 shell 的前提下
 * 根本跑不起来，存进去只会把"配置成功"变成"运行时启动失败"。
 *
 * 后缀表与判定只在 `cli-discovery.mjs` 定义一份（QA P2-1）：发现侧拒收候选、
 * 校验侧拒收用户手填，是同一规则的两个调用点，不是两份规则。
 */
const WRAPPER_MESSAGE = '.cmd / .bat 包装脚本不能直接执行，请指向 .exe';
const NOT_EXECUTABLE_MESSAGE = '不是可直接执行的文件';

/** 路径类字段 ←→ 发现工具名（其余字段没有发现层）。 */
const TOOL_BY_FIELD = Object.freeze({ dopBin: 'dop', ghBin: 'gh' });

/** 逐字段的层序。缺省值不在此表：它在 `DEFAULTS`，出现时 origin 记为 `default`。 */
const LAYERS = Object.freeze({
  dopBin: Object.freeze(['config', 'env', 'discovered']),
  ghBin: Object.freeze(['config', 'env', 'discovered']),
  dopEndpoint: Object.freeze(['config', 'env']),
  ghOwner: Object.freeze(['config', 'env']),
  sourceType: Object.freeze(['config', 'env']),
  timeoutMs: Object.freeze(['config', 'env']),
});

/** 基线缺省（非机密、与 `resolveRuntimeConfig` 同源）。`dopBin` 故意缺席。 */
const DEFAULTS = Object.freeze({
  ghBin: DEFAULT_GH_BIN,
  sourceType: DEFAULT_SOURCE_TYPE,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

const ORIGIN_BY_LAYER = Object.freeze({
  config: CLI_ORIGINS.CONFIG,
  env: CLI_ORIGINS.ENV,
  discovered: CLI_ORIGINS.DISCOVERED,
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 配置层入参：接受裸字段对象，也接受 `resolveRuntimeConfig()` 的信封（`ok:false` 视为未配置）。
 * 装配层两种都会传（loader 的 `Config` 输出 vs 环境变量解析结果），在这里统一，别处不再判断。
 */
function configLayerOf(config) {
  if (!isPlainObject(config)) return {};
  if (config.ok === true && isPlainObject(config.value)) return config.value;
  if (config.ok === false) return {};
  return config;
}

/** 某个字段在某一层是否有值；没有返回 `undefined`（与"空串"同义）。 */
function layerValue(layer, field, sources) {
  if (layer === 'config') {
    const raw = sources.config[field];
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw === 'string' && raw.trim() === '') return undefined;
    return raw;
  }
  if (layer === 'env') {
    const env = sources.env;
    const raw = isPlainObject(env) ? env[ENV_KEYS[field]] : undefined;
    return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
  }
  // discovered：发现结果只贡献路径类字段；`found` 按 tier、path 升序，取首个即"静默取首个"策略。
  const tool = TOOL_BY_FIELD[field];
  if (tool === undefined) return undefined;
  const discovery = isPlainObject(sources.discovery) ? sources.discovery[tool] : undefined;
  const found = isPlainObject(discovery) ? discovery.found : undefined;
  if (!Array.isArray(found)) return undefined;
  const hit = found.find((item) => text(item?.path) !== '');
  return hit === undefined ? undefined : text(hit.path);
}

function looksLikePath(value, platform) {
  return platform === 'win32' ? /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) : value.includes('/');
}

/**
 * Windows 上的可执行形态：**路径形态**的值必须以 `.exe` 结尾；裸命令名（如 `gh`）不当作路径——
 * 它是 PATH 名，交给子进程的 PATH 解析，不是这里的责任。
 */
function checkExecutableSuffix(value, platform) {
  if (platform !== 'win32') return { ok: true, value };
  if (!looksLikePath(value, platform)) return { ok: true, value };
  if (value.toLowerCase().endsWith('.exe')) return { ok: true, value };
  return { ok: false, message: `${NOT_EXECUTABLE_MESSAGE}（Windows 上请指向 .exe）` };
}

/** 目录/执行位文案按字段点名本体，便于用户对着资源管理器找（DESIGN §6 error.isDirectory）。 */
function binaryLabel(field, platform) {
  const tool = TOOL_BY_FIELD[field] ?? 'dop';
  return platform === 'win32' ? `${tool}.exe` : tool;
}

/** 读盘判定：存在性 → 目录 → 普通文件 → 执行位（posix）。`fs` 缺失时跳过（解析环节不读盘）。 */
function probeFile(field, value, platform, fs) {
  if (fs === null || fs === undefined || typeof fs.statSync !== 'function') return { ok: true, value };
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    return { ok: false, message: '找不到这个文件' };
  }
  if (!isPlainObject(stat)) return { ok: true, value };
  if (typeof stat.isDirectory === 'function' && stat.isDirectory() === true) {
    return { ok: false, message: `这是目录，需要指向 ${binaryLabel(field, platform)} 本体` };
  }
  if (typeof stat.isFile === 'function' && stat.isFile() !== true) {
    return { ok: false, message: NOT_EXECUTABLE_MESSAGE };
  }
  if (platform !== 'win32') {
    const mode = typeof stat.mode === 'number' ? stat.mode : 0;
    if ((mode & 0o111) === 0) return { ok: false, message: `${NOT_EXECUTABLE_MESSAGE}（缺少执行位）` };
  }
  return { ok: true, value };
}

/**
 * 字段级校验（层解析与保存校验共用）：基础规则 → 包装脚本 → 可选读盘 → 可执行形态。
 *
 * 顺序有意为之：目录/不存在这类"看得见的错"优先于扩展名，用户先修掉最直观的问题；
 * 扩展名判定放在读盘之后，否则一个真实存在的目录会被报成"不是 .exe"，反而更费解。
 */
function checkFieldValue({ field, value, platform, fs }) {
  const base = validateConfigField(field, value);
  if (base.ok !== true) return base;
  if (TOOL_BY_FIELD[field] === undefined || base.value === null) return base;

  const path = base.value;
  if (wrapperSuffixOf(path) !== null) return { ok: false, message: WRAPPER_MESSAGE };
  if (!looksLikePath(path, platform)) return { ok: true, value: path };

  const probed = probeFile(field, path, platform, fs);
  if (probed.ok !== true) return probed;
  const suffix = checkExecutableSuffix(path, platform);
  if (suffix.ok !== true) return suffix;
  return { ok: true, value: path };
}

function entryOf(field, origin, value, overrides) {
  const entry = { origin, value, overrides: Object.freeze(overrides) };
  const tool = TOOL_BY_FIELD[field];
  if (tool !== undefined) entry.tool = tool;
  return Object.freeze(entry);
}

/** 被本层压过的下层（只记"本来有值"的层），页面/状态面据此说明覆盖关系。 */
function overriddenLayers(field, winningLayer, sources) {
  const layers = LAYERS[field] ?? [];
  const index = winningLayer === null ? layers.length : layers.indexOf(winningLayer);
  return layers
    .slice(index + 1)
    .filter((layer) => layerValue(layer, field, sources) !== undefined)
    .map((layer) => ORIGIN_BY_LAYER[layer]);
}

function resolveField(field, sources, invalid) {
  for (const layer of LAYERS[field] ?? []) {
    const candidate = layerValue(layer, field, sources);
    if (candidate === undefined) continue;
    const verdict = checkFieldValue({ field, value: candidate, platform: sources.platform, fs: null });
    if (verdict.ok !== true) {
      const origin = ORIGIN_BY_LAYER[layer];
      invalid.push(Object.freeze({ field, origin, message: verdict.message }));
      // 不回落下一层：填错的意图若被静默替换成别的路径，用户会以为"我配置的那个在生效"。
      return entryOf(field, origin, null, []);
    }
    return entryOf(field, ORIGIN_BY_LAYER[layer], verdict.value, overriddenLayers(field, layer, sources));
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULTS, field)) {
    return entryOf(field, CLI_ORIGINS.DEFAULT, DEFAULTS[field], []);
  }
  return entryOf(field, CLI_ORIGINS.MISSING, null, []);
}

/** 找过哪几类位置：配置与环境变量恒查；发现层的 tier 来自发现结果自报。 */
function searchedCategories(discovery) {
  const tiers = new Set();
  for (const tool of ['dop', 'gh']) {
    const found = isPlainObject(discovery) ? discovery[tool] : undefined;
    if (!isPlainObject(found)) continue;
    const searched = found.searched;
    if (Array.isArray(searched)) {
      for (const tier of searched) tiers.add(String(tier));
    } else {
      // 发现跑过但没自报 tier：按发现层的定义（PATH + 候选目录）记，宁愿多报也不漏报。
      tiers.add('PATH');
      tiers.add('candidate-dir');
    }
  }
  const list = [CLI_SEARCH_CATEGORIES.CONFIG, CLI_SEARCH_CATEGORIES.ENV];
  if (tiers.has('PATH')) list.push(CLI_SEARCH_CATEGORIES.PATH);
  if (tiers.has('candidate-dir') || tiers.has('candidate-dirs')) {
    list.push(CLI_SEARCH_CATEGORIES.CANDIDATE_DIRS);
  }
  return list;
}

function originLabel(access, field) {
  const origin = access.entries?.[field]?.origin;
  return CLI_ORIGIN_LABELS[origin] ?? CLI_ORIGIN_LABELS[CLI_ORIGINS.MISSING];
}

/**
 * 指引文案的唯一生成处（AC-5 / AC-12）：类别名 + 一句指向配置页的话。
 * 只有 origin 标签与类别词，**不含路径、endpoint、环境变量名**——它要进工具错误信息。
 */
function guidanceOf(access) {
  const hint = `请到「${CLI_PAGE_HINT}」`;
  if (access.ready === true) {
    return `命令行工具已就绪（dop 来自${originLabel(access, 'dopBin')} · gh 来自${originLabel(access, 'ghBin')}）`;
  }
  if (access.reason === CLI_REASONS.INVALID) {
    const detail = (Array.isArray(access.invalid) ? access.invalid : [])
      .map((item) => `${item.field}：${item.message}`)
      .join('；');
    return `命令行配置不可用（${detail}）· ${hint}修正`;
  }
  const categories = (Array.isArray(access.searched) ? access.searched : [])
    .map((category) => CATEGORY_LABELS[category] ?? category)
    .join('、');
  return `未找到 dop · 已查 ${categories} · ${hint}指定位置`;
}

/**
 * 三层合并（逐字段），返回**含路径**的 `Access`（主机内使用，绝不直接进工具输出/报告/日志）。
 *
 * 任一层出现非法值即 `ready:false` + `CLI_CONFIG_INVALID`，并**不**回落到下一层；
 * `dopBin` 三层都没有则 `ready:false` + `CLI_NOT_FOUND`。两种失败都带 `guidance`。
 *
 * @param {object} [options]
 * @param {object|null} [options.config] 配置层（裸字段对象或 `resolveRuntimeConfig` 信封）
 * @param {object|null} [options.env] 环境变量表（显式传入，不读进程环境）
 * @param {{dop?: object, gh?: object}|null} [options.discovery] `discoverCli()` 的输出
 * @param {string} [options.platform] `process.platform` 口径；显式传入以便离线复现 Windows
 * @returns {Readonly<object>} Access
 */
export function resolveCliAccess({ config = null, env = null, discovery = null, platform } = {}) {
  const sources = {
    config: configLayerOf(config),
    env,
    discovery,
    platform: typeof platform === 'string' && platform !== '' ? platform : process.platform,
  };

  const invalid = [];
  const entries = {};
  for (const field of CLI_FIELDS) entries[field] = resolveField(field, sources, invalid);

  const ready = entries.dopBin.value !== null && invalid.length === 0;
  const reason = ready
    ? null
    : invalid.length > 0
      ? CLI_REASONS.INVALID
      : CLI_REASONS.NOT_FOUND;

  const value = ready
    ? Object.freeze({
        dopBin: entries.dopBin.value,
        dopEndpoint: entries.dopEndpoint.value ?? undefined,
        ghBin: entries.ghBin.value,
        ghOwner: entries.ghOwner.value ?? undefined,
        sourceType: entries.sourceType.value,
        timeoutMs: entries.timeoutMs.value,
      })
    : null;

  const access = {
    ready,
    reason,
    entries: Object.freeze(entries),
    value,
    invalid: Object.freeze(invalid),
    searched: Object.freeze(searchedCategories(discovery)),
    guidance: '',
  };
  access.guidance = guidanceOf(access);
  return Object.freeze(access);
}

/**
 * 脱敏描述（AC-10）：只有 origin、配置布尔位与两个非机密枚举。
 *
 * 结构上不把任何 `value` 读进返回值——路径与 endpoint 只经 GET 快照出网；这个函数的结果
 * 才会进 `cliStatus()`、工具描述与报告。
 */
export function describeCliAccess(access) {
  const source = isPlainObject(access) ? access : {};
  const entries = isPlainObject(source.entries) ? source.entries : {};

  const described = {};
  for (const field of CLI_FIELDS) {
    const entry = isPlainObject(entries[field]) ? entries[field] : {};
    const value = entry.value;
    described[field] = Object.freeze({
      origin: typeof entry.origin === 'string' ? entry.origin : CLI_ORIGINS.MISSING,
      configured:
        (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value)),
      overrides: Object.freeze(
        Array.isArray(entry.overrides) ? entry.overrides.filter((item) => typeof item === 'string') : [],
      ),
    });
  }

  const invalid = (Array.isArray(source.invalid) ? source.invalid : [])
    .filter((item) => isPlainObject(item))
    .map((item) =>
      Object.freeze({
        field: typeof item.field === 'string' ? item.field : 'unknown',
        origin: typeof item.origin === 'string' ? item.origin : CLI_ORIGINS.CONFIG,
        message: typeof item.message === 'string' ? item.message : '',
      }),
    );

  const enumValue = (field) => {
    const value = entries[field]?.value;
    return typeof value === 'string' ? value : null;
  };
  const timeoutMs = entries.timeoutMs?.value;

  return Object.freeze({
    ready: source.ready === true,
    reason: typeof source.reason === 'string' ? source.reason : null,
    entries: Object.freeze(described),
    sourceType: enumValue('sourceType'),
    timeoutMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : null,
    invalid: Object.freeze(invalid),
    searched: Object.freeze(Array.isArray(source.searched) ? source.searched.filter((item) => typeof item === 'string') : []),
    guidance: cliGuidance(source),
  });
}

/**
 * 单字段校验（保存路径）：字段规则 + 路径类读盘判定。
 *
 * `null`/空串 = 清除该字段（合法），返回 `{ ok:true, value:null }`；
 * 非法返回 `{ ok:false, message }`，message **不含用户输入值**（回显边界 AC-10）。
 */
export function validateCliField({ field, value, platform, fs } = {}) {
  if (typeof field !== 'string' || !CLI_FIELDS.includes(field)) {
    return { ok: false, message: `未知配置项：${String(field)}` };
  }
  return checkFieldValue({
    field,
    value,
    platform: typeof platform === 'string' && platform !== '' ? platform : process.platform,
    fs: fs ?? null,
  });
}

/**
 * 保存补丁：把页面提交的**意图**合并进现存用户层，逐字段报错（AC-9 / AC-15）。
 *
 * 语义：
 *   - `patch[field] === null`（或空串）→ 从 `next` 删除该键 = 回落下一层；
 *   - 合法值 → 归一化后写入 `next`；
 *   - 任一字段非法 → `{ ok:false, errors }`，**一个字段都不写**（磁盘保持原样）；
 *   - `current` 不被修改（纯函数），未出现在 patch 里的既有键原样保留。
 *
 * 等值噪声由调用方（cli-access）用 `next` 与继承层深等比较收口；这里不做"猜意图"。
 */
export function buildCliPatch({ current, patch, platform, fs } = {}) {
  if (!isPlainObject(patch)) {
    return { ok: false, errors: Object.freeze({ fields: '请求体需要一个字段对象' }) };
  }
  const normalizedPlatform = typeof platform === 'string' && platform !== '' ? platform : process.platform;
  const base = isPlainObject(current) ? current : {};

  const next = {};
  for (const field of CLI_FIELDS) {
    const stored = base[field];
    if (stored === null || stored === undefined) continue;
    if (typeof stored === 'string' && stored.trim() === '') continue;
    next[field] = stored;
  }

  const errors = {};
  for (const [field, raw] of Object.entries(patch)) {
    if (!CLI_FIELDS.includes(field)) {
      errors[field] = `未知配置项：${field}`;
      continue;
    }
    const cleared = raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (cleared) {
      delete next[field];
      continue;
    }
    const verdict = checkFieldValue({ field, value: raw, platform: normalizedPlatform, fs: fs ?? null });
    if (verdict.ok !== true) {
      errors[field] = verdict.message;
      continue;
    }
    if (verdict.value === null) delete next[field];
    else next[field] = verdict.value;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors: Object.freeze(errors) };
  return { ok: true, next: Object.freeze(next) };
}

/**
 * 指引文案（AC-5）：类别名 + 配置页指引，不含路径与 endpoint。
 * 接受 `Access` 或 `describeCliAccess()` 的输出，两者核心字段同形。
 */
export function cliGuidance(access) {
  const source = isPlainObject(access) ? access : {};
  const entries = isPlainObject(source.entries) ? source.entries : {};
  return guidanceOf({
    ready: source.ready === true,
    reason: typeof source.reason === 'string' ? source.reason : null,
    entries,
    invalid: Array.isArray(source.invalid) ? source.invalid : [],
    searched:
      Array.isArray(source.searched) && source.searched.length > 0
        ? source.searched
        : [CLI_SEARCH_CATEGORIES.CONFIG, CLI_SEARCH_CATEGORIES.ENV],
  });
}
