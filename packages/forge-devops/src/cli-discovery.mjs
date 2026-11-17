/**
 * `@heluo/forge-devops` 有界 CLI 发现（T1(r3)，AC-1 / AC-2 / AC-4；r18 重写「选哪个」）。
 *
 * 这个模块回答一个问题：**这台机器上，dop / gh 有没有能被本插件启动的入口，在哪。**
 * 它是插件里唯一需要读文件系统的地方，因此把三条纪律写进实现，而不是留给调用方自觉：
 *   1. **只读**：只调用注入的 `statSync` / `readFileSync` / `readdirSync`，不写盘、不读配置、
 *      不改环境。
 *   2. **零外部程序**：不启动任何进程，也不提供"跑一下 `where`/`which`/`--version` 看看"
 *      的通道——发现若会执行候选程序，一个同名的恶意文件就能在装配期被跑起来。
 *      本模块因此只依赖 `node:path`、支撑包的两个纯函数模块与注入的 `fs`。
 *   3. **有界**：目录数上限 + 截止时间 + 单目录异常吞掉，任何一项到点即停并如实置
 *      `truncated`；读 shim 另受支撑包 `SHIM_READ_LIMIT`（16 KiB）约束。
 *
 * ## r18：只有「能被本插件启动的入口」才算找到
 *
 * r8 让发现接受"是普通文件"的一切形态，于是 win32 上 npm 的无后缀 shim 被当成入口选中，
 * 配置页显示就绪，用户点开业务命令才报包装脚本（内网现场）。r18 改回**按启动方式**筛选：
 *
 *   - 判定用 `isSpawnableEntry`（支撑包唯一实现）：win32 只认 `.exe`；POSIX 普通文件 + 执行位。
 *   - 遇到 shim（`.cmd` / `.ps1` / 无后缀）不让它进 `found`，而是**沿 shim 解析到包内原生
 *     程序**（`resolveNpmShim`：读 shim → `node_modules/<包>/<脚本>.js` → 包根 → `bin\<tool>.exe`）。
 *     npm 在 Windows 上的全局安装正是这个布局：`<prefix>\dop` 只是壳，
 *     `<prefix>\node_modules\@cli-tools\dop\bin\dop.exe` 才是能启动的那个。
 *   - 解析成功 → 原生路径进 `found`，并带 `resolvedFrom`（shim 原始路径，仅主机内可见）；
 *     解析失败 → 进 `rejected`（`why` = 支撑包原因码），**绝不**把 shim 当结果返回。
 *
 * 因此 `found[0]` 恒为"选定即可用"的入口；`rejected` 不再恒为空，它是页面解释"为什么没就绪"
 * 的依据（只经同源 GET 出网）。
 *
 * 产物契约（蓝图 §3.2，r18 修订）：
 *   WRAPPER_SUFFIXES / wrapperSuffixOf / isStorableEntry / isSpawnableEntry（再导出，定义在支撑包）
 *   DISCOVERY_TIERS
 *   candidateExecutableNames(tool, platform) -> string[]
 *   parsePathVar({ env, platform, pathModule }) -> string[]
 *   candidateDirs({ platform, env, tool? }) -> [{ dir, tier: 'candidate-dir' }]
 *   discoverTool({ tool, platform, env, fs, now, maxCandidates, deadlineMs }) -> Discovery
 *   discoverCli({ platform, env, fs, now, tools, maxCandidates, deadlineMs }) -> { dop, gh }
 *
 * `Discovery`（仅主机内，含路径）：
 *   { tool,
 *     found: [{ path, tier, resolvedFrom? }],
 *     rejected: [{ path, tier, form, why }],
 *     searched: ['PATH', 'candidate-dir'], scannedDirs, skippedDirs, truncated, elapsedMs }
 *
 * `found` 排序键为 `(是否由 shim 解析而来, tier 序号, 候选名序号, path)`——解析出的原生入口
 * 排最前（它就是为了绕开起不来的壳），其后同一层级内 `.exe` 恒先于裸名与脚本形态。
 *
 * `fs` 注入同步面 `{ statSync, readdirSync, readFileSync? }`；缺少 `readFileSync` 时不解析
 * shim（shim 记为 `rejected`，`why='no-reader'`），不静默降格成"就用 shim"。
 */
import path from 'node:path';

import {
  candidateExecutableNames,
  expandPathVars,
  parsePathVar,
  pathKey,
  pathModuleFor,
} from './entry-path.mjs';
import {
  ENTRY_FORMS,
  WRAPPER_SUFFIXES,
  entryFormOf,
  isSpawnableEntry,
  isStorableEntry,
  wrapperSuffixOf,
} from './entry-form.mjs';
import { resolveNpmShim } from './entry-resolve.mjs';

