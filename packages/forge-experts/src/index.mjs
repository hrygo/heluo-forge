/**
 * Pure Cordis assembly point for @heluo/forge-experts (P2 / P3 / P8).
 * Holds zero mutable business state; connects scope, catalog, preferences, mentions, and routes via explicit ports.
 */
import { createScopeManager } from './scope.mjs';
import { createCatalogService } from './catalog.mjs';
import { createPreferencesStore, PreferencePutBodySchema } from './preferences.mjs';
import { createMentionsService } from './mentions.mjs';
import { API_PREFIX, createExpertsRoutes } from './routes.mjs';
import { ExpertsError } from './errors.mjs';

export const name = 'forge-experts';
// Cordis accepts only a service-name array or a name -> config map. An object
// such as { required: [...] } makes Cordis wait for a service literally named
// "required", so the plugin never activates.
export const inject = ['webServer', 'connection', 'storageDomain', 'iam'];

function readService(ctx, serviceName) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(serviceName) : ctx?.[serviceName];
  } catch {
    return undefined;
  }
}

export function createExpertsHost(ports) {
  const managementEnabled = ports?.config?.managementEnabled === true;
  const isolatedMentionsPreviewEnabled = managementEnabled && ports?.config?.isolatedMentionsPreviewEnabled === true;
  const dispatchEnabled = managementEnabled && ports?.config?.dispatchEnabled === true;

  let routesRef = null;
  let catalogRef = null;
  let preferencesRef = null;
  let mentionsRef = null;

  const scope = createScopeManager({
    getIamSession: ports.getIamSession,
    resolveDelegraScope: ports.resolveDelegraScope,
    onScopeChanged({ scopeEpoch }) {
      catalogRef?.invalidate(scopeEpoch);
      preferencesRef?.invalidateScope(scopeEpoch);
      mentionsRef?.invalidate(scopeEpoch, null);
      routesRef?.broadcast({
        type: 'scope-changed',
        scopeEpoch,
        viewVersion: catalogRef?.getViewVersion() ?? 1,
      });
    },
  });

  const preferences = createPreferencesStore({
    openStorageDomain: ports.openStorageDomain,
    getScopeSnapshot: () => scope.getSnapshot(),
    assertScopeCurrent: (epoch, expectedScope) => scope.assertCurrent(epoch, expectedScope),
    verifyOrgCallable: ports.verifyOrgCallable,
    onPreferenceChanged({ scopeEpoch, expertId, viewVersion }) {
      mentionsRef?.invalidate(scopeEpoch, null);
      routesRef?.broadcast({ type: 'preference-updated', scopeEpoch, expertId, viewVersion });
    },
    now: ports.now,
    editTokenTtlMs: ports.editTokenTtlMs,
  });
  preferencesRef = preferences;

  const catalog = createCatalogService({
    resolveScope: () => scope.resolveForRequest(),
    assertScopeCurrent: (epoch, expectedScope) => scope.assertCurrent(epoch, expectedScope),
    fetchDelegraCatalog: ports.fetchDelegraCatalog,
    onCatalogInvalidated({ scopeEpoch, viewVersion }) {
      routesRef?.broadcast({ type: 'catalog-invalidated', scopeEpoch, viewVersion });
    },
    onItemObserved({ scope: itemScope, item }) {
      if (!item.access.callableInOrg) {
        return preferences.reconcileRevocation({
          scope: itemScope,
          scopeEpoch: itemScope.scopeEpoch,
          expertId: item.expertId,
          callableInOrg: false,
          authContinuityDigest: item.access.authContinuityDigest,
        });
      }
      return undefined;
    },
  });
  catalogRef = catalog;

  const mentions = createMentionsService({
    isMentionsEnabled: () => isolatedMentionsPreviewEnabled || dispatchEnabled,
    resolveScope: () => scope.resolveForRequest(),
    assertScopeCurrent: (epoch, expectedScope) => scope.assertCurrent(epoch, expectedScope),
    resolveSessionScope: ports.resolveSessionScope,
    listConfirmedEnabled: (params) => preferences.listConfirmedEnabled(params),
    isPreferencePending: (params) => preferences.isPending(params),
    checkDelegraSessionScope: ports.checkDelegraSessionScope,
    getKnownExpert: (scopeEpoch, expertId) => catalog.getKnownExpert(scopeEpoch, expertId),
    onMentionsInvalidated({ scopeEpoch, sessionId, viewVersion }) {
      routesRef?.broadcast({ type: 'mentions-invalidated', scopeEpoch, sessionId, viewVersion });
    },
    now: ports.now,
  });
  mentionsRef = mentions;

  const routes = createExpertsRoutes({
    isManagementEnabled: () => managementEnabled,
    getConnection: ports.getConnection,
    resolveScope: () => scope.resolveForRequest(),
    listCatalog: (params) => catalog.list(params),
    listMentions: (params) => mentions.list(params),
    getKnownExpert: (scopeEpoch, expertId) => catalog.getKnownExpert(scopeEpoch, expertId),
    getPreference: (params) => preferences.get(params),
    getEditSettlement: (params) => preferences.getEditSettlement(params),
    setPreference: (params) => preferences.setEnabled(params),
    validatePutBody: (body) => PreferencePutBodySchema.safeParse(body),
    getViewVersion: () => Math.max(catalog.getViewVersion(), preferences.getViewVersion(), mentions.getViewVersion()),
  });
  routesRef = routes;

  return Object.freeze({
    managementEnabled,
    isolatedMentionsPreviewEnabled,
    dispatchEnabled,
    open: () => (managementEnabled ? preferences.open() : Promise.resolve()),
    close: async () => {
      routes.closeAllStreams();
      await preferences.close();
    },
    handleRequest: routes.handle,
    scope,
    catalog,
    preferences,
    mentions,
    routes,
  });
}

