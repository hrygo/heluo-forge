// 过程观察投影与有界导出（#36）。规则来源：docs/contracts/metrics-events.md
// （允许清单、幂等/折叠语义、§5.2 失败与重送、§7 负向用例）。
//
// 三条硬约束：
//   1. 只接受契约列出的字段；未知字段、未知枚举、未知版本、超限载荷一律**整条拒绝**，
//      拒绝结果只给原因码，不回显任何载荷内容（也不做"敏感词扫描"式放行）。
//   2. 观察链路的任何故障都只降级观察，不抛出给调用方，不改变必要审计与判定结果；
//      这里有界内存缓冲，**不建磁盘队列**（未获准的持久化通道一律不落盘）。
//   3. 导出默认关闭；关闭时 start() 不注册任何发送，exportOnce() 直接返回 skipped。

export const SCHEMA_VERSION = 'forge.observation.v1';

export const EVENT_NAMES = Object.freeze([
  'forge.change.accepted',
  'forge.tool.completed',
  'forge.tool.reconciled',
  'forge.decision.requested',
  'forge.observation.loss',
]);

export const ACCESS_KINDS = Object.freeze(['read', 'development_write', 'review_write', 'local']);

/** 引用类字段：不透明标识，只允许受控字符集与长度。 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
/** 纯 64 位十六进制是"自由文本的哈希"最常见的伪装形态，直接拒绝。 */
const HEX_DIGEST_PATTERN = /^[0-9a-f]{32,}$/iu;
const SOURCE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

const COMMON_REQUIRED = ['schema_version', 'event_id', 'event_name', 'source_version', 'emitted_at'];

/**
 * 每事件的适用字段。`required` 与 `optional` 之外的字段一律按"不适用"拒绝：
 * 这样"合法字段承载不适用的含义"也会被挡住，而不是只挡未知字段名。
 */
const EVENT_SPECS = Object.freeze({
  'forge.change.accepted': {
    required: ['change_ref', 'repository_ref'],
    optional: ['project_ref', 'system_ref', 'occurred_at'],
  },
  'forge.tool.completed': {
    required: ['operation_id', 'action', 'access_kind', 'status'],
    optional: ['result_version', 'occurred_at', 'duration_ms', 'error_code', 'change_ref', 'project_ref'],
  },
  'forge.tool.reconciled': {
    required: ['operation_id', 'result_version', 'action', 'access_kind', 'status'],
    optional: ['occurred_at', 'duration_ms', 'error_code', 'change_ref', 'project_ref'],
  },
  'forge.decision.requested': {
    required: ['decision_kind', 'change_ref'],
    optional: ['occurred_at', 'project_ref', 'system_ref'],
  },
  'forge.observation.loss': {
    required: ['loss_reason', 'loss_count', 'window_start', 'window_end'],
    optional: [],
  },
});

export const REJECTION_REASONS = Object.freeze([
  'NOT_AN_OBJECT',
  'UNKNOWN_VERSION',
  'UNKNOWN_EVENT',
  'MISSING_FIELD',
  'UNKNOWN_FIELD',
  'NOT_APPLICABLE_FIELD',
  'INVALID_TYPE',
  'INVALID_ENUM',
  'INVALID_REF',
  'INVALID_TIME',
  'OVERSIZE',
]);

class Rejection {
  constructor(reason) {
    this.reason = reason;
  }
}

