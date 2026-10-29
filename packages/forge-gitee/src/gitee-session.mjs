/**
 * 幂等台账 + 动作证据（AC-16 / AC-24）。
 *
 * 两件事，刻意放在一个模块里，因为它们是同一件事的两面：**做过就记住，记得就有据**。
 *
 * 1. **台账是进程内 `Map`，不落盘**。落盘会让"上一轮跑过"在下一个进程里被误判成"这一轮
 *    已经做过"，而这正是重复建单的另一种写法：跨进程的复用需要平台侧查重来证明，不是本地
 *    一张表说了算。进程退出即忘，重启后由"创建前查重 + 回读"重新确认，这才是可审计的重放语义。
 * 2. **不重放 `unknown`**。台账里记的 `unknown` 意味着"远端可能已经变了"，命中它只能回
 *    人工核对（`replay_blocked`），不许自动再发一次子进程；只有 `failed`（确定未生效）可以
 *    重试，因为它连台账都不写。
 *
 * 幂等键与 r1（`packages/forge-devops/src/actions.mjs` 的 `idempotencyKey`）**逐字同位**：
 * `sha256(变更号|对象类型|归一化标题)` 前 16 位小写十六进制。归一化规则也一样（变更号大写、
 * 标题 NFKC → 折叠空白 → 去首尾 → 小写 → 去尾部标点），因为两个 provider 面对的是**同一个
 * 变更下的同一个对象**：`CHG-2026-001` 在 GitHub 面建过 Issue，在 Gitee 面就绝不该再建一个
 * "同名但键不同"的 Issue。两边算法一旦漂移，双 provider 场景就会二次建单——这是本文件唯一
 * 的跨包不变量，由 `test/session.test.mjs` 的固定向量守住。
 *
 * 证据（`buildEvidence`）只由**白名单字段**拼出来：命令标签、时间、宿主版本、目标、来源类型。
 * 没有 stdout、没有参数正文、没有令牌——"证据不掺假"的底线是它压根装不下别的东西。
 */
import { createHash } from 'node:crypto';

/** 台账默认保留时长：6 小时。超过这个窗口的 `done` 不再复用（重新查重比信任旧表更安全）。 */
export const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** 台账里"不可重放"的状态：命中即 `replay_blocked`，一次子进程都不再发。 */
export const REPLAY_BLOCKED_STATUSES = Object.freeze(['unknown', 'pending']);

/** 台账里"可直接复用"的状态。 */
export const REUSABLE_STATUSES = Object.freeze(['done']);

/** 证据来源词表：`gitee-cli` = 事实来自 CLI 子进程；`policy-only` = 只有门禁裁决；`none` = 无。 */
export const EVIDENCE_SOURCE_TYPES = Object.freeze(['gitee-cli', 'policy-only', 'none']);

/** 证据字段白名单：多一个字段都不进证据（证据是可核对的事实，不是日志）。 */
export const EVIDENCE_FIELDS = Object.freeze(['provider', 'command', 'at', 'hostVersion', 'target', 'sourceType']);

/** 单个证据字段的最大长度：证据里不该出现整篇正文。 */
const EVIDENCE_VALUE_LIMIT = 512;

/** 标题归一化时剥掉的尾部标点（"Fix gate." 与 "fix gate" 是同一个对象）。 */
const TRAILING_PUNCTUATION = /[.。,，;；:：!！?？、]+$/u;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * 标题归一化（与 r1 逐字同式）：NFKC → 折叠空白 → 去首尾 → 小写 → 去尾部标点。
 *
 * 归一化只服务于"这是不是同一个对象"，**不改变写出去的标题**——平台收到的仍是原文。
 */
