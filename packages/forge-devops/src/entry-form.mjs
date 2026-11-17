/**
 * CLI 入口形态单点模块（r18：本包自带一份实现；`gh` 用的那份在 `@heluo/forge-gitee`，
 * 两者的等价性由根目录 `tests/cli-entry-parity.test.mjs` 逐条比对——裁决是不新增共享包）。
 *
 * 这个模块只回答一个问题：**一个入口长什么形态，它能被「固定 argv + 不带 shell」的调用
 * 方式直接用掉吗。** 它不产出任何提示文案、不读盘、不启动进程——文案归各包的失败面，
 * 读盘归 `entry-resolve.mjs`。
 *
 * 为什么要分成两个谓词（r18 的核心修正）：
 *
 *   - `isStorableEntry`（**保存侧**：用户能不能把这串字符存进配置）沿用 r8 口径——win32 上
 *     是普通文件即可，不按后缀拒收。用户手工填了 `dop.cmd` 是"我知道我在填什么"，保存层
 *     不该替他否决。
 *   - `isSpawnableEntry`（**系统自动选中 / 装配期就绪**）只认本插件真能启动的形态：win32 上
 *     仅 `.exe`（原生 PE），POSIX 上是普通文件且执行位打开。系统替用户挑入口时**必须**用这条，
 *     否则就会出现 r8 的现场：自动选中 npm 的无后缀 shim、页面显示就绪、`execFile` 起不来，
 *     直到用户点开某个业务命令才看到失败信封。
 *
 * 两条谓词曾经是同一条（`isDirectlyExecutable`），这条历史正是 r18 故障的设计源头：**"能不能
 * 存"与"能不能按这份调用方式启动"被当成同一个问题**。现在它们分开，且系统自动选中只用后者。
 *
 * 纪律（静态用例守）：
 *   1. 纯函数、零 IO：不读盘、不读环境、不看时钟；`stat` 由调用方注入。
 *   2. 零子进程：连"试跑一下看看"的能力都不提供。
 *   3. 唯一依赖 `node:path`，并按目标平台选 `win32`/`posix` 实现——否则 POSIX 主机上测不了
 *      Windows 路径。
 */

import path from 'node:path';

/**
 * 包装脚本后缀：长得像命令，但在固定 argv、未经 shell 的调用方式下起不来。
 *
 * **全仓唯一定义点**：devops 的保存侧/失败面与 gitee 的配置校验都读这一份。新增/删除后缀
 * 只改这里；任何模块再内联一张 `.cmd`/`.bat` 表都属缺陷。
 * `.com` 留在包装表里：它在 win32 上确实可能被 CreateProcess 直接起，但它同时是 npm 时代的
 * 脚本形态，本插件按"非原生 PE"处理更安全——真要选它，用户显式配置并自检。
 * `.vbs` 同理：只为运行期提示覆盖全集。
 */
export const WRAPPER_SUFFIXES = Object.freeze(['.cmd', '.bat', '.ps1', '.com', '.vbs']);

/**
 * 四种入口形态。用常量对象而不是裸字符串，是为了让消费者不能靠手写拼写命中。
 */
export const ENTRY_FORMS = Object.freeze({
  NATIVE: 'native',
  WRAPPER: 'wrapper',
  EXTENSIONLESS: 'extensionless',
  OTHER: 'other',
});

const isWin32 = (platform) => platform === 'win32';

/** 平台专属的 path 实现：不能用宿主 `path`，否则 posix 主机上测不了 win32 行为。 */
const pathModuleFor = (platform) => (isWin32(platform) ? path.win32 : path.posix);

/** 取文件名部分（只看 basename：目录名里带 `.cmd` 不算包装脚本）。 */
function basenameOf(file, platform) {
  if (typeof file !== 'string') return '';
  const trimmed = file.trim();
  if (trimmed === '') return '';
  const name = pathModuleFor(platform).basename(trimmed);
  return typeof name === 'string' ? name : '';
}

/**
 * 命中的包装脚本后缀（小写）或 `null`；大小写不敏感。
 *
 * 非字符串、空串一律 `null`——"判定不出来"不能被当成"是包装脚本"或"不是包装脚本"的任一侧
 * 答案，调用方按自己的语义处理 `null`。
 */
