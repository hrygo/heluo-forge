/**
 * 受保护路径：根解析、别名归一与包含判定。
 *
 * 判定只看归一化后的真实位置：相对穿越、symlink 等别名落到受保护根内即命中。
 * 任一步无法判定（非绝对路径、ELOOP、权限不足）都抛错，由门禁按拒绝处理。
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse as parsePath, sep } from 'node:path';

/**
 * 模板展开的取值基线：`DSH_HOME` 默认宿主口径 `~/.dsh`，再让进程环境与插件配置覆盖。
 *
 * 装载期校验（`config.mjs`）与装配期展开（`installer.mjs`）共用本函数，
 * 避免两处各写一份基线而漂移。
 */
export function defaultTemplateValues() {
  return { DSH_HOME: join(homedir(), '.dsh') };
}

/**
 * 合并后的模板取值环境：基线 → 进程环境 → 配置里的 `env`。
 *
 * @param {unknown} [inputEnv]
 * @returns {Record<string, string | undefined>}
 */
export function templateEnv(inputEnv) {
  const configured = inputEnv !== null && typeof inputEnv === 'object' && !Array.isArray(inputEnv) ? inputEnv : {};
  return { ...defaultTemplateValues(), ...process.env, ...configured };
}

export class PolicyPathError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyPathError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const TEMPLATE = /^\$([A-Z][A-Z0-9_]*)(?:\/(.*))?$/u;

/**
 * Resolve configured protected roots. A template variable that cannot be
 * resolved refuses the mount instead of silently protecting nothing.
 *
 * @param {readonly string[]} templates `$DSH_HOME/**`, `$DSH_HOME`, or an absolute path
 * @param {Record<string, string | undefined>} env process environment
 * @returns {{raw: string, root: string}[]} resolved roots
 */
export function resolveProtectedRoots(templates = [], env = process.env) {
  if (!Array.isArray(templates)) {
    throw new PolicyPathError('protectedPaths must be an array', 'POLICY_PROTECTED_ROOT_INVALID');
  }
  return templates.map((raw) => {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new PolicyPathError('each protected path must be a non-empty string', 'POLICY_PROTECTED_ROOT_INVALID');
    }
    const template = raw.trim().replace(/\/\*\*$/u, '');
    let value = template;
    const match = TEMPLATE.exec(template);
    if (match !== null) {
      const [, variable, rest] = match;
      const fromEnv = env[variable];
      if (fromEnv === undefined || fromEnv.length === 0) {
        throw new PolicyPathError(
          `protected path template "${raw}" cannot be resolved: ${variable} is not set`,
          'POLICY_PROTECTED_ROOT_UNRESOLVED',
          { template: raw, variable },
        );
      }
      value = rest === undefined || rest === '' ? fromEnv : `${fromEnv}${fromEnv.endsWith(sep) ? '' : sep}${rest}`;
    }
    if (!isAbsolute(value)) {
      throw new PolicyPathError(
        `protected path "${raw}" must be absolute or start with an environment variable`,
        'POLICY_PROTECTED_ROOT_NOT_ABSOLUTE',
        { template: raw },
      );
    }
    return { raw, root: value };
  });
}

const CASE_INSENSITIVE = new Set(['darwin', 'win32']);

/**
 * Canonicalize an absolute path for comparison: resolve symlinks before applying
 * parent components, preserve missing components, and case-fold where the
 * platform is case-insensitive.
 *
 * @param {string} input candidate path
 * @param {{platform?: string, resolve?: Function}} [options]
 * @returns {string} canonical path
 */
export function canonicalize(input, options = {}) {
  const platform = options.platform ?? process.platform;
  const resolve = options.resolve ?? realpathSync.native ?? realpathSync;
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new PolicyPathError('path must be a non-empty string', 'POLICY_PATH_INVALID');
  }
  if (!isAbsolute(input)) {
    throw new PolicyPathError(`path "${input}" must be absolute`, 'POLICY_PATH_NOT_ABSOLUTE', { path: input });
  }
  const real = resolvePhysically(input, resolve);
  return CASE_INSENSITIVE.has(platform) ? real.toLowerCase() : real;
}

/**
 * Walk the path one component at a time, resolving symlinks before applying
 * `..`. Lexical folding first would let `/root/link/../x` escape a protected
 * root when `link` points into it: the shell resolves `link` and then takes the
 * parent of its *target*, while a lexical fold takes the parent of `link`.
 * Components that do not exist yet keep their literal value and are resolved
 * again if a deeper ancestor appears.
 *
 * @param {string} input absolute path
 * @param {Function} resolve realpath-like function
 * @returns {string} physically resolved path
 */
