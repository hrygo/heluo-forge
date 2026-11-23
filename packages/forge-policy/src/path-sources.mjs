/**
 * 受保护路径的候选来源：只从"确实是路径"的字段里取候选。
 *
 * 记录口径（P3 · protectPaths）：
 * - `path` / `file` 两个键大小写不敏感，出现在任意深度（含数组内）都算候选；
 * - `target` 只在能确认为路径时才算候选（绝对路径、`./` `../` 前缀，或工作区内已存在的相对路径）；
 * - 其余字段（分支名、仓库名、issue 标题等）不按路径判定，避免把业务标识误当文件路径。
 *
 * 候选只做归一化前的收集；是否受保护由 `paths.mjs#judgeProtectedPath` 判定。
 */
import { statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/** 恒为路径来源的字段（小写比较）。 */
export const PATH_SOURCE_KEYS = Object.freeze(['path', 'file']);

/** 嵌套展开深度上限；更深的节点不再展开（只影响候选数量，不放大拒绝面）。 */
export const MAX_PATH_DEPTH = 4;

/** 单次调用的候选上限；超过按"无法确认"拒绝，不静默抽样。 */
export const MAX_PATH_CANDIDATES = 32;

/** 单个候选值的长度上限；超长值截断后按路径判定，判定失败即拒绝。 */
export const MAX_PATH_VALUE_LENGTH = 4_096;

const RELATIVE_PATH_PREFIX = /^\.{1,2}(?:[\\/]|$)/u;

function safeExists(candidate, workspaceRoot) {
  try {
    statSync(resolvePath(workspaceRoot, candidate));
    return true;
  } catch {
    return false;
  }
}

/**
 * `target` 是否可确认为路径。业务目标（仓库名、分支名、issue 编号）保持不判定。
 *
 * @param {unknown} value
 * @param {{workspaceRoot?: string, stat?: (candidate: string) => boolean}} [options]
 * @returns {string | undefined} 可判定的候选值
 */
export function targetAsPath(value, options = {}) {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (candidate === '') return undefined;
  if (isAbsolute(candidate) || RELATIVE_PATH_PREFIX.test(candidate)) return candidate;
  const workspaceRoot = options.workspaceRoot;
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') return undefined;
  const stat = options.stat ?? ((input) => safeExists(input, workspaceRoot));
  try {
    return stat(candidate) === true ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 收集一次调用里可判定的路径候选。
 *
 * @param {unknown} args 工具调用参数（`arguments`）
 * @param {{workspaceRoot?: string, stat?: (candidate: string) => boolean}} [options]
 * @returns {{candidates: readonly {field: string, value: string}[], truncated: boolean}}
 *   `truncated` 为真表示候选超过上限，调用方必须按"无法确认"拒绝。
 */
export function collectPathCandidates(args, options = {}) {
  const candidates = [];
  let truncated = false;

  function push(field, value) {
    if (typeof value !== 'string' || value.trim() === '') return;
    if (candidates.length >= MAX_PATH_CANDIDATES) {
      truncated = true;
      return;
    }
    candidates.push(Object.freeze({
      field,
      value: value.length > MAX_PATH_VALUE_LENGTH ? value.slice(0, MAX_PATH_VALUE_LENGTH) : value,
    }));
  }

  function walk(node, depth, field) {
    if (depth > MAX_PATH_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      // 普通数组里的字符串不是路径来源（例如 labels、tags）；只有从 path/file
      // 键进入的数组才把字符串算作候选，对象项继续展开。
      for (const item of node) {
        if (typeof item === 'string') {
          if (field !== undefined) push(field, item);
        } else {
          walk(item, depth, field);
        }
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (PATH_SOURCE_KEYS.includes(lower)) {
        if (typeof value === 'string') push(key, value);
        else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') push(key, item);
          }
        } else {
          walk(value, depth + 1, key);
        }
        continue;
      }
      walk(value, depth + 1, undefined);
    }
  }

  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const target = targetAsPath(args.target, options);
    if (target !== undefined) push('target', target);
  }
  walk(args, 0, undefined);
  return Object.freeze({ candidates: Object.freeze(candidates), truncated });
}
