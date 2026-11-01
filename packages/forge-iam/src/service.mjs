import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isConfigured, validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';
import { createGatewayCredentialStore, createGrantStore, StoreError } from './store.mjs';
import { isAccessExpired, isRefreshUsable, shouldRefresh, summarizeGrant } from './record.mjs';
import { createView, transition } from './state.mjs';
import {
  OidcError,
  buildAuthorizationUrl,
  createPkce,
  exchangeCode,
  fetchJson,
  loadMetadata,
  parseCallbackUrl,
  randomToken,
  refreshTokens,
  revokeToken,
  safeStateEqual,
  verifyIdToken,
} from './oidc.mjs';

const METADATA_TTL_MS = 5 * 60 * 1000;
const JWKS_TTL_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 5000;
const ID_TOKEN_CLOCK_SKEW_SECONDS = 60;
// The account view is polled every couple of seconds; re-reading the secret
// from an OS keychain on every poll is wasteful and may re-trigger access
// checks, so the summary is reused briefly unless a caller forces a reload.
const GATEWAY_RELOAD_MS = 5000;
// Automatic refresh for an expired-but-refreshable session retries at most this
// often; the view poll runs every two seconds and must not hammer the IdP.
const AUTO_REFRESH_BACKOFF_MS = 30000;

function canonicalRecord(value) {
  if (Array.isArray(value)) return value.map(canonicalRecord);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalRecord(value[key])]));
  }
  return value;
}

function refreshBaseId(grant, id) {
  return createHmac('sha256', id).update(JSON.stringify(canonicalRecord(grant))).digest('base64url');
}

function sameGrantIgnoringRefreshMarker(left, right) {
  const { refreshOperation: ignoredLeft, ...leftBase } = left;
  const { refreshOperation: ignoredRight, ...rightBase } = right;
  return isDeepStrictEqual(leftBase, rightBase);
}

function nowIso(now) {
  return new Date(now).toISOString();
}

function addSeconds(now, seconds) {
  return new Date(now + seconds * 1000).toISOString();
}

function tokenErrorMessage(error) {
  if (error instanceof OidcError) {
    if (error.code === 'IAM_HTTP_ERROR' && error.details?.oauthError === 'invalid_grant') {
      return 'IAM_INVALID_GRANT';
    }
    return error.code;
  }
  if (error instanceof IamError) return error.code;
  if (error instanceof StoreError) return error.code;
  return 'IAM_INTERNAL';
}

function safeMessage(code) {
  const messages = {
    IAM_UNCONFIGURED: 'IAM configuration is incomplete',
    IAM_CREDENTIALS_UNAVAILABLE: 'credential storage is unavailable',
    IAM_ATOMIC_STORE_UNVERIFIED: 'credential storage atomicity is not trusted by this composition',
    IAM_CREDENTIALS_CLEAR_FAILED: 'credential storage could not be cleared',
    IAM_CALLBACK_UNAVAILABLE: 'IAM callback origin is unavailable',
    IAM_UNREACHABLE: 'IAM endpoint is unreachable',
    IAM_INVALID_GRANT: 'IAM authorization is no longer valid',
    IAM_REAUTH_REQUIRED: 'IAM sign-in is required again',
    IAM_STATE_MISMATCH: 'IAM callback state does not match this attempt',
    IAM_ATTEMPT_EXPIRED: 'IAM sign-in attempt expired',
    IAM_ID_TOKEN_INVALID: 'IAM ID token is invalid',
    IAM_ID_TOKEN_SIGNATURE: 'IAM ID token signature is invalid',
    IAM_ID_TOKEN_AUDIENCE: 'IAM ID token audience does not match',
    IAM_ID_TOKEN_ISSUER: 'IAM ID token issuer does not match',
    IAM_DISCOVERY_ISSUER_MISMATCH: 'IAM discovery issuer does not match configuration',
    IAM_GRANT_CONTEXT_MISMATCH: 'IAM grant belongs to a different client or resource',
    IAM_REVOCATION_FAILED: 'IAM local session ended but token revocation was not confirmed',
    IAM_ID_TOKEN_NONCE: 'IAM ID token nonce does not match',
    IAM_ID_TOKEN_EXPIRED: 'IAM ID token is expired',
    IAM_REFRESH_TOKEN_MISSING: 'IAM token response has no refresh token',
    IAM_REFRESH_SUBJECT_MISMATCH: 'IAM refresh response changed the subject',
  };
  return messages[code] ?? 'IAM operation failed';
}

/**
 * Host-side IAM session. Login is OIDC authorization-code + PKCE against
 * configured endpoints; every unverified capability stays fail closed.
 *
 * @param {Record<string, unknown>} config normalized config
 * @param {{
 *   exclusive?: { ok: boolean, reason?: string },
 *   credentials?: object,
 *   getOrigin?: () => string | undefined,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 * }} [options]
 */
