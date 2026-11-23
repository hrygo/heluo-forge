/**
 * Sole owner of session-scoped @-mention candidate projection and invalidation versioning (P2 / §3.6).
 * Intersects three independent facts: callableInScope && acceptingTasks === 'accepting' && confirmedEnabled.
 * Never falls back to org-level directory when session delegation scope is missing or unverified.
 */
import { ExpertsError } from './errors.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {{
 *   isMentionsEnabled: () => boolean,
 *   resolveScope: () => Promise<object>,
 *   assertScopeCurrent: (epoch: number, scope: object) => void,
 *   resolveSessionScope: (sessionId: string, scope: object) => Promise<{ delegationScope: string } | null>,
 *   listConfirmedEnabled: (params: { scope: object }) => Promise<Array<{ expertId: string, revision: number, authContinuityDigest: string }>>,
 *   isPreferencePending: (params: { scope: object, expertId: string }) => boolean,
 *   checkDelegraSessionScope: (params: { scope: object, delegationScope: string, expertIds: string[] }) => Promise<object>,
 *   getKnownExpert: (scopeEpoch: number, expertId: string) => object | null,
 *   onMentionsInvalidated?: (event: { scopeEpoch: number, sessionId: string | null, viewVersion: number }) => void,
 *   now?: () => number,
 * }} ports
 */
export function createMentionsService(ports) {
  if (!ports || typeof ports.resolveScope !== 'function' || typeof ports.assertScopeCurrent !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'mentions service requires scope ports');
  }

  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  let viewVersion = 1;
  let globalVersion = 1;
  const sessionVersions = new Map();
  const sessionLastScope = new Map();

  function invalidate(scopeEpoch, sessionId = null) {
    viewVersion += 1;
    if (sessionId === null) {
      globalVersion += 1;
      sessionLastScope.clear();
    } else {
      sessionVersions.set(sessionId, (sessionVersions.get(sessionId) ?? 0) + 1);
      sessionLastScope.delete(sessionId);
    }
    ports.onMentionsInvalidated?.({ scopeEpoch, sessionId, viewVersion });
    return viewVersion;
  }

  function getViewVersion() {
    return viewVersion;
  }

  async function list({ sessionId, query = '' } = {}) {
    if (!ports.isMentionsEnabled?.()) {
      throw new ExpertsError('EXPERT_MENTIONS_DISABLED', 'Expert @-mention projection is disabled');
    }
    if (!isNonEmptyString(sessionId)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', 'sessionId is required for @-mention lookup');
    }
    const cleanSessionId = sessionId.trim();
    const cleanQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';

    const scope = await ports.resolveScope();
    const startEpoch = scope.scopeEpoch;

    let sessionBinding;
    try {
      sessionBinding = await ports.resolveSessionScope?.(cleanSessionId, scope);
    } catch (error) {
      if (error instanceof ExpertsError) throw error;
      throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Unable to verify session delegation scope');
    }
    if (!sessionBinding || !isNonEmptyString(sessionBinding.delegationScope)) {
      throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Missing verified delegation scope for current session');
    }
    const delegationScope = sessionBinding.delegationScope.trim();

    // Ensure A -> B -> A round-trip on the same session always advances viewVersion (§3.5)
    // while isolating per-session scope transitions from unrelated concurrent sessions.
    const prevScope = sessionLastScope.get(cleanSessionId);
    if (prevScope !== undefined && prevScope !== delegationScope) {
      sessionVersions.set(cleanSessionId, (sessionVersions.get(cleanSessionId) ?? 0) + 1);
      viewVersion += 1;
    }
    sessionLastScope.set(cleanSessionId, delegationScope);
    const startGlobalVersion = globalVersion;
    const startSessionVersion = sessionVersions.get(cleanSessionId) ?? 0;
    const startVersion = viewVersion;

    const enabledRecords = await ports.listConfirmedEnabled({ scope });
    const eligibleIds = enabledRecords
      .filter((entry) => !ports.isPreferencePending?.({ scope, expertId: entry.expertId }))
      .map((entry) => entry.expertId);

    if (eligibleIds.length === 0) {
      return Object.freeze({
        sessionId: cleanSessionId,
        delegationScope,
        scopeEpoch: startEpoch,
        viewVersion: startVersion,
        validUntil: scope.validUntil ?? null,
        candidates: Object.freeze([]),
      });
    }

    let checkResult;
    try {
      checkResult = await ports.checkDelegraSessionScope({
        scope,
        delegationScope,
        expertIds: eligibleIds,
      });
    } catch (error) {
      if (error instanceof ExpertsError) throw error;
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Unable to verify session expert eligibility', { retryable: true });
    }

    // Re-verify scope epoch, global invalidations, and this session's version before publishing.
    ports.assertScopeCurrent(startEpoch, scope);
    if (startGlobalVersion !== globalVersion || startSessionVersion !== (sessionVersions.get(cleanSessionId) ?? 0)) {
      throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Mention projection was invalidated while loading', { retryable: true });
    }
    if (checkResult?.scopeVerified !== true) {
      throw new ExpertsError('EXPERT_SCOPE_UNVERIFIED', 'Delegra did not verify session delegation scope');
    }

    const validUntil = typeof checkResult.validUntil === 'string' ? checkResult.validUntil : (scope.validUntil ?? null);
    if (validUntil && Number.isFinite(Date.parse(validUntil)) && Date.parse(validUntil) <= now()) {
      return Object.freeze({
        sessionId: cleanSessionId,
        delegationScope,
        scopeEpoch: startEpoch,
        viewVersion: startVersion,
        validUntil,
        expired: true,
        candidates: Object.freeze([]),
      });
    }

    const enabledMap = new Map(enabledRecords.map((entry) => [entry.expertId, entry]));
    const rows = Array.isArray(checkResult.results) ? checkResult.results : [];
    const candidates = [];

    for (const row of rows) {
      if (!row || !isNonEmptyString(row.expertId)) continue;
      if (row.callableInScope !== true) continue;
      if (row.acceptingTasks !== 'accepting') continue;
      if (ports.isPreferencePending?.({ scope, expertId: row.expertId })) continue;

      const pref = enabledMap.get(row.expertId);
      if (!pref) continue;
      if (!row.authContinuityDigest || pref.authContinuityDigest !== row.authContinuityDigest) continue;

      const known = ports.getKnownExpert?.(startEpoch, row.expertId);
      const displayName = row.displayName ?? known?.displayName ?? row.expertId;
      const disambiguation = row.disambiguation ?? known?.disambiguation ?? null;
      const responsibility = row.responsibility ?? known?.summary?.responsibility ?? null;

      if (cleanQuery) {
        const haystack = `${displayName} ${disambiguation ?? ''} ${responsibility ?? ''} ${row.expertId}`.toLowerCase();
        if (!haystack.includes(cleanQuery)) continue;
      }

      candidates.push(Object.freeze({
        expertId: row.expertId,
        displayName,
        disambiguation,
        responsibility,
        delegationScope,
        scopeEpoch: startEpoch,
        viewVersion: startVersion,
      }));
    }

    return Object.freeze({
      sessionId: cleanSessionId,
      delegationScope,
      scopeEpoch: startEpoch,
      viewVersion: startVersion,
      validUntil,
      candidates: Object.freeze(candidates),
    });
  }

  return Object.freeze({
    list,
    invalidate,
    getViewVersion,
  });
}
