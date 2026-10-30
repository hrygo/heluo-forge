/**
 * `@heluo/forge-devops` 命令行配置（T2）：三层合并、来源归属、逐字段校验、脱敏描述。
 *
 * 这个模块回答三个问题，且是它们的**唯一**回答处：
 *   1. **当前生效哪一层**：逐字段 `配置 > 环境变量 > 自动发现`，`ghBin`/`sourceType`/`timeoutMs`
 *      另有基线缺省（`default`）。`dopBin` 永不给默认值——fail closed 不能被一个猜测的路径掩盖。
 *   2. **值能不能存**：字段规则只有一份（`runtime-config.validateConfigField`），本模块只在其上
 *      追加需要平台与文件系统的**路径类**判定（存在性、目录、普通文件/执行位）。**后缀形态不是门槛**：
 *      win32 下 `.exe`/无后缀/`.cmd`/`.ps1`/`.bat` 一律可存（AC-1/r8）；"能不能直接启动"由
 *      `entry-form.isDirectlyExecutable` 单点判定（AC-4），本模块不自带任何后缀表。
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
 *   deriveSourceType(entries) -> 'mock' | 'enterprise'（唯一推导处；只在 resolveCliAccess 里调用一次）
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
// 入口形态（后缀词表 + 可直接执行判定）的唯一真源：保存侧只消费，不再自带后缀规则（AC-4/r8）。
import { isDirectlyExecutable } from './entry-form.mjs';

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
export const CLI_PAGE_HINT = '设置 → 企业 DevOps';

/**
 * 拒收文案（AC-2）：只描述**真问题**——找不到文件、是目录、不是普通文件、缺执行位。
 * r8 起没有"后缀不对"这一类，因此也没有对应文案：win32 的 `.exe`/无后缀/`.cmd`/`.ps1`/`.bat`
 * 一律可存（AC-1），包装脚本"存得下但跑不起来"由运行期归因提示（`entry-form.describeSpawnFailure`，AC-5）。
 */
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

/** 目录文案按字段点名本体（`dop`/`gh`），便于用户对着资源管理器找（DESIGN §6 error.isDirectory）。 */
function binaryLabel(field) {
  return TOOL_BY_FIELD[field] ?? 'dop';
}

/**
 * 读盘判定：存在性 → 目录 → **可直接执行**（末审只有一处：`entry-form.isDirectlyExecutable`）。
 *
 * 判定本身不在这里复制（AC-4）：win32 只看「是普通文件」——r8 去后缀门槛（AC-1）；POSIX 仍是
 * 包装脚本 / 执行位口径（PRD 明确 POSIX 不动）。这里只负责把 `false` 翻译成一句能据以修的原因，
 * 所以目录先判：「这是目录」比「不是可直接执行的文件」有用得多。
 *
 * `fs` 缺失时跳过（解析环节只做形状判定，读盘只在「发现」与「保存校验」两处）。
 */
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
    return { ok: false, message: `这是目录，需要指向 ${binaryLabel(field)} 的可执行文件本体` };
  }
  if (isDirectlyExecutable({ path: value, platform, stat }) === true) return { ok: true, value };
  // 形态判定已归 entry-form，这里只剩两种否决理由：不是普通文件 / POSIX 缺执行位。
  if (typeof stat.isFile === 'function' && stat.isFile() !== true) {
    return { ok: false, message: NOT_EXECUTABLE_MESSAGE };
  }
  const mode = typeof stat.mode === 'number' ? stat.mode : 0;
  if ((mode & 0o111) === 0) return { ok: false, message: `${NOT_EXECUTABLE_MESSAGE}（缺少执行位）` };
  return { ok: false, message: NOT_EXECUTABLE_MESSAGE };
}

/**
 * 字段级校验（层解析与保存校验共用）：基础规则 → 可选读盘（存在/目录/可执行）→ 原值放行。
 *
 * **没有后缀判定**：`dop` / `dop.cmd` / `dop.ps1` / `dop.bat` / `dop.exe` / `DOP.EXE` 在 win32 上
 * 一视同仁（AC-1）——存不存得下与「跑不跑得起来」是两件事，后者由运行期归因提示（AC-5）负责。
 * 裸命令名（如 `gh`）不当作路径：那是 PATH 名，交给子进程的 PATH 解析，不是这里的责任。
 *
 * 放行时返回 `base.value`（只去首尾空白），其余字符**逐字回写**（AC-1）：不补后缀、不改大小写、
 * 不把 `/` 换成 `\`。
 */
function checkFieldValue({ field, value, platform, fs }) {
  const base = validateConfigField(field, value);
  if (base.ok !== true) return base;
  if (TOOL_BY_FIELD[field] === undefined || base.value === null) return base;

  const path = base.value;
  if (!looksLikePath(path, platform)) return { ok: true, value: path };
  return probeFile(field, path, platform, fs);
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

/**
 * 入口"解析到可直接执行的文件"：有值且来源是显式/发现。
 *
 * `default`（裸命令名 `gh`，`runtime-config.mjs` 的基线缺省）不算就绪——装配期不做 PATH 探测，
 * 把"恰好有个默认名"当作已解析到可执行文件，正是伪企业证据的入口（AC-8）。
 * 非法值同理：`resolveField` 对非法层给的是 `value:null`，这里自然为 false（宁可少标）。
 */
function entryReady(entry) {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.value !== 'string' || entry.value === '') return false;
  return (
    entry.origin === CLI_ORIGINS.CONFIG ||
    entry.origin === CLI_ORIGINS.ENV ||
    entry.origin === CLI_ORIGINS.DISCOVERED
  );
}

/**
 * 推导事实来源（AC-7）：dop 与 gh 都就绪才 `enterprise`，其余一律 `mock`（宁可少标）。
 *
 * **唯一实现处**：页面拿得到 `entries` 但不发送该键，装配层只消费 `resolveCliAccess()` 的结论；
 * 任何一处再推导都会让"这批结论算不算企业实测"出现第二个口径。
 */
export function deriveSourceType(entries) {
  const source = isPlainObject(entries) ? entries : {};
  return entryReady(source.dopBin) && entryReady(source.ghBin) ? 'enterprise' : 'mock';
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
 * `sourceType` 的优先级：配置 > 环境变量 > 推导（`deriveSourceType`）。推导只填既有 `default`
 * 槽位，因此 `entries.sourceType.origin` 只有 `config`/`env`/`default` 三种取值，调用方不必分辨
 * "缺省值"与"推导值"——两者都不压任何层，`overrides` 恒为空。
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

  // 事实来源（AC-7）：只有配置层与环境变量层都没声明时才推导。推导结果占用既有 `default`
  // 槽位（origin 词表不新增、overrides 为空），页面永不发送该键——显式声明永远压过推导。
  if (entries.sourceType.origin === CLI_ORIGINS.DEFAULT) {
    entries.sourceType = entryOf('sourceType', CLI_ORIGINS.DEFAULT, deriveSourceType(entries), []);
  }

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