export function wrapperSuffixOf(name) {
  if (typeof name !== 'string' || name === '') return null;
  const lower = name.toLowerCase();
  return WRAPPER_SUFFIXES.find((suffix) => lower.endsWith(suffix)) ?? null;
}

/**
 * 入口形态分类：
 *   - 后缀 ∈ `WRAPPER_SUFFIXES` → `wrapper`；
 *   - basename 以 `.exe` 结尾（不区分大小写）→ `native`；
 *   - basename 不含 `.`：win32 上是 npm 生成的无后缀 shim（`extensionless`），POSIX 上就是
 *     普通可执行文件（`native`，脚本有 shebang + 执行位即可 spawn）；
 *   - 其余 → `other`（`.sh`、`.mjs`、带点的普通文件名……）。
 */
export function entryFormOf(file, platform = process.platform) {
  const resolvedPlatform = platform ?? process.platform;
  const name = basenameOf(file, resolvedPlatform);
  if (name === '') return ENTRY_FORMS.OTHER;
  if (wrapperSuffixOf(name) !== null) return ENTRY_FORMS.WRAPPER;
  const lower = name.toLowerCase();
  if (lower.endsWith('.exe')) return ENTRY_FORMS.NATIVE;
  if (!name.includes('.')) {
    return isWin32(resolvedPlatform) ? ENTRY_FORMS.EXTENSIONLESS : ENTRY_FORMS.NATIVE;
  }
  return ENTRY_FORMS.OTHER;
}

/** 普通文件的唯一判定处：`stat` 缺失或不是普通文件一律 `false`。 */
function isRegularFile(file, stat) {
  if (typeof file !== 'string' || file.trim() === '') return false;
  if (stat === null || stat === undefined) return false;
  if (typeof stat.isFile !== 'function' || stat.isFile() !== true) return false;
  return true;
}

/** POSIX 执行位：mode 缺失视为不可判定（不可判定即不放行）。 */
function hasExecBit(stat) {
  return Number.isInteger(stat?.mode) && (stat.mode & 0o111) !== 0;
}

/**
 * **可保存**：用户把这串字符存进配置时，末审是否放行。
 *
 *   - win32：是普通文件即可，**没有后缀门槛**（r8 AC-1 口径不变）。
 *   - POSIX：包装脚本不放行，任一执行位（`mode & 0o111`）打开才算。
 *
 * 这条只回答"存不存得下"，**不能**用来判定"能不能启动"——那是 `isSpawnableEntry`。
 */
export function isStorableEntry(options = {}) {
  const { path: file, platform = process.platform, stat } = options;
  if (!isRegularFile(file, stat)) return false;
  const resolvedPlatform = platform ?? process.platform;
  if (isWin32(resolvedPlatform)) return true;
  if (wrapperSuffixOf(basenameOf(file, resolvedPlatform)) !== null) return false;
  return hasExecBit(stat);
}

/**
 * **可启动**：本插件（`execFile` + 固定 argv + `shell:false`）真能起得来的形态。
 *
 * 系统自动选中与装配期就绪**只能**用这条：
 *   - win32：仅 `native`（`.exe`）。无后缀 / `.cmd` / `.ps1` / `.bat` / `.com` 一律不可启动
 *     ——它们要么是 npm shim，要么需要 shell 解释；想用它们必须先经 `entry-resolve.mjs`
 *     解析到包内原生可执行文件，或者由用户手工指定 `.exe`。
 *   - POSIX：非包装脚本 + 执行位。无后缀带 shebang + 执行位的脚本由内核直接启动，照旧放行。
 *
 * 判定不出来就返回 `false`：把"没把握"当"可以启动"，正是误把 shim 当入口的那个坑。
 */
export function isSpawnableEntry(options = {}) {
  const { path: file, platform = process.platform, stat } = options;
  if (!isRegularFile(file, stat)) return false;
  const resolvedPlatform = platform ?? process.platform;
  if (isWin32(resolvedPlatform)) return entryFormOf(file, resolvedPlatform) === ENTRY_FORMS.NATIVE;
  return isSpawnablePosix(file, resolvedPlatform, stat);
}

/** POSIX 侧的可启动判定：包装脚本不放行，执行位必须打开。 */
function isSpawnablePosix(file, platform, stat) {
  if (wrapperSuffixOf(basenameOf(file, platform)) !== null) return false;
  return hasExecBit(stat);
}
