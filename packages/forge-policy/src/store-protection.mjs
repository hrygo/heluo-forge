/**
 * IAM 凭据存档访问与取票通道判定（issue #375）。
 *
 * 判定发生在目录解析之前：`read`/`glob`/`grep`/`bash` 这类调用永远拿不到 catalog
 * action，因此不能走受控写门禁的目录登记路径，只能按调用参数直接判。
 *
 * 边界（与方案 §3.1、§4.4 一致）：
 * - 只判定调用时可见的参数：路径、`cwd`、命令文本；运行期拼装的路径（`$(which …)`、
 *   `python3 -c` 自算、脚本内含路径）不在覆盖范围，交付文案不得宣称已封堵。
 * - 不复制平台布局：存档目录来自 `credentials-store-location`（由内置凭据后端提供），
 *   本模块只接受 `{directory, keyDirectory}`，不臆造默认目录。
 */
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { canonicalize, matchProtected } from './paths.mjs';
import { collectPathCandidates } from './path-sources.mjs';

/** 命中根所属的存档物；只用于审计与文案，不含路径原文。 */
export const STORE_ARTIFACT = Object.freeze({
  STORE_DIR: 'iam-store-dir',
  KEYRING: 'iam-keyring',
});

/** 取票通道的可执行名（`bin/heluo-forge.mjs` 由 shebang 直接执行时也算）。 */
export const CLI_NAMES = Object.freeze(['heluo-forge', 'heluo-forge.mjs']);

/** 命令里裸文件名即可确认是存档的指纹。 */
const STORE_FILE_FINGERPRINTS = Object.freeze([/^credentials\.sqlite(?:[-.].*)?$/u, /^keyring\.json$/u]);

/** 存档目录名指纹（仅在路径无法归一化时兜底使用）。 */
const STORE_DIR_FINGERPRINTS = Object.freeze(['HeluoForge', 'heluo-iam-store']);

/** 通用兜底跳过的参数键：内容型字段不是路径，也不该按命令判定。 */
const NON_PATH_KEYS = new Set([
  'pattern',
  'query',
  'prompt',
  'description',
  'justification',
  'meta',
  'content',
  'old_string',
  'new_string',
  'text',
]);

const SHELL_SEPARATORS = /[;&|\n]+/u;

/**
 * 由位置服务解析出受保护根：库目录与密钥目录，两者都必须已是绝对路径。
 *
 * @param {{directory?: unknown, keyDirectory?: unknown}} location
 * @returns {{raw: string, root: string, artifact: string}[]}
 */
export function storeRootsFrom(location) {
  const roots = [];
  const entries = [
    [location?.directory, STORE_ARTIFACT.STORE_DIR],
    [location?.keyDirectory, STORE_ARTIFACT.KEYRING],
  ];
  for (const [value, artifact] of entries) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw Object.assign(new Error('the credential store location is incomplete'), {
        code: 'POLICY_STORE_LOCATION_INVALID',
      });
    }
    if (!isAbsolute(value)) {
      throw Object.assign(new Error('the credential store location must be absolute'), {
        code: 'POLICY_PROTECTED_ROOT_NOT_ABSOLUTE',
      });
    }
    roots.push(Object.freeze({ raw: value, root: value, artifact }));
  }
  return Object.freeze(roots);
}

