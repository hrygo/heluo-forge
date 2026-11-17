/**
 * CLI 入口路径工具（r18 从 `@heluo/forge-devops` 的 `cli-discovery.mjs` 提升为共享模块）。
 *
 * 这里只放三类纯工具，没有任何策略：
 *   1. `candidateExecutableNames(tool, platform)`：某个工具在一台机器上可能出现的**文件名表**，
 *      顺序即优先级（win32 `.exe` 恒在最前）。
 *   2. `parsePathVar({env, platform, pathModule})`：`PATH` → 目录列表（去引号、展开变量、去重）。
 *   3. `pathKey(dir, platform)` / `expandPathVars(value, env, platform)`：去重键与变量展开。
 *
 * 纪律：零 IO、零子进程，`env` / `pathModule` 全部由调用方注入，宿主是 POSIX 时也能模拟
 * win32 的口径（否则 Windows 行为在 macOS/CI 上根本无法离线覆盖）。
 */

import path from 'node:path';

const isWin32 = (platform) => platform === 'win32';

/** 平台专属的 path 实现。 */
export const pathModuleFor = (platform) => (isWin32(platform) ? path.win32 : path.posix);

/** 大小写敏感与否的唯一判定处（win32 的文件名与环境变量名都不区分大小写）。 */
export function fold(value, platform) {
  return isWin32(platform) ? String(value).toLowerCase() : String(value);
}

/** 环境变量读取：win32 按名字大小写不敏感匹配（`Path` / `PATH` 都算）。 */
export function envValue(env, name, platform) {
  if (env === null || env === undefined || typeof env !== 'object') return undefined;
  if (isWin32(platform)) {
    const wanted = String(name).toLowerCase();
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() === wanted && typeof value === 'string') return value;
    }
    return undefined;
  }
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 变量展开（只展开 `env` 里已定义者，未定义的原样保留——静默清空会让一个拼错的变量名变成
 * "根目录下的相对路径"，比留着 `%DOP_HOME%` 更难排查）。单次替换、不递归。
 */
export function expandPathVars(value, env, platform) {
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
export function stripQuotes(value) {
  return value.replace(/^"+|"+$/g, '').trim();
}

/**
 * 目录去重键：win32 把分隔符统一成 `\` 并小写（`C:/Tools` = `c:\tools`），去掉尾部分隔符；
 * 盘符根 `C:\` 与 POSIX 根 `/` 保留自身。posix 严格按字符串比较。
 */
export function pathKey(value, platform) {
  let key = isWin32(platform) ? value.replace(/\//g, '\\').toLowerCase() : value;
  if (isWin32(platform) && /^[a-z]:\\$/.test(key)) return key;
  key = key.replace(/[\\/]+$/, '');
  if (key === '') return isWin32(platform) ? '\\' : '/';
  return key;
}

/**
 * 某个工具在某个平台可执行的名字表。**顺序即优先级**。
 *
 * win32 六项：`.exe`（原生）→ 裸名（npm 生成的 shim）→ `.cmd` → `.ps1` → `.bat` → `.com`。
 * 这张表既能当"发现时该找哪些文件"，也能当"同一目录里谁优先"——`.exe` 下标最小。
 * POSIX 仍只有裸名一项（执行位文件）。
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
 * 分割符来自注入的 `pathModule.delimiter`（win32 `;` / posix `:`）：宿主是 posix 时模拟
 * win32，不能拿宿主的 `:` 去切。
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
    const key = pathKey(cleaned, resolvedPlatform);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(cleaned);
  }
  return dirs;
}
