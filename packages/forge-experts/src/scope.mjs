/**
 * Sole owner of verified employee/org/instance scope and monotonic scopeEpoch (P2).
 * Never trusts client-supplied identity or org headers; re-validates against IAM & Delegra binding.
 */
import { ExpertsError } from './errors.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeScope(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { instanceId, orgId, issuer, subject } = raw;
  if (!isNonEmptyString(instanceId) || !isNonEmptyString(orgId) || !isNonEmptyString(issuer) || !isNonEmptyString(subject)) {
    return null;
  }
  return Object.freeze({
    instanceId: instanceId.trim(),
    orgId: orgId.trim(),
    issuer: issuer.trim(),
    subject: subject.trim(),
    validUntil: isNonEmptyString(raw.validUntil) ? raw.validUntil.trim() : null,
  });
}

function sameScope(a, b) {
  if (!a || !b) return false;
  return a.instanceId === b.instanceId
    && a.orgId === b.orgId
    && a.issuer === b.issuer
    && a.subject === b.subject;
}

/**
 * @param {{
 *   getIamSession: () => Promise<object | null> | object | null,
 *   resolveDelegraScope: (session: object) => Promise<object | null> | object | null,
 *   onScopeChanged?: (event: { scopeEpoch: number, scope: object | null }) => void,
 * }} ports
 */
export function createScopeManager(ports) {
  if (!ports || typeof ports.getIamSession !== 'function' || typeof ports.resolveDelegraScope !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'scope manager requires getIamSession and resolveDelegraScope ports');
  }

  let scopeEpoch = 1;
  let currentScope = null;
  const listeners = new Set();

  function emitChange() {
    const payload = { scopeEpoch, scope: currentScope };
    ports.onScopeChanged?.(payload);
    for (const listener of listeners) {
      try { listener(payload); } catch { /* observer isolation */ }
    }
  }

  function advanceEpoch(nextScope = null) {
    scopeEpoch += 1;
    currentScope = nextScope;
    emitChange();
    return { scopeEpoch, scope: currentScope };
  }

  function getSnapshot() {
    return Object.freeze({ scopeEpoch, scope: currentScope });
  }

  function assertCurrent(expectedEpoch, expectedScope) {
    if (expectedEpoch !== scopeEpoch) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Active scope epoch has changed');
    }
    if (expectedScope && !sameScope(currentScope, expectedScope)) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Active scope identity has changed');
    }
  }

  async function resolveForRequest() {
    let session;
    try {
      session = await ports.getIamSession();
    } catch {
      throw new ExpertsError('EXPERT_UNAUTHENTICATED', 'Unable to read active IAM session', { retryable: true });
    }
    if (!session || session.state !== 'ready' || !isNonEmptyString(session.issuer) || !isNonEmptyString(session.subject)) {
      if (currentScope !== null) advanceEpoch(null);
      throw new ExpertsError('EXPERT_UNAUTHENTICATED', 'Employee sign-in is required');
    }

    let bound;
    try {
      bound = await ports.resolveDelegraScope(session);
    } catch (error) {
      if (error instanceof ExpertsError) throw error;
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Unable to verify Delegra scope binding', { retryable: true });
    }

    const normalized = normalizeScope(bound);
    if (!normalized) {
      throw new ExpertsError('EXPERT_ORG_FORBIDDEN', 'Verified Delegra organization scope is unavailable');
    }
    if (normalized.issuer !== session.issuer.trim() || normalized.subject !== session.subject.trim()) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Delegra scope binding does not match active IAM identity');
    }

    if (!sameScope(currentScope, normalized)) {
      advanceEpoch(normalized);
    } else if (currentScope.validUntil !== normalized.validUntil) {
      currentScope = normalized;
    }

    return Object.freeze({
      scopeEpoch,
      ...currentScope,
    });
  }

  function watch(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return Object.freeze({
    getSnapshot,
    resolveForRequest,
    advanceEpoch,
    assertCurrent,
    watch,
  });
}
