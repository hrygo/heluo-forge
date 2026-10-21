// P4 的纯逻辑部分：更版状态机与恢复计划（DESIGN-007 §7.3–§7.4）。
// 不调用真实 DSH、不执行安装；effect 由调用方注入，便于夹具验证。任何失败都不自动重试或回滚。

export const STATE = Object.freeze({
  REJECTED: 'rejected',
  IN_FLIGHT: 'operation-in-flight',
  REMOVE_FAILED: 'remove-failed',
  RECOVERY_REQUIRED: 'old-removed/recovery-required',
  COMPLETED: 'completed',
  PENDING: 'pending/unknown',
});

const record = (state) => ({ state, steps: [], reasons: [] });

/** 同一 requestId 只允许一次进行中的写；重复到达直接拒绝，不合并、不排队。 */
export class OperationGate {
  #active = new Set();

  acquire(requestId) {
    if (typeof requestId !== 'string' || requestId === '') throw new Error('request-id-invalid');
    if (this.#active.has(requestId)) return false;
    this.#active.add(requestId);
    return true;
  }

  release(requestId) {
    this.#active.delete(requestId);
  }

  get size() {
    return this.#active.size;
  }
}

function note(result, id, ok, detail = '') {
  result.steps.push({ id, ok, ...(detail ? { detail } : {}) });
}

/**
 * 执行一次更版：预检 → 移除 → 移除后再准入 → 精确安装。
 * plan: { requestId, name, targetVersion, oldVersion, enabled, canRemove, canRecoverOld, admitTarget(phase) }
 * effects: { removeBundle(name), installBundle(options), waitForInstall(requestId), listBundles() }
 */
export async function runUpgrade(plan, effects, gate = null) {
  const result = record(STATE.PENDING);
  if (!plan || typeof plan.name !== 'string' || typeof plan.targetVersion !== 'string') {
    result.state = STATE.REJECTED;
    result.reasons.push('plan-invalid');
    return result;
  }

  if (gate && !gate.acquire(plan.requestId)) {
    result.state = STATE.IN_FLIGHT;
    result.reasons.push('duplicate-request');
    return result;
  }

  try {
    if (plan.canRemove === false) {
      result.state = STATE.REJECTED;
      result.reasons.push('not-removable');
      return result;
    }
    if (plan.canRecoverOld === false) {
      result.state = STATE.REJECTED;
      result.reasons.push('no-recovery-eligibility');
      return result;
    }
    note(result, 'precheck');

    const before = await plan.admitTarget('precheck');
    if (!before?.allowed) {
      result.state = STATE.REJECTED;
      result.reasons.push(...(before?.reasons?.length ? before.reasons : ['target-not-admitted']));
      return result;
    }
    note(result, 'admit-before-remove');

    try {
      await effects.removeBundle(plan.name);
      note(result, 'remove');
    } catch (error) {
      result.state = STATE.REMOVE_FAILED;
      result.reasons.push(`remove-failed:${error?.message ?? error}`);
      result.inventory = await safeList(effects);
      return result;
    }

    const after = await plan.admitTarget('after-remove');
    if (!after?.allowed) {
      result.state = STATE.RECOVERY_REQUIRED;
      result.reasons.push(...(after?.reasons?.length ? after.reasons : ['target-revoked-after-remove']));
      return result;
    }
    note(result, 'admit-after-remove');

    let installed;
    try {
      installed = await effects.installBundle({
        spec: `${plan.name}@${plan.targetVersion}`,
        enabled: plan.enabled === true,
        saveExact: true,
        requestId: plan.requestId,
      });
      note(result, 'install', true, installed?.stage ?? '');
    } catch (error) {
      result.state = STATE.RECOVERY_REQUIRED;
      result.reasons.push(`install-failed:${error?.message ?? error}`);
      return result;
    }

    if (installed?.unknown) {
      const reconciliation = await reconcileUpgrade({
        requestId: plan.requestId,
        name: plan.name,
        targetVersion: plan.targetVersion,
        waitForInstall: effects.waitForInstall,
        listBundles: effects.listBundles,
      });
      result.state = reconciliation.state;
      note(result, 'reconcile', reconciliation.state === STATE.COMPLETED, reconciliation.evidence);
      result.evidence = reconciliation.evidence;
      if (reconciliation.state === STATE.RECOVERY_REQUIRED) result.reasons.push('install-not-visible');
      return result;
    }

    result.state = STATE.COMPLETED;
    result.stage = installed?.stage ?? 'installed';
    return result;
  } finally {
    if (gate) gate.release(plan.requestId);
  }
}

async function safeList(effects) {
  try {
    return (await effects.listBundles?.()) ?? [];
  } catch {
    return [];
  }
}

/**
 * 失联对账：waitForInstall 返回 null 不证明成功/失败，只有当 inventory 确证目标版本已装才判完成；
 * 其余一律保留 pending/unknown，不自动重装。
 */
export async function reconcileUpgrade({ requestId, name, targetVersion, waitForInstall, listBundles }) {
  let waitResult;
  try {
    waitResult = await waitForInstall(requestId);
  } catch {
    waitResult = undefined;
  }
  let inventory = [];
  try {
    inventory = (await listBundles()) ?? [];
  } catch {
    inventory = [];
  }
  const found = inventory.find((entry) => entry?.name === name);
  if (found?.version === targetVersion) return { state: STATE.COMPLETED, evidence: 'inventory-confirmed' };
  if (waitResult === null) return { state: STATE.PENDING, evidence: 'wait-null-not-failure' };
  return { state: STATE.PENDING, evidence: 'unknown' };
}

/**
 * 手工恢复计划：只在旧版当前仍获准且 registry 仍保留时给出步骤；不自动执行、不降级安全。
 */
export function planRecovery({ name, oldVersion, enabled, oldVersionAllowed, registryHasOldVersion }) {
  const reasons = [];
  if (!name || !oldVersion) reasons.push('version-missing');
  if (oldVersionAllowed !== true) reasons.push('old-version-not-allowed');
  if (registryHasOldVersion !== true) reasons.push('old-version-not-in-registry');
  if (reasons.length > 0) return { allowed: false, reasons, steps: [] };
  return {
    allowed: true,
    reasons: [],
    steps: [
      `在线复核 current：确认 ${name}@${oldVersion} 仍获准且未过期`,
      `installBundle(${name}@${oldVersion}, { saveExact: true, enabled: ${enabled === true} })`,
      '核对 Host 激活与 Client 可用；重新启用可能改变插件层顺序',
    ],
  };
}