const reject = (reason) => {
  throw new Rejection(reason);
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 建立一个投影器。`enums` 由调用方给出**已登记**的枚举集合：本模块不发明
 * 状态/动作/错误码取值，只强制"必须是受控枚举中的一员"。
 *
 * @param {{
 *   maxEventBytes?: number,
 *   enums?: { status?: string[], action?: string[], errorCode?: string[], decisionKind?: string[], lossReason?: string[] },
 * }} [options]
 */
export function createProjection(options = {}) {
  const maxEventBytes = options.maxEventBytes ?? 8192;
  const enums = options.enums ?? {};
  const listFor = (name) => (Array.isArray(enums[name]) ? enums[name] : []);

  const assertEnum = (field, value, listName) => {
    const allowed = listFor(listName);
    if (allowed.length === 0) reject('INVALID_ENUM');
    if (typeof value !== 'string' || !allowed.includes(value)) reject('INVALID_ENUM');
  };

  const assertRef = (value) => {
    if (typeof value !== 'string') reject('INVALID_TYPE');
    if (!REF_PATTERN.test(value) || HEX_DIGEST_PATTERN.test(value)) reject('INVALID_REF');
  };

  const assertTime = (value) => {
    if (typeof value !== 'string' || !TIME_PATTERN.test(value)) reject('INVALID_TIME');
  };

  const validateField = (key, value) => {
    switch (key) {
      case 'schema_version':
        if (value !== SCHEMA_VERSION) reject('UNKNOWN_VERSION');
        return;
      case 'event_name':
        if (typeof value !== 'string') reject('INVALID_TYPE');
        if (!EVENT_NAMES.includes(value)) reject('UNKNOWN_EVENT');
        return;
      case 'event_id':
        assertRef(value);
        return;
      case 'source_version':
        if (typeof value !== 'string' || !SOURCE_VERSION_PATTERN.test(value)) reject('INVALID_TYPE');
        return;
      case 'occurred_at':
      case 'emitted_at':
      case 'window_start':
      case 'window_end':
        assertTime(value);
        return;
      case 'operation_id':
      case 'change_ref':
      case 'repository_ref':
      case 'project_ref':
      case 'system_ref':
        assertRef(value);
        return;
      case 'result_version':
        if (!Number.isInteger(value) || value < 1) reject('INVALID_TYPE');
        return;
      case 'duration_ms':
        if (!Number.isFinite(value) || value < 0) reject('INVALID_TYPE');
        return;
      case 'loss_count':
        if (!Number.isInteger(value) || value < 0) reject('INVALID_TYPE');
        return;
      case 'access_kind':
        if (typeof value !== 'string' || !ACCESS_KINDS.includes(value)) reject('INVALID_ENUM');
        return;
      case 'status':
        assertEnum(key, value, 'status');
        return;
      case 'action':
        assertEnum(key, value, 'action');
        return;
      case 'error_code':
        assertEnum(key, value, 'errorCode');
        return;
      case 'decision_kind':
        assertEnum(key, value, 'decisionKind');
        return;
      case 'loss_reason':
        assertEnum(key, value, 'lossReason');
        return;
      default:
        reject('UNKNOWN_FIELD');
    }
  };

  return {
    maxEventBytes,
    /**
     * 投影一条候选事件。
     * @returns {{ok: true, event: object} | {ok: false, reason: string}}
     */
    project(input) {
      try {
        if (!isPlainObject(input)) reject('NOT_AN_OBJECT');
        const name = input.event_name;
        if (typeof name !== 'string' || !EVENT_NAMES.includes(name)) {
          reject(typeof name === 'string' ? 'UNKNOWN_EVENT' : 'MISSING_FIELD');
        }
        const spec = EVENT_SPECS[name];
        const allowed = new Set([...COMMON_REQUIRED, ...spec.required, ...spec.optional]);
        for (const key of Object.keys(input)) {
          if (!allowed.has(key)) {
            // 契约里的固定字段但对该事件不适用，与完全未知的字段分开报，便于定位。
            reject(Object.hasOwn(input, key) && isKnownField(key) ? 'NOT_APPLICABLE_FIELD' : 'UNKNOWN_FIELD');
          }
        }
        for (const key of [...COMMON_REQUIRED, ...spec.required]) {
          if (!Object.hasOwn(input, key)) reject('MISSING_FIELD');
        }
        // 大小上限按整条事件判断，超限整条拒绝，绝不截断后当合法事件发送。
        const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
        if (bytes > maxEventBytes) reject('OVERSIZE');
        for (const [key, value] of Object.entries(input)) validateField(key, value);
        // 事件自身的适用性：reconciled 是修订，不是第二次动作。
        if (name === 'forge.tool.reconciled' && input.result_version === undefined) reject('MISSING_FIELD');
        if (name === 'forge.observation.loss' && input.loss_count === 0) reject('INVALID_TYPE');
        return { ok: true, event: Object.freeze({ ...input }) };
      } catch (error) {
        if (error instanceof Rejection) return { ok: false, reason: error.reason };
        throw error;
      }
    },
  };
}

const KNOWN_FIELDS = new Set([
  ...COMMON_REQUIRED,
  ...Object.values(EVENT_SPECS).flatMap((spec) => [...spec.required, ...spec.optional]),
]);

function isKnownField(key) {
  return KNOWN_FIELDS.has(key);
}

/**
 * 按 `operation_id` 折叠逻辑动作：同一动作的多次观察只算一次，`result_version`
 * 取最高者；乱序输入与重复重送不扩大分母。
 *
 * @param {Array<object>} events
 * @returns {{events: object[], operationCount: number, versions: Map<string, number>}}
 */
export function foldByOperation(events) {
  const byOperation = new Map();
  const anonymous = [];
  for (const event of events) {
    if (typeof event.operation_id !== 'string') {
      anonymous.push(event);
      continue;
    }
    const current = byOperation.get(event.operation_id);
    if (current === undefined) {
      byOperation.set(event.operation_id, event);
      continue;
    }
    const nextVersion = event.result_version ?? 1;
    const currentVersion = current.result_version ?? 1;
    // 版本更高才替换；同版本保留先到者（重复重送不改变结果）。
    if (nextVersion > currentVersion) byOperation.set(event.operation_id, event);
  }
  return {
    events: [...anonymous, ...byOperation.values()],
    operationCount: byOperation.size,
    versions: new Map([...byOperation].map(([id, event]) => [id, event.result_version ?? 1])),
  };
}

/**
 * 有界内存缓冲：默认上限 1000 条 / 4 MiB / 24 小时 TTL，先到即拒绝新增并计数；
 * 不落盘（持久离线队列需要企业既有机制单独批准）。
 */
export function createBoundedBuffer(options = {}) {
  const maxEvents = options.maxEvents ?? 1000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  /** @type {Map<string, {event: object, bytes: number, addedAt: number}>} */
  const entries = new Map();
  const dropped = { capacity: 0, bytes: 0, ttl: 0 };
  let bytes = 0;

  const evictExpired = () => {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.addedAt <= cutoff) {
        entries.delete(id);
        bytes -= entry.bytes;
        dropped.ttl += 1;
      }
    }
  };

  return {
    add(event) {
      evictExpired();
      if (entries.has(event.event_id)) return { ok: true, duplicate: true };
      const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (entries.size >= maxEvents) {
        dropped.capacity += 1;
        return { ok: false, reason: 'CAPACITY' };
      }
      if (bytes + size > maxBytes) {
        dropped.bytes += 1;
        return { ok: false, reason: 'BYTES' };
      }
      entries.set(event.event_id, { event, bytes: size, addedAt: now() });
      bytes += size;
      return { ok: true, duplicate: false };
    },
    /** 取出前 n 条（不删除）：只有被明确确认的项才会移除。 */
    peek(limit = 50) {
      evictExpired();
      return [...entries.values()].slice(0, limit).map((entry) => entry.event);
    },
    /** 只移除被确认的项，未确认项保留以便重送。 */
    ack(ids) {
      let removed = 0;
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry === undefined) continue;
        entries.delete(id);
        bytes -= entry.bytes;
        removed += 1;
      }
      return removed;
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    stats() {
      evictExpired();
      return { events: entries.size, bytes, maxEvents, maxBytes, ttlMs, dropped: { ...dropped } };
    },
  };
}

