/**
 * `@heluo/forge-gitee` 的唯一子进程出口（TK2，AC-23）与凭据面（AC-22）。
 *
 * 本包所有 CLI 调用都必须经过这里的 `run()`：没有第二个 `execFile`，没有 `spawn`，
 * 没有 shell 拼串，也没有"拼一个命令字符串"的通道。四道约束写在实现里：
 *
 *   1. **入参白名单**：`run({ bin, args, purpose })`，多一个字段就拒（未知字段等于有人
 *      在试通用命令通道）。
 *   2. **有界执行**：`shell: false`、超时 → `timedOut`、单流 1 MiB 截断 → `truncated`，
 *      失败是数据不是异常（与 r1 `cli-runner` 同一套终态口径，受控重复见 R-2）。
 *   3. **环境白名单**：子进程只拿到 `ENV_ALLOWLIST` 里的运行态变量 + `authEnv` 点名的
 *      凭据变量。`AWS_SECRET_ACCESS_KEY`、`CORP_PASSWORD` 这类与企业无关的机密不会
 *      被继承下去；凭据也永远不会进 argv。
 *   4. **凭据只从环境变量来**：落盘凭据（CLI 配置目录里的 `hosts.yml` 等）一律不放行——
 *      第一次 `run()` 之前自检，命中就抛 `GITEE_PERSISTENT_TOKEN`，**零子进程**。
 *
 * 产物契约（蓝图 §3 第 2 行，下游逐字使用）：
 *   createGiteeRunner({execFile, env, timeoutMs, maxOutputBytes, now})
 *     -> { run({ bin, args, purpose }) }
 *   run(...) -> { exitCode, stdout, stderr, durationMs, timedOut, truncated }
 *   scrubSecrets(text, tokens) -> string
 *   detectPersistentToken({ env, readFile }) -> { blocked, reason, files, checked, next_action }
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { DEFAULT_AUTH_ENV, DEFAULT_TIMEOUT_MS } from './runtime-config.mjs';

/** 单流默认上限 1 MiB：够装下列表类 JSON，又不至于把上下文塞满（与 r1 同值）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** 允许的入参字段。白名单而非"忽略额外字段"：未知字段意味着有人在试通用命令通道。 */
export const INVOCATION_KEYS = Object.freeze(['bin', 'args', 'purpose']);

/**
 * 从宿主继承给子进程的环境变量白名单：只放运行态需要的东西。
 *
 * 刻意**不含**任何凭据变量：凭据只从 `authEnv` 点名的变量来（AC-22）。也不含
 * "另一个 provider 的 host 变量"之类的语义，host 走 `--host` 参数由适配器加。
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
]);

/** 凭据面的固定原因码（TECHNICAL §8.3）：落盘令牌阻断、缺令牌。 */
export const CREDENTIAL_REASONS = Object.freeze({
  PERSISTENT: 'GITEE_PERSISTENT_TOKEN',
  AUTH_MISSING: 'AUTH_MISSING',
});

/** 替换后的占位符：看得出被脱敏过，但看不出原值（长度也不泄露）。 */
const REDACTED = '***';

/** CLI 配置目录里可能落盘凭据的文件名（`gh` 兼容 CLI 的既有布局）。 */
const CONFIG_FILE_NAMES = Object.freeze(['hosts.yml', 'hosts.yaml', 'config.yml', 'config.yaml']);

/** 只扫描前 64 KiB：令牌在文件头部，超大文件不该成为启动期开销。 */
const MAX_CREDENTIAL_SCAN_BYTES = 65_536;

/**
 * 落盘令牌的形态判据（**不解析 YAML**：解析失败/格式变体都可能被绕过，这里只认
 * "键值形状"）。四条都是形状扫描，因此永远不返回命中的值本身（AC-22 不回显）。
 */
const PERSISTENT_TOKEN_PATTERNS = Object.freeze([
  /(?:^|\n)[ \t-]*(?:oauth_)?token[ \t]*[:=][ \t]*['"]?[^\s'"#]{8,}/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /(?:^|\n)[ \t-]*(?:token|pat|access[_-]?token)[ \t]*[:=][ \t]*['"]?[0-9a-f]{32,}/i,
]);

/**
 * 本模块唯一的错误类型：形状错误（更可能是代码 bug）与凭据拒止（安全结论）都用它，
 * 但 `code` / `reason` / `status` 分开表达，便于适配器映射四状态。
 */
