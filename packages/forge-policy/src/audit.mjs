/**
 * 恒开审计：`begin` 先落、执行后 `settle` 补 `durationMs`/`decision`。
 *
 * memory sink 是进程内环形缓冲（默认 1000，超出覆盖最旧）；file sink 按天一个
 * JSONL 文件、保留 `keepDays` 天。写入失败（权限/磁盘/路径不可写）**中止本次
 * 受控调用**，由门禁给出可操作建议，绝不静默落回 memory。
 *
 * 记录按独立允许字段最小化：不含凭据、业务正文、参数原文或 stdout/stderr；
 * `params` 只存摘要，路径只留尾 4 段（D57）。
 */

import { mkdir, appendFile, readdir, unlink } from 'node:fs/promises';

export class PolicyAuditError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyAuditError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// 证据字段：策略版本、命中的规则、身份与批准人分列、未判定的事实源。
// 仍不含参数值、正文、凭据或输出；数组只保存短标识。
const ALLOWED_FIELDS = new Set([
  'subject',
  'action',
  'target',
  'tool',
  'decision',
  'rule',
  'operationId',
  'revision',
  'observedAt',
  'durationMs',
  'phase',
  'policyVersion',
  'orgDigest',
  'ruleIds',
  'actor',
  'approver',
  'unevaluated',
  'contentSkipped',
  'mode',
  'contentDigest',
  'agent',
  'summary',
  'params',
  'truncated',
]);

const FORBIDDEN_FIELDS = new Set(['arguments', 'args', 'stdout', 'stderr', 'content', 'body', 'output', 'token', 'secret', 'credential']);

const REDACT_SEGMENTS = 4;

/** 参数摘要里的凭据类键整键丢弃，摘要也不落敏感值。 */
const SENSITIVE_KEY = /^(token|secret|password|passwd|credential|credentials|authorization|apiKey|api_key|accessToken|refreshToken)$/iu;

/** 路径只留尾 4 段（D57）：审计要能指认位置，但不落完整本机路径。 */
function redactPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const looksLikePath = /^([A-Za-z]:)?[\\/]/u.test(value);
  if (!looksLikePath) return value.length <= 128 ? value : `${value.slice(0, 127)}…`;
  const separator = value.includes('\\') ? '\\' : '/';
  const segments = value.split(/[\\/]/u).filter((segment) => segment.length > 0);
  return segments.slice(-REDACT_SEGMENTS).join(separator);
}

/** 参数只存摘要：字符串截断、路径脱敏、深度与数组长度受限。 */
function summarizeParams(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactPath(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value).slice(0, 64);
  if (depth >= 2) return '[summary]';
  if (Array.isArray(value)) return Object.freeze(value.slice(0, 8).map((item) => summarizeParams(item, depth + 1)));
  const summary = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (SENSITIVE_KEY.test(key)) continue;
    summary[key] = /^(path|file|filePath|filepath|cwd|root|directory|dir)$/u.test(key) ? redactPath(item) : summarizeParams(item, depth + 1);
  }
  return Object.freeze(summary);
}

function normalizeAgent(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return Object.freeze({ kind: value.slice(0, 32) });
  if (typeof value === 'object' && typeof value.kind === 'string') return Object.freeze({ kind: value.kind.slice(0, 32) });
  return undefined;
}

/**
 * @param {Record<string, unknown>} input candidate record
 * @returns {Record<string, unknown>} minimized record
 */
export function buildAuditRecord(input = {}) {
  const record = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      throw new PolicyAuditError(`audit field "${key}" is never recorded`, 'POLICY_AUDIT_FIELD_FORBIDDEN', { field: key });
    }
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (value === undefined) continue;
    if (key === 'params') {
      record.params = summarizeParams(value);
      continue;
    }
    if (key === 'agent') {
      const agent = normalizeAgent(value);
      if (agent !== undefined) record.agent = agent;
      continue;
    }
    if (key === 'truncated') {
      record.truncated = value === true;
      continue;
    }
    // 数组只保留短标识：命中规则、未判定事实、脱敏片段都不携带正文。
    if (Array.isArray(value)) {
      record[key] = Object.freeze(value.slice(0, 32).map((item) => String(item).slice(0, 128)));
      continue;
    }
    record[key] = typeof value === 'string' ? value.slice(0, 512) : value;
  }
  if (typeof record.action !== 'string' || record.action.length === 0) {
    throw new PolicyAuditError('audit record needs an action', 'POLICY_AUDIT_RECORD_INVALID');
  }
  return Object.freeze(record);
}

async function withTimeout(promise, timeoutMs, code) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new PolicyAuditError(`audit operation timed out after ${timeoutMs}ms`, code)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * memory sink：进程内环形缓冲，超出 `buffer` 覆盖最旧。
 *
 * @param {{buffer?: number, now?: () => number}} [options]
 */
export function createMemorySink(options = {}) {
  const buffer = Number.isInteger(options.buffer) && options.buffer > 0 ? options.buffer : 1_000;
  const clock = options.now ?? (() => Date.now());
  const entries = [];
  return Object.freeze({
    durable: false,
    kind: 'memory',
    append(record) {
      entries.push(record);
      if (entries.length > buffer) entries.splice(0, entries.length - buffer);
    },
    records: () => [...entries],
    size: () => entries.length,
    lastAt: () => (entries.length === 0 ? undefined : entries.at(-1).observedAt ?? clock()),
  });
}

