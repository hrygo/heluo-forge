/**
 * `@heluo/forge-devops` 有界 CLI 发现（T1(r3)，AC-1 / AC-2 / AC-4）。
 *
 * 这个模块回答一个问题：**这台机器上，dop / gh 有没有可直接执行的入口，在哪。**
 * 它是插件里唯一需要读文件系统的地方，因此把三条纪律写进实现，而不是留给调用方自觉：
 *   1. **只读**：只调用注入的 `statSync` / `readdirSync`，不写盘、不读配置、不改环境。
 *   2. **零外部程序**：不启动任何进程，也不提供"跑一下 `where`/`which`/`--version` 看看"
 *      的通道——发现若会执行候选程序，一个同名的恶意文件就能在装配期被跑起来。
 *      本模块因此只依赖 `node:path` 与注入的 `fs`（静态用例守这条，见
 *      `test/delivery-selfcheck.test.mjs` 的 r3 增量）。
 *   3. **有界**：目录数上限 + 截止时间 + 单目录异常吞掉，任何一项到点即停并如实置
 *      `truncated`——宁可说"没扫完"，也不让一次网络盘挂载把插件装配拖住。
 *
 * "可直接执行"的判定（r8 AC-2/AC-4）：**唯一实现在 `entry-form.mjs`**，本模块只再导出
 * 同一批符号，不再自带一份后缀规则。
 *   - win32：是普通文件即可（`.exe` / 裸名 / `.cmd` / `.ps1` / `.bat` / `.com` 同等对待，
 *     不再有后缀门槛）——"能不能被这份调用方式启动"由运行期提示回答，不由发现阶段替用户拒收。
 *   - 其它：普通文件且任一执行位打开（POSIX 口径零变化）。
 *   - `rejected` 保留键但**恒为空数组**：r8 起发现不再拒收任何形态，键留着是为了快照契约
 *     （`cli-access.pathEntry` 透传、页面字段断言）不变。
 *
 * 产物契约（蓝图 §3.2，逐字）：
 *   WRAPPER_SUFFIXES / wrapperSuffixOf / isDirectlyExecutable（再导出，定义在 entry-form.mjs）
 *   DISCOVERY_TIERS
 *   candidateExecutableNames(tool, platform) -> string[]
 *   parsePathVar({ env, platform, pathModule }) -> string[]
 *   candidateDirs({ platform, env, tool? }) -> [{ dir, tier: 'candidate-dir' }]
 *   discoverTool({ tool, platform, env, fs, now, maxCandidates, deadlineMs }) -> Discovery
 *   discoverCli({ platform, env, fs, now, tools, maxCandidates, deadlineMs }) -> { dop, gh }
 *
 * `Discovery`（仅主机内，含路径）：
 *   { tool, found: [{ path, tier }], rejected: [],
 *     searched: ['PATH', 'candidate-dir'], scannedDirs, skippedDirs, truncated, elapsedMs }
 *
 * `found` 排序键为 `(tier 序号, 候选名序号, path)`——候选名序号取
 * `candidateExecutableNames()` 的下标，于是"同层级内原生 `.exe` 恒先于裸名与脚本形态"既
 * 不依赖目录遍历顺序，也不依赖 PATH 先后（AC-3）。
 *
 * `fs` 只注入同步面 `{ statSync, readdirSync }`；`now` 注入毫秒时钟（默认 `Date.now`），
 * 两者合起来让"Windows 行为"与"到点即停"能被假实现确定性覆盖（真机仍属 NOT RUN）。
 */

import path from 'node:path';
import { isDirectlyExecutable, wrapperSuffixOf, WRAPPER_SUFFIXES } from './entry-form.mjs';

// 再导出（不是重新声明）：调用方与既有测试仍从 cli-discovery 取这三个符号，但定义只有一份。
export { isDirectlyExecutable, wrapperSuffixOf, WRAPPER_SUFFIXES };

/** 发现层：先查 PATH，再查候选目录。顺序即优先级（同类命中里 PATH 排前）。 */
export const DISCOVERY_TIERS = Object.freeze(['PATH', 'candidate-dir']);

/** 预算缺省值（AC-4）：200 个目录、250ms。两者都是"上限"，不是"目标"。 */
export const DEFAULT_MAX_CANDIDATES = 200;
export const DEFAULT_DEADLINE_MS = 250;

