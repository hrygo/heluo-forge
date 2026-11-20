/**
 * 门禁的宿主适配器：把 0–10 骨架落到 tools/pre-execute、tools 守卫与 command 面。
 *
 * P0 只保留 resolve → identity → audit → receipt 四段：登记目录里的写动作要求
 * 解析出 IAM actor，先落 `begin` 审计再放行；执行后 `settle` 补结果。一次性
 * 收据防止重放，执行前复验参数、身份与审计健康度。未登记动作（含全部读动作）
 * 是 out-of-scope：直接放行，不读身份、不写审计（D22/D23）。
 */

import { decideAction } from './catalog.mjs';
import { digestContent } from './content-rules.mjs';

const AUDIT_FAILURE_COPY = (action, sinkKind, target) => {
  const shape = target === undefined ? '(无目标)' : target.includes('/') ? target.split('/').slice(-2).join('/') : target;
  return `受控写「${action}」已中止：本次执行记录无法写入（存储 ${sinkKind}，目标 ${shape}）。`
    + '请检查策略日志目录的写权限、磁盘空间与路径配置后重试；在记录可写之前本次动作不会执行。';
};

const AUDIT_OUTSTANDING_COPY = '上一次执行记录尚未回写，为避免漏记，本次受控写已中止；请检查策略存储并确认缺口后重试。';

const IDENTITY_COPY = (action) => `未解析到 IAM 身份，受控写「${action}」已拒绝：请在「设置 → 账号」完成登录后重试。`;

function normalizeActor(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (value !== null && typeof value === 'object') {
    if (typeof value.principal === 'string' && value.principal.trim() !== '') return value.principal;
    if (typeof value.subject === 'string' && value.subject.trim() !== '') return value.subject;
  }
  return undefined;
}

function targetOf(exec) {
  const value = exec?.arguments?.target;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function digestOf(exec) {
  return digestContent({ name: exec?.name ?? null, arguments: exec?.arguments ?? null });
}

// `params` 只写调用摘要：正文/评论/补丁等业务内容既不落审计，也不进日志。
// 需要的完整性由 `contentDigest`（参数整体摘要）承担。
const CONTENT_ARG_KEYS = new Set(['title', 'body', 'description', 'content', 'message', 'comment', 'review', 'summary', 'text', 'diff', 'patch']);

function summarizeArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args ?? {};
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    summary[key] = CONTENT_ARG_KEYS.has(key) ? '[content]' : value;
  }
  return summary;
}

function agentKindOf(exec) {
  if (exec?.agent === null || exec?.agent === undefined) return 'host';
  if (typeof exec.agent.kind === 'string') return exec.agent.kind;
  if (exec.agent.id !== undefined) return 'agent';
  return 'host';
}

function deny(reason) {
  return Object.freeze({ kind: 'deny', reason });
}

function toolAction(tools, toolName) {
  if (tools instanceof Map) return tools.get(toolName);
  if (tools !== null && typeof tools === 'object' && Object.hasOwn(tools, toolName)) return tools[toolName];
  return undefined;
}

/**
 * @param {{catalog: Map, rules?: object, pipeline?: readonly object[], audit: object,
 *   tools?: object | Map, getActor?: Function, onDecision?: Function, now?: () => number}} options
 */
