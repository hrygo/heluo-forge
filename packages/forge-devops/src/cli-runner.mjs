/**
 * 唯一子进程出口（T1，§5.5）。
 *
 * 整个 `@heluo/forge-devops` 里，只有这里碰进程。三条纪律写死在实现里，而不是靠约定：
 *   1. **只有 `execFile`**：程序名与参数分开传，`shell: false`，不存在 heredoc / 管道 /
 *      变量展开这类拼串通道；`sh -c`、同步 exec 一律不出现。
 *   2. **只有 `{bin, args, purpose}` 一种入参**：多余字段直接拒绝，所以没有
 *      "把整条命令当字符串传进来" 的通用逃生口。`bin` 只由适配器从运行时配置取
 *      （dop / gh 两个），不接受模型输入。
 *   3. **有界**：`timeout` 到点杀进程，`maxBuffer` 限制单流字节数；截断与超时都在
 *      返回值里显式可见，不静默当成正常输出。
 *
 * 出厂契约：
 *   createCliRunner({ execFile, env, timeoutMs, maxOutputBytes }) -> { run(args) }
 *   run({ bin, args, purpose })
 *     -> Promise<{ exitCode: number | null, stdout: string, stderr: string,
 *                  durationMs: number, timedOut: boolean, truncated: boolean }>
 *
 * `execFile` 可注入（离线测试用假实现，绝不 spawn 真实 CLI）；不注入时用
 * `node:child_process` 的同名实现，装配层无需额外代码。`env` 是叠加在
 * `process.env` 之上的**覆盖项**，用于给子进程注入非机密开关。
 *
 * **不抛异常**：命令失败是数据不是异常——它们表现为 `exitCode !== 0`、`timedOut` 或
 * `exitCode === null`（起不来），由适配器映射成 `unknown`/`failed`。只有「调用方代码写错」
 * （缺 `bin`、`args` 不是字符串数组、多余字段）才抛 `TypeError`。
 */

import { execFile as nodeExecFile } from 'node:child_process';

import { DEFAULT_TIMEOUT_MS } from './runtime-config.mjs';

/** 单流默认上限 1 MiB：足够装下 `gh`/`dop` 的列表输出，又不至于把上下文塞满。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** 允许的入参字段。白名单而非"忽略额外字段"：未知字段意味着有人在试通用命令通道。 */
export const INVOCATION_KEYS = Object.freeze(['bin', 'args', 'purpose']);

/**
 * 子进程环境变量白名单（CORP-DSH-DESIGN-018 §5 / ADR-0011）。
 * 默认剥离宿主环境中的 `DEEPSEEK_API_KEY`、`GITEE_TOKEN` 等无关敏感变量，
 * 只透传子进程运行所需的系统基本变量与 DevOps 自身凭证键 `DEVOPS_API_KEY`。
 */
export const ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  'PWD',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'NO_COLOR',
  'CLICOLOR',
  'CI',
  'DEVOPS_API_KEY',
]);

export function pickAllowlistedEnv(sourceEnv = process.env, allowlist = ENV_ALLOWLIST) {
  if (sourceEnv === null || sourceEnv === undefined || typeof sourceEnv !== 'object') {
    return {};
  }
  const picked = {};
  for (const key of allowlist) {
    const value = sourceEnv[key];
    if (typeof value === 'string') {
      picked[key] = value;
    }
  }
  return picked;
}

