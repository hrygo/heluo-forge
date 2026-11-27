/**
 * Trusted expert dispatch, Forge Policy egress gate, and #247 request correlation store
 * (CORP-DSH-DESIGN-023 §3.6 / CORP-DSH-EXPERT-001 §7).
 *
 * Independent axis (P2): zero cross-axis imports. Persists only minimal requestId
 * correlation metadata before outbound delivery (never raw tokens or task body text),
 * runs final authorization/preference re-verification inside the preference serial boundary,
 * and keeps authoritative readback/cancel open even after dispatchEnabled is turned off (§9.2).
 */
import { createHash, randomUUID } from 'node:crypto';
import { computeCanonicalDigest } from './digest.mjs';
import { ExpertsError } from './errors.mjs';

export const REQUEST_CORRELATIONS_DOMAIN_NAME = 'forge_experts_requests';
export const REQUEST_CORRELATIONS_DOMAIN_VERSION = 1;
export const REQUEST_CORRELATIONS_TABLE = 'correlations';
export const REQUEST_PENDING_INDEX_TABLE = 'pending_index';

const MAX_TASK_TEXT_CHARS = 32_000;
const MAX_REUSE_REFS = 20;
const MAX_PENDING_INDEX_IDS = 100;
const VALID_CORRELATION_STATUSES = new Set([
  'pending_delivery',
  'accepted',
  'unknown',
  'rejected',
  'aborted_before_delivery',
  'not_found',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeReuseRefs(reuseRefs) {
  if (reuseRefs === undefined || reuseRefs === null) return Object.freeze([]);
  if (!Array.isArray(reuseRefs) || reuseRefs.length > MAX_REUSE_REFS) return null;
  const out = [];
  for (const item of reuseRefs) {
    if (!isNonEmptyString(item) || item.trim().length > 256) return null;
    out.push(item.trim());
  }
  return Object.freeze(out);
}

function computeDispatchDigest({ expertId, delegationScope, taskText, reuseRefs = [] }) {
  return computeCanonicalDigest({
    expertId: String(expertId ?? '').trim(),
    delegationScope: String(delegationScope ?? '').trim(),
    taskText: String(taskText ?? ''),
    reuseRefs: Array.isArray(reuseRefs) ? [...reuseRefs] : [],
  });
}

export function deriveCorrelationKey({ instanceId, orgId, issuer, subject, requestId }) {
  return createHash('sha256')
    .update(JSON.stringify(['request_correlation', instanceId, orgId, issuer, subject, requestId]))
    .digest('hex');
}

export function derivePendingIndexKey({ instanceId, orgId, issuer, subject }) {
  return createHash('sha256')
    .update(JSON.stringify(['request_pending_index', instanceId, orgId, issuer, subject]))
    .digest('hex');
}

export const RequestCorrelationSchema = Object.freeze({
  safeParse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { success: false, error: 'Correlation record must be a plain object' };
    }
    const allowedKeys = new Set([
      'schemaVersion',
      'requestId',
      'instanceId',
      'orgId',
      'issuer',
      'subject',
      'originSessionRef',
      'expertId',
      'delegationScope',
      'payloadDigest',
      'taskId',
      'status',
      'createdAt',
      'updatedAt',
    ]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return { success: false, error: `Unexpected field: ${key}` };
    }
    if (value.schemaVersion !== 1) return { success: false, error: 'Unsupported schemaVersion' };
    for (const field of ['requestId', 'instanceId', 'orgId', 'issuer', 'subject', 'originSessionRef', 'expertId', 'delegationScope', 'payloadDigest']) {
      if (!isNonEmptyString(value[field])) return { success: false, error: `${field} must be non-empty string` };
    }
    if (value.taskId !== null && !isNonEmptyString(value.taskId)) {
      return { success: false, error: 'taskId must be null or non-empty string' };
    }
    if (!VALID_CORRELATION_STATUSES.has(value.status)) {
      return { success: false, error: `Invalid correlation status: ${value.status}` };
    }
    if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
      return { success: false, error: 'createdAt must be ISO datetime string' };
    }
    if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
      return { success: false, error: 'updatedAt must be ISO datetime string' };
    }
    return {
      success: true,
      data: Object.freeze({
        schemaVersion: 1,
        requestId: value.requestId.trim(),
        instanceId: value.instanceId.trim(),
        orgId: value.orgId.trim(),
        issuer: value.issuer.trim(),
        subject: value.subject.trim(),
        originSessionRef: value.originSessionRef.trim(),
        expertId: value.expertId.trim(),
        delegationScope: value.delegationScope.trim(),
        payloadDigest: value.payloadDigest.trim(),
        taskId: value.taskId ? value.taskId.trim() : null,
        status: value.status,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      }),
    };
  },
});