function resolvePhysically(input, resolve) {
  const { root } = parsePath(input);
  let current = root === '' ? sep : root;
  const relative = input.slice(root.length);
  for (const part of relative.split(sep === '\\' ? /[\\/]+/u : '/')) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    try {
      current = resolve(next);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new PolicyPathError(`cannot resolve "${input}": ${error?.code ?? error?.message}`, 'POLICY_PATH_UNRESOLVABLE', {
          path: input,
        });
      }
      current = next;
    }
  }
  return current;
}

/**
 * @param {string} candidate path to check
 * @param {{root: string, raw: string}[]} roots resolved protected roots
 * @param {{platform?: string, resolve?: Function}} [options]
 * @returns {{protected: boolean, root?: string, canonical: string}}
 */
export function matchProtected(candidate, roots = [], options = {}) {
  const canonical = canonicalize(candidate, options);
  for (const entry of roots) {
    const root = canonicalize(entry.root, options);
    if (canonical === root || canonical.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
      return { protected: true, root: entry.raw, canonical };
    }
  }
  return { protected: false, canonical };
}

/**
 * 九类受保护文件名：固定在代码里，配置只能追加范围，不能把这些类别关掉。
 * `*` 只按仓内约定表示前缀/后缀，不引入通配引擎。
 */
export const PROTECTED_NAME_PATTERNS = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  '.npmrc',
  '.netrc',
  'credentials*',
  '*.p12',
]);

const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);

function foldCase(value, platform) {
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? value.toLowerCase() : value;
}

function matchesNamePattern(name, pattern) {
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * 单个文件名的受保护类别判定；大小写折叠规则与 `canonicalize` 一致。
 *
 * @param {string} name 文件基名
 * @param {{platform?: string}} [options]
 * @returns {string | undefined} 命中的模式（如 `*.pem`）
 */
export function matchProtectedName(name, options = {}) {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const platform = options.platform ?? process.platform;
  const folded = foldCase(name, platform);
  for (const pattern of PROTECTED_NAME_PATTERNS) {
    if (matchesNamePattern(folded, pattern)) return pattern;
  }
  return undefined;
}

function withinRoot(canonical, root) {
  return canonical === root || canonical.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * 把候选路径放进"会话工作区 + 配置追加根"的作用域里判定。
 *
 * 工作区内的九类名称固定生效；配置追加根整段受保护（不套九类名）。
 * 两个作用域都不命中时不判定（交给宿主沙箱），判定所需信息缺失则抛错由门禁拒绝。
 *
 * @param {string} candidate
 * @param {{workspaceRoot?: string, roots?: {raw: string, root: string}[], platform?: string, resolve?: Function}} [options]
 * @returns {{judged: boolean, protected: boolean, canonical: string, kind?: 'name' | 'root', pattern?: string,
 *   template?: string, rootId?: string, category?: string, ruleIds?: readonly string[]}}
 */
export function judgeProtectedPath(candidate, options = {}) {
  const roots = options.roots ?? [];
  if (typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim() === '') {
    throw new PolicyPathError('the session workspace root is not available', 'POLICY_PATH_SCOPE_UNAVAILABLE');
  }
  const platform = options.platform ?? process.platform;
  const workspace = canonicalize(options.workspaceRoot, options);
  const canonical = canonicalize(candidate, options);
  const inWorkspace = withinRoot(canonical, workspace);
  let configured;
  let configuredIndex = -1;
  for (const [index, entry] of roots.entries()) {
    if (withinRoot(canonical, canonicalize(entry.root, options))) {
      configured = entry;
      configuredIndex = index;
      break;
    }
  }
  if (!inWorkspace && configured === undefined) {
    return Object.freeze({ judged: false, protected: false, canonical });
  }
  const pattern = matchProtectedName(basename(canonical), { platform });
  if (pattern !== undefined) {
    return Object.freeze({
      judged: true,
      protected: true,
      kind: 'name',
      pattern,
      category: `name:${pattern}`,
      ruleIds: Object.freeze([`name:${pattern}`]),
      canonical,
    });
  }
  if (configured !== undefined) {
    // 追加项用配置里的序号标识，不用路径原文：配置可能写的是绝对路径，
    // 而 category/ruleIds 会进审计。原文只放在 template 里供人看，禁止写入审计。
    const rootId = `root:${configuredIndex + 1}`;
    return Object.freeze({
      judged: true,
      protected: true,
      kind: 'root',
      template: configured.raw,
      rootId,
      category: rootId,
      ruleIds: Object.freeze([rootId]),
      canonical,
    });
  }
  return Object.freeze({ judged: true, protected: false, canonical });
}

/**
 * 配置项的路径语法：绝对路径，或 `$VAR` / `$VAR/rest` 形式的环境变量模板。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPathTemplate(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (TEMPLATE.test(value)) return true;
  return isAbsolute(value);
}
