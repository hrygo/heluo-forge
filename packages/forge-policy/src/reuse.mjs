/**
 * 会话内决策复用：同一次调用被重试时，不再为同一个决定打扰用户。
 *
 * 键由四个分量组成：`tool + callId + action + digest`。任一分量缺失即返回
 * `undefined`——既不能查询也不能写入，避免只凭 callId 或只凭动作就跳过人工确认。
 *
 * 缓存只在进程内存里：上限 32 条，`Map` 插入序当 LRU（命中即 delete + set 刷新为
 * 最新，不增条目），不落盘、不进日志、不跨会话，插件卸载即清空。
 */

export const DECISION_CACHE_LIMIT = 32;

const SEPARATOR = '\u0000';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 四元键：任一分量缺失即 `undefined`（fail-closed，不上探）。
 *
 * @param {{tool?: string, callId?: string, action?: string, digest?: string}} parts
 * @returns {string | undefined}
 */
export function reuseKeyOf({ tool, callId, action, digest } = {}) {
  if (!nonEmptyString(tool) || !nonEmptyString(callId) || !nonEmptyString(action) || !nonEmptyString(digest)) {
    return undefined;
  }
  return `${tool}${SEPARATOR}${callId}${SEPARATOR}${action}${SEPARATOR}${digest}`;
}

/**
 * LRU 决策缓存。
 *
 * @param {{limit?: number}} [options]
 * @returns {{has: Function, peek: Function, set: Function, touch: Function,
 *   delete: Function, clear: Function, size: Function, limit: Function}}
 */
export function createDecisionCache({ limit = DECISION_CACHE_LIMIT } = {}) {
  const capacity = Number.isInteger(limit) && limit > 0 ? limit : DECISION_CACHE_LIMIT;
  const entries = new Map();

  function trim() {
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  return Object.freeze({
    has: (key) => entries.has(key),
    peek(key) {
      const entry = entries.get(key);
      return entry === undefined ? undefined : Object.freeze({ ...entry });
    },
    /** 写入一条允许决策；命中同键先删除再插入，保持"最近使用"顺序。 */
    set(entry) {
      if (entry === null || typeof entry !== 'object' || !nonEmptyString(entry.key)) return false;
      entries.delete(entry.key);
      entries.set(entry.key, Object.freeze({ hits: 0, ...entry }));
      trim();
      return true;
    },
    /** 命中即刷新为最新：不增条目，只改 recency 与命中次数。 */
    touch(key) {
      const entry = entries.get(key);
      if (entry === undefined) return false;
      entries.delete(key);
      entries.set(key, Object.freeze({ ...entry, hits: (entry.hits ?? 0) + 1 }));
      return true;
    },
    delete: (key) => entries.delete(key),
    clear: () => {
      entries.clear();
    },
    size: () => entries.size,
    limit: () => capacity,
  });
}