export function createIamService(rawConfig, options = {}) {
  const checked = validateConfig(rawConfig);
  if ('issues' in checked) {
    throw new IamError('IAM_CONFIG_INVALID', safeMessage('IAM_CONFIG_INVALID'), { issues: checked.issues });
  }
  const config = checked.value;
  const configured = isConfigured(config).ok;
  let exclusive = options.exclusive ?? { ok: true };
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let store = null;
  let storeCredentials = null;
  let storeError = null;
  let gatewayStore = null;
  let gatewaySummary = null;
  let gatewayLoadedAt = 0;
  let gatewayLoading = null;
  // Bumped whenever the credentials provider changes, so an in-flight read from
  // the previous provider cannot repopulate the summary after revocation.
  let gatewayEpoch = 0;
  let lastBackgroundRefreshAt = 0;

  function ensureStore() {
    let credentials;
    try {
      credentials = typeof options.getCredentials === 'function'
        ? options.getCredentials()
        : options.credentials;
    } catch {
      credentials = undefined;
    }
    if (!credentials) {
      // The provider fiber was revoked: never keep reading gateway state (and
      // possibly resolving the secret) through the previous provider.
      store = null;
      gatewayStore = null;
      gatewaySummary = null;
      gatewayLoading = null;
      gatewayLoadedAt = 0;
      gatewayEpoch += 1;
      storeCredentials = null;
      storeError = new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      return null;
    }
    if (store && storeCredentials === credentials) return store;
    try {
      let targetStore;
      targetStore = createGrantStore(credentials, { verifyAtomicStore: (instance) => {
        try { assertAtomic(targetStore, instance); return true; } catch { return false; }
      } });
      store = targetStore;
      gatewayStore = createGatewayCredentialStore(credentials);
      gatewayLoading = null;
      gatewayEpoch += 1;
      storeCredentials = credentials;
      storeError = null;
      return store;
    } catch (error) {
      store = null;
      gatewayStore = null;
      storeCredentials = null;
      storeError = error;
      return null;
    }
  }

  let state = !exclusive.ok ? 'error' : (configured ? 'signed-out' : 'unconfigured');
  let error = exclusive.ok ? null : (exclusive.reason ?? 'exclusive-violation');
  let lastGrant = null;
  // A weak association prevents a discarded cached grant retaining its provider.
  const grantOwners = new WeakMap();
  let attempt = null;
  let disposed = false;
  let refreshPromise = null;
  let refreshPromiseStore = null;
  let refreshPromiseCredentials = null;
  let signInPromise = null;
  let signOutPromise = null;
  let signingOut = false;
  let sessionEpoch = 0;
  let authEpoch = 0;
  let observedPending = null;
  let metadataCache = null;
  let jwksCache = null;
  const listeners = new Set();
  const stopWaiters = new Set();

  function recheckExclusive() {
    if (typeof options.recheckExclusive !== 'function') return;
    const next = options.recheckExclusive();
    if (next?.ok === false) {
      observedPending = null;
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
    return createView(state, {
      configured,
      missing: isConfigured(config).missing,
      error,
      exclusive: exclusive.ok ? 'ok' : (exclusive.reason ?? 'exclusive-violation'),
      principal: summary.principal ?? null,
      accessExpiresAt: summary.accessExpiresAt ?? null,
      gatewayCredential: gatewaySummary,
      gatewayConsoleUrl: config.gatewayConsoleUrl || null,
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

  function clearAttempt() {
    if (attempt?.timer) clearTimeout(attempt.timer);
    attempt = null;
  }

  function atomicVerified(credentials) {
    try {
      if (!credentials || typeof options.verifyAtomicStore !== 'function') return false;
      const value = options.verifyAtomicStore(credentials);
      if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
      return value === true;
    } catch { return false; }
  }

  function assertAtomic(target, credentials) {
    if (ensureStore() !== target || storeCredentials !== credentials || !atomicVerified(credentials)) {
      throw new IamError('IAM_ATOMIC_STORE_UNVERIFIED', safeMessage('IAM_ATOMIC_STORE_UNVERIFIED'));
    }
  }

  function requireStore() {
    const current = ensureStore();
    if (current) return current;
    throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
  }

  function fail(code) {
    observedPending = null;
    clearAttempt();
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

  async function metadata() {
    const current = now();
    if (metadataCache && current - metadataCache.loadedAt < METADATA_TTL_MS) {
      return metadataCache.value;
    }
    const value = await loadMetadata(config, {
      fetchImpl,
      timeoutMs: config.httpTimeoutMs,
      allowInsecureHttp: config.allowInsecureHttp === true,
    });
    metadataCache = { value, loadedAt: current };
    return value;
  }

  async function jwks(uri) {
    const current = now();
    if (jwksCache && jwksCache.uri === uri && current - jwksCache.loadedAt < JWKS_TTL_MS) {
      return jwksCache.value;
    }
    const value = await fetchJson(uri, { fetchImpl, timeoutMs: config.httpTimeoutMs });
    jwksCache = { uri, value, loadedAt: current };
    return value;
  }

  /**
   * Verify an ID token, retrying once on a missing `kid`: the IdP may have
   * rotated keys after this process cached the JWKS document.
   */
  async function verifyWithJwks(token, { uri, issuer, clientId, nonce, accessToken }) {
    const options = {
      issuer,
      clientId,
      accessToken,
      skewSeconds: ID_TOKEN_CLOCK_SKEW_SECONDS,
      now: now(),
      ...(nonce === undefined ? {} : { nonce }),
    };
    try {
      return verifyIdToken(token, { ...options, jwks: await jwks(uri) });
    } catch (error) {
      if (error?.code !== 'IAM_JWKS_KEY_NOT_FOUND') throw error;
      jwksCache = null;
      return verifyIdToken(token, { ...options, jwks: await jwks(uri) });
    }
  }

  function assertGrantContext(grant) {
    if (!grant) return;
    const wrongClient = grant.clientId !== config.clientId;
    // V1 login carries no gateway audience; only compare when one is configured
    // so grants stored before the split keep working.
    const wrongResource = Boolean(config.gatewayResource) && grant.resource !== config.gatewayResource;
    const wrongIssuer = Boolean(config.issuer) && grant.issuer !== config.issuer;
    if (wrongClient || wrongResource || wrongIssuer) {
      throw new IamError('IAM_GRANT_CONTEXT_MISMATCH', safeMessage('IAM_GRANT_CONTEXT_MISMATCH'));
    }
  }

  function redirectUri() {
    if (config.redirectUri) {
      let parsed;
      try {
        parsed = new URL(config.redirectUri);
      } catch {
        throw new IamError('IAM_CONFIG_INVALID', 'redirectUri must be an absolute URL');
      }
      if (parsed.pathname !== config.redirectPath) {
        throw new IamError('IAM_CONFIG_INVALID', 'redirectUri path must equal redirectPath');
      }
      let live;
      try {
        live = options.getOrigin?.();
      } catch {
        live = undefined;
      }
      if (live && parsed.origin !== new URL(live).origin) {
        throw new IamError('IAM_CONFIG_INVALID', 'redirectUri origin must equal the live web server origin');
      }
      return parsed.href;
    }
    let origin;
    try {
      origin = options.getOrigin?.();
    } catch {
      origin = undefined;
    }
    if (!origin) {
      throw new IamError('IAM_CALLBACK_UNAVAILABLE', safeMessage('IAM_CALLBACK_UNAVAILABLE'));
    }
    try {
      return new URL(config.redirectPath, origin).href;
    } catch {
      throw new IamError('IAM_CALLBACK_UNAVAILABLE', safeMessage('IAM_CALLBACK_UNAVAILABLE'));
    }
  }

  function grantFromToken(previous, token, issuer, obtainedAt) {
    const refreshToken = token.refreshToken ?? previous?.refreshToken;
    if (!refreshToken) {
      throw new IamError('IAM_REFRESH_TOKEN_MISSING', safeMessage('IAM_REFRESH_TOKEN_MISSING'));
    }
    return {
      version: 1,
      issuer,
      subject: previous?.subject ?? null,
      clientId: config.clientId,
      refreshToken,
      scope: token.scope ?? previous?.scope ?? config.scopes.join(' '),
      ...(config.gatewayResource ? { resource: config.gatewayResource } : {}),
      obtainedAt: previous?.obtainedAt ?? obtainedAt,
      ...(previous && Object.hasOwn(previous, 'sessionInstanceId') ? { sessionInstanceId: previous.sessionInstanceId } : {}),
      accessToken: token.accessToken,
      accessExpiresAt: addSeconds(now(), token.expiresIn),
      ...(token.refreshExpiresIn ? { refreshExpiresAt: addSeconds(now(), token.refreshExpiresIn) } : previous?.refreshExpiresAt ? { refreshExpiresAt: previous.refreshExpiresAt } : {}),
      ...(token.idToken ? { idToken: token.idToken } : previous?.idToken ? { idToken: previous.idToken } : {}),
    };
  }

  async function buildGrant(token, claims, meta, obtainedAt) {
    if (!token.refreshToken) {
      throw new IamError('IAM_REFRESH_TOKEN_MISSING', safeMessage('IAM_REFRESH_TOKEN_MISSING'));
    }
    return {
      version: 1,
      issuer: meta.issuer,
      subject: claims.sub,
      sessionInstanceId: randomToken(32),
      clientId: config.clientId,
      refreshToken: token.refreshToken,
      scope: token.scope ?? config.scopes.join(' '),
      ...(config.gatewayResource ? { resource: config.gatewayResource } : {}),
      obtainedAt,
      accessToken: token.accessToken,
      accessExpiresAt: addSeconds(now(), token.expiresIn),
      ...(token.refreshExpiresIn ? { refreshExpiresAt: addSeconds(now(), token.refreshExpiresIn) } : {}),
      ...(config.logoutMode === 'rp' && token.idToken ? { idToken: token.idToken } : {}),
    };
  }

  async function syncFromStore() {
    if (disposed || signingOut) return view();
    if (!configured || !exclusive.ok) return view();
    // A user-triggered sign-in owns the state machine until its callback,
    // cancellation, or timeout; a background hydration must not clobber it.
    if (state === 'authenticating') return view();
    // Only an error created by this instance observing pending can recover.
    const observation = state === 'error' ? observedPending : null;
    if (state === 'error' && (!observation || error !== 'IAM_REAUTH_REQUIRED'
      || observation.authEpoch !== authEpoch || now() >= observation.deadline)) {
      observedPending = null;
      return view();
    }
    const targetStore = ensureStore();
    if (!targetStore || (observation && targetStore !== observation.store)) {
      observedPending = null;
      return view();
    }
    const syncEpoch = authEpoch;
    const isCurrent = () => !disposed && !signingOut && exclusive.ok && authEpoch === syncEpoch
      && store === targetStore && (observation ? state === 'error' && error === 'IAM_REAUTH_REQUIRED'
        && observedPending === observation && now() < observation.deadline
        : state !== 'authenticating' && state !== 'error');
    try {
      const record = await targetStore.read();
      recheckExclusive();
      if (!isCurrent()) return view();
      if (!record.ok) {
        observedPending = null;
        lastGrant = null;
        error = 'IAM_GRANT_INVALID';
        state = 'error';
        notify();
        return view();
      }
      if (!record.grant) {
        if (observation) {
          observedPending = null;
          return view();
        }
        const changed = lastGrant !== null || state !== 'signed-out';
        lastGrant = null;
        if (changed) {
          error = null;
          state = 'signed-out';
          notify();
        }
        return view();
      }
      assertGrantContext(record.grant);
      const marker = record.grant.refreshOperation;
      const identity = (({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId }) =>
        ({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId }))(record.grant);
      const refreshDigest = (grant, id) => createHmac('sha256', id).update(grant.refreshToken).digest('base64url');
      if (observation) {
        if (!marker || marker.version !== observation.version || marker.id !== observation.id
          || marker.base !== observation.base || !isDeepStrictEqual(identity, observation.identity)) {
          observedPending = null;
          return view();
        }
        const sameRefresh = refreshDigest(record.grant, marker.id) === observation.refreshDigest;
        if (marker.state === 'pending' && sameRefresh) return view();
        if (marker.state !== 'complete' || sameRefresh
          || isAccessExpired(record.grant, now()) || !isRefreshUsable(record.grant, now())) {
          observedPending = null;
          return view();
        }
      } else if (marker?.state === 'pending') {
        observedPending = { version: marker.version, id: marker.id, base: marker.base,
          identity, refreshDigest: refreshDigest(record.grant, marker.id), authEpoch, store: targetStore,
          deadline: now() + REFRESH_TIMEOUT_MS };
        lastGrant = null;
        state = 'error';
        error = 'IAM_REAUTH_REQUIRED';
        notify();
        return view();
      }
      const previousSubject = lastGrant?.subject ?? null;
      const previous = `${state}|${error}|${previousSubject}`;
      lastGrant = record.grant;
      grantOwners.set(record.grant, targetStore);
      // An adopted subject changes the displayed match, not the stored key.
      if (observation || (previousSubject !== null && record.grant.subject !== previousSubject)) {
        await loadGatewayCredential({ force: true });
        if (!isCurrent()) {
          if (lastGrant === record.grant) lastGrant = null;
          return view();
        }
      }
      if (observation) observedPending = null;
      // `expired` means the access token is no longer usable, not merely inside
      // the refresh skew: a token request renews the latter, and showing "expired"
      // while the token still works would send the user through a needless login.
      state = isAccessExpired(record.grant, now()) ? 'expired' : 'ready';
      error = null;
      // With a usable refresh token an expired session is recoverable; without
      // this, the interim client would only ever offer a full re-login.
      if (state === 'expired' && isRefreshUsable(record.grant, now())
        && now() - lastBackgroundRefreshAt >= AUTO_REFRESH_BACKOFF_MS) {
        lastBackgroundRefreshAt = now();
        void service.resolveToken().catch(() => {});
      }
      if (previous !== `${state}|${error}|${lastGrant.subject ?? ''}`) notify();
    } catch (cause) {
      if (!isCurrent()) return view();
      observedPending = null;
      lastGrant = null;
      error = cause?.code === 'IAM_GRANT_CONTEXT_MISMATCH' ? cause.code : 'IAM_CREDENTIALS_UNAVAILABLE';
      state = 'error';
      notify();
    }
    return view();
  }

  async function readGatewayCredential() {
    if (disposed) return null;
    // Rebind to the current credentials provider; a revoked fiber must not keep
    // serving gateway state (or a resolvable secret) from the previous one.
    ensureStore();
    if (!gatewayStore) return null;
    const record = await gatewayStore.read().catch(() => ({ ok: false, reason: 'unreadable' }));
    if (!record.ok) return { state: 'invalid' };
    const resolved = await gatewayStore.resolve().catch(() => undefined);
    const credential = record.credential ?? {};
    if (!resolved?.value) return { state: 'unconfigured' };
    // A keychain value without metadata is still unattributable. This status is
    // informational; it does not prevent another consumer resolving the ref.
    if (!record.credential) return { state: 'invalid', matchesAccount: false };
    const storage = await gatewayStore.describe().catch(() => null);
    const signedInSubject = lastGrant?.subject ?? null;
    const matchesAccount = Boolean(credential.ownerSubject && signedInSubject && credential.ownerSubject === signedInSubject);
    return {
      // Without a session the stored key is still "configured"; it only becomes
      // a mismatch once a different subject is known.
      state: !signedInSubject || matchesAccount ? 'configured' : 'owner-mismatch',
      ownerSubject: credential.ownerSubject ?? null,
      deviceLabel: credential.deviceLabel ?? null,
      enteredAt: credential.enteredAt ?? null,
      suggestedExpiry: credential.suggestedExpiry ?? null,
      // 'keychain' is the only source that keeps the value out of plaintext
      // files; the account page warns for the dev/pilot fallbacks.
      storage: storage?.configured ? (storage.source ?? null) : null,
      matchesAccount,
    };
  }

  async function loadGatewayCredential({ force = false } = {}) {
    // A hydrate that lost the race with dispose must not repopulate runtime state.
    if (disposed) return null;
    if (!force && gatewayLoadedAt > 0 && now() - gatewayLoadedAt < GATEWAY_RELOAD_MS) return gatewaySummary;
    if (gatewayLoading) return gatewayLoading;
    // Bind to the current provider before capturing the epoch, so this read is
    // not discarded by the store creation it is about to trigger.
    ensureStore();
    const epoch = gatewayEpoch;
    gatewayLoadedAt = now();
    gatewayLoading = readGatewayCredential()
      .then((summary) => {
        // dispose() or a credentials change may have happened while reading.
        gatewaySummary = disposed || epoch !== gatewayEpoch ? null : summary;
        return gatewaySummary;
      })
      .catch(() => {
        gatewaySummary = null;
        return null;
      })
      .finally(() => { gatewayLoading = null; });
    return gatewayLoading;
  }

  async function hydrate() {
    // Preserve any pre-existing legacy reference; its migration or deletion
    // requires a separate decision and does not make it safe to consume.
    await syncFromStore();
    await loadGatewayCredential({ force: true });
    return view();
  }

  const service = {
    getView() {
      return view();
    },

    hydrate,
    syncFromStore,
    loadGatewayCredential,

    /**
     * Store the UAG personal credential the user pasted. IAM only records it;
     * it never issues, refreshes, or probes the key (that belongs to the
     * gateway package once it exists).
     */
    async saveGatewayCredential({ key: value, deviceLabel } = {}) {
      assertExclusive();
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (!configured) {
        throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
          missing: isConfigured(config).missing,
        });
      }
      const targetStore = requireStore();
      if (!gatewayStore) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      let subject = lastGrant?.subject ?? null;
      if (!subject) {
        const record = await targetStore.read().catch(() => null);
        subject = record?.ok ? record.grant?.subject ?? null : null;
      }
      if (!subject) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'sign in before saving a gateway credential');
      }
      // Labels are display-only: drop control characters and bound the length so
      // a pasted newline cannot break the account page layout.
      const label = typeof deviceLabel === 'string'
        ? deviceLabel.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64)
        : '';
      const enteredAt = nowIso(now());
      const suggestedExpiry = addSeconds(now(), 90 * 24 * 60 * 60).slice(0, 10);
      await gatewayStore.save({
        value,
        ownerSubject: subject,
        deviceLabel: label,
        enteredAt,
        suggestedExpiry,
      });
      await loadGatewayCredential({ force: true });
      notify();
      return view();
    },

    async clearGatewayCredential() {
      assertExclusive();
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      requireStore();
      if (!gatewayStore) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      const cleared = await gatewayStore.clear();
      if (!cleared.ok) {
        throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
      }
      await loadGatewayCredential({ force: true });
      notify();
      return view();
    },

    /** Minimal principal for Host policy/audit; never tokens. */
    getPrincipal() {
      if (!lastGrant) return undefined;
      return { issuer: lastGrant.issuer, subject: lastGrant.subject };
    },

    async startSignIn() {
      assertExclusive();
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (!configured) {
        throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
          missing: isConfigured(config).missing,
        });
      }
      if (signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      const targetStore = ensureStore();
      const credentials = storeCredentials;
      if (attempt && (attempt.targetStore !== targetStore || attempt.credentials !== credentials)) {
        authEpoch += 1;
        clearAttempt();
        if (state === 'authenticating') {
          state = 'signed-out';
          error = null;
        }
      }
      if (!targetStore) throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      assertAtomic(targetStore, credentials);
      if (state === 'ready') return { view: view(), authorizationUrl: null };
      if (state === 'authenticating' && attempt) {
        return { view: view(), authorizationUrl: attempt.authorizationUrl };
      }
      if (signInPromise) return signInPromise;
      authEpoch += 1;
      observedPending = null;
      signInPromise = service._startSignInOnce(targetStore, credentials).finally(() => { signInPromise = null; });
      return signInPromise;
    },

    async _startSignInOnce(targetStore, credentials) {
      const startEpoch = authEpoch;
      if (state === 'unreachable') {
        throw new IamError('IAM_UNREACHABLE', safeMessage('IAM_UNREACHABLE'));
      }
      let meta;
      try {
        meta = await metadata();
      } catch (err) {
        const code = tokenErrorMessage(err);
        const mapped = code === 'IAM_HTTP_ERROR' || code === 'IAM_DISCOVERY_INVALID' ? 'IAM_UNREACHABLE' : code;
        throw new IamError(mapped, safeMessage(mapped));
      }
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (authEpoch !== startEpoch || signingOut) {
        throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      }
      assertAtomic(targetStore, credentials);
      const oauthState = randomToken(32);
      const nonce = randomToken(32);
      const pkce = createPkce();
      const callbackUri = redirectUri();
      const authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: meta.authorizationEndpoint,
        clientId: config.clientId,
        redirectUri: callbackUri,
        scopes: config.scopes,
        state: oauthState,
        nonce,
        codeChallenge: pkce.challenge,
        resource: config.gatewayResource,
      });
      if (attempt) clearAttempt();
      attempt = {
        state: oauthState,
        nonce,
        verifier: pkce.verifier,
        redirectUri: callbackUri,
        authorizationUrl,
        metadata: meta,
        targetStore,
        credentials,
        expiresAt: now() + config.attemptTimeoutSeconds * 1000,
      };
      const scheduledAttempt = attempt;
      attempt.timer = setTimeout(() => {
        if (attempt === scheduledAttempt) {
          scheduledAttempt.expired = true;
          clearAttempt();
          error = 'IAM_ATTEMPT_EXPIRED';
          if (state === 'authenticating') state = 'error';
          notify();
        }
      }, config.attemptTimeoutSeconds * 1000);
      attempt.timer.unref?.();
      publish('SIGN_IN');
      return { view: view(), authorizationUrl };
    },

    async handleCallback(rawUrl) {
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      assertExclusive();
      let callback;
      try {
        callback = new URL(rawUrl);
      } catch {
        throw new IamError('IAM_CALLBACK_INVALID', safeMessage('IAM_CALLBACK_INVALID'));
      }
      const receivedState = callback.searchParams.get('state');
      if (!attempt || !safeStateEqual(attempt.state, receivedState)) {
        throw new IamError('IAM_STATE_MISMATCH', safeMessage('IAM_STATE_MISMATCH'));
      }
      const expected = new URL(attempt.redirectUri);
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
        || callback.username || callback.password || callback.hash) {
        throw new IamError('IAM_CALLBACK_INVALID', safeMessage('IAM_CALLBACK_INVALID'));
      }
      if (attempt.processing) {
        throw new IamError('IAM_ATTEMPT_IN_PROGRESS', safeMessage('IAM_ATTEMPT_IN_PROGRESS'));
      }
      const issuers = callback.searchParams.getAll('iss');
      if (issuers.length === 1 && issuers[0] && issuers[0] !== attempt.metadata.issuer) {
        throw new IamError('IAM_CALLBACK_ISSUER', safeMessage('IAM_CALLBACK_ISSUER'));
      }
      if (now() > attempt.expiresAt) {
        clearAttempt();
        error = 'IAM_ATTEMPT_EXPIRED';
        if (state === 'authenticating') state = 'error';
        notify();
        throw new IamError('IAM_ATTEMPT_EXPIRED', safeMessage('IAM_ATTEMPT_EXPIRED'));
      }
      let parsed;
      try {
        parsed = parseCallbackUrl(rawUrl);
      } catch (error) {
        const code = tokenErrorMessage(error);
        if (!attempt || !safeStateEqual(attempt.state, receivedState)) {
          throw new IamError('IAM_STATE_MISMATCH', safeMessage('IAM_STATE_MISMATCH'));
        }
        if (code === 'IAM_AUTHORIZATION_ERROR') fail(code);
        throw new IamError(code, safeMessage(code));
      }
      const { code } = parsed;
      if (!attempt || !safeStateEqual(attempt.state, receivedState)) {
        throw new IamError('IAM_STATE_MISMATCH', safeMessage('IAM_STATE_MISMATCH'));
      }
      const current = attempt;
      assertAtomic(current.targetStore, current.credentials);
      if (parsed.iss !== undefined && parsed.iss !== current.metadata.issuer) {
        throw new IamError('IAM_CALLBACK_ISSUER', safeMessage('IAM_CALLBACK_ISSUER'));
      }
      // Claim the attempt synchronously before the first await. A replay must
      // never consume the same authorization code or interfere with its owner.
      current.processing = true;
      const attemptEpoch = authEpoch;
      const isCurrent = () => {
        if (attempt === current && authEpoch === attemptEpoch && state === 'authenticating'
          && now() > current.expiresAt) {
          current.expired = true;
          clearAttempt();
          error = 'IAM_ATTEMPT_EXPIRED';
          state = 'error';
          notify();
        }
        return attempt === current && authEpoch === attemptEpoch && state === 'authenticating';
      };
      const interrupted = () => current.expired
        ? new IamError('IAM_ATTEMPT_EXPIRED', safeMessage('IAM_ATTEMPT_EXPIRED'))
        : new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      let issuedToken;
      let intendedGrant;
      let intendedStore;
      let writeUnconfirmed = false;
      let guardRejection;
      try {
        const token = await exchangeCode({
          tokenEndpoint: current.metadata.tokenEndpoint,
          code,
          codeVerifier: current.verifier,
          redirectUri: current.redirectUri,
          clientId: config.clientId,
          resource: config.gatewayResource,
          fetchImpl,
          timeoutMs: config.httpTimeoutMs,
        });
        issuedToken = token;
        assertAtomic(current.targetStore, current.credentials);
        if (!token.idToken) {
          throw new IamError('IAM_ID_TOKEN_INVALID', safeMessage('IAM_ID_TOKEN_INVALID'));
        }
        const claims = await verifyWithJwks(token.idToken, {
          uri: current.metadata.jwksUri,
          issuer: current.metadata.issuer,
          clientId: config.clientId,
          nonce: current.nonce,
          accessToken: token.accessToken,
        });
        const grant = await buildGrant(token, claims, current.metadata, nowIso(now()));
        if (!isCurrent()) throw interrupted();
        assertExclusive();
        assertAtomic(current.targetStore, current.credentials);
        intendedStore = current.targetStore;
        intendedGrant = grant;
        writeUnconfirmed = true;
        const written = await intendedStore.write(grant, {
          guard: () => {
            assertAtomic(current.targetStore, current.credentials);
            if (!isCurrent()) {
              guardRejection = interrupted();
              throw guardRejection;
            }
            return true;
          },
        });
        if (!isDeepStrictEqual(written.record, { kind: 'grant', payload: grant })) {
          throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
        }
        writeUnconfirmed = false;
        assertAtomic(current.targetStore, current.credentials);
        if (!isCurrent()) throw interrupted();
        // Show any owner mismatch without changing the user's stored key.
        lastGrant = grant;
        grantOwners.set(grant, current.targetStore);
        await loadGatewayCredential({ force: true });
        assertAtomic(current.targetStore, current.credentials);
        if (!isCurrent()) throw interrupted();
        clearAttempt();
        publish('SIGN_IN_SUCCESS');
        return view();
      } catch (cause) {
        const guardPreventedWrite = guardRejection && cause === guardRejection;
        let cleanupUnknown = Boolean(writeUnconfirmed && !guardPreventedWrite);
        if (intendedStore && intendedGrant && !guardPreventedWrite) {
          const cleanup = await intendedStore.discardCallbackGrant(intendedGrant).catch(() => ({ ok: false }));
          if (!cleanup.ok) cleanupUnknown = true;
        }
        if (lastGrant === intendedGrant) lastGrant = null;
        if (issuedToken?.refreshToken && current.metadata.revocationEndpoint) {
          await revokeToken({
            revocationEndpoint: current.metadata.revocationEndpoint,
            token: issuedToken.refreshToken,
            tokenTypeHint: 'refresh_token',
            clientId: config.clientId,
            fetchImpl,
            timeoutMs: config.httpTimeoutMs,
          }).catch(() => {});
        }
        const stillCurrent = isCurrent();
        if (cleanupUnknown) {
          if (!disposed && !signingOut && (stillCurrent || (!attempt && (state === 'signed-out' || state === 'error')))) {
            if (stillCurrent) clearAttempt();
            state = 'error';
            error = 'IAM_CREDENTIALS_CLEAR_FAILED';
            notify();
          }
          throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
        }
        if (!stillCurrent || cause?.code === 'IAM_ATTEMPT_CANCELLED' || cause?.code === 'IAM_ATTEMPT_EXPIRED') {
          throw cause?.code === 'IAM_ATTEMPT_EXPIRED' ? cause : interrupted();
        }
        const failureCode = tokenErrorMessage(cause);
        fail(failureCode);
        throw new IamError(failureCode, safeMessage(failureCode));
      }
    },

    async cancelSignIn() {
      if (disposed) return view();
      authEpoch += 1;
      observedPending = null;
      if (state !== 'authenticating') return view();
      clearAttempt();
      lastGrant = null;
      gatewayEpoch += 1;
      gatewaySummary = null;
      gatewayLoadedAt = 0;
      return publish('CANCEL');
    },

    async signOut() {
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (signOutPromise) return signOutPromise;
      signingOut = true;
      authEpoch += 1;
      observedPending = null;
      clearAttempt();
      // Register before running any work: provider checks and notifications can
      // synchronously reenter signOut. All callers observe the final outcome.
      signOutPromise = Promise.resolve().then(() => service._signOutOnce()).finally(() => {
        signingOut = false;
        signOutPromise = null;
      });
      return signOutPromise;
    },

    async _signOutOnce() {
      const checkDisposed = () => {
        if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      };
      checkDisposed();
      if (refreshPromise) await refreshPromise.catch(() => {});
      checkDisposed();
      let grant = null;
      const targetStore = ensureStore();
      const targetCredentials = storeCredentials;
      checkDisposed();
      const unknownSignOut = () => {
        checkDisposed();
        lastGrant = null;
        error = 'IAM_CREDENTIALS_CLEAR_FAILED';
        state = 'error';
        notify();
        return { view: view(), logoutUrl: null, revocation: 'unknown' };
      };
      try { assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      if (targetStore) {
        const record = await targetStore.read().catch(() => ({ ok: false, grant: null }));
        if (!record.ok) return unknownSignOut();
        try {
          // Do not let a provider mutate nested fields of the captured snapshot.
          grant = structuredClone(record.grant);
          assertGrantContext(grant);
        } catch { return unknownSignOut(); }
      }
      checkDisposed();
      try { assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      checkDisposed();
      lastGrant = null;
      let revocation = 'skipped';
      let revocationError = null;
      let meta = metadataCache?.value;
      let revocationEndpoint = meta?.revocationEndpoint ?? config.revocationEndpoint;
      if (grant && !revocationEndpoint && config.discoveryUrl) {
        try {
          meta = await metadata();
          revocationEndpoint = meta.revocationEndpoint ?? config.revocationEndpoint;
        } catch {
          revocationEndpoint = undefined;
        }
      }
      checkDisposed();
      const revokeCurrent = async (current) => {
        checkDisposed();
        assertAtomic(targetStore, targetCredentials);
        checkDisposed();
        grant = current;
        if (revocationEndpoint && current?.refreshToken) {
          try {
            await revokeToken({
              revocationEndpoint,
              token: current.refreshToken,
              tokenTypeHint: 'refresh_token',
              clientId: config.clientId,
              fetchImpl,
              timeoutMs: Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS),
            });
            revocation = 'ok';
          } catch (cause) {
            revocation = 'failed';
            revocationError = tokenErrorMessage(cause);
          }
        }
      };
      try { assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      checkDisposed();
      const cleared = targetStore
        ? await targetStore.signOutSnapshot(grant, async (current) => {
          await revokeCurrent(current);
          checkDisposed();
          assertAtomic(targetStore, targetCredentials);
          checkDisposed();
        })
        : { ok: false };
      checkDisposed();
      try { assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      if (!cleared.ok || !['cleared', 'absent'].includes(cleared.decision)) return unknownSignOut();
      checkDisposed();
      // Sign-out keeps the gateway credential, but the summary must stop
      // claiming it matches the (now absent) session.
      await loadGatewayCredential({ force: true });
      checkDisposed();
      try { assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      checkDisposed();
      let logoutUrl = null;
      if (config.logoutMode === 'rp' && grant?.idToken) {
        try {
          const meta = metadataCache?.value ?? await metadata();
          const endSessionEndpoint = meta.endSessionEndpoint ?? config.endSessionEndpoint;
          if (endSessionEndpoint) {
            const url = new URL(endSessionEndpoint);
            url.searchParams.set('client_id', config.clientId);
            if (grant?.idToken) url.searchParams.set('id_token_hint', grant.idToken);
            if (config.postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', config.postLogoutRedirectUri);
            logoutUrl = url.href;
          }
        } catch {
          logoutUrl = null;
        }
      }
      checkDisposed();
      try { assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      checkDisposed();
      const nextError = revocation === 'failed' ? 'IAM_REVOCATION_FAILED' : null;
      if (state !== 'unconfigured' && state !== 'signed-out') {
        publish('SIGN_OUT', nextError);
      } else {
        error = nextError;
        notify();
      }
      return { view: view(), logoutUrl, revocation, revocationError };
    },

    async resolveToken() {
      assertExclusive();
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (signingOut || state === 'authenticating') {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
      }
      const useSharedRefresh = async (checkBefore = true) => {
        const shared = refreshPromise;
        const sharedStore = refreshPromiseStore;
        const sharedCredentials = refreshPromiseCredentials;
        const sharedSessionEpoch = sessionEpoch;
        const sharedAuthEpoch = authEpoch;
        const checkLifecycle = () => {
          if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
          if (signingOut || state === 'authenticating' || sessionEpoch !== sharedSessionEpoch || authEpoch !== sharedAuthEpoch) {
            throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
          }
        };
        const checkProvider = () => {
          checkLifecycle();
          assertExclusive();
          checkLifecycle();
          const current = ensureStore();
          checkLifecycle();
          if (current !== sharedStore || storeCredentials !== sharedCredentials) {
            // Do not clear a newer provider's independently published session.
            if (lastGrant && grantOwners.get(lastGrant) === sharedStore) {
              lastGrant = null;
              if (state === 'ready' || state === 'expired' || state === 'unreachable') {
                state = 'error';
                error = 'IAM_CREDENTIALS_UNAVAILABLE';
                notify();
              }
            }
            throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
          }
        };
        if (checkBefore) checkProvider();
        const token = await shared;
        checkProvider();
        return token;
      };
      if (refreshPromise) return useSharedRefresh();
      const epoch = sessionEpoch;
      const auth = authEpoch;
      const targetStore = requireStore();
      const targetCredentials = storeCredentials;
      const grantAtStart = lastGrant;
      let refreshing = false;
      let operationGrant = null;
      const alive = () => !disposed && !signingOut && epoch === sessionEpoch
        && auth === authEpoch && state !== 'authenticating';
      const checkAlive = () => {
        if (!alive()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
        assertExclusive();
        if (refreshing) assertAtomic(targetStore, targetCredentials);
      };
      const rejectSession = (code = 'IAM_REAUTH_REQUIRED') => {
        // A late failure belongs to its original provider, not a newer session.
        const current = ensureStore();
        if (alive() && current === targetStore && storeCredentials === targetCredentials
          && (!lastGrant || lastGrant === grantAtStart
            || (operationGrant && sameGrantIgnoringRefreshMarker(lastGrant, operationGrant)))) {
          observedPending = null;
          lastGrant = null;
          state = 'error';
          error = code;
          notify();
        }
        throw new IamError(code, safeMessage(code));
      };
      const useGrant = (grant) => {
        checkAlive();
        // A read from a revoked/replaced provider must not authorize a token.
        // This identity check does not claim the provider has atomic storage.
        if (ensureStore() !== targetStore || storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
        }
        checkAlive();
        assertGrantContext(grant);
        if (!grant?.accessToken || grant.refreshOperation?.state === 'pending' || isAccessExpired(grant, now())) return rejectSession();
        observedPending = null;
        lastGrant = grant;
        grantOwners.set(grant, targetStore);
        lastBackgroundRefreshAt = 0;
        state = 'ready';
        error = null;
        notify();
        return grant.accessToken;
      };
      // Do not make signOut wait for an unrelated, possibly stalled initial read.
      let record;
      try {
        record = await targetStore.read();
      } catch {
        if (!alive()) throw new IamError(disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
        return rejectSession('IAM_CREDENTIALS_UNAVAILABLE');
      }
      if (!alive()) throw new IamError(disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
      const currentStore = ensureStore();
      if (!alive()) throw new IamError(disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
      if (currentStore !== targetStore || storeCredentials !== targetCredentials) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      if (refreshPromise) return useSharedRefresh();
      refreshPromiseStore = targetStore;
      refreshPromiseCredentials = targetCredentials;
      refreshPromise = (async () => {
        try {
          checkAlive();
          if (!record.ok) return rejectSession('IAM_INVALID_GRANT');
          if (!record.grant) return rejectSession('IAM_NOT_SIGNED_IN');
          operationGrant = record.grant;
          assertGrantContext(record.grant);
          const initial = record.grant;
          if (initial.refreshOperation?.state !== 'pending' && !shouldRefresh(initial, now(), config.refreshSkewSeconds)) {
            return useGrant(initial);
          }
          if (!isRefreshUsable(initial, now())) return rejectSession();
          refreshing = true;
          checkAlive();

          // Wait only for the observed operation; a timeout is never a lease or
          // permission to resend. Polling never holds the provider lock.
          const waitFor = async (pending) => {
            // A pending rotation may already have consumed the refresh token.
            // Remove only the view belonging to this operation while awaiting it.
            checkAlive();
            if ((!lastGrant || lastGrant === grantAtStart || sameGrantIgnoringRefreshMarker(lastGrant, pending))
              && (state !== 'error' || error === 'IAM_REAUTH_REQUIRED')) {
              lastGrant = null;
              observedPending = null;
              state = 'error';
              error = 'IAM_REAUTH_REQUIRED';
              notify();
            }
            const operation = pending.refreshOperation;
            const identity = (({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId }) =>
              ({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId }))(pending);
            const originalRefresh = pending.refreshToken;
            const deadline = performance.now() + REFRESH_TIMEOUT_MS;
            const remaining = () => deadline - performance.now();
            while (remaining() > 0) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
              checkAlive();
              const budget = remaining();
              if (budget <= 0) return rejectSession();
              // Racing a read bounds our wait, not the underlying I/O. Promise.race
              // observes late rejection, and only this continuation can update view.
              let timer;
              const timeout = Symbol('read timeout');
              let latest;
              try {
                latest = await Promise.race([
                  targetStore.read(),
                  new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), budget); }),
                ]);
              } finally {
                clearTimeout(timer);
              }
              checkAlive();
              if (latest === timeout || remaining() <= 0 || !latest.ok || !latest.grant) return rejectSession();
              assertGrantContext(latest.grant);
              const marker = latest.grant.refreshOperation;
              const latestIdentity = (({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId }) =>
                ({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId }))(latest.grant);
              if (!marker || marker.version !== operation.version || marker.id !== operation.id || marker.base !== operation.base
                || !isDeepStrictEqual(identity, latestIdentity)) return rejectSession();
              if (marker.state === 'pending' && latest.grant.refreshToken === originalRefresh) continue;
              if (marker.state !== 'complete' || latest.grant.refreshToken === originalRefresh
                || isAccessExpired(latest.grant, now()) || remaining() <= 0) return rejectSession();
              checkAlive();
              if (remaining() <= 0) return rejectSession();
              return useGrant(latest.grant);
            }
            return rejectSession();
          };
          if (initial.refreshOperation?.state === 'pending') return await waitFor(initial);

          // Preload metadata before claiming, never while a record lock is held.
          const meta = metadataCache?.value ?? await metadata();
          checkAlive();
          const keys = await jwks(meta.jwksUri);
          checkAlive();
          const operationId = randomToken(32);
          const operation = { version: 1, state: 'pending', id: operationId, base: refreshBaseId(initial, operationId) };
          let claimed = false;
          let claimedGrant = null;
          const claim = await targetStore.mutate((current) => {
            checkAlive();
            if (!current) return undefined;
            assertGrantContext(current);
            if (current.refreshOperation?.state === 'pending' || !isDeepStrictEqual(current, initial)) return undefined;
            if (!shouldRefresh(current, now(), config.refreshSkewSeconds) || !isRefreshUsable(current, now())) return undefined;
            claimed = true;
            claimedGrant = current;
            return { ...current, refreshOperation: operation };
          });
          checkAlive();
          const claimedRecord = claim.record?.kind === 'grant' ? claim.record.payload : null;
          if (!claimed) {
            const latest = await targetStore.read();
            if (!latest.ok || !latest.grant) return rejectSession();
            if (latest.grant.refreshOperation?.state === 'pending') {
              const { refreshOperation: ignoredLatest, ...latestBase } = latest.grant;
              const { refreshOperation: ignoredInitial, ...initialBase } = initial;
              const marker = latest.grant.refreshOperation;
              if (!isDeepStrictEqual(latestBase, initialBase)
                || marker.base !== refreshBaseId(initial, marker.id)) return rejectSession();
              return await waitFor(latest.grant);
            }
            const marker = latest.grant.refreshOperation;
            const identity = ({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId }) =>
              ({ issuer, clientId, resource, subject, obtainedAt, sessionInstanceId });
            if (marker?.state === 'complete' && marker.base === refreshBaseId(initial, marker.id)
              && isDeepStrictEqual(identity(initial), identity(latest.grant))
              && latest.grant.refreshToken !== initial.refreshToken
              && isRefreshUsable(latest.grant, now())) {
              return useGrant(latest.grant);
            }
            // A new login without our original record binding is not our result.
            return rejectSession();
          }
          // A resolved provider call and its returned record are both required;
          // an exception or ambiguous result can never authorize the POST.
          if (!isDeepStrictEqual(claimedRecord, { ...claimedGrant, refreshOperation: operation })) return rejectSession();
          const token = await refreshTokens({
            tokenEndpoint: meta.tokenEndpoint,
            refreshToken: claimedGrant.refreshToken,
            clientId: config.clientId,
            resource: config.gatewayResource,
            fetchImpl,
            timeoutMs: Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS),
          });
          checkAlive();
          // Rotation semantics are not yet confirmed by the IdP. Never make an
          // already-sent refresh token eligible for another request by assuming
          // a missing or identical token is reusable.
          if (!token.refreshToken || token.refreshToken === claimedGrant.refreshToken) return rejectSession();
          let claims = null;
          if (token.idToken) {
            const verifyOptions = { issuer: meta.issuer, clientId: config.clientId,
              accessToken: token.accessToken, skewSeconds: ID_TOKEN_CLOCK_SKEW_SECONDS, now: now() };
            try {
              claims = verifyIdToken(token.idToken, { ...verifyOptions, jwks: keys });
            } catch (cause) {
              if (cause?.code !== 'IAM_JWKS_KEY_NOT_FOUND') throw cause;
              claims = await verifyWithJwks(token.idToken, { uri: meta.jwksUri, ...verifyOptions });
            }
          }
          if (claims && claims.sub !== claimedGrant.subject) {
            throw new IamError('IAM_REFRESH_SUBJECT_MISMATCH', safeMessage('IAM_REFRESH_SUBJECT_MISMATCH'));
          }
          const next = grantFromToken(claimedGrant, token, meta.issuer, nowIso(now()));
          if (claims) next.subject = claims.sub;
          next.refreshOperation = { ...operation, state: 'complete' };
          checkAlive();
          let committed = false;
          const result = await targetStore.mutate((current) => {
            checkAlive();
            if (!isDeepStrictEqual(current, { ...claimedGrant, refreshOperation: operation })) return undefined;
            committed = true;
            return next;
          });
          checkAlive();
          if (!committed || result.record?.kind !== 'grant'
            || !isDeepStrictEqual(result.record.payload, next)) return rejectSession();
          return useGrant(next);
        } catch (cause) {
          if (!alive()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
          if (['IAM_GRANT_CONTEXT_MISMATCH', 'IAM_NOT_SIGNED_IN', 'IAM_INVALID_GRANT', 'IAM_ATOMIC_STORE_UNVERIFIED', 'IAM_CREDENTIALS_UNAVAILABLE'].includes(cause?.code)) {
            return rejectSession(cause.code);
          }
          // Once a request might have been sent, pending remains authoritative;
          // do not erase it or fall back to an old access token.
          return rejectSession();
        }
      })().finally(() => {
        refreshPromise = null;
        refreshPromiseStore = null;
        refreshPromiseCredentials = null;
      });
      return useSharedRefresh(false);
    },

    async *watch(signal) {
      const queue = [];
      let waiter = null;
      const stop = () => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(null);
        }
      };
      const listener = (value) => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(value);
        } else {
          queue.push(value);
        }
      };
      const onAbort = () => stop();
      listeners.add(listener);
      stopWaiters.add(stop);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        yield view();
        for (;;) {
          if (signal?.aborted) return;
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          const value = await new Promise((resolve) => {
            waiter = resolve;
            if (signal?.aborted) {
              waiter = null;
              resolve(null);
            }
          });
          if (value === null || signal?.aborted) return;
          yield value;
        }
      } finally {
        stop();
        listeners.delete(listener);
        stopWaiters.delete(stop);
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      sessionEpoch += 1;
      authEpoch += 1;
      observedPending = null;
      clearAttempt();
      // Stop subscribers before any await so unload cannot leave a watch()
      // caller parked forever. dispose() is lifecycle cleanup, not logout:
      // persisted credentials are cleared only by an explicit signOut() or by
      // the enterprise uninstall flow.
      listeners.clear();
      for (const stop of [...stopWaiters]) stop();
      stopWaiters.clear();
      lastGrant = null;
      gatewaySummary = null;
      state = 'signed-out';
      error = null;
      // Lifecycle cleanup only: the grant and the user's gateway credential
      // stay stored, so unload cannot silently discard them.
    },
  };

  return service;
}