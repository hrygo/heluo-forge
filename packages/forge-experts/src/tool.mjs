/**
 * Main-assistant restricted expert tool bridge & #247 synthesis envelope
 * (CORP-DSH-DESIGN-023 §3.6 / §5.1, CORP-DSH-EXPERT-001 §7.2).
 *
 * Independent axis (P2): zero cross-axis imports. Enforces verified single-use
 * selectionToken presence before delegation (blocking hallucinated LLM calls with
 * zero outbound tasks), separates acceptance from completion (`completed: false`),
 * projects attributed expert results with collapsed raw payloads and read-only
 * `waiting_user` notices, and marks cancellations with `externalActionsNotReverted: true`.
 */
import { ExpertsError } from './errors.mjs';

export const EXPERT_TOOL_NAMES = Object.freeze({
  DELEGATE: 'forge_experts.delegate',
  STATUS: 'forge_experts.get_status',
  RESULT: 'forge_experts.get_result',
  RECONCILE: 'forge_experts.reconcile',
  FOLLOWUP: 'forge_experts.followup',
  CANCEL: 'forge_experts.cancel',
});

export const DEFAULT_WAITING_USER_NOTICE =
  'Expert task is waiting for additional user input. This notice is read-only; send an explicit follow-up to continue.';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function filterAuthorizedItems(items) {
  if (!Array.isArray(items)) return Object.freeze([]);
  const out = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') {
      if (item.trim().length > 0) out.push(item.trim());
      continue;
    }
    if (isPlainObject(item)) {
      if (item.authorized === false) continue;
      out.push(Object.freeze({ ...item }));
    }
  }
  return Object.freeze(out);
}

/**
 * Projects a Delegra expert task result into a #247 synthesis envelope that
 * strictly separates expert attribution from main-assistant judgment, keeps
 * raw output collapsed by default, filters out unauthorized sources/artifacts,
 * and attaches a read-only notice on `waiting_user`.
 *
 * @param {Record<string, unknown>} rawResult
 */
export function projectExpertResultEnvelope(rawResult) {
  if (!isPlainObject(rawResult)) {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'Expert task result payload must be a plain object');
  }
  const taskId = isNonEmptyString(rawResult.taskId) ? rawResult.taskId.trim() : null;
  if (!taskId) {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'Expert task result is missing taskId');
  }
  const status = isNonEmptyString(rawResult.status) ? rawResult.status.trim() : 'unknown';
  const runId = isNonEmptyString(rawResult.runId) ? rawResult.runId.trim() : null;
  const runGeneration = normalizeOptionalInteger(rawResult.runGeneration);
  const resultVersion = normalizeOptionalInteger(rawResult.resultVersion);
  const summary = typeof rawResult.summary === 'string' ? rawResult.summary : '';
  const rawOutput = typeof rawResult.rawResult === 'string'
    ? rawResult.rawResult
    : (typeof rawResult.content === 'string' ? rawResult.content : null);

  const waitingUserNotice = status === 'waiting_user'
    ? Object.freeze({
      readOnly: true,
      message: isNonEmptyString(rawResult.waitingUserPrompt)
        ? rawResult.waitingUserPrompt.trim()
        : (isNonEmptyString(rawResult.waitingUserNotice)
          ? rawResult.waitingUserNotice.trim()
          : DEFAULT_WAITING_USER_NOTICE),
    })
    : null;

  return Object.freeze({
    taskId,
    status,
    summary,
    rawResult: rawOutput,
    rawResultCollapsed: true,
    sources: filterAuthorizedItems(rawResult.sources),
    artifacts: filterAuthorizedItems(rawResult.artifacts),
    waitingUserNotice,
    synthesizedByMainAssistant: false,
    attribution: Object.freeze({
      role: 'expert',
      taskId,
      runId,
      runGeneration,
      resultVersion,
      status,
    }),
  });
}

/**
 * @param {{
 *   isDispatchEnabled: () => boolean,
 *   dispatchTask: (body: object) => Promise<object>,
 *   reconcileByRequest: (params: { requestId: string }) => Promise<object>,
 *   getTask: (params: { taskId: string }) => Promise<object>,
 *   getTaskResult: (params: { taskId: string }) => Promise<object>,
 *   followupTask: (params: object) => Promise<object>,
 *   cancelTask: (params: { taskId: string }) => Promise<object>,
 * }} ports
 */
