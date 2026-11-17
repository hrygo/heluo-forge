/**
 * `@heluo/forge-gitee` 的 CLI 入口解析（r18 / T1）：把"配置里的 `cliPath` 到底能不能启动、
 * 启动的是哪一个程序"收成一处。
 *
 * 为什么要这一层：`cliPath` 的保存校验只回答**存不存得下**（不是包装脚本后缀、不是 URL、
 * 没有控制字符），不回答**起不起得来**。企业内网现场常见的情形是：Windows 上 `gh` 只有
 * npm 全局 shim（`<prefix>\gh`、`gh.cmd`、`gh.ps1` 三件套），真正能启动的原生程序在
 * `<prefix>\node_modules\<包>\bin\gh.exe` 这样的包内路径。本插件用 `execFile` 直接启动、
 * **不经 shell**（`shell` 固定为 `false`），裸名 `gh` 在 win32 上解析到 shim 就会起不来，
 * 最终以 `SPAWN_FAILED` 收场；用户改填 `gh.cmd` 又会被保存侧的后缀门槛拒收——"配不对也救不了"。
 *
 * 三个被否决的选项（以及为什么否决）：
 *   1. **把 shim 里的 `run.js` 交给插件**：那个壳只是给 `node` 解释器看的 JS 引导，
 *      `execFile` 不经 shell、不认 `#!/bin/sh` 也不认 `@echo off`，把脚本交给它只会拿到
 *      "不是可执行文件"的失败，而且失败时刻从保存挪到了首次调用。
 *   2. **改成经 shell 启动**：参数会重新交给命令行解释（引号、通配、变量展开），只读白名单、
 *      凭据注入与超时/退出码语义都会跟着变模糊；这不是"让 `gh` 能起来"该付的代价。
 *   3. **在保存侧放行包装脚本**：保存侧的口径是"可执行文件标识"，放行一个起不来的值只是
 *      把失败推迟到运行期（`tests/private-bundle-boundary.test.mjs` 的交叉断言也守着这条）。
 *
 * 所以这里做的事只有一件：沿 shim 的壳文件读出它指向的包内原生程序，把**真正可启动的 bin**
 * 交回装配层。原生优先、只有 shim 时才解析、解析不出来就如实报原因码（枚举来自支撑包）。
 *
 * 纪律：
 *   - 模块级**零 IO、零子进程**：`fs` / `env` / `platform` / `tool` 全由调用方注入，
 *     结论可离线复现（`fs` 至少要 `statSync`，解析 shim 还需要 `readFileSync`）。
 *   - 解析失败**不阻断**装配：调用方保留原值启动、把这里的原因码与指引放进配置面；
 *     解析通道本身缺失或抛错同样只是"这次解析不了"，绝不因此挂载失败。
 */
import { entryFormOf } from './entry-form.mjs';
import { RESOLVE_REASONS, looksLikePathValue, resolveCommandEntry } from './entry-resolve.mjs';

/** 默认工具名：与 `runtime-config.DEFAULT_CLI_PATH` 同源（`gh`）。 */
const DEFAULT_TOOL = 'gh';

/**
 * 解析结论的原因码：支撑包的 `RESOLVE_REASONS` 原样保留，另加三种"解析通道本身"的问题。
 * 只增不改——名字即契约，调用方按枚举分支，不解析文案。
 */
export const ENTRY_REASONS = Object.freeze({
  ...RESOLVE_REASONS,
  /** fs 面没有 `readFileSync`：沿 shim 解析要读壳文件，这次读不了。 */
  NO_SHIM_READER: 'shim-unreadable',
  /** 没有可用的解析通道（缺 `statSync`，或解析整体抛错）。 */
  RESOLVER_UNAVAILABLE: 'resolver-unavailable',
  /** `cliPath` 不是非空字符串。 */
  INVALID: 'invalid-value',
});

