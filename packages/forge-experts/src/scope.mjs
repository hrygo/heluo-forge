/**
 * Sole owner of verified employee/org/instance scope and monotonic scopeEpoch (P2).
 * Never trusts client-supplied identity or org headers; re-validates against IAM & Delegra binding.
 */
import { ExpertsError } from './errors.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pickNonEmptyString(primary, fallback) {
  if (isNonEmptyString(primary)) return primary.trim();
  if (isNonEmptyString(fallback)) return fallback.trim();
  return null;
}

function normalizeIamSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Reject contradictory session states (e.g. state: 'ready' paired with signedIn: false or non-ready status).
  if (raw.signedIn === false) return null;
  if (typeof raw.status === 'string' && raw.status !== 'ready') return null;
  // Support both test/adapter shape (`state: 'ready'`) and real @heluo/forge-iam
  // `sessionView()` shape (`status: 'ready', signedIn: true, principal: { issuer, subject }`).
  const ready = raw.state === 'ready' || (raw.status === 'ready' && raw.signedIn === true);
  const issuer = pickNonEmptyString(raw.issuer, raw.principal?.issuer);
  const subject = pickNonEmptyString(raw.subject, raw.principal?.subject);
  const orgId = pickNonEmptyString(raw.orgId, raw.principal?.orgId);
  if (!ready || !issuer || !subject) return null;
  return Object.freeze({
    state: 'ready',
    issuer,
    subject,
    ...(orgId ? { orgId } : {}),
  });
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

function assertIamIdentity(session, { issuer, subject }, orgId) {
  if (!session || session.issuer !== issuer || session.subject !== subject || (session.orgId ?? null) !== orgId) {
    throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Active IAM identity has changed');
  }
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
  let currentIamOrgId = null;
  const listeners = new Set();

  function emitChange() {
    const payload = { scopeEpoch, scope: currentScope };
    ports.onScopeChanged?.(payload);
    for (const listener of listeners) {
      try { listener(payload); } catch { /* observer isolation */ }
    }
  }

  function advanceEpoch(nextScope = null, iamOrgId = null) {
    scopeEpoch += 1;
    currentScope = nextScope;
    currentIamOrgId = iamOrgId;
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

  async function readIamSession() {
    try {
      return normalizeIamSession(await ports.getIamSession());
    } catch {
      throw new ExpertsError('EXPERT_UNAUTHENTICATED', 'Unable to read active IAM session', { retryable: true });
    }
  }

  async function assertIamIdentityCurrent(expectedEpoch, expectedScope) {
    const session = await readIamSession();
    assertCurrent(expectedEpoch, expectedScope);
    assertIamIdentity(session, expectedScope, currentIamOrgId);
  }

  async function resolveForRequest() {
    const session = await readIamSession();
    if (!session) {
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

    // The IAM input and the verified Delegra organization can differ. Track changes to each independently.
    const iamOrgId = session.orgId ?? null;
    const liveSession = await readIamSession();
    assertIamIdentity(liveSession, session, iamOrgId);
    if (!sameScope(currentScope, normalized) || iamOrgId !== currentIamOrgId) {
      advanceEpoch(normalized, iamOrgId);
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
    assertIamIdentityCurrent,
    watch,
  });
}