function dayStamp(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function dayStart(now) {
  return Date.parse(`${dayStamp(now)}T00:00:00.000Z`);
}

/**
 * file sink：`<dir>/forge-policy-<YYYY-MM-DD>.jsonl`，一天一文件、UTF-8 JSONL
 * 追加；启动与每次写入前按 `keepDays` 清理同前缀过期文件，目录缺失则创建。
 *
 * @param {{dir: string, keepDays?: number, now?: () => number,
 *   fs?: {mkdir: Function, appendFile: Function, readdir: Function, unlink: Function}}} options
 */
export function createFileSink(options = {}) {
  const dir = options.dir;
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new PolicyAuditError('a file audit sink needs a directory', 'POLICY_AUDIT_SINK_INVALID');
  }
  const keepDays = Number.isInteger(options.keepDays) && options.keepDays > 0 ? options.keepDays : 7;
  const clock = options.now ?? (() => Date.now());
  const fs = {
    mkdir: options.fs?.mkdir ?? mkdir,
    appendFile: options.fs?.appendFile ?? appendFile,
    readdir: options.fs?.readdir ?? readdir,
    unlink: options.fs?.unlink ?? unlink,
  };
  const pattern = /^forge-policy-(\d{4}-\d{2}-\d{2})\.jsonl$/u;

  function file(now = clock()) {
    return `${dir}/forge-policy-${dayStamp(now)}.jsonl`;
  }

  async function prune(now) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    const cutoff = dayStart(now) - (keepDays - 1) * 86_400_000;
    for (const name of names) {
      const match = pattern.exec(String(name));
      if (match === null) continue;
      const stamp = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isNaN(stamp) || stamp >= cutoff) continue;
      try {
        await fs.unlink(`${dir}/${name}`);
      } catch {
        // 清理失败不阻断写入；下次再试。
      }
    }
  }

  return Object.freeze({
    durable: true,
    kind: 'file',
    file,
    async append(record) {
      const now = clock();
      const target = file(now);
      try {
        await fs.mkdir(dir, { recursive: true });
        await prune(now);
        await fs.appendFile(target, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (error) {
        throw new PolicyAuditError(`the audit file sink could not write ${target}`, 'POLICY_AUDIT_WRITE_FAILED', {
          sink: 'file',
          file: target,
          cause: String(error?.message ?? error),
        });
      }
    },
    records: () => [],
    size: () => 0,
  });
}

/**
 * @param {{sink?: object, timeoutMs?: number, now?: () => number, onGap?: Function}} [options]
 */
export function createAuditBarrier(options = {}) {
  const clock = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 2_000;
  const gaps = [];
  let sink = options.sink;
  let degraded = false;

  function requireSink() {
    if (sink === undefined || sink === null || typeof sink.append !== 'function') {
      throw new PolicyAuditError('no audit sink is available', 'POLICY_AUDIT_UNAVAILABLE');
    }
  }

  function recordGap(entry) {
    const gap = Object.freeze({ id: `gap-${gaps.length + 1}`, at: clock(), ...entry });
    gaps.push(gap);
    try {
      options.onGap?.(gap);
    } catch {
      // 观察失败不影响判定。
    }
    return gap;
  }

  /**
   * Mandatory pre-audit. Throws when the record cannot be written, which the
   * caller must turn into a refusal with zero side effects.
   */
  async function begin(record) {
    if (degraded) {
      throw new PolicyAuditError('an earlier audit gap is still outstanding', 'POLICY_AUDIT_GAP_OUTSTANDING');
    }
    requireSink();
    const entry = buildAuditRecord({ ...record, phase: 'begin', observedAt: record.observedAt ?? clock() });
    try {
      await withTimeout(Promise.resolve(sink.append(entry)), timeoutMs, 'POLICY_AUDIT_TIMEOUT');
    } catch (error) {
      if (error instanceof PolicyAuditError && error.code === 'POLICY_AUDIT_TIMEOUT') throw error;
      if (error instanceof PolicyAuditError && error.code === 'POLICY_AUDIT_WRITE_FAILED') throw error;
      throw new PolicyAuditError(`audit sink rejected the record: ${error?.message ?? error}`, 'POLICY_AUDIT_WRITE_FAILED', {
        cause: String(error?.message ?? error),
      });
    }
    return Object.freeze({ receipt: entry, startedAt: clock() });
  }

  /**
   * Post-execution record. A failure here never undoes the executed action; it
   * keeps the outcome plus a gap and degrades the barrier.
   */
  async function settle(receipt, outcome = {}) {
    const entry = buildAuditRecord({
      ...receipt.receipt,
      ...outcome,
      phase: 'settle',
      observedAt: clock(),
      durationMs: clock() - receipt.startedAt,
    });
    try {
      if (sink === undefined || typeof sink.append !== 'function') throw new Error('no audit sink');
      await withTimeout(Promise.resolve(sink.append(entry)), timeoutMs, 'POLICY_AUDIT_TIMEOUT');
      return { action: 'settled', record: entry };
    } catch (error) {
      degraded = true;
      const gap = recordGap({
        kind: 'settle-failed',
        action: entry.action,
        target: entry.target,
        outcome: outcome.decision ?? 'unknown',
        error: String(error?.message ?? error),
      });
      return { action: 'gap', gap, record: entry };
    }
  }

  return {
    setSink: (next) => {
      sink = next;
      return () => {
        sink = options.sink;
      };
    },
    begin,
    settle,
    sinks: () => sink,
    gaps: () => [...gaps],
    acknowledgeGaps: () => {
      const cleared = gaps.splice(0);
      degraded = false;
      return cleared.length;
    },
    isDegraded: () => degraded,
  };
}
