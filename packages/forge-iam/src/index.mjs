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
    await service.dispose();
    if (typeof offWebServer === 'function') offWebServer();
    else await offWebServer?.dispose?.();
    disposeProvide?.();
  };

  let disposeProvide;
  let offWebServer;

  ctx.effect(() => {
    disposeProvide = ctx.provide('iam', service);
    // Same-origin management API plus the OIDC loopback callback. The callback
    // is a GET route; state/PKCE bind it to the Host attempt. The management
    // API is additionally gated by DSH Connection authentication.
    if (typeof ctx.inject === 'function') {
      offWebServer = ctx.inject(['webServer'], (host) => {
        const routes = createIamRoutes(service, {
          callbackPath: result.value.redirectPath,
          getOrigin: () => host.webServer.getOrigin?.(),
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
