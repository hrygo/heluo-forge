/**
 * `/policy-audit` 的纯展示层：条数解析、时间与行格式化、空态/不可读文案。
 *
 * 只做格式化，不读 sink、不写审计、不改策略状态；命令面拿到 sink 快照后调用这里。
 * 输出刻意保持一屏可读：八列、一行一条、缺省 `-`，不含参数原文、业务正文、
 * 凭据或绝对路径。
 */

export const DEFAULT_AUDIT_LIMIT = 20;
export const MAX_AUDIT_LIMIT = 200;

/** 固定列头；列序在文档与测试里同步。 */
export const AUDIT_COLUMNS = '时间 | 阶段 | 动作 | 目标 | 决策 | 规则 | 耗时 | agent.kind';

export const AUDIT_EMPTY_COPY = '暂无审计记录：先执行一次受控写，或开启任一规则后重试。';
export const AUDIT_UNREADABLE_COPY = '审计源不可读：请检查 audit.sink 配置与日志目录权限后重试。';

const TRUNCATION_MARK = '…';

function truncate(value, max) {
  if (value === undefined || value === null || value === '') return '-';
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}${TRUNCATION_MARK}` : text;
}

/** 路径形状的目标只展示最后一段，避免把目录结构带进输出。 */
function displayTarget(value) {
  if (typeof value !== 'string' || value.trim() === '') return '-';
  if (/[\\/]/u.test(value)) {
    const segments = value.split(/[\\/]+/u).filter((segment) => segment !== '');
    return truncate(segments.at(-1), 48);
  }
  return truncate(value, 48);
}

/**
 * 解析命令输入里的条数。
 *
 * 空输入与非法输入都回落到默认 20；超过上限截断到 200；两者分别附带一句提示，
 * 提示只说明条数的处理，不暴露内部实现。
 *
 * @param {unknown} raw
 * @returns {{limit: number, note?: string}}
 */
export function parseAuditCount(raw) {
  if (raw === undefined || raw === null) return { limit: DEFAULT_AUDIT_LIMIT };
  const text = String(raw).trim();
  if (text === '') return { limit: DEFAULT_AUDIT_LIMIT };
  if (!/^[+-]?\d+$/u.test(text)) {
    return { limit: DEFAULT_AUDIT_LIMIT, note: '条数需为 1–200 的整数，已回退为 20。' };
  }
  const value = Number(text);
  if (value > MAX_AUDIT_LIMIT) {
    return { limit: MAX_AUDIT_LIMIT, note: `超过上限，只显示最近 ${MAX_AUDIT_LIMIT} 条。` };
  }
  if (value <= 0) {
    return { limit: DEFAULT_AUDIT_LIMIT, note: '条数需为 1–200 的整数，已回退为 20。' };
  }
  return { limit: value };
}

/**
 * UTC 时间列：`YYYY-MM-DD HH:mm:ssZ`；缺失或非时间值给 `-`。
 *
 * @param {unknown} observedAt 毫秒时间戳
 * @returns {string}
 */
export function formatAuditTime(observedAt) {
  const stamp = typeof observedAt === 'number' ? observedAt : Number(observedAt);
  if (!Number.isFinite(stamp)) return '-';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '-';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

function agentKindOf(record) {
  const kind = record?.agent?.kind;
  return typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : 'unknown';
}

function durationOf(record) {
  const value = record?.durationMs;
  return typeof value === 'number' && Number.isFinite(value) ? `${value}ms` : '-';
}

/**
 * 单条审计记录 → 一行（八列）。
 *
 * @param {object} record
 * @returns {string}
 */
export function formatAuditRow(record = {}) {
  return [
    formatAuditTime(record?.observedAt),
    truncate(record?.phase, 16),
    truncate(record?.action, 48),
    displayTarget(record?.target),
    truncate(record?.decision, 16),
    truncate(record?.rule, 32),
    durationOf(record),
    truncate(agentKindOf(record), 32),
  ].join(' | ');
}

/**
 * 读快照 → 命令返回值。`records` 已按"新 → 旧"排好序，这里不再排序。
 *
 * @param {{records?: readonly object[], corrupt?: number, missing?: boolean, unreadable?: boolean}} [snapshot]
 * @returns {{kind: 'success' | 'error', text: string}}
 */
export function formatAuditReport(snapshot = {}) {
  if (snapshot?.unreadable === true) {
    return Object.freeze({ kind: 'error', text: AUDIT_UNREADABLE_COPY });
  }
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  if (records.length === 0) {
    return Object.freeze({ kind: 'error', text: AUDIT_EMPTY_COPY });
  }
  const lines = [`最近 ${records.length} 条审计记录（新 → 旧）`, AUDIT_COLUMNS, ...records.map(formatAuditRow)];
  const corrupt = Number.isInteger(snapshot?.corrupt) ? snapshot.corrupt : 0;
  if (corrupt > 0) lines.push(`另有 ${corrupt} 行无法解析，已跳过。`);
  return Object.freeze({ kind: 'success', text: lines.join('\n') });
}
