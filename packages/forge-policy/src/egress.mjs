/**
 * C3 外发确认：确认绑定动作、目标与内容摘要。
 *
 * 确认只覆盖被展示过的那一次外发；动作、目标或内容变化后旧确认即失效。
 * 取消、过期、超时、通道不可用与策略 `never` 都按拒绝处理，不伪造同意。
 * 白名单主机只说明"可去"，不代表写已获授权。
 */
import { createHash } from 'node:crypto';

export class PolicyEgressError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyEgressError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** @param {unknown} content the payload that would leave the host */
export function digestContent(content) {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * Describe exactly what a confirmation covers. Only field names are carried for
 * display; values never enter the scope or the rendered text.
 *
 * @param {{action: string, target: string, content?: unknown, fields?: readonly string[]}} request
 */
export function confirmationScope({ action, target, content, fields }) {
  if (typeof action !== 'string' || action.length === 0) {
    throw new PolicyEgressError('egress scope needs an action', 'POLICY_EGRESS_SCOPE_INVALID');
  }
  if (typeof target !== 'string' || target.length === 0) {
    throw new PolicyEgressError('egress scope needs a target', 'POLICY_EGRESS_SCOPE_INVALID');
  }
  const contentDigest = digestContent(content ?? null);
  const names = Object.freeze([...(fields ?? (content && typeof content === 'object' ? Object.keys(content) : []))].sort());
  return Object.freeze({ action, target, contentDigest, fields: names, key: `${action}\u0000${target}\u0000${contentDigest}` });
}

/** Human-readable scope: names and a digest prefix, never values. */
export function renderEgressScope(scope) {
  const fields = scope.fields.length > 0 ? scope.fields.join(', ') : '(no fields)';
  return `action=${scope.action} target=${scope.target} fields=[${fields}] content=${scope.contentDigest.slice(0, 12)}`;
}

/**
 * @param {{host: string, scope: object, confirmation?: object, allowlist?: readonly string[], now?: number}} request
 * @returns {{action: 'allow' | 'deny', rule: string, reason: string, scope: object}}
 */
export function decideEgress({ host, scope, confirmation, allowlist, now = Date.now() }) {
  const deny = (rule, reason) => ({ action: 'deny', rule, reason, scope });
  if (typeof host !== 'string' || host.length === 0) return deny('egress-host-required', 'egress needs an explicit host');
  if (allowlist !== undefined && !allowlist.includes(host)) {
    return deny('egress-host-not-allowed', `host "${host}" is not on the egress allowlist`);
  }
  if (confirmation === undefined || confirmation === null) {
    return deny('egress-confirmation-required', `egress to "${host}" requires an explicit confirmation: ${renderEgressScope(scope)}`);
  }
  if (confirmation.outcome !== 'allowed-once') {
    return deny(`egress-confirmation-${confirmation.outcome ?? 'unknown'}`, `egress was not confirmed (${confirmation.outcome ?? 'unknown'})`);
  }
  if (confirmation.key !== scope.key) {
    return deny('egress-confirmation-stale', 'the confirmation covers a different action, target or content');
  }
  if (typeof confirmation.expiresAt === 'number' && confirmation.expiresAt <= now) {
    return deny('egress-confirmation-expired', 'the confirmation expired before the egress ran');
  }
  return { action: 'allow', rule: 'egress-confirmed', reason: `egress to "${host}" was confirmed`, scope };
}

/**
 * Canary guard: a credential or session value must never appear in rendered
 * confirmations or error text.
 *
 * @param {string} text text that is about to be shown or logged
 * @param {readonly string[]} canaries values that must not appear
 */
export function assertNoCanary(text, canaries = []) {
  for (const canary of canaries) {
    if (typeof canary === 'string' && canary.length >= 4 && text.includes(canary)) {
      throw new PolicyEgressError('rendered text contains a protected value', 'POLICY_EGRESS_CANARY_LEAK');
    }
  }
  return text;
}