export function createExpertToolBridge(ports) {
  if (!ports || typeof ports.dispatchTask !== 'function' || typeof ports.getTask !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'expert tool bridge requires dispatch ports');
  }

  async function delegate(rawInput) {
    if (!ports.isDispatchEnabled?.()) {
      throw new ExpertsError('EXPERT_DISPATCH_DISABLED', 'Expert dispatch is disabled');
    }
    if (!isPlainObject(rawInput)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'Delegate input must be a plain object');
    }
    // Fail closed before any outbound call when the model attempts to invoke an expert
    // without a user-initiated @-mention selectionToken (§3.6 / #245).
    if (!isNonEmptyString(rawInput.selectionToken)) {
      throw new ExpertsError(
        'EXPERT_SELECTION_INVALID',
        'A verified single-use selectionToken from user @-mention is required to delegate to an expert',
      );
    }
    const receipt = await ports.dispatchTask(rawInput);
    const status = isNonEmptyString(receipt?.status) ? receipt.status.trim() : 'queued';
    return Object.freeze({
      ...receipt,
      status,
      accepted: true,
      // Explicitly distinguish acceptance from task completion (#247).
      completed: false,
    });
  }

  // Authoritative readback, reconciliation, and cancellation remain available
  // even when dispatchEnabled is false (§9.2).
  async function getStatus(rawInput) {
    if (!isPlainObject(rawInput) || !isNonEmptyString(rawInput.taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const task = await ports.getTask({ taskId: rawInput.taskId.trim() });
    return Object.freeze({ ...task });
  }

  async function getResult(rawInput) {
    if (!isPlainObject(rawInput) || !isNonEmptyString(rawInput.taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const raw = await ports.getTaskResult({ taskId: rawInput.taskId.trim() });
    return projectExpertResultEnvelope(raw);
  }

  async function reconcile(rawInput) {
    if (!isPlainObject(rawInput) || !isNonEmptyString(rawInput.requestId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'requestId is required');
    }
    const reconciled = await ports.reconcileByRequest({ requestId: rawInput.requestId.trim() });
    return Object.freeze({ ...reconciled });
  }

  async function followup(rawInput) {
    if (!ports.isDispatchEnabled?.()) {
      throw new ExpertsError('EXPERT_DISPATCH_DISABLED', 'Expert dispatch is disabled');
    }
    if (!isPlainObject(rawInput) || !isNonEmptyString(rawInput.taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const receipt = await ports.followupTask(rawInput);
    const status = isNonEmptyString(receipt?.status) ? receipt.status.trim() : 'queued';
    return Object.freeze({
      ...receipt,
      status,
      accepted: true,
      completed: false,
    });
  }

  async function cancel(rawInput) {
    if (!isPlainObject(rawInput) || !isNonEmptyString(rawInput.taskId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'taskId is required');
    }
    const result = await ports.cancelTask({ taskId: rawInput.taskId.trim() });
    return Object.freeze({
      ...result,
      // Never claim that external side effects performed by the expert were reverted (#247).
      externalActionsNotReverted: true,
    });
  }

  function getToolDefinitions() {
    const readAndCancelDefs = [
      Object.freeze({
        name: EXPERT_TOOL_NAMES.STATUS,
        description: 'Fetch authoritative status for a delegated expert task.',
        readOnly: true,
        handler: getStatus,
      }),
      Object.freeze({
        name: EXPERT_TOOL_NAMES.RESULT,
        description: 'Fetch attributed expert task result with collapsed raw output and authorized sources/artifacts.',
        readOnly: true,
        handler: getResult,
      }),
      Object.freeze({
        name: EXPERT_TOOL_NAMES.RECONCILE,
        description: 'Reconcile an uncertain expert dispatch by requestId against Delegra.',
        readOnly: true,
        handler: reconcile,
      }),
      Object.freeze({
        name: EXPERT_TOOL_NAMES.CANCEL,
        description: 'Request cancellation of an expert task (does not revert completed external actions).',
        readOnly: false,
        handler: cancel,
      }),
    ];

    if (!ports.isDispatchEnabled?.()) {
      return Object.freeze(readAndCancelDefs);
    }

    return Object.freeze([
      Object.freeze({
        name: EXPERT_TOOL_NAMES.DELEGATE,
        description: 'Delegate a user-selected @-mention task to a verified enterprise expert using a single-use selectionToken.',
        readOnly: false,
        handler: delegate,
      }),
      Object.freeze({
        name: EXPERT_TOOL_NAMES.FOLLOWUP,
        description: 'Send a follow-up instruction to an existing delegated expert task.',
        readOnly: false,
        handler: followup,
      }),
      ...readAndCancelDefs,
    ]);
  }

  return Object.freeze({
    delegate,
    getStatus,
    getResult,
    reconcile,
    followup,
    cancel,
    getToolDefinitions,
  });
}
