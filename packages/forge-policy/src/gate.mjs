/**
 * 门禁的宿主适配器：唯一放行点 `admitOnce`，三条入口（tools/pre-execute、tools
 * 守卫、command 面）共用同一判定。
 *
 * P1 在 P0 的 resolve → identity → audit → receipt 之间插入两段：来源判定（子代理
 * 一律不写）与逐次确认（命中 `confirmPush`/`confirmDopWrite` 时弹一次卡片，超时或
 * 通道缺失即拒绝）。允许结论进会话内 LRU：同一次调用的重试不再打扰用户，但仍要
 * 过身份复验、参数摘要复验与一次性收据。未登记动作（含全部读动作）是 out-of-scope：
 * 直接放行，不读身份、不写审计（D22/D23）。
 */

import { decideAction } from './catalog.mjs';
import { digestContent } from './content-rules.mjs';
import { DEFAULT_CONFIRMATION_TIMEOUT_MS } from './config.mjs';
import {
  CONFIRM_CODES,
  CONFIRM_REASONS,
  buildConfirmationCard,
} from './confirm.mjs';
import {
  PERSONA,
  agentKindOf,
  confirmDelegatedCopy,
  delegationCopy,
  delegationSummary,
  personaOf,
} from './delegation.mjs';
import { reuseKeyOf } from './reuse.mjs';

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

/**
 * 参数摘要只覆盖工具名与 arguments，用于放行后的"参数有没有被改写"复验——
 * 这一步必须同步，正文通道（`exec.content`）可能是异步函数，不能塞进来。
 */
function staticDigestOf(exec) {
  return digestContent({ name: exec?.name ?? null, arguments: exec?.arguments ?? null });
}

/**
 * 正文摘要额外覆盖 `exec.content`：Gitee 与 DevOps 把写出去的正文放在这条私有通道上，
 * 只散列 arguments 会让"同目标、同参数、不同正文"的两次写在审计里长得一模一样。
 * 函数形式的正文在这里解析一次；解析失败用占位符，避免因为读不到正文就放行无记录。
 */
function digestInput(exec, content) {
  return {
    name: exec?.name ?? null,
    arguments: exec?.arguments ?? null,
    ...(content === undefined ? {} : { content }),
  };
}

/** 正文是普通对象时同步算：放行路径上多余的 await 会改变宿主看到的时序。 */
function contentDigestOf(exec) {
  if (typeof exec?.content !== 'function') return digestContent(digestInput(exec, exec?.content));
  return (async () => {
    try {
      return digestContent(digestInput(exec, await exec.content()));
    } catch {
      return digestContent(digestInput(exec, '[content-unavailable]'));
    }
  })();
}

/**
 * `subject` 是 provider 自证（Gitee guard 要求 `gitee`），与 IAM `actor` 是两个字段。
 * 从工具名前缀推断来源，推断不出来就不写，交给消费方按"没自证"处理。
 */
