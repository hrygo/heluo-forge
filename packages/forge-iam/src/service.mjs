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
  const config = 'value' in checked ? checked.value : (rawConfig ?? {});
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
  let refreshPromise = null;
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
      configured: configured && state !== 'unconfigured',
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

  function redirectUri() {
    if (config.redirectUri) {
      try {
        return new URL(config.redirectUri).href;
      } catch {
        throw new IamError('IAM_CONFIG_INVALID', 'redirectUri must be an absolute URL');
      }
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

  async function hydrate() {
    if (!configured || !exclusive.ok) return view();
    const targetStore = ensureStore();
    if (!targetStore) return view();
    try {
      const record = await targetStore.read();
      if (!record.ok) {
        error = 'IAM_GRANT_INVALID';
        state = 'error';
        notify();
        return view();
      }
      if (!record.grant) return view();
      lastGrant = record.grant;
      state = isRefreshUsable(record.grant) || !shouldRefresh(record.grant, now(), config.refreshSkewSeconds)
        ? 'ready'
        : 'expired';
      error = null;
      if (lastGrant.accessToken) await targetStore.mirror(lastGrant.accessToken).catch(() => {});
      notify();
    } catch {
      error = 'IAM_CREDENTIALS_UNAVAILABLE';
      state = 'error';
      notify();
    }
    return view();
  }

  const service = {
    getView() {
      return view();
    },

    hydrate,

    async startSignIn() {
      assertExclusive();
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
      assertExclusive();
      let parsed;
      try {
        parsed = parseCallbackUrl(rawUrl);
      } catch (error) {
        const code = tokenErrorMessage(error);
        fail(code);
        throw new IamError(code, safeMessage(code));
      }
      const { code, state: receivedState } = parsed;
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
          now: now(),
          skewSeconds: config.refreshSkewSeconds,
        });
        const grant = await buildGrant(token, claims, current.metadata, nowIso(now()));
        assertExclusive();
        const targetStore = requireStore();
        try {
          await targetStore.write(grant);
          await targetStore.mirror(token.accessToken);
        } catch (error) {
          await targetStore.clear().catch(() => {});
          throw error;
        }
        lastGrant = grant;
        clearAttempt();
        publish('SIGN_IN_SUCCESS');
        return view();
      } catch (error) {
        const code = tokenErrorMessage(error);
        fail(code);
        throw new IamError(code, safeMessage(code));
      }
    },

    async cancelSignIn() {
      if (state !== 'authenticating') return view();
      clearAttempt();
      return publish('CANCEL');
    },

    async signOut() {
      clearAttempt();
      let grant = lastGrant;
      const targetStore = ensureStore();
      if (targetStore) {
        const record = await targetStore.read().catch(() => ({ ok: false, grant: null }));
        if (record?.grant) grant = record.grant;
        await targetStore.clear().catch(() => {});
      }
      lastGrant = null;
      if (grant) {
        const meta = metadataCache?.value;
        if (meta?.revocationEndpoint && grant.refreshToken) {
          await revokeToken({
            revocationEndpoint: meta.revocationEndpoint,
            token: grant.refreshToken,
            tokenTypeHint: 'refresh_token',
            clientId: config.clientId,
            fetchImpl,
            timeoutMs: config.httpTimeoutMs,
          }).catch(() => {});
        }
      }
      let logoutUrl = null;
      if (config.logoutMode === 'rp') {
        try {
          const meta = metadataCache?.value ?? await metadata();
          if (meta.endSessionEndpoint) {
            const url = new URL(meta.endSessionEndpoint);
            url.searchParams.set('client_id', config.clientId);
            if (grant?.idToken) url.searchParams.set('id_token_hint', grant.idToken);
            if (config.postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', config.postLogoutRedirectUri);
            logoutUrl = url.href;
          }
        } catch {
          logoutUrl = null;
        }
      }
      if (state !== 'unconfigured' && state !== 'signed-out') {
        publish('SIGN_OUT');
      }
      return { view: view(), logoutUrl };
    },

    async resolveToken() {
      assertExclusive();
      const targetStore = requireStore();
      let record = await targetStore.read();
      if (!record.ok) {
        throw new IamError('IAM_INVALID_GRANT', safeMessage('IAM_INVALID_GRANT'));
      }
      if (!record.grant) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
      }
      if (!shouldRefresh(record.grant, now(), config.refreshSkewSeconds)) {
        lastGrant = record.grant;
        if (state !== 'ready') {
          state = 'ready';
          notify();
        }
        return record.grant.accessToken;
      }
      if (!isRefreshUsable(record.grant, now())) {
        await targetStore.clear().catch(() => {});
        lastGrant = null;
        if (state === 'ready' || state === 'expired') publish('SIGN_OUT');
        throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
      }
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => {
        try {
          const result = await targetStore.mutate(async (current) => {
            if (!current) return undefined;
            if (!shouldRefresh(current, now(), config.refreshSkewSeconds)) return undefined;
            const meta = metadataCache?.value ?? await metadata();
            const token = await refreshTokens({
              tokenEndpoint: meta.tokenEndpoint,
              refreshToken: current.refreshToken,
              clientId: config.clientId,
              resource: config.gatewayResource,
              fetchImpl,
              timeoutMs: config.httpTimeoutMs,
            });
            let claims = null;
            if (token.idToken) {
              claims = verifyIdToken(token.idToken, {
                jwks: await jwks(meta.jwksUri),
                issuer: meta.issuer,
                clientId: config.clientId,
                now: now(),
                skewSeconds: config.refreshSkewSeconds,
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
          lastGrant = latest;
          assertExclusive();
          await targetStore.mirror(latest.accessToken);
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
          const code = tokenErrorMessage(err);
          if (code === 'IAM_INVALID_GRANT' || code === 'IAM_REAUTH_REQUIRED') {
            await targetStore.clear().catch(() => {});
            lastGrant = null;
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

    dispose() {
      clearAttempt();
      listeners.clear();
      for (const stop of [...stopWaiters]) stop();
      stopWaiters.clear();
    },
  };

  return service;
}