function normalizeObjectTitle(title) {
  return (typeof title === 'string' ? title : '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

/**
 * 幂等键：`sha256(变更号|对象类型|归一化标题)` 前 16 位十六进制。
 *
 * @param {{ change?: string, objectType?: string, title?: string }} input
 * @returns {string} 16 位小写十六进制
 */
export function idempotencyKey({ change, objectType, title } = {}) {
  const changeId = text(change).toUpperCase();
  const type = text(objectType);
  const normalized = normalizeObjectTitle(title);
  if (changeId === '') throw new TypeError('幂等键缺少变更号（change）');
  if (type === '') throw new TypeError('幂等键缺少对象类型（objectType）');
  if (normalized === '') throw new TypeError('幂等键缺少可归一化的标题（title）');
  return createHash('sha256').update(`${changeId}|${type}|${normalized}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 幂等台账（进程内，不落盘）。
 *
 * @param {{ now?: () => number, ttlMs?: number }} [options]
 * @returns {{ lookup: (key: string) => object|undefined, record: (entry: object) => object,
 *   forget: (key: string) => boolean, size: () => number }}
 */
export function createGiteeSession({ now = Date.now, ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  if (typeof now !== 'function') throw new TypeError('幂等台账的 now 必须是返回毫秒数的函数');
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_SESSION_TTL_MS;
  /** @type {Map<string, object>} */
  const entries = new Map();

  const expired = (entry) => now() - entry.at > ttl;

  /** 惰性清理：读的时候顺带丢过期的，不额外起定时器（卸载后不该有活着的东西）。 */
  function purge() {
    for (const [key, entry] of entries) {
      if (expired(entry)) entries.delete(key);
    }
  }

  function lookup(key) {
    const id = text(key);
    if (id === '') return undefined;
    const entry = entries.get(id);
    if (entry === undefined) return undefined;
    if (expired(entry)) {
      entries.delete(id);
      return undefined;
    }
    return entry;
  }

  function record(raw = {}) {
    const key = text(raw.key);
    if (key === '') throw new TypeError('台账条目缺少幂等键（key）');
    const status = text(raw.status);
    if (status === '') throw new TypeError('台账条目缺少状态（status）');
    const entry = Object.freeze({
      key,
      status,
      action: text(raw.action) || null,
      target: text(raw.target) || null,
      objectRef: text(raw.objectRef) || null,
      at: now(),
      evidence: raw.evidence !== null && typeof raw.evidence === 'object' ? raw.evidence : null,
    });
    entries.set(key, entry);
    purge();
    return entry;
  }

  function forget(key) {
    return entries.delete(text(key));
  }

  return Object.freeze({
    lookup,
    record,
    forget,
    size: () => {
      purge();
      return entries.size;
    },
  });
}

/**
 * 构造动作证据（只由白名单字段组成）。
 *
 * `sourceType` 描述的是**证据来源**，不是"是否真的联调过"：`gitee-cli` 表示这一条来自 CLI
 * 子进程（命令标签与时间可复核），`policy-only` 表示只有门禁裁决、没有远端事实。未联调项
 * 不靠这里声明，靠 README 的 NOT RUN 清单——把"没跑"写成 `done` 才是造假。
 *
 * @param {{ command?: string, at?: string, hostVersion?: string|null, target?: string,
 *   sourceType?: string }} input
 * @returns {Readonly<Record<string, string|null>>}
 */
export function buildEvidence({ command, at, hostVersion = null, target, sourceType = 'gitee-cli' } = {}) {
  const source = text(sourceType) || 'gitee-cli';
  if (!EVIDENCE_SOURCE_TYPES.includes(source)) {
    throw new TypeError(`证据来源必须是 ${EVIDENCE_SOURCE_TYPES.join('|')}，收到 ${source}`);
  }
  const clip = (value) => {
    const flat = text(value);
    if (flat === '') return null;
    return flat.length <= EVIDENCE_VALUE_LIMIT ? flat : `${flat.slice(0, EVIDENCE_VALUE_LIMIT - 1)}…`;
  };
  const stamp = text(at) || new Date().toISOString();
  return Object.freeze({
    provider: 'gitee',
    command: clip(command),
    at: stamp,
    hostVersion: clip(hostVersion),
    target: clip(target),
    sourceType: source,
  });
}