function subjectOf(toolName, action) {
  const name = typeof toolName === 'string' ? toolName : '';
  if (name.startsWith('forge_gitee_')) return 'gitee';
  if (name.startsWith('forge_devops_')) return 'devops';
  if (typeof action === 'string' && action.startsWith('gitee.')) return 'gitee';
  return undefined;
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

/**
 * 六个 `POLICY_CONFIRM_*` 码的用户文案：码本身留在结构化结果与审计里，不拼进正文。
 * 每条都说清"没有执行"与"能否重试"，也都不提内部路径或实现细节。
 */
const CONFIRM_DENY_COPY = Object.freeze({
  [CONFIRM_CODES.DENIED]: (action) => `受控写「${action}」已取消：你在确认卡片上选择了取消本次写入。可重新发起该动作。`,
  [CONFIRM_CODES.TIMEOUT]: (action, seconds) => `受控写「${action}」未执行：等待人工确认超时（${seconds} 秒）。可重新发起该动作。`,
  [CONFIRM_CODES.UNAVAILABLE]: (action) => `受控写「${action}」未执行：当前环境没有可用的确认通道（需要桌面端人工确认）。请在桌面端重试。`,
  [CONFIRM_CODES.INVALID_ANSWER]: (action) => `受控写「${action}」未执行：确认应答无法识别，按未确认处理。请重新发起该动作。`,
  [CONFIRM_CODES.DELEGATED]: (action) => confirmDelegatedCopy(action),
  [CONFIRM_CODES.ERROR]: (action) => `受控写「${action}」未执行：确认流程出现异常。请重试；若持续失败请联系管理员。`,
});

/** 审计里对确认结论的一句话：超时与通道缺失不能写成"用户拒绝"。 */
const ANSWER_SUMMARY = Object.freeze({
  [CONFIRM_CODES.DENIED]: '取消本次写入',
  [CONFIRM_CODES.TIMEOUT]: '等待超时，未确认',
  [CONFIRM_CODES.UNAVAILABLE]: '确认通道不可用，未确认',
  [CONFIRM_CODES.INVALID_ANSWER]: '应答无法识别，未确认',
  [CONFIRM_CODES.DELEGATED]: '子代理来源，未确认',
  [CONFIRM_CODES.ERROR]: '确认流程异常，未确认',
});

/** 确认记录写不进去时本次动作不执行；文案不提「审计」，只说记录没写成。 */
const CONFIRM_RECORD_FAILED_COPY = (action) => `受控写「${action}」未执行：本次的确认过程没有留下可用记录，按未确认处理。请检查策略存储后重试。`;

function denyCopyOf(code, action, timeoutMs) {
  const seconds = Math.max(1, Math.round((Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CONFIRMATION_TIMEOUT_MS) / 1_000));
  const copy = code !== undefined && Object.hasOwn(CONFIRM_DENY_COPY, code) ? CONFIRM_DENY_COPY[code] : undefined;
  return (copy ?? CONFIRM_DENY_COPY[CONFIRM_CODES.ERROR])(action, seconds);
}

function answerSummary(decision, code) {
  if (decision === 'allow') return '允许本次写入';
  return code !== undefined && Object.hasOwn(ANSWER_SUMMARY, code) ? ANSWER_SUMMARY[code] : '未确认';
}

function deny(reason, code) {
  return code === undefined
    ? Object.freeze({ kind: 'deny', reason })
    : Object.freeze({ kind: 'deny', reason, code });
}

function toolAction(tools, toolName) {
  if (tools instanceof Map) return tools.get(toolName);
  if (tools !== null && typeof tools === 'object' && Object.hasOwn(tools, toolName)) return tools[toolName];
  return undefined;
}

/**
 * @param {{catalog: Map, rules?: object, pipeline?: readonly object[], audit: object,
 *   tools?: object | Map, getActor?: Function, onDecision?: Function, now?: () => number,
 *   confirmations?: {ask: Function}, decisionCache?: object, timeoutMs?: number}} options
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
  confirmations,
  decisionCache,
  timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
} = {}) {
  const stages = Object.freeze([...(pipeline ?? [])]);
  const clock = now ?? (() => Date.now());
  const approved = new WeakMap();
  const admitting = new WeakSet();
  const admitted = new Map();
  const pendingSettlements = new Set();
  const confirmationTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONFIRMATION_TIMEOUT_MS;
  let confirmationCount = 0;
  let disposed = false;

  function callIdOf(exec) {
    const value = exec?.callId;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  /** 单条审计（asked/answered/来源拒绝）。写失败只回报 false，由调用方决定拒绝。 */
  async function writeRecord(fields) {
    if (audit === undefined || audit === null || typeof audit.record !== 'function') return false;
    try {
      await audit.record(fields);
      return true;
    } catch {
      return false;
    }
  }

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
    // 结清即释放：`admitted` 只用来在放行与结清之间挡住同一个 callId 的并发重放，
    // 留着已结清的条目会把执行对象（含正文）一直强引用到插件卸载。
    if (entry.exec?.callId !== undefined) admitted.delete(String(entry.exec.callId));
    // 失败/取消/未知的调用没有换来一个可复用的"允许"：撤掉缓存，重试仍要重新确认。
    if (entry.cacheKey !== undefined && outcome.decision !== 'executed') {
      decisionCache?.delete?.(entry.cacheKey);
    }
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
    if (decision.action === 'deny') {
      return deny(decision.reason);
    }
    const persona = personaOf(exec?.agent);
    const kind = agentKindOf(exec);
    const operationId = exec?.callId === undefined ? undefined : String(exec.callId);
    // 来源闸在身份之前：子代理不该比主会话更容易拿到一次写入。
    if (persona === PERSONA.CHILD && rules?.denyDelegatedWrites === true) {
      await writeRecord({
        action,
        target,
        tool: exec?.name,
        decision: 'deny',
        rule: 'deny-delegated-writes',
        code: CONFIRM_CODES.DELEGATED,
        operationId,
        agent: { kind },
        summary: delegationSummary(action),
      });
      return deny(delegationCopy(action), CONFIRM_CODES.DELEGATED);
    }
    const actor = normalizeActor(await getActor?.(ctx));
    if (actor === undefined) {
      return deny(IDENTITY_COPY(action));
    }
    const digest = staticDigestOf(exec);
    const contentDigest = typeof exec?.content === 'function'
      ? await contentDigestOf(exec)
      : contentDigestOf(exec);
    const subject = subjectOf(exec?.name, action);
    let rule = decision.rule;
    let cacheKey;
    if (decision.action === 'confirm') {
      const callId = callIdOf(exec);
      const key = reuseKeyOf({ tool: exec?.name, callId, action, digest });
      const hit = key !== undefined && decisionCache !== undefined ? decisionCache.peek(key) : undefined;
      if (hit !== undefined && hit.digest === digest && hit.action === action) {
        // 同一个决定的重试：不再打扰用户，但仍要过身份复验、一次性收据与执行后复验。
        decisionCache.touch(key);
        cacheKey = key;
        rule = 'reused-decision';
      } else {
        if (persona === PERSONA.CHILD) {
          await writeRecord({
            action,
            target,
            tool: exec?.name,
            decision: 'deny',
            rule: 'confirm-delegated-refused',
            code: CONFIRM_CODES.DELEGATED,
            operationId,
            agent: { kind },
            summary: delegationSummary(action),
          });
          return deny(confirmDelegatedCopy(action), CONFIRM_CODES.DELEGATED);
        }
        const reasons = ['action'];
        const card = buildConfirmationCard({ action, target, args: exec?.arguments ?? {}, reasons });
        const askedAt = clock();
        const asked = await writeRecord({
          ...(subject === undefined ? {} : { subject }),
          actor,
          action,
          target,
          tool: exec?.name,
          decision: 'pending',
          rule: 'confirm-required',
          operationId,
          agent: { kind },
          summary: `受控写 ${action} 需要人工确认（${reasons.map((reason) => CONFIRM_REASONS[reason]).join('；')}）`,
          phase: 'asked',
        });
        // 先有记录，再问人：asked 写不进去时连卡片都不该弹。
        if (!asked) return deny(CONFIRM_RECORD_FAILED_COPY(action), CONFIRM_CODES.ERROR);
        confirmationCount += 1;
        const verdict = (await confirmations?.ask({
          ctx,
          agent: exec?.agent,
          action,
          questions: card.questions,
          timeoutMs: confirmationTimeoutMs,
        })) ?? { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE };
        const answeredOk = await writeRecord({
          ...(subject === undefined ? {} : { subject }),
          actor,
          action,
          target,
          tool: exec?.name,
          decision: verdict.decision,
          ...(verdict.decision === 'allow' ? {} : { code: verdict.code }),
          rule: 'confirm-required',
          operationId,
          agent: { kind },
          durationMs: clock() - askedAt,
          summary: `受控写 ${action} 的确认结论：${answerSummary(verdict.decision, verdict.code)}`,
          phase: 'answered',
        });
        if (!answeredOk) return deny(CONFIRM_RECORD_FAILED_COPY(action), CONFIRM_CODES.ERROR);
        if (verdict.decision !== 'allow') {
          return deny(denyCopyOf(verdict.code, action, confirmationTimeoutMs), verdict.code ?? CONFIRM_CODES.ERROR);
        }
        if (key !== undefined && decisionCache !== undefined) {
          decisionCache.set({ key, tool: exec?.name, callId, action, digest, decidedAt: clock() });
          cacheKey = key;
        }
        rule = 'confirm-allowed';
      }
    }
    let receipt;
    try {
      receipt = await audit.begin({
        ...(subject === undefined ? {} : { subject }),
        actor,
        action,
        target,
        tool: exec?.name,
        decision: 'allow',
        rule,
        operationId,
        policyVersion: undefined,
        agent: { kind },
        summary: `受控写 ${action}（目标 ${target ?? '(未提供)'}）`,
        params: summarizeArguments(exec?.arguments ?? {}),
        contentDigest,
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
      staticDigest: digest,
      decision,
      receipt,
      cacheKey,
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
    const changedReason = await recheck(entry, exec, ctx);
    if (changedReason !== undefined) return cancel(entry, changedReason.reason);
    return Object.freeze({ kind: 'allow' });
  }

  /**
   * 放行之后、执行之前的最终复验：卸载、取消、参数改写、身份切换，任何一项变化都不能
   * 让这次写入落地。`tools/pre-execute` 与 `executeAction` 共用这一份判定，避免两条入口
   * 各自维护、慢慢走样。
   */
  async function recheck(entry, exec, ctx) {
    if (disposed) return { reason: 'the policy gate was unloaded before the call started', rule: 'unloaded' };
    if (exec?.signal?.aborted === true) return { reason: 'the call was cancelled after it was admitted', rule: 'cancelled' };
    if (staticDigestOf(exec) !== entry.staticDigest) {
      return { reason: 'the arguments changed before the call started', rule: 'arguments-changed' };
    }
    if (typeof getActor === 'function') {
      const current = normalizeActor(await getActor(ctx));
      if (current !== entry.actor) return { reason: 'the IAM identity changed after the call was admitted', rule: 'identity-changed' };
    }
    return undefined;
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
    if (staticDigestOf(exec) !== entry.staticDigest) return 'the arguments changed after the call was admitted';
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

  /** `recheck` 的拒绝文案：说清"没有执行"，也不把内部规则名抛给用户。 */
  function executeDenyCopy(action, rule) {
    if (rule === 'cancelled') return `受控写「${action}」已取消：调用在排队等待期间被取消，本次未执行。`;
    if (rule === 'identity-changed') return `受控写「${action}」未执行：等待期间登录身份发生变化，请重新发起该动作。`;
    if (rule === 'arguments-changed') return `受控写「${action}」未执行：等待期间参数发生变化，请重新发起该动作。`;
    if (rule === 'unloaded') return `受控写「${action}」未执行：策略插件已卸载，本次未执行。`;
    return `受控写「${action}」未执行：放行后状态发生变化。`;
  }

  async function executeAction(ctx, action, exec, operation) {
    if (typeof operation !== 'function') {
      return { kind: 'error', text: '受控写缺少执行体，已拒绝执行。' };
    }
    if (!isControlled(action)) return operation();
    if (disposed) return { kind: 'error', text: 'the policy gate is no longer mounted' };
    const record = exec ?? {};
    const admission = await admit(ctx, record, action);
    // 拒绝时 code 必须跟着结构化结果一起交出去，调用方不能只有一句自然语言可用。
    if (admission.kind !== 'allow') {
      return admission.code === undefined
        ? { kind: 'error', text: admission.reason }
        : { kind: 'error', text: admission.reason, code: admission.code };
    }
    const entry = approved.get(record);
    const changedReason = await recheck(entry, record, ctx);
    if (changedReason !== undefined) {
      await settle(entry, { decision: 'cancelled', rule: changedReason.rule });
      return { kind: 'error', text: executeDenyCopy(action, changedReason.rule) };
    }
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
    /** 本次挂载内真正发起过的人工询问次数（复用命中不计数）。 */
    confirmationCount: () => confirmationCount,
    dispose,
    now: clock,
    /** 诊断用：还在"已放行、未结清"之间的执行数（结清后必须归零，否则执行对象被长期持有）。 */
    pendingAdmissions: () => admitted.size,
  });
}
