/**
 * 有限任务委托：把一次入口确认绑定到用户、变更、仓库、动作与版本。
 *
 * 委托只由宿主侧事实创建；模型自填的 `approved`、`principal`、`readOnly` 等
 * 参数不能创建委托。任何越界、过期或版本漂移都按拒绝处理。
 */

export class PolicyDelegationError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyDelegationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const TRUSTED_SOURCE = 'host';

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PolicyDelegationError(`delegation ${label} is required`, 'POLICY_DELEGATION_INVALID', { label });
  }
  return value;
}

/**
 * Create a delegation from host-attested facts.
 *
 * @param {{id: string, principal: string, changeId: string, repositories: readonly string[],
 *   actions: readonly string[], revisions: Record<string, string>, ttlMs: number, now?: number,
 *   source?: string}} input host-supplied facts
 */
export function createDelegation(input = {}) {
  const id = requireText(input.id, 'id');
  if (input.source !== TRUSTED_SOURCE) {
    throw new PolicyDelegationError(
      `delegation "${id}" must come from host facts, not from ${input.source ?? 'an unknown source'}`,
      'POLICY_DELEGATION_UNTRUSTED_SOURCE',
      { id, source: input.source },
    );
  }
  const principal = requireText(input.principal, 'principal');
  const changeId = requireText(input.changeId, 'changeId');
  if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
    throw new PolicyDelegationError(`delegation "${id}" needs at least one repository`, 'POLICY_DELEGATION_INVALID', { id });
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    throw new PolicyDelegationError(`delegation "${id}" needs at least one action`, 'POLICY_DELEGATION_INVALID', { id });
  }
  const ttlMs = Number(input.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new PolicyDelegationError(`delegation "${id}" needs a positive ttlMs`, 'POLICY_DELEGATION_INVALID', { id });
  }
  const now = input.now ?? Date.now();
  return Object.freeze({
    id,
    principal,
    changeId,
    repositories: Object.freeze([...input.repositories]),
    actions: Object.freeze([...input.actions]),
    revisions: Object.freeze({ ...(input.revisions ?? {}) }),
    issuedAt: now,
    expiresAt: now + ttlMs,
    revokedAt: undefined,
    source: TRUSTED_SOURCE,
  });
}

/** @param {object} grant @param {{reason?: string, now?: number}} [options] */
export function revokeDelegation(grant, options = {}) {
  if (grant === undefined || grant === null) {
    throw new PolicyDelegationError('no delegation to revoke', 'POLICY_DELEGATION_MISSING');
  }
  return Object.freeze({ ...grant, revokedAt: options.now ?? Date.now(), revokedReason: options.reason ?? 'revoked' });
}

const DENY = (rule, reason) => ({ action: 'deny', rule, reason });

/**
 * @param {{grant?: object, request: {principal: string, changeId: string, repository: string,
 *   action: string, revisions?: Record<string, string>}, catalog?: Map<string, object>, now?: number}} input
 */
export function authorizeDelegation({ grant, request = {}, catalog, now = Date.now() }) {
  if (grant === undefined || grant === null) {
    return DENY('delegation-missing', 'no delegation covers this action');
  }
  if (grant.source !== TRUSTED_SOURCE) {
    return DENY('delegation-untrusted-source', 'the delegation does not come from host facts');
  }
  if (grant.revokedAt !== undefined) {
    return DENY('delegation-revoked', `the delegation was revoked (${grant.revokedReason ?? 'revoked'})`);
  }
  if (grant.expiresAt <= now) {
    return DENY('delegation-expired', 'the delegation expired');
  }
  const catalogEntry = catalog?.get(request.action);
  if (catalog !== undefined && catalogEntry === undefined) {
    return DENY('delegation-action-unregistered', `action "${request.action}" is not registered`);
  }
  if (catalogEntry !== undefined && catalogEntry.enabled !== true) {
    return DENY('delegation-action-disabled', `action "${request.action}" is not enabled`);
  }
  if (!grant.actions.includes(request.action)) {
    return DENY('delegation-action-out-of-scope', `action "${request.action}" is outside the delegated action set`);
  }
  if (request.principal !== grant.principal) {
    return DENY('delegation-principal-mismatch', 'the delegation belongs to a different principal');
  }
  if (request.changeId !== grant.changeId) {
    return DENY('delegation-change-mismatch', 'the delegation covers a different change');
  }
  if (!grant.repositories.includes(request.repository)) {
    return DENY('delegation-repository-out-of-scope', `repository "${request.repository}" is outside the delegation`);
  }
  for (const [name, revision] of Object.entries(request.revisions ?? {})) {
    const expected = grant.revisions[name];
    if (expected !== undefined && expected !== revision) {
      return DENY('delegation-revision-drift', `${name} moved from the delegated revision`);
    }
  }
  return { action: 'allow', rule: 'delegation-in-scope', reason: 'the action is inside the delegated scope' };
}
