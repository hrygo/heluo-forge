/**
 * Host-side trusted submit & agent/pre-step guard (CORP-DSH-DESIGN-023 §3.6, #245, #246, #247).
 *
 * Independent axis (P2): zero cross-axis imports. Binds a verified single-use
 * selectionToken to an active agent turn before model execution, blocks forged or
 * swapped expert delegations in `beforeToolCall`, discards unused tokens and preserves
 * the user's draft when the model fails to delegate or the binding fails.
 */
import { randomBytes } from 'node:crypto';
import { ExpertsError } from './errors.mjs';

const DEFAULT_MAX_ACTIVE_TURNS = 128;
const MODEL_DID_NOT_DELEGATE_NOTICE =
  '主助手未调用所选专家，未发起远端任务；已保留您的草稿，可重新确认后发送。';

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
 *   maxActiveTurns?: number,
 * }} ports
 */
export function createPreStepGuard(ports) {
  if (!ports || typeof ports.resolveScope !== 'function' || typeof ports.inspectSelection !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'prestep guard requires scope and selection inspection ports');
  }

  const maxActiveTurns = Number.isInteger(ports.maxActiveTurns) && ports.maxActiveTurns > 0
    ? ports.maxActiveTurns
    : DEFAULT_MAX_ACTIVE_TURNS;

  const activeTurns = new Map();

  function storeTurn(turnId, state) {
    activeTurns.delete(turnId);
    activeTurns.set(turnId, state);
    while (activeTurns.size > maxActiveTurns) {
      const oldest = activeTurns.keys().next().value;
      if (oldest === undefined) break;
      const evicted = activeTurns.get(oldest);
      activeTurns.delete(oldest);
      if (evicted?.selectionToken) {
        try { ports.discardSelection?.(evicted.selectionToken); } catch { /* best effort */ }
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
  }

  /**
   * Validates a native chat submit before entering the main-assistant step:
   * - Plain text without a `selectionToken` passes through unbound (`expertBound: false`),
   *   even if the text contains pasted `@expert` strings (no implicit delegation).
   * - A submit carrying a `selectionToken` is verified against the active scope, session,
   *   `draftVersion`, and `taskText`/`reuseRefs` digest. Any mismatch fails closed and
   *   preserves the user's draft so nothing is silently lost or re-routed.
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

    const turnId = randomBytes(16).toString('hex');
    storeTurn(turnId, {
      turnId,
      selectionToken: binding.selectionToken,
      expertId: binding.expertId,
      sessionId: binding.sessionId,
      scopeEpoch: binding.scopeEpoch,
      draft,
      delegateAttempted: false,
      delegatedTaskId: null,
    });

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
    if (!isNonEmptyString(turnId)) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Expert delegation requires a bound user @-mention turn');
    }
    const turn = activeTurns.get(turnId.trim());
    if (!turn) {
      throw new ExpertsError('EXPERT_SELECTION_INVALID', 'Active expert turn binding not found or already finalized');
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
    if (!isNonEmptyString(turnId)) {
      return Object.freeze({ status: 'unbound', expertParticipated: false, completed: false, preserveDraft: false });
    }
    const cleanTurnId = turnId.trim();
    const turn = activeTurns.get(cleanTurnId);
    if (!turn) {
      return Object.freeze({ status: 'unbound', expertParticipated: false, completed: false, preserveDraft: false });
    }
    activeTurns.delete(cleanTurnId);

    if (isNonEmptyString(delegatedTaskId)) {
      turn.delegatedTaskId = delegatedTaskId.trim();
      return Object.freeze({
        status: 'delegated',
        expertParticipated: true,
        completed: false,
        taskId: turn.delegatedTaskId,
        expertId: turn.expertId,
        preserveDraft: false,
      });
    }

    // Ensure unused single-use selectionToken cannot be replayed after a failed or skipped turn.
    try { ports.discardSelection?.(turn.selectionToken); } catch { /* best effort */ }

    if (error) {
      const code = error instanceof ExpertsError ? error.code : 'EXPERT_INTERNAL_ERROR';
      return Object.freeze({
        status: 'failed',
        code,
        expertParticipated: false,
        completed: false,
        expertId: turn.expertId,
        preserveDraft: true,
        draft: turn.draft,
      });
    }

    return Object.freeze({
      status: 'model_did_not_delegate',
      expertParticipated: false,
      completed: false,
      expertId: turn.expertId,
      preserveDraft: true,
      draft: turn.draft,
      notice: MODEL_DID_NOT_DELEGATE_NOTICE,
    });
  }

  return Object.freeze({
    prepareTurn,
    beforeToolCall,
    finalizeTurn,
    clear,
    activeTurnCount: () => activeTurns.size,
  });
}
