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
  const dispose = ctx.provide('iam', service);
  const fibers = [];

  // Same-origin API for the Client skeleton plus the OIDC loopback callback.
  // The callback is a GET route; state/PKCE bind it to the Host attempt.
  if (typeof ctx.inject === 'function') {
    fibers.push(ctx.inject(['webServer'], (host) => {
      const routes = createIamRoutes(service, { callbackPath: result.value.redirectPath });
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
      const close = () => {
        offApi?.();
        offCallback?.();
      };
      host.effect?.(() => close);
      return close;
    }));
  }

  void service.hydrate();

  return async () => {
    await service.dispose();
    dispose?.();
    for (const fiber of fibers) {
      if (typeof fiber === 'function') fiber();
      else await fiber?.dispose?.();
    }
  };
}
