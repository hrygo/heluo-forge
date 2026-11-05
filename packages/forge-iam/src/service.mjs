import { normalizeGatewayBaseURL } from './managed-models.mjs';
import { createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isConfigured, validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';
import { assertClientAuthConfigured, assertClientAuthCurrent, assertGrantAuthBinding, clientAuthContext, clientAuthDescriptor, grantAuthPin, prepareClientAuthentication } from './client-auth.mjs';
import { StoreError } from './store.mjs';
import { isAccessExpired, isRefreshUsable, shouldRefresh, summarizeGrant } from './record.mjs';
import { createServiceState } from './service-state.mjs';
import { createServiceStore } from './service-store.mjs';
import { transition } from './state.mjs';
import { inspectReadonlyModelSelection, readonlyModelResult } from './model-selection-host.mjs';
import { createConsumptionWitness } from './consumption-witness.mjs';
import { fetchUserInfo, normalizeProfileFields, projectUserInfo } from './userinfo.mjs';
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
  revokeAccessToken,
  revokeToken,
  safeStateEqual,
  verifyIdToken,
} from './oidc.mjs';

import {
  canonicalRecord,
  refreshBaseId,
  sameGrantIgnoringRefreshMarker,
  grantIdentity,
  nowIso,
  addSeconds,
  tokenErrorMessage,
  safeMessage,
} from './service-helpers.mjs';

const METADATA_TTL_MS = 5 * 60 * 1000;
const JWKS_TTL_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 5000;
const ID_TOKEN_CLOCK_SKEW_SECONDS = 60;
const GATEWAY_RELOAD_MS = 5000;
const AUTO_REFRESH_BACKOFF_MS = 30000;

