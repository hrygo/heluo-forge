/**
 * 确认卡片：载荷构造、应答判定与宿主 `userQuestions` 通道。
 *
 * 三件事都必须是 fail-closed 的：载荷只含动作可读名、目标定位与原因类别；应答只有
 * "每题恰为允许标签"才算允许，其余一律拒绝；通道缺失、无应答端、超时、宿主异常都
 * 映射成六个 `POLICY_CONFIRM_*` 码之一，永不向调用方抛错，也永不挂死。
 *
 * 判定与文案常量都在这里定义一次，gate 只按码取文案，不二次推断结论。
 */

import { CONFIRM_ACTION_LABELS, REASON_LABELS, confirmationCardCopy } from './prompts.mjs';
import { PERSONA, personaOf } from './delegation.mjs';

export const CONFIRM_CODES = Object.freeze({
  DENIED: 'POLICY_CONFIRM_DENIED',
  TIMEOUT: 'POLICY_CONFIRM_TIMEOUT',
  UNAVAILABLE: 'POLICY_CONFIRM_UNAVAILABLE',
  INVALID_ANSWER: 'POLICY_CONFIRM_INVALID_ANSWER',
  DELEGATED: 'POLICY_CONFIRM_DELEGATED',
  CANCELLED: 'POLICY_CONFIRM_CANCELLED',
  ERROR: 'POLICY_CONFIRM_ERROR',
});

export const CONFIRM_LABELS = Object.freeze({
  allow: CONFIRM_ACTION_LABELS.allow,
  deny: CONFIRM_ACTION_LABELS.deny,
});

/** 原因类别：卡片标题与审计 summary 的唯一真源。 */
export const CONFIRM_REASONS = Object.freeze({
  action: REASON_LABELS.action.zh,
  content: REASON_LABELS.content.zh,
});

/** 原因顺序固定：动作确认在前、内容风险在后（P2 接入内容闸时沿用）。 */
const REASON_ORDER = Object.freeze(['action', 'content']);

const OPTION_DESCRIPTIONS = Object.freeze({
  allow: '只放行这一次调用',
  deny: '拒绝本次调用，不执行',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  const requested = new Set();
  for (const item of list) {
    const name = typeof item === 'string' ? item : isPlainObject(item) ? item.reason ?? item.category : undefined;
    if (typeof name === 'string' && Object.hasOwn(CONFIRM_REASONS, name)) requested.add(name);
  }
  const ordered = REASON_ORDER.filter((reason) => requested.has(reason));
  return ordered.length === 0 ? ['action'] : ordered;
}

/**
 * Build the payload for one human confirmation. One question per merged reason, so
 * the client can walk them step by step and submit once.
 *
 * @param {{action: string, target?: string, args?: object, reasons?: readonly string[], origin?: 'root' | 'subagent'}} request
 * @returns {{questions: object[], allowLabel: string, denyLabel: string}}
 */
export function buildConfirmationCard({ action, target, args = {}, reasons, origin = 'root' } = {}) {
  const allowLabel = CONFIRM_LABELS.allow;
  const denyLabel = CONFIRM_LABELS.deny;
  const questions = normalizeReasons(reasons).map((reason) => {
    const copy = confirmationCardCopy({ action, target, args, reason, origin });
    return Object.freeze({
      id: `forge-policy-${reason}`,
      header: CONFIRM_REASONS[reason],
      question: copy.question,
      detail: copy.detail,
      options: Object.freeze([
        Object.freeze({ label: allowLabel, description: OPTION_DESCRIPTIONS.allow }),
        Object.freeze({ label: denyLabel, description: OPTION_DESCRIPTIONS.deny }),
      ]),
    });
  });
  return Object.freeze({ questions: Object.freeze(questions), allowLabel, denyLabel });
}

/**
 * Read a host answer into a verdict. Anything that is not an exact, complete,
 * single-selection of the allow label is a refusal; a refusal label wins over an
 * allow label on another question.
 *
 * @param {unknown} answer host `userQuestions` answer payload
 * @param {{questions?: readonly object[], allowLabel?: string, denyLabel?: string}} context
 * @returns {{decision: 'allow' | 'deny', code?: string}}
 */
export function readConfirmationAnswer(answer, { questions = [], allowLabel = CONFIRM_LABELS.allow, denyLabel = CONFIRM_LABELS.deny } = {}) {
  const invalid = () => ({ decision: 'deny', code: CONFIRM_CODES.INVALID_ANSWER });
  if (!isPlainObject(answer) || !Array.isArray(answer.answers)) return invalid();
  const expected = Array.isArray(questions) ? questions.filter((question) => isPlainObject(question) && typeof question.id === 'string') : [];
  const responses = answer.answers;
  if (expected.length === 0 || responses.length !== expected.length) return invalid();

  const selectedById = new Map();
  for (const response of responses) {
    if (!isPlainObject(response)) return invalid();
    if (typeof response.id !== 'string' || selectedById.has(response.id)) return invalid();
    if (!Array.isArray(response.selected) || response.selected.some((value) => typeof value !== 'string')) return invalid();
    // 单选：一次应答必须恰有一个标签，重复或缺失都不算"允许"。
    if (response.selected.length !== 1) return invalid();
    // 用户输入的自定义文本不是标签，不能当允许。
    if (typeof response.custom === 'string' && response.custom.trim() !== '') return invalid();
    selectedById.set(response.id, response.selected[0]);
  }
  for (const question of expected) {
    if (!selectedById.has(question.id)) return invalid();
  }
  // 拒绝优先：只要有一题选了取消，整次判定就是拒绝。
  for (const question of expected) {
    if (selectedById.get(question.id) === denyLabel) return { decision: 'deny', code: CONFIRM_CODES.DENIED };
  }
  for (const question of expected) {
    if (selectedById.get(question.id) !== allowLabel) return invalid();
  }
  return { decision: 'allow' };
}

const UNAVAILABLE = Object.freeze({ decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE });
const DELEGATED = Object.freeze({ decision: 'deny', code: CONFIRM_CODES.DELEGATED });
const TIMEOUT = Object.freeze({ decision: 'deny', code: CONFIRM_CODES.TIMEOUT });
const CHANNEL_ERROR = Object.freeze({ decision: 'deny', code: CONFIRM_CODES.ERROR });
const CANCELLED = Object.freeze({ decision: 'deny', code: CONFIRM_CODES.CANCELLED });

/** 宿主抛出的错误码 → 本仓库的确认码；未知异常一律"流程异常"，不冒充超时或拒绝。 */
function codeOfHostError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'NO_PROVIDER') return CONFIRM_CODES.UNAVAILABLE;
  if (code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE') return CONFIRM_CODES.DELEGATED;
  // 宿主 abort 只说明这次询问被结束（调用取消、插件卸载或超时收尾），不是"用户没答"。
  if (code === 'ASK_ABORTED') return CONFIRM_CODES.CANCELLED;
  return CONFIRM_CODES.ERROR;
}