export const AUTH_STOP_STATUSES = Object.freeze([401, 403]);
/** 服务端退避提示的下限保护：提示为 0 或缺失时不至于变成"立刻重试"。 */
const MIN_BACKOFF_MS = 250;

/**
 * 有界导出：默认关闭；401/403 停止；429 按服务端提示或指数退避（封顶 5 分钟、带抖动）；
 * 连续失败到阈值后暂停；响应未知时只有提供方保证幂等才有限重送。
 */
export function createBoundedExporter(options = {}) {
  const buffer = options.buffer;
  const send = options.send;
  const enabled = options.enabled ?? false;
  const batchSize = options.batchSize ?? 50;
  const baseBackoffMs = options.baseBackoffMs ?? 1000;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60 * 1000;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
  const idempotentProvider = options.idempotentProvider ?? false;
  const maxUnknownRetries = options.maxUnknownRetries ?? 2;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  const state = {
    status: enabled ? 'idle' : 'disabled',
    consecutiveFailures: 0,
    unknownRetries: 0,
    nextAttemptAt: 0,
    lastResult: null,
  };

  const stop = (status) => {
    // The state name is separate from the HTTP code: a stopped export must stay
    // stopped on every later attempt, not only on the attempt that saw the 401.
    state.status = 'stopped-auth';
    state.lastResult = { status: 'stopped', code: status };
    return state.lastResult;
  };

  const backoff = (hintMs) => {
    const exponent = Math.min(state.consecutiveFailures, 8);
    const base = Math.min(baseBackoffMs * 2 ** exponent, maxBackoffMs);
    const jitter = Math.floor(base * 0.2 * random());
    const delay = Math.min(base + jitter, maxBackoffMs);
    // 服务端给出有效退避提示时**以提示为准**（只做下限保护与封顶）：把提示改写成自己的
    // 指数退避会提前重试，正是限流场景下最容易把对方打垮的行为。
    const applied = Number.isFinite(hintMs) && hintMs > 0
      ? Math.min(Math.max(hintMs, MIN_BACKOFF_MS), maxBackoffMs)
      : delay;
    state.nextAttemptAt = now() + applied;
    return applied;
  };

  return {
    state,
    get enabled() {
      return enabled;
    },
    /**
     * 跑一次导出。任何失败都只反映在返回值与状态里，**不抛出**：
     * 观察链路故障不得阻塞研发。
     */
    async exportOnce() {
      if (!enabled) {
        state.status = 'disabled';
        return { status: 'skipped', reason: 'DISABLED' };
      }
      if (state.status === 'stopped-auth' || state.status === 'paused') {
        return { status: 'skipped', reason: state.status === 'paused' ? 'PAUSED' : 'AUTH_STOPPED' };
      }
      if (now() < state.nextAttemptAt) {
        return { status: 'skipped', reason: 'BACKOFF' };
      }
      const batch = buffer.peek(batchSize);
      if (batch.length === 0) {
        state.lastResult = { status: 'empty' };
        return state.lastResult;
      }
      let response;
      try {
        response = await send(batch);
      } catch {
        // 响应未知（超时/连接中断）：只有提供方保证幂等才有限重送，否则暂停。
        if (idempotentProvider && state.unknownRetries < maxUnknownRetries) {
          state.unknownRetries += 1;
          state.consecutiveFailures += 1;
          backoff();
          state.lastResult = { status: 'retry', reason: 'UNKNOWN_RESPONSE' };
          return state.lastResult;
        }
        state.status = 'paused';
        state.lastResult = { status: 'paused', reason: 'UNKNOWN_RESPONSE' };
        return state.lastResult;
      }
      const code = response?.status;
      if (AUTH_STOP_STATUSES.includes(code)) return stop(code);
      if (code === 429) {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= maxConsecutiveFailures) {
          state.status = 'paused';
          state.lastResult = { status: 'paused', reason: 'RATE_LIMITED' };
          return state.lastResult;
        }
        const delay = backoff(response?.retryAfterMs);
        state.lastResult = { status: 'backoff', delayMs: delay };
        return state.lastResult;
      }
      if (code !== undefined && code >= 500) {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= maxConsecutiveFailures) {
          state.status = 'paused';
          state.lastResult = { status: 'paused', reason: 'SERVER_ERROR' };
          return state.lastResult;
        }
        const delay = backoff(response?.retryAfterMs);
        state.lastResult = { status: 'backoff', delayMs: delay };
        return state.lastResult;
      }
      // 成功：只移除被明确确认的项，其余保留并保持 event_id。
      const acked = Array.isArray(response?.ack) ? response.ack : [];
      const removed = buffer.ack(acked);
      state.consecutiveFailures = 0;
      state.unknownRetries = 0;
      state.status = 'idle';
      state.lastResult = { status: 'sent', accepted: removed, pending: batch.length - removed };
      return state.lastResult;
    },
    /** 人工/定时恢复：从暂停回到可导出。 */
    resume() {
      if (state.status === 'paused') {
        state.status = 'idle';
        state.consecutiveFailures = 0;
        state.unknownRetries = 0;
        state.nextAttemptAt = 0;
        return true;
      }
      return false;
    },
  };
}