/**
 * Host-side IAM session. Login is OIDC authorization-code + PKCE against
 * configured endpoints; every unverified capability stays fail closed.
 *
 * @param {Record<string, unknown>} config normalized config
 * @param {{
 *   exclusive?: { ok: boolean, reason?: string },
 *   credentials?: object,
 *   getModelSelectionServices?: () => {llm: object, agentDefaultModel: object} | undefined,
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
  // Real apply supplies neither private function; configuration cannot unlock it.
  assertClientAuthConfigured(config, options);
  const configured = isConfigured(config).ok;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // Empty by default: IAM has not confirmed field names, so no name is shown.
  const profileFields = normalizeProfileFields(options.profileFields ?? Object.freeze({}));
  let modelSelectionFlight = null;
  let modelSelectionQueued = false;
  let modelSelectionGeneration = 0;
  let lastBackgroundRefreshAt = 0;

  // Credentials provider handles and their caches live in one module.
  const provider = createServiceStore({ options });

  // Every published-state read/write goes through ctx: the state module owns
  // the five scalars, the transition path and the listener set.
  const ctx = createServiceState({
    config,
    options,
    configured,
    now,
    getGatewaySummary: () => provider.gatewaySummary,
    getMetadataIssuer: () => metadataCache?.value.issuer ?? '',
    scheduleReconcile: scheduleDefaultModelReconciliation,
    clearPendingObservation: () => { observedPending = null; },
    onFailReset: () => {
      observedPending = null;
      clearAttempt();
      identityProfile = undefined;
    },
  });


  /**
   * Resolve the subject that owns a person's durable model settings. The grant
   * is read back from the provider instead of trusting a cached copy: an
   * account or provider change must not let one person's selection be read or
   * written under another's name.
   */
  async function selectionOwner() {
    const target = provider.ensure();
    if (!target) return null;
    const credentials = provider.storeCredentials;
    const record = await target.read().catch(() => null);
    if (!record?.ok || !record.grant?.subject) return null;
    try { assertGrantContext(record.grant, ctx.knownIssuer()); } catch { return null; }
    const expires = Date.parse(record.grant.accessExpiresAt);
    return { subject: record.grant.subject, credentials, expired: !Number.isFinite(expires) || expires <= now() };
  }

  // Non-secret provenance/pin and the last authenticated session identity only.
  let sessionAuthentication = null;
  let identityProfile;
  let refreshPromiseAuthentication = null;
  // A weak association prevents a discarded cached grant retaining its provider.
  const grantOwners = new WeakMap();
  let attempt = null;
  let refreshPromise = null;
  let refreshPromiseStore = null;
  let refreshPromiseCredentials = null;
  let refreshPromiseIssuer = null;
  let signInPromise = null;
  let signOutPromise = null;
  let signingOut = false;
  let sessionEpoch = 0;
  let authEpoch = 0;
  let syncPublications = 0;
  let observedPending = null;
  let metadataCache = null;
  let jwksCache = null;
  const stopWaiters = new Set();
  // Absent in real apply: do not inspect private binding readers without opt-in.
  const consumptionWitness = typeof options.registerWitness === 'function'
    ? createConsumptionWitness(config, options, (adopted) => {
      ctx.recheckExclusive();
      return !ctx.disposed && !signingOut && ctx.state === 'ready' && ctx.exclusive.ok
        && authEpoch === adopted.binding.authEpoch && sessionEpoch === adopted.binding.sessionEpoch
        && provider.store === adopted.binding.store && provider.storeCredentials === adopted.binding.credentials
        && ctx.lastGrant?.sessionInstanceId === adopted.sessionInstanceId
        && ctx.lastGrant.issuer === adopted.issuer && ctx.lastGrant.subject === adopted.subject
        && ctx.lastGrant.accessExpiresAt === adopted.accessExpiresAt && ctx.lastGrant.version === adopted.version
        && ctx.lastGrant.clientId === adopted.clientId && ctx.lastGrant.resource === adopted.resource
        && isDeepStrictEqual(ctx.lastGrant.authContext, adopted.authContext) && !isAccessExpired(ctx.lastGrant, now());
    }) : undefined;

  function beginConsumption(issuer, target, credentials, expected) {
    return consumptionWitness?.begin(issuer, credentials, target, authEpoch, sessionEpoch, expected);
  }

  function adoptConsumption(ticket, grant) {
    if (!consumptionWitness) return;
    const { issuer, subject, sessionInstanceId, accessExpiresAt, version, clientId, resource } = grant;
    const authContext = grant.authContext ? Object.freeze({ mode: grant.authContext.mode,
      method: grant.authContext.method, secretRef: grant.authContext.secretRef,
      secretRevision: grant.authContext.secretRevision }) : undefined;
    consumptionWitness.adopt(ticket, { issuer, subject, sessionInstanceId, accessExpiresAt,
      version, clientId, resource, authContext });
  }

  function clearAttempt() {
    if (attempt?.timer) clearTimeout(attempt.timer);
    attempt = null;
  }



  async function prepareAuthentication(issuer, target, credentials, { grant, expected = sessionAuthentication, guard } = {}) {
    if (config.authMode !== 'confidential') return undefined;
    const current = () => {
      if (guard) guard();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      ctx.assertExclusive();
      if (provider.ensure() !== target || provider.storeCredentials !== credentials) {
        throw new IamError('IAM_CLIENT_AUTH_CHANGED', safeMessage('IAM_CLIENT_AUTH_CHANGED'));
      }
      if (guard) guard();
      return true;
    };
    current();
    const operation = await prepareClientAuthentication(config, options, { issuer, credentials,
      expectedPin: grantAuthPin(grant) ?? expected?.pin, expectedProvenance: expected?.provenance, guard: current });
    assertClientAuthCurrent(operation);
    return operation;
  }

  function rememberAuthentication(operation, grant) {
    if (operation) sessionAuthentication = Object.freeze({ ...clientAuthDescriptor(operation), identity: grantIdentity(grant), credentials: provider.storeCredentials });
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

  async function loadIdentityProfile(grant) {
    if (Object.keys(profileFields).length === 0) return;
    identityProfile = undefined;
    const epoch = authEpoch;
    try {
      const meta = metadataCache?.value ?? await metadata();
      const endpoint = meta?.userInfoEndpoint;
      if (!endpoint) return;
      const raw = await fetchUserInfo({
        userInfoEndpoint: endpoint,
        accessToken: grant.accessToken,
        fetchImpl,
        timeoutMs: Math.min(config.httpTimeoutMs, 5000),
      });
      if (ctx.disposed || authEpoch !== epoch || ctx.lastGrant !== grant) return;
      const profile = projectUserInfo(raw, profileFields);
      identityProfile = profile ? Object.freeze({ identity: grantIdentity(grant), profile }) : undefined;
    } catch {
      // UserInfo is enrichment only: login stays successful without it.
      identityProfile = undefined;
    }
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
  async function verifyWithJwks(token, { uri, issuer, clientId, nonce, accessToken, guard }) {
    const options = {
      issuer,
      clientId,
      accessToken,
      skewSeconds: ID_TOKEN_CLOCK_SKEW_SECONDS,
      now: now(),
      ...(nonce === undefined ? {} : { nonce }),
    };
    try {
      const keys = await jwks(uri);
      if (guard) guard();
      return verifyIdToken(token, { ...options, jwks: keys });
    } catch (cause) {
      if (guard) guard();
      if (cause?.code !== 'IAM_JWKS_KEY_NOT_FOUND') throw cause;
      jwksCache = null;
      const keys = await jwks(uri);
      if (guard) guard();
      return verifyIdToken(token, { ...options, jwks: keys });
    }
  }

  function assertGrantBinding(grant) {
    if (!grant) return;
    assertGrantAuthBinding(config, grant);
    const wrongClient = grant.clientId !== config.clientId;
    // V1 login carries no gateway audience; only compare when one is configured
    // so grants stored before the split keep working.
    const wrongResource = Boolean(config.gatewayResource) && grant.resource !== config.gatewayResource;
    if (wrongClient || wrongResource) {
      throw new IamError('IAM_GRANT_CONTEXT_MISMATCH', safeMessage('IAM_GRANT_CONTEXT_MISMATCH'));
    }
  }

  function assertGrantContext(grant, expectedIssuer) {
    if (!grant) return;
    assertGrantBinding(grant);
    if (!expectedIssuer || grant.issuer !== expectedIssuer) {
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
      version: previous?.version ?? 1,
      ...(previous?.authContext ? { authContext: { ...previous.authContext } } : {}),
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

  async function buildGrant(token, claims, meta, obtainedAt, authentication) {
    if (!token.refreshToken) {
      throw new IamError('IAM_REFRESH_TOKEN_MISSING', safeMessage('IAM_REFRESH_TOKEN_MISSING'));
    }
    return {
      version: authentication ? 2 : 1,
      ...(authentication ? { authContext: clientAuthContext(authentication.pin) } : {}),
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
    if (ctx.disposed || signingOut) return ctx.view();
    if (!configured || !ctx.exclusive.ok) return ctx.view();
    // A user-triggered sign-in owns the state machine until its callback,
    // cancellation, or timeout; a background hydration must not clobber it.
    if (ctx.state === 'authenticating' || signInPromise) return ctx.view();
    // Only an error created by this instance observing pending can recover.
    const observation = ctx.state === 'error' ? observedPending : null;
    if (ctx.state === 'error' && (!observation || ctx.error !== 'IAM_REAUTH_REQUIRED'
      || observation.authEpoch !== authEpoch || now() >= observation.deadline)) {
      observedPending = null;
      return ctx.view();
    }
    const expectedIssuer = ctx.knownIssuer();
    const syncEpoch = authEpoch;
    let publication = syncPublications;
    let expectedGrant = ctx.lastGrant;
    const isActive = () => !ctx.disposed && !signingOut && ctx.exclusive.ok && authEpoch === syncEpoch
      && syncPublications === publication && ctx.lastGrant === expectedGrant
      && (observation ? ctx.state === 'error' && ctx.error === 'IAM_REAUTH_REQUIRED'
        && observedPending === observation && now() < observation.deadline
        : ctx.state !== 'authenticating' && ctx.state !== 'error' && !signInPromise);
    const published = () => {
      publication = ++syncPublications;
      expectedGrant = ctx.lastGrant;
    };
    const discardIdentity = () => {
      // Store lookups can be rebound independently. Clear only the adopted
      // identity this sync still owns, never a later publication (even null).
      if (expectedGrant && ctx.lastGrant === expectedGrant && grantOwners.has(expectedGrant)) {
        ctx.lastGrant = null;
        ctx.state = 'signed-out';
        ctx.error = null;
        published();
        ctx.notify();
      }
    };
    const targetStore = provider.ensure();
    if (!isActive()) return ctx.view();
    if (!targetStore || (observation && targetStore !== observation.store)) {
      if (!targetStore) discardIdentity();
      observedPending = null;
      return ctx.view();
    }
    const targetCredentials = provider.storeCredentials;
    const consumption = beginConsumption(expectedIssuer, targetStore, targetCredentials);
    // Re-read the live provider after each await; the lookup itself may also
    // synchronously dispose this service or start a newer auth operation.
    const isCurrent = () => {
      if (!isActive()) return false;
      const currentStore = provider.ensure();
      if (!isActive()) return false;
      if (currentStore === targetStore && provider.storeCredentials === targetCredentials) return true;
      discardIdentity();
      if (observation && observedPending === observation) observedPending = null;
      return false;
    };
    try {
      const record = await targetStore.read();
      ctx.recheckExclusive();
      if (!isCurrent()) return ctx.view();
      if (!record.ok) {
        observedPending = null;
        ctx.lastGrant = null;
        ctx.error = 'IAM_GRANT_INVALID';
        ctx.state = 'error';
        published();
        ctx.notify();
        return ctx.view();
      }
      if (!record.grant) {
        if (observation) {
          observedPending = null;
          return ctx.view();
        }
        const changed = ctx.lastGrant !== null || ctx.state !== 'signed-out';
        ctx.lastGrant = null;
        published();
        if (changed) {
          ctx.error = null;
          ctx.state = 'signed-out';
          ctx.notify();
        }
        return ctx.view();
      }
      assertGrantContext(record.grant, expectedIssuer);
      const authentication = await prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: record.grant, guard: () => {
        if (!isCurrent()) throw new IamError('IAM_CLIENT_AUTH_CHANGED', safeMessage('IAM_CLIENT_AUTH_CHANGED'));
      } });
      if (!isCurrent()) return ctx.view();
      assertClientAuthCurrent(authentication);
      const marker = record.grant.refreshOperation;
      const identity = grantIdentity(record.grant);
      const refreshDigest = (grant, id) => createHmac('sha256', id).update(grant.refreshToken).digest('base64url');
      if (observation) {
        if (!marker || marker.version !== observation.version || marker.id !== observation.id
          || marker.base !== observation.base || !isDeepStrictEqual(identity, observation.identity)) {
          observedPending = null;
          return ctx.view();
        }
        const sameRefresh = refreshDigest(record.grant, marker.id) === observation.refreshDigest;
        if (marker.state === 'pending' && sameRefresh) return ctx.view();
        if (marker.state !== 'complete' || sameRefresh
          || isAccessExpired(record.grant, now()) || !isRefreshUsable(record.grant, now())) {
          observedPending = null;
          return ctx.view();
        }
      } else if (marker?.state === 'pending') {
        observedPending = { version: marker.version, id: marker.id, base: marker.base,
          identity, refreshDigest: refreshDigest(record.grant, marker.id), authEpoch, store: targetStore,
          deadline: now() + REFRESH_TIMEOUT_MS };
        ctx.lastGrant = null;
        ctx.state = 'error';
        ctx.error = 'IAM_REAUTH_REQUIRED';
        published();
        ctx.notify();
        return ctx.view();
      }
      const previousSubject = ctx.lastGrant?.subject ?? null;
      const previous = `${ctx.state}|${ctx.error}|${previousSubject}`;
      ctx.lastGrant = record.grant;
      grantOwners.set(record.grant, targetStore);
      published();
      // An adopted subject changes the displayed match, not the stored key.
      if (observation || (previousSubject !== null && record.grant.subject !== previousSubject)) {
        await loadGatewayCredential({ force: true });
        if (!isCurrent()) {
          if (ctx.lastGrant === record.grant) ctx.lastGrant = null;
          return ctx.view();
        }
        assertClientAuthCurrent(authentication);
      }
      rememberAuthentication(authentication, record.grant);
      if (observation) observedPending = null;
      // `expired` means the access token is no longer usable, not merely inside
      // the refresh skew: a token request renews the latter, and showing "expired"
      // while the token still works would send the user through a needless login.
      ctx.state = isAccessExpired(record.grant, now()) ? 'expired' : 'ready';
      ctx.error = null;
      adoptConsumption(consumption, record.grant);
      // With a usable refresh token an expired session is recoverable; without
      // this, the interim client would only ever offer a full re-login.
      if (ctx.state === 'expired' && isRefreshUsable(record.grant, now())
        && now() - lastBackgroundRefreshAt >= AUTO_REFRESH_BACKOFF_MS) {
        lastBackgroundRefreshAt = now();
        void service.resolveToken().catch(() => {});
      }
      if (previous !== `${ctx.state}|${ctx.error}|${ctx.lastGrant.subject ?? ''}`) ctx.notify();
    } catch (cause) {
      if (!isCurrent()) return ctx.view();
      observedPending = null;
      ctx.lastGrant = null;
      ctx.error = ['IAM_GRANT_CONTEXT_MISMATCH', 'IAM_CLIENT_AUTH_CONTEXT_INVALID', 'IAM_CLIENT_AUTH_UNVERIFIED', 'IAM_CLIENT_AUTH_CHANGED'].includes(cause?.code)
        ? cause.code : 'IAM_CREDENTIALS_UNAVAILABLE';
      ctx.state = 'error';
      published();
      ctx.notify();
    }
    return ctx.view();
  }

  async function readGatewayCredential(targetGatewayStore, targetStore, isCurrent) {
    if (!isCurrent()) return null;
    const record = await targetGatewayStore.read().catch(() => ({ ok: false, reason: 'unreadable' }));
    if (!isCurrent()) return null;
    if (!record.ok) return { state: 'invalid' };
    const resolved = await targetGatewayStore.resolve(record.credential).catch(() => undefined);
    if (!isCurrent()) return null;
    const credential = record.credential ?? {};
    if (resolved?.invalid) return { state: 'invalid' };
    if (!resolved?.value) return { state: 'unconfigured' };
    // A keychain value without metadata is still unattributable. This status is
    // informational; it does not prevent another consumer resolving the ref.
    if (!record.credential) return { state: 'invalid', matchesAccount: false };
    const storage = await targetGatewayStore.describe().catch(() => null);
    if (!isCurrent()) return null;
    const signedInSubject = ctx.lastGrant && grantOwners.get(ctx.lastGrant) === targetStore ? ctx.lastGrant.subject : null;
    const matchesAccount = Boolean(credential.ownerSubject && signedInSubject && credential.ownerSubject === signedInSubject);
    return {
      // Without a session the stored key is still "configured"; it only becomes
      // a mismatch once a different subject is known.
      state: !signedInSubject || matchesAccount ? 'configured' : 'owner-mismatch',
      ownerSubject: credential.ownerSubject ?? null,
      baseURL: credential.baseURL ?? config.managedModels?.baseURL ?? null,
      generation: credential.writeOperationId ?? null,
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
    if (ctx.disposed) return null;
    // Cache hits and singleflight reuse must belong to the live provider too.
    const targetStore = provider.ensure();
    if (ctx.disposed || !targetStore || !provider.gatewayStore) return null;
    if (!force && provider.gatewayLoadedAt > 0 && now() - provider.gatewayLoadedAt < GATEWAY_RELOAD_MS) return provider.gatewaySummary;
    if (provider.gatewayLoading) return provider.gatewayLoading;
    const targetGatewayStore = provider.gatewayStore;
    const targetCredentials = provider.storeCredentials;
    const epoch = provider.gatewayEpoch;
    const isCurrent = () => {
      if (ctx.disposed || epoch !== provider.gatewayEpoch) return false;
      const current = provider.ensure();
      return !ctx.disposed && epoch === provider.gatewayEpoch && current === targetStore
        && provider.gatewayStore === targetGatewayStore && provider.storeCredentials === targetCredentials;
    };
    const request = readGatewayCredential(targetGatewayStore, targetStore, isCurrent)
      .then((summary) => {
        if (!isCurrent()) return null;
        const changed = !isDeepStrictEqual(provider.gatewaySummary, summary);
        provider.gatewaySummary = summary;
        provider.gatewayLoadedAt = now();
        // Own forced reads do not feed back into another observation.
        if (changed && !modelSelectionFlight) scheduleDefaultModelReconciliation();
        return summary;
      })
      .catch(() => {
        if (isCurrent()) { provider.gatewaySummary = null; provider.gatewayLoadedAt = 0; }
        return null;
      })
      .finally(() => { if (provider.gatewayLoading === request) provider.gatewayLoading = null; });
    provider.gatewayLoading = request;
    return request;
  }

  function scheduleDefaultModelReconciliation() {
    if (ctx.disposed || !config.defaultModel.trim()) return;
    if (modelSelectionFlight) {
      modelSelectionQueued = true;
      return;
    }
    // Deliberately detached from login/callback failure handling. A read-only
    // model observation must never discard a grant or revoke a token.
    void reconcileDefaultModel().catch(() => {});
  }

  // The private composition getter keeps one binding object per scoped lifetime.
  function modelSelectionServices() {
    try {
      if (typeof options.getModelSelectionServices !== 'function') return undefined;
      const binding = options.getModelSelectionServices();
      if (binding && typeof binding.then === 'function') {
        Promise.resolve(binding).catch(() => {});
        return undefined;
      }
      if (!binding || typeof binding !== 'object') return undefined;
      // Retain the binding identity too: an injected scope may be removed and
      // rebound with the same two SDK instances while an old read is pending.
      const llm = binding.llm;
      const agentDefaultModel = binding.agentDefaultModel;
      return llm && agentDefaultModel ? { binding, llm, agentDefaultModel } : undefined;
    } catch {
      return undefined;
    }
  }

  async function reconcileDefaultModel() {
    if (!config.defaultModel.trim() || !config.defaultProvider.trim()) {
      return readonlyModelResult('default-model-unconfigured');
    }
    if (ctx.disposed || signingOut || ctx.state !== 'ready') return readonlyModelResult('iam-not-ready');
    const targetStore = provider.ensure();
    const targetCredentials = provider.storeCredentials;
    const grant = ctx.lastGrant;
    if (!targetStore || !grant || grantOwners.get(grant) !== targetStore
      || isAccessExpired(grant, now())) return readonlyModelResult('iam-not-ready');
    const services = modelSelectionServices();
    if (!services) return readonlyModelResult('model-services-unavailable');
    if (modelSelectionFlight) {
      modelSelectionQueued = true;
      return modelSelectionFlight.promise;
    }
    const auth = authEpoch;
    const generation = modelSelectionGeneration;
    const gateway = provider.gatewayEpoch;
    const active = () => !ctx.disposed && !signingOut && ctx.state === 'ready' && ctx.exclusive.ok
      && authEpoch === auth && modelSelectionGeneration === generation && provider.gatewayEpoch === gateway
      && ctx.lastGrant === grant && !isAccessExpired(grant, now());
    const isCurrent = () => {
      try {
        if (!active()) return false;
        ctx.assertExclusive();
        if (!active() || provider.ensure() !== targetStore || provider.storeCredentials !== targetCredentials) return false;
        const current = modelSelectionServices();
        return active() && current?.binding === services.binding && current.llm === services.llm
          && current.agentDefaultModel === services.agentDefaultModel;
      } catch { return false; }
    };
    const request = Promise.resolve().then(async () => {
      if (!isCurrent()) return readonlyModelResult('model-context-changed');
      const summary = await loadGatewayCredential({ force: true });
      if (!isCurrent()) return readonlyModelResult('model-context-changed');
      if (summary?.state !== 'configured' || summary.matchesAccount !== true) {
        return readonlyModelResult('gateway-credential-unavailable');
      }
      return inspectReadonlyModelSelection(services, {
        provider: config.defaultProvider, model: config.defaultModel,
      }, isCurrent);
    }).catch(() => readonlyModelResult(isCurrent() ? 'model-read-failed' : 'model-context-changed'))
      .finally(() => {
        if (modelSelectionFlight?.promise !== request) return;
        modelSelectionFlight = null;
        const queued = modelSelectionQueued;
        modelSelectionQueued = false;
        if (queued) scheduleDefaultModelReconciliation();
      });
    modelSelectionFlight = { promise: request };
    return request;
  }

  async function hydrate() {
    // Preserve any pre-existing legacy reference; its migration or deletion
    // requires a separate decision and does not make it safe to consume.
    await syncFromStore();
    await loadGatewayCredential({ force: true });
    return ctx.view();
  }

  const service = {
    getView() {
      return ctx.view();
    },
    getModelAccessEpoch() { return `${authEpoch}:${sessionEpoch}:${modelSelectionGeneration}`; },

    /**
     * Identity and freshness only. Never a token, verifier or ID token: this is
     * the cross-module read surface, and it must not become a token channel by
     * accident. Use `resolveToken()` (or `getAccessToken()`) for the token.
     */
    getSession() {
      ctx.recheckExclusive();
      const summary = ctx.lastGrant ? summarizeGrant(ctx.lastGrant) : {};
      return {
        status: ctx.state,
        signedIn: summary.signedIn === true,
        principal: summary.principal
          ? { issuer: summary.issuer ?? null, subject: summary.principal }
          : undefined,
        accessExpiresAt: summary.accessExpiresAt ?? null,
        scope: summary.scope ?? null,
      };
    },

    hydrate,
    syncFromStore,
    loadGatewayCredential,
    /**
     * Host-only: push the current view after a change that never touched the
     * IAM state machine (the managed model catalogue is the only such source).
     * Without this, subscribers keep the last frame until an unrelated event.
     */
    notifyView() { return ctx.notify(); },
    // Host-only observation; intentionally absent from routes and IamView.
    reconcileDefaultModel,

    /** Host-only request credential; never exposed by management routes or IamView. */
    async resolveGatewayCredential() { return (await service.resolveGatewayConnection()).key; },

    async refreshGatewayModels() {
      const runtime = options.getManagedModelRuntime?.();
      if (!runtime) throw new IamError('ENTERPRISE_MODELS_UNAVAILABLE', '企业模型暂不可用，请联系管理员。');
      return runtime.refresh();
    },

    async updateModelOptions(nextOptions) {
      const runtime = options.getManagedModelRuntime?.();
      if (!runtime) throw new IamError('ENTERPRISE_MODELS_UNAVAILABLE', '企业模型暂不可用，请联系管理员。');
      return runtime.updateModelOptions(nextOptions);
    },

    getModelOptions() {
      const runtime = options.getManagedModelRuntime?.();
      return runtime?.getModelOptions?.() ?? {};
    },

    /**
     * Durable model selection for the signed-in person. The record is bound to
     * one subject, so another person's saved choice is never adopted: it simply
     * reads as "nothing saved" and the runtime starts from the catalogue.
     */
    async readModelSelection() {
      const current = await selectionOwner();
      if (!current) return { subject: null, saved: false, models: {}, defaultModelId: null };
      const target = provider.ensure() ? provider.modelSelectionStore : null;
      if (!target || provider.storeCredentials !== current.credentials) {
        return { subject: current.subject, saved: false, models: {}, defaultModelId: null };
      }
      const record = await target.read();
      if (!record.ok || !record.selection || record.selection.subject !== current.subject) {
        // Nothing stored for this subject (or the record belongs to someone
        // else / is unreadable): the caller decides the first-run default.
        return { subject: current.subject, saved: false, models: {}, defaultModelId: null };
      }
      return { subject: current.subject, saved: true, models: record.selection.models, defaultModelId: record.selection.defaultModelId };
    },

    /** Persist the enabled set. Never a token channel: only model ids and overrides. */
    async saveModelSelection({ models, defaultModelId } = {}) {
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      let current = await selectionOwner();
      if (current?.expired && ctx.lastGrant && isRefreshUsable(ctx.lastGrant, now())) {
        try {
          await service.resolveToken();
          current = await selectionOwner();
        } catch {
          // keep expired status if refresh fails
        }
      }
      if (!current || current.expired) throw new IamError('IAM_NOT_SIGNED_IN', '企业账号状态已变化，请重新登录。');
      const target = provider.ensure() ? provider.modelSelectionStore : null;
      if (!target || provider.storeCredentials !== current.credentials) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', '暂时无法写入模型设置。');
      }
      const saved = await target.save({ subject: current.subject, models, defaultModelId });
      return saved.selection;
    },

    async resolveGatewayConnection() {
      // Refresh and validate the current grant through the existing authoritative path.
      // V1 sends only the personal Key to UAG; the IAM token never leaves this method.
      await service.resolveToken();
      const epoch = authEpoch;
      const targetStore = provider.require();
      const targetGatewayStore = provider.gatewayStore;
      const targetCredentials = provider.storeCredentials;
      const subject = ctx.lastGrant?.subject;
      const generation = modelSelectionGeneration;
      const check = () => {
        if (ctx.disposed || signingOut || authEpoch !== epoch || modelSelectionGeneration !== generation
          || ctx.state !== 'ready' || !subject || ctx.lastGrant?.subject !== subject || Date.parse(ctx.lastGrant.accessExpiresAt) <= now()) {
          throw new IamError('IAM_NOT_SIGNED_IN', '企业账号状态已变化，请重新登录。');
        }
        ctx.assertExclusive();
        if (provider.ensure() !== targetStore || provider.gatewayStore !== targetGatewayStore || provider.storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', '暂时无法读取个人访问凭证。');
        }
      };
      check();
      const record = await targetGatewayStore?.read();
      check();
      if (!record?.ok || record.credential?.ownerSubject !== subject) {
        throw new IamError('IAM_GATEWAY_CREDENTIAL_REQUIRED', '请保存当前账号的个人访问凭证。');
      }
      const resolved = await targetGatewayStore.resolve(record.credential);
      check();
      if (resolved?.invalid || !resolved?.value) {
        throw new IamError('IAM_GATEWAY_CREDENTIAL_REQUIRED', '请保存当前账号的个人访问凭证。');
      }
      const address = record.credential.baseURL ?? config.managedModels?.baseURL;
      if (!address) throw new IamError('IAM_GATEWAY_URL_INVALID', '请先设置网关地址。');
      const baseURL = normalizeGatewayBaseURL(address, config.allowInsecureHttp);
      return { key: resolved.value, baseURL, generation: record.credential.writeOperationId ?? null };
    },

    /**
     * Store the UAG personal credential the user pasted. IAM only records it;
     * it never issues or refreshes the key. Model discovery/calls use the
     * independently guarded runtime, after this storage transaction.
     */
    async saveGatewayCredential({ key: value, deviceLabel, baseURL: address } = {}) {
      const baseURL = address === undefined ? undefined : normalizeGatewayBaseURL(address, config.allowInsecureHttp);
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      modelSelectionGeneration += 1;
      if (!configured) {
        throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
          missing: isConfigured(config).missing,
        });
      }
      const expectedIssuer = ctx.knownIssuer();
      const epoch = authEpoch;
      const targetStore = provider.require();
      const targetGatewayStore = provider.gatewayStore;
      const targetCredentials = provider.storeCredentials;
      if (!targetGatewayStore) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      const assertCurrent = () => {
        const active = () => {
          if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
          if (signingOut || authEpoch !== epoch || ctx.state === 'authenticating') {
            throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
          }
          ctx.assertExclusive();
        };
        active();
        if (provider.ensure() !== targetStore || provider.gatewayStore !== targetGatewayStore || provider.storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
        }
        active();
      };
      assertCurrent();
      // A cached subject may belong to an earlier provider or shared session.
      const record = await targetStore.read().catch(() => null);
      assertCurrent();
      if (!record?.ok) throw new IamError('IAM_GRANT_INVALID', safeMessage('IAM_GRANT_INVALID'));
      assertGrantContext(record.grant, expectedIssuer);
      const authentication = await prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: record.grant, guard: assertCurrent });
      assertCurrent();
      const subject = record.grant?.subject;
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
      assertCurrent();
      try {
        await targetGatewayStore.save({
          value,
          baseURL,
          ownerSubject: subject,
          deviceLabel: label,
          enteredAt,
          suggestedExpiry,
        }, { guard: () => { assertCurrent(); assertClientAuthCurrent(authentication); return true; } });
      } catch (cause) {
        if (cause instanceof StoreError) throw new IamError(cause.code, safeMessage(cause.code));
        throw cause;
      }
      // A post-commit lifecycle change does not roll back a confirmed transaction.
      assertCurrent();
      assertClientAuthCurrent(authentication);
      await loadGatewayCredential({ force: true });
      assertCurrent();
      assertClientAuthCurrent(authentication);
      ctx.notify();
      return ctx.view();
    },

    async clearGatewayCredential() {
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      modelSelectionGeneration += 1;
      const targetStore = provider.require();
      const targetGatewayStore = provider.gatewayStore;
      const targetCredentials = provider.storeCredentials;
      if (!targetGatewayStore) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      const assertCurrent = () => {
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
        ctx.assertExclusive();
        if (provider.ensure() !== targetStore || provider.gatewayStore !== targetGatewayStore || provider.storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
        }
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      };
      assertCurrent();
      let cleared;
      try {
        cleared = await targetGatewayStore.clear({ guard: () => { assertCurrent(); return true; } });
      } catch (cause) {
        if (cause instanceof StoreError) throw new IamError(cause.code, safeMessage(cause.code));
        throw cause;
      }
      assertCurrent();
      if (!cleared.ok) {
        throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
      }
      await loadGatewayCredential({ force: true });
      assertCurrent();
      ctx.notify();
      return ctx.view();
    },

    /** Minimal principal for Host policy/audit; never tokens. */
    getPrincipal() {
      if (!ctx.lastGrant) return undefined;
      return { issuer: ctx.lastGrant.issuer, subject: ctx.lastGrant.subject };
    },

    /** Projected UserInfo for future display; empty until IAM confirms fields. */
    getIdentityProfile() {
      // A profile is only valid for the grant that produced it: every path that
      // clears or replaces lastGrant hides it, without touching each call site.
      if (!ctx.lastGrant || !identityProfile) return undefined;
      if (!isDeepStrictEqual(identityProfile.identity, grantIdentity(ctx.lastGrant))) return undefined;
      return { ...identityProfile.profile };
    },

    async startSignIn() {
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (!configured) {
        throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
          missing: isConfigured(config).missing,
        });
      }
      if (signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      const targetStore = provider.ensure();
      const credentials = provider.storeCredentials;
      if (attempt && (attempt.targetStore !== targetStore || attempt.credentials !== credentials)) {
        authEpoch += 1;
        clearAttempt();
        if (ctx.state === 'authenticating') {
          ctx.state = 'signed-out';
          ctx.error = null;
        }
      }
      if (!targetStore) throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      provider.assertAtomic(targetStore, credentials);
      if (ctx.state === 'ready') return { view: ctx.view(), authorizationUrl: null };
      if (ctx.state === 'authenticating' && attempt) {
        if (config.authMode === 'confidential') {
          const current = attempt; const epoch = authEpoch;
          const authentication = await prepareAuthentication(current.metadata.issuer, targetStore, credentials, { expected: current.authentication, guard: () => {
            if (attempt !== current || epoch !== authEpoch || signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
            provider.assertAtomic(targetStore, credentials);
          } });
          assertClientAuthCurrent(authentication);
        }
        return { view: ctx.view(), authorizationUrl: attempt.authorizationUrl };
      }
      if (signInPromise) return signInPromise;
      authEpoch += 1;
      observedPending = null;
      consumptionWitness?.invalidate();
      const consumption = beginConsumption(ctx.knownIssuer(), targetStore, credentials);
      const pending = service._startSignInOnce(targetStore, credentials, consumption);
      // Only the attempt that still owns the slot clears it: a cancel or a newer
      // sign-in must not be overwritten by a superseded attempt settling late.
      const settle = () => { if (signInPromise === pending) signInPromise = null; };
      pending.then(settle, settle);
      signInPromise = pending;
      return signInPromise;
    },

    async _startSignInOnce(targetStore, credentials, consumption) {
      const startEpoch = authEpoch;
      if (ctx.state === 'unreachable') {
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
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (authEpoch !== startEpoch || signingOut) {
        throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      }
      provider.assertAtomic(targetStore, credentials);
      const authentication = await prepareAuthentication(meta.issuer, targetStore, credentials, { expected: null, guard: () => {
        if (authEpoch !== startEpoch || signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
        provider.assertAtomic(targetStore, credentials);
      } });
      assertClientAuthCurrent(authentication);
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (authEpoch !== startEpoch || signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      if (ctx.state === 'ready') return { view: ctx.view(), authorizationUrl: null };
      if (!transition(ctx.state, 'SIGN_IN').ok) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
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
        authentication: clientAuthDescriptor(authentication),
        consumption,
        expiresAt: now() + config.attemptTimeoutSeconds * 1000,
      };
      const scheduledAttempt = attempt;
      attempt.timer = setTimeout(() => {
        if (attempt === scheduledAttempt) {
          scheduledAttempt.expired = true;
          clearAttempt();
          ctx.error = 'IAM_ATTEMPT_EXPIRED';
          if (ctx.state === 'authenticating') ctx.state = 'error';
          ctx.notify();
        }
      }, config.attemptTimeoutSeconds * 1000);
      attempt.timer.unref?.();
      ctx.publish('SIGN_IN');
      return { view: ctx.view(), authorizationUrl };
    },

    async handleCallback(rawUrl) {
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      ctx.assertExclusive();
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
        ctx.error = 'IAM_ATTEMPT_EXPIRED';
        if (ctx.state === 'authenticating') ctx.state = 'error';
        ctx.notify();
        throw new IamError('IAM_ATTEMPT_EXPIRED', safeMessage('IAM_ATTEMPT_EXPIRED'));
      }
      let parsed;
      try {
        parsed = parseCallbackUrl(rawUrl);
      } catch (cause) {
        const code = tokenErrorMessage(cause);
        if (!attempt || !safeStateEqual(attempt.state, receivedState)) {
          throw new IamError('IAM_STATE_MISMATCH', safeMessage('IAM_STATE_MISMATCH'));
        }
        if (code === 'IAM_AUTHORIZATION_ERROR') ctx.fail(code);
        throw new IamError(code, safeMessage(code));
      }
      const { code } = parsed;
      if (!attempt || !safeStateEqual(attempt.state, receivedState)) {
        throw new IamError('IAM_STATE_MISMATCH', safeMessage('IAM_STATE_MISMATCH'));
      }
      const current = attempt;
      provider.assertAtomic(current.targetStore, current.credentials);
      if (parsed.iss !== undefined && parsed.iss !== current.metadata.issuer) {
        throw new IamError('IAM_CALLBACK_ISSUER', safeMessage('IAM_CALLBACK_ISSUER'));
      }
      // Claim the attempt synchronously before the first await. A replay must
      // never consume the same authorization code or interfere with its owner.
      current.processing = true;
      const attemptEpoch = authEpoch;
      const consumption = beginConsumption(current.metadata.issuer, current.targetStore, current.credentials, current.consumption ?? null);
      const isCurrent = () => {
        if (attempt === current && authEpoch === attemptEpoch && ctx.state === 'authenticating'
          && now() > current.expiresAt) {
          current.expired = true;
          clearAttempt();
          ctx.error = 'IAM_ATTEMPT_EXPIRED';
          ctx.state = 'error';
          ctx.notify();
        }
        return attempt === current && authEpoch === attemptEpoch && ctx.state === 'authenticating';
      };
      const interrupted = () => current.expired
        ? new IamError('IAM_ATTEMPT_EXPIRED', safeMessage('IAM_ATTEMPT_EXPIRED'))
        : new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      let issuedToken;
      let intendedGrant;
      let intendedStore;
      let writeUnconfirmed = false;
      let guardRejection;
      let authentication;
      const callbackGuard = () => {
        if (!isCurrent()) throw interrupted();
        ctx.assertExclusive();
        provider.assertAtomic(current.targetStore, current.credentials);
        if (!isCurrent()) throw interrupted();
      };
      try {
        authentication = await prepareAuthentication(current.metadata.issuer, current.targetStore, current.credentials, { expected: current.authentication, guard: callbackGuard });
        callbackGuard();
        const token = await exchangeCode({
          tokenEndpoint: current.metadata.tokenEndpoint,
          code,
          codeVerifier: current.verifier,
          clientAuthentication: authentication,
          redirectUri: current.redirectUri,
          clientId: config.clientId,
          resource: config.gatewayResource,
          fetchImpl,
          timeoutMs: config.httpTimeoutMs,
        });
        issuedToken = token;
        assertClientAuthCurrent(authentication);
        callbackGuard();
        provider.assertAtomic(current.targetStore, current.credentials);
        if (!token.idToken) {
          throw new IamError('IAM_ID_TOKEN_INVALID', safeMessage('IAM_ID_TOKEN_INVALID'));
        }
        const claims = await verifyWithJwks(token.idToken, {
          uri: current.metadata.jwksUri,
          issuer: current.metadata.issuer,
          clientId: config.clientId,
          nonce: current.nonce,
          guard: () => { callbackGuard(); assertClientAuthCurrent(authentication); },
          accessToken: token.accessToken,
        });
        assertClientAuthCurrent(authentication);
        const grant = await buildGrant(token, claims, current.metadata, nowIso(now()), authentication);
        assertClientAuthCurrent(authentication);
        if (!isCurrent()) throw interrupted();
        ctx.assertExclusive();
        provider.assertAtomic(current.targetStore, current.credentials);
        intendedStore = current.targetStore;
        intendedGrant = grant;
        writeUnconfirmed = true;
        const written = await intendedStore.write(grant, {
          guard: () => {
            provider.assertAtomic(current.targetStore, current.credentials);
            try { assertClientAuthCurrent(authentication); } catch (cause) { guardRejection = cause; throw cause; }
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
        assertClientAuthCurrent(authentication);
        provider.assertAtomic(current.targetStore, current.credentials);
        if (!isCurrent()) throw interrupted();
        // Show any owner mismatch without changing the user's stored key.
        ctx.lastGrant = grant;
        grantOwners.set(grant, current.targetStore);
        await loadGatewayCredential({ force: true });
        assertClientAuthCurrent(authentication);
        provider.assertAtomic(current.targetStore, current.credentials);
        if (!isCurrent()) throw interrupted();
        rememberAuthentication(authentication, grant);
        await loadIdentityProfile(grant);
        if (!isCurrent()) throw interrupted();
        clearAttempt();
        ctx.publish('SIGN_IN_SUCCESS');
        adoptConsumption(consumption, grant);
        return ctx.view();
      } catch (cause) {
        const guardPreventedWrite = guardRejection && cause === guardRejection;
        // A late HTTP/JWKS failure is no longer authoritative after auth changed.
        if (authentication && isCurrent()) {
          try { assertClientAuthCurrent(authentication); } catch (currentCause) { cause = currentCause; }
        }
        let cleanupUnknown = Boolean(writeUnconfirmed && !guardPreventedWrite);
        if (intendedStore && intendedGrant && !guardPreventedWrite) {
          const cleanup = await intendedStore.discardCallbackGrant(intendedGrant).catch(() => ({ ok: false }));
          if (!cleanup.ok) cleanupUnknown = true;
        }
        if (ctx.lastGrant === intendedGrant) ctx.lastGrant = null;
        if (issuedToken?.refreshToken && current.metadata.revocationEndpoint) {
          try {
            const cleanupAuthentication = await prepareAuthentication(current.metadata.issuer, current.targetStore, current.credentials, { expected: current.authentication, guard: callbackGuard });
            await revokeToken({
              revocationEndpoint: current.metadata.revocationEndpoint,
              token: issuedToken.refreshToken,
              clientAuthentication: cleanupAuthentication,
              tokenTypeHint: 'refresh_token',
              clientId: config.clientId,
              fetchImpl,
              timeoutMs: config.httpTimeoutMs,
            });
            assertClientAuthCurrent(cleanupAuthentication);
          } catch { /* no new source, no unauthenticated fallback or retry */ }
        }
        const stillCurrent = isCurrent();
        if (cleanupUnknown) {
          if (!ctx.disposed && !signingOut && (stillCurrent || (!attempt && (ctx.state === 'signed-out' || ctx.state === 'error')))) {
            if (stillCurrent) clearAttempt();
            ctx.state = 'error';
            ctx.error = 'IAM_CREDENTIALS_CLEAR_FAILED';
            ctx.notify();
          }
          throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
        }
        if (!stillCurrent || cause?.code === 'IAM_ATTEMPT_CANCELLED' || cause?.code === 'IAM_ATTEMPT_EXPIRED') {
          throw cause?.code === 'IAM_ATTEMPT_EXPIRED' ? cause : interrupted();
        }
        const failureCode = tokenErrorMessage(cause);
        ctx.fail(failureCode);
        throw new IamError(failureCode, safeMessage(failureCode));
      }
    },

    async cancelSignIn() {
      consumptionWitness?.invalidate();
      if (ctx.disposed) return ctx.view();
      authEpoch += 1;
      observedPending = null;
      // A cancelled attempt no longer owns the state machine, even when it never
      // reached `authenticating` (discovery or client-auth was still pending):
      // leaving its promise registered would keep blocking background hydration.
      signInPromise = null;
      if (ctx.state !== 'authenticating') return ctx.view();
      clearAttempt();
      ctx.lastGrant = null;
      provider.gatewayEpoch += 1;
      provider.gatewaySummary = null;
      provider.gatewayLoadedAt = 0;
      return ctx.publish('CANCEL');
    },

    async signOut() {
      consumptionWitness?.invalidate();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
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
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      };
      checkDisposed();
      let expectedIssuer = ctx.knownIssuer();
      if (refreshPromise) await refreshPromise.catch(() => {});
      checkDisposed();
      let grant = null;
      const targetStore = provider.ensure();
      const targetCredentials = provider.storeCredentials;
      checkDisposed();
      const unknownSignOut = () => {
        checkDisposed();
        ctx.lastGrant = null;
        identityProfile = undefined;
        ctx.error = 'IAM_CREDENTIALS_CLEAR_FAILED';
        ctx.state = 'error';
        ctx.notify();
        return { view: ctx.view(), logoutUrl: null, revocation: 'unknown' };
      };
      try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      if (targetStore) {
        const record = await targetStore.read().catch(() => ({ ok: false, grant: null }));
        if (!record.ok) return unknownSignOut();
        try {
          // Do not let a provider mutate nested fields of the captured snapshot.
          grant = structuredClone(record.grant);
          // Explicit logout may establish issuer context through discovery below;
          // its initial client/resource check must not trust the grant's issuer.
          assertGrantBinding(grant);
          if (config.issuer) assertGrantContext(grant, expectedIssuer);
        } catch { return unknownSignOut(); }
      }
      checkDisposed();
      try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      checkDisposed();
      ctx.lastGrant = null;
      let revocation = 'skipped';
      let revocationError = null;
      let meta = metadataCache?.value;
      let revocationEndpoint = meta?.revocationEndpoint ?? config.revocationEndpoint;
      if (grant && config.discoveryUrl && (!revocationEndpoint || !config.issuer)) {
        try {
          meta = await metadata();
          revocationEndpoint = meta.revocationEndpoint ?? config.revocationEndpoint;
        } catch {
          // An explicit endpoint cannot authenticate an otherwise unbound issuer.
          if (!config.issuer) return unknownSignOut();
          revocationEndpoint = undefined;
        }
      }
      expectedIssuer = meta?.issuer || expectedIssuer;
      try { assertGrantContext(grant, expectedIssuer); } catch { return unknownSignOut(); }
      checkDisposed();
      // A locally authenticated session must not clear a grant that another
      // process replaced; the check needs no client secret.
      if (sessionAuthentication && grant
        && (sessionAuthentication.credentials !== targetCredentials
          || !isDeepStrictEqual(sessionAuthentication.identity, grantIdentity(grant)))) {
        return unknownSignOut();
      }
      // D1 (2026-11-04): revoke the local access token with a GET that carries
      // the token itself and no client authentication. A missing client secret
      // must not stop sign-out, and the refresh token cannot be revoked here.
      const revokeCurrent = async (current) => {
        checkDisposed();
        provider.assertAtomic(targetStore, targetCredentials);
        checkDisposed();
        assertGrantContext(current, expectedIssuer);
        grant = current;
        if (revocationEndpoint && current?.accessToken) {
          const outcome = await revokeAccessToken({
            revocationEndpoint,
            accessToken: current.accessToken,
            fetchImpl,
            timeoutMs: Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS),
          });
          revocation = outcome.state;
          if (outcome.code) revocationError = outcome.code;
        }
      };
      try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      checkDisposed();
      const cleared = targetStore
        ? await targetStore.signOutSnapshot(grant, async (current) => {
          await revokeCurrent(current);
          checkDisposed();
          provider.assertAtomic(targetStore, targetCredentials);
          checkDisposed();
        })
        : { ok: false };
      checkDisposed();
      try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      if (!cleared.ok || !['cleared', 'absent'].includes(cleared.decision)) return unknownSignOut();
      checkDisposed();
      // Sign-out keeps the gateway credential, but the summary must stop
      // claiming it matches the (now absent) session.
      await loadGatewayCredential({ force: true });
      checkDisposed();
      try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
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
      try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
      checkDisposed();
      sessionAuthentication = null;
      identityProfile = undefined;
      // Three states stay distinct: confirmed, rejected, and unconfirmed.
      const nextError = revocation === 'failed' ? 'IAM_REVOCATION_FAILED'
        : revocation === 'unknown' ? 'IAM_REVOCATION_UNKNOWN' : null;
      if (ctx.state !== 'unconfigured' && ctx.state !== 'signed-out') {
        ctx.publish('SIGN_OUT', nextError);
      } else {
        ctx.error = nextError;
        ctx.notify();
      }
      return { view: ctx.view(), logoutUrl, revocation, revocationError };
    },

    /**
     * Read (or lazily mint) the loopback bridge capability. The value lives in
     * the credential store, so a caller must already be able to read that store
     * to obtain it; this is not a second authorization model.
     */
    async bridgeCapability() {
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      const credentials = provider.storeCredentials;
      if (!credentials || typeof credentials.resolve !== 'function' || typeof credentials.set !== 'function') {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      const existing = await credentials.resolve(BRIDGE_REF);
      if (typeof existing?.value === 'string' && existing.value.length > 0) return existing.value;
      const secret = randomBytes(32).toString('base64url');
      await credentials.set(BRIDGE_REF, secret);
      return secret;
    },

    /** Alias of `resolveToken()` for the documented cross-module read surface. */
    getAccessToken() {
      return this.resolveToken();
    },

    async resolveToken() {
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (signingOut || ctx.state === 'authenticating') {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
      }
      const expectedIssuer = ctx.knownIssuer();
      const useSharedRefresh = async (checkBefore = true) => {
        if (checkBefore && (!expectedIssuer || refreshPromiseIssuer !== expectedIssuer)) {
          throw new IamError('IAM_GRANT_CONTEXT_MISMATCH', safeMessage('IAM_GRANT_CONTEXT_MISMATCH'));
        }
        const shared = refreshPromise;
        const sharedStore = refreshPromiseStore;
        const sharedCredentials = refreshPromiseCredentials;
        const sharedAuthentication = refreshPromiseAuthentication;
        const sharedSessionEpoch = sessionEpoch;
        const sharedAuthEpoch = authEpoch;
        const checkLifecycle = () => {
          if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
          if (signingOut || ctx.state === 'authenticating' || sessionEpoch !== sharedSessionEpoch || authEpoch !== sharedAuthEpoch) {
            throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
          }
        };
        const checkProvider = () => {
          checkLifecycle();
          ctx.assertExclusive();
          checkLifecycle();
          const current = provider.ensure();
          checkLifecycle();
          if (current !== sharedStore || provider.storeCredentials !== sharedCredentials) {
            // Do not clear a newer provider's independently published session.
            if (ctx.lastGrant && grantOwners.get(ctx.lastGrant) === sharedStore) {
              ctx.lastGrant = null;
              if (ctx.state === 'ready' || ctx.state === 'expired' || ctx.state === 'unreachable') {
                ctx.state = 'error';
                ctx.error = 'IAM_CREDENTIALS_UNAVAILABLE';
                ctx.notify();
              }
            }
            throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
          }
        };
        let authentication;
        if (checkBefore) {
          checkProvider();
          if (config.authMode === 'confidential') {
            const latest = await sharedStore.read();
            checkProvider();
            if (!latest.ok || !latest.grant) throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
            assertGrantContext(latest.grant, expectedIssuer);
            authentication = await prepareAuthentication(expectedIssuer, sharedStore, sharedCredentials, { grant: latest.grant, expected: sharedAuthentication?.value ?? sessionAuthentication, guard: checkProvider });
          }
        }
        const token = await shared;
        checkProvider();
        if (config.authMode === 'confidential' && !authentication) {
          authentication = await prepareAuthentication(expectedIssuer, sharedStore, sharedCredentials, { expected: sharedAuthentication?.value, guard: checkProvider });
        }
        assertClientAuthCurrent(authentication);
        checkProvider();
        return token;
      };
      if (refreshPromise) return useSharedRefresh();
      const epoch = sessionEpoch;
      const auth = authEpoch;
      const targetStore = provider.require();
      const targetCredentials = provider.storeCredentials;
      const grantAtStart = ctx.lastGrant;
      const consumption = beginConsumption(expectedIssuer, targetStore, targetCredentials);
      let refreshing = false;
      let operationGrant = null;
      let authentication;
      const alive = () => !ctx.disposed && !signingOut && epoch === sessionEpoch
        && auth === authEpoch && ctx.state !== 'authenticating';
      const checkLifecycle = () => {
        if (!alive()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
        ctx.assertExclusive();
        if (refreshing) provider.assertAtomic(targetStore, targetCredentials);
      };
      const checkAlive = () => { checkLifecycle(); assertClientAuthCurrent(authentication); };
      const rejectSession = (code = 'IAM_REAUTH_REQUIRED') => {
        // A late failure belongs to its original provider, not a newer session.
        const current = provider.ensure();
        if (!(code === 'IAM_NOT_SIGNED_IN' && ctx.state === 'signed-out')
          && alive() && current === targetStore && provider.storeCredentials === targetCredentials
          && (!ctx.lastGrant || ctx.lastGrant === grantAtStart
            || (operationGrant && sameGrantIgnoringRefreshMarker(ctx.lastGrant, operationGrant)))) {
          observedPending = null;
          ctx.lastGrant = null;
          ctx.state = 'error';
          ctx.error = code;
          ctx.notify();
        }
        throw new IamError(code, safeMessage(code));
      };
      const useGrant = (grant) => {
        checkAlive();
        // A read from a revoked/replaced provider must not authorize a token.
        // This identity check does not claim the provider has atomic storage.
        if (provider.ensure() !== targetStore || provider.storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
        }
        checkAlive();
        assertGrantContext(grant, expectedIssuer);
        if (!grant?.accessToken || grant.refreshOperation?.state === 'pending' || isAccessExpired(grant, now())) return rejectSession();
        observedPending = null;
        rememberAuthentication(authentication, grant);
        ctx.lastGrant = grant;
        grantOwners.set(grant, targetStore);
        lastBackgroundRefreshAt = 0;
        ctx.state = 'ready';
        ctx.error = null;
        adoptConsumption(consumption, grant);
        ctx.notify();
        return grant.accessToken;
      };
      // Do not make signOut wait for an unrelated, possibly stalled initial read.
      let record;
      try {
        record = await targetStore.read();
      } catch {
        if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
        return rejectSession('IAM_CREDENTIALS_UNAVAILABLE');
      }
      if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
      const currentStore = provider.ensure();
      if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
      if (currentStore !== targetStore || provider.storeCredentials !== targetCredentials) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      if (refreshPromise) return useSharedRefresh();
      refreshPromiseStore = targetStore;
      refreshPromiseCredentials = targetCredentials;
      refreshPromiseIssuer = expectedIssuer;
      const flightAuthentication = {};
      refreshPromiseAuthentication = flightAuthentication;
      const flight = Promise.resolve().then(async () => {
        try {
          checkAlive();
          if (!record.ok) return rejectSession('IAM_INVALID_GRANT');
          if (!record.grant) return rejectSession('IAM_NOT_SIGNED_IN');
          operationGrant = record.grant;
          assertGrantContext(record.grant, expectedIssuer);
          const initial = record.grant;
          authentication = await prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: initial, guard: checkLifecycle });
          checkAlive();
          flightAuthentication.value = clientAuthDescriptor(authentication);
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
            if ((!ctx.lastGrant || ctx.lastGrant === grantAtStart || sameGrantIgnoringRefreshMarker(ctx.lastGrant, pending))
              && (ctx.state !== 'error' || ctx.error === 'IAM_REAUTH_REQUIRED')) {
              ctx.lastGrant = null;
              observedPending = null;
              ctx.state = 'error';
              ctx.error = 'IAM_REAUTH_REQUIRED';
              ctx.notify();
            }
            const operation = pending.refreshOperation;
            const identity = grantIdentity(pending);
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
              assertGrantContext(latest.grant, expectedIssuer);
              const marker = latest.grant.refreshOperation;
              const latestIdentity = grantIdentity(latest.grant);
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
          assertGrantContext(initial, meta.issuer);
          const keys = await jwks(meta.jwksUri);
          checkAlive();
          const operationId = randomToken(32);
          const operation = { version: 1, state: 'pending', id: operationId, base: refreshBaseId(initial, operationId) };
          let claimed = false;
          let claimedGrant = null;
          const claim = await targetStore.mutate((current) => {
            checkAlive();
            if (!current) return undefined;
            assertGrantContext(current, meta.issuer);
            if (current.refreshOperation?.state === 'pending' || !isDeepStrictEqual(current, initial)) return undefined;
            if (!shouldRefresh(current, now(), config.refreshSkewSeconds) || !isRefreshUsable(current, now())) return undefined;
            claimed = true;
            claimedGrant = current;
            return { ...current, refreshOperation: operation };
          }, { guard: () => { checkAlive(); return true; } });
          checkAlive();
          const claimedRecord = claim.record?.kind === 'grant' ? claim.record.payload : null;
          if (!claimed) {
            const latest = await targetStore.read();
            checkAlive();
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
            const identity = grantIdentity;
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
          // Re-read the original pin for this POST, outside the provider lock.
          authentication = await prepareAuthentication(meta.issuer, targetStore, targetCredentials, { grant: initial, expected: flightAuthentication.value, guard: checkLifecycle });
          checkAlive();
          const token = await refreshTokens({
            tokenEndpoint: meta.tokenEndpoint,
            refreshToken: claimedGrant.refreshToken,
            clientAuthentication: authentication,
            clientId: config.clientId,
            resource: config.gatewayResource,
            fetchImpl,
            timeoutMs: Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS),
          });
          checkAlive();
          // C9（2026-11-03 书面答复）已确认轮换：旧刷新令牌即时作废、重用只拒本次请求。
          // 因此响应里缺少新令牌、或原样返回旧令牌，都说明这条授权链不能再续用；
          // 不得把已经发出的刷新令牌当成可以再次使用。
          if (!token.refreshToken || token.refreshToken === claimedGrant.refreshToken) return rejectSession();
          let claims = null;
          if (token.idToken) {
            const verifyOptions = { issuer: meta.issuer, clientId: config.clientId,
              accessToken: token.accessToken, skewSeconds: ID_TOKEN_CLOCK_SKEW_SECONDS, now: now() };
            try {
              claims = verifyIdToken(token.idToken, { ...verifyOptions, jwks: keys });
            } catch (cause) {
              if (cause?.code !== 'IAM_JWKS_KEY_NOT_FOUND') throw cause;
              claims = await verifyWithJwks(token.idToken, { uri: meta.jwksUri, ...verifyOptions, guard: checkAlive });
            }
          }
          checkAlive();
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
          }, { guard: () => { checkAlive(); return true; } });
          checkAlive();
          if (!committed || result.record?.kind !== 'grant'
            || !isDeepStrictEqual(result.record.payload, next)) return rejectSession();
          return useGrant(next);
        } catch (cause) {
          if (!alive()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
          try { checkAlive(); } catch (currentCause) { cause = currentCause; }
          if (['IAM_GRANT_CONTEXT_MISMATCH', 'IAM_CLIENT_AUTH_CONTEXT_INVALID', 'IAM_CLIENT_AUTH_CHANGED', 'IAM_CLIENT_AUTH_UNVERIFIED', 'IAM_NOT_SIGNED_IN', 'IAM_INVALID_GRANT', 'IAM_ATOMIC_STORE_UNVERIFIED', 'IAM_CREDENTIALS_UNAVAILABLE'].includes(cause?.code)) {
            return rejectSession(cause.code);
          }
          // Once a request might have been sent, pending remains authoritative;
          // do not erase it or fall back to an old access token.
          return rejectSession();
        }
      }).finally(() => {
        if (refreshPromise !== flight) return;
        refreshPromise = null;
        refreshPromiseAuthentication = null;
        refreshPromiseStore = null;
        refreshPromiseCredentials = null;
        refreshPromiseIssuer = null;
      });
      refreshPromise = flight;
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
      ctx.addListener(listener);
      stopWaiters.add(stop);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        yield ctx.view();
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
        ctx.removeListener(listener);
        stopWaiters.delete(stop);
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async dispose() {
      consumptionWitness?.dispose();
      if (ctx.disposed) return;
      ctx.disposed = true;
      modelSelectionQueued = false;
      sessionEpoch += 1;
      authEpoch += 1;
      observedPending = null;
      clearAttempt();
      // Stop subscribers before any await so unload cannot leave a watch()
      // caller parked forever. dispose() is lifecycle cleanup, not logout:
      // persisted credentials are cleared only by an explicit signOut() or by
      // the enterprise uninstall flow.
      ctx.clearListeners();
      for (const stop of [...stopWaiters]) stop();
      stopWaiters.clear();
      ctx.lastGrant = null;
      sessionAuthentication = null;
      identityProfile = undefined;
      provider.gatewaySummary = null;
      ctx.state = 'signed-out';
      ctx.error = null;
      // Lifecycle cleanup only: the grant and the user's gateway credential
      // stay stored, so unload cannot silently discard them.
    },
  };

  consumptionWitness?.register(service);
  return service;
}