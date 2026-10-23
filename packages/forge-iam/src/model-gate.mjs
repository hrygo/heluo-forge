// 模型门禁：未登录/无企业网关凭据时企业模型整片 fail closed；默认模型只在
// "没有显式企业选择"或"当前指向已禁用/不可用模型"时切换，绝不覆盖用户已选企业模型。
//
// 这是纯判定函数：不读配置、不调用宿主、不写设置。宿主侧的 `agentDefaultModel`
// 读写与 IAM 登录态由调用方注入，便于离线用例覆盖正反负分支。

export const MODEL_GATE_REASONS = Object.freeze({
  NOT_SIGNED_IN: 'not-signed-in',
  GATEWAY_CREDENTIAL_MISSING: 'gateway-credential-missing',
  NO_ENTERPRISE_MODEL: 'no-enterprise-model',
  ENTERPRISE_MODEL_UNAVAILABLE: 'enterprise-model-unavailable',
  SELECTION_ABSENT_SWITCHED: 'selection-absent-switched',
  SELECTION_DISABLED_SWITCHED: 'selection-disabled-switched',
  SELECTION_NOT_EXPLICIT_SWITCHED: 'selection-not-explicit-switched',
  KEEP_EXPLICIT_ENTERPRISE: 'keep-explicit-enterprise',
  SELECTION_OUTSIDE_ENTERPRISE: 'selection-outside-enterprise',
});

export class ModelGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelGateError';
    this.code = code;
  }
}

const isSelection = (value) =>
  value === undefined ||
  (value !== null && typeof value === 'object' && typeof value.provider === 'string' && typeof value.model === 'string');

function deny(reason, notes) {
  return Object.freeze({ allow: false, reason, switchTo: undefined, notes: Object.freeze(notes) });
}

function allow(reason, switchTo, notes) {
  return Object.freeze({
    allow: true,
    reason,
    switchTo: switchTo === undefined ? undefined : Object.freeze({ provider: switchTo.provider, model: switchTo.model }),
    notes: Object.freeze(notes),
  });
}

/**
 * @param {{signedIn?: boolean, gatewayCredential?: 'present'|'missing'|'unconfigured',
 *   enterprise?: {provider: string, model: string}, selection?: {provider: string, model: string, explicit?: boolean},
 *   availableProviders?: string[], disabledProviders?: string[], officialApiKeyPresent?: boolean}} input
 */
export function evaluateModelGate(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'model gate input must be an object');
  }
  const {
    signedIn = false,
    gatewayCredential = 'unconfigured',
    enterprise,
    selection,
    availableProviders = [],
    disabledProviders = [],
    officialApiKeyPresent = false,
  } = input;
  if (!Array.isArray(availableProviders) || !Array.isArray(disabledProviders)) {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'availableProviders/disabledProviders must be arrays');
  }
  if (!isSelection(selection) || (enterprise !== undefined && (typeof enterprise?.provider !== 'string' || typeof enterprise?.model !== 'string'))) {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'enterprise and selection need string provider/model');
  }

  // 1. 未登录：企业模型整片关闭，不看官方 Key、不看本地模型，不给 break-glass。
  if (signedIn !== true) {
    return deny(MODEL_GATE_REASONS.NOT_SIGNED_IN, [
      '未登录不允许企业模型调用',
      officialApiKeyPresent ? '环境中存在官方 API Key，按 O3 一律忽略，不构成旁路' : '不因本地模型或静态 Key 放行',
    ]);
  }
  // 2. 登录态有了但网关凭据没就绪：仍然 fail closed，引导录入而不是回落。
  if (gatewayCredential !== 'present') {
    return deny(MODEL_GATE_REASONS.GATEWAY_CREDENTIAL_MISSING, [`网关凭据状态为 ${gatewayCredential}，不自动刷新也不回落`]);
  }
  // 3. 没有企业模型声明：无可选企业模型。
  if (enterprise === undefined) {
    return deny(MODEL_GATE_REASONS.NO_ENTERPRISE_MODEL, ['未声明企业模型，不借用官方或第三方模型']);
  }
  // 4. 声明的企业模型本身不可用（被禁用或没有可用提供方）。
  if (disabledProviders.includes(enterprise.provider) || !availableProviders.includes(enterprise.provider)) {
    return deny(MODEL_GATE_REASONS.ENTERPRISE_MODEL_UNAVAILABLE, [
      `企业模型提供方 ${enterprise.provider} 不可用（disabled=${disabledProviders.includes(enterprise.provider)}, available=${availableProviders.includes(enterprise.provider)}）`,
    ]);
  }
  // 5. 尚未选择：设为企业模型。
  if (selection === undefined) {
    return allow(MODEL_GATE_REASONS.SELECTION_ABSENT_SWITCHED, enterprise, ['没有显式选择，切到企业模型']);
  }
  // 6. 当前选择指向已禁用/不可用的提供方（例如被禁用的官方模型）：切到企业模型。
  if (disabledProviders.includes(selection.provider) || !availableProviders.includes(selection.provider)) {
    return allow(MODEL_GATE_REASONS.SELECTION_DISABLED_SWITCHED, enterprise, [
      `当前选择 ${selection.provider}/${selection.model} 不可用，切到企业模型`,
    ]);
  }
  // 7. 当前就是企业模型：显式选择一律保留。
  if (selection.provider === enterprise.provider && selection.model === enterprise.model) {
    return allow(MODEL_GATE_REASONS.KEEP_EXPLICIT_ENTERPRISE, undefined, ['当前已是企业模型，不重复切换']);
  }
  // 8. 仍是企业提供方的另一模型：显式选择保留，非显式选择收敛到企业默认。
  if (selection.provider === enterprise.provider) {
    return selection.explicit === true
      ? allow(MODEL_GATE_REASONS.KEEP_EXPLICIT_ENTERPRISE, undefined, ['用户显式选择了同提供方的其他模型，不覆盖'])
      : allow(MODEL_GATE_REASONS.SELECTION_NOT_EXPLICIT_SWITCHED, enterprise, ['非显式选择收敛到企业默认模型']);
  }
  // 9. 其他提供方：不静默改用非企业模型，交企业侧裁定。
  return deny(MODEL_GATE_REASONS.SELECTION_OUTSIDE_ENTERPRISE, [
    `当前选择 ${selection.provider}/${selection.model} 不属于企业模型，需企业侧明确开通后才能使用`,
  ]);
}

/** 供组合与探针使用的只读摘要：不包含凭据，只描述判定输入来自哪里。 */
export function describeModelGateInput(input = {}) {
  return Object.freeze({
    signedIn: input.signedIn === true,
    gatewayCredential: input.gatewayCredential ?? 'unconfigured',
    enterpriseDeclared: input.enterprise !== undefined,
    selectionProvider: input.selection?.provider,
    availableProviders: Object.freeze([...(input.availableProviders ?? [])]),
    disabledProviders: Object.freeze([...(input.disabledProviders ?? [])]),
    officialApiKeyPresent: input.officialApiKeyPresent === true,
  });
}
