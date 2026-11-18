import { assertClientAuthCurrent, clientAuthDescriptor } from './client-auth.mjs';
import { isDeepStrictEqual } from 'node:util';
import { IamError } from './errors.mjs';
import { credentialReadError } from './error-contract.mjs';
import { OidcError, randomToken, refreshTokens, verifyIdToken } from './oidc.mjs';
import { isAccessExpired, isRefreshUsable, renewalDeadline, renewalLeadMillis, shouldRefresh } from './record.mjs';
import { AUTO_REFRESH_BACKOFF_MS, grantIdentity, ID_TOKEN_CLOCK_SKEW_SECONDS, nowIso, refreshBaseId, REFRESH_TIMEOUT_MS, RESUME_JUMP_MS, safeMessage, sameGrantIgnoringRefreshMarker } from './service-helpers.mjs';

function completedRotationOf(previous, current) {
  const marker = current?.refreshOperation;
  return previous != null && marker?.state === 'complete'
    && current.refreshToken !== previous.refreshToken
    && isDeepStrictEqual(grantIdentity(previous), grantIdentity(current))
    && marker.base === refreshBaseId(previous, marker.id);
}

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
    config, ctx, provider, grants, now, monotonic = () => performance.now(), fetchImpl, isSigningOut,
    getSessionEpoch, getAuthEpoch, clearObservation, beginConsumption, adoptConsumption,
  } = env;

  let refreshPromise = null;
  let refreshPromiseStore = null;
  let refreshPromiseCredentials = null;
  let refreshPromiseIssuer = null;
  let refreshPromiseAuthentication = null;
  let refreshPromisePending = null;
  let refreshExchange = null;
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

  function takeRefreshForSignOut() {
    const exchange = refreshExchange;
    if (!exchange) return undefined;
    exchange.signOut = true;
    return (store, credentials) => exchange.store === store && exchange.credentials === credentials
      ? { pending: exchange.pending, complete: exchange.complete } : undefined;
  }

  // A suspended host resumes with a wall clock that has moved while the
  // monotonic clock has not. A jump this large means the deadline we scheduled
  // is no longer "in the future", so the next pass must renew immediately.
  let clockBaseline = null;
  function resumeJumpMillis() {
    const wall = now();
    const monotonicNow = monotonic();
    const previous = clockBaseline;
    clockBaseline = { wall, monotonic: monotonicNow };
    if (!previous) return 0;
    const jump = (wall - previous.wall) - (monotonicNow - previous.monotonic);
    return Number.isFinite(jump) && jump > RESUME_JUMP_MS ? jump : 0;
  }

  function trustedProvider(targetStore, targetCredentials) {
    return Boolean(targetStore && targetCredentials)
      && provider.ensure() === targetStore && provider.storeCredentials === targetCredentials
      && provider.atomicVerified(targetCredentials)
      && provider.ensure() === targetStore && provider.storeCredentials === targetCredentials;
  }

  // The deadline a scheduled timer compares against: the refresh token's own
  // expiry while recovering from an expired access token, otherwise the earlier
  // of the two known deadlines.
  function deadlineOf(grant, at, recovering) {
    const refreshExpiry = Date.parse(grant?.refreshExpiresAt);
    return recovering
      ? (Number.isFinite(refreshExpiry) ? refreshExpiry : Infinity)
      : renewalDeadline(grant, at);
  }

  function armTimer(scheduled, delay) {
    renewal = scheduled;
    scheduled.timer = setTimeout(() => {
      if (renewal !== scheduled) return;
      renewal = null;
      onRenewalDue(scheduled);
    }, Math.min(delay, 2_147_483_647));
    scheduled.timer.unref?.();
  }

  function onRenewalDue(scheduled) {
    const { recovering, targetStore, targetCredentials, auth, session, identity, expiry } = scheduled;
    const stillCurrent = () => {
      const current = ctx.lastGrant;
      return !ctx.disposed && ctx.state === (recovering ? 'expired' : 'ready') && !isSigningOut() && current
        && getAuthEpoch() === auth && getSessionEpoch() === session
        && deadlineOf(current, now(), recovering) === expiry
        && current.refreshToken === scheduled.refreshToken
        && isDeepStrictEqual(grantIdentity(current), identity);
    };
    // A withdrawn trust binding must stop this timer: renewal resumes only when
    // the host re-publishes a verified pair (see index.mjs hydrateBinding()).
    if (!stillCurrent() || !trustedProvider(targetStore, targetCredentials)) return;
    if (now() < scheduled.runAt) { scheduleRenewal({ retry: scheduled.backoff === true }); return; }
    void resolveToken(scheduled).catch((cause) => {
      if (cause?.code === 'IAM_UNREACHABLE') scheduleRenewal({ retry: true });
    });
  }

  // The Host owns the timer; the callback enters the existing single-flight
  // resolver and therefore uses the same provider and rotation checks.
  function scheduleRenewal({ retry = false } = {}) {
    const grant = ctx.lastGrant;
    const currentTime = now();
    // Observe the clock on every pass: the first activity after a suspension is
    // where a deadline that passed while asleep has to become a renewal.
    const resumed = resumeJumpMillis() > 0;
    const recovering = ctx.state === 'expired';
    const refreshExpiry = Date.parse(grant?.refreshExpiresAt);
    const expiry = deadlineOf(grant, currentTime, recovering);
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
    // Revoking trust stops renewal here; a later verified binding re-arms it.
    if (!trustedProvider(targetStore, targetCredentials)
      || ctx.lastGrant !== grant || ctx.disposed || isSigningOut()
      || ctx.state !== (recovering ? 'expired' : 'ready')
      || getAuthEpoch() !== auth || getSessionEpoch() !== session) {
      cancelRenewal();
      return;
    }
    // A suspended host is the one case where the normal schedule cannot help:
    // the access token already lapsed, so renew now and keep the timer below as
    // the fallback. Single-flight and the shared backoff bound the extra work.
    if (resumed && !retry && recovering && isAccessExpired(grant, currentTime)) {
      void resolveToken().catch(() => {});
    }
    const remaining = expiry - currentTime;
    const lead = renewalLeadMillis(grant, expiry, currentTime, config.refreshSkewSeconds);
    let delay = retry || recovering
      ? Math.min(AUTO_REFRESH_BACKOFF_MS, Math.max(1000, Math.floor(remaining / 2))) : Math.max(0, remaining - lead);
    const sameBackoff = renewal?.backoff && renewal.auth === auth && renewal.session === session
      && renewal.targetStore === targetStore && renewal.targetCredentials === targetCredentials
      && renewal.refreshToken === grant.refreshToken
      && isDeepStrictEqual(renewal.identity, identity);
    // A view notification must not turn a scheduled backoff into an earlier
    // normal renewal. Preserve its deadline even if the view became expired.
    if (!retry && sameBackoff) delay = Math.max(0, renewal.runAt - currentTime);
    // Never schedule a retry after the only known refresh token has expired:
    // the access token may legitimately lapse while its retry is pending.
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
      refreshToken: grant.refreshToken, grant: structuredClone(grant), renewalDue: true,
      backoff: Boolean(retry || recovering || sameBackoff), runAt: currentTime + delay, timer: null };
    armTimer(scheduled, delay);
  }

  function publishGrant(grant, targetStore, authentication, consumption, { expired = false, restored = false } = {}) {
    clearObservation();
    grants.rememberAuthentication(authentication, grant);
    ctx.lastGrant = grant;
    grants.own(grant, targetStore);
    rememberBackgroundRefresh(restored ? now() : 0);
    ctx.state = expired ? 'expired' : 'ready';
    ctx.error = null;
    adoptConsumption(consumption, grant);
    ctx.notify();
  }

  async function resolveToken(expected) {
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (isSigningOut() || ctx.state === 'authenticating') {
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
    }
    const checkExpected = (allowCompleted = false) => {
      if (!expected) return;
      // Publishing the old AT's expiry while the store read is pending does
      // not replace the session or invalidate its refresh claim.
      const expectedState = ctx.state === (expected.recovering ? 'expired' : 'ready')
        || (!expected.recovering && ctx.state === 'expired' && isAccessExpired(ctx.lastGrant, now()));
      const current = ctx.lastGrant;
      if (ctx.disposed || isSigningOut() || getAuthEpoch() !== expected.auth || getSessionEpoch() !== expected.session
        || !current || !isDeepStrictEqual(grantIdentity(current), expected.identity)) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
      }
      if (expectedState && current.refreshToken === expected.refreshToken) return;
      if (allowCompleted && ctx.state === 'ready' && completedRotationOf(expected.grant, current)
        && !isAccessExpired(current, now())) return current;
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
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
    const staleSession = new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
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
    const unsent = new IamError('IAM_UNREACHABLE', safeMessage('IAM_UNREACHABLE'));
    const useGrant = (grant, restored = false) => {
      checkAlive();
      // Authentication and store reads can yield while a newer session is
      // adopted. A background flight must never publish over that session.
      if (expected && (ctx.lastGrant
        ? !isDeepStrictEqual(ctx.lastGrant, grantAtStart)
        : !waitingForPending || ctx.state !== 'error' || ctx.error !== 'IAM_REAUTH_REQUIRED')) {
        throw staleSession;
      }
      // A read from a revoked/replaced provider must not authorize a token.
      // This identity check does not claim the provider has atomic storage.
      if (provider.ensure() !== targetStore || provider.storeCredentials !== targetCredentials) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      checkAlive();
      grants.assertGrantContext(grant, expectedIssuer);
      const expired = isAccessExpired(grant, now());
      if (grant.refreshOperation?.state === 'pending' || (expired && !(restored && isRefreshUsable(grant, now())))) return rejectSession();
      publishGrant(grant, targetStore, authentication, consumption, { expired, restored });
      if (restored) scheduleRenewal({ retry: true });
      if (expired) throw unsent;
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
    const assertReadLifecycle = () => {
      if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
    };
    const checkReadContext = () => {
      assertReadLifecycle();
      ctx.assertExclusive();
      const currentStore = provider.ensure();
      assertReadLifecycle();
      if (currentStore !== targetStore || provider.storeCredentials !== targetCredentials) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
    };
    checkReadContext();
    const readOriginal = !expected && record.ok && grantAtStart && isDeepStrictEqual(record.grant, grantAtStart);
    const checkLocalCompletion = () => {
      if (expected) return checkExpected(true);
      const current = ctx.lastGrant;
      if (readOriginal && ctx.state === 'ready' && completedRotationOf(grantAtStart, current)
        && !isAccessExpired(current, now())) return current;
    };
    const completed = checkLocalCompletion();
    if (completed) {
      // The first read may have captured the original grant before the other
      // flight finished. Require a durable readback of the confirmed result.
      const guard = () => {
        checkReadContext();
        if (grants.ownerOf(ctx.lastGrant) !== targetStore || !isDeepStrictEqual(checkLocalCompletion(), completed)) {
          throw staleSession;
        }
        const pending = refreshPromisePending;
        if (pending?.store === targetStore && pending.grant.refreshToken === completed.refreshToken) {
          throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
        }
      };
      let latest;
      try { latest = await targetStore.read(); }
      catch (cause) {
        guard();
        const code = credentialReadError(cause);
        throw new IamError(code, safeMessage(code));
      }
      guard();
      if (!latest.ok || !isDeepStrictEqual(latest.grant, completed)) throw staleSession;
      grants.assertGrantContext(latest.grant, expectedIssuer);
      const completedAuthentication = config.authMode === 'confidential'
        ? await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: latest.grant, guard })
        : undefined;
      assertClientAuthCurrent(completedAuthentication);
      guard();
      return latest.grant.accessToken;
    }
    const completedExpected = expected && record.ok && completedRotationOf(expected.grant, record.grant)
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
        // The host's own timer renews at half of the lifetime, earlier than the
        // foreground early-refresh window, so that pass may refresh ahead of the
        // window. A rotation adopted from another Host is already fresh and must
        // be taken as-is; every other check still runs.
        const forcedRenewal = expected?.renewalDue === true
          && initial.refreshToken === expected.refreshToken;
        authentication = await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: initial, guard: checkLifecycle });
        checkAlive();
        flightAuthentication.value = clientAuthDescriptor(authentication);
        const decisionTime = now();
        if (initial.refreshOperation?.state !== 'pending'
          && (completedExpected || (!forcedRenewal && !shouldRefresh(initial, decisionTime, config.refreshSkewSeconds))
            || (!isRefreshUsable(initial, decisionTime) && !isAccessExpired(initial, decisionTime)))) {
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
            // The observed base binds the entire pre-claim record. A
            // participating owner restores it only after proving no send.
            if (marker?.state !== 'pending' && isDeepStrictEqual(identity, latestIdentity)
              && refreshBaseId(latest.grant, operation.id) === operation.base) return useGrant(latest.grant, true);
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
            if ((!forcedRenewal && !shouldRefresh(current, now(), config.refreshSkewSeconds))
              || !isRefreshUsable(current, now())) return undefined;
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
          const decisionTime = now();
          if (isDeepStrictEqual(latest.grant, initial) && !isRefreshUsable(initial, decisionTime)
            && !isAccessExpired(initial, decisionTime)) return useGrant(initial);
          const completedFromInitial = completedRotationOf(initial, latest.grant);
          if (expected && (!isDeepStrictEqual(grantIdentity(latest.grant), expected.identity)
            || (latest.grant.refreshToken !== expected.refreshToken && !completedFromInitial))) {
            throw staleSession;
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
        const pending = { ...claimedGrant, refreshOperation: operation };
        const exchange = { store: targetStore, credentials: targetCredentials, pending, signOut: false, complete: undefined };
        refreshExchange = exchange;
        const ownsSignOut = () => !ctx.disposed && isSigningOut() && auth + 1 === getAuthEpoch()
          && epoch === getSessionEpoch() && ctx.state !== 'authenticating';
        const checkResult = () => {
          if (!exchange.signOut) return checkAlive();
          // The same Host can verify its dispatched result exclusively for
          // sign-out. It must never use normal token publication in that epoch.
          if (!ownsSignOut()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
          ctx.assertExclusive();
          provider.assertAtomic(targetStore, targetCredentials);
          assertClientAuthCurrent(authentication);
          if (!ownsSignOut()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
        };
        let token;
        try {
          token = await refreshTokens({
            tokenEndpoint: meta.tokenEndpoint,
            refreshToken: claimedGrant.refreshToken,
            clientAuthentication: authentication,
            clientId: config.clientId,
            resource: config.gatewayResource,
            fetchImpl,
            timeoutMs: Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS),
          });
        } catch (cause) {
          if (!(cause instanceof OidcError) || cause.code !== 'IAM_UNREACHABLE' || cause.details.requestUnsent !== true) throw cause;
          checkAlive();
          let restored = false;
          const result = await targetStore.mutate((current) => {
            checkAlive();
            if (!isDeepStrictEqual(current, pending)) return undefined;
            restored = true;
            return claimedGrant;
          }, { guard: () => { checkAlive(); return true; } });
          checkAlive();
          if (!restored || result.record?.kind !== 'grant' || !isDeepStrictEqual(result.record.payload, claimedGrant)) return rejectSession();
          return useGrant(claimedGrant, true);
        }
        checkResult();
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
            claims = await grants.verifyWithJwks(token.idToken, { uri: meta.jwksUri, ...verifyOptions, guard: checkResult });
          }
        }
        checkResult();
        if (claims && claims.sub !== claimedGrant.subject) {
          throw new IamError('IAM_REFRESH_SUBJECT_MISMATCH', safeMessage('IAM_REFRESH_SUBJECT_MISMATCH'));
        }
        const next = grants.grantFromToken(claimedGrant, token, meta.issuer, nowIso(now()));
        if (claims) next.subject = claims.sub;
        next.refreshOperation = { ...operation, state: 'complete' };
        exchange.complete = next;
        checkAlive();
        let committed = false;
        const result = await targetStore.mutate((current) => {
          checkAlive();
          if (!isDeepStrictEqual(current, pending)) return undefined;
          committed = true;
          return next;
        }, { guard: () => { checkAlive(); return true; } });
        checkAlive();
        if (!committed || result.record?.kind !== 'grant'
          || !isDeepStrictEqual(result.record.payload, next)) return rejectSession();
        return useGrant(next);
      } catch (cause) {
        if (cause === unsent || cause === staleSession) throw cause;
        if (!alive()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
        try { checkAlive(); } catch (currentCause) { cause = currentCause; }
        // Revoked trust before a claim cannot have consumed the refresh token.
        // Retain the session until a newly bound trusted provider can resume it.
        if (!refreshWriteAttempted && cause?.code === 'IAM_ATOMIC_STORE_UNVERIFIED') throw cause;
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
          // The preflight failed, not the session. A still-valid access token
          // keeps the conversation usable while the renewal backs off; serving
          // an expired one is never safe, so that case keeps the error.
          if (ctx.state === 'ready' && !isAccessExpired(ctx.lastGrant, now())) return ctx.lastGrant.accessToken;
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
      refreshExchange = null;
    });
    refreshPromise = flight;
    return useSharedRefresh(false);
  }

  /** Alias of `resolveToken()` for the documented cross-module read surface. */
  function getAccessToken() {
    return resolveToken();
  }

  // Model preflight is bound to the adopted login and its credential provider.
  // A successful rotation preserves that login; selecting another model does too.
  function captureModelSession() {
    const grant = ctx.lastGrant;
    if (!grant) return null;
    const auth = getAuthEpoch();
    const session = getSessionEpoch();
    const identity = grantIdentity(grant);
    const targetStore = grants.ownerOf(grant);
    const targetCredentials = provider.storeCredentials;
    const assertSession = () => {
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (isSigningOut() || getAuthEpoch() !== auth || getSessionEpoch() !== session
        || !['ready', 'expired'].includes(ctx.state) || !ctx.lastGrant
        || !isDeepStrictEqual(grantIdentity(ctx.lastGrant), identity)) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
      }
    };
    const assertCurrent = () => {
      ctx.assertExclusive();
      assertSession();
      const store = provider.ensure();
      assertSession();
      if (!targetStore || store !== targetStore || provider.storeCredentials !== targetCredentials
        || grants.ownerOf(ctx.lastGrant) !== targetStore) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
    };

    async function consumeModelGrant(consume, { signal, rotationOnly = false, beforeExpiry = false } = {}) {
      const check = () => { signal?.throwIfAborted(); assertCurrent(); };
      for (let read = 0; read < 2; read += 1) {
        check();
        const local = ctx.lastGrant;
        const claim = refreshPromisePending;
        let record;
        try { record = await targetStore.read(); }
        catch (cause) {
          check();
          const code = credentialReadError(cause);
          throw new IamError(code, safeMessage(code));
        }
        check();
        const latest = record.grant;
        const issuer = ctx.knownIssuer();
        if (!record.ok || !latest || !isDeepStrictEqual(grantIdentity(latest), identity)) {
          throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
        }
        grants.assertGrantContext(latest, issuer);
        const authentication = config.authMode === 'confidential'
          ? await grants.prepareAuthentication(issuer, targetStore, targetCredentials, { grant: latest, guard: check })
          : undefined;
        check();
        assertClientAuthCurrent(authentication);
        if (!isDeepStrictEqual(local, ctx.lastGrant) || claim !== refreshPromisePending) continue;
        if (beforeExpiry && isAccessExpired(local, now())) return false;
        if (latest.refreshOperation?.state === 'pending') {
          // A local owner may still publish success before the current lease
          // expires. A foreign pending record has no confirmed outcome here.
          if (rotationOnly && ownedPendingFlight(targetStore, targetCredentials, latest)) return false;
          throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
        }
        if (rotationOnly && !completedRotationOf(local, latest)) return false;
        if (isAccessExpired(latest, now()) || (claim?.store === targetStore && claim.grant.refreshToken === latest.refreshToken)) break;
        if (!isDeepStrictEqual(local, latest)) {
          if (rotationOnly) provider.assertAtomic(targetStore, targetCredentials);
          check();
          if (beforeExpiry && (isAccessExpired(local, now()) || isAccessExpired(latest, now()))) return false;
          const consumption = beginConsumption(issuer, targetStore, targetCredentials);
          publishGrant(latest, targetStore, authentication, consumption);
          check();
          if (!isDeepStrictEqual(ctx.lastGrant, latest) || claim !== refreshPromisePending) continue;
        }
        return consume(latest);
      }
      if (rotationOnly) return false;
      throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
    }

    return Object.freeze({
      assertCurrent,
      currentAccessToken() {
        assertCurrent();
        if (isAccessExpired(ctx.lastGrant, now())) throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
        // This is only the SDK's header snapshot. The transport must read and
        // authorize the durable grant again before it can use the network.
        return ctx.lastGrant.accessToken;
      },
      waitForCompletedRotation(signal, recheckDelay) {
        const previous = ctx.lastGrant;
        return new Promise((resolve, reject) => {
          let recheck;
          const stop = () => {
            clearTimeout(recheck);
            ctx.removeListener(onView);
            signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => { stop(); reject(signal.reason); };
          const onView = () => {
            const latest = ctx.lastGrant;
            if (ctx.state !== 'ready' || !completedRotationOf(previous, latest)
              || isAccessExpired(latest, now())) return;
            try { assertCurrent(); } catch (cause) { stop(); reject(cause); return; }
            // A same-login completed rotation is already published. The
            // sending gate will still confirm its durable version.
            stop();
            resolve();
          };
          signal.throwIfAborted();
          ctx.addListener(onView);
          signal.addEventListener('abort', onAbort, { once: true });
          recheck = setTimeout(async () => {
            // If the first read is stalled before it can join a flight, one
            // independent read can find another Host's confirmed completion.
            if (signal.aborted || refreshPromise) return;
            try { await consumeModelGrant(() => true, { signal, rotationOnly: true }); }
            catch (cause) {
              // This auxiliary read supplies only positive evidence. The
              // normal waiter owns typed refusal and pending reconciliation.
              if (!signal.aborted && !(cause instanceof IamError)) { stop(); reject(cause); }
            }
          }, recheckDelay);
          recheck.unref?.();
          onView();
        });
      },
      withDispatchAccessToken(dispatch) {
        // Use the durable version at the last local point before send.
        return consumeModelGrant(latest => dispatch(latest.accessToken));
      },
      adoptCommittedRotation(signal) {
        return consumeModelGrant(() => true, { signal, rotationOnly: true, beforeExpiry: true });
      },
      async renew() {
        assertCurrent();
        const current = ctx.lastGrant;
        if (ctx.state === 'ready' && !isAccessExpired(current, now())) return;
        if (!isRefreshUsable(current, now())) throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
        await resolveToken({ auth, session, identity, targetStore, targetCredentials,
          recovering: ctx.state === 'expired', refreshToken: current.refreshToken, grant: current });
        assertCurrent();
        if (ctx.state !== 'ready' || isAccessExpired(ctx.lastGrant, now())) {
          throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
        }
      },
    });
  }

  return {
    resolveToken,
    getAccessToken,
    captureModelSession,
    scheduleRenewal,
    cancelRenewal,
    ownedPendingFlight,
    takeRefreshForSignOut,
    get inFlight() { return refreshPromise; },
    get lastBackgroundRefreshAt() { return currentBackgroundRefreshAt(); },
    set lastBackgroundRefreshAt(next) { rememberBackgroundRefresh(next); },
  };
}
