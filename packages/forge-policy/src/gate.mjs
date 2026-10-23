/**
 * 统一门禁：把动作目录接到宿主管线。
 *
 * 判定顺序（与已核验的宿主管线一致）：`tools/pre-execute`（需确认动作取确认）
 * → `ctx.tools.guard`（单调硬拒绝）→ 执行。只处理被显式登记为业务动作的工具；
 * 未登记的工具不属于本门禁的作用域，不在这里假装覆盖。
 */
import { decideAction } from './catalog.mjs';
import { matchProtected } from './paths.mjs';

/**
 * @param {{catalog: Map<string, object>, tools?: Record<string, string>, categories?: Record<string, string>, onDecision?: Function}} options
 */
export function createGate({ catalog, tools = {}, categories = {}, protectedRoots = [], pathOptions = {}, audit, onDecision }) {
  const approved = new WeakSet();
  const receipts = new WeakMap();

  const actionFor = (toolName) => tools[toolName] ?? categories[toolName];
  const isEnforced = (toolName) => Object.hasOwn(tools, toolName) || Object.hasOwn(categories, toolName);

  const notify = (event) => {
    try {
      onDecision?.(event);
    } catch {
      // 观察失败不得影响判定结果。
    }
  };

  function check(toolName, request = {}) {
    const action = actionFor(toolName);
    if (action === undefined) {
      return { action: 'allow', reason: `tool "${toolName}" is not an enterprise action`, rule: 'out-of-scope' };
    }
    const decision = decideAction({ catalog, action, target: request.target, egress: request.egress });
    notify({ toolName, action, decision });
    return decision;
  }

  /**
   * Mandatory pre-audit for anything that would otherwise proceed. A record that
   * cannot be written (missing, non-durable, timeout, sink error) refuses the
   * action with zero side effects.
   */
  async function beginAudit(exec, decision) {
    if (audit === undefined) return undefined;
    try {
      const receipt = await audit.begin({
        action: actionFor(exec.name),
        target: typeof exec.arguments?.target === 'string' ? exec.arguments.target : undefined,
        tool: exec.name,
        decision: decision.action,
        rule: decision.rule,
        operationId: exec.callId,
      });
      receipts.set(exec, receipt);
      return undefined;
    } catch (error) {
      return `audit refused the action: ${error?.message ?? error}`;
    }
  }

  async function preExecute(ctx, exec, next) {
    if (!isEnforced(exec.name)) return next();
    const pathReason = pathDenial(exec, actionFor(exec.name));
    if (pathReason !== undefined) return { kind: 'deny', reason: pathReason };
    const decision = check(exec.name, { target: exec.arguments?.target, egress: exec.arguments?.egress });
    if (decision.action === 'deny') return { kind: 'deny', reason: decision.reason };
    if (decision.action === 'confirm') {
      const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
      if (approval === undefined || exec.agent === undefined) {
        return { kind: 'deny', reason: `${decision.reason}: no approval channel is available for this call` };
      }
      let outcome;
      try {
        outcome = await approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: decision.reason,
          signal: exec.signal,
        });
      } catch (error) {
        return { kind: 'deny', reason: `${decision.reason}: approval unavailable (${error?.message ?? error})` };
      }
      if (outcome !== 'allowed-once') {
        return { kind: 'deny', reason: `${decision.reason}: ${outcome}` };
      }
      const auditReason = await beginAudit(exec, decision);
      if (auditReason !== undefined) return { kind: 'deny', reason: auditReason };
      approved.add(exec);
      return { kind: 'allow' };
    }
    const auditReason = await beginAudit(exec, decision);
    if (auditReason !== undefined) return { kind: 'deny', reason: auditReason };
    return next();
  }

  /**
   * Post-execution record. A failure here is a gap: the outcome stands and the
   * barrier degrades, it never turns an executed action into a refusal.
   */
  async function postExecute(exec, result) {
    const receipt = receipts.get(exec);
    if (receipt === undefined || audit === undefined) return undefined;
    receipts.delete(exec);
    const outcome = result?.isError === true || result?.kind === 'error' ? 'error' : 'executed';
    return await audit.settle(receipt, { decision: outcome });
  }

  /**
   * Protected-path check. It runs before any allow/confirm decision and its
   * denial is hard: a granted confirmation cannot flip it.
   */
  function pathDenial(exec, action) {
    const entry = catalog.get(action);
    if (entry?.path === undefined) return undefined;
    const candidate = exec.arguments?.[entry.path];
    if (protectedRoots.length === 0) {
      return `action "${action}" needs a path check but no protected root is configured`;
    }
    try {
      const match = matchProtected(candidate, protectedRoots, pathOptions);
      if (match.protected) {
        return `action "${action}" targets the protected path ${match.root}`;
      }
    } catch (error) {
      return `action "${action}" path cannot be verified (${error?.code ?? error?.message})`;
    }
    return undefined;
  }

  function guard(exec) {
    if (!isEnforced(exec.name)) return undefined;
    const pathReason = pathDenial(exec, actionFor(exec.name));
    if (pathReason !== undefined) {
      notify({ toolName: exec.name, action: actionFor(exec.name), decision: { action: 'deny', reason: pathReason, rule: 'protected-path' } });
      return pathReason;
    }
    const decision = check(exec.name, { target: exec.arguments?.target, egress: exec.arguments?.egress });
    if (decision.action === 'deny') return decision.reason;
    if (decision.action === 'confirm' && !approved.has(exec)) {
      return `${decision.reason} (the confirmation stage did not run)`;
    }
    return undefined;
  }

  return { actionFor, isEnforced, check, pathDenial, preExecute, postExecute, guard, isApproved: (exec) => approved.has(exec) };
}
