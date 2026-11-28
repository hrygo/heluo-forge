/**
 * Host-side trusted submit & agent/pre-step guard (CORP-DSH-DESIGN-023 §3.6, #245, #246, #247).
 *
 * Independent axis (P2): zero cross-axis imports. Binds a verified single-use
 * selectionToken to an active agent turn before model execution, blocks forged or
 * swapped expert delegations in `beforeToolCall`, expires stale turns via TTL without
 * evicting active in-flight bindings, and discards unused tokens while preserving the
 * user's draft when the model fails to delegate or the binding fails.
 */
import { randomBytes } from 'node:crypto';
import { ExpertsError } from './errors.mjs';

const DEFAULT_MAX_ACTIVE_TURNS = 128;
const DEFAULT_TURN_TTL_MS = 5 * 60 * 1000;
const MODEL_DID_NOT_DELEGATE_NOTICE =
  '主助手未调用所选专家，未发起远端任务；已保留您的草稿，可重新确认后发送。';
const EXPIRED_TURN_NOTICE =
  '专家确认已超时失效，未发起远端任务；已保留您的草稿，请重新确认后发送。';
const DELEGATE_ATTEMPTED_EXPIRED_NOTICE =
  '专家委派已发起但本轮确认超时，受理结果待对账；请按原请求号查单，切勿重复发送。';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snapshotDraft({ taskText, draftVersion, reuseRefs }) {
  return Object.freeze({
    taskText: typeof taskText === 'string' ? taskText : '',
    draftVersion: Number.isInteger(draftVersion) ? draftVersion : null,
    reuseRefs: Array.isArray(reuseRefs) ? Object.freeze([...reuseRefs]) : Object.freeze([]),
  });
}

/**
 * @param {{
 *   isDispatchEnabled: () => boolean,
 *   resolveScope: () => Promise<object>,
 *   inspectSelection: (params: object) => object,
 *   discardSelection?: (selectionToken: string) => void,
 *   onTurnFinalized?: (event: object) => void,
 *   now?: () => number,
 *   turnTtlMs?: number,
 *   maxActiveTurns?: number,
 * }} ports
 */