function expandVariables(token, cwd) {
  return token
    .replace(/^\$?\{?HOME\}?(?=\/|$)/u, process.env.HOME ?? '')
    .replace(/^\$?\{?XDG_DATA_HOME\}?(?=\/|$)/u, process.env.XDG_DATA_HOME ?? '')
    .replace(/^\$?\{?LOCALAPPDATA\}?(?=\/|$)/u, process.env.LOCALAPPDATA ?? '')
    .replace(/^\$?\{?HELUO_FORGE_STORE_DIRECTORY\}?(?=\/|$)/u, process.env.HELUO_FORGE_STORE_DIRECTORY ?? '')
    .replace(/^~/u, process.env.HOME ?? '~')
    .replace(/\\(.)/gu, '$1')
    .replace(/^['"]|['"]$/gu, '');
}

function looksLikePath(token) {
  if (token === '' || token.startsWith('-')) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  return /^[A-Za-z]:/u.test(token);
}

/**
 * 把命令文本切成候选：路径词 + 存档指纹词。
 *
 * @param {string} text
 * @param {{cwd?: string}} [options]
 * @returns {{kind: 'path'|'command', text: string}[]}
 */
export function parseCommandTargets(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const stripped = text.replace(/(^|\s)#[^\n]*/gu, '$1');
  const targets = [];
  for (const segment of stripped.split(SHELL_SEPARATORS)) {
    for (const raw of segment.split(/\s+/u)) {
      const token = expandVariables(raw, options.cwd);
      if (token === '') continue;
      const base = token.split(/[\\/]/u).pop() ?? token;
      if (STORE_FILE_FINGERPRINTS.some((pattern) => pattern.test(base))) {
        targets.push(Object.freeze({ kind: 'command', text: base }));
        continue;
      }
      if (looksLikePath(token)) targets.push(Object.freeze({ kind: 'path', text: token }));
    }
  }
  return targets;
}

function argumentsOf(exec) {
  const args = exec?.arguments ?? exec?.args;
  return args !== null && typeof args === 'object' ? args : {};
}

function stringLeaves(value, depth = 0, out = []) {
  if (depth > 4) return out;
  if (typeof value === 'string') {
    if (value.length <= 8 * 1_024) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, depth + 1, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (NON_PATH_KEYS.has(key)) continue;
      stringLeaves(item, depth + 1, out);
    }
  }
  return out;
}

const PATH_TOOL_KEYS = Object.freeze({
  read: ['file_path'],
  read_image: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  glob: ['path'],
  grep: ['path'],
  working_directory: ['cd'],
  dsh_browser_download: ['savePath'],
  dsh_browser_upload: ['path'],
});

const COMMAND_TOOLS = new Set(['bash', 'terminal_send', 'run_code']);
const RECURSIVE_TOOLS = new Set(['glob', 'grep', 'terminal_open']);

/**
 * 从一次工具调用里抽取可判定的存档目标。
 *
 * @param {{name?: string, arguments?: object}} exec
 * @returns {{kind: 'path'|'command', text: string, recursive?: boolean}[]}
 */
export function extractStoreTargets(exec) {
  const name = String(exec?.name ?? '');
  const args = argumentsOf(exec);
  const targets = [];
  const pushPath = (value, recursive = false) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    targets.push(Object.freeze({ kind: 'path', text: value, recursive }));
  };

  const keys = PATH_TOOL_KEYS[name];
  if (keys !== undefined) {
    for (const key of keys) pushPath(args[key], RECURSIVE_TOOLS.has(name));
    // `file_path` 是 read/write/edit 的路径键，path-sources 只认 path/file，
    // 这里补齐；其余参数仍交给通用候选收集，避免漏掉 target 类字段。
    for (const candidate of collectPathCandidates(args).candidates) {
      if (candidate.field === 'path' || candidate.field === 'file') pushPath(candidate.value);
    }
    return targets;
  }

  if (name === 'terminal_open') {
    pushPath(args.cwd, true);
    return targets;
  }

  if (COMMAND_TOOLS.has(name)) {
    const texts = [];
    if (name === 'bash') texts.push(args.command);
    if (name === 'terminal_send') texts.push(args.text);
    if (name === 'run_code') {
      texts.push(args.script);
      texts.push(...stringLeaves(args.args));
    }
    for (const text of texts) {
      if (typeof text === 'string') targets.push(...parseCommandTargets(text, { cwd: args.workdir }));
    }
    return targets;
  }

  for (const candidate of collectPathCandidates(args).candidates) pushPath(candidate.value);
  for (const leaf of stringLeaves(args)) {
    if (looksLikePath(leaf) || /[\s;&|]/u.test(leaf)) targets.push(...parseCommandTargets(leaf));
  }
  return targets;
}

function isWithinRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function pathFingerprintHit(text) {
  const base = text.split(/[\\/]/u).pop() ?? text;
  return STORE_FILE_FINGERPRINTS.some((pattern) => pattern.test(base))
    || STORE_DIR_FINGERPRINTS.some((name) => text.includes(name));
}

function commandFingerprintHit(text) {
  const base = text.split(/[\\/]/u).pop() ?? text;
  return STORE_FILE_FINGERPRINTS.some((pattern) => pattern.test(base));
}

/**
 * 判定一次调用是否直接访问存档。
 *
 * @param {{name?: string, arguments?: object}} exec
 * @param {{raw: string, root: string, artifact: string}[]} roots
 * @returns {{hit: false} | {hit: true, artifact: string, reason: 'path'|'ancestor'|'command', recursive: boolean}}
 */
export function judgeStoreAccess(exec, roots = []) {
  // 位置服务缺席（无根）时仍按存档文件名/目录名指纹拒绝：凭据后端没装配不代表
  // 存档不存在，点名 `credentials.sqlite` / `keyring.json` / 存档目录的调用照样拦。
  const rootList = Array.isArray(roots) ? roots : [];
  for (const target of extractStoreTargets(exec)) {
    if (target.kind === 'command') {
      if (commandFingerprintHit(target.text)) {
        return Object.freeze({ hit: true, artifact: STORE_ARTIFACT.STORE_DIR, reason: 'command', recursive: false });
      }
      continue;
    }
    let canonical;
    try {
      canonical = canonicalize(target.text);
    } catch {
      // 不可判定的路径只在文本点名存档时拒绝；其余交给沙箱。
      const base = target.text.split(/[\\/]/u).pop() ?? target.text;
      if (STORE_FILE_FINGERPRINTS.some((pattern) => pattern.test(base))
        || STORE_DIR_FINGERPRINTS.some((name) => target.text.includes(name))) {
        return Object.freeze({ hit: true, artifact: STORE_ARTIFACT.STORE_DIR, reason: 'path', recursive: false });
      }
      continue;
    }
    const matched = rootList.length === 0 ? { protected: false } : matchProtected(canonical, rootList);
    if (matched.protected) {
      const entry = rootList.find((item) => item.raw === matched.root);
      return Object.freeze({
        hit: true,
        artifact: entry?.artifact ?? STORE_ARTIFACT.STORE_DIR,
        reason: 'path',
        recursive: target.recursive === true,
      });
    }
    if (target.recursive === true && rootList.length > 0) {
      for (const entry of rootList) {
        const root = canonicalize(entry.root);
        if (isWithinRoot(root, canonical)) {
          return Object.freeze({ hit: true, artifact: entry.artifact, reason: 'ancestor', recursive: true });
        }
      }
    }
    if (rootList.length === 0 && pathFingerprintHit(target.text)) {
      return Object.freeze({ hit: true, artifact: STORE_ARTIFACT.STORE_DIR, reason: 'path', recursive: false });
    }
  }
  return Object.freeze({ hit: false });
}

/**
 * 拒绝文案：不含绝对路径、不含命令原文。
 *
 * @param {string} tool
 * @param {{artifact?: string, reason?: string, recursive?: boolean}} [verdict]
 * @returns {string}
 */
export function storeDeniedCopy(tool, verdict = {}) {
  const action = verdict.reason === 'ancestor' || verdict.recursive === true ? '遍历' : '读取';
  const artifact = verdict.artifact === STORE_ARTIFACT.KEYRING ? '密钥目录' : '库目录';
  return [
    `IAM 凭据库与密钥目录只能经公开接口访问：本次调用「${tool}」试图直接${action}凭据存档（${artifact}），已拒绝。`,
    '请改用 `heluo-forge auth whoami --json`，或宿主插件接口 `ctx.iam.getSession()` / `ctx.iam.getAccessToken()` / `ctx.credentials.*`。',
  ].join('\n');
}

/** 取票拒绝文案：不含命令原文与绝对路径。 */
export function tokenDeniedCopy(tool) {
  return [
    `Agent 不得直接调用 \`heluo-forge auth token\`（工具「${tool}」）：该命令会把可复用的访问令牌输出到标准输出，一次确认无法约束其后续用途。`,
    '需要代办业务操作时，请由受信组件取用令牌并发起请求，只接收业务结果；身份自查请用 `heluo-forge auth whoami --json`。',
  ].join('\n');
}

const NODE_PREFIXES = new Set(['node', 'nodejs', 'npx', 'env', 'sudo', 'command', 'exec']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

function isCliToken(token) {
  const base = token.split(/[\\/]/u).pop() ?? token;
  return CLI_NAMES.includes(base);
}

function scanTokens(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isCliToken(token)) continue;
    // `heluo-forge auth token` 与 `heluo-forge auth --json token` 都算；`auth whoami` 不算。
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const word = tokens[cursor];
      if (word === 'auth') {
        const next = tokens.slice(cursor + 1).find((item) => !item.startsWith('-'));
        if (next === 'token') return { hit: true, executable: token };
        break;
      }
      if (!word.startsWith('-') && word !== 'auth') break;
    }
  }
  return { hit: false };
}