export class GiteeCliError extends Error {
  /**
   * @param {string} message 可展示原因（不得含令牌值）
   * @param {{code?: string, reason?: string | null, status?: string | null, detail?: object}} [options]
   */
  constructor(message, { code = 'INVOCATION_INVALID', reason = null, status = null, detail = {} } = {}) {
    super(message);
    this.name = 'GiteeCliError';
    this.code = code;
    this.reason = reason;
    this.status = status;
    this.detail = Object.freeze({ ...detail });
  }
}

/** 字符串修剪；非字符串/空白返回 `null`（"没给"与"给了空"在这里等价）。 */
function asText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeEnv(env) {
  if (env === null || env === undefined) return {};
  if (typeof env !== 'object') throw new GiteeCliError('env 必须是对象（环境变量覆盖项）');
  const overrides = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new GiteeCliError(`env.${key} 必须是字符串`);
    overrides[key] = value;
  }
  return overrides;
}

/** 凭据变量名：数组或单值；重复消除但保序（先配先生效）。 */
function normalizeAuthEnv(authEnv) {
  const list = Array.isArray(authEnv) ? authEnv : [authEnv];
  const names = [];
  for (const entry of list) {
    const name = asText(entry);
    if (name === null) throw new GiteeCliError('authEnv 只接受非空环境变量名');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new GiteeCliError('authEnv 不是合法的环境变量名（只允许字母、数字与下划线）');
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) throw new GiteeCliError('authEnv 至少需要一个环境变量名');
  return names;
}

/**
 * 子进程环境 = 白名单里的运行态变量 + `authEnv` 点名的凭据。
 *
 * 顺序有意为之：先白名单（可能含 PATH/HOME），再逐个覆写凭据变量——凭据是"注入"，
 * 不是"继承"，因此即使宿主环境里有同名变量也只以 `source`（显式 env ∪ 进程环境）为准。
 */
function buildChildEnv(source, authEnv) {
  const childEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) childEnv[key] = value;
  }
  for (const name of authEnv) {
    const value = asText(source[name]);
    if (value !== null) childEnv[name] = value;
  }
  return childEnv;
}

function normalizeTokens(tokens) {
  const list = Array.isArray(tokens) ? tokens : [tokens];
  const seen = [];
  for (const entry of list) {
    const token = asText(entry);
    if (token === null) continue;
    if (!seen.includes(token)) seen.push(token);
  }
  // 长的先换：短令牌是长令牌子串时，先换长的不会把长令牌切成两半漏出剩余部分。
  return seen.sort((left, right) => right.length - left.length);
}

/**
 * 输出脱敏：把令牌值逐字替换成 `***`。
 *
 * 用 `split/join` 而不是正则：令牌里可能有 `.`/`*`/`(` 之类的正则元字符，构造正则
 * 既慢又容易因为转义漏掉（AC-22 要求全链路零命中）。
 */
export function scrubSecrets(text, tokens) {
  const source = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
  const list = normalizeTokens(tokens);
  if (list.length === 0 || source.length === 0) return source;
  let scrubbed = source;
  for (const token of list) scrubbed = scrubbed.split(token).join(REDACTED);
  return scrubbed;
}

