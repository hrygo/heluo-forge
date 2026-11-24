/**
 * Pure Cordis assembly point for @heluo/forge-experts (P2 / P3 / P8).
 * Holds zero mutable business state; connects scope, catalog, preferences,
 * mentions, selection, dispatch, tool, delegra-client, and routes via explicit ports.
 */
import { createScopeManager } from './scope.mjs';
import { createCatalogService } from './catalog.mjs';
import { createPreferencesStore, PreferencePutBodySchema } from './preferences.mjs';
import { createMentionsService } from './mentions.mjs';
import { createSelectionService } from './selection.mjs';
import { createDispatchService } from './dispatch.mjs';
import { createExpertToolBridge } from './tool.mjs';
import { API_PREFIX, createExpertsRoutes } from './routes.mjs';
import { createDelegraClient } from './delegra-client.mjs';
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
  let selectionRef = null;

  const scope = createScopeManager({
    getIamSession: ports.getIamSession,
    resolveDelegraScope: ports.resolveDelegraScope,
    onScopeChanged({ scopeEpoch }) {
      catalogRef?.invalidate(scopeEpoch);
      preferencesRef?.invalidateScope(scopeEpoch);
      mentionsRef?.invalidate(scopeEpoch, null);
      selectionRef?.invalidateScope(scopeEpoch);
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
      selectionRef?.invalidateExpert(scopeEpoch, expertId);
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
      selectionRef?.invalidateSession(scopeEpoch, sessionId);
      routesRef?.broadcast({ type: 'mentions-invalidated', scopeEpoch, sessionId, viewVersion });
    },
    now: ports.now,
  });
  mentionsRef = mentions;

  const selection = createSelectionService({
    isDispatchEnabled: () => dispatchEnabled,
    resolveScope: () => scope.resolveForRequest(),
    assertScopeCurrent: (epoch, expectedScope) => scope.assertCurrent(epoch, expectedScope),
    resolveSessionScope: ports.resolveSessionScope,
    getMentionVersion: () => mentions.getViewVersion(),
    now: ports.now,
    selectionTtlMs: ports.selectionTtlMs,
    maxPendingSelections: ports.maxPendingSelections,
    maxPendingPerOwner: ports.maxPendingPerOwner,
  });
  selectionRef = selection;

  const dispatch = createDispatchService({
    isDispatchEnabled: () => dispatchEnabled,
    resolveScope: () => scope.resolveForRequest(),
    assertScopeCurrent: (epoch, expectedScope) => scope.assertCurrent(epoch, expectedScope),
    consumeSelection: (params) => selection.consume(params),
    runInPreferenceBoundary: (fn) => preferences.runSerialized(fn),
    listConfirmedEnabled: (params) => preferences.listConfirmedEnabled(params),
    isPreferencePending: (params) => preferences.isPending(params),
    checkDelegraSessionScope: ports.checkDelegraSessionScope,
    evaluatePolicy: ports.evaluatePolicy,
    openStorageDomain: ports.openStorageDomain,
    onCorrelationPersistError: ports.onCorrelationPersistError,
    createDelegraTask: ports.createDelegraTask ?? (() => {
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra task creation connector is not configured');
    }),
    getDelegraTaskByRequest: ports.getDelegraTaskByRequest ?? (() => {
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra task reconciliation connector is not configured');
    }),
    getDelegraTask: ports.getDelegraTask ?? (() => {
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra task lookup connector is not configured');
    }),
    getDelegraTaskResult: ports.getDelegraTaskResult ?? (() => {
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra task result connector is not configured');
    }),
    createDelegraFollowup: ports.createDelegraFollowup ?? (() => {
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra task followup connector is not configured');
    }),
    cancelDelegraTask: ports.cancelDelegraTask ?? (() => {
      throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra task cancel connector is not configured');
    }),
    now: ports.now,
    generateRequestId: ports.generateRequestId,
  });

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
    prepareSelection: (body) => selection.prepare(body),
    dispatchTask: (body) => dispatch.dispatchTask(body),
    reconcileTaskByRequest: (params) => dispatch.reconcileByRequest(params),
    getTask: (params) => dispatch.getTask(params),
    getTaskResult: (params) => dispatch.getTaskResult(params),
    followupTask: (params) => dispatch.followupTask(params),
    cancelTask: (params) => dispatch.cancelTask(params),
    getViewVersion: () => Math.max(catalog.getViewVersion(), preferences.getViewVersion(), mentions.getViewVersion()),
  });
  routesRef = routes;

  const tools = createExpertToolBridge({
    isDispatchEnabled: () => dispatchEnabled,
    dispatchTask: (body) => dispatch.dispatchTask(body),
    reconcileByRequest: (params) => dispatch.reconcileByRequest(params),
    getTask: (params) => dispatch.getTask(params),
    getTaskResult: (params) => dispatch.getTaskResult(params),
    followupTask: (params) => dispatch.followupTask(params),
    cancelTask: (params) => dispatch.cancelTask(params),
  });

  return Object.freeze({
    managementEnabled,
    isolatedMentionsPreviewEnabled,
    dispatchEnabled,
    open: async () => {
      if (!managementEnabled) return;
      await preferences.open();
      await dispatch.open();
    },
    close: async () => {
      routes.closeAllStreams();
      selection.clear();
      await dispatch.close();
      await preferences.close();
    },
    handleRequest: routes.handle,
    scope,
    catalog,
    preferences,
    mentions,
    selection,
    dispatch,
    tools,
    routes,
    delegraClient: ports.delegraClient ?? null,
  });
}

