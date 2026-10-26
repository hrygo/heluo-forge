/**
 * Shared command/tool admission. Async preparation writes the mandatory audit;
 * the monotonic guard admits only that exact, unchanged execution once.
 * Ordinary unmapped host tools remain outside the enterprise policy's scope.
 */
import { decideAction } from './catalog.mjs';
import { decideApproval, needsApproval } from './approvals.mjs';
import { digestContent } from './egress.mjs';
import { matchProtected } from './paths.mjs';

export function createGate({ catalog, tools = {}, categories = {}, protectedRoots = {}, pathOptions = {}, audit, onDecision, approvals = new Map(), now = () => Date.now() }) {
  const approved = new WeakSet();
  const receipts = new Map();
  const attempted = new WeakSet();
  const settlements = new Set();
  let active = true;
  const actionFor = (toolName) => tools[toolName] ?? categories[toolName];
  const isEnforced = (toolName) => Object.hasOwn(tools, toolName) || Object.hasOwn(categories, toolName);

  const notify = (event) => {
    try { onDecision?.(event); } catch { /* Optional observation cannot change admission. */ }
  };

  function decisionFor(toolName, action, request = {}) {
    const decision = decideAction({ catalog, action, target: request.target, egress: request.egress });
    notify({ toolName, action, decision });
    return decision;
  }

  function check(toolName, request = {}) {
    const action = actionFor(toolName);
    if (action === undefined) return { action: 'allow', reason: `tool "${toolName}" is not an enterprise action`, rule: 'out-of-scope' };
    return decisionFor(toolName, action, request);
  }

  function pathDenial(exec, action) {
    const entry = catalog.get(action);
    if (entry?.path === undefined) return undefined;
    const candidate = exec.arguments?.[entry.path];
    if (protectedRoots.length === 0) return `action "${action}" needs a path check but no protected root is configured`;
    try {
      const match = matchProtected(candidate, protectedRoots, pathOptions);
      if (match.protected) return `action "${action}" targets the protected path ${match.root}`;
    } catch (error) {
      return `action "${action}" path cannot be verified (${error?.code ?? error?.message})`;
    }
    return undefined;
  }

  // Digests stay in private memory: arguments and business content are never
  // added to the minimized audit record. The execution object is the capability,
  // not its caller-supplied/correlating callId.
  const snapshot = (exec, action) => digestContent({ action, name: exec.name, arguments: exec.arguments, callId: exec.callId });
  const deny = (reason) => ({ kind: 'deny', reason });
  function changed(exec, action, digest, agent) {
    try { return agent !== exec.agent || digest !== snapshot(exec, action); } catch { return true; }
  }
  const interruption = (exec) => !active ? 'the policy service was disposed'
    : exec.signal?.aborted ? 'the execution was cancelled before admission' : undefined;

  // FIX-03: the organization approval ledger is re-verified on every execution
  // (action + actual resource + revision range + current time), not only at mount.
  // The scope is captured once at prepare and replayed at guard with fresh time,
  // so an approval lapsing mid-flight is caught instead of grandfathered in.
  function approvalScope(exec) {
    try {
      return {
        resource: typeof exec.arguments?.target === 'string' ? exec.arguments.target : undefined,
        revision: exec.arguments?.revision,
      };
    } catch {
      return { unreadable: true };
    }
  }

  function approvalDenial(exec, action, at, scope) {
    const entry = catalog.get(action);
    if (entry === undefined || !needsApproval(entry)) return undefined;
    if (scope.unreadable === true) return 'execution arguments cannot be verified for approval';
    const approval = decideApproval({ approvals, action, resource: scope.resource, revision: scope.revision, now: at });
    if (approval.allowed !== true) {
      return `the organization approval does not cover this execution (${approval.reason})`;
    }
    return undefined;
  }

  async function prepare(ctx, exec, action) {
    if (!active) return deny('the policy service was disposed');
    if (attempted.has(exec)) return deny('the audit admission for this execution was already prepared');
    attempted.add(exec);
    // tools/result is an unawaited observer. Its fallback settlement must be
    // registered synchronously and drained HERE before another protected action.
    await Promise.all([...settlements]);
    if (interruption(exec)) return deny(interruption(exec));
    const pathReason = pathDenial(exec, action);
    if (pathReason !== undefined) return deny(pathReason);
    const decision = decisionFor(exec.name, action, exec.arguments);
    if (decision.action === 'deny') return deny(decision.reason);
    const scope = approvalScope(exec);
    const approvalReason = approvalDenial(exec, action, now(), scope);
    if (approvalReason !== undefined) return deny(approvalReason);
    let digest;
    const agent = exec.agent;
    try { digest = snapshot(exec, action); } catch { return deny('execution arguments cannot be verified for audit'); }
    if (decision.action === 'confirm') {
      const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
      if (approval === undefined || exec.agent === undefined) return deny(`${decision.reason}: no approval channel is available for this call`);
      let outcome;
      try {
        outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: decision.reason, signal: exec.signal });
      } catch (error) {
        return deny(`${decision.reason}: approval unavailable (${error?.message ?? error})`);
      }
      if (interruption(exec)) return deny(interruption(exec));
      if (changed(exec, action, digest, agent)) return deny('execution arguments or identity changed during confirmation');
      if (outcome !== 'allowed-once') return deny(`${decision.reason}: ${outcome}`);
    }
    try {
      if (audit === undefined) throw new Error('no audit barrier is available');
      const receipt = await audit.begin({ action, target: typeof exec.arguments?.target === 'string' ? exec.arguments.target : undefined,
        tool: exec.name, decision: decision.action, rule: decision.rule, operationId: exec.callId });
      if (interruption(exec) || changed(exec, action, digest, agent)) {
        await audit.settle(receipt, { decision: 'cancelled' });
        return deny(interruption(exec) ?? 'execution arguments or identity changed during audit');
      }
      receipts.set(exec, { receipt, digest, action, agent, used: false, resource: scope.resource, revision: scope.revision });
      if (decision.action === 'confirm') approved.add(exec);
      return { kind: 'allow' };
    } catch (error) {
      return deny(`audit refused the action: ${error?.message ?? error}`);
    }
  }

  async function preExecute(ctx, exec, next) {
    if (!isEnforced(exec.name)) return next();
    const decision = await prepare(ctx, exec, actionFor(exec.name));
    if (decision.kind === 'deny') return decision;
    let downstream;
    try { downstream = await next(); } catch (error) {
      await settleAdmission(exec, 'error');
      throw error;
    }
    // HMR/unload may remove the monotonic guard while a downstream listener is
    // awaiting. A captured pre callback must not return allow after disposal.
    if (interruption(exec)) {
      await settleAdmission(exec, 'cancelled');
      return deny(interruption(exec));
    }
    return downstream;
  }

  function guardAction(exec, action) {
    if (interruption(exec)) return interruption(exec);
    const pathReason = pathDenial(exec, action);
    if (pathReason !== undefined) {
      notify({ toolName: exec.name, action, decision: { action: 'deny', reason: pathReason, rule: 'protected-path' } });
      return pathReason;
    }
    const decision = decisionFor(exec.name, action, exec.arguments);
    if (decision.action === 'deny') return decision.reason;
    if (decision.action === 'confirm' && !approved.has(exec)) return `${decision.reason} (the confirmation stage did not run)`;
    if (audit?.isDegraded()) return 'an earlier audit gap is still outstanding';
    if (settlements.size > 0) return 'a previous mandatory audit settlement is still pending';
    const admission = receipts.get(exec);
    if (admission === undefined) return 'the mandatory audit stage did not run for this execution';
    if (admission.used) return 'the audit admission for this execution was already consumed';
    if (admission.action !== action || changed(exec, action, admission.digest, admission.agent)) {
      return 'execution arguments or identity changed after the mandatory audit';
    }
    // FIX-03: an approval that was valid at prepare time may lapse while an
    // awaited downstream or confirmation is in flight; re-verify with fresh time.
    const recheck = decideApproval({
      approvals,
      action,
      resource: admission.resource,
      revision: admission.revision,
      now: now(),
    });
    if (catalog.get(action) !== undefined && needsApproval(catalog.get(action)) && recheck.allowed !== true) {
      return `the organization approval does not cover this execution (${recheck.reason})`;
    }
    admission.used = true;
    return undefined;
  }

  function guard(exec) {
    return isEnforced(exec.name) ? guardAction(exec, actionFor(exec.name)) : undefined;
  }

  async function settleAdmission(exec, decision) {
    const admission = receipts.get(exec);
    if (admission === undefined) return undefined;
    receipts.delete(exec);
    approved.delete(exec);
    // Register before any observer returns. Removing the receipt first makes
    // post-execute + final-result fallback idempotent, not two audit appends.
    const pending = Promise.resolve().then(() => audit.settle(admission.receipt, { decision }))
      .catch(() => ({ action: 'gap', gap: audit.abandon(admission.receipt, 'audit-settlement-unavailable') }));
    settlements.add(pending);
    try { return await pending; } finally { settlements.delete(pending); }
  }

  async function postExecute(exec, result) {
    return await settleAdmission(exec, result?.isError === true || result?.kind === 'error' ? 'error' : 'executed');
  }

  /** The direct command path uses the same preparation, hard checks and settle. */
  async function executeAction(ctx, action, exec, operation) {
    const prepared = await prepare(ctx, exec, action);
    if (prepared.kind === 'deny') return { kind: 'error', text: prepared.reason };
    const reason = guardAction(exec, action);
    if (reason !== undefined) {
      await postExecute(exec, { kind: 'error' });
      return { kind: 'error', text: reason };
    }
    let result;
    try {
      result = await operation();
      return result;
    } catch (error) {
      result = { kind: 'error' };
      throw error;
    } finally {
      await postExecute(exec, result);
    }
  }

  function dispose() {
    if (!active) return;
    active = false;
    for (const [exec, admission] of receipts) {
      // A body admitted before unload may still be running. Never invent its
      // completion: preserve an explicit unknown-outcome gap and do not replay.
      if (admission.used) audit.abandon(admission.receipt, 'policy-disposed-before-outcome');
      void settleAdmission(exec, admission.used ? 'unknown' : 'cancelled');
    }
  }

  return { actionFor, isEnforced, check, pathDenial, preExecute, postExecute, guard, executeAction,
    dispose, isApproved: (exec) => approved.has(exec) };
}
