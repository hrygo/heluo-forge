/**
 * Pure Cordis assembly point for @heluo/forge-experts (P2 / P3 / P8).
 * Holds zero mutable business state; connects scope, catalog, preferences,
 * mentions, selection, dispatch, prestep, tool, delegra-client, and routes via explicit ports.
 */
import { createScopeManager } from './scope.mjs';
import { createCatalogService } from './catalog.mjs';
import { createPreferencesStore, PreferencePutBodySchema } from './preferences.mjs';
import { createMentionsService } from './mentions.mjs';
import { createSelectionService } from './selection.mjs';
import { createDispatchService } from './dispatch.mjs';
import { createPreStepGuard } from './prestep.mjs';
import { createExpertToolBridge } from './tool.mjs';
import { API_PREFIX, createExpertsRoutes } from './routes.mjs';
import { createDelegraClient } from './delegra-client.mjs';
import { ExpertsError } from './errors.mjs';

export const name = 'forge-experts';
// Cordis accepts only a service-name array or a name -> config map. An object
// such as { required: [...] } makes Cordis wait for a service literally named
// "required", so the plugin never activates.
export const inject = ['webServer', 'connection', 'storageDomain', 'iam'];

// Contract constants for @heluo/forge-policy `policy.decide()` responses.
const FORGE_POLICY_OUT_OF_SCOPE_RULE = 'out-of-scope';
const ALLOWED_POLICY_DECISIONS = Object.freeze(['allow', 'confirm']);

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
  let prestepRef = null;

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
    onPendingIndexError: ports.onPendingIndexError,
    onTaskReconciled: (event) => {
      // Never broadcast originSessionRef, expertId, or internal scope on shared SSE streams.
      routesRef?.broadcast({
        type: 'task-reconciled',
        requestId: event.requestId,
        taskId: event.taskId,
        status: event.status,
        ...(Number.isInteger(event?.runGeneration) ? { runGeneration: event.runGeneration } : {}),
        ...(event?.notFound === true ? { notFound: true } : {}),
      }, event?.scope ?? null);
    },
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

  const dispatchPorts = Object.freeze({
    dispatchTask: (body) => dispatch.dispatchTask(body),
    reconcileByRequest: (params) => dispatch.reconcileByRequest(params),
    getTask: (params) => dispatch.getTask(params),
    getTaskResult: (params) => dispatch.getTaskResult(params),
    followupTask: (params) => dispatch.followupTask(params),
    cancelTask: (params) => dispatch.cancelTask(params),
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
    ...dispatchPorts,
    reconcileTaskByRequest: dispatchPorts.reconcileByRequest,
    listPendingTasks: () => dispatch.listPendingRequests(),
    reconcilePendingTasks: () => dispatch.reconcilePendingRequests(),
    listRecentFinalizedTurns: (targetScope) => prestepRef?.listRecentFinalized(targetScope) ?? [],
    getViewVersion: () => Math.max(catalog.getViewVersion(), preferences.getViewVersion(), mentions.getViewVersion()),
  });
  routesRef = routes;

  const prestep = createPreStepGuard({
    isDispatchEnabled: () => dispatchEnabled,
    resolveScope: () => scope.resolveForRequest(),
    inspectSelection: (params) => selection.inspect(params),
    discardSelection: (token) => selection.discard(token),
    onTurnFinalized: (event) => {
      const { scope: targetScope, ...wireEvent } = event ?? {};
      routesRef?.broadcast({ type: 'turn-finalized', ...wireEvent }, targetScope ?? null);
    },
    now: ports.now,
    turnTtlMs: ports.turnTtlMs,
    maxActiveTurns: ports.maxActiveTurns,
  });
  prestepRef = prestep;

  const tools = createExpertToolBridge({
    isDispatchEnabled: () => dispatchEnabled,
    ...dispatchPorts,
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
      prestep.clear();
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
    prestep,
    tools,
    routes,
    delegraClient: ports.delegraClient ?? null,
  });
}

