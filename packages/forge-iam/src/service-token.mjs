import { assertClientAuthCurrent, clientAuthDescriptor } from './client-auth.mjs';
import { isDeepStrictEqual } from 'node:util';
import { IamError } from './errors.mjs';
import { credentialReadError } from './error-contract.mjs';
import { randomToken, refreshTokens, verifyIdToken } from './oidc.mjs';
import { isAccessExpired, isRefreshUsable, renewalDeadline, renewalSkewMillis, shouldRefresh } from './record.mjs';
import { AUTO_REFRESH_BACKOFF_MS, grantIdentity, ID_TOKEN_CLOCK_SKEW_SECONDS, nowIso, refreshBaseId, REFRESH_TIMEOUT_MS, safeMessage, sameGrantIgnoringRefreshMarker } from './service-helpers.mjs';

/**
 * The single-flight refresh: one promise per provider, and every caller that
 * arrives while it runs joins it instead of minting a second token.
 *
 * The flight records the store, credentials, issuer and client-authentication
 * descriptor it started with, so a caller that outlives a provider swap is
 * rejected rather than handed the new provider's token.
 */
export function createTokenResolver(env) {
  const {
    config, ctx, provider, grants, now, fetchImpl, isSigningOut, getSessionEpoch, getAuthEpoch, clearObservation,
    beginConsumption, adoptConsumption,
  } = env;

  let refreshPromise = null;
  let refreshPromiseStore = null;
  let refreshPromiseCredentials = null;
  let refreshPromiseIssuer = null;
  let refreshPromiseAuthentication = null;
  let refreshPromisePending = null;
  let lastBackgroundRefreshAt = 0;
  let backgroundRefreshBinding = null;
  let renewal = null;

  function rememberBackgroundRefresh(at) {
    lastBackgroundRefreshAt = at;
    const grant = ctx.lastGrant;
    backgroundRefreshBinding = at && grant ? {
      auth: getAuthEpoch(), session: getSessionEpoch(), identity: grantIdentity(grant),
      refreshToken: grant.refreshToken,
      store: provider.store, credentials: provider.storeCredentials,
    } : null;
  }

  function currentBackgroundRefreshAt() {
    const binding = backgroundRefreshBinding;
    const grant = ctx.lastGrant;
    return binding && grant && binding.auth === getAuthEpoch() && binding.session === getSessionEpoch()
      && binding.store === provider.store && binding.credentials === provider.storeCredentials
      && binding.refreshToken === grant.refreshToken
      && isDeepStrictEqual(binding.identity, grantIdentity(grant)) ? lastBackgroundRefreshAt : 0;
  }

  function cancelRenewal() {
    if (renewal) clearTimeout(renewal.timer);
    renewal = null;
  }

  // Only the exact pending record this Host is currently writing can be
  // joined. A different process's pending record remains unconfirmed.
  function ownedPendingFlight(store, credentials, grant) {
    return refreshPromise && refreshPromisePending?.store === store
      && refreshPromisePending.credentials === credentials
      && isDeepStrictEqual(refreshPromisePending.grant, grant) ? refreshPromise : null;
  }

  // The Host owns the timer; the callback enters the existing single-flight
  // resolver and therefore uses the same provider and rotation checks.
  function scheduleRenewal({ retry = false } = {}) {
    const grant = ctx.lastGrant;
    const currentTime = now();
    const recovering = ctx.state === 'expired';
    const refreshExpiry = Date.parse(grant?.refreshExpiresAt);
    const expiry = recovering
      ? (Number.isFinite(refreshExpiry) ? refreshExpiry : Infinity)
      : renewalDeadline(grant, currentTime);
    if (ctx.disposed || !['ready', 'expired'].includes(ctx.state) || isSigningOut() || !grant
      || grant.refreshOperation?.state === 'pending' || !isRefreshUsable(grant, currentTime)
      || (expiry !== Infinity && !Number.isFinite(expiry)) || expiry <= currentTime) {
      cancelRenewal();
      return;
    }
    const auth = getAuthEpoch();
    const session = getSessionEpoch();
    const identity = grantIdentity(grant);
    const targetStore = grants.ownerOf(grant);
    const targetCredentials = provider.storeCredentials;
    if (!targetStore || provider.store !== targetStore || !targetCredentials) {
      cancelRenewal();
      return;
    }
    const remaining = expiry - currentTime;
    const lead = Math.min(renewalSkewMillis(grant, config.refreshSkewSeconds, currentTime), Math.floor(remaining / 2));
    let delay = retry || recovering
      ? Math.min(AUTO_REFRESH_BACKOFF_MS, Math.max(1000, Math.floor(remaining / 2))) : remaining - lead;
    const sameBackoff = renewal?.backoff && renewal.auth === auth && renewal.session === session
      && renewal.targetStore === targetStore && renewal.targetCredentials === targetCredentials
      && renewal.refreshToken === grant.refreshToken
      && isDeepStrictEqual(renewal.identity, identity);
    // A view notification must not turn a scheduled backoff into an earlier
    // normal renewal. Preserve its deadline even if the view became expired.
    if (!retry && sameBackoff) delay = Math.max(0, renewal.runAt - currentTime);
    // Never schedule a retry after the only known refresh token has expired.
    if ((retry || recovering) && Number.isFinite(refreshExpiry) && currentTime + delay >= refreshExpiry) {
      cancelRenewal();
      return;
    }
    if (!retry && renewal && renewal.expiry === expiry && renewal.auth === auth && renewal.session === session
      && renewal.targetStore === targetStore && renewal.targetCredentials === targetCredentials
      && renewal.refreshToken === grant.refreshToken
      && renewal.recovering === recovering && isDeepStrictEqual(renewal.identity, identity)
      && renewal.runAt <= currentTime + delay) return;
    cancelRenewal();
    const scheduled = { expiry, auth, session, identity, recovering, targetStore, targetCredentials,
      refreshToken: grant.refreshToken, grant: structuredClone(grant),
      backoff: Boolean(retry || recovering || sameBackoff), runAt: currentTime + delay, timer: null };
    renewal = scheduled;
    scheduled.timer = setTimeout(() => {
      if (renewal !== scheduled) return;
      renewal = null;
      const stillCurrent = () => {
        const current = ctx.lastGrant;
        const currentRefreshExpiry = Date.parse(current?.refreshExpiresAt);
        const currentExpiry = recovering
          ? (Number.isFinite(currentRefreshExpiry) ? currentRefreshExpiry : Infinity)
          : renewalDeadline(current, now());
        return !ctx.disposed && ctx.state === (recovering ? 'expired' : 'ready') && !isSigningOut() && current
          && getAuthEpoch() === auth && getSessionEpoch() === session && currentExpiry === expiry
          && current.refreshToken === scheduled.refreshToken
          && isDeepStrictEqual(grantIdentity(current), identity);
      };
      if (!stillCurrent()) return;
      if (provider.ensure() !== targetStore || provider.storeCredentials !== targetCredentials || !stillCurrent()) return;
      if (now() < scheduled.runAt) { scheduleRenewal({ retry }); return; }
      void resolveToken(scheduled).catch((cause) => {
        if (cause?.code === 'IAM_UNREACHABLE') scheduleRenewal({ retry: true });
      });
    }, Math.min(delay, 2_147_483_647));
    scheduled.timer.unref?.();
  }

  async function resolveToken(expected) {
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (isSigningOut() || ctx.state === 'authenticating') {
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
    }
    const checkExpected = () => {
      if (!expected) return;
      if (ctx.disposed || isSigningOut() || ctx.state !== (expected.recovering ? 'expired' : 'ready')
        || getAuthEpoch() !== expected.auth || getSessionEpoch() !== expected.session || !ctx.lastGrant
        || ctx.lastGrant.refreshToken !== expected.refreshToken
        || !isDeepStrictEqual(grantIdentity(ctx.lastGrant), expected.identity)) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
      }
    };
    checkExpected();
    const expectedIssuer = ctx.knownIssuer();
    const useSharedRefresh = async (checkBefore = true) => {
      if (checkBefore && (!expectedIssuer || refreshPromiseIssuer !== expectedIssuer)) {
        throw new IamError('IAM_GRANT_CONTEXT_MISMATCH', safeMessage('IAM_GRANT_CONTEXT_MISMATCH'));
      }
      const shared = refreshPromise;
      const sharedStore = refreshPromiseStore;
      const sharedCredentials = refreshPromiseCredentials;
      const sharedAuthentication = refreshPromiseAuthentication;
      const sharedSessionEpoch = getSessionEpoch();
      const sharedAuthEpoch = getAuthEpoch();
      const checkLifecycle = () => {
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
        if (isSigningOut() || ctx.state === 'authenticating' || getSessionEpoch() !== sharedSessionEpoch || getAuthEpoch() !== sharedAuthEpoch) {
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
          if (ctx.lastGrant && grants.ownerOf(ctx.lastGrant) === sharedStore) {
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
          grants.assertGrantContext(latest.grant, expectedIssuer);
          authentication = await grants.prepareAuthentication(expectedIssuer, sharedStore, sharedCredentials, { grant: latest.grant, expected: sharedAuthentication?.value ?? ctx.sessionAuthentication, guard: checkProvider });
        }
      }
      const token = await shared;
      checkProvider();
      if (config.authMode === 'confidential' && !authentication) {
        authentication = await grants.prepareAuthentication(expectedIssuer, sharedStore, sharedCredentials, { expected: sharedAuthentication?.value, guard: checkProvider });
      }
      assertClientAuthCurrent(authentication);
      checkProvider();
      return token;
    };
    if (refreshPromise && expected
      && (refreshPromiseStore !== expected.targetStore || refreshPromiseCredentials !== expected.targetCredentials)) {
      throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    }
    if (refreshPromise) return useSharedRefresh();
    const epoch = getSessionEpoch();
    const auth = getAuthEpoch();
    const targetStore = provider.require();
    const targetCredentials = provider.storeCredentials;
    checkExpected();
    if (expected && (targetStore !== expected.targetStore || targetCredentials !== expected.targetCredentials)) {
      throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    }
    const grantAtStart = ctx.lastGrant;
    const consumption = beginConsumption(expectedIssuer, targetStore, targetCredentials);
    let refreshing = false;
    let refreshWriteAttempted = false;
    let unclaimedLockTimeout = false;
    let waitingForPending = false;
    let operationGrant = null;
    const staleBackground = expected ? new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed') : null;
    let authentication;
    const alive = () => !ctx.disposed && !isSigningOut() && epoch === getSessionEpoch()
      && auth === getAuthEpoch() && ctx.state !== 'authenticating';
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
        clearObservation();
        ctx.lastGrant = null;
        ctx.state = 'error';
        ctx.error = code;
        ctx.notify();
      }
      throw new IamError(code, safeMessage(code));
    };
    const useGrant = (grant) => {
      checkAlive();
      // Authentication and store reads can yield while a newer session is
      // adopted. A background flight must never publish over that session.
      if (expected && (ctx.lastGrant
        ? !isDeepStrictEqual(ctx.lastGrant, grantAtStart)
        : !waitingForPending || ctx.state !== 'error' || ctx.error !== 'IAM_REAUTH_REQUIRED')) {
        throw staleBackground;
      }
      // A read from a revoked/replaced provider must not authorize a token.
      // This identity check does not claim the provider has atomic storage.
      if (provider.ensure() !== targetStore || provider.storeCredentials !== targetCredentials) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      checkAlive();
      grants.assertGrantContext(grant, expectedIssuer);
      if (!grant?.accessToken || grant.refreshOperation?.state === 'pending' || isAccessExpired(grant, now())) return rejectSession();
      clearObservation();
      grants.rememberAuthentication(authentication, grant);
      ctx.lastGrant = grant;
      grants.own(grant, targetStore);
      rememberBackgroundRefresh(0);
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
    } catch (cause) {
      if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
      const unchanged = provider.ensure() === targetStore && provider.storeCredentials === targetCredentials;
      return rejectSession(unchanged ? credentialReadError(cause) : 'IAM_CREDENTIALS_UNAVAILABLE');
    }
    if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
    const currentStore = provider.ensure();
    if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
    checkExpected();
    if (currentStore !== targetStore || provider.storeCredentials !== targetCredentials) {
      throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    }
    const completeMarker = record.grant?.refreshOperation;
    const completedExpected = expected && record.ok && record.grant
      && completeMarker?.state === 'complete'
      && isDeepStrictEqual(grantIdentity(record.grant), expected.identity)
      && record.grant.refreshToken !== expected.refreshToken
      && completeMarker.base === refreshBaseId(expected.grant, completeMarker.id)
      && !isAccessExpired(record.grant, now()) && isRefreshUsable(record.grant, now());
    if (expected && (!record.ok || !record.grant
      || !isDeepStrictEqual(grantIdentity(record.grant), expected.identity)
      || (record.grant.refreshToken !== expected.refreshToken && !completedExpected))) {
      // A different session may have been written without a local notification.
      // Do not claim it or discard it on behalf of this stale background timer.
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
    }
    if (refreshPromise && expected
      && (refreshPromiseStore !== expected.targetStore || refreshPromiseCredentials !== expected.targetCredentials)) {
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
        grants.assertGrantContext(record.grant, expectedIssuer);
        const initial = record.grant;
        authentication = await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: initial, guard: checkLifecycle });
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
            waitingForPending = true;
            ctx.lastGrant = null;
            clearObservation();
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
            grants.assertGrantContext(latest.grant, expectedIssuer);
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
        const meta = await grants.metadata();
        checkAlive();
        grants.assertGrantContext(initial, meta.issuer);
        const keys = await grants.jwks(meta.jwksUri);
        checkAlive();
        const operationId = randomToken(32);
        const operation = { version: 1, state: 'pending', id: operationId, base: refreshBaseId(initial, operationId) };
        refreshPromisePending = { store: targetStore, credentials: targetCredentials,
          grant: { ...initial, refreshOperation: operation } };
        let claimed = false;
        let claimedGrant = null;
        let claimGateOpen = true;
        let claimCallbackUsed = false;
        refreshWriteAttempted = true;
        let claim;
        try {
          claim = await targetStore.mutate((current) => {
            // A provider that rejects and invokes its callback later must not
            // create a pending write after this flight has been abandoned.
            if (!claimGateOpen || claimCallbackUsed) return undefined;
            claimCallbackUsed = true;
            checkAlive();
            if (!current) return undefined;
            grants.assertGrantContext(current, meta.issuer);
            if (current.refreshOperation?.state === 'pending' || !isDeepStrictEqual(current, initial)) return undefined;
            if (!shouldRefresh(current, now(), config.refreshSkewSeconds) || !isRefreshUsable(current, now())) return undefined;
            claimed = true;
            claimedGrant = current;
            return { ...current, refreshOperation: operation };
          }, { guard: () => { checkAlive(); return true; } });
        } catch (cause) {
          // Once the callback runs it may have observed a different or pending
          // grant, or produced a candidate that could still commit later.
          unclaimedLockTimeout = cause?.code === 'CRED_LOCK_TIMEOUT' && !claimCallbackUsed && !claimed;
          throw cause;
        } finally {
          claimGateOpen = false;
        }
        checkAlive();
        const claimedRecord = claim.record?.kind === 'grant' ? claim.record.payload : null;
        if (!claimed) {
          const latest = await targetStore.read();
          checkAlive();
          if (!latest.ok || !latest.grant) return rejectSession();
          const latestMarker = latest.grant.refreshOperation;
          const completedFromInitial = latestMarker?.state === 'complete'
            && latestMarker.base === refreshBaseId(initial, latestMarker.id)
            && isDeepStrictEqual(grantIdentity(initial), grantIdentity(latest.grant))
            && latest.grant.refreshToken !== initial.refreshToken;
          if (expected && (!isDeepStrictEqual(grantIdentity(latest.grant), expected.identity)
            || (latest.grant.refreshToken !== expected.refreshToken && !completedFromInitial))) {
            throw staleBackground;
          }
          if (latest.grant.refreshOperation?.state === 'pending') {
            const { refreshOperation: ignoredLatest, ...latestBase } = latest.grant;
            const { refreshOperation: ignoredInitial, ...initialBase } = initial;
            const marker = latest.grant.refreshOperation;
            if (!isDeepStrictEqual(latestBase, initialBase)
              || marker.base !== refreshBaseId(initial, marker.id)) return rejectSession();
            return await waitFor(latest.grant);
          }
          if (completedFromInitial && isRefreshUsable(latest.grant, now())) {
            return useGrant(latest.grant);
          }
          // A new login without our original record binding is not our result.
          return rejectSession();
        }
        // A resolved provider call and its returned record are both required;
        // an exception or ambiguous result can never authorize the POST.
        if (!isDeepStrictEqual(claimedRecord, { ...claimedGrant, refreshOperation: operation })) return rejectSession();
        // Re-read the original pin for this POST, outside the provider lock.
        authentication = await grants.prepareAuthentication(meta.issuer, targetStore, targetCredentials, { grant: initial, expected: flightAuthentication.value, guard: checkLifecycle });
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
            claims = await grants.verifyWithJwks(token.idToken, { uri: meta.jwksUri, ...verifyOptions, guard: checkAlive });
          }
        }
        checkAlive();
        if (claims && claims.sub !== claimedGrant.subject) {
          throw new IamError('IAM_REFRESH_SUBJECT_MISMATCH', safeMessage('IAM_REFRESH_SUBJECT_MISMATCH'));
        }
        const next = grants.grantFromToken(claimedGrant, token, meta.issuer, nowIso(now()));
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
        if (staleBackground && cause === staleBackground) throw cause;
        if (!alive()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
        try { checkAlive(); } catch (currentCause) { cause = currentCause; }
        // The callback never ran, and the closed gate prevents a late callback
        // from producing a write candidate. Retry only the same adopted session;
        // keep the existing error contract for callers of this failed flight.
        if (unclaimedLockTimeout && cause?.code === 'CRED_LOCK_TIMEOUT'
          && ['ready', 'expired'].includes(ctx.state) && ctx.lastGrant && isRefreshUsable(ctx.lastGrant, now())
          && isDeepStrictEqual(ctx.lastGrant, operationGrant)
          && provider.ensure() === targetStore && provider.storeCredentials === targetCredentials
          && alive() && ['ready', 'expired'].includes(ctx.state) && ctx.lastGrant
          && isDeepStrictEqual(ctx.lastGrant, operationGrant)) {
          rememberBackgroundRefresh(now());
          if (ctx.state === 'ready' && isAccessExpired(ctx.lastGrant, now())) {
            ctx.state = 'expired';
            ctx.error = null;
            ctx.notify();
          }
          if (alive() && isDeepStrictEqual(ctx.lastGrant, operationGrant)
            && provider.store === targetStore && provider.storeCredentials === targetCredentials) {
            scheduleRenewal({ retry: true });
          }
          throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
        }
        // A transient preflight failure cannot have consumed the refresh token.
        // Keep the same session for a bounded retry, but never return expired access.
        const status = cause?.details?.status;
        const retryablePreflight = cause?.code === 'IAM_UNREACHABLE'
          || (cause?.code === 'IAM_HTTP_ERROR' && (status === 408 || status === 429 || (status >= 500 && status <= 599)));
        if (!refreshWriteAttempted && retryablePreflight
          && ['ready', 'expired'].includes(ctx.state) && ctx.lastGrant && isRefreshUsable(ctx.lastGrant, now())
          && isDeepStrictEqual(ctx.lastGrant, operationGrant)
          && provider.ensure() === targetStore && provider.storeCredentials === targetCredentials) {
          // Reconciliation and the timer share the same background backoff;
          // explicit token requests can still retry immediately.
          rememberBackgroundRefresh(now());
          if (ctx.state === 'ready' && isAccessExpired(ctx.lastGrant, now())) {
            ctx.state = 'expired';
            ctx.error = null;
            ctx.notify();
          }
          scheduleRenewal({ retry: true });
          throw cause;
        }
        if (['IAM_GRANT_CONTEXT_MISMATCH', 'IAM_CLIENT_AUTH_CONTEXT_INVALID', 'IAM_CLIENT_AUTH_CHANGED', 'IAM_CLIENT_AUTH_UNVERIFIED', 'IAM_NOT_SIGNED_IN', 'IAM_INVALID_GRANT', 'IAM_ATOMIC_STORE_UNVERIFIED', 'IAM_CREDENTIALS_UNAVAILABLE', 'CRED_KEY_UNAVAILABLE', 'CRED_DECRYPT_FAILED'].includes(cause?.code)) {
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
      refreshPromisePending = null;
    });
    refreshPromise = flight;
    return useSharedRefresh(false);
  }

  /** Alias of `resolveToken()` for the documented cross-module read surface. */
  function getAccessToken() {
    return resolveToken();
  }

  return {
    resolveToken,
    getAccessToken,
    scheduleRenewal,
    cancelRenewal,
    ownedPendingFlight,
    get inFlight() { return refreshPromise; },
    get lastBackgroundRefreshAt() { return currentBackgroundRefreshAt(); },
    set lastBackgroundRefreshAt(next) { rememberBackgroundRefresh(next); },
  };
}