/**
 * 识别命令型参数里的 CLI 取票调用。
 *
 * 覆盖：`heluo-forge auth token`、`node …/bin/heluo-forge.mjs auth token`、
 * `npx heluo-forge auth token`、`env … heluo-forge auth token`、
 * `sh -c '… heluo-forge auth token'`。不覆盖运行期拼装（`"$(which …)" auth token`）。
 *
 * @param {{name?: string, arguments?: object}} exec
 * @returns {{hit: false} | {hit: true, executable: string, reason: string}}
 */
export function judgeTokenInvocation(exec) {
  const name = String(exec?.name ?? '');
  const args = argumentsOf(exec);
  const texts = [];
  if (name === 'bash') texts.push(args.command);
  if (name === 'terminal_send') texts.push(args.text);
  if (name === 'run_code') {
    texts.push(args.script);
    texts.push(...stringLeaves(args.args));
  }
  for (const text of texts) {
    if (typeof text !== 'string' || text.trim() === '') continue;
    const segments = text.replace(/(^|\s)#[^\n]*/gu, '$1').split(SHELL_SEPARATORS);
    for (const segment of segments) {
      const tokens = segment.split(/\s+/u).map((token) => expandVariables(token)).filter(Boolean);
      const direct = scanTokens(tokens);
      if (direct.hit) return Object.freeze({ hit: true, executable: direct.executable, reason: 'cli' });
      // `sh -c '<cmd>'`：把引号内的脚本再扫一遍（token 已被去引号）。
      const shellIndex = tokens.findIndex((token) => SHELLS.has(token.split(/[\\/]/u).pop() ?? token));
      if (shellIndex !== -1) {
        const script = tokens.slice(shellIndex + 1).join(' ');
        const nested = scanTokens(script.split(/\s+/u));
        if (nested.hit) return Object.freeze({ hit: true, executable: nested.executable, reason: 'shell' });
      }
      // `node <cli>` / `npx <cli>`：前缀 token 不改变结论，但要求 CLI token 出现。
      const prefixed = tokens.filter((token, index) => index > 0 && NODE_PREFIXES.has(tokens[index - 1]));
      for (const token of prefixed) {
        if (!isCliToken(token)) continue;
        const nested = scanTokens([token, ...tokens.slice(tokens.indexOf(token) + 1)]);
        if (nested.hit) return Object.freeze({ hit: true, executable: token, reason: 'node' });
      }
    }
  }
  return Object.freeze({ hit: false });
}
