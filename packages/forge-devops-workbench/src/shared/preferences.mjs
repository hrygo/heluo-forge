/**
 * DOP 工作台个人定制偏好持久化与校验（CORP-DSH-DESIGN-028 §4.1 & §6）。
 *
 * 严格约束：
 *   1. 无任何分队/小组字段（拒绝 squadId / activeSquadId / teamId）；
 *   2. 只持久化 rolePreset 与三大进展板、五大领域页签的显隐与排序，绝不混存凭据或业务正文。
 */
import { ERROR_CODES, WorkbenchError } from './errors.mjs';

export const BOARD_KEYS = Object.freeze(['requirement', 'implementation', 'project']);
export const DOMAIN_KEYS = Object.freeze(['requirement', 'project', 'dev', 'efficiency', 'test']);

export const ROLE_PRESETS = Object.freeze({
  biz_mgr: Object.freeze({
    visibleBoards: ['requirement', 'project'],
    boardOrder: ['requirement', 'project', 'implementation'],
    visibleDomains: ['requirement', 'project', 'test'],
    domainOrder: ['requirement', 'project', 'test', 'dev', 'efficiency'],
  }),
  req_mgr: Object.freeze({
    visibleBoards: ['requirement', 'implementation', 'project'],
    boardOrder: ['requirement', 'implementation', 'project'],
    visibleDomains: ['requirement', 'project', 'dev', 'efficiency', 'test'],
    domainOrder: ['requirement', 'project', 'dev', 'efficiency', 'test'],
  }),
  dev_owner: Object.freeze({
    visibleBoards: ['implementation', 'requirement', 'project'],
    boardOrder: ['implementation', 'requirement', 'project'],
    visibleDomains: ['requirement', 'dev', 'test', 'project', 'efficiency'],
    domainOrder: ['requirement', 'dev', 'test', 'project', 'efficiency'],
  }),
  tech_lead: Object.freeze({
    visibleBoards: ['project', 'implementation', 'requirement'],
    boardOrder: ['project', 'implementation', 'requirement'],
    visibleDomains: ['requirement', 'project', 'dev', 'efficiency', 'test'],
    domainOrder: ['requirement', 'project', 'dev', 'efficiency', 'test'],
  }),
  custom: null,
});

export const VALID_ROLE_PRESETS = Object.freeze(Object.keys(ROLE_PRESETS));

export const DEFAULT_PREFERENCES = Object.freeze({
  rolePreset: 'req_mgr',
  visibleBoards: Object.freeze(['requirement', 'implementation', 'project']),
  boardOrder: Object.freeze(['requirement', 'implementation', 'project']),
  visibleDomains: Object.freeze(['requirement', 'project', 'dev', 'efficiency', 'test']),
  domainOrder: Object.freeze(['requirement', 'project', 'dev', 'efficiency', 'test']),
});

const ALLOWED_PATCH_KEYS = new Set([
  'rolePreset',
  'visibleBoards',
  'boardOrder',
  'visibleDomains',
  'domainOrder',
]);

const FORBIDDEN_PATCH_KEYS = new Set([
  'squadId',
  'activeSquadId',
  'squad',
  'teamId',
  'groupId',
  'token',
  'authorization',
  'credential',
  '_tk',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function normalizeOrder(list, validPool, fieldName) {
  if (!Array.isArray(list)) {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `${fieldName} 必须为数组`);
  }
  const poolSet = new Set(validPool);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || !poolSet.has(item)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `${fieldName} 包含未定义标识: ${String(item)}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  for (const fallback of validPool) {
    if (!seen.has(fallback)) out.push(fallback);
  }
  return out;
}

function normalizeSubset(list, validPool, fieldName, minCount = 0) {
  if (!Array.isArray(list)) {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `${fieldName} 必须为数组`);
  }
  const poolSet = new Set(validPool);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || !poolSet.has(item)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `${fieldName} 包含未定义标识: ${String(item)}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  if (out.length < minCount) {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `${fieldName} 至少需要保留 ${minCount} 项`);
  }
  return out;
}

