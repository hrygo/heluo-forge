/**
 * `@heluo/forge-devops` 入口形态单点模块（T1(r8) 建立，r9 收窄为**纯判定**）。
 *
 * 这个模块只回答一个问题：**一个入口到底长什么形态，它能不能被「固定 argv + 不带 shell」
 * 的调用方式直接启动。** 失败时给用户看哪句话**不归这里管**——那是 `failure-face.mjs`
 * 的职责（r9 / AC-5：渲染只一处）。r8 曾把运行期归因与脱敏放在本模块，那等于给文案留了
 * 第二个出处：只要有人再拼一句提示就会变成两套口径；r9 把它们整体迁到 `failure-face.mjs`
 * 并删除，本模块只剩形态与可执行性，**一个提示字符串都不产出**。
 *
 * 为什么单独成模块：r3 把同一条规则写在了三处（保存侧 `cli-config` 的后缀门槛、发现侧
 * `cli-discovery` 的 `isDirectlyExecutable`、页面 `client.js` 的 `WRAPPER_PATTERN`），只能
 * 靠交付自检的文本扫描防漂移。r8 把「保存放行」一放开，三份副本就会各说各话——于是规则
 * 收敛到这里，**本模块是仓库里唯一持有后缀词表与形态判定的地方**，其余模块全部是消费者：
 *   - 保存侧（`cli-config.mjs`）：末审调 `isDirectlyExecutable`，不再自带后缀表；
 *   - 发现侧（`cli-discovery.mjs`）：再导出同一批符号，候选名表用它排序；
 *   - 失败面（`failure-face.mjs`）：按 `entryFormOf` 的形态选类别文案，不自己判后缀。
 *
 * 纪律（静态用例守这三条，见 `test/entry-form.test.mjs`）：
 *   1. **纯函数、零 IO**：不读盘、不读环境、不看时钟；`stat` 由调用方注入。
 *   2. **零子进程**：不引入任何进程通道，连"试跑一下看看"的能力都不提供。
 *   3. **唯一依赖 `node:path`**（只用 `basename`，且按目标平台选 `win32`/`posix` 实现，
 *      否则 POSIX 主机上测不了 Windows 路径）。
 *
 * 产物契约（蓝图 §T1，逐字）：
 *   WRAPPER_SUFFIXES / ENTRY_FORMS
 *   wrapperSuffixOf(name) -> string | null
 *   entryFormOf(file, platform) -> 'native' | 'wrapper' | 'extensionless' | 'other'
 *   isDirectlyExecutable({ path, platform, stat }) -> boolean
 */

import path from 'node:path';

/**
 * 包装脚本后缀：长得像命令，但在固定 argv、未经 shell 的调用方式下起不来。
 *
 * **唯一定义点**（AC-4）：保存侧、发现侧、页面、运行期提示都读这一份。新增/删除后缀只改
 * 这里；任何模块再内联一张 `.cmd`/`.bat` 表都属缺陷（交付自检有断言）。
 * `.vbs` 留在表里是为了运行期提示覆盖全集——它不进候选名表，发现阶段也不会选它。
 */
export const WRAPPER_SUFFIXES = Object.freeze(['.cmd', '.bat', '.ps1', '.com', '.vbs']);

/**
 * 四种入口形态。用常量对象而不是裸字符串，是为了让消费者（尤其是失败面归因）不能靠
 * 手写拼写命中，改词表时编译器/用例会替我们发现漏改点。
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
 * 非字符串、空串一律 `null`——"判定不出来"不能被当成"是包装脚本"或"不是包装脚本"的
 * 任一侧答案，调用方按自己的语义处理 `null`。
 */
export function wrapperSuffixOf(name) {
  if (typeof name !== 'string' || name === '') return null;
  const lower = name.toLowerCase();
  return WRAPPER_SUFFIXES.find((suffix) => lower.endsWith(suffix)) ?? null;
}

/**
 * 入口形态分类（AC-2）：
 *   - 后缀 ∈ `WRAPPER_SUFFIXES` → `wrapper`；
 *   - basename 以 `.exe` 结尾（不区分大小写）→ `native`；
 *   - basename 不含 `.`：win32 上是 npm 生成的无后缀 shim（`extensionless`），POSIX 上
 *     就是普通可执行文件（`native`）；
 *   - 其余 → `other`（`.sh`、`.mjs`、带点的普通文件名……）。
 *
 * `platform` 缺省取宿主，调用方测试时显式注入。
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

/**
 * 是否「可直接启动」——**全仓唯一判定**（AC-4），保存侧与发现侧共用。
 *
 * `stat` 是 `statSync` 的结果（注入，便于离线覆盖）；缺失或不是普通文件一律 `false`。
 *
 *   - **win32：只看「是普通文件」，没有后缀门槛**（AC-1）。`.exe` / 无后缀 shim / `.cmd` /
 *     `.ps1` / `.bat` / `.com` 同等对待。"能不能被这份调用方式启动"由运行期提示回答
 *     （`failure-face.mjs` 的未启动类别），不由发现阶段替用户拒收。
 *   - **POSIX：r3 口径零变化**——包装脚本仍 `false`，任一执行位（`mode & 0o111`）打开才算
 *     可执行，`mode` 缺失视为不可判定。
 *
 * 判定不出来就返回 `false`：把"没把握"当"可以执行"，正是误执行包装脚本的入口。
 */
export function isDirectlyExecutable(options = {}) {
  const { path: file, platform = process.platform, stat } = options;
  if (typeof file !== 'string' || file.trim() === '') return false;
  if (stat === null || stat === undefined) return false;
  if (typeof stat.isFile !== 'function' || stat.isFile() !== true) return false;
  const resolvedPlatform = platform ?? process.platform;
  const name = basenameOf(file, resolvedPlatform);
  if (name === '') return false;
  // win32：普通文件即可（不看 mode，也不看后缀）。
  if (isWin32(resolvedPlatform)) return true;
  // POSIX：包装脚本仍不选；执行位必须打开。
  if (wrapperSuffixOf(name) !== null) return false;
  return Number.isInteger(stat.mode) && (stat.mode & 0o111) !== 0;
}