/** 给用户看的指引（配置面 `guidance`）：按原因码分组，不拼路径、不带机器相关的信息。 */
const GUIDANCE = Object.freeze({
  [ENTRY_REASONS.INVALID]: '需要一个非空的可执行文件标识（PATH 名或完整路径）',
  [ENTRY_REASONS.NOT_FOUND]: '入口不在 PATH 上：请填写完整路径，或把程序所在目录加入 PATH',
  [ENTRY_REASONS.NOT_SPAWNABLE]: '这个文件没有可执行权限：请给它执行权限，或换一个可执行文件',
  [ENTRY_REASONS.WRAPPER_ENTRY]: '入口是包装脚本：插件直接启动、不经 shell，只能启动真正的程序；请填写包内原生程序的完整路径',
  [ENTRY_REASONS.SHIM_UNRESOLVED]: '入口是脚本壳：插件直接启动、不经 shell，只能启动真正的程序；请填写包内原生程序的完整路径',
  [ENTRY_REASONS.NO_NATIVE]: '包装脚本所在包里找不到原生程序；请填写包内原生程序的完整路径',
  [ENTRY_REASONS.NO_SHIM_READER]: '入口解析不可用：当前按配置值直接启动，若失败请填写原生程序的完整路径',
  [ENTRY_REASONS.RESOLVER_UNAVAILABLE]: '入口解析不可用：当前按配置值直接启动，若失败请填写原生程序的完整路径',
});

/** 其余原因码（读不到 shim / 太大 / 指向包外 / 不是 shim）共用的兜底指引。 */
const FALLBACK_GUIDANCE = '入口解析失败：请填写程序原生可执行文件的完整路径';

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

const unusable = (reason, form) => Object.freeze({ ok: false, reason, form: form ?? null });

/**
 * 解析 `cliPath`：返回**可启动的 bin**与它的入口形态。
 *
 * @param {object} options
 * @param {string|null} options.cliPath 配置里的值（PATH 名或路径）
 * @param {string} [options.platform] 目标平台（默认 `process.platform`）
 * @param {object|null} [options.env] 显式 env（读 `PATH`；不读宿主进程环境）
 * @param {object|null} [options.fs] 注入的只读 fs（`statSync`，必要时 `readFileSync`）
 * @param {string} [options.tool] 工具名（决定 PATH 上的候选名表，默认 `gh`）
 * @returns {{ok:true, bin:string, form:string, resolvedFrom:string|null}
 *   |{ok:false, reason:string, form:string|null}}
 */
export function resolveCliEntry(options = {}) {
  const { cliPath = null, platform = null, env = null, fs = null, tool = DEFAULT_TOOL } = options ?? {};
  const resolvedPlatform = typeof platform === 'string' && platform !== '' ? platform : process.platform;
  const value = textOf(cliPath);
  if (value === '') return unusable(ENTRY_REASONS.INVALID, null);
  const form = entryFormOf(value, resolvedPlatform);

  // 没有 `statSync` 就没有解析通道：这不是"找不到"，而是"这次没法找"。
  if (fs === null || typeof fs !== 'object' || typeof fs.statSync !== 'function') {
    return unusable(ENTRY_REASONS.RESOLVER_UNAVAILABLE, form);
  }

  const toolName = textOf(tool) === '' ? DEFAULT_TOOL : textOf(tool);
  let outcome;
  try {
    outcome = resolveCommandEntry({ tool: toolName, value, platform: resolvedPlatform, env, fs });
  } catch {
    // 解析通道抛错（缺 `readFileSync`、fs 面只实现了一半等）一律降级成"这次解析不了"：
    // 装配期不因此失败，调用方保留原值启动，原因交给配置面。
    const reason = typeof fs.readFileSync === 'function'
      ? ENTRY_REASONS.RESOLVER_UNAVAILABLE
      : ENTRY_REASONS.NO_SHIM_READER;
    return unusable(reason, form);
  }

  if (outcome !== null && typeof outcome === 'object' && outcome.ok === true) {
    const bin = textOf(outcome.path) === '' ? value : outcome.path;
    const from = textOf(outcome.resolvedFrom);
    return Object.freeze({
      ok: true,
      bin,
      form: textOf(outcome.form) === '' ? entryFormOf(bin, resolvedPlatform) : outcome.form,
      // `resolvedFrom` 只在"解析确实换了程序"时出现（例如从 `gh.cmd` 换到包内 `gh.exe`）。
      resolvedFrom: from === '' ? (bin === value ? null : value) : outcome.resolvedFrom,
    });
  }

  const reason = textOf(outcome?.reason) === '' ? RESOLVE_REASONS.NOT_FOUND : outcome.reason;
  const failureForm = textOf(outcome?.form) === '' ? form : outcome.form;
  return unusable(reason, failureForm);
}

