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

const RESUME_KINDS = Object.freeze(['resume', 'fork', 'subagent']);

/**
 * 恢复/分叉/子 Agent 承接时**重新验证身份与范围**（#23 AC3）。
 *
 * 与 `authorizeDelegation` 一样只返回判定对象、从不抛错：任何无法复验的情况都按拒绝处理。
 * 范围只能维持或收窄；快照必须来自宿主事实，聊天记录、临时表或模型参数都不能恢复写授权；
 * 依据不足时返回 `delegation-resume-unverifiable`，调用方必须重新承接（重新委托）。
 *
 * @param {{grant?: object, resume?: {source?: string, kind?: string, principal?: string,
 *   changeId?: string, repository?: string, actions?: readonly string[], agentId?: string,
 *   revisions?: Record<string, string>}, now?: number}} input
 */
export function resumeDelegation({ grant, resume = {}, now = Date.now() } = {}) {
  const deny = (rule, reason, details) => ({ action: 'deny', rule, reason, ...(details === undefined ? {} : { details }) });
  if (grant === undefined || grant === null) return deny('delegation-missing', 'no delegation to resume');
  if (grant.source !== TRUSTED_SOURCE) return deny('delegation-untrusted-source', 'the delegation does not come from host facts');
  if (resume === null || typeof resume !== 'object' || Array.isArray(resume)) {
    return deny('delegation-resume-unverifiable', 'the host must attest the resume facts as an object');
  }
  if (resume.source !== TRUSTED_SOURCE) {
    return deny(
      'delegation-resume-untrusted-source',
      `a "${resume.source ?? 'unknown'}" snapshot cannot restore write authorization`,
      { source: resume.source },
    );
  }
  const kind = resume.kind ?? 'resume';
  if (!RESUME_KINDS.includes(kind)) return deny('delegation-resume-unknown-kind', `unknown resume kind "${kind}"`, { kind });
  if (grant.revokedAt !== undefined) return deny('delegation-revoked', `the delegation was revoked (${grant.revokedReason ?? 'revoked'})`);
  if (grant.expiresAt <= now) return deny('delegation-expired', 'the delegation expired');

  // 身份与绑定复验：必须由宿主给出**当前**事实，不接受"沿用旧快照"式的默认。
  if (typeof resume.principal !== 'string' || resume.principal.trim().length === 0) {
    return deny('delegation-resume-unverifiable', 'the current principal cannot be verified');
  }
  if (resume.principal !== grant.principal) {
    return deny('delegation-resume-principal-changed', 'the delegation belongs to a different principal', { principal: resume.principal });
  }
  if (typeof resume.changeId !== 'string' || resume.changeId.trim().length === 0) {
    return deny('delegation-resume-unverifiable', 'the current change cannot be verified');
  }
  if (resume.changeId !== grant.changeId) {
    return deny('delegation-resume-change-mismatch', 'the delegation covers a different change', { changeId: resume.changeId });
  }
  if (resume.repository !== undefined && !grant.repositories.includes(resume.repository)) {
    return deny('delegation-resume-repository-out-of-scope', `repository "${resume.repository}" is outside the delegation`);
  }
  for (const [name, revision] of Object.entries(resume.revisions ?? {})) {
    const expected = grant.revisions[name];
    if (expected === undefined) return deny('delegation-resume-unverifiable', `revision "${name}" is not part of the delegation`);
    if (expected !== revision) return deny('delegation-resume-revision-drift', `${name} moved from the delegated revision`);
  }
  if (kind === 'subagent' && (typeof resume.agentId !== 'string' || resume.agentId.trim().length === 0)) {
    return deny('delegation-resume-unverifiable', 'a subagent resume needs the host-attested agent identity');
  }

  // 范围：缺省继承（同等），显式给出时必须是子集——只许收窄，不许放宽。
  const requested = resume.actions === undefined ? [...grant.actions] : resume.actions;
  if (!Array.isArray(requested) || requested.some((action) => typeof action !== 'string')) {
    return deny('delegation-resume-unverifiable', 'actions must be an array of action names when present');
  }
  const widened = requested.filter((action) => !grant.actions.includes(action));
  if (widened.length > 0) {
    return deny('delegation-resume-scope-widened', `actions outside the delegated scope: ${widened.join(', ')}`, { widened });
  }

  const resumed = Object.freeze({
    ...grant,
    actions: Object.freeze([...requested]),
    resumedAt: now,
    resumeKind: kind,
    ...(kind === 'fork' ? { forkedFrom: grant.id } : {}),
    ...(kind === 'subagent' ? { delegatedTo: resume.agentId } : {}),
    // 到期时间只继承不延长：承接不得顺带续期。
    expiresAt: grant.expiresAt,
  });
  return {
    action: 'allow',
    rule: 'delegation-resumed',
    reason: 'the delegation was re-verified against host facts',
    grant: resumed,
    scopeReduced: requested.length < grant.actions.length,
  };
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
