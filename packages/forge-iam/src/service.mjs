import { isConfigured, validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';
import { createGrantStore, StoreError } from './store.mjs';
import { isRefreshUsable, shouldRefresh, summarizeGrant } from './record.mjs';
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

function isMirrorSessionLost(error) {
  return error instanceof StoreError && error.code === 'IAM_REAUTH_REQUIRED';
}

function safeMessage(code) {
  const messages = {
    IAM_UNCONFIGURED: 'IAM configuration is incomplete',
    IAM_CREDENTIALS_UNAVAILABLE: 'credential storage is unavailable',
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
      store = null;
      storeCredentials = null;
      storeError = new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      return null;
    }
    if (store && storeCredentials === credentials) return store;
    try {
      store = createGrantStore(credentials);
      storeCredentials = credentials;
      storeError = null;
      return store;
    } catch (error) {
      store = null;
      storeCredentials = null;
      storeError = error;
      return null;
    }
  }

  let state = !exclusive.ok ? 'error' : (configured ? 'signed-out' : 'unconfigured');
  let error = exclusive.ok ? null : (exclusive.reason ?? 'exclusive-violation');
  let lastGrant = null;
  let attempt = null;
  let disposed = false;
  let refreshPromise = null;
  let signInPromise = null;
  let signingOut = false;
  let sessionEpoch = 0;
  let authEpoch = 0;
  let metadataCache = null;
  let jwksCache = null;
  const listeners = new Set();
  const stopWaiters = new Set();

  function recheckExclusive() {
    if (typeof options.recheckExclusive !== 'function') return;
    const next = options.recheckExclusive();
    if (next?.ok === false) {
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
    });
  }

  function notify() {
    const snapshot = view();
    for (const listener of listeners) listener(snapshot);
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

  function requireStore() {
    const current = ensureStore();
    if (current) return current;
    throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
  }

  function fail(code) {
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

  function assertGrantContext(grant) {
    if (!grant) return;
    const wrongClient = grant.clientId !== config.clientId;
    const wrongResource = grant.resource !== config.gatewayResource;
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
      resource: config.gatewayResource,
      obtainedAt: previous?.obtainedAt ?? obtainedAt,
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
      clientId: config.clientId,
      refreshToken: token.refreshToken,
      scope: token.scope ?? config.scopes.join(' '),
      resource: config.gatewayResource,
      obtainedAt,
      accessToken: token.accessToken,
      accessExpiresAt: addSeconds(now(), token.expiresIn),
      ...(token.refreshExpiresIn ? { refreshExpiresAt: addSeconds(now(), token.refreshExpiresIn) } : {}),
      ...(config.logoutMode === 'rp' && token.idToken ? { idToken: token.idToken } : {}),
    };
  }

  async function syncFromStore({ mirror = false } = {}) {
    if (disposed || signingOut) return view();
    if (!configured || !exclusive.ok) return view();
    // A user-triggered sign-in owns the state machine until its callback,
    // cancellation, or timeout; a background hydration must not clobber it.
    if (state === 'authenticating') return view();
    // An explicit error (for example an expired attempt) must remain visible
    // until the user retries or signs out; a background poll must not erase it.
    if (state === 'error') return view();
    const targetStore = ensureStore();
    if (!targetStore) return view();
    const syncEpoch = authEpoch;
    const isCurrent = () => !disposed && !signingOut && authEpoch === syncEpoch
      && state !== 'authenticating' && state !== 'error';
    try {
      const record = await targetStore.read();
      if (!isCurrent()) return view();
      if (!record.ok) {
        lastGrant = null;
        error = 'IAM_GRANT_INVALID';
        state = 'error';
        notify();
        return view();
      }
      if (!record.grant) {
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
      const previous = `${state}|${error}|${lastGrant?.subject ?? ''}`;
      lastGrant = record.grant;
      const needsRefresh = shouldRefresh(record.grant, now(), config.refreshSkewSeconds);
      state = needsRefresh ? 'expired' : 'ready';
      error = null;
      if (mirror) {
        assertExclusive();
        if (!needsRefresh && lastGrant.accessToken) await targetStore.mirror(lastGrant.accessToken);
        else await targetStore.unsetMirror();
        if (!isCurrent()) {
          if (disposed) await targetStore.unsetMirror().catch(() => {});
          return view();
        }
      }
      if (previous !== `${state}|${error}|${lastGrant.subject ?? ''}`) notify();
    } catch (cause) {
      if (!isCurrent()) {
        if (disposed) await targetStore.unsetMirror().catch(() => {});
        return view();
      }
      lastGrant = null;
      error = isMirrorSessionLost(cause) ? 'IAM_REAUTH_REQUIRED'
        : cause?.code === 'IAM_GRANT_CONTEXT_MISMATCH' ? cause.code : 'IAM_CREDENTIALS_UNAVAILABLE';
      state = isMirrorSessionLost(cause) ? 'signed-out' : 'error';
      notify();
    }
    return view();
  }

  async function hydrate() {
    return syncFromStore({ mirror: true });
  }

  const service = {
    getView() {
      return view();
    },

    hydrate,
    syncFromStore,

    async startSignIn() {
      assertExclusive();
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (!configured) {
        throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
          missing: isConfigured(config).missing,
        });
      }
      requireStore();
      if (state === 'ready') return { view: view(), authorizationUrl: null };
      if (state === 'authenticating' && attempt) {
        return { view: view(), authorizationUrl: attempt.authorizationUrl };
      }
      if (signInPromise) return signInPromise;
      authEpoch += 1;
      signInPromise = service._startSignInOnce().finally(() => { signInPromise = null; });
      return signInPromise;
    },

    async _startSignInOnce() {
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
        expiresAt: now() + config.attemptTimeoutSeconds * 1000,
      };
      attempt.timer = setTimeout(() => {
        if (attempt) {
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
      let receivedState = null;
      try {
        receivedState = new URL(rawUrl, 'http://127.0.0.1').searchParams.get('state');
      } catch {
        receivedState = null;
      }
      let parsed;
      try {
        parsed = parseCallbackUrl(rawUrl);
      } catch (error) {
        const code = tokenErrorMessage(error);
        if (!attempt || !safeStateEqual(attempt.state, receivedState)) {
          throw new IamError('IAM_STATE_MISMATCH', safeMessage('IAM_STATE_MISMATCH'));
        }
        fail(code);
        throw new IamError(code, safeMessage(code));
      }
      const { code } = parsed;
      if (!attempt || !safeStateEqual(attempt.state, receivedState)) {
        throw new IamError('IAM_STATE_MISMATCH', safeMessage('IAM_STATE_MISMATCH'));
      }
      if (now() > attempt.expiresAt) {
        clearAttempt();
        error = 'IAM_ATTEMPT_EXPIRED';
        if (state === 'authenticating') state = 'error';
        notify();
        throw new IamError('IAM_ATTEMPT_EXPIRED', safeMessage('IAM_ATTEMPT_EXPIRED'));
      }
      const current = attempt;
      const attemptEpoch = authEpoch;
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
        if (!token.idToken) {
          throw new IamError('IAM_ID_TOKEN_INVALID', safeMessage('IAM_ID_TOKEN_INVALID'));
        }
        const keys = await jwks(current.metadata.jwksUri);
        const claims = verifyIdToken(token.idToken, {
          jwks: keys,
          issuer: current.metadata.issuer,
          clientId: config.clientId,
          nonce: current.nonce,
          skewSeconds: ID_TOKEN_CLOCK_SKEW_SECONDS,
          now: now(),
        });
        const grant = await buildGrant(token, claims, current.metadata, nowIso(now()));
        if (attempt !== current || authEpoch !== attemptEpoch || state !== 'authenticating') {
          if (token.refreshToken && current.metadata.revocationEndpoint) {
            await revokeToken({
              revocationEndpoint: current.metadata.revocationEndpoint,
              token: token.refreshToken,
              tokenTypeHint: 'refresh_token',
              clientId: config.clientId,
              fetchImpl,
              timeoutMs: config.httpTimeoutMs,
            }).catch(() => {});
          }
          throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
        }
        assertExclusive();
        const targetStore = requireStore();
        try {
          await targetStore.write(grant);
          await targetStore.mirror(token.accessToken);
          if (attempt !== current || authEpoch !== attemptEpoch || state !== 'authenticating') {
            await targetStore.clear().catch(() => {});
            throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
          }
        } catch (error) {
          // A failed mirror ownership check means the record may now belong
          // to a newer session. Do not delete that session during rollback.
          if (!isMirrorSessionLost(error)) await targetStore.clear().catch(() => {});
          throw error;
        }
        lastGrant = grant;
        clearAttempt();
        publish('SIGN_IN_SUCCESS');
        return view();
      } catch (error) {
        if (error?.code === 'IAM_ATTEMPT_CANCELLED') throw error;
        if (disposed || attempt !== current || authEpoch !== attemptEpoch) {
          throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
        }
        const code = tokenErrorMessage(error);
        fail(code);
        throw new IamError(code, safeMessage(code));
      }
    },

    async cancelSignIn() {
      if (disposed) return view();
      authEpoch += 1;
      if (state !== 'authenticating') return view();
      clearAttempt();
      return publish('CANCEL');
    },

    async signOut() {
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (signingOut) return { view: view(), logoutUrl: null, revocation: 'skipped' };
      signingOut = true;
      authEpoch += 1;
      try {
        return await service._signOutOnce();
      } finally {
        signingOut = false;
      }
    },

    async _signOutOnce() {
      clearAttempt();
      if (refreshPromise) await refreshPromise.catch(() => {});
      let grant = lastGrant;
      const targetStore = ensureStore();
      if (targetStore) {
        const record = await targetStore.read().catch(() => ({ ok: false, grant: null }));
        if (record?.grant) grant = record.grant;
      }
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
      const revokeCurrent = async (current) => {
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
      if (targetStore) {
        try {
          // Discovery stays outside the record lock. A bounded revocation reads
          // the latest rotation under that lock; deletion/ref cleanup is later.
          await targetStore.mutate(async (current) => {
            await revokeCurrent(current);
            return undefined;
          });
        } catch (cause) {
          revocation = 'failed';
          revocationError = tokenErrorMessage(cause);
        }
      } else {
        await revokeCurrent(grant);
      }
      const cleared = targetStore
        ? await targetStore.clear().catch(() => ({ ok: false }))
        : { ok: false };
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
      if (!cleared.ok) {
        error = 'IAM_CREDENTIALS_CLEAR_FAILED';
        state = 'error';
        notify();
        return { view: view(), logoutUrl: null, revocation, revocationError };
      }
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
      if (signingOut) throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
      const resolveEpoch = authEpoch;
      const targetStore = requireStore();
      let record = await targetStore.read();
      if (disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (signingOut || authEpoch !== resolveEpoch) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
      }
      if (!record.ok) {
        throw new IamError('IAM_INVALID_GRANT', safeMessage('IAM_INVALID_GRANT'));
      }
      if (!record.grant) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
      }
      assertGrantContext(record.grant);
      if (!shouldRefresh(record.grant, now(), config.refreshSkewSeconds)) {
        lastGrant = record.grant;
        if (state !== 'ready') {
          state = 'ready';
          notify();
        }
        return record.grant.accessToken;
      }
      if (!isRefreshUsable(record.grant, now())) {
        const cleared = await targetStore.clear().catch(() => ({ ok: false }));
        lastGrant = null;
        if (!cleared.ok) {
          error = 'IAM_CREDENTIALS_CLEAR_FAILED';
          state = 'error';
          notify();
          throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
        }
        if (state === 'ready' || state === 'expired') publish('SIGN_OUT');
        throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
      }
      if (refreshPromise) return refreshPromise;
      const epoch = sessionEpoch;
      refreshPromise = (async () => {
        let attemptedRefreshToken = null;
        let rotated = false;
        try {
          // Discovery and JWKS are resolved before entering the provider lock;
          // only the 5s-bounded token exchange runs inside it.
          const meta = metadataCache?.value ?? await metadata();
          const keys = await jwks(meta.jwksUri);
          const result = await targetStore.mutate(async (current) => {
            if (!current) return undefined;
            assertGrantContext(current);
            if (!shouldRefresh(current, now(), config.refreshSkewSeconds)) return undefined;
            attemptedRefreshToken = current.refreshToken;
            const token = await refreshTokens({
              tokenEndpoint: meta.tokenEndpoint,
              refreshToken: current.refreshToken,
              clientId: config.clientId,
              resource: config.gatewayResource,
              fetchImpl,
              timeoutMs: Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS),
            });
            rotated = true;
            let claims = null;
            if (token.idToken) {
              claims = verifyIdToken(token.idToken, {
                jwks: keys,
                issuer: meta.issuer,
                clientId: config.clientId,
                skewSeconds: ID_TOKEN_CLOCK_SKEW_SECONDS,
                now: now(),
              });
            }
            if (claims && current.subject && claims.sub !== current.subject) {
              throw new IamError('IAM_REFRESH_SUBJECT_MISMATCH', safeMessage('IAM_REFRESH_SUBJECT_MISMATCH'));
            }
            const grant = grantFromToken(current, token, meta.issuer, nowIso(now()));
            if (claims) grant.subject = claims.sub;
            assertExclusive();
            return grant;
          });
          let latest = result.record?.kind === 'grant' ? result.record.payload : null;
          if (!latest) {
            // Another process may have refreshed while this one waited on the
            // same record lock; use its result rather than failing the request.
            const reread = await targetStore.read();
            latest = reread.ok ? reread.grant : null;
          }
          if (!latest) {
            throw new IamError('IAM_INVALID_GRANT', safeMessage('IAM_INVALID_GRANT'));
          }
          if (epoch !== sessionEpoch) {
            throw new IamError('IAM_DISPOSED', 'IAM service was disposed');
          }
          lastGrant = latest;
          assertExclusive();
          await targetStore.mirror(latest.accessToken);
          if (epoch !== sessionEpoch) {
            await targetStore.unsetMirror().catch(() => {});
            throw new IamError('IAM_DISPOSED', 'IAM service was disposed');
          }
          if (state === 'expired') publish('REFRESH_SUCCESS');
          else if (state === 'unreachable' || state === 'error') {
            const next = transition(state, 'RECOVER');
            if (next.ok) {
              state = next.state;
              error = null;
              notify();
            }
          }
          return latest.accessToken;
        } catch (err) {
          if (epoch !== sessionEpoch) {
            await targetStore.unsetMirror().catch(() => {});
            throw new IamError('IAM_DISPOSED', 'IAM service was disposed');
          }
          const code = tokenErrorMessage(err);
          if (code === 'IAM_DISPOSED') throw err;
          if (isMirrorSessionLost(err)) {
            // Rotation was persisted; only its derived publication lost
            // ownership. A newer grant must survive this caller's failure.
            lastGrant = null;
            state = 'signed-out';
            error = code;
            notify();
            throw new IamError(code, safeMessage(code));
          }
          if (code === 'IAM_GRANT_CONTEXT_MISMATCH') {
            lastGrant = null;
            error = code;
            state = 'error';
            notify();
            throw new IamError(code, safeMessage(code));
          }
          if (rotated) {
            // The IdP may already have invalidated the old refresh token. If
            // the rotated grant cannot be persisted, keep no stale session.
            const cleared = await targetStore.clear().catch(() => ({ ok: false }));
            lastGrant = null;
            if (!cleared.ok) {
              error = 'IAM_CREDENTIALS_CLEAR_FAILED';
              state = 'error';
              notify();
              throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
            }
            if (state === 'ready' || state === 'expired') publish('SIGN_OUT');
            else { state = 'signed-out'; notify(); }
            throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
          }
          if (code === 'IAM_INVALID_GRANT' || code === 'IAM_REAUTH_REQUIRED') {
            // Another process may have rotated the refresh token after this
            // process started its request. Never clear a newer session; adopt
            // it when it is already usable.
            const current = await targetStore.read().catch(() => null);
            if (current?.ok && current.grant && attemptedRefreshToken && current.grant.refreshToken !== attemptedRefreshToken) {
              assertGrantContext(current.grant);
              if (lastGrant?.subject && current.grant.subject !== lastGrant.subject) {
                throw new IamError('IAM_REFRESH_SUBJECT_MISMATCH', safeMessage('IAM_REFRESH_SUBJECT_MISMATCH'));
              }
              assertExclusive();
              await targetStore.mirror(current.grant.accessToken);
              if (epoch !== sessionEpoch) {
                await targetStore.unsetMirror().catch(() => {});
                throw new IamError('IAM_DISPOSED', 'IAM service was disposed');
              }
              lastGrant = current.grant;
              state = 'ready';
              error = null;
              notify();
              return current.grant.accessToken;
            }
            const cleared = await targetStore.clear().catch(() => ({ ok: false }));
            lastGrant = null;
            if (!cleared.ok) {
              error = 'IAM_CREDENTIALS_CLEAR_FAILED';
              state = 'error';
              notify();
              throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
            }
            if (state === 'ready' || state === 'expired') publish('SIGN_OUT');
            throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
          }
          if (code === 'IAM_UNREACHABLE') {
            if (state === 'ready') publish('UNREACHABLE', code);
            throw new IamError(code, safeMessage(code));
          }
          if (state === 'expired') publish('REFRESH_FAILURE', code);
          throw new IamError(code, safeMessage(code));
        }
      })().finally(() => { refreshPromise = null; });
      return refreshPromise;
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
      clearAttempt();
      // Stop subscribers before any await so unload cannot leave a watch()
      // caller parked forever. dispose() is lifecycle cleanup, not logout:
      // persisted credentials are cleared only by an explicit signOut() or by
      // the enterprise uninstall flow.
      listeners.clear();
      for (const stop of [...stopWaiters]) stop();
      stopWaiters.clear();
      lastGrant = null;
      state = 'signed-out';
      error = null;
      // Removing the derived mirror is cache cleanup, not logout: the grant
      // remains for the next startup, but a process that no longer mounts IAM
      // cannot keep using an ambient access token. Reuse the store this
      // service already created: teardown runs concurrently with the
      // framework disposing ctx.provide('credentials'), so re-resolving the
      // seam here would silently skip the mirror cleanup.
      const targetStore = store ?? ensureStore();
      if (targetStore) await targetStore.unsetMirror().catch(() => {});
    },
  };

  return service;
}