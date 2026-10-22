import { Config, isConfigured, validateConfig } from './config.mjs';
import { checkExclusive } from './exclusive.mjs';
import { createIamRoutes } from './routes.mjs';
import { createView, transition } from './state.mjs';

export const name = 'forge-iam';

// The Host skeleton has no hard service dependency yet. Once credentials and
// webServer wiring lands, this becomes ['credentials'] and optional webServer
// injection; keeping it empty now avoids a plugin that stays pending forever.
export const inject = [];

export { Config };

export class IamError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IamError';
    this.code = code;
    this.details = details;
  }
}

function configuredState(config) {
  const check = isConfigured(config);
  return {
    state: check.ok ? 'signed-out' : 'unconfigured',
    missing: check.missing,
  };
}

/**
 * Build the Host service. It is intentionally fail closed until the login
 * exchange, credential storage and refresh loop are implemented in later
 * slices; callers must never interpret IAM_NOT_IMPLEMENTED as success.
 *
 * @param {Record<string, unknown>} config normalized config
 * @param {{ exclusive?: { ok: boolean, reason?: string } }} [options]
 */
export function createIamService(config, options = {}) {
  const initial = configuredState(config);
  const exclusive = options.exclusive ?? { ok: true };
  let state = exclusive.ok ? initial.state : 'error';
  let error = exclusive.ok ? null : (exclusive.reason ?? 'exclusive-violation');
  const listeners = new Set();

  function view() {
    return createView(state, {
      configured: state !== 'unconfigured',
      missing: initial.missing,
      error,
      exclusive: exclusive.ok ? 'ok' : (exclusive.reason ?? 'exclusive-violation'),
    });
  }

  function publish(next, nextError = null) {
    const result = transition(state, next);
    if (!result.ok) {
      throw new IamError('IAM_INVALID_TRANSITION', `cannot apply ${next} from ${state}`, {
        state,
        event: next,
        reason: result.reason,
      });
    }
    state = result.state;
    error = nextError;
    const snapshot = view();
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  const service = {
    getView() {
      return view();
    },

    async startSignIn() {
      if (!exclusive.ok) {
        throw new IamError('IAM_EXCLUSIVE_CONFLICT', 'official account service is still mounted', {
          reason: exclusive.reason ?? 'exclusive-violation',
        });
      }
      if (state === 'unconfigured') {
        throw new IamError('IAM_UNCONFIGURED', 'IAM configuration is incomplete', {
          missing: initial.missing,
        });
      }
      if (state === 'ready') return view();
      if (state === 'authenticating') return view();
      // No authorization URL is fabricated before the IAM contract is frozen.
      throw new IamError('IAM_NOT_IMPLEMENTED', 'IAM sign-in exchange is not implemented yet');
    },

    async cancelSignIn() {
      if (state !== 'authenticating') return view();
      return publish('CANCEL');
    },

    async signOut() {
      if (state === 'unconfigured') return view();
      if (state === 'signed-out') return view();
      return publish('SIGN_OUT');
    },

    async resolveToken() {
      throw new IamError('IAM_NOT_IMPLEMENTED', 'IAM token resolution is not implemented yet');
    },

    async *watch(signal) {
      const snapshot = view();
      yield snapshot;
      if (signal?.aborted) return;

      const queue = [];
      let waiter = null;
      const listener = (value) => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(value);
        } else {
          queue.push(value);
        }
      };
      const onAbort = () => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(null);
        }
      };
      listeners.add(listener);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        for (;;) {
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          const value = await new Promise((resolve) => {
            waiter = resolve;
          });
          if (value === null || signal?.aborted) return;
          yield value;
        }
      } finally {
        listeners.delete(listener);
        signal?.removeEventListener('abort', onAbort);
      }
    },

    dispose() {
      listeners.clear();
    },
  };

  return service;
}

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

  const service = createIamService(result.value, {
    exclusive: checkExclusive(ctx, result.value),
  });
  const dispose = ctx.provide('iam', service);
  const disposers = [];

  // The Client skeleton uses this interim same-origin route until the IAM
  // Remote namespace is available. It exposes no token and sign-in remains a
  // 501 until the IAM contract is frozen.
  if (typeof ctx.inject === 'function') {
    disposers.push(ctx.inject(['webServer'], (host) => {
      const off = host.webServer.register({
        kind: 'prefix',
        path: '/api/forge-iam',
        handler: createIamRoutes(service),
      });
      host.effect?.(() => off);
      return off;
    }));
  }

  return () => {
    service.dispose();
    dispose?.();
    for (const close of disposers) close?.();
  };
}