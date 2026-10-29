/**
 * 写路径的**唯一准入点**（AC-11 / AC-16 / AC-17）。
 *
 * 契约：`createGiteeGuard({ policy, provider }).execute({ action, target, tool, confirm, payload })`
 * 返回一个四状态裁决，`payload = { arguments, run }`——`run()` 才是真正发子进程的那一段，
 * 它**只在** `policy.executeAction` 的 operation 回调里被调用。于是"被拒 = 零子进程"不是靠
 * 调用方自觉，而是结构上不存在第二条路：本模块是 `packages/forge-gitee/src/` 里唯一调用
 * `policy.executeAction` 的文件（`test/actions.test.mjs` 静态扫描守这条唯一性）。
 *
 * 四道前置门，顺序即优先级——先拒的规则是更强的拒绝理由：
 *   1. **`gitee.*` 前缀**：动作名不在本包的命名空间里就地拒绝，连策略都不问（AC-11）。
 *      这一道是 provider 分流的实体：`gh.issue.write` 之类的动作在 gitee 这边永远走不进来。
 *   2. **target 必填**：没有目标就没有"这次写到哪"的证据，拒绝。
 *   3. **目录（catalog）**：`policy.decide` 说 `deny` 就拒绝，`rule` 原样透出
 *      （`unregistered-action` / `action-disabled`）——**默认禁用是目录事实，不是代码里的开关**。
 *   4. **确认**：远程写动作必须带 `confirm = { repo, object }`，且两者都要与目标逐字相符
 *      （AC-16「写动作前必须先给出目标」）。确认只在这一处校验，工具面不重复。
 *
 * 放行后：
 *   - operation 抛错 → `failed`，能确认有副作用痕迹（`detail.mayHaveSideEffect`）时由动作层
 *     升格成 `unknown`（不重放）；
 *   - operation 返回 → `done` + `value`（动作层再按 `value.status` 定最终状态）；
 *   - **审计 provider 槽校验**：策略包的 `ALLOWED_FIELDS` 里没有 `provider` 字段（不改策略包），
 *     gitee 侧靠"`action` 必须是 `gitee.*` + `subject` 固定 `gitee`"自证。gate 之后回看审计
 *     记录，前缀或 subject 不符即 `GITEE_AUDIT_PROVIDER_MISMATCH`（且标记"可能已落地"）。
 *     审计记录不可观察（持久 sink 或桩策略没有内存缓冲）时**不伪造结论**：裁决里标
 *     `audit.observable: false`，不据此升降状态。
 */
import { GITEE_PROVIDER } from './gitee-adapter.mjs';

/** 门禁裁决状态：`done` = 已放行并执行完；`denied` = 未执行；`failed` = 执行中出错。 */
export const GUARD_STATUSES = Object.freeze(['done', 'denied', 'failed']);

/** 门禁原因码（固定枚举；自由文本只进 `detail`）。 */
export const GUARD_REASONS = Object.freeze({
  ACTION_REQUIRED: 'GUARD_ACTION_REQUIRED',
  PROVIDER_MISMATCH: 'GUARD_PROVIDER_MISMATCH',
  TARGET_REQUIRED: 'GUARD_TARGET_REQUIRED',
  ACTION_UNREGISTERED: 'GUARD_ACTION_UNREGISTERED',
  ACTION_DISABLED: 'GUARD_ACTION_DISABLED',
  CONFIRMATION_REQUIRED: 'GUARD_CONFIRMATION_REQUIRED',
  POLICY_DENIED: 'GUARD_POLICY_DENIED',
  POLICY_ERROR: 'GUARD_POLICY_ERROR',
  OPERATION_FAILED: 'GUARD_OPERATION_FAILED',
  AUDIT_PROVIDER_MISMATCH: 'GITEE_AUDIT_PROVIDER_MISMATCH',
  INTERNAL: 'GUARD_INTERNAL',
});

/** 本包的动作命名空间。 */
export const GITEE_ACTION_PREFIX = 'gitee.';

/** 审计记录里 gitee 侧的自证值（策略包没有 provider 槽，用固定 subject 顶替）。 */
export const GITEE_AUDIT_SUBJECT = 'gitee';

/**
 * 必须带确认的远程写动作。
 *
 * 只包含**会产生远端副作用**的三个：Issue/PR 的创建与评论、审查发布。`gitee.review.record`
 * （本地 `review.md`）与 `gitee.delivery.judge`（纯判定）不在此列——给本地写也套一层"确认
 * 目标"，只会让"确认"这个动作失去意义（什么都确认等于什么都没确认）。
 */
export const CONFIRM_REQUIRED_ACTIONS = Object.freeze([
  'gitee.issue.write',
  'gitee.pr.write',
  'gitee.review.publish',
]);

/** 写动作声明的出网范围：策略目录据此走确认/出网分支（与 r1 同字面量）。 */
export const EGRESS_PLATFORM_WRITE = 'platform-write';

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const describeError = (error) => text(error?.message) || text(error?.code) || '未知错误';