/**
 * 候选目录表（数据驱动，F2 未决时只作兜底）：清单覆盖不足由配置页手动指定弥补，
 * 这里不试图穷举企业安装位置，也不递归查找。
 *
 * `{tool}` 是工具名占位符：`discoverTool` 总会带 `tool` 展开；`candidateDirs()` 不带
 * `tool` 时保留占位符原文，让"表本身"可被断言，而不是悄悄用某个工具名顶替。
 */
const CANDIDATE_DIR_TEMPLATES = Object.freeze({
  win32: Object.freeze([
    '%ProgramFiles%\\{tool}',
    '%ProgramFiles(x86)%\\{tool}',
    '%ProgramFiles%\\heluo',
    '%LOCALAPPDATA%\\Programs\\{tool}',
    '%USERPROFILE%\\.{tool}\\bin',
  ]),
  posix: Object.freeze(['/usr/local/bin', '/opt/{tool}/bin']),
});

const isWin32 = (platform) => platform === 'win32';

/** 平台专属的 path 实现：不能用宿主 `path`，否则 posix 主机上测不了 win32 行为。 */
const pathModuleFor = (platform) => (isWin32(platform) ? path.win32 : path.posix);

/** 大小写敏感与否的唯一判定处（win32 的文件名与环境变量名都不区分大小写）。 */
const fold = (value, platform) => (isWin32(platform) ? value.toLowerCase() : value);

/** 环境变量读取：win32 按名字大小写不敏感匹配（`Path` / `PATH` 都算）。 */
function envValue(env, name, platform) {
  if (env === null || env === undefined || typeof env !== 'object') return undefined;
  if (isWin32(platform)) {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() === wanted && typeof value === 'string') return value;
    }
    return undefined;
  }
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 变量展开（只展开 `env` 里已定义者，未定义的原样保留——静默清空会让一个拼错的
 * 变量名变成"根目录下的相对路径"，比留着 `%DOP_HOME%` 更难排查）。
 * 单次替换、不递归：环境变量值里再写变量名属于环境配置错误，不在这里兜。
 */
function expandPathVars(value, env, platform) {
  if (isWin32(platform)) {
    return value.replace(/%([^%]+)%/g, (whole, name) => {
      const hit = envValue(env, name, platform);
      return hit === undefined ? whole : hit;
    });
  }
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (whole, braced, bare) => {
    const name = braced ?? bare;
    const hit = envValue(env, name, platform);
    return hit === undefined ? whole : hit;
  });
}

/** 去掉 PATH 项两侧的引号（`"C:\Program Files\x";C:\tools` 这种写法在 Windows 上很常见）。 */
function stripQuotes(value) {
  return value.replace(/^"+|"+$/g, '').trim();
}

/**
 * 目录去重键：win32 把分隔符统一成 `\` 并小写（`C:/Tools` = `c:\tools`），去掉尾部
 * 分隔符；盘符根 `C:\` 与 POSIX 根 `/` 保留自身。posix 严格按字符串比较。
 */