/**
 * Host confirmation channel. `ask` always resolves, never rejects: every failure is
 * a refusal with a code, and the timeout is enforced here (not by the host) so a
 * silent client cannot leave the gate waiting forever.
 *
 * @param {{resolveService?: Function, timeoutMs?: number, now?: Function,
 *   setTimer?: Function, clearTimer?: Function}} [options]
 */
export function createConfirmationGateway({
  resolveService = (ctx) => (typeof ctx?.get === 'function' ? ctx.get('userQuestions') : undefined),
  timeoutMs = 120_000,
  now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const inflight = new Set();
  let disposed = false;

  function budgetOf(requested) {
    if (Number.isFinite(requested) && requested > 0) return requested;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
    return 120_000;
  }

  async function ask({ ctx, agent, action, questions, timeoutMs: requested, signal } = {}) {
    if (disposed) return CHANNEL_ERROR;
    let service;
    try {
      service = resolveService(ctx);
    } catch {
      return UNAVAILABLE;
    }
    if (!isPlainObject(service) || typeof service.ask !== 'function') return UNAVAILABLE;
    // 没有会话主体，卡片无处呈现；子代理不会拿到卡片（gate 已挡，这里二次保险）。
    if (agent === null || agent === undefined) return UNAVAILABLE;
    if (personaOf(agent) === PERSONA.CHILD) return DELEGATED;

    // 调用方已取消：不必再弹卡，也不必等超时。
    if (signal?.aborted === true) return CANCELLED;
    const label = { questions, allowLabel: CONFIRM_LABELS.allow, denyLabel: CONFIRM_LABELS.deny };
    const controller = new AbortController();
    const token = { controller };
    inflight.add(token);
    let timer;
    let onAbort;
    try {
      const answered = Promise.resolve()
        .then(() => service.ask({ questions, agent, signal: controller.signal }))
        .then(
          (answer) => readConfirmationAnswer(answer, label),
          (error) => ({ decision: 'deny', code: codeOfHostError(error) }),
        );
      const deadline = new Promise((resolve) => {
        timer = setTimer(() => resolve(TIMEOUT), budgetOf(requested));
        timer?.unref?.();
      });
      // 工具调用被取消时立即结束等待：卡片仍在客户端，但结论已定。
      const cancelled = new Promise((resolve) => {
        if (signal === null || signal === undefined || typeof signal.addEventListener !== 'function') return;
        onAbort = () => resolve(CANCELLED);
        if (signal.aborted === true) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      // 三路都已有 settle 处理；这里只等先到的那一路，其余不会留下未处理拒绝。
      const verdict = await Promise.race([answered, deadline, cancelled]);
      return verdict;
    } catch {
      return CHANNEL_ERROR;
    } finally {
      if (timer !== undefined) clearTimer(timer);
      if (onAbort !== undefined && typeof signal?.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // 移除失败不影响结论。
        }
      }
      inflight.delete(token);
      // 结论已定：释放宿主侧挂起询问（超时路径尤其需要）。
      try {
        controller.abort();
      } catch {
        // abort 失败不影响结论。
      }
    }
  }

  return Object.freeze({
    ask,
    /** 卸载时收尾：挂起的询问按"流程异常"拒绝，不留悬挂 Promise。 */
    dispose() {
      disposed = true;
      for (const token of inflight) {
        try {
          token.controller.abort();
        } catch {
          // 单个 abort 失败不影响其余收尾。
        }
      }
      inflight.clear();
    },
    pending: () => inflight.size,
    now,
  });
}