/**
 * 校验并合并用户定制偏好补丁。
 *
 * @param {unknown} input
 * @param {object} [base]
 */
export function validatePreferencesPatch(input, base = DEFAULT_PREFERENCES) {
  if (!isPlainObject(input)) {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '定制参数必须为对象');
  }
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_PATCH_KEYS.has(key) || !ALLOWED_PATCH_KEYS.has(key)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `不允许的定制字段: ${key}`);
    }
  }

  let rolePreset = base.rolePreset ?? DEFAULT_PREFERENCES.rolePreset;
  let visibleBoards = [...(base.visibleBoards ?? DEFAULT_PREFERENCES.visibleBoards)];
  let boardOrder = [...(base.boardOrder ?? DEFAULT_PREFERENCES.boardOrder)];
  let visibleDomains = [...(base.visibleDomains ?? DEFAULT_PREFERENCES.visibleDomains)];
  let domainOrder = [...(base.domainOrder ?? DEFAULT_PREFERENCES.domainOrder)];

  if (input.rolePreset !== undefined) {
    if (!VALID_ROLE_PRESETS.includes(input.rolePreset)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `不支持的角色预设: ${String(input.rolePreset)}`);
    }
    rolePreset = input.rolePreset;
    const preset = ROLE_PRESETS[rolePreset];
    if (preset) {
      visibleBoards = [...preset.visibleBoards];
      boardOrder = [...preset.boardOrder];
      visibleDomains = [...preset.visibleDomains];
      domainOrder = [...preset.domainOrder];
    }
  }

  if (input.visibleBoards !== undefined) {
    visibleBoards = normalizeSubset(input.visibleBoards, BOARD_KEYS, 'visibleBoards', 0);
  }
  if (input.boardOrder !== undefined) {
    boardOrder = normalizeOrder(input.boardOrder, BOARD_KEYS, 'boardOrder');
  }
  if (input.visibleDomains !== undefined) {
    visibleDomains = normalizeSubset(input.visibleDomains, DOMAIN_KEYS, 'visibleDomains', 1);
  }
  if (input.domainOrder !== undefined) {
    domainOrder = normalizeOrder(input.domainOrder, DOMAIN_KEYS, 'domainOrder');
  }

  return Object.freeze({
    rolePreset,
    visibleBoards,
    boardOrder,
    visibleDomains,
    domainOrder,
  });
}

/**
 * 创建个人定制偏好存储。
 * 默认使用进程内存 Map 按 userKey 隔离；支持注入可选 storage（get/set）对接宿主持久化。
 */
export function createPreferencesStore({ storage = null } = {}) {
  const memory = new Map();

  async function get(userKey = 'default') {
    const key = String(userKey || 'default');
    if (storage && typeof storage.get === 'function') {
      try {
        const stored = await storage.get(key);
        if (isPlainObject(stored)) {
          return validatePreferencesPatch(stored, DEFAULT_PREFERENCES);
        }
      } catch {
        // 读失败回退默认布局，不阻塞工作台展示（CORP-DSH-DESIGN-028 §6）
      }
    }
    return memory.get(key) ?? DEFAULT_PREFERENCES;
  }

  async function save(userKey = 'default', patch = {}) {
    const key = String(userKey || 'default');
    const current = await get(key);
    const next = validatePreferencesPatch(patch, current);
    if (storage && typeof storage.set === 'function') {
      try {
        await storage.set(key, next);
      } catch (err) {
        throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, '保存工作台定制偏好失败', {
          upstream: 'preferences-store',
          retryable: true,
          cause: err,
        });
      }
    }
    memory.set(key, next);
    return next;
  }

  function clear() {
    memory.clear();
  }

  return Object.freeze({ get, save, clear });
}