export async function apply(ctx, config = {}) {
  const managementEnabled = config?.managementEnabled === true;
  const host = createExpertsHost({
    config,
    getIamSession: () => {
      const iam = readService(ctx, 'iam');
      if (!iam || typeof iam.getSession !== 'function') {
        throw new ExpertsError('EXPERT_UNAUTHENTICATED', 'Forge IAM service is unavailable');
      }
      return iam.getSession();
    },
    getConnection: () => readService(ctx, 'connection'),
    openStorageDomain: (spec) => {
      const storage = readService(ctx, 'storageDomain');
      if (!storage || typeof storage.open !== 'function') {
        throw new ExpertsError('EXPERT_STORAGE_UNAVAILABLE', 'DSH storageDomain service is unavailable');
      }
      return storage.open(spec);
    },
    resolveDelegraScope: typeof config?.resolveDelegraScope === 'function'
      ? config.resolveDelegraScope
      : () => {
        throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra scope connector is not configured');
      },
    fetchDelegraCatalog: typeof config?.fetchDelegraCatalog === 'function'
      ? config.fetchDelegraCatalog
      : () => {
        throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra catalog connector is not configured');
      },
    verifyOrgCallable: typeof config?.verifyOrgCallable === 'function'
      ? config.verifyOrgCallable
      : () => {
        throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra authorization verifier is not configured');
      },
    resolveSessionScope: typeof config?.resolveSessionScope === 'function'
      ? config.resolveSessionScope
      : () => null,
    checkDelegraSessionScope: typeof config?.checkDelegraSessionScope === 'function'
      ? config.checkDelegraSessionScope
      : () => {
        throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra session scope checker is not configured');
      },
  });

  if (managementEnabled) {
    // A storage failure must degrade the panel, not abort plugin activation:
    // routes answer EXPERT_STORAGE_UNAVAILABLE instead of disappearing.
    await host.open().catch((error) => {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('[forge-experts] preference storage unavailable', error?.message ?? String(error));
      }
    });
  }

  const webServer = readService(ctx, 'webServer');
  const unregisterRoute = webServer && typeof webServer.register === 'function'
    ? webServer.register({ kind: 'prefix', path: API_PREFIX, handler: host.handleRequest })
    : null;
  if (typeof unregisterRoute !== 'function' && typeof ctx.logger?.warn === 'function') {
    ctx.logger.warn('[forge-experts] webServer route registration unavailable');
  }

  ctx.provide?.('forgeExperts', host);
  // Cordis runs a plain function plugin with `new` and never emits a `dispose`
  // event, so cleanup must be registered as an effect or the route, the SSE
  // streams and the domain handle leak for the life of the Host.
  ctx.effect?.(() => async () => {
    if (typeof unregisterRoute === 'function') unregisterRoute();
    await host.close();
  });
}