/**
 * 装配层唯一需要的判断：**解析成功用原生 bin，解析失败保留原值**。
 *
 * 抽成函数是为了让"什么都不阻断"这件事本身可测（`index.mjs` 的 `buildFaces` 只消费它，
 * 不再自己写一遍三元表达式）：失败时运行期行为与 r18 之前完全一致，归因仍由 `SPAWN_FAILED`
 * 兜底，用户可见的结论在配置快照的 `entries.cliPath.reason` / `guidance` 里。
 *
 * @param {Parameters<typeof resolveCliEntry>[0]} options
 * @returns {{bin:string, entry:ReturnType<typeof resolveCliEntry>}}
 */
export function runtimeBinOf(options = {}) {
  const entry = resolveCliEntry(options);
  return Object.freeze({ bin: entry.ok ? entry.bin : textOf(options?.cliPath), entry });
}

/**
 * 把解析结论折成**配置面**的解析事实（快照 `entries.cliPath` 的新增键）。
 *
 * 故意不改既有 `path` / `value`：那两个键是"用户配了什么"，`bin` 才是"运行时会启动什么"；
 * 页面与 `mergedRuntimeOf` 仍按配置值读，解析结论只作为旁证陪跑。
 *
 * @param {ReturnType<typeof resolveCliEntry>} result 解析结论
 * @param {{cliPath?: string|null, platform?: string|null}} [context] 解析时用的原值
 * @returns {Readonly<object>} 固定形状：`form` / `spawnable` / `bin` / `resolvedFrom` /
 *   `candidates` / `rejected` / `reason` / `guidance`
 */
export function entryFactsOf(result, context = {}) {
  const { cliPath = null, platform = null } = context ?? {};
  const resolvedPlatform = typeof platform === 'string' && platform !== '' ? platform : process.platform;
  const value = textOf(cliPath) === '' ? null : textOf(cliPath);

  if (result !== null && typeof result === 'object' && result.ok === true) {
    const from = textOf(result.resolvedFrom) === '' ? null : result.resolvedFrom;
    return Object.freeze({
      form: result.form,
      spawnable: true,
      bin: result.bin,
      resolvedFrom: from,
      candidates: Object.freeze([Object.freeze({ path: result.bin, form: result.form, resolvedFrom: from })]),
      rejected: Object.freeze([]),
      reason: null,
      guidance: null,
    });
  }

  const reason = textOf(result?.reason) === '' ? ENTRY_REASONS.INVALID : result.reason;
  const form = textOf(result?.form) === '' ? (value === null ? null : entryFormOf(value, resolvedPlatform)) : result.form;
  return Object.freeze({
    form,
    spawnable: false,
    bin: null,
    resolvedFrom: null,
    candidates: Object.freeze([]),
    // `rejected` 说的是"这条配置值被拒收、没有交给运行时"：只有像路径的值才列得出来，
    // 裸名（`gh`）在 PATH 上没找到时没有具体文件可说，原因码已经足够。
    rejected: value !== null && looksLikePathValue(value, resolvedPlatform)
      ? Object.freeze([Object.freeze({ path: value, why: reason, form })])
      : Object.freeze([]),
    reason,
    guidance: GUIDANCE[reason] ?? FALLBACK_GUIDANCE,
  });
}
