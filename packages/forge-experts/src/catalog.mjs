/**
 * Sole owner of employee-authorized expert catalog projection, pagination, and in-flight deduplication (P2).
 * Never fabricates missing summary fields or masks partial/truncated results as complete.
 */
import { ExpertsError } from './errors.mjs';

const VALID_VIEWS = new Set(['directory', 'callable']);
const VALID_COMPLETENESS = new Set(['complete', 'partial', 'truncated', 'unknown']);
const VALID_DISCLOSURE = new Set(['available', 'missing', 'stale', 'restricted']);
const VALID_ACCEPTING = new Set(['accepting', 'paused', 'unavailable', 'unknown']);

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.expertId !== 'string' || !raw.expertId.trim()) {
    return null;
  }
  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
  const access = raw.access && typeof raw.access === 'object' ? raw.access : {};
  const availability = raw.availability && typeof raw.availability === 'object' ? raw.availability : {};
  return Object.freeze({
    expertId: raw.expertId.trim(),
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : raw.expertId.trim(),
    disambiguation: typeof raw.disambiguation === 'string' && raw.disambiguation.trim() ? raw.disambiguation.trim() : null,
    summary: Object.freeze({
      disclosureState: VALID_DISCLOSURE.has(summary.disclosureState) ? summary.disclosureState : 'missing',
      responsibility: typeof summary.responsibility === 'string' ? summary.responsibility : null,
      capabilities: Array.isArray(summary.capabilities) ? Object.freeze(summary.capabilities.filter((v) => typeof v === 'string')) : Object.freeze([]),
      toolScope: Array.isArray(summary.toolScope) ? Object.freeze(summary.toolScope.filter((v) => typeof v === 'string')) : Object.freeze([]),
      updatedAt: typeof summary.updatedAt === 'string' ? summary.updatedAt : null,
    }),
    access: Object.freeze({
      readable: access.readable === true,
      callableInOrg: access.callableInOrg === true,
      callableReason: typeof access.callableReason === 'string' ? access.callableReason : 'unknown',
      authContinuityDigest: typeof access.authContinuityDigest === 'string' && access.authContinuityDigest.trim()
        ? access.authContinuityDigest.trim()
        : null,
    }),
    availability: Object.freeze({
      acceptingTasks: VALID_ACCEPTING.has(availability.acceptingTasks) ? availability.acceptingTasks : 'unknown',
      reason: typeof availability.reason === 'string' ? availability.reason : null,
    }),
  });
}

function sameIdentity(expected, returned) {
  if (!expected || !returned || typeof returned !== 'object') return false;
  return expected.instanceId === returned.instanceId
    && expected.orgId === returned.orgId
    && expected.issuer === returned.issuer
    && expected.subject === returned.subject;
}

/**
 * @param {{
 *   resolveScope: () => Promise<object>,
 *   assertScopeCurrent: (epoch: number, scope: object) => void,
 *   fetchDelegraCatalog: (params: object) => Promise<object>,
 *   onCatalogInvalidated?: (event: { scopeEpoch: number, viewVersion: number }) => void,
 *   onItemObserved?: (payload: { scope: object, item: object }) => Promise<void> | void,
 * }} ports
 */
export function createCatalogService(ports) {
  if (!ports || typeof ports.resolveScope !== 'function' || typeof ports.assertScopeCurrent !== 'function' || typeof ports.fetchDelegraCatalog !== 'function') {
    throw new ExpertsError('EXPERT_INTERNAL_ERROR', 'catalog service requires resolveScope, assertScopeCurrent, and fetchDelegraCatalog ports');
  }

  let viewVersion = 1;
  let lastScopeEpoch = 0;
  const inFlight = new Map();
  const knownByScope = new Map();

  function invalidate(scopeEpoch) {
    viewVersion += 1;
    inFlight.clear();
    knownByScope.clear();
    if (typeof scopeEpoch === 'number') lastScopeEpoch = scopeEpoch;
    ports.onCatalogInvalidated?.({ scopeEpoch: lastScopeEpoch, viewVersion });
    return viewVersion;
  }

  function getViewVersion() {
    return viewVersion;
  }

  function getKnownExpert(scopeEpoch, expertId) {
    if (scopeEpoch !== lastScopeEpoch) return null;
    return knownByScope.get(expertId) ?? null;
  }

  async function list({ view = 'directory', query = '', cursor = null, limit = 50 } = {}) {
    if (!VALID_VIEWS.has(view)) {
      throw new ExpertsError('EXPERT_REQUEST_INVALID', `Unsupported catalog view: ${String(view)}`);
    }
    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    const normalizedCursor = typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null;
    const normalizedLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;

    const scope = await ports.resolveScope();
    if (scope.scopeEpoch !== lastScopeEpoch) {
      lastScopeEpoch = scope.scopeEpoch;
      inFlight.clear();
      knownByScope.clear();
      viewVersion += 1;
    }

    const flightKey = JSON.stringify([scope.scopeEpoch, viewVersion, view, normalizedQuery, normalizedCursor, normalizedLimit]);
    if (inFlight.has(flightKey)) {
      return inFlight.get(flightKey);
    }

    const startEpoch = scope.scopeEpoch;
    const startVersion = viewVersion;
    const run = (async () => {
      let response;
      try {
        response = await ports.fetchDelegraCatalog({
          scope,
          view,
          query: normalizedQuery || undefined,
          cursor: normalizedCursor || undefined,
          limit: normalizedLimit,
        });
      } catch (error) {
        if (error instanceof ExpertsError) throw error;
        throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Expert directory service is unavailable', { retryable: true });
      }

      // Discard late responses after scope change or invalidation (P6 / §3.3).
      ports.assertScopeCurrent(startEpoch, scope);
      if (startVersion !== viewVersion) {
        throw new ExpertsError('EXPERT_CURSOR_STALE', 'Catalog view was invalidated while loading', { retryable: true });
      }
      if (!sameIdentity(scope, response?.scope)) {
        throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Catalog response scope does not match active employee scope');
      }

      const completeness = VALID_COMPLETENESS.has(response?.completeness) ? response.completeness : 'unknown';
      const rawItems = Array.isArray(response?.items) ? response.items : [];
      const items = rawItems.map(normalizeItem).filter(Boolean);
      const filteredItems = view === 'callable'
        ? items.filter((item) => item.access.callableInOrg)
        : items;

      for (const item of items) {
        knownByScope.set(item.expertId, item);
        await ports.onItemObserved?.({ scope, item });
      }

      return Object.freeze({
        scope: Object.freeze({
          instanceId: scope.instanceId,
          orgId: scope.orgId,
          issuer: scope.issuer,
          subject: scope.subject,
          validUntil: response?.scope?.validUntil ?? scope.validUntil ?? null,
        }),
        scopeEpoch: startEpoch,
        viewVersion,
        catalogVersion: typeof response?.catalogVersion === 'string' ? response.catalogVersion : null,
        completeness,
        coveredScopes: Array.isArray(response?.coveredScopes) ? Object.freeze([...response.coveredScopes]) : Object.freeze([]),
        items: Object.freeze(filteredItems),
        page: Object.freeze({
          nextCursor: typeof response?.page?.nextCursor === 'string' ? response.page.nextCursor : null,
          hasMore: response?.page?.hasMore === true,
        }),
      });
    })();

    inFlight.set(flightKey, run);
    try {
      return await run;
    } finally {
      if (inFlight.get(flightKey) === run) inFlight.delete(flightKey);
    }
  }

  return Object.freeze({
    list,
    getKnownExpert,
    invalidate,
    getViewVersion,
  });
}
