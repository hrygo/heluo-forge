// Pure state machine for the IAM session. It deliberately has no DSH imports so
// the lifecycle can be tested without a Host runtime.

export const STATES = Object.freeze([
  'unconfigured',
  'signed-out',
  'authenticating',
  'ready',
  'expired',
  'unreachable',
  'error',
]);

export const EVENTS = Object.freeze([
  'CONFIGURE',
  'SIGN_IN',
  'SIGN_IN_SUCCESS',
  'SIGN_IN_FAILURE',
  'CANCEL',
  'EXPIRE',
  'REFRESH_SUCCESS',
  'REFRESH_FAILURE',
  'UNREACHABLE',
  'RECOVER',
  'SIGN_OUT',
  'EXCLUSIVE_CONFLICT',
  'RESET',
]);

const TRANSITIONS = Object.freeze({
  unconfigured: Object.freeze({
    CONFIGURE: 'signed-out',
    SIGN_OUT: 'unconfigured',
    RESET: 'unconfigured',
  }),
  'signed-out': Object.freeze({
    SIGN_IN: 'authenticating',
    SIGN_IN_SUCCESS: 'ready',
    SIGN_OUT: 'signed-out',
    EXCLUSIVE_CONFLICT: 'error',
    RESET: 'signed-out',
  }),
  authenticating: Object.freeze({
    CANCEL: 'signed-out',
    SIGN_IN_SUCCESS: 'ready',
    SIGN_IN_FAILURE: 'error',
    EXCLUSIVE_CONFLICT: 'error',
    SIGN_OUT: 'signed-out',
  }),
  ready: Object.freeze({
    EXPIRE: 'expired',
    UNREACHABLE: 'unreachable',
    SIGN_OUT: 'signed-out',
    EXCLUSIVE_CONFLICT: 'error',
    RESET: 'signed-out',
  }),
  expired: Object.freeze({
    SIGN_IN: 'authenticating',
    REFRESH_SUCCESS: 'ready',
    REFRESH_FAILURE: 'signed-out',
    SIGN_OUT: 'signed-out',
    UNREACHABLE: 'unreachable',
    EXCLUSIVE_CONFLICT: 'error',
  }),
  unreachable: Object.freeze({
    RECOVER: 'ready',
    EXPIRE: 'expired',
    SIGN_OUT: 'signed-out',
    EXCLUSIVE_CONFLICT: 'error',
  }),
  error: Object.freeze({
    RESET: 'signed-out',
    SIGN_OUT: 'signed-out',
    SIGN_IN: 'authenticating',
  }),
});

/**
 * @param {string} state
 * @param {string} event
 * @returns {{ ok: true, state: string } | { ok: false, state: string, reason: string }}
 */
export function transition(state, event) {
  if (!STATES.includes(state)) {
    return { ok: false, state, reason: 'unknown-state' };
  }
  if (!EVENTS.includes(event)) {
    return { ok: false, state, reason: 'unknown-event' };
  }
  const next = TRANSITIONS[state]?.[event];
  if (!next) {
    return { ok: false, state, reason: 'invalid-transition' };
  }
  return { ok: true, state: next };
}

export function isSignedIn(state) {
  return state === 'ready' || state === 'unreachable';
}

export function canSignIn(state) {
  return state === 'signed-out' || state === 'expired' || state === 'error';
}

export function credentialStoreUnavailable(state, error) {
  return (state === 'unreachable' || state === 'error') && error === 'IAM_CREDENTIALS_UNAVAILABLE';
}

/**
 * Build the non-secret snapshot consumed by the Host service and Client UI.
 *
 * @param {string} state
 * @param {{ configured?: boolean, missing?: string[], error?: string | null, exclusive?: string, principal?: string | null, accessExpiresAt?: string | null, renewal?: string, refreshExpiresAt?: string | null, gatewayCredential?: object | null, gatewayConsoleUrl?: string | null }} [details]
 */
export function createView(state, details = {}) {
  const storageUnavailable = credentialStoreUnavailable(state, details.error);
  const sessionActionsAllowed = details.configured !== false && (details.exclusive ?? 'ok') === 'ok';
  const signOutPending = state === 'error'
    && ['IAM_REVOCATION_UNKNOWN', 'IAM_CREDENTIALS_CLEAR_FAILED'].includes(details.error);
  return {
    state,
    configured: details.configured !== false,
    // Storage recovery still needs a durable grant before publishing sign-in.
    signedIn: isSignedIn(state) && !storageUnavailable,
    canSignOut: sessionActionsAllowed && (isSignedIn(state) || state === 'expired' || signOutPending),
    canSignIn: sessionActionsAllowed && (canSignIn(state) || storageUnavailable),
    missing: details.missing ?? [],
    error: details.error ?? null,
    exclusive: details.exclusive ?? 'ok',
    principal: details.principal ?? null,
    accessExpiresAt: details.accessExpiresAt ?? null,
    // Whether this session can still renew itself without a fresh sign-in.
    // `none` means there is no stored grant to renew.
    renewal: details.renewal ?? 'none',
    refreshExpiresAt: details.refreshExpiresAt ?? null,
    gatewayCredential: details.gatewayCredential ?? null,
    gatewayConsoleUrl: details.gatewayConsoleUrl ?? null,
    modelAccess: details.modelAccess ?? null,
  };
}

export function initialState(configured, missing = []) {
  return createView(configured ? 'signed-out' : 'unconfigured', { configured, missing });
}