function parseCorrelationRecord(value) {
  const parsed = RequestCorrelationSchema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(`Invalid request correlation record: ${parsed.error}`);
    error.code = 'invalid-record';
    throw error;
  }
  return parsed.data;
}

function parsePendingIndexRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !Array.isArray(value.requestIds)) {
    const error = new Error('Invalid pending request index record');
    error.code = 'invalid-record';
    throw error;
  }
  const ids = [];
  for (const id of value.requestIds) {
    if (isNonEmptyString(id) && ids.length < MAX_PENDING_INDEX_IDS) ids.push(id.trim());
  }
  return Object.freeze({ schemaVersion: 1, requestIds: Object.freeze(ids) });
}

export const REQUEST_CORRELATIONS_DOMAIN_SPEC = Object.freeze({
  name: REQUEST_CORRELATIONS_DOMAIN_NAME,
  version: REQUEST_CORRELATIONS_DOMAIN_VERSION,
  tables: Object.freeze({
    [REQUEST_CORRELATIONS_TABLE]: Object.freeze({
      valueSchema: Object.freeze({ parse: parseCorrelationRecord }),
    }),
    [REQUEST_PENDING_INDEX_TABLE]: Object.freeze({
      valueSchema: Object.freeze({ parse: parsePendingIndexRecord }),
    }),
  }),
});

export const DispatchTaskBodySchema = Object.freeze({
  safeParse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { success: false, error: 'Body must be a plain object' };
    }
    const allowedKeys = new Set([
      'selectionToken',
      'sessionId',
      'taskText',
      'draftVersion',
      'reuseRefs',
      'confirmationToken',
    ]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return { success: false, error: `Unexpected field: ${key}` };
    }
    if (!isNonEmptyString(value.selectionToken) || value.selectionToken.trim().length > 256) {
      return { success: false, error: 'selectionToken must be a non-empty string' };
    }
    if (!isNonEmptyString(value.sessionId) || value.sessionId.trim().length > 128) {
      return { success: false, error: 'sessionId must be a non-empty string' };
    }
    if (typeof value.taskText !== 'string' || value.taskText.trim().length === 0 || value.taskText.length > MAX_TASK_TEXT_CHARS) {
      return { success: false, error: `taskText must be 1..${MAX_TASK_TEXT_CHARS} chars` };
    }
    if (value.draftVersion !== undefined && (!Number.isInteger(value.draftVersion) || value.draftVersion < 0)) {
      return { success: false, error: 'draftVersion must be a non-negative integer when provided' };
    }
    const reuseRefs = normalizeReuseRefs(value.reuseRefs);
    if (!reuseRefs) {
      return { success: false, error: `reuseRefs must be an array of up to ${MAX_REUSE_REFS} non-empty strings` };
    }
    if (value.confirmationToken !== undefined && (!isNonEmptyString(value.confirmationToken) || value.confirmationToken.trim().length > 256)) {
      return { success: false, error: 'confirmationToken must be a non-empty string when provided' };
    }
    return {
      success: true,
      data: Object.freeze({
        selectionToken: value.selectionToken.trim(),
        sessionId: value.sessionId.trim(),
        taskText: value.taskText,
        draftVersion: value.draftVersion ?? null,
        reuseRefs,
        confirmationToken: value.confirmationToken ? value.confirmationToken.trim() : null,
      }),
    };
  },
});

