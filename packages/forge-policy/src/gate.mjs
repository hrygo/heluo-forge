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
import { approvalDisplayReason, confirmationDisplayReason } from './prompts.mjs';
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
  const snapshot = (exec, action) => digestContent({
    action,
    name: exec.name,
    arguments: exec.arguments,
    content: exec.content,
    callId: exec.callId,
  });
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
    // `owner/name!12` 与 `owner/name#12` 指的是同一仓库里的同一个对象；作用域必须按仓库算，
    // 否则同一任务的两种写法会各自要一次确认，把"一条任务一次确认"退化成逐次询问。
    const cut = target.search(/[#!]/u);
    return cut === -1 ? target : target.slice(0, cut);
  }

  /**
   * The trusted session identity a task scope belongs to. A range ticket is a
   * per-session grant: the same authenticated principal in another session must
   * confirm again, otherwise one confirmation leaks across sessions.
   */
  function sessionOf(exec) {
    const agent = exec?.agent;
    if (typeof agent === 'string' && agent.trim() !== '') return agent.trim();
    const id = agent?.id;
    if (typeof id === 'string' && id.trim() !== '') return id.trim();
    return undefined;
  }

  function changeOf(args) {
    if (typeof args?.changeId === 'string' && args.changeId.trim().length > 0) return args.changeId;
    if (typeof args?.change === 'string' && args.change.trim().length > 0) return args.change;
    return undefined;
  }

  /**
   * 工具写入的正文通过 `exec.content` 这一私有通道进来：它参与内容/流程判定与摘要，
   * 但不进入参数对象，也不写进审计记录。
   */
  const withContent = (args, content) => (content === undefined || content === null ? args : { ...args, ...content });

  function processOutcome(action, args, content) {
    const entry = catalog.get(action);
    if (entry === undefined || entry.processRules.length === 0) {
      return { decision: 'allow', deny: [], confirm: [], unevaluated: [], ruleIds: [] };
    }
    const sources = typeof getFactSources === 'function'
      ? getFactSources({ action, changeId: changeOf(args) }) ?? {} : {};
    const facts = withSources(factsFromArguments(withContent(args, content)), sources);
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

  function contentOutcome(action, args, content) {
    const entry = catalog.get(action);
    if (entry === undefined || entry.contentGate !== true || contentRules.length === 0) {
      return { decision: 'allow', hard: [], soft: [], skipped: [], ruleIds: [] };
    }
    let result;
    try {
      result = scanPayloads(contentRules, payloadsFromArguments(withContent(args, content)));
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
      decision: result.soft.length > 0 || result.skipped.length > 0 ? 'confirm' : 'allow',
      reason: result.soft.length > 0 ? `content rules flagged ${result.soft.map((finding) => finding.rule).join(', ')}` : undefined,
      hard: [],
      soft: result.soft,
      skipped: result.skipped,
      ruleIds: result.soft.map((finding) => finding.rule),
    };
  }

  async function requestApproval(ctx, exec, reason, display) {
    const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
    if (approval === undefined || approval === null || exec.agent === undefined) {
      return { ok: false, reason: `${reason}: no approval channel is available for this call` };
    }
    let outcome;
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason,
        ...(display === undefined ? {} : { displayReason: display }),
        signal: exec.signal,
      });
    } catch (error) {
      return { ok: false, reason: `${reason}: approval unavailable (${error?.message ?? error})` };
    }
    if (interruption(exec)) return { ok: false, reason: interruption(exec) };
    if (outcome !== 'allowed-once') return { ok: false, reason: `${reason}: ${outcome}` };
    return { ok: true };
  }

  /**
   * A range ticket covers repeated writes inside one task scope (principal,
   * session, change, repository, action). It is reusable and never consumed by
   * use, but every call still passes the other axes on its own, and a ticket
   * never carries over to another session.
   */
  function scopeOf(action, args, exec) {
    const entry = catalog.get(action);
    if (entry === undefined || entry.confirmation !== 'scope') return undefined;
    return {
      principal: actorOf(),
      session: sessionOf(exec),
      changeId: changeOf(args),
      repository: repositoryOf(action, args),
      action,
      revisions: typeof args?.revision === 'string' ? { [entry.target]: args.revision } : {},
    };
  }

  async function scopeAdmission(ctx, exec, action, args) {
    const request = scopeOf(action, args, exec);
    if (request === undefined) return { ok: true, ticketId: undefined };
    if (scope === undefined || typeof scope.verify !== 'function') {
      return { ok: false, reason: `action "${action}" needs a task scope but no scope ledger is available` };
    }
    const verified = scope.verify(request);
    if (verified.ok === true) return { ok: true, ticketId: verified.ticketId };
    if (request.principal === undefined) return { ok: false, reason: `action "${action}" needs an authenticated identity for its task scope` };
    if (request.changeId === undefined) return { ok: false, reason: `action "${action}" needs a change id to establish its task scope` };
    if (request.session === undefined) return { ok: false, reason: `action "${action}" needs a trusted session to establish its task scope` };
    const granted = await requestApproval(
      ctx,
      exec,
      `confirm a task scope for ${action} on ${request.repository ?? request.changeId}`,
      approvalDisplayReason({ action, repository: request.repository, changeId: request.changeId, args }),
    );
    // 审批侧的真实原因（被拒、无应答者、通道异常）优先于票据文案：只报票据
    // 文案时，用户点了"拒绝"和从未弹窗得到的是同一句话。
    if (granted.ok !== true) return { ok: false, reason: granted.reason ?? verified.reason ?? `${action} is outside the current task scope` };
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
    if (entry?.revision === true && (typeof exec.arguments?.revision !== 'string' || exec.arguments.revision.trim() === '')) {
      return deny(`action "${action}" requires a revision, and none was supplied`);
    }
    const write = isWriteAction(action);
    const actor = actorOf();
    if (write && actor === undefined) {
      return deny(`write action "${action}" requires an authenticated identity`);
    }
    if (write && org.state === 'invalid') {
      return deny(`the organization policy envelope is invalid (${org.reason ?? 'unknown reason'}); write actions are refused`);
    }
    // 写正文可以由调用方按需提供（例如推送前读取提交集合）：只有走到内容域才解析，
    // 被能力域拒绝的调用不产生任何额外读取。解析失败按"内容无法判定"拒绝。
    if (typeof exec.content === 'function') {
      try { exec.content = await exec.content(); } catch (error) {
        return deny(`content for ${action} cannot be read (${error?.code ?? error?.message})`);
      }
    }
    const content = contentOutcome(action, exec.arguments, exec.content);
    if (content.decision === 'deny') return deny(content.denied ?? 'content rules rejected this call');
    const process = processOutcome(action, exec.arguments, exec.content);
    if (process.decision === 'deny') return deny(process.reason ?? 'process rules rejected this call');
    let decision = strictestDecision(actionDecision.action, content.decision, process.decision);
    // 摘要与身份必须在任何等待（范围确认、逐次确认、审计）之前采集：等待期间参数或
    // 正文被改写时，后续复验会发现并拒绝，而不是只把新值写进收据。
    const agent = exec.agent;
    let digest;
    try { digest = snapshot(exec, action); } catch { return deny('execution arguments cannot be verified for audit'); }
    const scopeResult = write && decision !== 'deny'
      ? await scopeAdmission(ctx, exec, action, exec.arguments)
      : { ok: true };
    if (scopeResult.ok !== true) return deny(scopeResult.reason);
    if (decision === 'confirm') {
      const reason = [content.reason ?? process.reason ?? actionDecision.reason ?? 'this action requires confirmation',
        ...(content.skipped.length ? [`content scan incomplete: ${content.skipped.map(({ field, reason: why }) => `${field} (${why})`).join(', ')}`] : []),
      ].join('; ');
      const asked = await requestApproval(ctx, exec, reason, confirmationDisplayReason({
        action,
        repository: repositoryOf(action, exec.arguments),
        changeId: changeOf(exec.arguments),
        args: exec.arguments,
        rules: [...content.soft.map((finding) => finding.rule), ...process.confirm.map((item) => item.rule)],
        skipped: content.skipped,
      }));
      if (asked.ok !== true) return deny(asked.reason);
    }
    if (interruption(exec) || changed(exec, action, digest, agent)) return deny(interruption(exec) ?? 'execution arguments or identity changed during confirmation');
    const ruleIds = [...new Set([...content.ruleIds, ...process.ruleIds])];
    const extra = {
      policyVersion,
      ...(orgDigest === undefined ? {} : { orgDigest }),
      ruleIds,
      actor,
      approver: decision === 'confirm' || scopeResult.ticketId !== undefined ? 'host-approval' : '',
      unevaluated: process.unevaluated.map((item) => item.rule),
      contentSkipped: content.skipped.map(({ field, reason }) => `${field}:${reason}`),
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
        contentSkipped: extra.contentSkipped,
        mode: extra.mode,
        ...(extra.orgDigest === undefined ? {} : { orgDigest: extra.orgDigest }),
        contentDigest: digest,
      });
      if (interruption(exec) || changed(exec, action, digest, agent)) {
        await audit.settle(receipt, { decision: 'cancelled' });
        return deny(interruption(exec) ?? 'execution arguments or identity changed during audit');
      }
      receipts.set(exec, { receipt, digest, action, agent, used: false, actor, decision, ruleIds,
        processConfirm: process.confirm.map((item) => item.rule), ticketId: scopeResult.ticketId });
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
    // Facts can change while approval, audit, or downstream listeners await.
    // A new soft finding was not covered by the earlier confirmation either.
    const process = processOutcome(action, exec.arguments, exec.content);
    if (process.decision === 'deny') return process.reason ?? 'process rules rejected this call';
    const newConfirmation = process.confirm.find((item) => !admission.processConfirm.includes(item.rule));
    if (newConfirmation !== undefined) return newConfirmation.reason;
    // 范围票据可能在确认、审计或下游 await 期间被撤销或换绑：执行前按票据号复验，
    // 撤销后的收据不能再放行一次写。
    if (admission.ticketId !== undefined) {
      const request = scopeOf(action, exec.arguments, exec);
      const verified = request === undefined || scope === undefined || typeof scope.verify !== 'function'
        ? { ok: false }
        : scope.verify(request);
      if (verified.ok !== true || verified.ticketId !== admission.ticketId) {
        return 'the task scope for this execution is no longer valid';
      }
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
    let reason;
    try {
      reason = guardAction(exec, action);
    } catch (error) {
      // A failed final check did not run the operation; close its audit receipt.
      await postExecute(exec, { kind: 'error' });
      throw error;
    }
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
