/**
 * `@heluo/forge-devops` 失败面的**唯一渲染点**（T1(r9)，AC-1 / AC-2 / AC-3 / AC-5）。
 *
 * 这个模块只回答一个问题：**命令没跑通的时候，用户到底看到哪句话。** 判定、分类、文案、
 * 脱敏、三种出口的形状全部在这里，适配器与动作层只负责"这次调用失败了吗"，不再各拼一份
 * 提示（r8 时 dop 适配器 `:164-176` 与 gh 适配器 `:421-436` 是同一段判定的两份复制，
 * 改一处文案要记得改两处——那正是本次收敛的原因）。
 *
 * 三条结构性纪律（不是靠正则兜底，而是靠**形状**保证）：
 *   1. **未启动不读证据**：`exitCode === null`（子进程根本没起来）时，判定只用
 *      `{ bin, platform }`——入口形态即结论。`stderr/stdout` 压根不进这个分支，
 *      所以 AC-2 的六种注入（EINVAL / ENOENT / EACCES / 相对路径 / 绝对路径与 UNC /
 *      URI endpoint）**结构上**不可能泄进出口。
 *   2. **判定不依赖 errno**：`.cmd` 常见 `EINVAL`、npm 无后缀 shim 常见 `ENOENT`，
 *      原因相同（固定 argv + `shell:false` 起不了脚本）；按 errno 分支会让同一类故障
 *      时好时坏。
 *   3. **只读文本，不生成文本以外的动作**：不重试、不重放，写动作未启动仍记 `failed`
 *      （确定没写出去），文案里也不出现"重试"字样。
 *
 * 产物契约（蓝图 §T1，逐字）：
 *   SPAWN_FAILURE_REASON / SPAWN_CATEGORIES
 *   spawnFailureFace({ bin, platform }) -> { reason, category, message, next }
 *   failureFaceOf({ command, bin, platform, exitCode, evidence, observedAt, mayHaveSideEffect })
 *     -> { code, message, detail }
 *   redactFailureText(text) -> string
 *   failureMessageOf(error) -> string
 *   toolFailureOf(action, error) -> { ok:false, action, reason, next_action, detail }
 *   writeFailureOf(error, what) -> { status, reason, category, next, detail } | null
 *
 * 出口只读这五个字段：`reason`（固定枚举）、`category`、`next`（恒为页面指引）、
 * `message`（一句人话）、`detail`（结构化面）。**不含** 路径、endpoint、errno、退出码、
 * 原始 Node 报错片段——整段贴进工单也不会带出本机目录结构（AC-2）。
 */

import { CLI_PAGE_HINT } from './cli-config.mjs';
import { ENTRY_FORMS, entryFormOf, wrapperSuffixOf } from './entry-form.mjs';

/**
 * 未启动的固定原因码（读信封 `detail.reason` 与写动作 `reason` 共用）。
 *
 * 只作**细因**：读信封的 `error_code` 仍是 `COMMAND_FAILED`（词表不加码，见 TECHNICAL §3.4），
 * 页面按错误码展示，工具侧按 `detail.reason` 给出更具体的"没启动"。
 */
export const SPAWN_FAILURE_REASON = 'CLI_SPAWN_FAILED';

/**
 * 失败类别（对外可见）。三类措辞互斥、互不套用：`.exe` 原生入口**绝不**套用包装脚本解释。
 */
export const SPAWN_CATEGORIES = Object.freeze({
  WRAPPER_SCRIPT: 'WRAPPER_SCRIPT',
  EXTENSIONLESS_SHIM: 'EXTENSIONLESS_SHIM',
  NATIVE_ENTRY: 'NATIVE_ENTRY',
});

/**
 * 非 spawn 失败（超时、非零退出、解析失败）在信封里仍用这个原因码。
 *
 * 与 `read.mjs` 的 `READ_REASONS.COMMAND_FAILED` 同字面量。这里写字面量而**不 import**
 * `read.mjs`：`read.mjs` 反过来要用本模块的 `failureMessageOf` 收口信封 message，
 * 互相 import 会形成环——本模块是叶子，只依赖 `entry-form`（形态）与 `cli-config`（指引）。
 * 两份字面量的一致性由 `test/failure-face.test.mjs` 的等值断言守住。
 */
export const FAILURE_CODE = 'COMMAND_FAILED';