export const FollowupTaskBodySchema = Object.freeze({
  safeParse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { success: false, error: 'Body must be a plain object' };
    }
    const allowedKeys = new Set(['taskText', 'reuseRefs', 'requestId', 'confirmationToken']);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return { success: false, error: `Unexpected field: ${key}` };
    }
    if (typeof value.taskText !== 'string' || value.taskText.trim().length === 0 || value.taskText.length > MAX_TASK_TEXT_CHARS) {
      return { success: false, error: `taskText must be 1..${MAX_TASK_TEXT_CHARS} chars` };
    }
    const reuseRefs = normalizeReuseRefs(value.reuseRefs);
    if (!reuseRefs) {
      return { success: false, error: `reuseRefs must be an array of up to ${MAX_REUSE_REFS} non-empty strings` };
    }
    if (value.requestId !== undefined && (!isNonEmptyString(value.requestId) || value.requestId.trim().length > 128)) {
      return { success: false, error: 'requestId must be a non-empty string when provided' };
    }
    if (value.confirmationToken !== undefined && (!isNonEmptyString(value.confirmationToken) || value.confirmationToken.trim().length > 256)) {
      return { success: false, error: 'confirmationToken must be a non-empty string when provided' };
    }
    return {
      success: true,
      data: Object.freeze({
        taskText: value.taskText,
        reuseRefs,
        requestId: value.requestId ? value.requestId.trim() : null,
        confirmationToken: value.confirmationToken ? value.confirmationToken.trim() : null,
      }),
    };
  },
});

/**
 * @param {{
 *   isDispatchEnabled: () => boolean,
 *   resolveScope: () => Promise<object>,
 *   assertScopeCurrent: (epoch: number, scope: object) => void,
 *   consumeSelection: (params: object) => object,
 *   runInPreferenceBoundary: <T>(fn: () => Promise<T>) => Promise<T>,
 *   listConfirmedEnabled: (params: { scope: object, expertIds: string[] }) => Promise<Array<object>>,
 *   isPreferencePending: (params: { scope: object, expertId: string }) => boolean,
 *   checkDelegraSessionScope: (params: object) => Promise<object>,
 *   evaluatePolicy?: (params: object) => Promise<{ decision: 'allow' | 'deny' | 'confirm', reason?: string, confirmationScope?: string }>,
 *   openStorageDomain?: (spec: object) => Promise<object>,
 *   createDelegraTask: (params: object) => Promise<object>,
 *   getDelegraTaskByRequest: (params: object) => Promise<object>,
 *   getDelegraTask: (params: object) => Promise<object>,
 *   getDelegraTaskResult: (params: object) => Promise<object>,
 *   createDelegraFollowup: (params: object) => Promise<object>,
 *   cancelDelegraTask: (params: object) => Promise<object>,
 *   now?: () => number,
 *   generateRequestId?: () => string,
 * }} ports
 */
