/**
 * 可信确认账本：确认绑定动作、目标、内容与版本，且一次性消费。
 *
 * 账本是进程内状态：宿主重启或会话分叉后它为空，旧确认自然不可用——这是有意的
 * fail closed 语义，不能靠临时表或聊天记录恢复写授权。
 */
import { confirmationScope } from './egress.mjs';

export class PolicyConfirmationError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyConfirmationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const TRUSTED_KIND = 'human';

/**
 * @param {{now?: () => number}} [options]
 */
export function createConfirmationLedger(options = {}) {
  const clock = options.now ?? (() => Date.now());
  const entries = new Map();

  /**
   * Register a confirmation that the host attested. Model-produced consent is refused.
   *
   * @param {{action: string, target: string, content?: unknown, revision?: string,
   *   kind?: string, ttlMs: number}} input
   */
  function issue(input = {}) {
    if (input.kind !== TRUSTED_KIND) {
      throw new PolicyConfirmationError(
        `confirmation must be attested by a human decision, not by ${input.kind ?? 'an unknown kind'}`,
        'POLICY_CONFIRMATION_UNTRUSTED_KIND',
        { kind: input.kind },
      );
    }
    const ttlMs = Number(input.ttlMs);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new PolicyConfirmationError('confirmation needs a positive ttlMs', 'POLICY_CONFIRMATION_INVALID');
    }
    const scope = confirmationScope({ action: input.action, target: input.target, content: input.content, fields: input.fields });
    const now = clock();
    const record = Object.freeze({
      key: scope.key,
      scope,
      revision: input.revision ?? 'unknown',
      kind: TRUSTED_KIND,
      issuedAt: now,
      expiresAt: now + ttlMs,
      state: 'pending',
    });
    entries.set(scope.key, record);
    return record;
  }

  const deny = (rule, reason) => ({ action: 'deny', rule, reason });

  /**
   * Consume the confirmation for exactly the scope and revision it was issued for.
   */
  function consume({ action, target, content, fields, revision, key }) {
    const scopeKey = key ?? confirmationScope({ action, target, content, fields }).key;
    const record = entries.get(scopeKey);
    if (record === undefined) {
      return deny('confirmation-unknown', 'no confirmation is registered for this scope');
    }
    if (record.state === 'consumed') {
      return deny('confirmation-consumed', 'this confirmation was already used');
    }
    if (record.state === 'revoked') {
      return deny('confirmation-revoked', 'this confirmation was revoked');
    }
    if (record.expiresAt <= clock()) {
      return deny('confirmation-expired', 'this confirmation expired');
    }
    if (revision !== undefined && revision !== record.revision) {
      return deny('confirmation-revision-drift', 'the target revision changed after the confirmation');
    }
    entries.set(scopeKey, Object.freeze({ ...record, state: 'consumed', consumedAt: clock() }));
    return { action: 'allow', rule: 'confirmation-consumed', reason: 'the confirmation covered this exact action', scope: record.scope };
  }

  function revoke({ key, reason = 'revoked' }) {
    const record = entries.get(key);
    if (record === undefined) return false;
    entries.set(key, Object.freeze({ ...record, state: 'revoked', revokedReason: reason }));
    return true;
  }

  return { issue, consume, revoke, pending: () => [...entries.values()] };
}