/**
 * loss 事件的构造器。**不递归**：loss 事件本身失败只计入本地计数，不再生成新事件。
 */
export function createLossReporter(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const project = options.project;
  const counters = { emitted: 0, suppressed: 0 };
  return {
    counters,
    /** @returns {object|null} 可直接送入缓冲的 loss 事件；被投影拒绝时返回 null 并计数。 */
    report({ reason, count, windowStart, windowEnd }) {
      const candidate = {
        schema_version: SCHEMA_VERSION,
        event_id: `loss-${counters.emitted + 1}`,
        event_name: 'forge.observation.loss',
        source_version: options.sourceVersion ?? '0.1.0',
        emitted_at: now(),
        loss_reason: reason,
        loss_count: count,
        window_start: windowStart,
        window_end: windowEnd,
      };
      const result = project.project(candidate);
      if (!result.ok) {
        counters.suppressed += 1;
        return null;
      }
      counters.emitted += 1;
      return result.event;
    },
  };
}

/**
 * 把投影与导出接进插件的运行路径（#36）。
 *
 * 只把 `enabled` 做成配置：端点、认证资源、批量与响应格式属于契约明确"不由本仓库
 * 发明"的部分，因此发送方必须来自宿主已有的服务（`observationSink`）。启用但没有
 * 发送方时按 fail-closed 记为 `no-provider`，一次也不发。
 *
 * @param {{
 *   config?: { export?: { enabled?: boolean, idempotentProvider?: boolean }, enums?: object },
 *   getSink?: () => ({ send?: Function } | undefined),
 *   sourceVersion?: string,
 * }} [options]
 */
