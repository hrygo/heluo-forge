import { createManagedModelRuntime } from './managed-models.mjs';
import { createCallbackManager } from './callback-listener.mjs';
import { Config, validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';
import { checkExclusive } from './exclusive.mjs';
import { createIamRoutes } from './routes.mjs';
import { createIamService } from './service.mjs';

export const name = 'forge-iam';

// The service can load without credentials or webServer; those capabilities
// are checked when sign-in/callback actually needs them, so a misconfigured
// profile fails closed instead of staying pending forever.
export const inject = [];

export { Config, IamError, createIamService };

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const result = validateConfig(rawConfig);
  if ('issues' in result) {
    throw new IamError('IAM_CONFIG_INVALID', 'IAM configuration is invalid', {
      issues: result.issues,
    });
  }

  if (typeof ctx?.provide !== 'function') {
    throw new IamError('IAM_HOST_UNAVAILABLE', 'ctx.provide is required to register ctx.iam');
  }
  if (typeof ctx?.effect !== 'function') {
    throw new IamError('IAM_HOST_UNAVAILABLE', 'ctx.effect is required to own the IAM lifecycle');
  }

  // Cordis refuses to read a service the plugin did not inject ("cannot get
  // property ... without inject"), and ctx.get() is not an escape hatch. Every
  // lazy dependency is therefore bound through dynamic injection: the callback
  // runs when the service appears and its disposer clears the binding when the
  // service goes away, so a replaced provider can never satisfy the gate.
  const current = { credentials: undefined, atomicStore: undefined };
  const hasDynamicInjection = typeof ctx.inject === 'function';
  // Cordis throws for a mounted service read without injection, while plain
  // embeddings (tests, CLI hosts) expose services as properties or through
  // ctx.get. Injection is the primary binding for the two services the sign-in
  // gate depends on; the legacy reads stay as the embedding fallback and never
  // satisfy the gate on their own.
  const getContextService = (name) => {
    try {
      return ctx?.[name] ?? (typeof ctx?.get === 'function' ? ctx.get(name) : undefined);
    } catch {
      return undefined;
    }
  };
  const readCredentials = () => current.credentials ?? getContextService('credentials');
  const readAtomicStore = () => current.atomicStore ?? getContextService('iam-atomic-store');

  // The atomic-store verdict and the joint adapter come from a separate host
  // service owned by the credentials plugin, not from the provider's own
  // fields. A plain ctx.credentials impostor cannot satisfy the gate unless it
  // also mounts that service, and both disappear together on unload.
  const trustedJointStore = () => readAtomicStore();
  const verifyAtomicStore = (instance) => {
    try {
      const trust = trustedJointStore();
      const bound = () => !hasDynamicInjection
        || (current.credentials === instance && current.atomicStore === trust);
      return trust !== undefined && bound() && trust.verify(instance) === true && bound();
    } catch {
      return false;
    }
  };
  const getGatewayAtomicStore = (instance) => {
    const trust = trustedJointStore();
    if (trust === undefined || !verifyAtomicStore(instance) || trustedJointStore() !== trust) {
      throw new IamError('IAM_GATEWAY_ATOMIC_UNVERIFIED', 'no trusted joint store is bound to this credentials instance');
    }
    return trust.adapter();
  };
  const verifyGatewayAtomicStore = (instance, adapter) => {
    try {
      const trust = trustedJointStore();
      return trust !== undefined && verifyAtomicStore(instance)
        && trustedJointStore() === trust && adapter === trust.adapter();
    } catch {
      return false;
    }
  };
  const hasTrustedBinding = () => {
    const credentials = current.credentials;
    const atomicStore = current.atomicStore;
    return Boolean(credentials && atomicStore && verifyAtomicStore(credentials)
      && current.credentials === credentials && current.atomicStore === atomicStore);
  };

  let currentWebServer;
  let currentConnection;
  let modelServices;
  let managedRuntime;
  const service = createIamService(result.value, {
    exclusive: checkExclusive(ctx, result.value),
    recheckExclusive: () => checkExclusive(ctx, result.value),
    credentials: readCredentials(),
    getCredentials: () => readCredentials(),
    verifyAtomicStore,
    getGatewayAtomicStore,
    verifyGatewayAtomicStore,
    logGatewayStage: (stage, elapsedMs) => {
      // Only fixed stage names and monotonic elapsed time cross this boundary.
      try { return ctx.logger?.debug?.(`forge-iam: gateway-save ${stage} ${elapsedMs}ms`); } catch { /* optional diagnostic */ }
    },
    getManagedModelRuntime: () => managedRuntime,
    getModelSelectionServices: () => {
      try {
        const currentLlm = getContextService('llm');
        const currentAdm = getContextService('agentDefaultModel');
        return modelServices && currentLlm === modelServices.llm
          && currentAdm === modelServices.agentDefaultModel ? modelServices : undefined;
      } catch { return undefined; }
    },
    getOrigin: () => currentWebServer?.getOrigin?.(),
    openCallback: () => callbackManager?.ensure(),
    closeCallback: () => callbackManager?.release(),
    getCallbackOrigin: () => callbackManager?.origin,
  });

  // With callbackPort set the plugin owns the callback: a loopback listener that
  // exists only while an attempt is open. The host port may change between
  // launches and its origin is never used for the redirect.
  let callbackManager;
  if (typeof result.value.callbackPort === 'number') {
    const loopbackRoutes = createIamRoutes(service, {
      callbackPath: result.value.redirectPath,
      getOrigin: () => callbackManager?.origin,
    });
    callbackManager = createCallbackManager({
      port: result.value.callbackPort,
      address: result.value.callbackAddress,
      path: result.value.redirectPath,
      handler: loopbackRoutes,
    });
  }

  // Cordis runs a normal function plugin with `new`, so a returned cleanup is
  // not collected as an effect (only `Service.init` is). Register teardown as
  // an explicit effect: unload must dispose the service, stop the injected
  // webServer fiber and unprovide ctx.iam even though apply is a plain
  // function.
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    // Dispose first: a sign-in waiting on the callback bind must observe the
    // service as gone, not receive a URL for a listener that is about to close.
    await service.dispose();
    await callbackManager?.close();
    currentWebServer = undefined;
    currentConnection = undefined;
    if (typeof offConnection === 'function') offConnection();
    else await offConnection?.dispose?.();
    modelServices = undefined;
    agentDefaultModelService = undefined;
    if (typeof offAgentDefaultModel === 'function') offAgentDefaultModel();
    else offAgentDefaultModel?.dispose?.();
    if (typeof offManagedModels === 'function') await offManagedModels();
    else await offManagedModels?.dispose?.();
    if (typeof offModelServices === 'function') offModelServices();
    else await offModelServices?.dispose?.();
    if (typeof offWebServer === 'function') offWebServer();
    else await offWebServer?.dispose?.();
    if (typeof offAtomicStore === 'function') offAtomicStore();
    else await offAtomicStore?.dispose?.();
    if (typeof offCredentials === 'function') offCredentials();
    else await offCredentials?.dispose?.();
    disposeProvide?.();
    disposeBrokerProvide?.();
  };

  let disposeProvide;
  let disposeBrokerProvide;
  let offWebServer;
  let offConnection;
  let offCredentials;
  let offAtomicStore;
  let offModelServices;
  let offManagedModels;
  let offAgentDefaultModel;
  let agentDefaultModelService;
  let credentialsOwner;
  let atomicStoreOwner;
  let hydratedBinding;
  const prepareBridge = () => {
    if (!tornDown) void service.bridgeCapability().catch(() => {});
  };
  const hydrateBinding = () => {
    if (tornDown || !hasTrustedBinding()) return;
    const credentials = current.credentials;
    const atomicStore = current.atomicStore;
    if (hydratedBinding?.credentials === credentials && hydratedBinding.atomicStore === atomicStore) return;
    const binding = { credentials, atomicStore };
    hydratedBinding = binding;
    void service.hydrate().then(() => {
      // Rebinding the same record may not produce a state transition, but its
      // previous timer may have stopped while the trust service was absent.
      if (!tornDown && hydratedBinding === binding && hasTrustedBinding()) service.notifyView();
    }).catch(() => {});
  };

  ctx.effect(() => {
    disposeProvide = ctx.provide('iam', service);
    disposeBrokerProvide = ctx.provide('forgeIamCredentialBroker', service.extCredentialBroker);
    if (typeof ctx.inject === 'function') {
      try {
        offAgentDefaultModel = ctx.inject(['agentDefaultModel'], (agentHost) => {
          if (tornDown) return;
          agentDefaultModelService = agentHost.agentDefaultModel;
          if (managedRuntime?.syncDefaultModel) {
            void managedRuntime.syncDefaultModel().catch(() => {});
          }
          return () => {
            if (agentDefaultModelService === agentHost.agentDefaultModel) agentDefaultModelService = undefined;
          };
        });
      } catch {
        // agentDefaultModel is optional in reduced host environments
      }
      offManagedModels = ctx.inject(['llm'], (host) => {
        if (tornDown) return;
        const getHostDefaultModel = () => {
          try {
            return agentDefaultModelService
              ?? host?.agentDefaultModel
              ?? ctx?.agentDefaultModel
              ?? modelServices?.agentDefaultModel
              ?? host?.get?.('agentDefaultModel')
              ?? ctx?.get?.('agentDefaultModel');
          } catch {
            return undefined;
          }
        };
        const runtime = createManagedModelRuntime({
          host,
          iam: service,
          config: result.value,
          getHostDefaultModel,
          // P1-3: keep the failure object fixed at { code, message }; the
          // internal code is diagnosis and goes to the host log only.
          logFailure: (detailCode, code) => ctx.logger?.debug?.(`forge-iam: model call failure ${detailCode} -> ${code}`),
          // The catalogue flips loading → ready/error without any IAM
          // transition. Push a view frame so subscribers do not keep a stale
          // "syncing" snapshot until some unrelated event arrives.
          onChange: () => { service.notifyView(); },
        });
        managedRuntime = runtime;
        const release = async () => {
          if (managedRuntime === runtime) managedRuntime = undefined;
          await runtime.dispose();
        };
        host.effect(() => release, 'forge-iam-managed-models');
        return release;
      });
    }
    if (result.value.defaultModel.trim() && typeof ctx.inject === 'function') {
      offModelServices = ctx.inject(['llm', 'agentDefaultModel'], (host) => {
        if (tornDown) return;
        const binding = Object.freeze({ llm: host.llm, agentDefaultModel: host.agentDefaultModel });
        modelServices = binding;
        const observe = () => {
          if (!tornDown && modelServices === binding) void service.reconcileDefaultModel().catch(() => {});
        };
        // The SDK declares this topology notification as payload-free emit.
        const offEvent = host.on?.('llm/adapters-updated', observe);
        observe();
        return () => {
          offEvent?.();
          if (modelServices === binding) modelServices = undefined;
        };
      });
    }
    // Same-origin management API plus the OIDC loopback callback. The callback
    // is a GET route; state/PKCE bind it to the Host attempt. The management
    // API is additionally gated by DSH Connection authentication.
    if (typeof ctx.inject === 'function') {
      offCredentials = ctx.inject(['credentials'], (host) => {
        const binding = host.credentials;
        const owner = {};
        credentialsOwner = owner;
        current.credentials = binding;
        prepareBridge();
        hydrateBinding();
        return () => {
          if (credentialsOwner !== owner) return;
          credentialsOwner = undefined;
          current.credentials = undefined;
          hydratedBinding = undefined;
          if (!tornDown) service.notifyView();
        };
      });
      offAtomicStore = ctx.inject(['iam-atomic-store'], (host) => {
        const binding = host['iam-atomic-store'];
        const owner = {};
        atomicStoreOwner = owner;
        current.atomicStore = binding;
        prepareBridge();
        hydrateBinding();
        return () => {
          if (atomicStoreOwner !== owner) return;
          atomicStoreOwner = undefined;
          current.atomicStore = undefined;
          hydratedBinding = undefined;
          if (!tornDown) service.notifyView();
        };
      });
      offConnection = ctx.inject(['connection'], (host) => {
        const binding = host.connection;
        currentConnection = binding;
        return () => { if (currentConnection === binding) currentConnection = undefined; };
      });
      offWebServer = ctx.inject(['webServer'], (host) => {
        const binding = host.webServer;
        currentWebServer = binding;
        const routes = createIamRoutes(service, {
          callbackPath: result.value.redirectPath,
          getOrigin: () => host.webServer.getOrigin?.(),
          getBridgeSecret: () => service.bridgeCapability().catch(() => undefined),
          getConnection: () => currentConnection,
        });
        const offApi = host.webServer.register({
          kind: 'prefix',
          path: '/api/forge-iam',
          handler: routes,
        });
        // A fixed-port listener owns the callback; registering it here too
        // would expose a second address IAM never registered.
        const offCallback = callbackManager ? undefined : host.webServer.register({
          kind: 'exact',
          path: result.value.redirectPath,
          handler: routes,
        });
        return () => {
          offApi?.();
          offCallback?.();
          if (currentWebServer === binding) currentWebServer = undefined;
        };
      });
    }
    return teardown;
  }, 'forge-iam');

  prepareBridge();
  if (hasDynamicInjection) hydrateBinding();
  else void service.hydrate().catch(() => {});

  // Returned for direct callers (tests, non-Cordis embeddings); Cordis owns
  // the same idempotent teardown through the effect above.
  return teardown;
}
