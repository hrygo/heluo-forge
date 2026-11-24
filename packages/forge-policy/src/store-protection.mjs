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
import { isAbsolute, sep } from 'node:path';

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
export const STORE_DIRECTORY_ENV = 'HELUO_FORGE_STORE_DIRECTORY';

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

const SHELL_WORDS = /[;&|\n]+|#[^\n]*|(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s;&|'"\\])+/gu;
const FILE_COMMANDS = new Set(['cat', 'cp', 'du', 'find', 'head', 'less', 'ls', 'mv', 'rm', 'rsync', 'sqlite3', 'stat', 'tail', 'touch']);

function* commandSegments(text) {
  let words = [];
  for (const word of text.match(SHELL_WORDS) ?? []) {
    if (word.startsWith('#')) continue;
    if (/^[;&|\n]+$/u.test(word)) {
      if (words.length > 0) yield words;
      words = [];
    } else {
      words.push(word);
    }
  }
  if (words.length > 0) yield words;
}

function unquote(token) {
  return token.replace(/^(['"])([\s\S]*)\1$/u, '$2');
}

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

function expandVariables(token) {
  if (token.startsWith("'")) return unquote(token);
  return unquote(token)
    .replace(/^\$?\{?HOME\}?(?=\/|$)/u, process.env.HOME ?? '')
    .replace(/^\$?\{?XDG_DATA_HOME\}?(?=\/|$)/u, process.env.XDG_DATA_HOME ?? '')
    .replace(/^\$?\{?LOCALAPPDATA\}?(?=\/|$)/u, process.env.LOCALAPPDATA ?? '')
    .replace(/^\$\{?([A-Z_]+)\}?(?=\/|$)/u, (original, name) => (
      name === STORE_DIRECTORY_ENV ? process.env[STORE_DIRECTORY_ENV] ?? original : original
    ))
    .replace(/^~/u, process.env.HOME ?? '~')
    .replace(process.platform === 'win32' ? /\\([ "';&|])/gu : /\\(.)/gu, '$1');
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
  return collectCommandTargets(text, options.cwd);
}

function collectCommandTargets(text, workdir, depth = 0, inheritedCwd = undefined) {
  if (typeof text !== 'string' || text.trim() === '' || depth > 4) return [];
  const targets = [];
  // 跟随命令文本里的 `cd`：`cd <存档目录> && sqlite3 credentials.sqlite` 的后半段
  // 才是真正的路径来源。无法解析的目录（含变量拼装）一律回落到未定 cwd。
  let cwd = typeof workdir === 'string' && isAbsolute(workdir) ? workdir : inheritedCwd;
  for (const segment of commandSegments(text)) {
    const { executable, args } = commandInvocation(segment.map(unquote));
    const script = shellScript(executable, args);
    if (script !== undefined) {
      targets.push(...collectCommandTargets(script, cwd, depth + 1, cwd));
      continue;
    }
    const words = segment.map(expandVariables);
    const name = executable.split(/[\\/]/u).at(-1);
    if ((name === 'cd' || name === 'pushd') && words.length > 1) {
      const next = words[1];
      if (!next.startsWith('-') && next !== '') {
        cwd = isAbsolute(next) ? next : (cwd === undefined ? undefined : cwd + sep + next);
      }
      continue;
    }
    const fileCommand = FILE_COMMANDS.has(name);
    for (const [index, token] of words.entries()) {
      if (token === '' || token.startsWith('-')) continue;
      const fingerprint = commandFingerprintHit(token);
      const pathLike = looksLikePath(token) || fingerprint;
      const fileOperand = index > 0 && fileCommand && /^[\w.-]+$/u.test(token);
      if (isAbsolute(token)) {
        targets.push(Object.freeze({ kind: 'path', text: token }));
      } else if (cwd !== undefined && (pathLike || fileOperand)) {
        // Preserve parent components until the shared physical resolver evaluates them.
        targets.push(Object.freeze({ kind: 'path', text: cwd + sep + token }));
      } else if (fingerprint) {
        // 裸文件名且 cwd 未定：只有位置服务缺席（或降级）时才靠文件名兜底，
        // 位置已知时由 judgeStoreAccess 放弃判定，避免误伤仓库内同名夹具。
        targets.push(Object.freeze({ kind: 'command', text: token }));
      } else if (pathLike) {
        targets.push(Object.freeze({ kind: 'path', text: token }));
      }
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

  const keys = Object.hasOwn(PATH_TOOL_KEYS, name) ? PATH_TOOL_KEYS[name] : undefined;
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
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function pathFingerprintHit(text) {
  const components = text.split(/[\\/]/u).filter(Boolean);
  const base = components.at(-1) ?? text;
  return STORE_FILE_FINGERPRINTS.some((pattern) => pattern.test(base))
    || components.some((part) => STORE_DIR_FINGERPRINTS.some((name) => part === name || part === name + '.keys'));
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
  // 调用方在位置服务缺席时跳过本判定。服务存在但目录不一致时以空根启用指纹兜底。
  const rootList = Array.isArray(roots) ? roots : [];
  for (const target of extractStoreTargets(exec)) {
    if (target.kind === 'command') {
      // 文件名指纹只用于「位置未知」：服务缺席或目录错配降级时，裸文件名仍然点名存档；
      // 位置已知时裸文件名可能只是别处同名文件（仓库内的 keyring.json 夹具），放行。
      if (rootList.length === 0 && commandFingerprintHit(target.text)) {
        return Object.freeze({ hit: true, artifact: STORE_ARTIFACT.STORE_DIR, reason: 'command', recursive: false });
      }
      continue;
    }
    let canonical;
    try {
      canonical = canonicalize(target.text);
    } catch {
      // 不可判定的路径只在文本点名存档时拒绝；其余交给沙箱。
      if (pathFingerprintHit(target.text)) {
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
// 这些命令只读取/转写参数，不会把参数当可执行文件运行：其中的 CLI 字样是数据。
const DATA_COMMANDS = new Set([
  'awk', 'basename', 'cat', 'cut', 'dirname', 'echo', 'grep', 'head', 'jq', 'less', 'logger',
  'man', 'more', 'printf', 'rg', 'sed', 'sort', 'tail', 'tee', 'tr', 'uniq', 'wc',
]);

function isCliToken(token) {
  const base = token.split(/[\\/]/u).pop() ?? token;
  return CLI_NAMES.includes(base);
}

function isDataCommand(executable) {
  return DATA_COMMANDS.has(executable.split(/[\\/]/u).at(-1));
}

function commandInvocation(tokens) {
  let cursor = 0;
  let wrapper = false;
  while (cursor < tokens.length) {
    const word = tokens[cursor];
    const name = word.split(/[\\/]/u).at(-1);
    if (NODE_PREFIXES.has(name)) {
      wrapper = true;
    } else if (!/^[A-Za-z_]\w*=/u.test(word) && !(wrapper && word.startsWith('-'))) {
      break;
    }
    cursor += 1;
  }
  return { executable: tokens[cursor] ?? '', args: tokens.slice(cursor + 1) };
}

function shellScript(executable, args) {
  if (!SHELLS.has(executable.split(/[\\/]/u).at(-1))) return undefined;
  const flagIndex = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg));
  return flagIndex === -1 ? undefined : args[flagIndex + 1];
}

function scanCommands(text, depth = 0) {
  if (depth > 4) return { hit: false };
  for (const words of commandSegments(text)) {
    const { executable, args } = commandInvocation(words.map(unquote));
    const script = shellScript(executable, args);
    if (script !== undefined) {
      const nested = scanCommands(script, depth + 1);
      if (nested.hit) return { ...nested, reason: 'shell' };
    } else if (isDataCommand(executable)) {
      // 只输出/转写参数的命令：`echo 'Usage: heluo-forge auth token'` 是文档内容，不是取票。
      continue;
    } else if (isCliToken(executable)) {
      const [command, subcommand] = args.filter((word) => !word.startsWith('-'));
      if (command === 'auth' && subcommand === 'token') {
        return { hit: true, executable, reason: 'cli' };
      }
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
    const verdict = scanCommands(text);
    if (verdict.hit) return Object.freeze(verdict);
  }
  return Object.freeze({ hit: false });
}
