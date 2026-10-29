/**
 * `@heluo/forge-devops` 的门禁薄适配（T5，设计 §5.3 / §7.1，AC-16 / AC-19）。
 *
 * 三层职责里这一层只管**能不能做**：`@heluo/forge-policy` 是唯一真源，本模块不代理、
 * 不缓存、不另立第二套规则，只做三件事：
 *
 * 1. **拒绝可读、零下游**：拒绝时一次下游调用都不发生（`calls: 0`），并把门禁给出的
 *    `rule`（`unregistered-action` / `action-disabled` / `egress-confirm` …）原样带出。
 *    "为什么没做"必须可核对，不能只剩一句"失败了"。
 * 2. **放行留痕**：放行时把下游结果放进 `value`，守卫自己的裁决是 `done`——两者分开，
 *    避免"门禁放行"被读成"动作已完成"（动作的 `done` 见 `actions.mjs` 的四状态）。
 * 3. **fail closed**：门禁不可用、`decide` 抛错、`executeAction` 返回无法识别的形状，
 *    一律 `denied` / `failed`，绝不放行。
 *
 * 为什么不直接调 `policy.decide`：`decideAction` 只是规则函数，不处理审批通道、审计回执
 * 与一次性放行（`WeakSet`）。绕过 `executeAction` 就等于开了一条没有审计的旁路。
 * 因此 `admit` 只做**前置可见性**（让报告与工具面提前知道会不会被拒），真正的放行仍由
 * `executeAction` 说了算：`admit` 说 allowed，`executeAction` 仍可 deny（例如没有审批通道）。
 */
import { READ_REASONS } from './read.mjs';

/** 守卫裁决：只回答"门禁怎么判、下游跑没跑"，不是动作的完成状态。 */
export const GUARD_STATUSES = Object.freeze(['done', 'denied', 'failed']);

/** `admit` 的三种前置裁决；`confirm` 表示"放行但需确认"，真正的确认由门禁的审批通道完成。 */
export const GUARD_DECISIONS = Object.freeze(['allowed', 'confirm', 'denied']);

/**
 * 守卫原因码。
 *
 * 前四项与 `read.mjs` 共用同一批字面量（`POLICY_REQUIRED` / `POLICY_ACTION_UNREGISTERED` /
 * `POLICY_DENIED`）——同一个条件只有一份词表，避免读路径与写路径各说一套。
 */
