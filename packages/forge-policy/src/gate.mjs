/**
 * Shared command/tool admission. Async preparation writes the mandatory audit;
 * the monotonic guard admits only that exact, unchanged execution once.
 *
 * 判定顺序：能力域 → 受保护路径 → 身份 → 内容域 → 流程域 → 决策合成 →
 * 写动作范围复验 → 逐次确认 → 前置审计。任何一步的 `deny` 都零副作用。
 */
import { decideAction } from './catalog.mjs';
import { isWriteAction, strictestDecision } from './classify.mjs';
import { payloadsFromArguments, scanPayloads } from './content-rules.mjs';
import { effectiveDecision } from './org-policy.mjs';
import { evaluateProcessRules, factsFromArguments, withSources } from './process-rules.mjs';
import { digestContent } from './egress.mjs';
import { matchProtected } from './paths.mjs';

const READ_CATEGORY = 'read';

export function createGate({
  catalog,
  tools = {},
  categories = {},
  protectedRoots = {},
  pathOptions = {},
  audit,
  onDecision,
  contentRules = [],
  org = { state: 'absent' },
  getActor,
  getFactSources,
  scope,
  now = () => Date.now(),
} = {}) {
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

  const policyVersion = org.state === 'verified' ? org.policyVersion : 'builtin';
  const orgDigest = org.state === 'verified' ? org.digest : undefined;

  function decisionFor(toolName, action, request = {}) {
    const base = decideAction({ catalog, action, target: request.target });
    let decision = base;
    if (base.action !== 'deny') {
      // 组织上限只能收紧：信封给出更严的决策时覆盖内置默认，从不放宽。
      let capped = 'allow';
      try {
        capped = effectiveDecision({ action, org });
      } catch {
        capped = 'deny';
      }
      const merged = strictestDecision(base.action, capped);
      if (merged !== base.action) {
        decision = {
          ...base,
          action: merged,
          rule: 'org-policy-ceiling',
          reason: `the organization policy holds ${action} at ${capped}`,
        };
      }
    }
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
  const deny = (reason, extra = undefined) => ({ kind: 'deny', reason, ...(extra === undefined ? {} : extra) });
  function changed(exec, action, digest, agent) {
    try { return agent !== exec.agent || digest !== snapshot(exec, action); } catch { return true; }
  }
  const interruption = (exec) => !active ? 'the policy service was disposed'
    : exec.signal?.aborted ? 'the execution was cancelled before admission' : undefined;

  function actorOf() {
    try {
      const value = typeof getActor === 'function' ? getActor() : undefined;
      return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The repository a call is scoped to. Issue and pull-request targets carry a
   * `repo!number` form; a repository action is the repository itself.
   */
  function repositoryOf(action, args) {
    const target = typeof args?.target === 'string' ? args.target : undefined;
    if (target === undefined) return undefined;
    const entry = catalog.get(action);
    if (entry?.category === READ_CATEGORY) return target;
    return target.includes('!') ? target.split('!')[0] : target;
  }

  function changeOf(args) {
    if (typeof args?.changeId === 'string' && args.changeId.trim().length > 0) return args.changeId;
    if (typeof args?.change === 'string' && args.change.trim().length > 0) return args.change;
    return undefined;
  }

  function processOutcome(action, args) {
    const entry = catalog.get(action);
    if (entry === undefined || entry.processRules.length === 0) {
      return { decision: 'allow', deny: [], confirm: [], unevaluated: [], ruleIds: [] };
    }
    let sources = {};
    try {
      sources = typeof getFactSources === 'function' ? getFactSources({ action, changeId: changeOf(args) }) ?? {} : {};
    } catch {
      sources = {};
    }
    const facts = withSources(factsFromArguments(args), sources);
    const outcome = evaluateProcessRules({
      rules: entry.processRules,
      facts,
      severities: org.state === 'verified' ? org.processRules : {},
    });
    const decision = outcome.deny.length > 0 ? 'deny' : outcome.confirm.length > 0 ? 'confirm' : 'allow';
    const reason = outcome.deny[0]?.reason ?? outcome.confirm[0]?.reason;
    return {
      decision,
      reason,
      deny: outcome.deny,
      confirm: outcome.confirm,
      unevaluated: outcome.unevaluated,
      ruleIds: [...outcome.deny, ...outcome.confirm, ...outcome.unevaluated].map((item) => item.rule),
    };
  }

  function contentOutcome(action, args) {
    const entry = catalog.get(action);
    if (entry === undefined || entry.contentGate !== true || contentRules.length === 0) {
      return { decision: 'allow', hard: [], soft: [], skipped: [], ruleIds: [] };
    }
    let result;
    try {
      result = scanPayloads(contentRules, payloadsFromArguments(args));
    } catch (error) {
      return { decision: 'deny', denied: `content rules cannot be evaluated (${error?.code ?? error?.message})`, hard: [], soft: [], skipped: [], ruleIds: [] };
    }
    if (result.hard.length > 0) {
      const hit = result.hard[0];
      return {
        decision: 'deny',
        denied: `content rule ${hit.rule} rejected this ${action} (${hit.field}: ${hit.excerpt})`,
        hard: result.hard,
        soft: result.soft,
        skipped: result.skipped,
        ruleIds: result.hard.map((finding) => finding.rule),
      };
    }
    return {
      // SOFT 命中不阻断，但要求人工停下来确认一次。
      decision: result.soft.length > 0 ? 'confirm' : 'allow',
      reason: result.soft.length > 0 ? `content rules flagged ${result.soft.map((finding) => finding.rule).join(', ')}` : undefined,
      hard: [],
      soft: result.soft,
      skipped: result.skipped,
      ruleIds: result.soft.map((finding) => finding.rule),
    };
  }

  async function requestApproval(ctx, exec, reason) {
    const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
    if (approval === undefined || approval === null || exec.agent === undefined) {
      return { ok: false, reason: `${reason}: no approval channel is available for this call` };
    }
    let outcome;
    try {
      outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal });
    } catch (error) {
      return { ok: false, reason: `${reason}: approval unavailable (${error?.message ?? error})` };
    }
    if (interruption(exec)) return { ok: false, reason: interruption(exec) };
    if (outcome !== 'allowed-once') return { ok: false, reason: `${reason}: ${outcome}` };
    return { ok: true };
  }

  /**
   * A range ticket covers repeated writes inside one task scope (principal,
   * change, repository, action). It is reusable and never consumed by use, but
   * every call still passes the other axes on its own.
   */
  function scopeOf(action, args) {
    const entry = catalog.get(action);
    if (entry === undefined || entry.confirmation !== 'scope') return undefined;
    return {
      principal: actorOf(),
      changeId: changeOf(args),
      repository: repositoryOf(action, args),
      action,
      revisions: typeof args?.revision === 'string' ? { [entry.target]: args.revision } : {},
    };
  }

  async function scopeAdmission(ctx, exec, action, args) {
    const request = scopeOf(action, args);
    if (request === undefined) return { ok: true, ticketId: undefined };
    if (scope === undefined || typeof scope.verify !== 'function') {
      return { ok: false, reason: `action "${action}" needs a task scope but no scope ledger is available` };
    }
    const verified = scope.verify(request);
    if (verified.ok === true) return { ok: true, ticketId: verified.ticketId };
    if (request.principal === undefined) return { ok: false, reason: `action "${action}" needs an authenticated identity for its task scope` };
    if (request.changeId === undefined) return { ok: false, reason: `action "${action}" needs a change id to establish its task scope` };
    const granted = await requestApproval(ctx, exec, `confirm a task scope for ${action} on ${request.repository ?? request.changeId}`);
    if (granted.ok !== true) return { ok: false, reason: verified.reason ?? `${action} is outside the current task scope` };
    const issued = scope.issue(request);
    return { ok: true, ticketId: issued.id };
  }

  async function prepare(ctx, exec, action) {
    if (!active) return deny('the policy service was disposed');
    if (attempted.has(exec)) return deny('the audit admission for this execution was already prepared');
    attempted.add(exec);
    // tools/result is an unawaited observer. Its fallback settlement must be
    // registered synchronously and drained HERE before another protected action.
    await Promise.all([...settlements]);
    if (interruption(exec)) return deny(interruption(exec));
    const entry = catalog.get(action);
    const pathReason = pathDenial(exec, action);
    if (pathReason !== undefined) return deny(pathReason);
    const actionDecision = decisionFor(exec.name, action, exec.arguments);
    if (actionDecision.action === 'deny') return deny(actionDecision.reason);
    const write = isWriteAction(action);
    const actor = actorOf();
    if (write && actor === undefined) {
      return deny(`write action "${action}" requires an authenticated identity`);
    }
    if (write && org.state === 'invalid') {
      return deny(`the organization policy envelope is invalid (${org.reason ?? 'unknown reason'}); write actions are refused`);
    }
    const content = contentOutcome(action, exec.arguments);
    if (content.decision === 'deny') return deny(content.denied ?? 'content rules rejected this call');
    const process = processOutcome(action, exec.arguments);
    if (process.decision === 'deny') return deny(process.reason ?? 'process rules rejected this call');
    let decision = strictestDecision(actionDecision.action, content.decision, process.decision);
    const scopeResult = write && decision !== 'deny'
      ? await scopeAdmission(ctx, exec, action, exec.arguments)
      : { ok: true };
    if (scopeResult.ok !== true) return deny(scopeResult.reason);
    if (decision === 'confirm') {
      const reason = content.reason ?? process.reason ?? actionDecision.reason ?? 'this action requires confirmation';
      const asked = await requestApproval(ctx, exec, reason);
      if (asked.ok !== true) return deny(asked.reason);
    }
    let digest;
    const agent = exec.agent;
    try { digest = snapshot(exec, action); } catch { return deny('execution arguments cannot be verified for audit'); }
    if (interruption(exec) || changed(exec, action, digest, agent)) return deny(interruption(exec) ?? 'execution arguments or identity changed during confirmation');
    const ruleIds = [...new Set([...content.ruleIds, ...process.ruleIds])];
    const extra = {
      policyVersion,
      ...(orgDigest === undefined ? {} : { orgDigest }),
      ruleIds,
      actor,
      approver: decision === 'confirm' || scopeResult.ticketId !== undefined ? 'host-approval' : '',
      unevaluated: process.unevaluated.map((item) => item.rule),
      mode: org.state === 'verified' ? 'managed' : 'personal',
    };
    try {
      if (audit === undefined) throw new Error('no audit barrier is available');
      const receipt = await audit.begin({
        action,
        target: typeof exec.arguments?.target === 'string' ? exec.arguments.target : undefined,
        tool: exec.name,
        decision,
        rule: actionDecision.rule ?? 'composed-decision',
        operationId: exec.callId,
        policyVersion: extra.policyVersion,
        ruleIds: extra.ruleIds,
        actor: extra.actor,
        approver: extra.approver,
        unevaluated: extra.unevaluated,
        mode: extra.mode,
        ...(extra.orgDigest === undefined ? {} : { orgDigest: extra.orgDigest }),
        contentDigest: digest,
      });
      if (interruption(exec) || changed(exec, action, digest, agent)) {
        await audit.settle(receipt, { decision: 'cancelled' });
        return deny(interruption(exec) ?? 'execution arguments or identity changed during audit');
      }
      receipts.set(exec, { receipt, digest, action, agent, used: false, actor, decision, ruleIds, ticketId: scopeResult.ticketId });
      if (decision === 'confirm') approved.add(exec);
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
    if (audit?.isDegraded()) return 'an earlier audit gap is still outstanding';
    if (settlements.size > 0) return 'a previous mandatory audit settlement is still pending';
    const admission = receipts.get(exec);
    if (admission === undefined) return 'the mandatory audit stage did not run for this execution';
    if (admission.used) return 'the audit admission for this execution was already consumed';
    if (admission.action !== action || changed(exec, action, admission.digest, admission.agent)) {
      return 'execution arguments or identity changed after the mandatory audit';
    }
    // 执行期复验身份与策略摘要：在确认或下游 await 期间变化一律拒绝。
    const reActor = actorOf();
    if (isWriteAction(action) && reActor !== admission.actor) {
      return 'the authenticated identity changed after the mandatory audit';
    }
    if (admission.decision === 'confirm' && !approved.has(exec)) {
      return `${decision.reason} (the confirmation stage did not run)`;
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
    dispose, isApproved: (exec) => approved.has(exec), policyVersion };
}