export function createDispatchService(ports) {
  if (!ports || typeof ports.resolveScope !== 'function' || typeof ports.assertScopeCurrent !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'dispatch service requires scope ports');
  }

  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  const generateRequestId = typeof ports.generateRequestId === 'function' ? ports.generateRequestId : () => randomUUID();

  let domainHandle = null;
  let table = null;
  let pendingIndexTable = null;
  let closed = false;
  let pendingIndexQueue = Promise.resolve();
  const inFlightReconciles = new Map();
  const reconcileTimeoutMs = Number.isInteger(ports.reconcileTimeoutMs) && ports.reconcileTimeoutMs > 0
    ? ports.reconcileTimeoutMs
    : 10_000;
  const RECONCILE_CONCURRENCY = 5;
  // Bounded in-memory taskId -> { originSessionRef, expertId, delegationScope } index
  // populated by local dispatches/reconciliations so follow-ups reuse full preference
  // and scope re-verification without reading raw task payloads.
  const taskContextById = new Map();
  const MAX_TASK_CONTEXT_CACHE = 512;

  function rememberTaskContext(scope, taskId, context) {
    if (!isNonEmptyString(taskId)) return;
    const key = deriveCorrelationKey({ ...scope, requestId: `task:${taskId.trim()}` });
    taskContextById.delete(key);
    taskContextById.set(key, Object.freeze({
      originSessionRef: context.originSessionRef,
      expertId: context.expertId,
      delegationScope: context.delegationScope,
    }));
    while (taskContextById.size > MAX_TASK_CONTEXT_CACHE) {
      const oldest = taskContextById.keys().next().value;
      if (oldest === undefined) break;
      taskContextById.delete(oldest);
    }
  }

  function lookupTaskContext(scope, taskId) {
    if (!isNonEmptyString(taskId)) return null;
    const key = deriveCorrelationKey({ ...scope, requestId: `task:${taskId.trim()}` });
    return taskContextById.get(key) ?? null;
  }

  async function open() {
    if (domainHandle && !closed) return;
    closed = false;
    if (typeof ports.openStorageDomain !== 'function') return;
    try {
      domainHandle = await ports.openStorageDomain(REQUEST_CORRELATIONS_DOMAIN_SPEC);
      table = domainHandle.table(REQUEST_CORRELATIONS_TABLE);
      pendingIndexTable = domainHandle.table(REQUEST_PENDING_INDEX_TABLE);
    } catch {
      domainHandle = null;
      table = null;
      pendingIndexTable = null;
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Request correlation storage domain is unavailable', {
        retryable: true,
      });
    }
  }

  async function close() {
    closed = true;
    taskContextById.clear();
    inFlightReconciles.clear();
    if (domainHandle) {
      const closing = domainHandle;
      domainHandle = null;
      table = null;
      pendingIndexTable = null;
      await closing.close?.();
    }
  }

  async function readPendingIndex(scope) {
    if (closed || !pendingIndexTable) {
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Pending request index storage is unavailable', {
        retryable: true,
      });
    }
    try {
      const raw = await pendingIndexTable.get(derivePendingIndexKey(scope));
      if (raw === undefined || raw === null) return [];
      if (typeof raw !== 'object' || !Array.isArray(raw.requestIds)) return [];
      return raw.requestIds.filter((id) => isNonEmptyString(id)).map((id) => id.trim());
    } catch (error) {
      if (error instanceof ExpertsError) throw error;
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Failed to read pending request index', {
        retryable: true,
      });
    }
  }

  function syncPendingIndex(scope, requestId, status, { strict = false } = {}) {
    if (closed || !pendingIndexTable) {
      if (strict) {
        return Promise.reject(new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Pending request index storage is unavailable', {
          retryable: true,
        }));
      }
      return Promise.resolve();
    }
    const run = async () => {
      if (closed || !pendingIndexTable) {
        if (strict) {
          throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Pending request index storage is unavailable', {
            retryable: true,
          });
        }
        return;
      }
      try {
        const existing = await readPendingIndex(scope);
        const isPending = status === 'pending_delivery' || status === 'unknown';
        const filtered = existing.filter((id) => id !== requestId);
        if (isPending) {
          filtered.push(requestId);
          while (filtered.length > MAX_PENDING_INDEX_IDS) filtered.shift();
        }
        const unchanged = existing.length === filtered.length
          && existing.every((id, idx) => id === filtered[idx]);
        if (unchanged) return;
        await pendingIndexTable.put(derivePendingIndexKey(scope), {
          schemaVersion: 1,
          requestIds: filtered,
        });
      } catch (error) {
        try {
          ports.onPendingIndexError?.({
            requestId,
            status,
            message: error?.message ?? String(error),
          });
        } catch { /* diagnostics isolation */ }
        if (strict) {
          if (error instanceof ExpertsError) throw error;
          throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Failed to persist pending request index before outbound delivery', {
            retryable: true,
          });
        }
      }
    };
    const next = pendingIndexQueue.then(run, run);
    pendingIndexQueue = next.catch(() => {});
    return next;
  }

  async function persistCorrelation(scope, record, { strictPendingIndex = false } = {}) {
    if (closed || !table) {
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Request correlation storage is unavailable', {
        retryable: true,
      });
    }
    const validated = RequestCorrelationSchema.safeParse(record);
    if (!validated.success) {
      throw new ExpertsError('EXPERT_INTERNAL_ERROR', `Invalid correlation record: ${validated.error}`);
    }
    const key = deriveCorrelationKey({ ...scope, requestId: validated.data.requestId });
    try {
      await table.put(key, validated.data);
    } catch {
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Failed to persist request correlation before outbound delivery', {
        retryable: true,
      });
    }
    await syncPendingIndex(scope, validated.data.requestId, validated.data.status, { strict: strictPendingIndex });
    return validated.data;
  }

  async function persistCorrelationBestEffort(scope, record) {
    try {
      await persistCorrelation(scope, record);
    } catch (persistError) {
      // Never swallow post-delivery correlation convergence failures silently:
      // surface minimal non-sensitive metadata so stuck `pending_delivery` records remain observable.
      try {
        ports.onCorrelationPersistError?.({
          requestId: record.requestId,
          status: record.status,
          message: persistError?.message ?? String(persistError),
        });
      } catch {
        // Diagnostics callback must not override the primary dispatch outcome.
      }
    }
  }

  async function readCorrelation(scope, requestId) {
    if (closed || !table) return null;
    try {
      // Await table.get so both synchronous KvTable.get and async storage adapters work seamlessly.
      const raw = await table.get(deriveCorrelationKey({ ...scope, requestId }));
      if (raw === undefined || raw === null) return null;
      const parsed = RequestCorrelationSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function checkPolicy(policyInput) {
    if (typeof ports.evaluatePolicy !== 'function') {
      // Fail closed (P3): outbound dispatch/followup must never bypass Forge Policy when the gate is absent.
      throw new ExpertsError('EXPERT_POLICY_DENIED', 'Forge Policy egress gate is not configured; dispatch is fail-closed');
    }
    let verdict;
    try {
      verdict = await ports.evaluatePolicy(policyInput);
    } catch (error) {
      if (error instanceof ExpertsError) throw error;
      throw new ExpertsError('EXPERT_POLICY_DENIED', 'Forge Policy egress check failed closed');
    }
    const decision = verdict?.decision;
    if (decision === 'allow') return;
    if (decision === 'confirm') {
      throw new ExpertsError(
        'EXPERT_POLICY_CONFIRMATION_REQUIRED',
        verdict?.reason ?? 'Human confirmation is required by Forge Policy before dispatching to this expert',
        {
          details: {
            ...(verdict?.confirmationScope ? { confirmationScope: verdict.confirmationScope } : {}),
          },
        },
      );
    }
    throw new ExpertsError(
      'EXPERT_POLICY_DENIED',
      verdict?.reason ?? 'Expert dispatch blocked by Forge Policy',
    );
  }

  async function verifyInPreferenceBoundary({ scope, startEpoch, expertId, delegationScope }) {
    const runBoundary = typeof ports.runInPreferenceBoundary === 'function'
      ? ports.runInPreferenceBoundary
      : (fn) => fn();

    return runBoundary(async () => {
      ports.assertScopeCurrent(startEpoch, scope);
      if (!isNonEmptyString(expertId) || !isNonEmptyString(delegationScope)) {
        throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Missing expert or delegation scope context; verification cannot be skipped');
      }
      if (ports.isPreferencePending?.({ scope, expertId })) {
        throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Expert preference update is pending; re-confirm before sending');
      }
      const enabled = await ports.listConfirmedEnabled({ scope, expertIds: [expertId] });
      const pref = enabled.find((item) => item.expertId === expertId);
      if (!pref) {
        throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Expert is no longer enabled in personal preferences');
      }
      const check = await ports.checkDelegraSessionScope({
        scope,
        delegationScope,
        expertIds: [expertId],
      });
      ports.assertScopeCurrent(startEpoch, scope);
      if (check?.scopeVerified !== true) {
        throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Delegra did not verify session delegation scope');
      }
      const row = Array.isArray(check.results)
        ? check.results.find((entry) => entry?.expertId === expertId)
        : null;
      if (!row || row.callableInScope !== true) {
        throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Employee is not authorized to call this expert in current scope');
      }
      if (!row.authContinuityDigest || row.authContinuityDigest !== pref.authContinuityDigest) {
        throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Expert authorization continuity changed; re-enable before sending');
      }
      if (row.acceptingTasks !== 'accepting') {
        throw new ExpertsError('EXPERT_NOT_ACCEPTING', 'Expert is currently not accepting new tasks');
      }
      return check;
    });
  }

  async function dispatchTask(rawInput) {
    if (!ports.isDispatchEnabled?.()) {
      throw new ExpertsError('EXPERT_DISPATCH_DISABLED', 'Expert dispatch is disabled');
    }
    const parsed = DispatchTaskBodySchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', parsed.error);
    }
    const input = parsed.data;

    const scope = await ports.resolveScope();
    const startEpoch = scope.scopeEpoch;

    // 1. Consume single-use selection binding (verifies scope, session, expiry, and draft digest).
    const binding = ports.consumeSelection({
      selectionToken: input.selectionToken,
      scope,
      scopeEpoch: startEpoch,
      sessionId: input.sessionId,
      taskText: input.taskText,
      draftVersion: input.draftVersion,
      reuseRefs: input.reuseRefs,
    });

    const payloadDigest = computeDispatchDigest({
      expertId: binding.expertId,
      delegationScope: binding.delegationScope,
      taskText: input.taskText,
      reuseRefs: input.reuseRefs,
    });

    // 2. Evaluate Forge Policy outside the preference serial boundary (§3.6).
    await checkPolicy({
      action: 'expert.dispatch',
      expertId: binding.expertId,
      orgId: scope.orgId,
      delegationScope: binding.delegationScope,
      sessionId: binding.sessionId,
      payloadDigest,
      taskText: input.taskText,
      reuseRefs: input.reuseRefs,
      confirmationToken: input.confirmationToken,
    });

    // 3. Persist minimal #247 request correlation BEFORE outbound delivery.
    const requestId = generateRequestId();
    const createdAt = new Date(now()).toISOString();
    const baseRecord = {
      schemaVersion: 1,
      requestId,
      instanceId: scope.instanceId,
      orgId: scope.orgId,
      issuer: scope.issuer,
      subject: scope.subject,
      originSessionRef: binding.sessionId,
      expertId: binding.expertId,
      delegationScope: binding.delegationScope,
      payloadDigest,
      taskId: null,
      status: 'pending_delivery',
      createdAt,
      updatedAt: createdAt,
    };
    await persistCorrelation(scope, baseRecord, { strictPendingIndex: true });

    // 4. Final serialized re-verification in the same boundary as preference updates (§3.6).
    // A preference disable submitted earlier wins and aborts this dispatch before outbound transport.
    let scopeCheck;
    try {
      scopeCheck = await verifyInPreferenceBoundary({
        scope,
        startEpoch,
        expertId: binding.expertId,
        delegationScope: binding.delegationScope,
      });
    } catch (error) {
      await persistCorrelationBestEffort(scope, {
        ...baseRecord,
        status: 'aborted_before_delivery',
        updatedAt: new Date(now()).toISOString(),
      });
      throw error;
    }

    // 5. Outbound atomic delivery (outside preference lock so network I/O never stalls preferences).
    if (!scopeCheck) {
      throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'Missing verified scope check before delivery');
    }
    try {
      const receipt = await ports.createDelegraTask({
        scope,
        expertId: binding.expertId,
        delegationScope: binding.delegationScope,
        requestId,
        originSessionRef: binding.sessionId,
        taskText: input.taskText,
        reuseRefs: input.reuseRefs,
        payloadDigest,
      });
      rememberTaskContext(scope, receipt.taskId, {
        originSessionRef: binding.sessionId,
        expertId: binding.expertId,
        delegationScope: binding.delegationScope,
      });
      await persistCorrelationBestEffort(scope, {
        ...baseRecord,
        taskId: receipt.taskId ?? null,
        status: 'accepted',
        updatedAt: new Date(now()).toISOString(),
      });
      return Object.freeze({
        ...receipt,
        requestId,
        originSessionRef: binding.sessionId,
      });
    } catch (error) {
      if (error instanceof ExpertsError && error.code === 'EXPERT_ACCEPTANCE_UNKNOWN') {
        await persistCorrelationBestEffort(scope, {
          ...baseRecord,
          status: 'unknown',
          updatedAt: new Date(now()).toISOString(),
        });
        throw new ExpertsError('EXPERT_ACCEPTANCE_UNKNOWN', error.message, {
          status: 503,
          retryable: true,
          details: { ...(error.details ?? {}), requestId },
        });
      }
      await persistCorrelationBestEffort(scope, {
        ...baseRecord,
        status: 'rejected',
        updatedAt: new Date(now()).toISOString(),
      });
      throw error;
    }
  }

  // Authoritative readback & cancel remain available even when dispatchEnabled is false (§5 / §9.2).
  async function reconcileByRequest({ requestId }) {
    if (!isNonEmptyString(requestId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'requestId is required');
    }
    const cleanId = requestId.trim();
    const scope = await ports.resolveScope();
    const existing = await readCorrelation(scope, cleanId);
    try {
      const authoritative = await ports.getDelegraTaskByRequest({ scope, requestId: cleanId });
      if (existing) {
        rememberTaskContext(scope, authoritative.taskId ?? existing.taskId, {
          originSessionRef: existing.originSessionRef,
          expertId: existing.expertId,
          delegationScope: existing.delegationScope,
        });
        const reconcilable = existing.status === 'pending_delivery' || existing.status === 'unknown';
        await persistCorrelationBestEffort(scope, {
          ...existing,
          taskId: reconcilable ? (authoritative.taskId ?? existing.taskId) : existing.taskId,
          status: reconcilable ? 'accepted' : existing.status,
          updatedAt: new Date(now()).toISOString(),
        });
      }
      return Object.freeze({
        ...authoritative,
        correlation: existing ? Object.freeze({ originSessionRef: existing.originSessionRef, expertId: existing.expertId }) : null,
      });
    } catch (error) {
      if (error instanceof ExpertsError && error.code === 'EXPERT_TASK_NOT_FOUND' && existing) {
        await persistCorrelationBestEffort(scope, {
          ...existing,
          status: 'not_found',
          updatedAt: new Date(now()).toISOString(),
        });
      }
      throw error;
    }
  }

  async function getTask({ taskId }) {
    if (!isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const scope = await ports.resolveScope();
    return ports.getDelegraTask({ scope, taskId: taskId.trim() });
  }

  async function getTaskResult({ taskId }) {
    if (!isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const scope = await ports.resolveScope();
    return ports.getDelegraTaskResult({ scope, taskId: taskId.trim() });
  }

  async function followupTask({ taskId, ...rawBody }) {
    if (!ports.isDispatchEnabled?.()) {
      throw new ExpertsError('EXPERT_DISPATCH_DISABLED', 'Expert dispatch is disabled');
    }
    if (!isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const cleanTaskId = taskId.trim();
    const parsed = FollowupTaskBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', parsed.error);
    }
    const input = parsed.data;
    const scope = await ports.resolveScope();
    const startEpoch = scope.scopeEpoch;
    const requestId = input.requestId ?? generateRequestId();
    const knownContext = lookupTaskContext(scope, cleanTaskId);
    const payloadDigest = computeCanonicalDigest({
      taskId: cleanTaskId,
      taskText: input.taskText,
      reuseRefs: input.reuseRefs,
    });

    // 1. Evaluate Forge Policy outside the preference serial boundary (§3.6).
    await checkPolicy({
      action: 'expert.followup',
      taskId: cleanTaskId,
      ...(knownContext ? { expertId: knownContext.expertId, delegationScope: knownContext.delegationScope } : {}),
      orgId: scope.orgId,
      payloadDigest,
      taskText: input.taskText,
      reuseRefs: input.reuseRefs,
      confirmationToken: input.confirmationToken,
    });

    // Fail closed if task context is absent (e.g. after restart before by-request reconciliation):
    // never persist placeholder identities or bypass preference/scope verification.
    if (!knownContext || !isNonEmptyString(knownContext.expertId) || !isNonEmptyString(knownContext.delegationScope)) {
      throw new ExpertsError('EXPERT_TASK_NOT_FOUND', 'Task context is unavailable; reconcile the task before sending follow-ups');
    }

    // 2. Persist minimal #247 request correlation BEFORE outbound followup delivery.
    const createdAt = new Date(now()).toISOString();
    const baseRecord = {
      schemaVersion: 1,
      requestId,
      instanceId: scope.instanceId,
      orgId: scope.orgId,
      issuer: scope.issuer,
      subject: scope.subject,
      originSessionRef: knownContext.originSessionRef,
      expertId: knownContext.expertId,
      delegationScope: knownContext.delegationScope,
      payloadDigest,
      taskId: cleanTaskId,
      status: 'pending_delivery',
      createdAt,
      updatedAt: createdAt,
    };
    await persistCorrelation(scope, baseRecord, { strictPendingIndex: true });

    // 3. Final serialized re-verification in the preference boundary before outbound delivery (§3.6).
    try {
      await verifyInPreferenceBoundary({
        scope,
        startEpoch,
        expertId: knownContext.expertId,
        delegationScope: knownContext.delegationScope,
      });
    } catch (error) {
      await persistCorrelationBestEffort(scope, {
        ...baseRecord,
        status: 'aborted_before_delivery',
        updatedAt: new Date(now()).toISOString(),
      });
      throw error;
    }

    // 4. Outbound followup delivery with correlation status convergence.
    try {
      const receipt = await ports.createDelegraFollowup({
        scope,
        taskId: cleanTaskId,
        requestId,
        taskText: input.taskText,
        reuseRefs: input.reuseRefs,
      });
      await persistCorrelationBestEffort(scope, {
        ...baseRecord,
        status: 'accepted',
        updatedAt: new Date(now()).toISOString(),
      });
      return receipt;
    } catch (error) {
      if (error instanceof ExpertsError && error.code === 'EXPERT_ACCEPTANCE_UNKNOWN') {
        await persistCorrelationBestEffort(scope, {
          ...baseRecord,
          status: 'unknown',
          updatedAt: new Date(now()).toISOString(),
        });
        throw new ExpertsError('EXPERT_ACCEPTANCE_UNKNOWN', error.message, {
          status: 503,
          retryable: true,
          details: { ...(error.details ?? {}), requestId },
        });
      }
      await persistCorrelationBestEffort(scope, {
        ...baseRecord,
        status: 'rejected',
        updatedAt: new Date(now()).toISOString(),
      });
      throw error;
    }
  }

  async function cancelTask({ taskId }) {
    if (!isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const scope = await ports.resolveScope();
    return ports.cancelDelegraTask({ scope, taskId: taskId.trim() });
  }

  async function listPendingRequests() {
    const scope = await ports.resolveScope();
    const requestIds = await readPendingIndex(scope);
    const items = [];
    for (let idx = 0; idx < requestIds.length; idx += RECONCILE_CONCURRENCY) {
      const batch = requestIds.slice(idx, idx + RECONCILE_CONCURRENCY);
      const records = await Promise.all(batch.map((requestId) => readCorrelation(scope, requestId)));
      for (const record of records) {
        if (!record) continue;
        if (record.status !== 'pending_delivery' && record.status !== 'unknown') continue;
        items.push(Object.freeze({
          requestId: record.requestId,
          originSessionRef: record.originSessionRef,
          expertId: record.expertId,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }));
      }
    }
    return Object.freeze({ scopeEpoch: scope.scopeEpoch, items: Object.freeze(items) });
  }

  function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Pending task reconciliation timed out', { retryable: true }));
      }, ms);
    });
    // NOTE: Promise.race bounds the HTTP wait window without cancelling an in-flight
    // upstream by-request read (idempotent GET); timed-out IDs stay in stillPending for next pass.
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  // Startup/reconnect recovery (#247): reconciles pending_delivery/unknown requestIds
  // against Delegra via by-request with per-scope in-flight dedup, bounded concurrency,
  // and per-call timeout, without ever blindly re-sending createDelegraTask.
  async function reconcilePendingRequests() {
    const scope = await ports.resolveScope();
    const scopeKey = derivePendingIndexKey(scope);
    const existingPass = inFlightReconciles.get(scopeKey);
    if (existingPass) return existingPass;

    const pass = (async () => {
      const requestIds = await readPendingIndex(scope);
      const reconciled = [];
      const notFound = [];
      const stillPending = [];

      const reconcileOne = async (requestId) => {
        const record = await readCorrelation(scope, requestId);
        if (!record || (record.status !== 'pending_delivery' && record.status !== 'unknown')) {
          await syncPendingIndex(scope, requestId, 'accepted');
          return;
        }
        try {
          const result = await withTimeout(reconcileByRequest({ requestId }), reconcileTimeoutMs);
          const entry = Object.freeze({
            requestId,
            taskId: result.taskId ?? record.taskId ?? null,
            status: result.status ?? 'queued',
            originSessionRef: record.originSessionRef,
            expertId: record.expertId,
          });
          reconciled.push(entry);
          try { ports.onTaskReconciled?.({ ...entry, scope }); } catch { /* best effort */ }
        } catch (error) {
          if (error instanceof ExpertsError && error.code === 'EXPERT_TASK_NOT_FOUND') {
            notFound.push(requestId);
            await syncPendingIndex(scope, requestId, 'not_found');
          } else {
            stillPending.push(requestId);
          }
        }
      };

      for (let idx = 0; idx < requestIds.length; idx += RECONCILE_CONCURRENCY) {
        const batch = requestIds.slice(idx, idx + RECONCILE_CONCURRENCY);
        await Promise.all(batch.map((requestId) => reconcileOne(requestId)));
      }

      return Object.freeze({
        reconciled: Object.freeze(reconciled),
        notFound: Object.freeze(notFound),
        stillPending: Object.freeze(stillPending),
      });
    })().finally(() => {
      if (inFlightReconciles.get(scopeKey) === pass) inFlightReconciles.delete(scopeKey);
    });

    inFlightReconciles.set(scopeKey, pass);
    return pass;
  }

  return Object.freeze({
    open,
    close,
    dispatchTask,
    reconcileByRequest,
    listPendingRequests,
    reconcilePendingRequests,
    getTask,
    getTaskResult,
    followupTask,
    cancelTask,
    getCorrelation: (scope, requestId) => readCorrelation(scope, requestId),
  });
}