function assertOptions({ execFile, timeoutMs, maxOutputBytes, resolveChildEnv }) {
  if (typeof execFile !== 'function') {
    throw new TypeError('createCliRunner 需要可注入的 execFile（唯一子进程出口）');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs 必须是正整数，收到 ${String(timeoutMs)}`);
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError(`maxOutputBytes 必须是正整数，收到 ${String(maxOutputBytes)}`);
  }
  if (resolveChildEnv !== undefined && resolveChildEnv !== null && typeof resolveChildEnv !== 'function') {
    throw new TypeError('resolveChildEnv 必须是函数或未提供');
  }
}

function normalizeEnv(env) {
  if (env === null || env === undefined) return {};
  if (typeof env !== 'object') throw new TypeError('env 必须是对象（子进程环境覆盖项）');
  const overrides = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new TypeError(`env.${key} 必须是字符串`);
    overrides[key] = value;
  }
  return overrides;
}

/**
 * 校验调用形状：只认 `{bin, args, purpose}`，且 `args` 必须是干净的字符串数组。
 * NUL 会被内核截断参数，属于危险输入，直接拒绝。
 */
function normalizeInvocation(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('run() 需要 { bin, args, purpose }');
  }
  const extra = Object.keys(input).filter((key) => !INVOCATION_KEYS.includes(key));
  if (extra.length > 0) {
    throw new TypeError(
      `run() 不接受字段 ${extra.join(', ')}：只允许 bin/args/purpose，没有通用命令通道`,
    );
  }

  const { bin, args = [], purpose } = input;
  if (typeof bin !== 'string' || bin.trim().length === 0) {
    throw new TypeError('run().bin 必须是非空可执行标识（PATH 名或环境注入的绝对路径）');
  }
  if (!Array.isArray(args)) {
    throw new TypeError('run().args 必须是字符串数组（程序名与参数分开传，不拼串）');
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new TypeError(`run().args 只接受字符串，收到 ${typeof arg}`);
    }
    if (arg.includes('\0')) {
      throw new TypeError('run().args 不允许包含 NUL 字符');
    }
  }
  if (purpose !== undefined && typeof purpose !== 'string') {
    throw new TypeError('run().purpose 必须是字符串（仅用于诊断，可省略）');
  }

  return { bin, args: [...args], purpose: purpose ?? '' };
}

/**
 * 截断到上限，并如实报告是否截断过——静默截断会让下游把半截 JSON 当成格式错误。
 */
function capText(value, limit) {
  const text = typeof value === 'string'
    ? value
    : (value === null || value === undefined ? '' : String(value));
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  return { text: Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8'), truncated: true };
}

/**
 * 同时兼容两种注入形态：
 *   - 回调式（Node `execFile` 的原生形状，生产默认）
 *   - Promise 式（测试里写 `async (bin, args, options) => ({...})` 更顺手）
 * 谁先给出结果用谁，另一个不会覆盖。
 */
function invoke(execFile, bin, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let returned;
    try {
      returned = execFile(bin, args, options, (error, stdout, stderr) => {
        settle({ error: error ?? null, stdout, stderr });
      });
    } catch (error) {
      settle({ error, stdout: '', stderr: '' });
      return;
    }

    if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
      returned.then(
        (result) => settle({ error: null, promiseResult: result }),
        (error) => settle({ error, stdout: '', stderr: '' }),
      );
    }
  });
}

/** 超时在 Node 侧的三种表现（ETIMEDOUT / killed+signal / 假实现显式标记）统一成一个布尔位。 */
function isTimedOut(error) {
  if (error === null || error === undefined) return false;
  if (error.timedOut === true) return true;
  if (error.code === 'ETIMEDOUT') return true;
  const killedBySignal = error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL';
  const noExitCode = error.code === null || error.code === undefined;
  return killedBySignal && noExitCode;
}

function exitCodeOf(error) {
  if (error === null || error === undefined) return 0;
  if (typeof error.exitCode === 'number') return error.exitCode;
  if (typeof error.code === 'number') return error.code;
  return null;
}

function fromPromiseResult(result, limit) {
  if (typeof result === 'string') {
    const out = capText(result, limit);
    return { exitCode: 0, stdout: out.text, stderr: '', timedOut: false, truncated: out.truncated };
  }
  const record = result !== null && typeof result === 'object' ? result : {};
  const out = capText(record.stdout, limit);
  const err = capText(record.stderr, limit);
  const exitCode = typeof record.exitCode === 'number'
    ? record.exitCode
    : (typeof record.code === 'number' ? record.code : (record.timedOut === true ? null : 0));
  return {
    exitCode,
    stdout: out.text,
    stderr: err.text,
    timedOut: record.timedOut === true,
    truncated: out.truncated || err.truncated,
  };
}

/**
 * 装配一个 runner。
 *
 * @param {object} [options]
 * @param {Function} [options.execFile] 注入点；默认 `node:child_process.execFile`
 * @param {Record<string, string | undefined>} [options.env] 子进程环境覆盖项
 * @param {Record<string, string | undefined>} [options.processEnv] 宿主进程环境（默认 `process.env`），按 `ENV_ALLOWLIST` 过滤
 * @param {Function} [options.resolveChildEnv] 可选的按次环境解析钩子（如宿主托管凭证注入；返回 `{ ok: false }` 时 fail closed 且零 spawn）
 * @param {number} [options.timeoutMs] 单次调用上限
 * @param {number} [options.maxOutputBytes] 单流输出上限
 */
export function createCliRunner({
  execFile = nodeExecFile,
  env,
  processEnv = process.env,
  resolveChildEnv = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  assertOptions({ execFile, timeoutMs, maxOutputBytes, resolveChildEnv });
  const staticOverrides = normalizeEnv(env);

  /**
   * @param {{bin: string, args?: string[], purpose?: string}} invocation
   */
  async function run(invocation) {
    const { bin, args } = normalizeInvocation(invocation);
    const childEnv = { ...pickAllowlistedEnv(processEnv), ...staticOverrides };

    if (typeof resolveChildEnv === 'function') {
      let resolved;
      try {
        resolved = await resolveChildEnv();
      } catch (err) {
        return {
          exitCode: null,
          stdout: '',
          stderr: typeof err?.message === 'string' && err.message.length > 0 ? err.message : 'CREDENTIAL_UNAVAILABLE',
          durationMs: 0,
          timedOut: false,
          truncated: false,
        };
      }
      if (resolved !== null && typeof resolved === 'object' && resolved.ok === false) {
        const reason = typeof resolved.message === 'string' && resolved.message.length > 0
          ? resolved.message
          : typeof resolved.code === 'string' && resolved.code.length > 0
            ? resolved.code
            : 'CREDENTIAL_UNAVAILABLE';
        return {
          exitCode: null,
          stdout: '',
          stderr: reason,
          durationMs: 0,
          timedOut: false,
          truncated: false,
        };
      }
      if (resolved !== null && typeof resolved === 'object') {
        Object.assign(childEnv, pickAllowlistedEnv(resolved));
      }
    }

    const options = {
      env: childEnv,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: maxOutputBytes,
      shell: false,
      windowsHide: true,
    };

    const startedAt = Date.now();
    const outcome = await invoke(execFile, bin, args, options);
    const durationMs = Date.now() - startedAt;

    if (outcome.promiseResult !== undefined) {
      return { ...fromPromiseResult(outcome.promiseResult, maxOutputBytes), durationMs };
    }

    const { error, stdout, stderr } = outcome;
    if (error === null || error === undefined) {
      const out = capText(stdout, maxOutputBytes);
      const err = capText(stderr, maxOutputBytes);
      return {
        exitCode: 0,
        stdout: out.text,
        stderr: err.text,
        durationMs,
        timedOut: false,
        truncated: out.truncated || err.truncated,
      };
    }

    const out = capText(stdout, maxOutputBytes);
    const err = capText(stderr, maxOutputBytes);
    const message = typeof error.message === 'string' ? error.message : '';
    return {
      exitCode: exitCodeOf(error),
      stdout: out.text,
      stderr: err.text.length > 0 ? err.text : message,
      durationMs,
      timedOut: isTimedOut(error),
      truncated: out.truncated || err.truncated,
    };
  }

  return Object.freeze({ run });
}
