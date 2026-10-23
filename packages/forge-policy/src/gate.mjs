/**
 * 统一门禁：把动作目录接到宿主管线。
 *
 * 判定顺序（与已核验的宿主管线一致）：`tools/pre-execute`（需确认动作取确认）
 * → `ctx.tools.guard`（单调硬拒绝）→ 执行。只处理被显式登记为业务动作的工具；
 * 未登记的工具不属于本门禁的作用域，不在这里假装覆盖。
 */
import { decideAction } from './catalog.mjs';

/**
 * @param {{catalog: Map<string, object>, tools?: Record<string, string>, categories?: Record<string, string>, onDecision?: Function}} options
 */
export function createGate({ catalog, tools = {}, categories = {}, onDecision }) {
  const approved = new WeakSet();

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

  async function preExecute(ctx, exec, next) {
    if (!isEnforced(exec.name)) return next();
    const decision = check(exec.name, { target: exec.arguments?.target, egress: exec.arguments?.egress });
    if (decision.action !== 'confirm') return next();
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
    if (outcome === 'allowed-once') {
      approved.add(exec);
      return { kind: 'allow' };
    }
    return { kind: 'deny', reason: `${decision.reason}: ${outcome}` };
  }

  function guard(exec) {
    if (!isEnforced(exec.name)) return undefined;
    const decision = check(exec.name, { target: exec.arguments?.target, egress: exec.arguments?.egress });
    if (decision.action === 'deny') return decision.reason;
    if (decision.action === 'confirm' && !approved.has(exec)) {
      return `${decision.reason} (the confirmation stage did not run)`;
    }
    return undefined;
  }

  return { actionFor, isEnforced, check, preExecute, guard, isApproved: (exec) => approved.has(exec) };
}
