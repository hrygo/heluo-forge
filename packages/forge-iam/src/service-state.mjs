import { isConfigured } from './config.mjs';
import { IamError } from './errors.mjs';
import { createView, transition } from './state.mjs';
import { isAccessExpired, isRefreshUsable, summarizeGrant } from './record.mjs';
import { renewalDeadlines } from './session-renewal-log.mjs';

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
 * after every listener, then updates the renewal schedule; `fail()` notifies
 * once per branch.
 */
export function createServiceState(env) {
  const {
    config,
    options,
    configured,
    now,
    logRenewal,
    getGatewaySummary,
    getMetadataIssuer,
    scheduleReconcile,
    scheduleRenewal,
    clearPendingObservation,
    onFailReset,
  } = env;

  let exclusive = options.exclusive ?? { ok: true };
  let state = !exclusive.ok ? 'error' : (configured ? 'signed-out' : 'unconfigured');
  let error = exclusive.ok ? null : (exclusive.reason ?? 'exclusive-violation');
  let lastGrant = null;
  // Non-secret provenance/pin and the last authenticated session identity only.
  let sessionAuthentication = null;
  let disposed = false;
  let expiry = null;
  let publishedState;
  let publishedError;
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

  function currentState(at) {
    return state === 'ready' && isAccessExpired(lastGrant, at) ? 'expired' : state;
  }

  function cancelExpiry() {
    clearTimeout(expiry?.timer);
    expiry = null;
  }

  function scheduleExpiry(sampledAt) {
    const access = state === 'ready' ? Date.parse(lastGrant?.accessExpiresAt) : NaN;
    const refresh = ['ready', 'expired'].includes(state) && isRefreshUsable(lastGrant, sampledAt)
      ? Date.parse(lastGrant?.refreshExpiresAt) : NaN;
    const deadline = Math.min(Number.isFinite(access) ? access : Infinity, Number.isFinite(refresh) ? refresh : Infinity);
    if (disposed || !Number.isFinite(deadline)) {
      cancelExpiry();
      return;
    }
    // A deadline visible in the published view may pass before this call.
    // Re-arm an overdue timer immediately even if the deadline is unchanged.
    const remaining = deadline - now();
    if (expiry?.deadline === deadline && remaining > 0) return;
    cancelExpiry();
    const timer = setTimeout(() => {
      if (expiry?.timer !== timer) return;
      expiry = null;
      if (now() >= deadline) notify();
      else scheduleExpiry(sampledAt);
    }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    timer.unref?.();
    expiry = { deadline, timer };
  }

  function view() {
    recheckExclusive();
    const at = now();
    const current = currentState(at);
    const summary = lastGrant ? summarizeGrant(lastGrant) : {};
    const gateway = getGatewaySummary();
    // The catalogue is display state, not an authorization: keep the last known
    // list while the session is still recoverable (a signed-in subject whose
    // access token lapsed or whose revocation check is offline) so the panel
    // can mark it stale instead of erasing the model list.
    const renewable = Boolean(lastGrant) && isRefreshUsable(lastGrant, at);
    const recoverable = current === 'ready' || (current === 'unreachable' && error !== 'IAM_CREDENTIALS_UNAVAILABLE')
      || (current === 'expired' && renewable);
    const snapshot = createView(current, {
      configured,
      missing: isConfigured(config).missing,
      error: current === state ? error : null,
      exclusive: exclusive.ok ? 'ok' : (exclusive.reason ?? 'exclusive-violation'),
      principal: summary.principal ?? null,
      accessExpiresAt: summary.accessExpiresAt ?? null,
      renewal: lastGrant ? (renewable ? 'available' : 'unavailable') : 'none',
      refreshExpiresAt: summary.refreshExpiresAt ?? null,
      gatewayCredential: gateway,
      gatewayConsoleUrl: config.gatewayConsoleUrl || null,
      modelAccess: {
        ...(options.getManagedModelRuntime?.()?.getView() ?? { managed: true, state: 'unconfigured', models: [] }),
        configured: Boolean(gateway?.baseURL || config.managedModels?.baseURL),
        baseURL: gateway?.baseURL ?? config.managedModels?.baseURL ?? '',
        ...(!recoverable || gateway?.state !== 'configured' || gateway?.matchesAccount !== true
          ? { state: 'unconfigured', error: null, defaultModelId: null, enabled: [], models: [], modelOptions: {}, manualTruncated: 0 }
          : {}),
      },
    });
    // Sampling time accompanies the browser transport. Internal equality and
    // observer projections continue to compare the account state itself.
    return Object.defineProperty(snapshot, 'sampledAt', { value: at });
  }

  function notify() {
    // Expiry can become observable before the Host timer runs after a wake.
    const current = currentState(now());
    if (state !== current) {
      state = current;
      error = null;
    }
    const snapshot = view();
    if (logRenewal && (publishedState !== state || publishedError !== error)) {
      logRenewal('session-state', { previousState: publishedState, state, code: error, ...renewalDeadlines(lastGrant) });
      publishedState = state;
      publishedError = error;
    }
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // One subscriber must not corrupt a transition or starve the others.
      }
    }
    scheduleReconcile();
    scheduleRenewal?.();
    scheduleExpiry(snapshot.sampledAt);
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
    get sessionAuthentication() { return sessionAuthentication; },
    set sessionAuthentication(next) { sessionAuthentication = next; },
    get disposed() { return disposed; },
    set disposed(next) {
      disposed = next;
      if (next) cancelExpiry();
    },
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