export function createPreStepGuard(ports) {
  if (!ports || typeof ports.resolveScope !== 'function' || typeof ports.inspectSelection !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'prestep guard requires scope and selection inspection ports');
  }

  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  const turnTtlMs = Number.isInteger(ports.turnTtlMs) && ports.turnTtlMs > 0
    ? ports.turnTtlMs
    : DEFAULT_TURN_TTL_MS;
  const maxActiveTurns = Number.isInteger(ports.maxActiveTurns) && ports.maxActiveTurns > 0
    ? ports.maxActiveTurns
    : DEFAULT_MAX_ACTIVE_TURNS;

  const activeTurns = new Map();
  const activeTokens = new Map();
  const expiredAttemptedTurns = new Map();

  function rememberExpiredAttempted(id, entry) {
    expiredAttemptedTurns.delete(id);
    expiredAttemptedTurns.set(id, {
      scope: entry.scope ?? null,
      sessionId: entry.sessionId,
      expertId: entry.expertId,
      draftDigest: entry.draftDigest ?? null,
      selectionToken: entry.selectionToken ?? null,
    });
    while (expiredAttemptedTurns.size > maxActiveTurns) {
      const oldest = expiredAttemptedTurns.keys().next().value;
      if (oldest === undefined) break;
      expiredAttemptedTurns.delete(oldest);
    }
  }

  function pruneExpiredTurns(skipTurnId = null) {
    const at = now();
    for (const [id, entry] of activeTurns.entries()) {
      if (skipTurnId && id === skipTurnId) continue;
      if (at >= entry.expiresAt) {
        activeTurns.delete(id);
        if (entry?.selectionToken && activeTokens.get(entry.selectionToken) === id) {
          activeTokens.delete(entry.selectionToken);
        }
        if (entry.delegateAttempted) {
          rememberExpiredAttempted(id, entry);
          try {
            ports.onTurnFinalized?.({
              scope: entry.scope ?? null,
              sessionId: entry.sessionId,
              expertId: entry.expertId,
              ...(entry.draftDigest ? { draftDigest: entry.draftDigest } : {}),
              status: 'acceptance_unknown',
              code: 'EXPERT_ACCEPTANCE_UNKNOWN',
              preserveDraft: false,
              notice: DELEGATE_ATTEMPTED_EXPIRED_NOTICE,
            });
          } catch { /* best effort */ }
          continue;
        }
        if (entry?.selectionToken) {
          try { ports.discardSelection?.(entry.selectionToken); } catch { /* best effort */ }
        }
        try {
          ports.onTurnFinalized?.({
            scope: entry.scope ?? null,
            sessionId: entry.sessionId,
            expertId: entry.expertId,
            ...(entry.draftDigest ? { draftDigest: entry.draftDigest } : {}),
            status: 'expired',
            code: 'EXPERT_SELECTION_INVALID',
            preserveDraft: true,
            notice: EXPIRED_TURN_NOTICE,
          });
        } catch { /* best effort */ }
      }
    }
  }

  function clear() {
    for (const entry of activeTurns.values()) {
      if (entry?.selectionToken) {
        try { ports.discardSelection?.(entry.selectionToken); } catch { /* best effort */ }
      }
    }
    activeTurns.clear();
    activeTokens.clear();
    expiredAttemptedTurns.clear();
  }

  /**
   * Validates a native chat submit before entering the main-assistant step:
   * - Plain text without a `selectionToken` passes through unbound (`expertBound: false`),
   *   even if the text contains pasted `@expert` strings (no implicit delegation).
   * - A submit carrying a `selectionToken` is verified against the active scope, session,
   *   `draftVersion`, and `taskText`/`reuseRefs` digest. Any mismatch fails closed and
   *   preserves the user's draft so nothing is silently lost or re-routed.
   *
   * Lifecycle contract: once `prepareTurn` returns `{ allowed: true, expertBound: true, turnId }`,
   * callers MUST invoke `finalizeTurn({ turnId, delegatedTaskId, error })` when the turn ends
   * (success or failure); as a safety net, unfinalized turns expire automatically after `turnTtlMs`.
   */
  async function prepareTurn(rawInput) {
    if (!isPlainObject(rawInput)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'Turn input must be a plain object');
    }
    const hasTokenField = rawInput.selectionToken !== undefined && rawInput.selectionToken !== null;
    if (!hasTokenField) {
      return Object.freeze({
        allowed: true,
        expertBound: false,
        turnId: null,
        expertId: null,
        preserveDraft: false,
      });
    }

    const draft = snapshotDraft(rawInput);
    if (!ports.isDispatchEnabled?.()) {
      return Object.freeze({
        allowed: false,
        expertBound: false,
        code: 'EXPERT_DISPATCH_DISABLED',
        preserveDraft: true,
        draft,
      });
    }
    if (!isNonEmptyString(rawInput.selectionToken)) {
      return Object.freeze({
        allowed: false,
        expertBound: false,
        code: 'EXPERT_SELECTION_INVALID',
        preserveDraft: true,
        draft,
      });
    }

    // Reclaim expired turns first; never evict a still-active in-flight turn by capacity.
    pruneExpiredTurns();
    if (activeTurns.size >= maxActiveTurns) {
      return Object.freeze({
        allowed: false,
        expertBound: false,
        code: 'EXPERT_RATE_LIMITED',
        preserveDraft: true,
        draft,
      });
    }

    let scope;
    try {
      scope = await ports.resolveScope();
    } catch (error) {
      const code = error instanceof ExpertsError ? error.code : 'EXPERT_INTERNAL_ERROR';
      return Object.freeze({
        allowed: false,
        expertBound: false,
        code,
        preserveDraft: true,
        draft,
      });
    }

    let binding;
    try {
      binding = ports.inspectSelection({
        selectionToken: rawInput.selectionToken.trim(),
        scope,
        scopeEpoch: scope.scopeEpoch,
        sessionId: rawInput.sessionId,
        taskText: rawInput.taskText,
        draftVersion: rawInput.draftVersion ?? null,
        reuseRefs: rawInput.reuseRefs ?? [],
      });
    } catch (error) {
      const code = error instanceof ExpertsError ? error.code : 'EXPERT_SELECTION_INVALID';
      return Object.freeze({
        allowed: false,
        expertBound: false,
        code,
        preserveDraft: true,
        draft,
      });
    }

    if (activeTokens.has(binding.selectionToken)) {
      return Object.freeze({
        allowed: false,
        expertBound: false,
        code: 'EXPERT_SELECTION_INVALID',
        preserveDraft: true,
        draft,
      });
    }

    const turnId = randomBytes(16).toString('hex');
    const createdAt = now();
    activeTurns.set(turnId, {
      turnId,
      selectionToken: binding.selectionToken,
      expertId: binding.expertId,
      sessionId: binding.sessionId,
      scopeEpoch: binding.scopeEpoch,
      scope,
      draftDigest: binding.draftDigest ?? null,
      draft,
      delegateAttempted: false,
      delegatedTaskId: null,
      createdAt,
      expiresAt: createdAt + turnTtlMs,
    });
    activeTokens.set(binding.selectionToken, turnId);

    return Object.freeze({
      allowed: true,
      expertBound: true,
      turnId,
      expertId: binding.expertId,
      sessionId: binding.sessionId,
      selectionToken: binding.selectionToken,
      preserveDraft: false,
    });
  }

  /**
   * `agent/pre-step` tool call guard: blocks hallucinated, forged, or cross-expert
   * `forge_experts.delegate` calls before they reach the tool bridge.
   */
  function beforeToolCall({ turnId, toolName, toolInput } = {}) {
    if (toolName !== 'forge_experts.delegate') {
      return Object.freeze({ allowed: true });
    }
    pruneExpiredTurns();
    if (!isNonEmptyString(turnId)) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Expert delegation requires a bound user @-mention turn');
    }
    const turn = activeTurns.get(turnId.trim());
    if (!turn) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Active expert turn binding not found, expired, or already finalized');
    }
    if (!isPlainObject(toolInput) || toolInput.selectionToken !== turn.selectionToken) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Delegate tool call selectionToken does not match bound user selection');
    }
    if (isNonEmptyString(toolInput.expertId) && toolInput.expertId.trim() !== turn.expertId) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Delegate tool call target expert does not match bound user selection');
    }
    if (isNonEmptyString(toolInput.sessionId) && toolInput.sessionId.trim() !== turn.sessionId) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Delegate tool call sessionId does not match bound user session');
    }
    turn.delegateAttempted = true;
    return Object.freeze({ allowed: true, expertId: turn.expertId });
  }

  /**
   * Finalizes a bound turn after main-assistant execution:
   * - If delegation succeeded (`delegatedTaskId`), clears the turn without preserving draft.
   * - If the model never invoked `forge_experts.delegate`, discards the unused single-use
   *   `selectionToken` (preventing replay), marks `expertParticipated: false, completed: false`,
   *   and returns `preserveDraft: true` with the original draft and an explicit notice (#245/#247).
   */
  function finalizeTurn({ turnId, delegatedTaskId = null, error = null } = {}) {
    const cleanTurnId = isNonEmptyString(turnId) ? turnId.trim() : null;
    pruneExpiredTurns(cleanTurnId);
    if (!cleanTurnId) {
      return Object.freeze({ status: 'unbound', expertParticipated: false, completed: false, preserveDraft: false });
    }
    const turn = activeTurns.get(cleanTurnId);
    if (!turn) {
      const expiredAttempted = expiredAttemptedTurns.get(cleanTurnId);
      if (expiredAttempted) {
        expiredAttemptedTurns.delete(cleanTurnId);
        if (isNonEmptyString(delegatedTaskId)) {
          const cleanTaskId = delegatedTaskId.trim();
          if (expiredAttempted.selectionToken) {
            try { ports.discardSelection?.(expiredAttempted.selectionToken); } catch { /* best effort */ }
          }
          try {
            ports.onTurnFinalized?.({
              scope: expiredAttempted.scope ?? null,
              sessionId: expiredAttempted.sessionId,
              expertId: expiredAttempted.expertId,
              ...(expiredAttempted.draftDigest ? { draftDigest: expiredAttempted.draftDigest } : {}),
              status: 'delegated',
              preserveDraft: false,
            });
          } catch { /* best effort */ }
          return Object.freeze({
            status: 'delegated',
            expertParticipated: true,
            completed: false,
            taskId: cleanTaskId,
            expertId: expiredAttempted.expertId,
            sessionId: expiredAttempted.sessionId,
            preserveDraft: false,
          });
        }
      }
      return Object.freeze({ status: 'unbound', expertParticipated: false, completed: false, preserveDraft: false });
    }
    activeTurns.delete(cleanTurnId);
    if (activeTokens.get(turn.selectionToken) === cleanTurnId) {
      activeTokens.delete(turn.selectionToken);
    }

    if (isNonEmptyString(delegatedTaskId)) {
      turn.delegatedTaskId = delegatedTaskId.trim();
      // Belt-and-suspenders single-use cleanup in case a custom host finalized without consuming via dispatchTask.
      try { ports.discardSelection?.(turn.selectionToken); } catch { /* best effort */ }
      try {
        ports.onTurnFinalized?.({
          scope: turn.scope ?? null,
          sessionId: turn.sessionId,
          expertId: turn.expertId,
          ...(turn.draftDigest ? { draftDigest: turn.draftDigest } : {}),
          status: 'delegated',
          preserveDraft: false,
        });
      } catch { /* best effort */ }
      return Object.freeze({
        status: 'delegated',
        expertParticipated: true,
        completed: false,
        taskId: turn.delegatedTaskId,
        expertId: turn.expertId,
        sessionId: turn.sessionId,
        preserveDraft: false,
      });
    }

    // Ensure unused single-use selectionToken cannot be replayed after a failed or skipped turn.
    try { ports.discardSelection?.(turn.selectionToken); } catch { /* best effort */ }

    const outcome = error
      ? Object.freeze({
        status: 'failed',
        code: error instanceof ExpertsError ? error.code : 'EXPERT_INTERNAL_ERROR',
        expertParticipated: false,
        completed: false,
        expertId: turn.expertId,
        sessionId: turn.sessionId,
        preserveDraft: true,
        draft: turn.draft,
      })
      : Object.freeze({
        status: 'model_did_not_delegate',
        expertParticipated: false,
        completed: false,
        expertId: turn.expertId,
        sessionId: turn.sessionId,
        preserveDraft: true,
        draft: turn.draft,
        notice: MODEL_DID_NOT_DELEGATE_NOTICE,
      });

    // Notify host event stream with minimal non-sensitive metadata (never broadcast raw draft text).
    try {
      ports.onTurnFinalized?.({
        scope: turn.scope ?? null,
        sessionId: turn.sessionId,
        expertId: turn.expertId,
        ...(turn.draftDigest ? { draftDigest: turn.draftDigest } : {}),
        status: outcome.status,
        ...(outcome.code ? { code: outcome.code } : {}),
        preserveDraft: true,
        ...(outcome.notice ? { notice: outcome.notice } : {}),
      });
    } catch { /* best effort */ }

    return outcome;
  }

  return Object.freeze({
    prepareTurn,
    beforeToolCall,
    finalizeTurn,
    clear,
    activeTurnCount: () => {
      pruneExpiredTurns();
      return activeTurns.size;
    },
  });
}
