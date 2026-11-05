/**
 * `@heluo/forge-gitee` 的唯一子进程出口（TK2，AC-23；r10 起兼管本地 git）与凭据面。
 *
 * 本包所有子进程调用都必须经过这里的 `run()`（gitee CLI）或 `runGit()`（本地 git）：
 * 没有第二个 `execFile`，没有 `spawn`，没有 shell 拼串，也没有"拼一个命令字符串"的
 * 通道。四道约束写在实现里：
 *
 *   1. **入参白名单**：`run({ bin, args, purpose })` / `runGit({ args, purpose, cwd })`，
 *      多一个字段就拒（未知字段等于有人在试通用命令通道）。git 的 bin 固定在装配期
 *      注入，不给调用方传 `/bin/sh` 的机会。
 *   2. **有界执行**：`shell: false`、超时 → `timedOut`、单流 1 MiB 截断 → `truncated`，
 *      失败是数据不是异常（与 r1 `cli-runner` 同一套终态口径，受控重复见 R-2）。
 *   3. **环境白名单**：子进程只拿到 `ENV_ALLOWLIST` 里的运行态变量 + `authEnv` 点名的
 *      凭据变量。白名单里有**唯一**一个凭据例外 `GITEE_TOKEN`：它就是这个 CLI 的认证模型，
 *      其余凭据变量仍不继承。git 调用额外叠 `GIT_TERMINAL_PROMPT=0`：绝不因为缺凭据而在
 *      管道里等一个永远不来的输入。
 *   4. **凭据只是提示**：落盘凭据（CLI 配置目录里的 `hosts.yml`、本 CLI 的
 *      `~/.gitee-cli/config.json` 等）默认只告警（`persistentToken: 'warn'`）；配成 `block`
 *      才在第一次调用前抛 `GITEE_PERSISTENT_TOKEN`（**零子进程**）。凭据也永远不会进 argv。
 *
 * 产物契约（蓝图 §3 第 2 行，下游逐字使用）：
 *   createGiteeRunner({execFile, env, timeoutMs, maxOutputBytes, now, authEnv, gitBin,
 *                      gitCwd, persistentTokenPolicy})
 *     -> { run({ bin, args, purpose }), runGit({ args, purpose, cwd }), credentialStatus, describe }
 *   run(...) / runGit(...) -> { exitCode, stdout, stderr, durationMs, timedOut, truncated }
 *   scrubSecrets(text, tokens) -> string
 *   detectPersistentToken({ env, readFile }) -> { blocked, reason, files, checked, next_action }
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_AUTH_ENV,
  DEFAULT_PERSISTENT_TOKEN_POLICY,
  DEFAULT_TIMEOUT_MS,
  PERSISTENT_TOKEN_POLICIES,
} from './runtime-config.mjs';

/** 单流默认上限 1 MiB：够装下列表类 JSON，又不至于把上下文塞满（与 r1 同值）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** 允许的入参字段。白名单而非"忽略额外字段"：未知字段意味着有人在试通用命令通道。 */
export const INVOCATION_KEYS = Object.freeze(['bin', 'args', 'purpose']);

/** git 调用的入参字段：**没有** bin（bin 在装配期固定），只有 argv 与工作目录。 */
export const GIT_INVOCATION_KEYS = Object.freeze(['args', 'purpose', 'cwd']);

/** 本地 git 的默认可执行名：走 PATH，装配期可用 `gitBin` 覆盖。 */
export const DEFAULT_GIT_BIN = 'git';

/**
 * git 子进程额外的环境位：`GIT_TERMINAL_PROMPT=0` 让 git 在缺凭据时**报错退出**而不是
 * 阻塞等输入（管道里没有终端，等待会一直拖到超时）。只加这一位，不覆盖白名单推导结果。
 */
const GIT_ENV_OVERRIDES = Object.freeze({ GIT_TERMINAL_PROMPT: '0' });

