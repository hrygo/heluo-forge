/**
 * `@heluo/forge-devops` 入口启动自检（r18，用户点击触发）。
 *
 * 为什么需要它：`ready` 只说明"入口已解析到能按本插件方式启动的程序"（r18 语义），
 * 它编码的是**形态与解析**，不是"真跑得起来"。两者之间还剩一层不确定性——被解析出来的原生
 * 程序可能缺依赖、被杀软隔离、架构不匹配。以前这层不确定性要等用户点开业务命令、收到失败信封
 * 才暴露（内网现场）。自检把这一步前移到配置页：用户点一下，就能在保存后立刻知道"能不能启动"。
 *
 * 三条边界，写在实现里而不是留给调用方：
 *   1. **固定 argv**：只跑 `--version`（`dop -v` / `dop --version` 打印 `dop version dop-cli …`
 *      并 exit 0，见 `docs/contracts/dop-cli-spec.md`）。本模块不接受调用方传命令、参数或环境，
 *      因此不存在"用自检当通用命令通道"的路径（`cli-runner` 的 `INVOCATION_KEYS` 同样的理由）。
 *   2. **不经 shell**：交给 `cli-runner` 的 `execFile`，`shell:false`、固定 argv、超时短于业务调用
 *      （8s）：自检只在配置页等待，不该让一次点击挂 20s。
 *   3. **不进装配期**：自检只在用户点击时执行，`apply`、发现、`describe()` 都不会顺手跑它——
 *      装配期跑子进程会让"打开设置页"变成一次不可控的外部执行。
 *
 * 结论是**数据不是异常**：起不来、超时、非零退出都返回结构化报告，由页面按 `reason` 显示。
 *
 * 自检通过说明：这个入口在本机、以本插件的启动方式、跑得起来并说得出自己的版本。
 * 不说明：认证有效、endpoint 可达、权限足够——那三件事仍由运行期归因负责（AC-5）。
 */
import { createCliRunner } from './cli-runner.mjs';

/** 报告契约版本：页面按它判形状，改字段必须递增。 */
export const SELFCHECK_CONTRACT = 1;

/** 固定 argv：只问版本，不触达任何业务命令（不读项目、不写盘、不改远端）。 */
export const SELFCHECK_ARGS = Object.freeze(['--version']);

/** 传给 runner 的 purpose：只用于日志语境，不参与命令构造。 */
export const SELFCHECK_PURPOSE = 'selfcheck';

/** 自检超时：短于业务调用的 20s，因为它挡在配置页的交互前面。 */
export const SELFCHECK_TIMEOUT_MS = 8000;

/** 报告里回显的输出上限：`--version` 只有一行，截断只为兜住异常输出。 */
export const SELFCHECK_OUTPUT_LIMIT = 200;

/** 失败原因码（页面据此换文案，不再解析字符串）。 */
export const SELFCHECK_REASONS = Object.freeze({
  NO_ENTRY: 'no-entry',
  NOT_SPAWNABLE: 'not-spawnable',
  SPAWN_FAILED: 'spawn-failed',
  TIMED_OUT: 'timed-out',
  NONZERO_EXIT: 'nonzero-exit',
  OK: 'ok',
});

/** 报告状态：与 readiness 同一套词，避免页面上出现第二套"成没成"。 */
export const SELFCHECK_STATES = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  NOT_RUN: 'not-run',
});

/** 单行摘要：去掉空行与控制字符，截到 `SELFCHECK_OUTPUT_LIMIT`。 */
function summarize(text) {
  const value = typeof text === 'string' ? text : '';
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return '';
  const clean = firstLine.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return clean.length > SELFCHECK_OUTPUT_LIMIT ? `${clean.slice(0, SELFCHECK_OUTPUT_LIMIT)}…` : clean;
}

/**
 * 构造自检器。`run` 必须来自 `cli-runner`（唯一子进程通道），本模块不 import `child_process`。
 */
