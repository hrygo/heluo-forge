import { createManagedModelRuntime } from './managed-models.mjs';
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

  let credentials;
  try {
    credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
  } catch {
    credentials = undefined;
  }

  let modelServices;
  let managedRuntime;
  const service = createIamService(result.value, {
    exclusive: checkExclusive(ctx, result.value),
    recheckExclusive: () => checkExclusive(ctx, result.value),
    credentials,
    getCredentials: () => {
      try {
        return typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
      } catch {
        return undefined;
      }
    },
    getManagedModelRuntime: () => managedRuntime,
    getModelSelectionServices: () => {
      try {
        return modelServices && ctx.get?.('llm') === modelServices.llm
          && ctx.get?.('agentDefaultModel') === modelServices.agentDefaultModel ? modelServices : undefined;
      } catch { return undefined; }
    },
    getOrigin: () => {
      try {
        return ctx.get?.('webServer')?.getOrigin?.();
      } catch {
        return undefined;
      }
    },
  });

  // Cordis runs a normal function plugin with `new`, so a returned cleanup is
  // not collected as an effect (only `Service.init` is). Register teardown as
  // an explicit effect: unload must dispose the service, stop the injected
  // webServer fiber and unprovide ctx.iam even though apply is a plain
  // function.
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    modelServices = undefined;
    agentDefaultModelService = undefined;
    if (typeof offAgentDefaultModel === 'function') offAgentDefaultModel();
    else offAgentDefaultModel?.dispose?.();
    if (typeof offManagedModels === 'function') await offManagedModels();
    else await offManagedModels?.dispose?.();
    await service.dispose();
    if (typeof offModelServices === 'function') offModelServices();
    else await offModelServices?.dispose?.();
    if (typeof offWebServer === 'function') offWebServer();
    else await offWebServer?.dispose?.();
    disposeProvide?.();
  };

  let disposeProvide;
  let offWebServer;
  let offModelServices;
  let offManagedModels;
  let offAgentDefaultModel;
  let agentDefaultModelService;

  ctx.effect(() => {
    disposeProvide = ctx.provide('iam', service);
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
        });
        managedRuntime = runtime;
        const release = async () => { if (managedRuntime === runtime) managedRuntime = undefined; await runtime.dispose(); };
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
      offWebServer = ctx.inject(['webServer'], (host) => {
        const routes = createIamRoutes(service, {
          callbackPath: result.value.redirectPath,
          getOrigin: () => host.webServer.getOrigin?.(),
          getBridgeSecret: () => service.bridgeCapability().catch(() => undefined),
          getConnection: () => {
            try {
              return ctx.get?.('connection');
            } catch {
              return undefined;
            }
          },
        });
        const offApi = host.webServer.register({
          kind: 'prefix',
          path: '/api/forge-iam',
          handler: routes,
        });
        const offCallback = host.webServer.register({
          kind: 'exact',
          path: result.value.redirectPath,
          handler: routes,
        });
        return () => {
          offApi?.();
          offCallback?.();
        };
      });
    }
    return teardown;
  }, 'forge-iam');

  void service.hydrate().catch(() => {});

  // Returned for direct callers (tests, non-Cordis embeddings); Cordis owns
  // the same idempotent teardown through the effect above.
  return teardown;
}