/**
 * 从宿主继承给子进程的环境变量白名单：只放运行态需要的东西。
 *
 * 唯一的凭据例外是 `GITEE_TOKEN`：本 CLI 的认证模型就是"环境变量 `GITEE_TOKEN` 优先于
 * 系统凭据管理器（keyring service `gitee-cli-go`）"（规格 §1.3）。不放行它，用户按 CLI
 * 文档设了变量也只会拿到 `Not authenticated.`；系统凭据管理器是子进程自己读的，不经过环境。
 * 别家 CLI 的令牌变量、云厂商密钥等仍一律不继承——`authEnv` 是显式注入通道，同名变量以它为准。
 *
 * 里面也没有"另一个 provider 的 host 变量"之类的语义：主机地址来自本 CLI 自己的
 * `~/.gitee-cli/config.json` 的 `base_url`，既不是参数也不是环境变量（规格 §1.1/§1.5）。
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
  // 唯一凭据例外：本 CLI 的认证模型（规格 §1.3），见上方白名单注释。
  'GITEE_TOKEN',
]);

/** 凭据面的固定原因码（TECHNICAL §8.3）：落盘令牌阻断、缺令牌。 */
export const CREDENTIAL_REASONS = Object.freeze({
  PERSISTENT: 'GITEE_PERSISTENT_TOKEN',
  AUTH_MISSING: 'AUTH_MISSING',
});

/** 替换后的占位符：看得出被脱敏过，但看不出原值（长度也不泄露）。 */
const REDACTED = '***';

/**
 * CLI 配置目录里可能落盘凭据的 YAML 文件名（`gh` 兼容布局：另一份 CLI 形态仍在用）。
 */
const CONFIG_FILE_NAMES = Object.freeze(['hosts.yml', 'hosts.yaml', 'config.yml', 'config.yaml']);

/**
 * 本 CLI 的实际落盘布局：`<用户主目录>/.gitee-cli/config.json`（规格 §1.5）。
 *
 * 它是 2 空格缩进 JSON，可能出现的键只有 `token`/`base_url`/`remote_pattern`；`auth login`
 * 默认写系统凭据管理器，但 `config set token …` 会把令牌落进这个文件——AC-22 的风险检查
 * 必须能看见它，否则"检测不到"就只是"扫错了地方"。
 */
const GITEE_CONFIG_DIR_NAME = '.gitee-cli';
const GITEE_CONFIG_FILE_NAMES = Object.freeze(['config.json']);

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

/**
 * 凭据变量名：数组或单值；重复消除但保序（先配先生效）。
 *
 * 空数组合法（r10）：默认 `authEnv` 就是空，表示"不注入任何凭据变量"——缺凭据不再
 * 阻断只读命令，所以"一个都不点名"是意图，不是配置错误。
 */
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

/** 凭据的"形状"兜底：即使没点名变量（默认 authEnv 为空），输出里形似令牌的串也要抹掉。 */
const SECRET_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|gitee_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g;

/**
 * 输出脱敏：把令牌值逐字替换成 `***`，再按形状兜底。
 *
 * 值替换用 `split/join` 而不是正则：令牌里可能有 `.`/`*`/`(` 之类的正则元字符，构造
 * 正则既慢又容易因为转义漏掉（AC-22 要求全链路零命中）。形状兜底覆盖"没点名变量、
 * 但 CLI 自己把令牌打进了错误信息"这种情况。
 */