export const GUARD_REASONS = Object.freeze({
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  TARGET_REQUIRED: 'TARGET_REQUIRED',
  POLICY_REQUIRED: READ_REASONS.POLICY_REQUIRED,
  POLICY_ACTION_UNREGISTERED: READ_REASONS.POLICY_ACTION_UNREGISTERED,
  POLICY_DENIED: READ_REASONS.POLICY_DENIED,
  POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
  POLICY_FAILED: 'POLICY_FAILED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  ACTION_FAILED: 'ACTION_FAILED',
  NO_OPERATION: 'NO_OPERATION',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

const describeError = (error) => text(error?.message) || text(error?.code) || '未知错误';

/**
 * 把门禁裁决归一成 `{ status, code, rule, reason }`。
 *
 * `status` 用 `GUARD_DECISIONS` 的词（前置裁决），`code` 是给报告用的原因码。
 */
function admission(status, code, rule, reason) {
  return Object.freeze({ status, code: code ?? null, rule: rule ?? null, reason: reason ?? null });
}

const denied = (code, rule, reason) => admission('denied', code, rule, reason);

const allowed = (rule, reason) => admission('allowed', null, rule, reason);

/** 判定结果 → 原因码。规则名由策略服务给，映射只补语义，不改判定。 */
const DECISION_CODES = Object.freeze({
  'unregistered-action': GUARD_REASONS.POLICY_ACTION_UNREGISTERED,
  'policy-unavailable': GUARD_REASONS.POLICY_UNAVAILABLE,
  'target-required': GUARD_REASONS.TARGET_REQUIRED,
  'confirm-required': GUARD_REASONS.CONFIRMATION_REQUIRED,
  'egress-confirm': GUARD_REASONS.CONFIRMATION_REQUIRED,
});

/**
 * 创建门禁适配器。
 *
 * @param {{ policy?: object }} options 策略服务（`catalog` + `executeAction`，可选 `decide`）
 * @returns {{ admit: Function, execute: Function }}
 */
export function createPolicyGuard({ policy } = {}) {
  const service = asObject(policy);

  const catalogOf = () => {
    const catalog = service.catalog;
    return catalog !== null && typeof catalog === 'object' && typeof catalog.get === 'function' ? catalog : undefined;
  };

  /**
   * 前置裁决：**不产生任何下游调用**，只回答"按现有登记会不会被拒"。
   *
   * 有 `decide` 就交给它（规则只有一份，本模块不复制 `decideAction` 的顺序）；
   * 没有 `decide` 的桩策略（离线测试常见）退化为"登记 + 启用"两项检查，
   * 只收紧不放宽：查不到的 action 一律拒绝。
   */
  function admit(input = {}) {
    const request = asObject(input);
    const action = text(request.action);
    const target = text(request.target);
    const egress = text(request.egress);

    if (action === '') return denied(GUARD_REASONS.ACTION_REQUIRED, 'action-required', '缺少动作名，门禁无法判定');
    if (target === '') return denied(GUARD_REASONS.TARGET_REQUIRED, 'target-required', `动作 ${action} 缺少目标对象，写动作前必须先给出目标`);

    const catalog = catalogOf();
    if (catalog === undefined) {
      return denied(GUARD_REASONS.POLICY_UNAVAILABLE, 'policy-unavailable', '策略服务没有可用的动作目录，按未登记处理');
    }

    if (typeof service.decide === 'function') {
      let decision;
      try {
        decision = service.decide({ action, target, egress: egress === '' ? undefined : egress });
      } catch (error) {
        return denied(GUARD_REASONS.POLICY_FAILED, 'policy-failed', `策略判定抛错，按拒绝处理：${describeError(error)}`);
      }
      const source = asObject(decision);
      const verdict = text(source.action);
      const rule = text(source.rule);
      const reason = text(source.reason);
      if (verdict === 'deny') {
        return denied(DECISION_CODES[rule] ?? GUARD_REASONS.POLICY_DENIED, rule, reason);
      }
      if (verdict === 'confirm') {
        return admission('confirm', DECISION_CODES[rule] ?? GUARD_REASONS.CONFIRMATION_REQUIRED, rule, reason);
      }
      if (verdict === 'allow') return allowed(rule, reason);
      return denied(GUARD_REASONS.POLICY_FAILED, 'policy-failed', '策略判定返回了无法识别的形状，按拒绝处理');
    }

    const entry = catalog.get(action);
    if (entry === undefined) {
      return denied(GUARD_REASONS.POLICY_ACTION_UNREGISTERED, 'unregistered-action', `动作 ${action} 未在策略目录登记`);
    }
    if (asObject(entry).enabled !== true) {
      return denied(GUARD_REASONS.POLICY_DENIED, 'action-disabled', `动作 ${action} 未启用`);
    }
    return allowed('registered-action', `动作 ${action} 已登记且启用`);
  }

  /** 门禁拒绝时 `executeAction` 返回的形状（`{kind:'error', text}`）；据此判"没被允许"。 */
  const isPolicyRejection = (value) => {
    const source = asObject(value);
    return source.kind === 'error' && typeof source.text === 'string';
  };

  const verdict = (status, { action, target, reason, rule, detail, value, mayHaveSideEffect }) => Object.freeze({
    status,
    action,
    target,
    reason: reason ?? null,
    rule: rule ?? null,
    detail: detail ?? null,
    mayHaveSideEffect: mayHaveSideEffect === true,
    value,
  });

  /**
   * 经门禁执行一次动作：**唯一入口**，不允许调用方绕过。
   *
   * - 前置裁决拒绝 → `denied`，`operation` 一次都不调用；
   * - 放行 → 交给 `policy.executeAction`（审计、审批、一次性放行都在里面），
   *   它拒绝时同样是 `denied`（下游零调用），放行时把 `operation` 的返回值放进 `value`；
   * - 下游抛错 → `failed`（`detail` 带原因，`mayHaveSideEffect` 透传适配器的判断）。
   */
  async function execute(input = {}, operation) {
    const request = asObject(input);
    const action = text(request.action);
    const target = text(request.target);
    const egress = text(request.egress);
    const ctx = asObject(request.ctx);
    const extra = asObject(request.arguments);
    const base = { action, target };

    const preliminary = admit(request);
    if (preliminary.status === 'denied') {
      return verdict('denied', { ...base, reason: preliminary.code, rule: preliminary.rule, detail: preliminary.reason });
    }
    if (typeof operation !== 'function') {
      return verdict('failed', { ...base, reason: GUARD_REASONS.NO_OPERATION, detail: '门禁适配器没有拿到要执行的动作' });
    }
    if (typeof service.executeAction !== 'function') {
      return verdict('denied', {
        ...base,
        reason: GUARD_REASONS.POLICY_REQUIRED,
        rule: 'policy-unavailable',
        detail: '策略服务没有 executeAction，不能放行（拒绝绕过门禁）',
      });
    }

    // 门禁只读 `exec.arguments.target` / `.egress`；这两项放在最后，调用方传什么都覆盖不掉。
    const exec = {
      name: action,
      arguments: { ...extra, target, ...(egress === '' ? {} : { egress }) },
      agent: request.agent,
      callId: text(request.callId) || undefined,
      signal: request.signal,
    };

    let value;
    let downstreamRan = false;
    const tracked = () => {
      downstreamRan = true;
      return operation();
    };
    try {
      value = await service.executeAction(ctx, action, exec, tracked);
    } catch (error) {
      // 抛错分两种：**还没轮到下游**说明放行没成立（fail closed，判 denied，适配器零调用）；
      // 下游已经跑起来再抛错才是动作失败（`failed`，副作用标记透传，上层据此降级为 unknown）。
      if (!downstreamRan) {
        return verdict('denied', {
          ...base,
          reason: GUARD_REASONS.POLICY_FAILED,
          rule: 'policy-failed',
          detail: `策略执行通道在放行前抛错，按未放行处理：${describeError(error)}`,
        });
      }
      return verdict('failed', {
        ...base,
        reason: text(error?.code) || GUARD_REASONS.ACTION_FAILED,
        detail: describeError(error),
        mayHaveSideEffect: asObject(error?.detail).mayHaveSideEffect === true,
      });
    }

    if (isPolicyRejection(value)) {
      return verdict('denied', {
        ...base,
        reason: GUARD_REASONS.POLICY_DENIED,
        rule: 'policy-denied',
        detail: text(value.text),
      });
    }
    return verdict('done', { ...base, value });
  }

  return Object.freeze({ admit, execute });
}