/** 默认读文件：任何错误都当"没有这个文件"，检测不该因为权限/缺失而中断。 */
function defaultReadFile(file) {
  try {
    return readFileSync(file, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

/**
 * 从环境推出 CLI 配置目录下的候选文件（`gh` 兼容布局）。
 *
 * 只看传进来的 env：装配层传真实环境，离线用例传显式 env 即零候选——检测逻辑因此
 * 完全可复现，不会在测试里读到开发机的真实配置。
 */
function candidateConfigFiles(env) {
  const source = env === null || env === undefined ? {} : env;
  const files = [];
  const pushDir = (dir, ...rest) => {
    const base = asText(dir);
    if (base === null) return;
    const trimmed = base.replace(/[\\/]+$/, '');
    if (trimmed.length === 0) return;
    for (const name of CONFIG_FILE_NAMES) files.push([trimmed, ...rest, name].join('/'));
  };

  pushDir(source.GH_CONFIG_DIR);
  const xdg = asText(source.XDG_CONFIG_HOME);
  if (xdg !== null) pushDir(xdg, 'gh');
  const appData = asText(source.APPDATA);
  if (appData !== null) pushDir(appData, 'GitHub CLI');
  const home = asText(source.HOME) ?? asText(source.USERPROFILE);
  if (home !== null) pushDir(home, '.config', 'gh');

  return [...new Set(files)];
}

function hasPersistentToken(text) {
  for (const pattern of PERSISTENT_TOKEN_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * 落盘凭据自检（AC-22）：CLI 配置目录里存在持久令牌时阻断，不静默继续。
 *
 * 返回值**只含文件名与下一步动作**，不含令牌值；`checked` 是本次实际看过的候选数，
 * 让"零候选"与"看了但干净"在证据里可区分（前者是因为环境里没有 HOME）。
 *
 * @param {{env?: object, readFile?: (file: string) => string | null}} [options]
 * @returns {Readonly<{blocked: boolean, reason: string | null, files: readonly string[],
 *   checked: number, next_action: string | null}>}
 */
export function detectPersistentToken({ env = {}, readFile = defaultReadFile } = {}) {
  if (typeof readFile !== 'function') {
    throw new GiteeCliError('detectPersistentToken 需要可注入的 readFile');
  }
  const files = candidateConfigFiles(env);
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFile(file);
    } catch {
      text = null;
    }
    if (typeof text !== 'string' || text.length === 0) continue;
    if (hasPersistentToken(text.slice(0, MAX_CREDENTIAL_SCAN_BYTES))) hits.push(file);
  }

  if (hits.length === 0) {
    return Object.freeze({ blocked: false, reason: null, files: Object.freeze([]), checked: files.length, next_action: null });
  }
  return Object.freeze({
    blocked: true,
    reason: CREDENTIAL_REASONS.PERSISTENT,
    files: Object.freeze([...hits]),
    checked: files.length,
    next_action: '删除 CLI 配置目录里的持久令牌，改用环境变量注入（本包只读环境变量），然后重启插件',
  });
}

function capText(value, limit) {
  const text = typeof value === 'string'
    ? value
    : (value === null || value === undefined ? '' : String(value));
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  // 按字节切可能落在多字节序列中间：末尾那个替换字符是"切坏了"，不是数据本身，
  // 直接丢掉（下游拿到以 U+FFFD 结尾的 JSON 会误判成编码损坏）。
  let sliced = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
  if (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);
  return { text: sliced, truncated: true };
}

/** 超时的三种 Node 侧表现（ETIMEDOUT / killed+signal / 假实现显式标记）归一成一布尔位。 */
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

/** 同时兼容回调式（Node 原生）与 Promise 式（测试注入更顺手）两种实现，谁先给用谁。 */
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

/**
 * 校验调用形状：只认 `{bin, args, purpose}`，`args` 必须是干净的字符串数组。
 * NUL 会被内核截断参数（`--limit=5\0 --host=x`），属于注入面，直接拒绝。
 */
function normalizeInvocation(input) {
  if (input === null || typeof input !== 'object') {
    throw new GiteeCliError('run() 需要 { bin, args, purpose }');
  }
  const extra = Object.keys(input).filter((key) => !INVOCATION_KEYS.includes(key));
  if (extra.length > 0) {
    throw new GiteeCliError(`run() 不接受字段 ${extra.join(', ')}：只允许 bin/args/purpose，没有通用命令通道`);
  }

  const { bin, args = [], purpose } = input;
  if (typeof bin !== 'string' || bin.trim().length === 0) {
    throw new GiteeCliError('run().bin 必须是非空可执行标识（PATH 名或环境注入的绝对路径）');
  }
  if (!Array.isArray(args)) {
    throw new GiteeCliError('run().args 必须是字符串数组（程序名与参数分开传，不拼串）');
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new GiteeCliError('run().args 只接受字符串');
    }
    if (arg.includes('\0')) {
      throw new GiteeCliError('run().args 不允许包含 NUL 字符');
    }
  }
  if (purpose !== undefined && typeof purpose !== 'string') {
    throw new GiteeCliError('run().purpose 必须是字符串（仅用于诊断，可省略）');
  }

  return { bin, args: [...args], purpose: purpose ?? '' };
}

function assertOptions({ execFile, timeoutMs, maxOutputBytes, now }) {
  if (typeof execFile !== 'function') {
    throw new GiteeCliError('createGiteeRunner 需要可注入的 execFile（唯一子进程出口）');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GiteeCliError('timeoutMs 必须是正整数');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new GiteeCliError('maxOutputBytes 必须是正整数');
  }
  if (typeof now !== 'function') {
    throw new GiteeCliError('now 必须是返回时间戳的函数（可注入时钟）');
  }
}

/**
 * 装配唯一子进程出口。
 *
 * `env` 是**显式环境**（覆盖 `process.env`，与 r1 `cli-runner` 同语义）：子进程环境
 * 由"白名单 + `authEnv`"从合并结果推导；落盘凭据自检只看这份显式 env（不传则用
 * `process.env`），因此离线用例传显式 env 就完全离线。
 *
 * @param {object} [options]
 * @param {Function} [options.execFile] 注入点；默认 `node:child_process.execFile`
 * @param {Record<string, string | undefined>} [options.env] 显式环境（覆盖进程环境）
 * @param {number} [options.timeoutMs] 单次调用上限（默认与配置层同源）
 * @param {number} [options.maxOutputBytes] 单流输出上限
 * @param {() => number} [options.now] 可注入时钟（时长统计）
 * @param {string[] | string} [options.authEnv] 凭据变量名（默认与配置层同源，不在此另写一份）
 * @param {(file: string) => string | null} [options.readFile] 凭据自检的读文件注入点
 */
export function createGiteeRunner({
  execFile = nodeExecFile,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  now = Date.now,
  authEnv = DEFAULT_AUTH_ENV,
  readFile = defaultReadFile,
} = {}) {
  assertOptions({ execFile, timeoutMs, maxOutputBytes, now });
  const authNames = normalizeAuthEnv(authEnv);
  if (typeof readFile !== 'function') throw new GiteeCliError('readFile 必须是函数（凭据自检注入点）');

  const overrides = normalizeEnv(env);
  const source = { ...process.env, ...overrides };
  const childEnv = buildChildEnv(source, authNames);
  const tokens = authNames.map((name) => asText(source[name])).filter((value) => value !== null);
  const detectEnv = env === null || env === undefined ? { ...process.env } : overrides;

  /** 自检只做一次：CLI 配置目录不会在一次装配里变化，重复读盘只是纯开销。 */
  let credentialSnapshot = null;
  function credentialStatus() {
    if (credentialSnapshot === null) {
      credentialSnapshot = detectPersistentToken({ env: detectEnv, readFile });
    }
    return credentialSnapshot;
  }

  /**
   * @param {{bin: string, args?: string[], purpose?: string}} invocation
   * @returns {Promise<{exitCode: number | null, stdout: string, stderr: string,
   *   durationMs: number, timedOut: boolean, truncated: boolean}>}
   */
  async function run(invocation) {
    const { bin, args } = normalizeInvocation(invocation);

    const credentials = credentialStatus();
    if (credentials.blocked) {
      // 先拒后调：命中落盘凭据时一次子进程都不起（AC-22 的"阻断"，不是"事后告警"）。
      throw new GiteeCliError(
        '检测到 CLI 配置目录存在持久令牌：本包只接受环境变量注入的凭据，已停止执行',
        {
          code: 'PERSISTENT_TOKEN',
          reason: CREDENTIAL_REASONS.PERSISTENT,
          status: 'denied',
          detail: { files: credentials.files, next_action: credentials.next_action },
        },
      );
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

    const startedAt = now();
    const outcome = await invoke(execFile, bin, args, options);
    const durationMs = Math.max(0, now() - startedAt);

    const result = outcome.promiseResult !== undefined
      ? { ...fromPromiseResult(outcome.promiseResult, maxOutputBytes), durationMs }
      : buildResult(outcome, maxOutputBytes, durationMs);

    // 出口统一脱敏：适配器与工具面拿到的 stdout/stderr 里不该出现令牌（AC-22）。
    return {
      ...result,
      stdout: scrubSecrets(result.stdout, tokens),
      stderr: scrubSecrets(result.stderr, tokens),
    };
  }

  return Object.freeze({ run });
}

function buildResult(outcome, maxOutputBytes, durationMs) {
  const { error, stdout, stderr } = outcome;
  const out = capText(stdout, maxOutputBytes);
  const err = capText(stderr, maxOutputBytes);
  if (error === null || error === undefined) {
    return {
      exitCode: 0,
      stdout: out.text,
      stderr: err.text,
      durationMs,
      timedOut: false,
      truncated: out.truncated || err.truncated,
    };
  }
  // 起不来（ENOENT/EACCES）时 stderr 可能就是空的：把 error.message 补进 stderr，原因不丢。
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