export function scrubSecrets(text, tokens) {
  const source = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
  if (source.length === 0) return source;
  const list = normalizeTokens(tokens);
  let scrubbed = source;
  for (const token of list) scrubbed = scrubbed.split(token).join(REDACTED);
  return scrubbed.replace(SECRET_SHAPE, REDACTED);
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
 * 从环境推出 CLI 配置目录下的候选文件：`gh` 兼容的 YAML 布局 + 本 CLI 的 JSON 布局。
 *
 * 只看传进来的 env：装配层传真实环境，离线用例传显式 env 即零候选——检测逻辑因此
 * 完全可复现，不会在测试里读到开发机的真实配置。
 */
function candidateConfigFiles(env) {
  const source = env === null || env === undefined ? {} : env;
  const files = [];
  const pushDir = (dir, segments, names) => {
    const base = asText(dir);
    if (base === null) return;
    const trimmed = base.replace(/[\\/]+$/, '');
    if (trimmed.length === 0) return;
    for (const name of names) files.push([trimmed, ...segments, name].join('/'));
  };

  pushDir(source.GH_CONFIG_DIR, [], CONFIG_FILE_NAMES);
  const xdg = asText(source.XDG_CONFIG_HOME);
  if (xdg !== null) pushDir(xdg, ['gh'], CONFIG_FILE_NAMES);
  const appData = asText(source.APPDATA);
  if (appData !== null) pushDir(appData, ['GitHub CLI'], CONFIG_FILE_NAMES);
  const home = asText(source.HOME) ?? asText(source.USERPROFILE);
  if (home !== null) pushDir(home, ['.config', 'gh'], CONFIG_FILE_NAMES);
  // 本 CLI 的落盘位置：`~/.gitee-cli/config.json` 与 `%USERPROFILE%\.gitee-cli\config.json`。
  // 两个变量在部分环境里都设了且不同，各看一次；重复由末尾的 Set 收口。
  for (const profile of [asText(source.HOME), asText(source.USERPROFILE)]) {
    if (profile !== null) pushDir(profile, [GITEE_CONFIG_DIR_NAME], GITEE_CONFIG_FILE_NAMES);
  }

  return [...new Set(files)];
}

/**
 * `~/.gitee-cli/config.json` 的判据：解析 JSON 后看顶层 `token` 是不是**非空字符串**。
 *
 * 空串/缺键都等于"没设置"（规格 §1.5：只存被显式 set 过的键），所以不能只看键名。
 * 解析失败不猜：半截文件自造的告警无法复现，交给下面的形状扫描兜底。
 */
function hasJsonToken(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const flat = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  return flat && typeof parsed.token === 'string' && parsed.token.trim() !== '';
}

function hasPersistentToken(text, file = '') {
  // JSON 布局按字段判：形状扫描只认 YAML 的 `token: value`，对 `"token": "…"` 不成立，
  // 硬套会把 `"token": ""` 也当成命中（误报）或整份文件漏掉（漏报）。
  if (String(file).toLowerCase().endsWith('.json') && hasJsonToken(text)) return true;
  for (const pattern of PERSISTENT_TOKEN_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * 落盘凭据自检（AC-22）：CLI 配置目录里存在持久令牌时阻断，不静默继续。
 *
 * 候选覆盖两套布局：`gh` 兼容的 YAML（`hosts.yml` 等）与本 CLI 的
 * `~/.gitee-cli/config.json`（规格 §1.5）。只扫 YAML 会让这个 CLI 的落盘令牌永远检测不到。
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
    if (hasPersistentToken(text.slice(0, MAX_CREDENTIAL_SCAN_BYTES), file)) hits.push(file);
  }

  if (hits.length === 0) {
    return Object.freeze({ blocked: false, reason: null, files: Object.freeze([]), checked: files.length, next_action: null });
  }
  return Object.freeze({
    blocked: true,
    reason: CREDENTIAL_REASONS.PERSISTENT,
    files: Object.freeze([...hits]),
    checked: files.length,
    next_action: '删除 CLI 配置目录里的明文令牌（如 ~/.gitee-cli/config.json），改用 gh auth login 存入系统凭据库，然后重启插件',
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
 * NUL 会被内核截断参数（`--limit=5\0 --state=all`），属于注入面，直接拒绝。
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

/**
 * 校验 git 调用形状：只认 `{args, purpose, cwd}`，`args` 必须是**非空**的干净字符串数组。
 *
 * 与 `run()` 的差别有两处，都是刻意的：没有 `bin`（git 可执行在装配期固定，调用方
 * 不能改），`args` 非空（`git` 裸跑只会打印帮助，说明调用点拼错了）。
 */
function normalizeGitInvocation(input) {
  if (input === null || typeof input !== 'object') {
    throw new GiteeCliError('runGit() 需要 { args, purpose }');
  }
  const extra = Object.keys(input).filter((key) => !GIT_INVOCATION_KEYS.includes(key));
  if (extra.length > 0) {
    throw new GiteeCliError(`runGit() 不接受字段 ${extra.join(', ')}：只允许 args/purpose/cwd，可执行由装配期固定`);
  }

  const { args, purpose, cwd } = input;
  if (!Array.isArray(args) || args.length === 0) {
    throw new GiteeCliError('runGit().args 必须是非空的字符串数组（子命令与参数分开传，不拼串）');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0) {
      throw new GiteeCliError('runGit().args 只接受非空字符串');
    }
    if (arg.includes('\0')) {
      throw new GiteeCliError('runGit().args 不允许包含 NUL 字符');
    }
  }
  if (purpose !== undefined && typeof purpose !== 'string') {
    throw new GiteeCliError('runGit().purpose 必须是字符串（仅用于诊断，可省略）');
  }
  if (cwd !== undefined && cwd !== null) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0 || cwd.includes('\0')) {
      throw new GiteeCliError('runGit().cwd 必须是非空且不含 NUL 的目录路径（可省略）');
    }
  }

  return { args: [...args], purpose: purpose ?? '', cwd: asText(cwd) };
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

function assertPolicy(persistentTokenPolicy) {
  if (!PERSISTENT_TOKEN_POLICIES.includes(persistentTokenPolicy)) {
    throw new GiteeCliError(`persistentToken 只接受 ${PERSISTENT_TOKEN_POLICIES.join(' / ')}`);
  }
  return persistentTokenPolicy;
}

/** 诊断里只给文件名：看得出用哪个可执行，又不泄露本机绝对路径。 */
function baseName(bin) {
  const parts = String(bin).split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : String(bin);
}

/**
 * 装配唯一子进程出口。
 *
 * `env` 是**显式环境**（覆盖 `process.env`，与 r1 `cli-runner` 同语义）：子进程环境
 * 由"白名单 + `authEnv`"从合并结果推导；落盘凭据自检只看这份显式 env（不传则用
 * `process.env`），因此离线用例传显式 env 就完全离线。
 *
 * r10 新增：`runGit()` 与 `run()` 走同一个执行体（同一份超时/截断/env 白名单/脱敏），
 * 只叠加 `GIT_TERMINAL_PROMPT=0` 与 `cwd`；`persistentTokenPolicy` 决定落盘凭据是
 * 告警（`warn`，默认）还是拒绝（`block`）。
 *
 * @param {object} [options]
 * @param {Function} [options.execFile] 注入点；默认 `node:child_process.execFile`
 * @param {Record<string, string | undefined>} [options.env] 显式环境（覆盖进程环境）
 * @param {number} [options.timeoutMs] 单次调用上限（默认与配置层同源）
 * @param {number} [options.maxOutputBytes] 单流输出上限
 * @param {() => number} [options.now] 可注入时钟（时长统计）
 * @param {string[] | string} [options.authEnv] 凭据变量名（默认与配置层同源，不在此另写一份）
 * @param {(file: string) => string | null} [options.readFile] 凭据自检的读文件注入点
 * @param {string} [options.gitBin] 本地 git 可执行（默认 `git`，走 PATH）
 * @param {string} [options.gitCwd] git 默认工作目录（省略则用子进程继承的 cwd）
 * @param {'warn' | 'block'} [options.persistentTokenPolicy] 落盘凭据策略
 */
export function createGiteeRunner({
  execFile = nodeExecFile,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  now = Date.now,
  authEnv = DEFAULT_AUTH_ENV,
  readFile = defaultReadFile,
  gitBin = DEFAULT_GIT_BIN,
  gitCwd,
  persistentTokenPolicy = DEFAULT_PERSISTENT_TOKEN_POLICY,
} = {}) {
  assertOptions({ execFile, timeoutMs, maxOutputBytes, now });
  const authNames = normalizeAuthEnv(authEnv);
  if (typeof readFile !== 'function') throw new GiteeCliError('readFile 必须是函数（凭据自检注入点）');
  if (typeof gitBin !== 'string' || gitBin.trim().length === 0) {
    throw new GiteeCliError('gitBin 必须是非空可执行标识');
  }
  const workdir = asText(gitCwd);
  const policy = assertPolicy(persistentTokenPolicy);

  const overrides = normalizeEnv(env);
  const source = { ...process.env, ...overrides };
  const childEnv = buildChildEnv(source, authNames);
  const tokens = authNames.map((name) => asText(source[name])).filter((value) => value !== null);
  const detectEnv = env === null || env === undefined ? { ...process.env } : overrides;

  /** 自检只做一次：CLI 配置目录不会在一次装配里变化，重复读盘只是纯开销。 */
  let credentialSnapshot = null;
  function credentialStatus() {
    if (credentialSnapshot === null) {
      const detected = detectPersistentToken({ env: detectEnv, readFile });
      credentialSnapshot = Object.freeze({
        ...detected,
        policy,
        enforced: detected.blocked && policy === 'block',
      });
    }
    return credentialSnapshot;
  }

  /** 命中落盘凭据且策略为 block 时先拒后调：一次子进程都不起（AC-22 的"阻断"）。 */
  function assertCredentialsOpen() {
    const credentials = credentialStatus();
    if (credentials.enforced !== true) return;
    throw new GiteeCliError(
      '检测到 CLI 配置目录存在持久令牌：当前策略为 block，已停止执行；请删除该明文令牌，然后在终端运行 gh auth login 存入系统凭据库',
      {
        code: 'PERSISTENT_TOKEN',
        reason: CREDENTIAL_REASONS.PERSISTENT,
        status: 'denied',
        detail: { files: credentials.files, next_action: credentials.next_action, policy: credentials.policy },
      },
    );
  }

  /** 两个命令面共用的执行体：唯一调子进程的地方、有界、出口统一脱敏。 */
  async function execute(bin, args, { cwd, extraEnv } = {}) {
    const options = {
      env: extraEnv === undefined ? childEnv : { ...childEnv, ...extraEnv },
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: maxOutputBytes,
      shell: false,
      windowsHide: true,
    };
    if (typeof cwd === 'string' && cwd.length > 0) options.cwd = cwd;

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

  /**
   * @param {{bin: string, args?: string[], purpose?: string}} invocation
   * @returns {Promise<{exitCode: number | null, stdout: string, stderr: string,
   *   durationMs: number, timedOut: boolean, truncated: boolean}>}
   */
  async function run(invocation) {
    const { bin, args } = normalizeInvocation(invocation);
    assertCredentialsOpen();
    return execute(bin, args);
  }

  /**
   * 本地 git 调用面（r10）：与 `run()` 同一执行体，只叠加 `GIT_TERMINAL_PROMPT=0` 与 cwd。
   *
   * @param {{args: string[], purpose?: string, cwd?: string}} invocation
   * @returns {Promise<{exitCode: number | null, stdout: string, stderr: string,
   *   durationMs: number, timedOut: boolean, truncated: boolean}>}
   */
  async function runGit(invocation) {
    const { args, cwd } = normalizeGitInvocation(invocation);
    assertCredentialsOpen();
    return execute(gitBin, args, { cwd: cwd ?? workdir, extraEnv: GIT_ENV_OVERRIDES });
  }

  function describe() {
    const credentials = credentialStatus();
    return Object.freeze({
      timeoutMs,
      maxOutputBytes,
      authEnv: Object.freeze([...authNames]),
      persistentToken: credentials.blocked ? 'detected' : 'absent',
      persistentTokenPolicy: policy,
      git: Object.freeze({
        bin: baseName(gitBin),
        cwd: workdir === null ? null : baseName(workdir),
        terminalPrompt: false,
      }),
      shell: false,
    });
  }

  return Object.freeze({ run, runGit, credentialStatus, describe });
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
