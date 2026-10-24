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

export const MODEL_SELECTION_REASONS = Object.freeze({
  WRITTEN: 'selection-written',
  NO_WRITE_GATE_DENIED: 'no-write-gate-denied',
  NO_WRITE_NO_TARGET: 'no-write-no-target',
  NO_WRITE_KEEP_EXPLICIT: 'no-write-keep-explicit-enterprise',
  NO_WRITE_ALREADY_ENTERPRISE: 'no-write-already-enterprise',
  NO_WRITE_UNPROVABLE_SELECTION: 'no-write-selection-unprovable',
  WRITE_FAILED: 'selection-write-failed',
  WRITE_UNVERIFIED: 'selection-write-unverified',
});

const isSelectionLike = (value) =>
  value !== null && typeof value === 'object' && typeof value.provider === 'string' && typeof value.model === 'string';

/**
 * 默认模型的**写入接线**（#13 AC6 / ADR-14 决策 b）。
 *
 * 只做一件事：把已经判定好的切换落到设置里，并在写入前**独立复查**"绝不覆盖用户显式企业选择"。
 * 判定与写入分离，写入因此可以在没有企业环境的机器上做正反负测；受控写默认禁用，
 * 任何无法证明当前选择的情况一律不写。
 *
 * @param {{decision: {allow: boolean, switchTo?: {provider: string, model: string}},
 *   currentSelection?: {provider: string, model: string, explicit?: boolean},
 *   readSelection?: () => unknown, saveSelection: (target: {provider: string, model: string}) => unknown,
 *   enterprise?: {provider: string, model: string}, availableProviders?: string[],
 *   disabledProviders?: string[]}} input
 */
export async function applyModelSelection(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'model selection input must be an object');
  }
  const { decision, saveSelection, readSelection, enterprise } = input;
  if (decision === null || typeof decision !== 'object' || typeof decision.allow !== 'boolean') {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'decision must be an object with a boolean allow');
  }
  if (typeof saveSelection !== 'function') {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'saveSelection must be a function');
  }
  if (readSelection !== undefined && typeof readSelection !== 'function') {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'readSelection must be a function when present');
  }
  if (enterprise !== undefined && !isSelectionLike(enterprise)) {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'enterprise needs string provider/model');
  }
  const availableProviders = input.availableProviders ?? [];
  const disabledProviders = input.disabledProviders ?? [];
  if (!Array.isArray(availableProviders) || !Array.isArray(disabledProviders)) {
    throw new ModelGateError('MODEL_GATE_INPUT_INVALID', 'availableProviders/disabledProviders must be arrays');
  }

  const skip = (reason, notes, current) =>
    Object.freeze({ written: false, verified: false, reason, attempted: undefined, current: current ?? null, notes: Object.freeze(notes) });

  // 当前选择：优先用宿主读取器，读不出来就不写（无法证明将覆盖什么）。
  let current = input.currentSelection;
  if (readSelection !== undefined) {
    try {
      current = await readSelection();
    } catch (error) {
      return skip(MODEL_SELECTION_REASONS.NO_WRITE_UNPROVABLE_SELECTION, [`读取当前选择失败：${String(error?.message ?? error)}`]);
    }
  }
  if (current !== undefined && current !== null && !isSelectionLike(current)) {
    return skip(MODEL_SELECTION_REASONS.NO_WRITE_UNPROVABLE_SELECTION, ['当前选择无法解析，按无法证明处理']);
  }

  // 独立复查：显式选择且仍然可用（含企业模型本身）一律不覆盖 —— 即使判定说要切。
  if (isSelectionLike(current) && current.explicit === true) {
    const isEnterprise = isSelectionLike(enterprise) && current.provider === enterprise.provider && current.model === enterprise.model;
    const stillUsable = availableProviders.includes(current.provider) && !disabledProviders.includes(current.provider);
    if (isEnterprise || stillUsable) {
      return skip(MODEL_SELECTION_REASONS.NO_WRITE_KEEP_EXPLICIT, ['用户显式选择仍然可用，写入接线拒绝覆盖'], current);
    }
  }

  if (decision.allow !== true) {
    return skip(MODEL_SELECTION_REASONS.NO_WRITE_GATE_DENIED, [`判定未放行：${decision.reason ?? 'unknown'}`], current);
  }
  const target = decision.switchTo;
  if (!isSelectionLike(target)) {
    return skip(MODEL_SELECTION_REASONS.NO_WRITE_NO_TARGET, ['判定放行但没有给出切换目标'], current);
  }
  if (isSelectionLike(current) && current.provider === target.provider && current.model === target.model) {
    return skip(MODEL_SELECTION_REASONS.NO_WRITE_ALREADY_ENTERPRISE, ['当前已经是目标模型，不重复写入'], current);
  }

  try {
    await saveSelection({ provider: target.provider, model: target.model });
  } catch (error) {
    return skip(MODEL_SELECTION_REASONS.WRITE_FAILED, [`写入失败：${String(error?.message ?? error)}`], current);
  }

  if (readSelection === undefined) {
    return Object.freeze({
      written: true,
      verified: false,
      reason: MODEL_SELECTION_REASONS.WRITTEN,
      attempted: Object.freeze({ provider: target.provider, model: target.model }),
      current: current ?? null,
      notes: Object.freeze(['已写入但未回读验证（调用方未提供读取器）']),
    });
  }
  let after;
  try {
    after = await readSelection();
  } catch (error) {
    return Object.freeze({
      written: true,
      verified: false,
      reason: MODEL_SELECTION_REASONS.WRITE_UNVERIFIED,
      attempted: Object.freeze({ provider: target.provider, model: target.model }),
      current: current ?? null,
      notes: Object.freeze([`写入后回读失败：${String(error?.message ?? error)}`]),
    });
  }
  const verified = isSelectionLike(after) && after.provider === target.provider && after.model === target.model;
  return Object.freeze({
    written: true,
    verified,
    reason: verified ? MODEL_SELECTION_REASONS.WRITTEN : MODEL_SELECTION_REASONS.WRITE_UNVERIFIED,
    attempted: Object.freeze({ provider: target.provider, model: target.model }),
    current: current ?? null,
    notes: Object.freeze(
      verified ? ['已写入并回读一致'] : [`写入后回读不一致：${isSelectionLike(after) ? `${after.provider}/${after.model}` : '无法解析'}，按未验证报告缺口`],
    ),
  });
}