/** 失败行的字符上限：能贴进工具输出，也不至于糊屏（与 r8 同一量级）。 */
const MAX_TEXT_LENGTH = 200;

const REDACTED_PATH = '<路径>';
const REDACTED_URI = '<地址>';
const REDACTED_CODE = '<错误码>';

/** 带协议写法（`scheme://…`）：endpoint 换成人话，不进提示。 */
const URI_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/** 绝对路径开头：盘符（`C:\`/`C:/`）、UNC（`\\server`）、POSIX（`/usr/bin`）。 */
const ABSOLUTE_PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\\\\)|^\//u;

/** 路径可能带空格（`C:\Program Files\…`）：带分隔符的词元一律按路径处理（宁可多脱敏）。 */
const HAS_SEPARATOR = /[\\/]/u;

/**
 * errno 形态：`E` + 两个以上大写字母（`ENOENT` / `EINVAL` / `EACCES`），
 * 或 `ERR_` 前缀的全大写词元（`ERR_INVALID_ARG_TYPE`）。
 *
 * 项目自身的固定枚举（`COMMAND_FAILED`、`NO_READER`、`CLI_SPAWN_FAILED`、`WRAPPER_SCRIPT`…）
 * 都不以 `E` 开头，因此**不会**被这条规则吃掉——白名单即这些值。
 */
const ERRNO_LIKE = /^(?:E[A-Z]{2,}|ERR_[A-Z0-9_]+)$/u;

/** 行首的原始前缀：`spawn ` / `Error: spawn ` 是 Node 的措辞，不是原因。 */
const SPAWN_PREFIX = /^(?:Error:\s*)?spawn\s+/u;

/** 错误消息自带的 `<CODE>: ` 前缀：原因码已经在 `reason` 字段里，不必重复。 */
const CODE_PREFIX = /^[A-Z][A-Z0-9_]*:\s*/u;