function dirKey(value, platform) {
  let key = isWin32(platform) ? value.replace(/\//g, '\\').toLowerCase() : value;
  if (isWin32(platform) && /^[a-z]:\\$/.test(key)) return key;
  key = key.replace(/[\\/]+$/, '');
  if (key === '') return isWin32(platform) ? '\\' : '/';
  return key;
}

/**
 * 预算归一：缺省用默认值，非法值用默认值，**负数当 0**——一个负预算不能被解释成
 * "没设上限"，否则调用方写错一处，发现就退化成无界扫描。
 */
function clampBudget(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function compareText(left, right) {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft !== foldedRight) return foldedLeft < foldedRight ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 某个工具在某个平台可执行的名字表（r8 AC-3）。
 *
 * win32 从 1 项扩到 6 项，**顺序即优先级**：`.exe`（原生）→ 裸名（npm 生成的 shim）→
 * `.cmd` → `.ps1` → `.bat` → `.com`。发现侧不再按后缀拒收，所以"哪个能直接跑"不能靠丢候选
 * 来表达，只能靠这张表的次序——`found` 排序取本表下标，同层级内 `.exe` 因此恒排第一。
 * POSIX 仍只有裸名一项（执行位文件，零变化）。
 */
export function candidateExecutableNames(tool, platform = process.platform) {
  const name = typeof tool === 'string' ? tool.trim() : '';
  if (name === '') return [];
  return isWin32(platform)
    ? [`${name}.exe`, name, `${name}.cmd`, `${name}.ps1`, `${name}.bat`, `${name}.com`]
    : [name];
}

/**
 * 解析 `PATH` 环境变量 → 目录列表。
 * 分割符来自注入的 `pathModule.delimiter`（win32 `;` / posix `:`）：宿主是 posix 时
 * 模拟 win32，不能拿宿主的 `:` 去切。
 */
export function parsePathVar(options = {}) {
  const { env = null, platform = process.platform, pathModule } = options;
  const resolvedPlatform = platform ?? process.platform;
  const pm = pathModule ?? pathModuleFor(resolvedPlatform);
  const delimiter = typeof pm?.delimiter === 'string' && pm.delimiter !== ''
    ? pm.delimiter
    : isWin32(resolvedPlatform) ? ';' : ':';
  const raw = envValue(env, 'PATH', resolvedPlatform) ?? '';
  const dirs = [];
  const seen = new Set();
  for (const item of raw.split(delimiter)) {
    const cleaned = stripQuotes(expandPathVars(item, env, resolvedPlatform));
    if (cleaned === '') continue;
    const key = dirKey(cleaned, resolvedPlatform);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(cleaned);
  }
  return dirs;
}

/**
 * 候选目录表 → `[{ dir, tier: 'candidate-dir' }]`。
 * 环境变量缺失导致条目不完整的直接跳过（无法解析成绝对目录）；`tool` 缺省时保留
 * `{tool}` 占位符——本函数只描述"表"，展开由 `discoverTool` 用它自己的工具名完成。
 */
export function candidateDirs(options = {}) {
  const { platform = process.platform, env = null, tool = null } = options;
  const resolvedPlatform = platform ?? process.platform;
  const pm = pathModuleFor(resolvedPlatform);
  const templates = CANDIDATE_DIR_TEMPLATES[isWin32(resolvedPlatform) ? 'win32' : 'posix'];
  const toolName = typeof tool === 'string' ? tool.trim() : '';
  const dirs = [];
  const seen = new Set();
  for (const template of templates) {
    const expanded = expandPathVars(template, env, resolvedPlatform);
    // 保留未定义变量说明这一项解析不出来：宁可少一个候选目录，也不要一个假路径。
    if (isWin32(resolvedPlatform) && /%[^%]+%/.test(expanded)) continue;
    const withTool = toolName === '' ? expanded : expanded.split('{tool}').join(toolName);
    const normalized = isWin32(resolvedPlatform) ? pm.normalize(withTool) : withTool;
    if (normalized === '' || normalized === '.') continue;
    const key = dirKey(normalized, resolvedPlatform);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({ dir: normalized, tier: 'candidate-dir' });
  }
  return dirs;
}

/**
 * 一次有界发现：PATH → 候选目录，边读边判，到预算即停。
 * 调用 `now()` 的时机固定为：开始时一次、每个目录前一次、结束时一次。
 */
export function discoverTool(options = {}) {
  const {
    tool,
    platform = process.platform,
    env = null,
    fs,
    now = Date.now,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = options;
  if (fs === null || fs === undefined || typeof fs.statSync !== 'function' || typeof fs.readdirSync !== 'function') {
    throw new TypeError('discoverTool 需要注入同步 fs（statSync / readdirSync），发现只读文件系统');
  }
  if (typeof now !== 'function') throw new TypeError('discoverTool 的 now 必须是返回毫秒数的函数');
  const toolName = typeof tool === 'string' ? tool.trim().toLowerCase() : '';
  if (toolName === '') throw new TypeError('discoverTool 需要 tool 名（dop / gh）');

  const resolvedPlatform = platform ?? process.platform;
  const pm = pathModuleFor(resolvedPlatform);
  const startedAt = now();
  const budget = clampBudget(maxCandidates, DEFAULT_MAX_CANDIDATES);
  const allowedMs = clampBudget(deadlineMs, DEFAULT_DEADLINE_MS);

  // 名字表下标 = 优先级（`.exe`=0、裸名=1、`.cmd`=2、`.ps1`=3、`.bat`=4、`.com`=5）。
  // 折叠后建立索引：win32 上 `DOP.EXE` 必须与 `dop.exe` 落在同一格优先级。
  const executableNames = candidateExecutableNames(toolName, resolvedPlatform);
  const rankByName = new Map(executableNames.map((name, index) => [fold(name, resolvedPlatform), index]));

  // 跨层去重：同一目录既在 PATH 里又是候选目录时只扫一次，层级取先出现的（PATH 优先）。
  const visits = [];
  const visitedKeys = new Set();
  const pushVisit = (dir, tier) => {
    const key = dirKey(dir, resolvedPlatform);
    if (visitedKeys.has(key)) return;
    visitedKeys.add(key);
    visits.push({ dir, tier });
  };
  for (const dir of parsePathVar({ env, platform: resolvedPlatform, pathModule: pm })) {
    pushVisit(dir, DISCOVERY_TIERS[0]);
  }
  for (const { dir, tier } of candidateDirs({ platform: resolvedPlatform, env, tool: toolName })) {
    pushVisit(dir, tier);
  }

  const found = [];
  const seenFound = new Set();
  let scannedDirs = 0;
  let skippedDirs = 0;
  let truncated = false;

  for (const visit of visits) {
    if (scannedDirs >= budget) {
      truncated = true;
      break;
    }
    if (now() - startedAt >= allowedMs) {
      truncated = true;
      break;
    }
    scannedDirs += 1;
    let items;
    try {
      items = fs.readdirSync(visit.dir);
    } catch {
      // 目录不存在 / 权限不足 / 网络盘掉线：都只是"这一格没查到"，不中断整次发现。
      skippedDirs += 1;
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const name = typeof item === 'string' ? item : item !== null && typeof item?.name === 'string' ? item.name : '';
      if (name === '') continue;
      const nameKey = fold(name, resolvedPlatform);
      // 不是候选名（`readme.txt`、`dop.sh`、`.vbs`）连 stat 都不做；不再按后缀拒收。
      if (!rankByName.has(nameKey)) continue;
      const full = pm.join(visit.dir, name);
      const fullKey = dirKey(full, resolvedPlatform);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!isDirectlyExecutable({ path: full, platform: resolvedPlatform, stat })) continue;
      if (seenFound.has(fullKey)) continue;
      seenFound.add(fullKey);
      found.push({ path: full, tier: visit.tier });
    }
  }

  // 排序：层级（PATH 优先）→ 候选名下标（`.exe` 恒先于裸名与脚本形态）→ 路径升序。
  // 页面按这个顺序展示，首个即"静默取首个"的那个（AC-3：双形态并存时 found[0] 是原生入口）。
  const rankOf = (file) => {
    const key = fold(pm.basename(file), resolvedPlatform);
    return rankByName.get(key) ?? executableNames.length;
  };
  const ordered = [...found].sort((left, right) => {
    const tierDelta = DISCOVERY_TIERS.indexOf(left.tier) - DISCOVERY_TIERS.indexOf(right.tier);
    if (tierDelta !== 0) return tierDelta;
    const rankDelta = rankOf(left.path) - rankOf(right.path);
    return rankDelta !== 0 ? rankDelta : compareText(left.path, right.path);
  });

  return {
    tool: toolName,
    found: ordered,
    // r8：不再拒收任何形态，键保留（快照契约），值恒为空数组。
    rejected: [],
    searched: [...DISCOVERY_TIERS],
    scannedDirs,
    skippedDirs,
    truncated,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

/**
 * 发现 `dop` 与 `gh`，共用一份预算（AC-4：发现是**整次**有界，不是每个工具各花 200 个目录）。
 * `dop` 先扫：它是 fail closed 的字段，`gh` 有 `DEFAULT_GH_BIN` 兜底。
 */
export function discoverCli(options = {}) {
  const {
    platform = process.platform,
    env = null,
    fs,
    now = Date.now,
    tools = ['dop', 'gh'],
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = options;
  const resolvedPlatform = platform ?? process.platform;
  const requested = [...new Set(
    (Array.isArray(tools) ? tools : ['dop', 'gh'])
      .map((tool) => (typeof tool === 'string' ? tool.trim().toLowerCase() : ''))
      .filter((tool) => tool !== ''),
  )];
  const startedAt = now();
  const endsAt = startedAt + clampBudget(deadlineMs, DEFAULT_DEADLINE_MS);
  let remainingDirs = clampBudget(maxCandidates, DEFAULT_MAX_CANDIDATES);
  const result = {};
  for (const tool of requested) {
    const remainingMs = Math.max(0, endsAt - now());
    const discovery = discoverTool({
      tool,
      platform: resolvedPlatform,
      env,
      fs,
      now,
      maxCandidates: remainingDirs,
      deadlineMs: remainingMs,
    });
    result[tool] = discovery;
    remainingDirs = Math.max(0, remainingDirs - discovery.scannedDirs);
  }
  return result;
}
