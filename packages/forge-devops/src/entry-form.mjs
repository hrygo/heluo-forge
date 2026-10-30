/**
 * `@heluo/forge-devops` 入口形态单点模块（T1(r8)，AC-2 / AC-4 / AC-5）。
 *
 * 这个模块回答一个问题：**一个入口到底长什么形态，它能不能被「固定 argv + 不带 shell」
 * 的调用方式直接启动。**
 *
 * 为什么单独成模块：r3 把同一条规则写在了三处（保存侧 `cli-config` 的后缀门槛、发现侧
 * `cli-discovery` 的 `isDirectlyExecutable`、页面 `client.js` 的 `WRAPPER_PATTERN`），只能
 * 靠交付自检的文本扫描防漂移。r8 把「保存放行」一放开，三份副本就会各说各话——于是规则
 * 收敛到这里，**本模块是仓库里唯一持有后缀词表与形态判定的地方**，其余模块全部是消费者：
 *   - 保存侧（`cli-config.mjs`）：末审调 `isDirectlyExecutable`，不再自带后缀表；
 *   - 发现侧（`cli-discovery.mjs`）：再导出同一批符号，候选名表用它排序；
 *   - 运行期（`dop-adapter.mjs` / `gh-adapter.mjs`）：未启动时用 `describeSpawnFailure` 归因。
 *
 * 纪律（静态用例守这三条，见 `test/entry-form.test.mjs`）：
 *   1. **纯函数、零 IO**：不读盘、不读环境、不看时钟；`stat` 由调用方注入。
 *   2. **零子进程**：不引入任何进程通道，连"试跑一下看看"的能力都不提供。
 *   3. **唯一依赖 `node:path`**（只用 `basename`，且按目标平台选 `win32`/`posix` 实现，
 *      否则 POSIX 主机上测不了 Windows 路径）。
 *
 * 产物契约（蓝图 §3.1，逐字）：
 *   WRAPPER_SUFFIXES / ENTRY_FORMS
 *   wrapperSuffixOf(name) -> string | null
 *   entryFormOf(file, platform) -> 'native' | 'wrapper' | 'extensionless' | 'other'
 *   isDirectlyExecutable({ path, platform, stat }) -> boolean
 *   describeSpawnFailure({ bin, platform, evidence }) -> string
 *   redactPathLike(text) -> string
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
 * 四种入口形态。用常量对象而不是裸字符串，是为了让消费者（尤其是运行期归因）不能靠
 * 手写拼写命中，改词表时编译器/用例会替我们发现漏改点。
 */
export const ENTRY_FORMS = Object.freeze({
  NATIVE: 'native',
  WRAPPER: 'wrapper',
  EXTENSIONLESS: 'extensionless',
  OTHER: 'other',
});

/** 提示行上限（AC-5：可行动、不糊屏）。与适配器诊断行同一量级，超出截断。 */
const MAX_PROMPT_LENGTH = 200;

/** 路径脱敏后的占位符。 */
const REDACTED_PATH = '<路径>';

/** endpoint 脱敏后的占位符（AC-5 ④：提示里不得出现 endpoint 实值）。 */
const REDACTED_URI = '<地址>';

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

function clip(value, limit = MAX_PROMPT_LENGTH) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
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
 *     （`describeSpawnFailure`），不由发现阶段替用户拒收。
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

/** 形如 `ENOENT` / `EINVAL` 的 errno 片段：脱敏时要留住它，否则用户失去唯一线索。 */
const ERRNO_LIKE = /^[A-Z][A-Z0-9_]{2,}$/u;

/** 带协议的写法（`scheme://…`）：提示里换成人话，不暴露 endpoint。 */
const URI_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/** 绝对路径开头：盘符（`C:\`、`C:/`）、UNC（`\\server`）、POSIX（`/usr/bin`）。 */
const ABSOLUTE_PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\\\\)|^\//u;

/** 路径里可能带空格（`C:\Program Files\…`）：判断"下一片是否仍属同一条路径"。 */
const HAS_SEPARATOR = /[\\/]/u;