/** 词元前的开括号/引号：`(C:\tools\dop)`、`"C:\tools\dop"` 同样要认成路径。 */
const OPENERS = /^[("'`[（《<]+/u;

/** 词元后的标点：判定时去掉，保留原词元参与输出。 */
const TRAILING = /[)"'`\]）》。,，;；:：]+$/u;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

function clip(value, limit = MAX_TEXT_LENGTH) {
  const raw = typeof value === 'string' ? value : '';
  return raw.length <= limit ? raw : `${raw.slice(0, Math.max(0, limit - 1))}…`;
}

/** 三类类别的文案（唯一出处）。`.exe` 与"认不出的形态"都走 `NATIVE_ENTRY`，不臆断成包装脚本。 */
function wrapperMessage(suffix) {
  const head = suffix === null ? '入口是包装脚本' : `入口是 ${suffix} 包装脚本`;
  return `${head}，固定 argv 且未经 shell 无法启动脚本 · 请到「${CLI_PAGE_HINT}」指向该 CLI 的原生可执行文件`;
}

function shimMessage() {
  return `入口是 npm 生成的无后缀 shim，固定 argv 且未经 shell 无法启动脚本 · 请到「${CLI_PAGE_HINT}」指向该 CLI 的原生可执行文件`;
}

function nativeMessage() {
  return `入口未能启动（系统拒绝执行或文件不可用）· 请到「${CLI_PAGE_HINT}」重新选择可执行文件`;
}

/** 类别 → 文案。`suffix` 只在包装脚本类别里有意义（回显实际命中的后缀）。 */
function messageOfCategory(category, suffix = null) {
  if (category === SPAWN_CATEGORIES.WRAPPER_SCRIPT) return wrapperMessage(suffix);
  if (category === SPAWN_CATEGORIES.EXTENSIONLESS_SHIM) return shimMessage();
  return nativeMessage();
}

/** 把一个 detail（可能来自注入桩）收敛成已登记类别：认不出就按原生入口说人话，不猜。 */
function categoryOf(detail) {
  const value = text(detail.category);
  return Object.values(SPAWN_CATEGORIES).includes(value) ? value : SPAWN_CATEGORIES.NATIVE_ENTRY;
}

/**
 * 入口形态 → 失败类别（AC-3）。
 *
 * `EXTENSIONLESS` 只在 win32 上是 npm 生成的替身；POSIX 上无后缀就是原生可执行文件，
 * 由 `entryFormOf` 已经判成 `NATIVE`。`OTHER`（`.sh`/`.mjs` 等）不替用户臆断，
 * 也归入原生入口措辞——它同样"没启动"，下一步都是重新选可执行文件。
 */
function categoryOfEntry({ bin, platform }) {
  const form = entryFormOf(bin, platform);
  if (form === ENTRY_FORMS.WRAPPER) return SPAWN_CATEGORIES.WRAPPER_SCRIPT;
  if (form === ENTRY_FORMS.EXTENSIONLESS) return SPAWN_CATEGORIES.EXTENSIONLESS_SHIM;
  return SPAWN_CATEGORIES.NATIVE_ENTRY;
}

/** 包装脚本类别里回显的后缀（`.cmd` / `.ps1`…）；取不到就退化成"脚本"这层措辞。 */
function suffixOf(bin, platform) {
  const form = entryFormOf(bin, platform);
  if (form !== ENTRY_FORMS.WRAPPER) return null;
  return wrapperSuffixOf(typeof bin === 'string' ? bin : '') ?? null;
}

/**
 * 未启动的失败面（AC-1 / AC-3）：**只吃入口形态，不吃证据行**。
 *
 * 返回值四个字段都在出口可见：`reason` 固定枚举、`category` 三类、`message` 一句人话、
 * `next` 恒为页面指引（与 NO_READER 的 guidance 同源，AC-1 要求"同源同句式"）。
 */
export function spawnFailureFace({ bin = '', platform = process.platform } = {}) {
  const resolvedPlatform = platform ?? process.platform;
  const category = categoryOfEntry({ bin, platform: resolvedPlatform });
  return Object.freeze({
    reason: SPAWN_FAILURE_REASON,
    category,
    message: clip(messageOfCategory(category, suffixOf(bin, resolvedPlatform))),
    next: CLI_PAGE_HINT,
  });
}

/**
 * 证据行脱敏（AC-2）：路径 / UNC / endpoint / errno / `spawn ` 前缀一律换占位符。
 *
 * 这是**唯一**的脱敏实现：适配器给非 spawn 失败组装证据行、读信封收口 message、动作层
 * 拼 detail 都走这里。`relativePaths` 为 false 时只处理绝对路径与 URI——读信封的整句里
 * 有命令标签与 target（`acme/ard-sdk#12` 这类），把相对路径规则套上去会把 target 也抹掉。
 */
function redactTokens(value, { relativePaths }) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(SPAWN_PREFIX, '');
  if (trimmed === '') return '';
  const kept = [];
  const push = (token) => {
    // 连续占位符合成一个，避免 `<路径> <路径> <路径>` 这种噪声。
    if (token === REDACTED_PATH && kept[kept.length - 1] === REDACTED_PATH) return;
    kept.push(token);
  };
  for (const token of trimmed.split(/\s+/u)) {
    if (URI_LIKE.test(token.replace(OPENERS, ''))) {
      push(REDACTED_URI);
      continue;
    }
    if (ABSOLUTE_PATH_LIKE.test(token.replace(OPENERS, ''))) {
      push(REDACTED_PATH);
      continue;
    }
    if (ERRNO_LIKE.test(token.replace(TRAILING, ''))) {
      push(REDACTED_CODE);
      continue;
    }
    if (relativePaths && HAS_SEPARATOR.test(token)) {
      push(REDACTED_PATH);
      continue;
    }
    push(token);
  }
  return clip(kept.join(' '));
}

/**
 * 失败证据行的脱敏出口（AC-2 / AC-5）。非字符串返回空串——调用方据此改用兜底文案，
 * 而不是把 `undefined` 印到提示里。
 */
export function redactFailureText(value) {
  return redactTokens(value, { relativePaths: true });
}

/**
 * 读信封 `message` 的收口（AC-1 / AC-5）：去掉 `<CODE>: ` 前缀，并**保证脱敏**。
 *
 * 两条分支：
 *   - **未启动**：完全不读 `error.message`，由 `detail.category` 重建整句。适配器给的
 *     message 本来就干净，但注入桩/第三方适配器可能把原始报错塞进 message——重建之后
 *     出口与来源无关，AC-2 才是"结构性"而不是"约定性"的。
 *   - **其它失败**：`<命令> 失败（退出码 N）：<证据>` 只在最后一个 `：` 之后脱敏；
 *     前半段是命令标签与 target，逐字保留（target 原样是既有用例的契约）。
 */
export function failureMessageOf(error) {
  const detail = asObject(error?.detail);
  if (detail.spawnFailed === true) {
    const category = categoryOf(detail);
    const face = messageOfCategory(category, text(detail.suffix) || null);
    const command = text(detail.command);
    return clip(command === '' ? `未启动：${face}` : `${command} 未启动：${face}`);
  }
  const raw = text(error?.message);
  if (raw === '') return '';
  const stripped = raw.replace(CODE_PREFIX, '');
  const separator = stripped.lastIndexOf('：');
  if (separator >= 0) {
    return clip(`${stripped.slice(0, separator + 1)}${redactTokens(stripped.slice(separator + 1), { relativePaths: true })}`);
  }
  // 没有证据段：只收掉绝对路径 / URI / errno，不动 target 与命令标签里的 `a/b` 片段。
  return clip(redactTokens(stripped, { relativePaths: false }));
}

/**
 * 适配器唯一入口（AC-1）：spawn 失败给"类别 + 下一步"，其余失败给脱敏后的证据行。
 *
 * `exitCode` 为 `null`/`undefined` 即未启动（`cli-runner` 的约定：只有这两种才代表没起来）；
 * `evidence` 只在非 spawn 分支被读取——这是 AC-2 六注入零命中的结构性保证。
 */
export function failureFaceOf({
  command = '',
  bin = '',
  platform = process.platform,
  exitCode = null,
  evidence = '',
  observedAt = null,
  mayHaveSideEffect = false,
} = {}) {
  const label = text(command);
  const at = typeof observedAt === 'string' && observedAt !== '' ? observedAt : null;
  if (!Number.isInteger(exitCode)) {
    const face = spawnFailureFace({ bin, platform });
    const suffix = suffixOf(bin, platform ?? process.platform);
    const detail = {
      reason: face.reason,
      category: face.category,
      next: face.next,
      command: label,
      observedAt: at,
      spawnFailed: true,
    };
    if (suffix !== null) detail.suffix = suffix;
    if (mayHaveSideEffect === true) detail.mayHaveSideEffect = true;
    return { code: FAILURE_CODE, message: clip(label === '' ? `未启动：${face.message}` : `${label} 未启动：${face.message}`), detail };
  }
  const line = redactFailureText(evidence) || '无输出';
  const detail = { command: label, observedAt: at, exitCode, spawnFailed: false };
  if (mayHaveSideEffect === true) detail.mayHaveSideEffect = true;
  return {
    code: FAILURE_CODE,
    message: clip(`${label} 失败（退出码 ${exitCode}）：${line}`),
    detail,
  };
}

/**
 * 工具信封的失败体（AC-1 第一出口）。
 *
 * `next_action` 恒为 `configure-reader`（去重新选入口），`detail` 是**对象**而不是字符串——
 * 工具出口是三处里唯一能让模型直接看到结构化字段的地方。其余失败仍由 `tools.mjs`
 * 的 `failure()` 出字符串 detail（report/卡片按字符串读，不能混）。
 */
export function toolFailureOf(action, error) {
  const detail = asObject(error?.detail);
  return {
    ok: false,
    action,
    reason: typeof error?.code === 'string' && error.code !== '' ? error.code : FAILURE_CODE,
    next_action: 'configure-reader',
    detail: {
      reason: SPAWN_FAILURE_REASON,
      category: categoryOf(detail),
      next: text(detail.next) || CLI_PAGE_HINT,
      command: text(detail.command),
      observedAt: typeof detail.observedAt === 'string' ? detail.observedAt : null,
    },
  };
}

/**
 * 写动作结果的失败片段（AC-1 第二出口）。
 *
 * 只有**确定没启动**才返回 `failed`：spawn 失败意味着命令根本没跑，写动作没有副作用，
 * 记 `unknown` 会让人去核对一件没发生的事。其余失败返回 `null`，交回 `actions.mjs`
 * 既有的"超时/结果不确定 → unknown，转人工核对，不自动重放"分支（四状态语义不改）。
 */
export function writeFailureOf(error, what = '') {
  const detail = asObject(error?.detail);
  if (detail.spawnFailed !== true) return null;
  const category = categoryOf(detail);
  const next = text(detail.next) || CLI_PAGE_HINT;
  const label = text(what);
  return {
    status: 'failed',
    reason: SPAWN_FAILURE_REASON,
    category,
    next,
    detail: `${label}命令未启动（无副作用）：${messageOfCategory(category, text(detail.suffix) || null)} · 下一步：${next}`,
  };
}