/** `owner/name` 或 `owner/name#12` / `owner/name!12` → `owner/name`。 */
function repoOf(target) {
  const raw = text(target);
  const cut = raw.search(/[#!]/u);
  return cut === -1 ? raw : raw.slice(0, cut);
}

function denial({ status = 'denied', action, target, tool, rule, reason, detail = null, mayHaveSideEffect = false, calls = 0 }) {
  return Object.freeze({
    status,
    action,
    target,
    tool,
    rule,
    reason,
    detail,
    mayHaveSideEffect,
    calls,
  });
}

/**
 * @param {{ policy: object, provider?: string, now?: () => number }} options
 * @returns {{ execute: (request: object) => Promise<object>, provider: string, describe: () => object }}
 */
export function createGiteeGuard({ policy = null, provider = GITEE_PROVIDER, now = Date.now } = {}) {
  if (policy === null || typeof policy !== 'object') {
    throw new TypeError('gitee 门禁需要策略服务（policy）：缺门禁即拒绝装配，不降级成无策略执行');
  }
  if (typeof policy.decide !== 'function') {
    throw new TypeError('策略服务缺少 decide()：无法判断目录里有没有这个动作');
  }
  if (typeof policy.executeAction !== 'function') {
    throw new TypeError('策略服务缺少 executeAction()：写动作必须经策略门禁执行（拒绝绕过门禁）');
  }
  if (typeof now !== 'function') throw new TypeError('门禁的 now 必须是返回毫秒数的函数');

  const namespace = text(provider) || GITEE_PROVIDER;
  let sequence = 0;
  const nextCallId = (kind) => {
    sequence += 1;
    return `${namespace}-guard-${kind}-${sequence}`;
  };

  /**
   * 审计记录的 provider 自证。
   *
   * 只看**这一次动作**的记录：`action` 必须落在 `gitee.*` 里，`subject` 若存在必须是 `gitee`。
   * 记录不可观察时返回 `{ observable: false }`，由调用方决定措辞——不假装核过。
   */
  function inspectAudit(action) {
    if (typeof policy.auditRecords !== 'function') return { observable: false, records: 0, mismatch: false };
    let records;
    try {
      records = policy.auditRecords();
    } catch (error) {
      return { observable: false, records: 0, mismatch: false, detail: describeError(error) };
    }
    if (!Array.isArray(records) || records.length === 0) return { observable: false, records: 0, mismatch: false };
    const mine = records.filter((record) => isPlainObject(record) && text(record.action) === action);
    if (mine.length === 0) return { observable: false, records: 0, mismatch: false };
    for (const record of mine) {
      const subject = text(record.subject);
      if (subject !== '' && subject !== GITEE_AUDIT_SUBJECT) {
        return {
          observable: true,
          records: mine.length,
          mismatch: true,
          detail: `审计记录的 subject 是 "${subject}"，不是 "${GITEE_AUDIT_SUBJECT}"`,
        };
      }
      if (!text(record.action).startsWith(GITEE_ACTION_PREFIX)) {
        return {
          observable: true,
          records: mine.length,
          mismatch: true,
          detail: `审计记录的 action "${text(record.action)}" 不在 ${GITEE_ACTION_PREFIX} 命名空间里`,
        };
      }
    }
    return { observable: true, records: mine.length, mismatch: false };
  }

  /**
   * 受控动作的唯一入口。
   *
   * @param {{ action?: string, target?: string, tool?: string, confirm?: object,
   *   payload?: { arguments?: object, run?: Function }, ctx?: object }} request
   */
  async function execute(request = {}) {
    const source = isPlainObject(request) ? request : {};
    const action = text(source.action);
    const target = text(source.target);
    const tool = text(source.tool) || `${namespace}_${action.split('.').pop() || 'action'}`;

    if (action === '') {
      return denial({ action, target, tool, rule: 'action-required', reason: GUARD_REASONS.ACTION_REQUIRED, detail: '缺少动作名（action）' });
    }
    // 门 1：命名空间。非 gitee.* 动作就地拒绝，零策略调用、零子进程（AC-11）。
    if (!action.startsWith(GITEE_ACTION_PREFIX)) {
      return denial({
        action,
        target,
        tool,
        rule: 'provider-mismatch',
        reason: GUARD_REASONS.PROVIDER_MISMATCH,
        detail: `动作 "${action}" 不在 ${GITEE_ACTION_PREFIX}* 命名空间里：gitee 侧不执行其他 provider 的动作`,
      });
    }
    // 门 2：目标。没有目标就没有"这次写到哪"的证据。
    if (target === '') {
      return denial({ action, target, tool, rule: 'target-required', reason: GUARD_REASONS.TARGET_REQUIRED, detail: '缺少目标（target）' });
    }

    const payload = isPlainObject(source.payload) ? source.payload : null;
    const run = typeof payload?.run === 'function' ? payload.run : null;
    if (run === null) {
      throw new TypeError(`门禁请求缺少执行体（payload.run）：${action} 不能绕过 operation 直接写`);
    }
    const args = isPlainObject(payload.arguments) ? { ...payload.arguments, target } : { target };

    // 门 3：目录。默认禁用是"没登记"这件事实，`rule` 原样透出（AC-17）。
    let decision;
    try {
      decision = policy.decide({ action, target, egress: EGRESS_PLATFORM_WRITE });
    } catch (error) {
      return denial({
        action,
        target,
        tool,
        rule: 'policy-unavailable',
        reason: GUARD_REASONS.POLICY_ERROR,
        detail: `策略服务无法裁决：${describeError(error)}`,
      });
    }
    const verdictAction = text(decision?.action);
    if (verdictAction === 'deny') {
      const rule = text(decision?.rule) || 'policy-denied';
      const unregistered = rule === 'unregistered-action';
      const disabled = rule === 'action-disabled';
      return denial({
        status: 'denied',
        action,
        target,
        tool,
        rule,
        reason: unregistered
          ? GUARD_REASONS.ACTION_UNREGISTERED
          : disabled
            ? GUARD_REASONS.ACTION_DISABLED
            : GUARD_REASONS.POLICY_DENIED,
        detail: text(decision?.reason) || `策略拒绝了 ${action}`,
      });
    }

    // 门 4：确认（只对远程写动作）。repo 与 object 都要与目标逐字相符。
    if (CONFIRM_REQUIRED_ACTIONS.includes(action)) {
      const confirm = isPlainObject(source.confirm) ? source.confirm : null;
      const repo = text(confirm?.repo);
      const object = text(confirm?.object);
      if (repo === '' || object === '') {
        return denial({
          action,
          target,
          tool,
          rule: 'confirm-required',
          reason: GUARD_REASONS.CONFIRMATION_REQUIRED,
          detail: `${action} 是远程写动作：必须给出 confirm.repo 与 confirm.object`,
        });
      }
      if (repo !== repoOf(target) || object !== target) {
        return denial({
          action,
          target,
          tool,
          rule: 'confirm-required',
          reason: GUARD_REASONS.CONFIRMATION_REQUIRED,
          detail: `确认的目标与本次写入不一致（confirmation: ${repo} / ${object}）`,
        });
      }
    }

    // 放行：operation 只在策略的 operation 回调里执行。
    const exec = {
      name: tool,
      arguments: args,
      callId: nextCallId(action.split('.')[1] || 'action'),
    };
    // 宿主 approval 通道：`index.mjs` 的 execute 直通，不额外注入 ctx；调用方要确认通道时
    // 必须显式传 `request.ctx`，否则策略侧的 `kind: 'confirm'` 条目会因"没有审批通道"被拒
    // （拒绝，而不是悄悄放行）。
    const ctx = isPlainObject(source.ctx) ? source.ctx : { get: () => undefined };

    let outcome;
    try {
      outcome = await policy.executeAction(ctx, action, exec, () => run({ action, target, arguments: args }));
    } catch (error) {
      const detail = isPlainObject(error?.detail) ? error.detail : {};
      return denial({
        status: 'failed',
        action,
        target,
        tool,
        rule: 'operation-failed',
        reason: text(error?.code) || GUARD_REASONS.OPERATION_FAILED,
        detail: describeError(error),
        mayHaveSideEffect: detail.mayHaveSideEffect === true,
        calls: null,
      });
    }

    if (isPlainObject(outcome) && outcome.kind === 'error') {
      return denial({
        action,
        target,
        tool,
        rule: 'policy-denied',
        reason: GUARD_REASONS.POLICY_DENIED,
        detail: text(outcome.text) || `策略拒绝了 ${action}`,
      });
    }

    const audit = inspectAudit(action);
    if (audit.mismatch) {
      // 审计记录与本次动作对不上：写可能已经发生，但证据链不可信。不重放，交人工核对。
      return denial({
        status: 'failed',
        action,
        target,
        tool,
        rule: 'audit-provider-mismatch',
        reason: GUARD_REASONS.AUDIT_PROVIDER_MISMATCH,
        detail: audit.detail,
        mayHaveSideEffect: true,
        calls: null,
      });
    }

    return Object.freeze({
      status: 'done',
      action,
      target,
      tool,
      rule: text(decision?.rule) || 'registered-action',
      reason: null,
      detail: null,
      mayHaveSideEffect: false,
      calls: null,
      value: outcome,
      audit: Object.freeze({
        observable: audit.observable === true,
        records: audit.records ?? 0,
        subject: GITEE_AUDIT_SUBJECT,
      }),
    });
  }

  return Object.freeze({
    provider: namespace,
    execute,
    /** 脱敏描述：只有命名空间与确认范围，不含任何配置值。 */
    describe: () =>
      Object.freeze({
        provider: namespace,
        prefix: GITEE_ACTION_PREFIX,
        auditSubject: GITEE_AUDIT_SUBJECT,
        confirmRequired: Object.freeze([...CONFIRM_REQUIRED_ACTIONS]),
      }),
  });
}