export function createGate({
  catalog,
  rules = {},
  pipeline = [],
  audit,
  tools = {},
  getActor,
  onDecision,
  now,
} = {}) {
  const stages = Object.freeze([...(pipeline ?? [])]);
  const clock = now ?? (() => Date.now());
  const approved = new WeakMap();
  const admitting = new WeakSet();
  const admitted = new Map();
  const pendingSettlements = new Set();
  let disposed = false;

  function actionFor(toolName) {
    return toolAction(tools, toolName);
  }

  function isControlled(action) {
    return catalog instanceof Map && catalog.has(action);
  }

  function isEnforced(toolName) {
    const action = actionFor(toolName);
    return action !== undefined && isControlled(action);
  }

  function check(toolName, request = {}) {
    const action = actionFor(toolName) ?? (isControlled(toolName) ? toolName : undefined);
    if (action === undefined) {
      return Object.freeze({ action: 'allow', rule: 'out-of-scope', reason: `tool "${toolName}" is not under policy control` });
    }
    const decision = decideAction({ catalog, rules, action, target: request?.target });
    onDecision?.(decision);
    return decision;
  }

  async function settle(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    const promise = audit.settle(entry.receipt, { decision: outcome.decision, rule: outcome.rule ?? entry.decision?.rule, ...outcome.extra });
    pendingSettlements.add(promise);
    try {
      await promise;
    } finally {
      pendingSettlements.delete(promise);
    }
  }

  /**
   * Resolve → identity → audit, then register the one-shot receipt.
   * Returns `{kind:'allow'}` or `{kind:'deny', reason}`.
   */
  async function admit(ctx, exec, action) {
    // One execution object gets exactly one admission, even under concurrent
    // prepare listeners; a second one must not mint another receipt.
    if (approved.has(exec) || admitting.has(exec)) {
      return deny('this execution was already admitted by the policy gate');
    }
    admitting.add(exec);
    try {
      return await admitOnce(ctx, exec, action);
    } finally {
      admitting.delete(exec);
    }
  }

  async function admitOnce(ctx, exec, action) {
    const target = targetOf(exec);
    const decision = decideAction({ catalog, rules, action, target });
    onDecision?.(decision);
    if (decision.action !== 'allow') {
      return deny(decision.reason);
    }
    const actor = normalizeActor(await getActor?.(ctx));
    if (actor === undefined) {
      return deny(IDENTITY_COPY(action));
    }
    const digest = digestOf(exec);
    let receipt;
    try {
      receipt = await audit.begin({
        subject: actor,
        actor,
        action,
        target,
        tool: exec?.name,
        decision: 'allow',
        rule: decision.rule,
        operationId: exec?.callId === undefined ? undefined : String(exec.callId),
        policyVersion: undefined,
        agent: { kind: agentKindOf(exec) },
        summary: `受控写 ${action}（目标 ${target ?? '(未提供)'}）`,
        params: summarizeArguments(exec?.arguments ?? {}),
        contentDigest: digest,
      });
    } catch (error) {
      if (error?.code === 'POLICY_AUDIT_GAP_OUTSTANDING') return deny(AUDIT_OUTSTANDING_COPY);
      return deny(AUDIT_FAILURE_COPY(action, audit?.sinks?.()?.kind ?? 'memory', target));
    }
    const entry = {
      exec,
      action,
      target,
      actor,
      digest,
      decision,
      receipt,
      startedAt: receipt.startedAt,
      used: false,
      settled: false,
    };
    approved.set(exec, entry);
    if (exec?.callId !== undefined) admitted.set(String(exec.callId), exec);
    return Object.freeze({ kind: 'allow' });
  }

  async function cancel(entry, reason, rule = 'cancelled') {
    await settle(entry, { decision: 'cancelled', rule });
    return deny(reason);
  }

  async function preExecute(ctx, exec, next) {
    const action = actionFor(exec?.name);
    if (action === undefined || !isControlled(action)) {
      return typeof next === 'function' ? next() : Object.freeze({ kind: 'allow' });
    }
    if (disposed) return deny('the policy gate is no longer mounted');
    // A final-result observer settles asynchronously; the next controlled call
    // waits for it so a failed settlement cannot slip through as a fresh begin.
    if (pendingSettlements.size > 0) await Promise.allSettled([...pendingSettlements]);
    if (typeof audit?.isDegraded === 'function' && audit.isDegraded()) return deny(AUDIT_OUTSTANDING_COPY);
    const admission = await admit(ctx, exec, action);
    if (admission.kind !== 'allow') return admission;
    const entry = approved.get(exec);
    if (typeof next !== 'function') return admission;
    let downstream;
    try {
      downstream = await next();
    } catch (error) {
      await settle(entry, { decision: 'error', rule: 'downstream-failed' });
      throw error;
    }
    if (downstream !== undefined && downstream?.kind !== 'allow') {
      return cancel(entry, downstream?.reason ?? 'a downstream stage refused the call', 'downstream-refused');
    }
    if (disposed) return cancel(entry, 'the policy gate was unloaded before the call started');
    if (exec?.signal?.aborted === true) return cancel(entry, 'the call was cancelled after it was admitted');
    if (digestOf(exec) !== entry.digest) return cancel(entry, 'the arguments changed before the call started');
    const current = normalizeActor(await getActor?.(ctx));
    if (typeof getActor === 'function' && current !== entry.actor) {
      return cancel(entry, 'the IAM identity changed after the call was admitted');
    }
    return Object.freeze({ kind: 'allow' });
  }

  function guard(ctxOrExec, maybeExec) {
    const exec = maybeExec ?? ctxOrExec;
    const action = actionFor(exec?.name);
    if (action === undefined || !isControlled(action)) return undefined;
    if (disposed) return 'the policy gate is no longer mounted';
    const entry = approved.get(exec);
    if (entry === undefined) {
      return exec?.callId !== undefined && admitted.has(String(exec.callId))
        ? 'this call id was already admitted by another call'
        : 'this call was not admitted by the policy gate';
    }
    if (entry.used) return 'the admission receipt for this call was already used';
    if (typeof audit?.isDegraded === 'function' && audit.isDegraded()) {
      return 'an earlier audit gap is outstanding; the call is refused until it is acknowledged';
    }
    if (pendingSettlements.size > 0) return 'a previous settlement is still pending; the call is refused';
    if (exec?.signal?.aborted === true) return 'the call was cancelled after it was admitted';
    if (digestOf(exec) !== entry.digest) return 'the arguments changed after the call was admitted';
    if (typeof getActor === 'function' && normalizeActor(getActor(undefined)) !== entry.actor) {
      return 'the IAM identity changed after the call was admitted';
    }
    entry.used = true;
    return undefined;
  }

  async function postExecute(exec, result) {
    const entry = approved.get(exec);
    if (entry === undefined || entry.settled) return;
    const failed = result?.isError === true || result?.kind === 'error';
    await settle(entry, { decision: failed ? 'error' : 'executed' });
  }

  async function executeAction(ctx, action, exec, operation) {
    if (typeof operation !== 'function') {
      return { kind: 'error', text: '受控写缺少执行体，已拒绝执行。' };
    }
    if (!isControlled(action)) return operation();
    if (disposed) return { kind: 'error', text: 'the policy gate is no longer mounted' };
    const record = exec ?? {};
    const admission = await admit(ctx, record, action);
    if (admission.kind !== 'allow') return { kind: 'error', text: admission.reason };
    const entry = approved.get(record);
    entry.used = true;
    let result;
    try {
      result = await operation();
    } catch (error) {
      await settle(entry, { decision: 'error', rule: 'operation-failed' });
      throw error;
    }
    const current = normalizeActor(await getActor?.(ctx));
    if (typeof getActor === 'function' && current !== entry.actor) {
      await settle(entry, { decision: 'error', rule: 'identity-changed' });
      return { kind: 'error', text: '执行后复验发现 IAM 身份已变化，本次动作结果按失败处理。' };
    }
    const failed = result?.isError === true || result?.kind === 'error';
    await settle(entry, { decision: failed ? 'error' : 'executed' });
    return result;
  }

  function dispose() {
    disposed = true;
    for (const entry of admitted.values()) {
      const admittedEntry = approved.get(entry);
      if (admittedEntry !== undefined && !admittedEntry.settled) {
        void settle(admittedEntry, { decision: 'unknown', rule: 'gate-disposed' });
      }
    }
    admitted.clear();
  }

  return Object.freeze({
    stages,
    actionFor,
    isEnforced,
    check,
    preExecute,
    guard,
    postExecute,
    executeAction,
    dispose,
    now: clock,
  });
}