function looksLikePath(token) {
  // 容忍被括号/引号/中文标点包住的路径，如 `(C:\tools\dop.exe)`、`"C:\tools\dop.exe"`。
  const bare = token.replace(/^[("'`[（《<]+/u, '');
  return ABSOLUTE_PATH_LIKE.test(bare);
}

/**
 * 脱敏：把盘符 / UNC / POSIX 绝对路径 / endpoint 换成占位符，并截断到 200 字符
 * （AC-5 ④）。非字符串返回空串——调用方据此改用兜底文案。
 *
 * 判定是**词元级 + 续片**的：`spawn C:\Program Files\nodejs\dop.exe ENOENT` 里路径被空格
 * 切成几片，只要下一片还带分隔符就继续吞掉；errno 这类全大写片段保留，用户仍能看到
 * 失败原因。这条规则不追求还原真实命令行语法，只保证**不把机器路径泄进 message**。
 */
export function redactPathLike(text) {
  if (typeof text !== 'string') return '';
  const tokens = text.trim().split(/\s+/u).filter((token) => token !== '');
  const kept = [];
  let insidePath = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (URI_LIKE.test(token)) {
      if (kept[kept.length - 1] !== REDACTED_URI) kept.push(REDACTED_URI);
      insidePath = false;
      continue;
    }
    if (looksLikePath(token)) {
      if (kept[kept.length - 1] !== REDACTED_PATH) kept.push(REDACTED_PATH);
      insidePath = true;
      continue;
    }
    const continues =
      insidePath &&
      !ERRNO_LIKE.test(token) &&
      (HAS_SEPARATOR.test(token) || HAS_SEPARATOR.test(tokens[index + 1] ?? ''));
    if (continues) continue;
    insidePath = false;
    kept.push(token);
  }
  return clip(kept.join(' '));
}

/**
 * 子进程**未启动**（`exitCode === null`）时的可读归因（AC-5）。
 *
 * 判定只看形态，**不看 errno**：`.cmd` 通常是 `EINVAL`，npm 生成的无后缀 shim 通常是
 * `ENOENT`，两者原因相同——固定 argv + 未经 shell 启动不了脚本。文案三段：
 *   ① 入口形态判断（包装脚本 / 无扩展名 shim）；
 *   ② 原因归属运行时能力（启动方式的限制，与路径写法无关）；
 *   ③ 下一步（改指原生可执行文件，或换提供原生二进制的安装方式）。
 * 不含路径、不含 endpoint，也不含"重试"字样（写动作语义不变：未启动记 `failed` 且不重放）。
 *
 * 原生入口（`.exe` 等）失败**绝不**套用包装脚本解释：回退到脱敏后的证据行，问什么答什么。
 */
export function describeSpawnFailure({ bin, platform = process.platform, evidence } = {}) {
  const resolvedPlatform = platform ?? process.platform;
  const form = entryFormOf(bin, resolvedPlatform);
  if (form === ENTRY_FORMS.WRAPPER) {
    const suffix = wrapperSuffixOf(basenameOf(bin, resolvedPlatform)) ?? '脚本';
    return clip(
      `入口是 ${suffix} 包装脚本，固定 argv 且未经 shell 启动时无法运行——` +
        '这是启动方式的限制，与路径写法无关；请把配置改为该 CLI 的原生可执行文件，' +
        '或改用提供原生二进制的安装方式',
    );
  }
  if (isWin32(resolvedPlatform) && form === ENTRY_FORMS.EXTENSIONLESS) {
    return clip(
      '入口是没有扩展名的命令 shim（npm 在 Windows 上生成的替身，也可能是 Git Bash 版），' +
        '固定 argv 且未经 shell 启动时无法运行——这是启动方式的限制，与路径写法无关；' +
        '请把配置改为该 CLI 的原生可执行文件，或改用提供原生二进制的安装方式',
    );
  }
  const line = redactPathLike(evidence);
  return line === '' ? '进程未能启动' : line;
}
