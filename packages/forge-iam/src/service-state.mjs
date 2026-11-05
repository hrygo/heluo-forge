import { isConfigured } from './config.mjs';
import { IamError } from './errors.mjs';
import { createView, transition } from './state.mjs';
import { isAccessExpired, isRefreshUsable, summarizeGrant } from './record.mjs';

/**
 * Session state, owned in one place.
 *
 * The rest of the service reads and writes these five scalars through `ctx`
 * instead of closing over loose `let` bindings. Everything this module needs
 * from the outside arrives through `env`, so it never reaches back into the
 * service: the gateway summary, the metadata issuer and the reconciliation
 * trigger are getters, and `fail()` asks the caller to clear its attempt and
 * profile bookkeeping through `onFailReset`.
 *
 * Ordering is part of the contract: `view()` reads the gateway summary before
 * asking the managed-model runtime, `notify()` calls the reconciliation trigger
 * after every listener, and `fail()` notifies once per branch.
 */
export function createServiceState(env) {
  const {
    config,
    options,
    configured,
    now,
    getGatewaySummary,
    getMetadataIssuer,
    scheduleReconcile,
    clearPendingObservation,
    onFailReset,
  } = env;

  let exclusive = options.exclusive ?? { ok: true };
  let state = !exclusive.ok ? 'error' : (configured ? 'signed-out' : 'unconfigured');
  let error = exclusive.ok ? null : (exclusive.reason ?? 'exclusive-violation');
  let lastGrant = null;
  let disposed = false;
  const listeners = new Set();

  function recheckExclusive() {
    if (typeof options.recheckExclusive !== 'function') return;
    const next = options.recheckExclusive();
    if (next?.ok === false) {
      clearPendingObservation();
      exclusive = next;
      error = next.reason ?? 'exclusive-violation';
      if (state !== 'unconfigured') state = 'error';
    }
  }

  function assertExclusive() {
    recheckExclusive();
    if (!exclusive.ok) {
      throw new IamError('IAM_EXCLUSIVE_CONFLICT', 'official account service is still mounted', {
        reason: exclusive.reason ?? 'exclusive-violation',
      });
    }
  }

  function view() {
    recheckExclusive();
    const summary = lastGrant ? summarizeGrant(lastGrant) : {};
    const gateway = getGatewaySummary();
    // The catalogue is display state, not an authorization: keep the last known
    // list while the session is still recoverable (a signed-in subject whose
    // access token lapsed or whose revocation check is offline) so the panel
    // can mark it stale instead of erasing the model list.
    const recoverable = state === 'ready' || state === 'unreachable'
      || (state === 'expired' && lastGrant && isRefreshUsable(lastGrant, now()));
    return createView(state, {
      configured,
      missing: isConfigured(config).missing,
      error,
      exclusive: exclusive.ok ? 'ok' : (exclusive.reason ?? 'exclusive-violation'),
      principal: summary.principal ?? null,
      accessExpiresAt: summary.accessExpiresAt ?? null,
      gatewayCredential: gateway,
      gatewayConsoleUrl: config.gatewayConsoleUrl || null,
      modelAccess: {
        ...(options.getManagedModelRuntime?.()?.getView() ?? { managed: true, state: 'unconfigured', models: [] }),
        configured: Boolean(gateway?.baseURL || config.managedModels?.baseURL),
        baseURL: gateway?.baseURL ?? config.managedModels?.baseURL ?? '',
        ...(!recoverable || gateway?.state !== 'configured' || gateway?.matchesAccount !== true
          ? { state: 'unconfigured', error: null, defaultModelId: null, enabled: [], models: [], modelOptions: {} }
          : {}),
      },
    });
  }

  function notify() {
    const snapshot = view();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // One subscriber must not corrupt a transition or starve the others.
      }
    }
    scheduleReconcile();
    return snapshot;
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
    return notify();
  }

  function fail(code) {
    onFailReset();
    lastGrant = null;
    error = code;
    if (state === 'unconfigured') {
      notify();
      return;
    }
    if (state === 'authenticating') {
      const result = transition(state, 'SIGN_IN_FAILURE');
      if (result.ok) state = result.state;
    } else if (state !== 'error') {
      state = 'error';
    }
    notify();
  }

  // Only normalized configuration or metadata validated by this instance can
  // bind a stored identity. Neither the grant nor discovery URL is an issuer pin.
  function knownIssuer() {
    return config.issuer || getMetadataIssuer() || '';
  }

  return {
    get state() { return state; },
    set state(next) { state = next; },
    get error() { return error; },
    set error(next) { error = next; },
    get lastGrant() { return lastGrant; },
    set lastGrant(next) { lastGrant = next; },
    get disposed() { return disposed; },
    set disposed(next) { disposed = next; },
    get exclusive() { return exclusive; },
    set exclusive(next) { exclusive = next; },

    view,
    notify,
    publish,
    fail,
    recheckExclusive,
    assertExclusive,
    knownIssuer,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    clearListeners() { listeners.clear(); },
  };
}
