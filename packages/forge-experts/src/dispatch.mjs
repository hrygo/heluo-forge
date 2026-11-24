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
import { ExpertsError } from './errors.mjs';

export const REQUEST_CORRELATIONS_DOMAIN_NAME = 'forge_experts_requests';
export const REQUEST_CORRELATIONS_DOMAIN_VERSION = 1;
export const REQUEST_CORRELATIONS_TABLE = 'correlations';

const MAX_TASK_TEXT_CHARS = 32_000;
const MAX_REUSE_REFS = 20;
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
  const canonical = JSON.stringify({
    expertId: String(expertId ?? '').trim(),
    delegationScope: String(delegationScope ?? '').trim(),
    taskText: String(taskText ?? ''),
    reuseRefs: Array.isArray(reuseRefs) ? [...reuseRefs] : [],
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function deriveCorrelationKey({ instanceId, orgId, issuer, subject, requestId }) {
  return createHash('sha256')
    .update(JSON.stringify(['request_correlation', instanceId, orgId, issuer, subject, requestId]))
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

export const REQUEST_CORRELATIONS_DOMAIN_SPEC = Object.freeze({
  name: REQUEST_CORRELATIONS_DOMAIN_NAME,
  version: REQUEST_CORRELATIONS_DOMAIN_VERSION,
  tables: Object.freeze({
    [REQUEST_CORRELATIONS_TABLE]: Object.freeze({
      valueSchema: Object.freeze({ parse: parseCorrelationRecord }),
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
  let closed = false;

  async function open() {
    if (domainHandle && !closed) return;
    closed = false;
    if (typeof ports.openStorageDomain !== 'function') return;
    try {
      domainHandle = await ports.openStorageDomain(REQUEST_CORRELATIONS_DOMAIN_SPEC);
      table = domainHandle.table(REQUEST_CORRELATIONS_TABLE);
    } catch {
      domainHandle = null;
      table = null;
      throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'Request correlation storage domain is unavailable', {
        retryable: true,
      });
    }
  }

  async function close() {
    closed = true;
    if (domainHandle) {
      const closing = domainHandle;
      domainHandle = null;
      table = null;
      await closing.close?.();
    }
  }

  async function persistCorrelation(scope, record) {
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
    return validated.data;
  }

  function readCorrelation(scope, requestId) {
    if (closed || !table) return null;
    try {
      const raw = table.get(deriveCorrelationKey({ ...scope, requestId }));
      if (raw === undefined || raw === null) return null;
      const parsed = RequestCorrelationSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function checkPolicy(policyInput) {
    if (typeof ports.evaluatePolicy !== 'function') return;
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
            ...(verdict?.reason ? { reason: verdict.reason } : {}),
          },
        },
      );
    }
    throw new ExpertsError(
      'EXPERT_POLICY_DENIED',
      verdict?.reason ?? 'Expert dispatch blocked by Forge Policy',
    );
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
    await persistCorrelation(scope, baseRecord);

    // 4. Final serialized re-verification in the same boundary as preference updates (§3.6).
    // A preference disable submitted earlier wins and aborts this dispatch before outbound transport.
    const runBoundary = typeof ports.runInPreferenceBoundary === 'function'
      ? ports.runInPreferenceBoundary
      : (fn) => fn();

    let scopeCheck;
    try {
      scopeCheck = await runBoundary(async () => {
        ports.assertScopeCurrent(startEpoch, scope);
        if (ports.isPreferencePending?.({ scope, expertId: binding.expertId })) {
          throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Expert preference update is pending; re-confirm before sending');
        }
        const enabled = await ports.listConfirmedEnabled({ scope, expertIds: [binding.expertId] });
        const pref = enabled.find((item) => item.expertId === binding.expertId);
        if (!pref) {
          throw new ExpertsError('EXPERT_CALL_FORBIDDEN', 'Expert is no longer enabled in personal preferences');
        }
        const check = await ports.checkDelegraSessionScope({
          scope,
          delegationScope: binding.delegationScope,
          expertIds: [binding.expertId],
        });
        ports.assertScopeCurrent(startEpoch, scope);
        if (check?.scopeVerified !== true) {
          throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Delegra did not verify session delegation scope');
        }
        const row = Array.isArray(check.results)
          ? check.results.find((entry) => entry?.expertId === binding.expertId)
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
    } catch (error) {
      await persistCorrelation(scope, {
        ...baseRecord,
        status: 'aborted_before_delivery',
        updatedAt: new Date(now()).toISOString(),
      }).catch(() => {});
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
      await persistCorrelation(scope, {
        ...baseRecord,
        taskId: receipt.taskId ?? null,
        status: 'accepted',
        updatedAt: new Date(now()).toISOString(),
      }).catch(() => {});
      return Object.freeze({
        ...receipt,
        requestId,
        originSessionRef: binding.sessionId,
      });
    } catch (error) {
      if (error instanceof ExpertsError && error.code === 'EXPERT_ACCEPTANCE_UNKNOWN') {
        await persistCorrelation(scope, {
          ...baseRecord,
          status: 'unknown',
          updatedAt: new Date(now()).toISOString(),
        }).catch(() => {});
        throw new ExpertsError('EXPERT_ACCEPTANCE_UNKNOWN', error.message, {
          status: 503,
          retryable: true,
          details: { ...(error.details ?? {}), requestId },
        });
      }
      await persistCorrelation(scope, {
        ...baseRecord,
        status: 'rejected',
        updatedAt: new Date(now()).toISOString(),
      }).catch(() => {});
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
    const existing = readCorrelation(scope, cleanId);
    try {
      const authoritative = await ports.getDelegraTaskByRequest({ scope, requestId: cleanId });
      if (existing) {
        await persistCorrelation(scope, {
          ...existing,
          taskId: authoritative.taskId ?? existing.taskId,
          status: 'accepted',
          updatedAt: new Date(now()).toISOString(),
        }).catch(() => {});
      }
      return Object.freeze({
        ...authoritative,
        correlation: existing ? Object.freeze({ originSessionRef: existing.originSessionRef, expertId: existing.expertId }) : null,
      });
    } catch (error) {
      if (error instanceof ExpertsError && error.code === 'EXPERT_TASK_NOT_FOUND' && existing) {
        await persistCorrelation(scope, {
          ...existing,
          status: 'not_found',
          updatedAt: new Date(now()).toISOString(),
        }).catch(() => {});
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
    const parsed = FollowupTaskBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', parsed.error);
    }
    const input = parsed.data;
    const scope = await ports.resolveScope();
    const requestId = input.requestId ?? generateRequestId();

    await checkPolicy({
      action: 'expert.followup',
      taskId: taskId.trim(),
      orgId: scope.orgId,
      taskText: input.taskText,
      reuseRefs: input.reuseRefs,
      confirmationToken: input.confirmationToken,
    });

    return ports.createDelegraFollowup({
      scope,
      taskId: taskId.trim(),
      requestId,
      taskText: input.taskText,
      reuseRefs: input.reuseRefs,
    });
  }

  async function cancelTask({ taskId }) {
    if (!isNonEmptyString(taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const scope = await ports.resolveScope();
    return ports.cancelDelegraTask({ scope, taskId: taskId.trim() });
  }

  return Object.freeze({
    open,
    close,
    dispatchTask,
    reconcileByRequest,
    getTask,
    getTaskResult,
    followupTask,
    cancelTask,
    getCorrelation: (scope, requestId) => readCorrelation(scope, requestId),
  });
}
