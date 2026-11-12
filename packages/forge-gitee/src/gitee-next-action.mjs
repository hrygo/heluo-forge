/**
 * 拒绝/失败信封里的 `next_action` 词表（唯一映射点）。
 *
 * 失败必须可执行：调用方拿到 `reason` 之后，下一步该改参数、去登记策略、去修凭据，还是
 * 只能转人工核对，是**协议**而不是文案。这里把原因码翻成固定动词，门禁（`gitee-guard.mjs`）
 * 与动作层（`gitee-actions.mjs`）共用同一份映射，避免两处各写一套词。
 *
 * 词汇与 `@heluo/forge-devops` 的失败面保持一致（`report-to-admin`、`fix-arguments`、
 * `complete-arguments`、`confirm-object`、`give-a-target`、`retry` 等）；gitee 侧多出的
 * 动作只在确有独立处置时才新增词，不为同义动作造第二个名字。
 */
/** 动作层原因码里需要单独指向的值（与 `gitee-actions.mjs` / 适配器 / 读层逐字相同）。 */
const ACTION_NEXT = Object.freeze({
  MISSING_ARGUMENT: 'complete-arguments',
  MISSING_TARGET: 'give-a-target',
  INVALID_TARGET: 'fix-arguments',
  INVALID_ARGUMENT: 'fix-arguments',
  HUMAN_CONFIRMATION_FORBIDDEN: 'report-to-admin',
  AUTH_MISSING: 'configure-credentials',
  GITEE_PERSISTENT_TOKEN: 'configure-credentials',
  AUTH_TRANSPORT_UNAVAILABLE: 'use-native-http-credential',
  REPLAY_BLOCKED: 'verify-remote-state',
  READBACK_MISMATCH: 'verify-remote-state',
  READBACK_UNAVAILABLE: 'verify-remote-state',
  COMMAND_TIMEOUT: 'verify-remote-state',
  COMMAND_FAILED: 'retry',
  SPAWN_FAILED: 'configure-runtime',
  ITEM_NOT_FOUND: 'check-target-exists',
  MALFORMED_RESULT: 'retry',
  REVIEW_INVALID: 'fix-content',
  COMMIT_MESSAGE_INVALID: 'fix-content',
  DELIVERY_UNAVAILABLE: 'complete-arguments',
  MODULE_UNAVAILABLE: 'report-to-admin',
  GITEE_STATUS_DISPOSED: 'report-to-admin',
  INTERNAL: 'report-to-admin',
});

// 门禁原因码按字面量写死：`gitee-guard.mjs` 也依赖本模块，import 其常量会形成初始化环。
const GUARD_NEXT = Object.freeze({
  GUARD_ACTION_REQUIRED: 'report-to-admin',
  GUARD_PROVIDER_MISMATCH: 'use-supported-channel',
  GUARD_TARGET_REQUIRED: 'give-a-target',
  GUARD_ACTION_UNREGISTERED: 'register-policy-action',
  GUARD_ACTION_DISABLED: 'enable-policy-action',
  GUARD_CONFIRMATION_REQUIRED: 'confirm-object',
  GUARD_POLICY_DENIED: 'report-to-admin',
  GUARD_POLICY_ERROR: 'retry',
  GUARD_OPERATION_FAILED: 'report-to-admin',
  GITEE_AUDIT_PROVIDER_MISMATCH: 'report-to-admin',
  GUARD_INTERNAL: 'report-to-admin',
});

const FALLBACK = 'report-to-admin';

/**
 * 判定类结果没有失败原因码时由调用方显式给的动词：交付判定未通过表示"还有关闭条件没满足"，
 * 不是参数错、也不是策略拒绝，因此单独给一个可执行动作，不借用 `fix-arguments`。
 */
export const DELIVERY_NOT_READY_ACTION = 'complete-delivery-criteria';

/**
 * 原因码 → 下一步动词。未知原因不猜，落到 `report-to-admin`。
 *
 * @param {unknown} reason 原因码（门禁或动作层）
 * @returns {string}
 */
export function nextActionFor(reason) {
  const key = typeof reason === 'string' ? reason.trim() : '';
  if (key === '') return FALLBACK;
  return GUARD_NEXT[key] ?? ACTION_NEXT[key] ?? FALLBACK;
}

/** 词表全集（文档与测试枚举用；顺序无关，去重后冻结）。 */
export const NEXT_ACTIONS = Object.freeze([...new Set([...Object.values(GUARD_NEXT), ...Object.values(ACTION_NEXT), DELIVERY_NOT_READY_ACTION, FALLBACK])].sort());