export async function apply(ctx, config = {}) {
  const managementEnabled = config?.managementEnabled === true;
  const resolveExchangeCredential = () => {
    if (typeof config?.exchangeCredential === 'function') return config.exchangeCredential;
    const iam = readService(ctx, 'iam');
    if (iam && typeof iam.exchangeAudienceCredential === 'function') {
      return (params) => iam.exchangeAudienceCredential(params);
    }
    return null;
  };
  const delegraTarget = typeof config?.delegraTarget === 'string' ? config.delegraTarget.trim() : '';
  const delegraBaseUrl = typeof config?.delegraBaseUrl === 'string' ? config.delegraBaseUrl.trim() : '';
  const delegraOrgId = typeof config?.delegraOrgId === 'string' ? config.delegraOrgId.trim() : '';
  const hasDelegraTarget = Boolean(delegraTarget || delegraBaseUrl || delegraOrgId);
  const delegraClient = hasDelegraTarget
    ? createDelegraClient({
      exchangeCredential: (params) => {
        const exchange = resolveExchangeCredential();
        if (!exchange) {
          throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Forge IAM audience credential exchange is unavailable');
        }
        return exchange(params);
      },
      target: delegraTarget || undefined,
      baseUrl: delegraBaseUrl || undefined,
      orgId: delegraOrgId || undefined,
      timeoutMs: config?.delegraTimeoutMs,
    })
    : null;

  const evaluatePolicy = typeof config?.evaluatePolicy === 'function'
    ? config.evaluatePolicy
    : (() => {
      const policy = readService(ctx, 'forgePolicy');
      if (policy && typeof policy.decideEgress === 'function') {
        return (params) => policy.decideEgress(params);
      }
      return undefined;
    })();

  const host = createExpertsHost({
    config,
    delegraClient,
    evaluatePolicy,
    onCorrelationPersistError: ({ requestId, status, message }) => {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('[forge-experts] request correlation update failed', { requestId, status, message });
      }
    },
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
      : (delegraClient
        ? delegraClient.resolveDelegraScope
        : () => {
          throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra scope connector is not configured');
        }),
    fetchDelegraCatalog: typeof config?.fetchDelegraCatalog === 'function'
      ? config.fetchDelegraCatalog
      : (delegraClient
        ? delegraClient.fetchDelegraCatalog
        : () => {
          throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra catalog connector is not configured');
        }),
    verifyOrgCallable: typeof config?.verifyOrgCallable === 'function'
      ? config.verifyOrgCallable
      : (delegraClient
        ? delegraClient.verifyOrgCallable
        : () => {
          throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra authorization verifier is not configured');
        }),
    resolveSessionScope: typeof config?.resolveSessionScope === 'function'
      ? config.resolveSessionScope
      : () => null,
    checkDelegraSessionScope: typeof config?.checkDelegraSessionScope === 'function'
      ? config.checkDelegraSessionScope
      : (delegraClient
        ? delegraClient.checkDelegraSessionScope
        : () => {
          throw new ExpertsError('EXPERT_DIRECTORY_UNAVAILABLE', 'Delegra session scope checker is not configured');
        }),
    createDelegraTask: typeof config?.createDelegraTask === 'function'
      ? config.createDelegraTask
      : delegraClient?.createTask,
    getDelegraTaskByRequest: typeof config?.getDelegraTaskByRequest === 'function'
      ? config.getDelegraTaskByRequest
      : delegraClient?.getTaskByRequest,
    getDelegraTask: typeof config?.getDelegraTask === 'function'
      ? config.getDelegraTask
      : delegraClient?.getTask,
    getDelegraTaskResult: typeof config?.getDelegraTaskResult === 'function'
      ? config.getDelegraTaskResult
      : delegraClient?.getTaskResult,
    createDelegraFollowup: typeof config?.createDelegraFollowup === 'function'
      ? config.createDelegraFollowup
      : delegraClient?.createFollowup,
    cancelDelegraTask: typeof config?.cancelDelegraTask === 'function'
      ? config.cancelDelegraTask
      : delegraClient?.cancelTask,
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

  const toolRegistry = readService(ctx, 'tools');
  const unregisterTools = host.dispatchEnabled && toolRegistry && typeof toolRegistry.register === 'function'
    ? host.tools.getToolDefinitions()
      .map((definition) => toolRegistry.register(definition))
      .filter((dispose) => typeof dispose === 'function')
    : [];

  ctx.provide?.('forgeExperts', host);
  // Cordis runs a plain function plugin with `new` and never emits a `dispose`
  // event, so cleanup must be registered as an effect or the route, the SSE
  // streams, tool registrations and the domain handle leak for the life of the Host.
  ctx.effect?.(() => async () => {
    for (const dispose of unregisterTools) dispose();
    if (typeof unregisterRoute === 'function') unregisterRoute();
    await host.close();
  });
}
