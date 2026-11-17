/**
 * 范围票据：一次人工确认换取"同一会话内、同一任务范围"的重复写许可。
 *
 * 票据绑定已认证身份、可信会话、变更号、仓库与动作，不设有效期（进程内有效，重启失效），
 * 也不因使用而消费；每次写仍要独立通过能力、路径、内容与流程判定并各记一条审计。
 * 承接时只能保持或收窄，不延长、不换身份，也不跨会话顶替。
 */

export class PolicyScopeError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyScopeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRevisionMap = (value) => isRecord(value) && Object.entries(value).every(([name, revision]) => isText(name) && isText(revision));

function sameRevisions(left, right) {
  const entries = Object.entries(left);
  if (entries.length !== Object.keys(right).length) return false;
  return entries.every(([name, revision]) => Object.hasOwn(right, name) && right[name] === revision);
}

function requireText(value, label) {
  if (!isText(value)) {
    throw new PolicyScopeError(`scope ticket ${label} is required`, 'POLICY_SCOPE_INVALID', { label });
  }
  return value;
}

/**
 * @param {{now?: () => number}} [options]
 */
export function createScopeLedger(options = {}) {
  const clock = options.now ?? (() => Date.now());
  const tickets = new Map();
  let counter = 0;

  function issue(request = {}) {
    const principal = requireText(request.principal, 'principal');
    const changeId = requireText(request.changeId, 'changeId');
    const action = requireText(request.action, 'action');
    const repository = requireText(request.repository, 'repository');
    const session = requireText(request.session, 'session');
    const revisions = request.revisions === undefined ? {} : request.revisions;
    if (!isRevisionMap(revisions)) {
      throw new PolicyScopeError('scope ticket revisions must map a target to a revision', 'POLICY_SCOPE_INVALID');
    }
    for (const ticket of tickets.values()) {
      if (ticket.revokedAt !== undefined) continue;
      if (ticket.principal === principal && ticket.session === session && ticket.changeId === changeId
        && ticket.action === action && ticket.repository === repository) {
        if (sameRevisions(ticket.revisions, revisions)) return ticket;
        // 同一范围换了绑定版本：旧票据立刻失效，否则 verify 会一直拿旧版本比对，
        // 让新版本每次都要重新询问。
        revoke(ticket.id, 'superseded-by-newer-revision');
      }
    }
    counter += 1;
    const ticket = Object.freeze({
      id: `scope-${counter}`,
      principal,
      session,
      changeId,
      action,
      repository,
      revisions: Object.freeze({ ...revisions }),
      issuedAt: clock(),
      revokedAt: undefined,
    });
    tickets.set(ticket.id, ticket);
    return ticket;
  }

  function verify(request = {}) {
    if (!isRecord(request)) return { ok: false, reason: 'the task scope cannot be verified' };
    if (!isText(request.principal)) return { ok: false, reason: 'the task scope needs an authenticated identity' };
    if (!isText(request.session)) return { ok: false, reason: 'the task scope needs a trusted session' };
    const matches = [...tickets.values()].filter((ticket) => ticket.revokedAt === undefined
      && ticket.principal === request.principal
      && ticket.session === request.session
      && ticket.changeId === request.changeId
      && ticket.action === request.action
      && ticket.repository === request.repository);
    if (matches.length === 0) {
      return { ok: false, reason: `no confirmed task scope covers ${request.action} on ${request.repository ?? request.changeId}` };
    }
    const current = isRevisionMap(request.revisions) ? request.revisions : {};
    for (const ticket of matches) {
      const bound = Object.entries(ticket.revisions);
      const complete = bound.every(([name, revision]) => Object.hasOwn(current, name) && current[name] === revision);
      if (complete) return { ok: true, ticketId: ticket.id };
    }
    return { ok: false, reason: `the confirmed task scope for ${request.action} covers a different revision` };
  }

  function revoke(id, reason = 'revoked') {
    const ticket = tickets.get(id);
    if (ticket === undefined) return undefined;
    const revoked = Object.freeze({ ...ticket, revokedAt: clock(), revokedReason: reason });
    tickets.set(id, revoked);
    return revoked;
  }

  return {
    issue,
    verify,
    revoke,
    list: () => [...tickets.values()],
  };
}
