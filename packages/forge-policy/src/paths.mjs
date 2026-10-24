/**
 * 受保护路径：根解析、别名归一与包含判定。
 *
 * 判定只看归一化后的真实位置：相对穿越、symlink 等别名落到受保护根内即命中。
 * 任一步无法判定（非绝对路径、ELOOP、权限不足）都抛错，由门禁按拒绝处理。
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve as resolvePath, sep } from 'node:path';

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
      value = rest === undefined || rest === '' ? fromEnv : join(fromEnv, rest);
    }
    if (!isAbsolute(value)) {
      throw new PolicyPathError(
        `protected path "${raw}" must be absolute or start with an environment variable`,
        'POLICY_PROTECTED_ROOT_NOT_ABSOLUTE',
        { template: raw },
      );
    }
    return { raw, root: resolvePath(value) };
  });
}

function realpathDeepest(target, resolve) {
  let current = target;
  const trailing = [];
  for (;;) {
    try {
      const real = resolve(current);
      return trailing.length === 0 ? real : join(real, ...trailing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new PolicyPathError(`cannot resolve "${target}": ${error?.code ?? error?.message}`, 'POLICY_PATH_UNRESOLVABLE', {
          path: target,
        });
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new PolicyPathError(`cannot resolve "${target}"`, 'POLICY_PATH_UNRESOLVABLE', { path: target });
      }
      trailing.push(basename(current));
      current = parent;
    }
  }
}

const CASE_INSENSITIVE = new Set(['darwin', 'win32']);

/**
 * Canonicalize one candidate path for comparison: absolute, lexically folded,
 * symlink-resolved through the deepest existing ancestor, case-folded where the
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
  for (const part of relative.split(/[\\/]+/u)) {
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
  const platform = options.platform ?? process.platform;
  const canonical = canonicalize(candidate, options);
  for (const entry of roots) {
    const root = canonicalize(entry.root, options);
    const separator = platform === 'win32' ? '\\' : sep;
    if (canonical === root || canonical.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)) {
      return { protected: true, root: entry.raw, canonical };
    }
  }
  return { protected: false, canonical };
}