export async function apply(ctx, config = {}) {
  const managementEnabled = config?.managementEnabled === true;
  const requestedDispatchEnabled = managementEnabled && config?.dispatchEnabled === true;
  const agentHooks = readService(ctx, 'agentHooks');
  const hasPreStepHook = Boolean(agentHooks && typeof agentHooks.registerPreStep === 'function');
  if (requestedDispatchEnabled && !hasPreStepHook && typeof ctx.logger?.warn === 'function') {
    ctx.logger.warn('[forge-experts] agentHooks.registerPreStep unavailable; pre-step turn guard missing, disabling new dispatch');
  }
  const effectiveConfig = requestedDispatchEnabled && !hasPreStepHook
    ? { ...config, dispatchEnabled: false }
    : config;
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
    : async (params) => {
      const customPolicy = readService(ctx, 'forgePolicy');
      if (customPolicy && typeof customPolicy.decideEgress === 'function') {
        return customPolicy.decideEgress(params);
      }
      const policy = readService(ctx, 'policy');
      if (policy && typeof policy.decide === 'function') {
        let verdict;
        try {
          verdict = await policy.decide({
            action: params.action,
            target: params.expertId ?? params.taskId ?? 'expert',
          });
        } catch (error) {
          if (error instanceof ExpertsError) throw error;
          if (typeof ctx.logger?.warn === 'function') {
            ctx.logger.warn('[forge-experts] policy.decide threw; failing closed', error?.message ?? String(error));
          }
          throw new ExpertsError('EXPERT_POLICY_DENIED', 'Forge Policy egress check failed closed');
        }
        // Never treat generic forge-policy 'out-of-scope' fallback as explicit expert egress authorization.
        if (verdict?.rule === FORGE_POLICY_OUT_OF_SCOPE_RULE) {
          return {
            decision: 'deny',
            reason: 'Action is out-of-scope in Forge Policy catalog; explicit egress policy is required',
          };
        }
        const rawDecision = verdict?.action ?? verdict?.decision;
        // Fail-closed allowlist: only explicit 'allow' or 'confirm' passes through; any other value becomes 'deny'.
        const decision = ALLOWED_POLICY_DECISIONS.includes(rawDecision) ? rawDecision : 'deny';
        return {
          decision,
          reason: verdict?.reason,
          ...(decision === 'confirm' ? { confirmationScope: params.action } : {}),
        };
      }
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('[forge-experts] no egress policy configured; dispatch fail-closed');
      }
      throw new ExpertsError('EXPERT_POLICY_DENIED', 'Forge Policy egress gate is not configured; dispatch is fail-closed');
    };

  const host = createExpertsHost({
    config: effectiveConfig,
    delegraClient,
    evaluatePolicy,
    onCorrelationPersistError: ({ requestId, status, message }) => {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('[forge-experts] request correlation update failed', { requestId, status, message });
      }
    },
    onPendingIndexError: ({ requestId, status, message }) => {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('[forge-experts] pending_index sync failed', { requestId, status, message });
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
  const unregisterTools = [];
  // When dispatch was requested without a pre-step guard, host.dispatchEnabled is false
  // so getToolDefinitions() exposes only readback/reconcile/cancel tools (§9.2).
  if (requestedDispatchEnabled) {
    if (!toolRegistry || typeof toolRegistry.register !== 'function') {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('[forge-experts] tool registry unavailable; restricted expert tools not registered');
      }
    } else {
      try {
        for (const definition of host.tools.getToolDefinitions()) {
          const dispose = toolRegistry.register(definition);
          if (typeof dispose === 'function') unregisterTools.push(dispose);
        }
      } catch (error) {
        for (const dispose of unregisterTools) {
          try { dispose(); } catch { /* best-effort rollback */ }
        }
        if (typeof unregisterRoute === 'function') {
          try { unregisterRoute(); } catch { /* best-effort rollback */ }
        }
        await host.close().catch(() => {});
        throw error;
      }
    }
  }

  let unregisterPreStep = null;
  if (host.dispatchEnabled && hasPreStepHook) {
    try {
      const dispose = agentHooks.registerPreStep(host.prestep);
      if (typeof dispose === 'function') unregisterPreStep = dispose;
    } catch (error) {
      for (const dispose of unregisterTools) {
        try { dispose(); } catch { /* best-effort rollback */ }
      }
      if (typeof unregisterRoute === 'function') {
        try { unregisterRoute(); } catch { /* best-effort rollback */ }
      }
      await host.close().catch(() => {});
      throw error;
    }
  }

  ctx.provide?.('forgeExperts', host);
  // Cordis runs a plain function plugin with `new` and never emits a `dispose`
  // event, so cleanup must be registered as an effect or the route, the SSE
  // streams, tool registrations, pre-step guard and the domain handle leak for the life of the Host.
  ctx.effect?.(() => async () => {
    if (typeof unregisterPreStep === 'function') unregisterPreStep();
    for (const dispose of unregisterTools) dispose();
    if (typeof unregisterRoute === 'function') unregisterRoute();
    await host.close();
  });
}