export function createObservationRuntime(options = {}) {
  const exportConfig = options.config?.export ?? {};
  const enabled = exportConfig.enabled === true;
  const project = createProjection({ enums: options.config?.enums ?? {} });
  const buffer = enabled ? createBoundedBuffer({ now: options.now }) : null;
  let status = enabled ? 'idle' : 'disabled';
  let exporter = null;
  // 工具类事件必须落在"已登记枚举"里才可能通过投影；一条枚举都没给就显式停在
  // `unregistered-enums`，而不是让每个事件被静默拒绝。
  const enumLists = options.config?.enums ?? {};
  const hasToolEnums = ['status', 'action'].every((name) => Array.isArray(enumLists[name]) && enumLists[name].length > 0);
  if (enabled && !hasToolEnums) status = 'unregistered-enums';
  if (enabled && hasToolEnums) {
    let sink;
    try {
      sink = options.getSink?.();
    } catch {
      // 宿主服务查找失败等同于没有发送方：观察链路不得因此影响研发路径。
      sink = undefined;
    }
    if (sink !== undefined && sink !== null && typeof sink.send === 'function') {
      exporter = createBoundedExporter({
        buffer,
        enabled: true,
        send: (batch) => sink.send(batch),
        idempotentProvider: exportConfig.idempotentProvider === true,
        batchSize: exportConfig.batchSize,
      });
      status = 'ready';
    } else {
      status = 'no-provider';
    }
  }
  return {
    project,
    fold: foldByOperation,
    get enabled() {
      return enabled;
    },
    /** 运行态：`disabled` / `no-provider` / `ready`。导出自身的状态另见 `exportState`。 */
    get status() {
      return status;
    },
    get exportState() {
      return exporter?.state.status ?? null;
    },
    buffer,
    /** 只登记通过投影的事件；被拒绝的只返回原因码。 */
    record(candidate) {
      if (!enabled || buffer === null) return { ok: false, reason: 'DISABLED' };
      const projected = project.project(candidate);
      if (!projected.ok) return projected;
      const stored = buffer.add(projected.event);
      return stored.ok ? { ok: true, event: projected.event, duplicate: stored.duplicate === true } : { ok: false, reason: stored.reason };
    },
    /** 导出一次；关闭或没有发送方时都不发送，也不抛出。 */
    async exportOnce() {
      if (!enabled) return { status: 'skipped', reason: 'DISABLED' };
      if (exporter === null) {
        return { status: 'skipped', reason: status === 'unregistered-enums' ? 'UNREGISTERED_ENUMS' : 'NO_PROVIDER' };
      }
      return exporter.exportOnce();
    },
    resume() {
      return exporter?.resume() ?? false;
    },
    stats() {
      return buffer?.stats() ?? { events: 0, bytes: 0, dropped: {} };
    },
  };
}
