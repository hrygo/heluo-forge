// 企业组合的五类开关声明（#37 E01 AC2/AC3）。
//
// 本模块只做**声明与判定**，不承载业务逻辑，也不新增机制：它把"只读 / 普通研发写 /
// AI 发布 / 人工 review / 观察"五类能力各自需要的依赖、默认状态与失败语义写成一个纯函数，
// 由组合层按宿主实测事实调用。写与发布默认关闭；必要审计缺失时**不降级为无审计只读**。
//
// 事实依据：策略动作目录的 kind 只有 read/write/confirm（packages/forge-policy/src/catalog.mjs）；
// 审计落点配置为 `audit.sink ∈ {none, memory}` 且 memory 需显式 allowNonDurable（P03）；
// 业务行（DevOps/Gitee 发布与人工 review）尚未实现，因此这两类只能是 blocked 而不是 on。

export const SWITCH_IDS = Object.freeze(['read', 'research-write', 'ai-publish', 'human-review', 'observe']);

/** 五类开关默认全关；任何"打开"都必须由显式批准 + 能力行 + 依赖三者同时满足。 */
export const SWITCH_DEFAULTS = Object.freeze({
  read: 'off',
  'research-write': 'off',
  'ai-publish': 'off',
  'human-review': 'off',
  observe: 'off',
});

/** 角色 preset 只能**收窄**，不能放大组织已批准的范围。 */
export const ROLE_PRESETS = Object.freeze({
  observer: Object.freeze(['observe']),
  reviewer: Object.freeze(['read', 'observe']),
  developer: Object.freeze(['read', 'research-write']),
  publisher: Object.freeze(['read', 'research-write', 'ai-publish', 'observe']),
  approver: Object.freeze(['read', 'human-review', 'observe']),
});

export const SWITCH_REASONS = Object.freeze({
  ON: 'on',
  NOT_APPROVED: 'not-approved',
  ROLE_NARROWS: 'role-narrows',
  CAPABILITY_NOT_IMPLEMENTED: 'capability-not-implemented',
  POLICY_NOT_READY: 'policy-not-ready',
  IDENTITY_NOT_READY: 'identity-not-ready',
  NECESSARY_AUDIT_NOT_READY: 'necessary-audit-not-ready',
  NO_EXPORT_SINK: 'no-export-sink',
  C3_NOT_APPROVED: 'c3-classification-not-approved',
});

export class EnterpriseSwitchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnterpriseSwitchError';
    this.code = code;
  }
}

const isReady = (value) => value === 'ready';

function capabilityKey(switchId) {
  if (switchId === 'research-write') return 'write';
  if (switchId === 'human-review') return 'review';
  if (switchId === 'ai-publish') return 'publish';
  return switchId;
}

/**
 * @param {{dependencies?: {policy?: string, iam?: string, audit?: string},
 *   capabilities?: Record<string, boolean>, approved?: string[], role?: string,
 *   c3Approved?: boolean}} [input]
 */
export function resolveSwitches(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EnterpriseSwitchError('ENTERPRISE_SWITCH_INPUT_INVALID', 'switch input must be an object');
  }
  const dependencies = input.dependencies ?? {};
  const capabilities = input.capabilities ?? {};
  const approved = input.approved ?? [];
  const { role, c3Approved = false } = input;
  if (typeof dependencies !== 'object' || typeof capabilities !== 'object' || !Array.isArray(approved)) {
    throw new EnterpriseSwitchError('ENTERPRISE_SWITCH_INPUT_INVALID', 'dependencies/capabilities must be objects and approved an array');
  }
  if (role !== undefined && !Object.hasOwn(ROLE_PRESETS, role)) {
    throw new EnterpriseSwitchError('ENTERPRISE_SWITCH_ROLE_UNKNOWN', `unknown role preset ${String(role)}`);
  }
  for (const id of approved) {
    if (!SWITCH_IDS.includes(id)) {
      throw new EnterpriseSwitchError('ENTERPRISE_SWITCH_UNKNOWN_ID', `unknown switch ${String(id)}`);
    }
  }

  const switches = {};
  for (const id of SWITCH_IDS) {
    const decide = () => {
      // 1. 依赖未就绪：硬依赖缺失一律关闭，且不提供"无审计只读"档位。
      if (!isReady(dependencies.policy)) return [SWITCH_REASONS.POLICY_NOT_READY, 'blocked'];
      if (!isReady(dependencies.iam)) return [SWITCH_REASONS.IDENTITY_NOT_READY, 'blocked'];
      if (!isReady(dependencies.audit)) {
        return id === 'observe'
          ? [SWITCH_REASONS.NO_EXPORT_SINK, 'off']
          : [SWITCH_REASONS.NECESSARY_AUDIT_NOT_READY, 'blocked'];
      }
      // 2. C3 分类未批准：review 通道不存在（人工决策项，未批准前不放行）。
      if (id === 'human-review' && c3Approved !== true) return [SWITCH_REASONS.C3_NOT_APPROVED, 'blocked'];
      // 3. 能力行是否存在：业务包未落地时标 blocked，而不是假装可用。
      if (capabilities[capabilityKey(id)] !== true) return [SWITCH_REASONS.CAPABILITY_NOT_IMPLEMENTED, 'blocked'];
      // 4. 组织批准与角色收窄。
      if (!approved.includes(id)) return [SWITCH_REASONS.NOT_APPROVED, 'off'];
      if (role !== undefined && !ROLE_PRESETS[role].includes(id)) return [SWITCH_REASONS.ROLE_NARROWS, 'off'];
      return [SWITCH_REASONS.ON, 'on'];
    };
    const [reason, state] = decide();
    switches[id] = Object.freeze({
      state,
      reason,
      capability: capabilityKey(id),
      /** 可见性只影响入口展示，不等于服务端授权。 */
      serverAuthorization: 'required',
    });
  }

  const blocked = SWITCH_IDS.filter((id) => switches[id].state === 'blocked');
  const on = SWITCH_IDS.filter((id) => switches[id].state === 'on');
  return Object.freeze({
    switches: Object.freeze(switches),
    on: Object.freeze(on),
    blocked: Object.freeze(blocked),
    role: role ?? null,
    notes: Object.freeze([
      '五类开关默认全关，只有依赖就绪 + 能力行存在 + 组织批准三者同时满足才为 on',
      '角色 preset 只能收窄，不能放大组织已批准范围',
      '入口可见性不等于服务端授权，服务端权限仍须独立鉴权',
      c3Approved === true ? 'C3 分类已批准（本仓库当前未批准，测试夹具除外）' : 'C3 分类未批准：人工 review 通道关闭',
    ]),
  });
}

/** 只输出可公开事实的输入摘要，便于探针与日志留证（不含凭据）。 */
export function describeSwitchInput(input = {}) {
  const dependencies = input.dependencies ?? {};
  return Object.freeze({
    policy: dependencies.policy ?? 'unconfigured',
    iam: dependencies.iam ?? 'unconfigured',
    audit: dependencies.audit ?? 'unconfigured',
    capabilities: Object.freeze({ ...(input.capabilities ?? {}) }),
    approved: Object.freeze([...(input.approved ?? [])]),
    role: input.role ?? null,
    c3Approved: input.c3Approved === true,
  });
}
