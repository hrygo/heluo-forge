/**
 * Short-lived trusted selection preparation and single-use submit binding (CORP-DSH-DESIGN-023 §3.6 / #245).
 * Independent axis (P2): zero cross-axis imports; binds employee, expert, session,
 * delegation scope, and draft digest so stale, mutated, or replayed picks fail closed.
 */
import { randomBytes } from 'node:crypto';
import { computeCanonicalDigest } from './digest.mjs';
import { ExpertsError } from './errors.mjs';

const DEFAULT_SELECTION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_PENDING_SELECTIONS = 256;
const DEFAULT_MAX_PENDING_PER_OWNER = 16;
const MAX_TASK_TEXT_CHARS = 32_000;
const MAX_REUSE_REFS = 20;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeReuseRefs(reuseRefs) {
  if (reuseRefs === undefined || reuseRefs === null) return Object.freeze([]);
  if (!Array.isArray(reuseRefs)) return null;
  if (reuseRefs.length > MAX_REUSE_REFS) return null;
  const normalized = [];
  for (const ref of reuseRefs) {
    if (!isNonEmptyString(ref) || ref.trim().length > 256) return null;
    normalized.push(ref.trim());
  }
  return Object.freeze(normalized);
}

export function computeDraftDigest({ expertId, sessionId, delegationScope, taskText, reuseRefs = [] }) {
  return computeCanonicalDigest({
    expertId: String(expertId ?? '').trim(),
    sessionId: String(sessionId ?? '').trim(),
    delegationScope: String(delegationScope ?? '').trim(),
    taskText: String(taskText ?? ''),
    reuseRefs: Array.isArray(reuseRefs) ? [...reuseRefs] : [],
  });
}

export const SelectionPrepareBodySchema = Object.freeze({
  safeParse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { success: false, error: 'Body must be a plain object' };
    }
    const allowedKeys = new Set([
      'expertId',
      'sessionId',
      'scopeEpoch',
      'viewVersion',
      'taskText',
      'draftVersion',
      'reuseRefs',
    ]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return { success: false, error: `Unexpected field: ${key}` };
    }
    if (!isNonEmptyString(value.expertId) || value.expertId.trim().length > 128) {
      return { success: false, error: 'expertId must be a non-empty string' };
    }
    if (!isNonEmptyString(value.sessionId) || value.sessionId.trim().length > 128) {
      return { success: false, error: 'sessionId must be a non-empty string' };
    }
    if (!Number.isInteger(value.scopeEpoch) || value.scopeEpoch < 1) {
      return { success: false, error: 'scopeEpoch must be a positive integer' };
    }
    if (value.viewVersion !== undefined && (!Number.isInteger(value.viewVersion) || value.viewVersion < 1)) {
      return { success: false, error: 'viewVersion must be a positive integer when provided' };
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
    return {
      success: true,
      data: Object.freeze({
        expertId: value.expertId.trim(),
        sessionId: value.sessionId.trim(),
        scopeEpoch: value.scopeEpoch,
        viewVersion: value.viewVersion ?? null,
        taskText: value.taskText,
        draftVersion: value.draftVersion ?? null,
        reuseRefs,
      }),
    };
  },
});

/**
 * @param {{
 *   isDispatchEnabled: () => boolean,
 *   resolveScope: () => Promise<object>,
 *   assertScopeCurrent: (epoch: number, scope: object) => void,
 *   resolveSessionScope: (sessionId: string, scope: object) => Promise<{ delegationScope: string } | null>,
 *   getMentionVersion?: () => number,
 *   now?: () => number,
 *   selectionTtlMs?: number,
 *   maxPendingSelections?: number,
 * }} ports
 */