// 再导出（不是重新声明）：调用方与既有测试仍从 cli-discovery 取这批符号，但定义只有一份。
export {
  WRAPPER_SUFFIXES,
  wrapperSuffixOf,
  isStorableEntry,
  isSpawnableEntry,
  candidateExecutableNames,
  parsePathVar,
};

/** 发现层：先查 PATH，再查候选目录。顺序即优先级（同类命中里 PATH 排前）。 */
export const DISCOVERY_TIERS = Object.freeze(['PATH', 'candidate-dir']);

/** 预算缺省值（AC-4）：200 个目录、250ms。两者都是"上限"，不是"目标"。 */
export const DEFAULT_MAX_CANDIDATES = 200;
export const DEFAULT_DEADLINE_MS = 250;

/**
 * shim 解析失败的原因码补位：`resolveNpmShim` 的 `READ_FAILED` 在发现层有两种成因
 * （注入的 fs 没有 `readFileSync` / 读的时候抛错），页面文案不同，所以分开记。
 */
const NO_READER = 'no-reader';

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

/** 大小写敏感与否的唯一判定处（win32 的文件名与环境变量名都不区分大小写）。 */
const fold = (value, platform) => (isWin32(platform) ? value.toLowerCase() : value);

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
    const key = pathKey(normalized, resolvedPlatform);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({ dir: normalized, tier: 'candidate-dir' });
  }
  return dirs;
}

/**
 * 尝试把一条 shim 候选解析成包内原生入口。
 *
 * 只对需要解释器才能启动的形态（`.cmd` / `.ps1` / 无后缀 shim）做；`.exe` 与 POSIX 可执行
 * 文件本来就能直接启动，走不到这里。注入的 `fs` 没有 `readFileSync` 时如实拒绝，不猜。
 */
function resolveShimCandidate({ path: file, tool, platform, fs }) {
  if (typeof fs.readFileSync !== 'function') {
    return { ok: false, reason: NO_READER };
  }
  const outcome = resolveNpmShim({ path: file, tool, platform, fs });
  if (outcome.ok === true) return outcome;
  return { ok: false, reason: typeof outcome.reason === 'string' ? outcome.reason : 'unresolved' };
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
    const key = pathKey(dir, resolvedPlatform);
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
  const rejected = [];
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
      // 不是候选名（`readme.txt`、`dop.sh`、`.vbs`）连 stat 都不做。
      if (!rankByName.has(nameKey)) continue;
      const full = pm.join(visit.dir, name);
      const fullKey = pathKey(full, resolvedPlatform);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }

      // ① 能直接启动：直接收下（win32 只有 .exe，POSIX 是带执行位的普通文件）。
      if (isSpawnableEntry({ path: full, platform: resolvedPlatform, stat }) === true) {
        if (seenFound.has(fullKey)) continue;
        seenFound.add(fullKey);
        found.push({ path: full, tier: visit.tier });
        continue;
      }

      // ② 存得下但起不来：只对包装形态做"沿 shim 找包内原生程序"。
      if (isStorableEntry({ path: full, platform: resolvedPlatform, stat }) !== true) continue;
      const form = entryFormOf(full, resolvedPlatform);
      if (form !== ENTRY_FORMS.WRAPPER && form !== ENTRY_FORMS.EXTENSIONLESS) continue;
      const resolved = resolveShimCandidate({ path: full, tool: toolName, platform: resolvedPlatform, fs });
      if (resolved.ok === true) {
        const resolvedKey = pathKey(resolved.path, resolvedPlatform);
        if (seenFound.has(resolvedKey)) continue;
        seenFound.add(resolvedKey);
        found.push({ path: resolved.path, tier: visit.tier, resolvedFrom: full });
        continue;
      }
      // 解析不出来就如实记进 rejected：页面据它解释"只发现包装脚本"，绝不回退成"就用它试试"。
      rejected.push({ path: full, tier: visit.tier, form, why: resolved.reason });
    }
  }

  // 排序：解析出的原生入口 → 层级（PATH 优先）→ 候选名下标 → 路径升序。
  const rankOf = (file) => {
    const key = fold(pm.basename(file), resolvedPlatform);
    return rankByName.get(key) ?? executableNames.length;
  };
  const ordered = [...found].sort((left, right) => {
    const resolvedDelta = (left.resolvedFrom === undefined ? 1 : 0) - (right.resolvedFrom === undefined ? 1 : 0);
    if (resolvedDelta !== 0) return resolvedDelta;
    const tierDelta = DISCOVERY_TIERS.indexOf(left.tier) - DISCOVERY_TIERS.indexOf(right.tier);
    if (tierDelta !== 0) return tierDelta;
    const rankDelta = rankOf(left.path) - rankOf(right.path);
    return rankDelta !== 0 ? rankDelta : compareText(left.path, right.path);
  });

  return {
    tool: toolName,
    found: ordered,
    // r18：装得下但起不来的候选记在这里（r8 曾恒为空）。
    rejected,
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
