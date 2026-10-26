/**
 * 必要审计：前置可写才算通过，执行后补记失败只记缺口。
 *
 * 记录按独立允许字段最小化：不含凭据、业务正文、参数值或 stdout/stderr。
 * 前置审计不可写或超时 → 该动作零执行；执行后补记失败 → 保留结果与缺口，
 * 并把后续动作限制为需显式确认缺口后才恢复（不自动重放写）。
 */

export class PolicyAuditError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyAuditError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

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
]);

const FORBIDDEN_FIELDS = new Set(['arguments', 'args', 'stdout', 'stderr', 'content', 'body', 'output', 'token', 'secret', 'credential']);

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
 * @param {{sink?: {durable?: boolean, append?: Function}, timeoutMs?: number, allowNonDurable?: boolean,
 *   now?: () => number, onGap?: Function}} [options]
 */
export function createAuditBarrier(options = {}) {
  const clock = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 2_000;
  const gaps = [];
  let sink = options.sink;
  let degraded = false;

  function checkSink() {
    if (sink === undefined || sink === null || typeof sink.append !== 'function') {
      throw new PolicyAuditError('no audit sink is available', 'POLICY_AUDIT_UNAVAILABLE');
    }
    if (sink.durable !== true && options.allowNonDurable !== true) {
      throw new PolicyAuditError(
        'the audit sink is not durable; a non-durable sink needs allowNonDurable for dev or pilot use',
        'POLICY_AUDIT_NOT_DURABLE',
      );
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
    checkSink();
    const entry = buildAuditRecord({ ...record, phase: 'begin', observedAt: record.observedAt ?? clock() });
    try {
      await withTimeout(Promise.resolve(sink.append(entry)), timeoutMs, 'POLICY_AUDIT_TIMEOUT');
    } catch (error) {
      if (error instanceof PolicyAuditError && error.code === 'POLICY_AUDIT_TIMEOUT') throw error;
      throw new PolicyAuditError(`audit sink rejected the record: ${error?.message ?? error}`, 'POLICY_AUDIT_UNAVAILABLE', {
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

  /** Optional telemetry: failures only leave a gap and never block work. */
  async function optional(name, operation) {
    try {
      return { action: 'ok', value: await operation() };
    } catch (error) {
      return { action: 'gap', gap: recordGap({ kind: 'optional-failed', action: name, error: String(error?.message ?? error) }) };
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
    optional,
    gaps: () => [...gaps],
    acknowledgeGaps: () => {
      const cleared = gaps.splice(0);
      degraded = false;
      return cleared.length;
    },
    isDegraded: () => degraded,
    // Used only by the execution barrier when unload or a broken settlement
    // leaves an admitted action without an authoritative final outcome.
    abandon: (receipt, reason) => {
      degraded = true;
      return recordGap({ kind: 'outcome-unavailable', action: receipt.receipt.action,
        target: receipt.receipt.target, outcome: 'unknown', reason });
    },
  };
}