export function createSelectionService(ports) {
  if (!ports || typeof ports.resolveScope !== 'function' || typeof ports.assertScopeCurrent !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'selection service requires scope ports');
  }

  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  const selectionTtlMs = Number.isInteger(ports.selectionTtlMs) && ports.selectionTtlMs > 0
    ? ports.selectionTtlMs
    : DEFAULT_SELECTION_TTL_MS;
  const maxPendingSelections = Number.isInteger(ports.maxPendingSelections) && ports.maxPendingSelections > 0
    ? ports.maxPendingSelections
    : DEFAULT_MAX_PENDING_SELECTIONS;
  const maxPendingPerOwner = Number.isInteger(ports.maxPendingPerOwner) && ports.maxPendingPerOwner > 0
    ? ports.maxPendingPerOwner
    : Math.min(DEFAULT_MAX_PENDING_PER_OWNER, maxPendingSelections);

  const pending = new Map();

  function ownerKeyFor(entry) {
    return JSON.stringify([
      entry.scope.instanceId,
      entry.scope.orgId,
      entry.scope.issuer,
      entry.scope.subject,
      entry.sessionId,
    ]);
  }

  function pruneExpired() {
    const at = now();
    for (const [token, entry] of pending.entries()) {
      if (at >= entry.expiresAt) pending.delete(token);
    }
  }

  function storeBounded(token, entry) {
    pruneExpired();
    pending.delete(token);
    const targetOwner = ownerKeyFor(entry);
    const ownerTokens = [];
    for (const [existingToken, existingEntry] of pending.entries()) {
      if (ownerKeyFor(existingEntry) === targetOwner) ownerTokens.push(existingToken);
    }
    // Enforce per-owner (subject + session) quota before global cap so one
    // noisy session only evicts its own oldest picks rather than other users'.
    while (ownerTokens.length >= maxPendingPerOwner) {
      const oldestOwn = ownerTokens.shift();
      if (oldestOwn !== undefined) pending.delete(oldestOwn);
    }
    pending.set(token, entry);
    while (pending.size > maxPendingSelections) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
  }

  function invalidateScope(scopeEpoch) {
    for (const [token, entry] of pending.entries()) {
      if (entry.scopeEpoch !== scopeEpoch) pending.delete(token);
    }
  }

  function invalidateExpert(scopeEpoch, expertId) {
    for (const [token, entry] of pending.entries()) {
      if (entry.scopeEpoch === scopeEpoch && entry.expertId === expertId) {
        pending.delete(token);
      }
    }
  }

  function invalidateSession(scopeEpoch, sessionId) {
    for (const [token, entry] of pending.entries()) {
      if (entry.scopeEpoch === scopeEpoch && (sessionId === null || entry.sessionId === sessionId)) {
        pending.delete(token);
      }
    }
  }

  function clear() {
    pending.clear();
  }

  async function prepare(rawInput) {
    if (!ports.isDispatchEnabled?.()) {
      throw new ExpertsError('EXPERT_DISPATCH_DISABLED', 'Expert dispatch is disabled');
    }
    const parsed = SelectionPrepareBodySchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', parsed.error);
    }
    const input = parsed.data;

    const scope = await ports.resolveScope();
    if (input.scopeEpoch !== scope.scopeEpoch) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Selection scopeEpoch does not match active scope');
    }
    if (input.viewVersion !== null && typeof ports.getMentionVersion === 'function') {
      const currentVersion = ports.getMentionVersion();
      if (input.viewVersion < currentVersion) {
        throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Mention projection version is stale; re-select expert');
      }
    }

    let sessionBinding;
    try {
      sessionBinding = await ports.resolveSessionScope?.(input.sessionId, scope);
    } catch (error) {
      if (error instanceof ExpertsError) throw error;
      throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Unable to verify session delegation scope');
    }
    if (!sessionBinding || !isNonEmptyString(sessionBinding.delegationScope)) {
      throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Missing verified delegation scope for current session');
    }
    const delegationScope = sessionBinding.delegationScope.trim();

    ports.assertScopeCurrent(scope.scopeEpoch, scope);

    const draftDigest = computeDraftDigest({
      expertId: input.expertId,
      sessionId: input.sessionId,
      delegationScope,
      taskText: input.taskText,
      reuseRefs: input.reuseRefs,
    });
    const selectionToken = randomBytes(24).toString('hex');
    const createdAt = now();
    const expiresAt = createdAt + selectionTtlMs;

    const entry = Object.freeze({
      selectionToken,
      scope: Object.freeze({
        instanceId: scope.instanceId,
        orgId: scope.orgId,
        issuer: scope.issuer,
        subject: scope.subject,
      }),
      scopeEpoch: scope.scopeEpoch,
      viewVersion: input.viewVersion,
      sessionId: input.sessionId,
      delegationScope,
      expertId: input.expertId,
      taskText: input.taskText,
      draftVersion: input.draftVersion,
      reuseRefs: input.reuseRefs,
      draftDigest,
      draftRecoveryId: randomBytes(16).toString('hex'),
      createdAt,
      expiresAt,
    });
    storeBounded(selectionToken, entry);

    return Object.freeze({
      selectionToken,
      expertId: entry.expertId,
      sessionId: entry.sessionId,
      delegationScope: entry.delegationScope,
      scopeEpoch: entry.scopeEpoch,
      viewVersion: entry.viewVersion,
      draftDigest: entry.draftDigest,
      draftRecoveryId: entry.draftRecoveryId,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  function verifyEntry({ selectionToken, scope, scopeEpoch, sessionId, taskText, draftVersion = null, reuseRefs = [] }, { consumeEntry }) {
    if (!isNonEmptyString(selectionToken)) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'selectionToken is required');
    }
    const key = selectionToken.trim();
    const entry = pending.get(key);
    if (!entry) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Selection token is missing, expired, or already consumed');
    }
    if (consumeEntry) {
      // Single-use: remove immediately so replay or duplicate submit cannot reuse it.
      pending.delete(key);
    }

    if (now() >= entry.expiresAt) {
      pending.delete(key);
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Selection token has expired; re-select expert');
    }
    if (
      !scope
      || entry.scopeEpoch !== scopeEpoch
      || entry.scope.instanceId !== scope.instanceId
      || entry.scope.orgId !== scope.orgId
      || entry.scope.issuer !== scope.issuer
      || entry.scope.subject !== scope.subject
    ) {
      pending.delete(key);
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Selection token does not match active employee scope');
    }
    if (entry.sessionId !== String(sessionId ?? '').trim()) {
      pending.delete(key);
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Selection token does not belong to current session');
    }
    if ((entry.draftVersion ?? null) !== (draftVersion ?? null)) {
      pending.delete(key);
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Draft version changed after selection; re-confirm expert');
    }

    const normalizedRefs = normalizeReuseRefs(reuseRefs);
    if (!normalizedRefs) {
      pending.delete(key);
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'Invalid reuseRefs');
    }
    const currentDigest = computeDraftDigest({
      expertId: entry.expertId,
      sessionId: entry.sessionId,
      delegationScope: entry.delegationScope,
      taskText,
      reuseRefs: normalizedRefs,
    });
    if (currentDigest !== entry.draftDigest) {
      pending.delete(key);
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Task draft changed after expert selection; re-confirm before sending');
    }

    return entry;
  }

  function inspect(params) {
    return verifyEntry(params, { consumeEntry: false });
  }

  function consume(params) {
    return verifyEntry(params, { consumeEntry: true });
  }

  function discard(selectionToken) {
    if (!isNonEmptyString(selectionToken)) return;
    pending.delete(selectionToken.trim());
  }

  return Object.freeze({
    prepare,
    inspect,
    consume,
    discard,
    invalidateScope,
    invalidateExpert,
    invalidateSession,
    clear,
    pendingCount: () => pending.size,
  });
}