export function createSelfCheck({ run, now = Date.now, timeoutMs = SELFCHECK_TIMEOUT_MS } = {}) {
  if (typeof run !== 'function') throw new TypeError('createSelfCheck 需要注入 cli-runner 的 run()');
  if (typeof now !== 'function') throw new TypeError('createSelfCheck 的 now 必须是返回毫秒数的函数');
  const allowedMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : SELFCHECK_TIMEOUT_MS;

  /**
   * 跑一次自检。
   *
   * @param {{bin?: string|null, form?: string|null, spawnable?: boolean}} [entry]
   *   `bin` 是**已解析**的入口（原生程序路径）；`form`/`spawnable` 是解析阶段的结论，
   *   用来在"根本没解析出可启动入口"时直接给出确定性原因，而不是先起个子进程碰运气。
   */
  async function check(entry = {}) {
    const bin = typeof entry?.bin === 'string' ? entry.bin.trim() : '';
    const form = typeof entry?.form === 'string' ? entry.form : null;
    const at = now();
    if (bin === '') {
      return Object.freeze({
        contract: SELFCHECK_CONTRACT,
        at,
        state: SELFCHECK_STATES.NOT_RUN,
        ok: false,
        started: false,
        reason: SELFCHECK_REASONS.NO_ENTRY,
        exitCode: null,
        durationMs: 0,
        argv: SELFCHECK_ARGS.join(' '),
        output: '',
      });
    }
    // 解析阶段已明确"这是包装脚本、起不来"：不必真跑一次再失败（也避免把 shim 交给 execFile）。
    if (entry?.spawnable === false) {
      return Object.freeze({
        contract: SELFCHECK_CONTRACT,
        at,
        state: SELFCHECK_STATES.FAIL,
        ok: false,
        started: false,
        reason: SELFCHECK_REASONS.NOT_SPAWNABLE,
        exitCode: null,
        durationMs: 0,
        argv: SELFCHECK_ARGS.join(' '),
        output: '',
        form,
      });
    }

    const outcome = await run({ bin, args: [...SELFCHECK_ARGS], purpose: SELFCHECK_PURPOSE });
    const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null;
    const timedOut = outcome?.timedOut === true;
    const reason = timedOut
      ? SELFCHECK_REASONS.TIMED_OUT
      : exitCode === null
        ? SELFCHECK_REASONS.SPAWN_FAILED
        : exitCode === 0
          ? SELFCHECK_REASONS.OK
          : SELFCHECK_REASONS.NONZERO_EXIT;
    const ok = reason === SELFCHECK_REASONS.OK;
    return Object.freeze({
      contract: SELFCHECK_CONTRACT,
      at,
      state: ok ? SELFCHECK_STATES.PASS : SELFCHECK_STATES.FAIL,
      ok,
      // 超时也说明它被启动过（只是没在预算内结束）；起不来才是真的没启动。
      started: timedOut || exitCode !== null,
      reason,
      exitCode,
      durationMs: Math.max(0, Math.floor(typeof outcome?.durationMs === 'number' ? outcome.durationMs : 0)),
      argv: SELFCHECK_ARGS.join(' '),
      output: summarize(ok ? outcome?.stdout : outcome?.stderr || outcome?.stdout),
      ...(form === null ? {} : { form }),
    });
  }

  return Object.freeze({ check, timeoutMs: allowedMs, args: [...SELFCHECK_ARGS] });
}

/**
 * 自检器缺省装配：用 `cli-runner`（唯一子进程通道）构造一个短超时执行器。
 * `env` 走 runner 的允许清单——自检不需要任何凭据，因此不额外注入 key。
 */
export function createSelfCheckRunner({ processEnv = null, timeoutMs = SELFCHECK_TIMEOUT_MS } = {}) {
  const runner = createCliRunner({
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : SELFCHECK_TIMEOUT_MS,
    ...(processEnv === null ? {} : { processEnv }),
  });
  return createSelfCheck({ run: runner.run, timeoutMs });
}

/** 脱敏描述：只有状态/原因/耗时/退出码与一行版本，无路径、无 stderr 细节。 */
export function describeSelfCheck(report) {
  const source = report !== null && typeof report === 'object' ? report : {};
  return Object.freeze({
    state: typeof source.state === 'string' ? source.state : SELFCHECK_STATES.NOT_RUN,
    ok: source.ok === true,
    started: source.started === true,
    reason: typeof source.reason === 'string' ? source.reason : SELFCHECK_REASONS.NO_ENTRY,
    exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
    durationMs: typeof source.durationMs === 'number' && Number.isFinite(source.durationMs) ? source.durationMs : 0,
    argv: typeof source.argv === 'string' ? source.argv : SELFCHECK_ARGS.join(' '),
    output: typeof source.output === 'string' ? source.output : '',
    ...(typeof source.form === 'string' ? { form: source.form } : {}),
  });
}
