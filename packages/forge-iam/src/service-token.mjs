import { assertClientAuthCurrent, assertClientAuthEndpoint, clientAuthDescriptor, isClientAuthReadLockTimeout, isClientAuthReadUnavailable, withCurrentClientAuth } from './client-auth.mjs';
import { isDeepStrictEqual } from 'node:util';
import { IamError } from './errors.mjs';
import { credentialReadError } from './error-contract.mjs';
import { OidcError, randomToken, refreshTokens, verifyIdToken } from './oidc.mjs';
import { isAccessExpired, isRefreshUsable, renewalDeadline, renewalLeadMillis, shouldRefresh } from './record.mjs';
import { AUTO_REFRESH_BACKOFF_MS, grantIdentity, ID_TOKEN_CLOCK_SKEW_SECONDS, nowIso, refreshBaseId, REFRESH_TIMEOUT_MS, RESUME_JUMP_MS, safeMessage, sameGrantIgnoringRefreshMarker } from './service-helpers.mjs';
import { renewalDeadlines, renewalErrorFields, tokenEndpointFailureFields } from './session-renewal-log.mjs';
import { StoreError } from './store.mjs';

function completedRotationOf(previous, current) {
  const marker = current?.refreshOperation;
  return previous != null && marker?.state === 'complete'
    && current.refreshToken !== previous.refreshToken
    && isDeepStrictEqual(grantIdentity(previous), grantIdentity(current))
    && marker.base === refreshBaseId(previous, marker.id);
}

function refreshOutcome(pending, current) {
  const operation = pending.refreshOperation;
  const marker = current?.refreshOperation;
  if (!current || !isDeepStrictEqual(grantIdentity(pending), grantIdentity(current))) return null;
  if (marker?.state !== 'pending' && refreshBaseId(current, operation.id) === operation.base) return 'restored';
  if (marker?.version !== operation.version || marker.id !== operation.id || marker.base !== operation.base) return null;
  if (marker.state === 'pending') return isDeepStrictEqual(pending, current) ? 'pending' : null;
  return marker.state === 'complete' && current.refreshToken !== pending.refreshToken ? 'complete' : null;
}

const unconfirmedRenewal = () => new IamError('IAM_RENEWAL_UNCONFIRMED', safeMessage('IAM_RENEWAL_UNCONFIRMED'));
const changedSession = () => new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
const reauthenticationRequired = () => new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
const signOutPendingError = (code) => new IamError(code, safeMessage(code), { reason: 'sign-out-pending' });

function raceCancellation(promise, signal) {
  if (!signal) return promise;
  const onAbort = Promise.withResolvers();
  const abort = () => onAbort.reject(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return Promise.race([promise, onAbort.promise]).finally(() => signal.removeEventListener('abort', abort));
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
    getSessionEpoch, getAuthEpoch, clearObservation, rememberPendingSignOut, pendingObservationFor, beginConsumption, adoptConsumption, logRenewal, deferRead,
  } = env;

  let refreshPromise = null;
  let refreshPromiseStore = null;
  let refreshPromiseCredentials = null;
  let refreshPromiseIssuer = null;
  let refreshPromiseAuthentication = null;
  let refreshPromisePending = null;
  let refreshExchange = null;
  let modelRotation = null;
  let modelOutputRead = null;
  // Keep each refusal for this Host so a later login cannot unblock an older read.
  const refusedSessions = new Set();
  let lastBackgroundRefreshAt = 0;
  let backgroundRefreshBinding = null;
  let renewal = null;
  let renewalSequence = 0;
  let lastBlockedReason;
  const handedToSignOut = new IamError('IAM_DISPOSED', 'IAM session changed');
  const expiredAfterRestore = new IamError('IAM_UNREACHABLE', safeMessage('IAM_UNREACHABLE'));

  function signOutPendingViewCode() {
    return ctx.error === 'IAM_CREDENTIALS_CLEAR_FAILED' ? ctx.error : 'IAM_REVOCATION_UNKNOWN';
  }

  function refusePending(grant) {
    refusedSessions.add(grant.sessionInstanceId);
  }

  function confirmPending(grant) {
    refusedSessions.delete(grant.sessionInstanceId);
  }

  function pendingRefused(grant) {
    return refusedSessions.has(grant?.sessionInstanceId);
  }

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

  function cancelRenewal(reason) {
    const scheduled = renewal;
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    renewal = null;
    logRenewal?.('renewal-cancelled', { renewalId: scheduled.renewalId, dueAtMs: scheduled.runAt, reason });
  }

  function blockRenewal(reason, grant) {
    const scheduled = renewal;
    cancelRenewal(reason);
    if (lastBlockedReason !== reason || scheduled) {
      logRenewal?.('renewal-blocked', { renewalId: scheduled?.renewalId, reason, state: ctx.state, ...renewalDeadlines(grant) });
    }
    lastBlockedReason = reason;
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
      && provider.atomicBinding(store, credentials) === exchange.binding
      ? { pending: exchange.pending, complete: exchange.complete,
        unsentGrant: exchange.dispatched ? undefined : exchange.original } : undefined;
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

  function providerBlockReason(targetStore, targetCredentials) {
    if (!targetStore || !targetCredentials) return 'credentials-unavailable';
    const matches = () => provider.ensure() === targetStore && provider.storeCredentials === targetCredentials;
    if (!matches()) return 'provider-changed';
    if (!provider.atomicVerified(targetCredentials)) return 'atomic-store-unverified';
    if (!matches()) return 'provider-changed';
    return null;
  }

  function activeModelRotation() {
    return modelRotation?.ownsGrant() ? modelRotation : null;
  }

  function readModelOutputGrant(store, credentials, original) {
    if (modelOutputRead?.store === store && modelOutputRead.credentials === credentials
      && modelOutputRead.original === original) return modelOutputRead.result;
    const controller = new AbortController();
    const deadline = monotonic() + REFRESH_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(unconfirmedRenewal()), REFRESH_TIMEOUT_MS);
    timer.unref?.();
    const read = { store, credentials, original, result: null };
    modelOutputRead = read;
    read.result = raceCancellation(Promise.resolve().then(() => store.read()), controller.signal).then(record => {
      if (monotonic() >= deadline) throw unconfirmedRenewal();
      return record;
    }).finally(() => {
      clearTimeout(timer);
      if (modelOutputRead === read) modelOutputRead = null;
    });
    return read.result;
  }

  // A verified pending marker can suspend use of an adopted session without
  // forgetting its identity. One observer per Host follows the exact operation.
  function observePendingRotation(store, credentials, pending) {
    const original = ctx.lastGrant;
    const existing = activeModelRotation();
    if (existing) return existing.store === store && existing.credentials === credentials
      && isDeepStrictEqual(existing.pending, pending) ? existing : null;
    const marker = pending.refreshOperation;
    if (!original || ctx.state !== 'ready' || isAccessExpired(original, now())
      || grants.ownerOf(original) !== store || marker?.state !== 'pending'
      || !sameGrantIgnoringRefreshMarker(original, pending) || marker.base !== refreshBaseId(original, marker.id)) return null;
    const auth = getAuthEpoch();
    const session = getSessionEpoch();
    const bindingCurrent = () => !ctx.disposed && !isSigningOut() && ctx.exclusive.ok
      && getAuthEpoch() === auth && getSessionEpoch() === session && ['ready', 'expired'].includes(ctx.state)
      && provider.store === store && provider.storeCredentials === credentials;
    const ownsGrant = () => bindingCurrent() && isDeepStrictEqual(ctx.lastGrant, original);
    const atomicBinding = provider.atomicBinding(store, credentials);
    if (!atomicBinding || !ownsGrant()) return null;
    const atomicBindingCurrent = () => provider.atomicBinding(store, credentials) === atomicBinding;
    const assertBinding = () => {
      if (!atomicBindingCurrent()) throw reauthenticationRequired();
    };

    const ownFlight = ownedPendingFlight(store, credentials, pending);
    const issuer = ctx.knownIssuer();
    const deadline = monotonic() + REFRESH_TIMEOUT_MS;
    const controller = new AbortController();
    const { signal } = controller;
    const timeout = setTimeout(() => controller.abort(unconfirmedRenewal()), REFRESH_TIMEOUT_MS);
    timeout.unref?.();
    const compatibleGrant = () => {
      if (!bindingCurrent()) return false;
      if (ownsGrant()) return true;
      const outcome = refreshOutcome(pending, ctx.lastGrant);
      return outcome === 'complete' || outcome === 'restored';
    };
    const onView = () => {
      if (!compatibleGrant()) controller.abort(changedSession());
      else if (!atomicBindingCurrent()) controller.abort(reauthenticationRequired());
    };
    const check = () => {
      signal.throwIfAborted();
      if (!compatibleGrant()) throw changedSession();
      if (monotonic() >= deadline) throw unconfirmedRenewal();
      ctx.assertExclusive();
      assertBinding();
      if (!compatibleGrant()) throw changedSession();
      if (monotonic() >= deadline) throw unconfirmedRenewal();
    };
    const read = async () => {
      let record;
      try { record = await raceCancellation(store.read(), signal); }
      catch (cause) {
        check();
        const code = credentialReadError(cause);
        throw new IamError(code, safeMessage(code));
      }
      check();
      if (record.reason === 'sign-out-pending') throw signOutPendingError('IAM_INVALID_GRANT');
      if (!record.ok) throw new IamError('IAM_INVALID_GRANT', safeMessage('IAM_INVALID_GRANT'));
      if (!record.grant || !isDeepStrictEqual(grantIdentity(pending), grantIdentity(record.grant))) throw changedSession();
      grants.assertGrantContext(record.grant, issuer);
      return record.grant;
    };
    const confirm = async () => {
      check();
      if (ownFlight) {
        // The owner must acknowledge its write itself. Reading ahead could
        // publish before a failed write acknowledgement invalidates the owner.
        await raceCancellation(ownFlight, signal);
        check();
        const latest = ctx.lastGrant;
        const outcome = refreshOutcome(pending, latest);
        if (outcome === 'complete' || outcome === 'restored') return latest;
        throw unconfirmedRenewal();
      }
      while (true) {
        let poll;
        try {
          await raceCancellation(new Promise(resolve => { poll = setTimeout(resolve, 50); }), signal);
        } finally { clearTimeout(poll); }
        check();
        const latest = await read();
        const outcome = refreshOutcome(pending, latest);
        if (outcome === 'pending') continue;
        if (!outcome) throw unconfirmedRenewal();
        const authentication = config.authMode === 'confidential'
          ? await raceCancellation(grants.prepareAuthentication(issuer, store, credentials, { grant: latest, guard: check }), signal)
          : undefined;
        if (authentication && !isDeepStrictEqual(latest, await read())) throw unconfirmedRenewal();
        check();
        assertClientAuthCurrent(authentication);
        const restored = outcome === 'restored';
        const confirmedAt = now();
        const expired = isAccessExpired(latest, confirmedAt);
        if (expired && !(restored && isRefreshUsable(latest, confirmedAt))) throw unconfirmedRenewal();
        if (ownsGrant()) {
          const consumption = beginConsumption(issuer, store, credentials);
          publishGrant(latest, store, authentication, consumption, { expired, restored });
          if (restored) scheduleRenewal({ retry: true, restored: true });
        } else if (!isDeepStrictEqual(ctx.lastGrant, latest)) throw changedSession();
        if (expired) throw expiredAfterRestore;
        return latest;
      }
    };
    const observation = { store, credentials, pending, ownsGrant, assertBinding, deadline, result: null };
    modelRotation = observation;
    ctx.addListener(onView);
    observation.result = Promise.resolve().then(confirm).catch(cause => {
      // A confirmed rollback is already published with its retry scheduled.
      // Reject this waiter without discarding that recoverable session.
      if (cause !== expiredAfterRestore && modelRotation === observation && ownsGrant()) {
        const code = cause instanceof IamError ? cause.code : credentialReadError(cause);
        const signOutPending = cause instanceof IamError && cause.details?.reason === 'sign-out-pending';
        if (code === 'IAM_REAUTH_REQUIRED') refusePending(pending);
        if (signOutPending) rememberPendingSignOut(store);
        ctx.lastGrant = null;
        ctx.state = code === 'IAM_NOT_SIGNED_IN' ? 'signed-out' : 'error';
        if (signOutPending) {
          clearObservation();
          ctx.error = signOutPendingViewCode();
        } else ctx.error = ctx.state === 'error' ? code : null;
        ctx.notify();
      }
      throw cause;
    }).finally(() => {
      clearTimeout(timeout);
      ctx.removeListener(onView);
      if (modelRotation === observation) modelRotation = null;
    });
    // Background observation also runs with no model caller attached.
    void observation.result.catch(() => {});
    return observation;
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
    const timing = { renewalId: scheduled.renewalId, dueAtMs: scheduled.runAt,
      lateMs: now() - scheduled.runAt, recovering, backoff: scheduled.backoff };
    logRenewal?.('renewal-fired', { ...timing, state: ctx.state });
    const invalidReason = () => {
      const current = ctx.lastGrant;
      if (ctx.disposed || isSigningOut() || !renewalStateMatches(recovering, now())) return 'session-inactive';
      if (!current || getAuthEpoch() !== auth || getSessionEpoch() !== session) return 'session-changed';
      if (deadlineOf(current, now(), recovering) !== expiry) return 'deadline-changed';
      if (current.refreshToken !== scheduled.refreshToken || !isDeepStrictEqual(grantIdentity(current), identity)) return 'session-changed';
      return providerBlockReason(targetStore, targetCredentials);
    };
    // A withdrawn trust binding must stop this timer: renewal resumes only when
    // the host re-publishes a verified pair (see index.mjs hydrateBinding()).
    const blocked = invalidReason();
    if (blocked) {
      logRenewal?.('renewal-blocked', { ...timing, reason: blocked, state: ctx.state, ...renewalDeadlines(ctx.lastGrant) });
      return;
    }
    if (now() < scheduled.runAt) {
      logRenewal?.('renewal-blocked', { ...timing, reason: 'timer-before-due', state: ctx.state });
      scheduleRenewal({ retry: scheduled.backoff === true });
      return;
    }
    void resolveToken(scheduled).catch((cause) => {
      if (cause === handedToSignOut) return;
      // The resolver owns each retry and can bind it to its confirmed outcome.
      logRenewal?.('renewal-failed', { ...timing, state: ctx.state, ...renewalErrorFields(cause) });
    });
  }

  function renewalStateMatches(recovering, at) {
    const expired = isAccessExpired(ctx.lastGrant, at);
    return (ctx.state === 'ready' && (!recovering || expired))
      || (ctx.state === 'expired' && (recovering || expired));
  }

  function scheduledRenewalAt(grant, targetStore, targetCredentials) {
    if (renewal && renewal.targetStore === targetStore && renewal.targetCredentials === targetCredentials
      && renewal.auth === getAuthEpoch() && renewal.session === getSessionEpoch()
      && isDeepStrictEqual(renewal.grant, grant)) return renewal.runAt;
    return null;
  }

  // The Host owns the timer; the callback enters the existing single-flight
  // resolver and therefore uses the same provider and rotation checks.
  function scheduleRenewal({ retry = false, resumeAt = null, restored = false } = {}) {
    const grant = ctx.lastGrant;
    const currentTime = now();
    // Observe the clock on every pass: the first activity after a suspension is
    // where a deadline that passed while asleep has to become a renewal.
    const jumpMs = resumeJumpMillis();
    const resumed = jumpMs > 0;
    const recovering = ctx.state === 'expired' || isAccessExpired(grant, currentTime);
    const refreshExpiry = Date.parse(grant?.refreshExpiresAt);
    const expiry = deadlineOf(grant, currentTime, recovering);
    if (ctx.disposed || !['ready', 'expired'].includes(ctx.state) || isSigningOut()) return blockRenewal('session-inactive', grant);
    if (!grant) return blockRenewal('no-grant', grant);
    if (grant.refreshOperation?.state === 'pending') return blockRenewal('refresh-pending', grant);
    if (!isRefreshUsable(grant, currentTime)) return blockRenewal('refresh-unusable', grant);
    if (expiry !== Infinity && !Number.isFinite(expiry)) return blockRenewal('deadline-unknown', grant);
    if (expiry <= currentTime) return blockRenewal('deadline-passed', grant);
    const auth = getAuthEpoch();
    const session = getSessionEpoch();
    const identity = grantIdentity(grant);
    const targetStore = grants.ownerOf(grant);
    const targetCredentials = provider.storeCredentials;
    // Revoking trust stops renewal here; a later verified binding re-arms it.
    const blocked = providerBlockReason(targetStore, targetCredentials);
    if (blocked) return blockRenewal(blocked, grant);
    if (ctx.lastGrant !== grant || ctx.disposed || isSigningOut()
      || !renewalStateMatches(recovering, currentTime)
      || getAuthEpoch() !== auth || getSessionEpoch() !== session) {
      return blockRenewal('session-changed', grant);
    }
    // A suspended host is the one case where the normal schedule cannot help:
    // the access token already lapsed, so renew now and keep the timer below as
    // the fallback. Single-flight and the shared backoff bound the extra work.
    if (resumed && !retry && recovering && isAccessExpired(grant, currentTime)) {
      logRenewal?.('renewal-resume', { jumpMs: Math.round(jumpMs), ...renewalDeadlines(grant) });
      void resolveToken(undefined, 'resume').catch(() => {});
    }
    // An expiry notification can run ahead of an already-due timer. Its
    // original slot still works for this grant within the refresh deadline.
    if (!retry && recovering && renewal?.recovering === false && renewal.runAt <= currentTime
      && scheduledRenewalAt(grant, targetStore, targetCredentials) !== null) return;
    const remaining = expiry - currentTime;
    const lead = renewalLeadMillis(grant, expiry, currentTime, config.refreshSkewSeconds);
    let delay = retry || recovering
      ? Math.min(AUTO_REFRESH_BACKOFF_MS, Math.max(1000, Math.floor(remaining / 2))) : Math.max(0, remaining - lead);
    // A confirmed unsent refresh can use the remaining window when the
    // normal minimum backoff would land at or after a known deadline.
    if (restored && retry && delay >= remaining) delay = Math.floor(remaining / 2);
    const sameBackoff = renewal?.backoff && renewal.auth === auth && renewal.session === session
      && renewal.targetStore === targetStore && renewal.targetCredentials === targetCredentials
      && renewal.refreshToken === grant.refreshToken
      && isDeepStrictEqual(renewal.identity, identity);
    // A view notification must not turn a scheduled backoff into an earlier
    // normal renewal. Preserve its deadline even if the view became expired.
    if (!retry && sameBackoff) delay = Math.max(0, renewal.runAt - currentTime);
    // The recovered read may have restored an earlier slot than that fallback.
    if (resumeAt !== null) delay = Math.min(delay, Math.max(0, resumeAt - currentTime));
    // Never schedule a retry after the only known refresh token has expired:
    // the access token may legitimately lapse while its retry is pending.
    if ((retry || recovering) && Number.isFinite(refreshExpiry) && currentTime + delay >= refreshExpiry) {
      return blockRenewal('retry-after-expiry', grant);
    }
    lastBlockedReason = undefined;
    if (!retry && renewal && renewal.expiry === expiry && renewal.auth === auth && renewal.session === session
      && renewal.targetStore === targetStore && renewal.targetCredentials === targetCredentials
      && renewal.refreshToken === grant.refreshToken
      && renewal.recovering === recovering && isDeepStrictEqual(renewal.identity, identity)
      && renewal.runAt <= currentTime + delay) return;
    cancelRenewal('replaced');
    const scheduled = { expiry, auth, session, identity, recovering, targetStore, targetCredentials,
      refreshToken: grant.refreshToken, grant: structuredClone(grant), renewalDue: true,
      backoff: Boolean(retry || recovering || sameBackoff), runAt: currentTime + delay, timer: null,
      renewalId: ++renewalSequence };
    armTimer(scheduled, delay);
    logRenewal?.('renewal-scheduled', { renewalId: scheduled.renewalId, dueAtMs: scheduled.runAt, delayMs: delay,
      recovering, backoff: scheduled.backoff, ...renewalDeadlines(grant) });
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

  async function resolveToken(expected, trigger = expected?.renewalDue === true ? 'timer' : 'request') {
    let renewalId = expected?.renewalId;
    let stage = 'store-read';
    let failureReported = false;
    let tokenEndpointFailure;
    const started = logRenewal ? performance.now() : 0;
    const trace = (event, fields) => {
      if (!logRenewal) return;
      renewalId ??= ++renewalSequence;
      logRenewal(event, { renewalId, stage, trigger, elapsedMs: Math.round(performance.now() - started), ...fields });
    };
    const advance = (next, fields) => {
      stage = next;
      trace('refresh-stage', fields);
    };
    const reportFailure = (code, reason, cause) => {
      if (failureReported) return;
      failureReported = true;
      const failure = tokenEndpointFailure ?? (cause ? renewalErrorFields(cause) : {});
      trace('refresh-failed', { code, reason, ...failure });
    };
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (isSigningOut() || ctx.state === 'authenticating') {
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session is not signed in');
    }
    if (ctx.state === 'unreachable' && ctx.error === 'IAM_CREDENTIALS_UNAVAILABLE') {
      throw new IamError(ctx.error, safeMessage(ctx.error));
    }
    const checkExpected = (allowCompleted = false) => {
      if (!expected) return;
      // Publishing the old AT's expiry while the store read is pending does
      // not replace the session or invalidate its refresh claim.
      const expectedState = renewalStateMatches(expected.recovering, now());
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
    const useObservedRotation = async (observation) => {
      const latest = await observation.result;
      observation.assertBinding();
      checkExpected(true);
      if (ctx.disposed || isSigningOut() || ctx.state !== 'ready' || !isDeepStrictEqual(ctx.lastGrant, latest)
        || isAccessExpired(latest, now())) throw changedSession();
      return latest.accessToken;
    };
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
      if (checkBefore && trigger !== 'request') trace('refresh-shared');
      const token = await shared;
      checkProvider();
      try {
        if (config.authMode === 'confidential' && !authentication) {
          authentication = await grants.prepareAuthentication(expectedIssuer, sharedStore, sharedCredentials, { expected: sharedAuthentication?.value, guard: checkProvider });
        }
        return await withCurrentClientAuth(authentication, () => {
          checkProvider();
          return token;
        });
      } catch (cause) {
        if (!isClientAuthReadLockTimeout(cause)) throw cause;
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
    };
    if (refreshPromise && expected
      && (refreshPromiseStore !== expected.targetStore || refreshPromiseCredentials !== expected.targetCredentials)) {
      throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    }
    const pendingRefusal = reauthenticationRequired();
    if (refreshPromise) return useSharedRefresh();
    const observed = activeModelRotation();
    if (observed) return useObservedRotation(observed);
    const epoch = getSessionEpoch();
    const auth = getAuthEpoch();
    const targetStore = provider.require();
    const targetCredentials = provider.storeCredentials;
    checkExpected();
    if (expected && (targetStore !== expected.targetStore || targetCredentials !== expected.targetCredentials)) {
      throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    }
    const usePendingObservation = async (observation) => {
      const result = await observation.wait();
      ctx.assertExclusive();
      if (!result) throw pendingRefusal;
      assertClientAuthCurrent(result.authentication);
      if (provider.atomicBinding(targetStore, targetCredentials) !== observation.atomicBinding) throw pendingRefusal;
      if (ctx.disposed || isSigningOut() || !ctx.exclusive.ok || getAuthEpoch() !== auth || getSessionEpoch() !== epoch) throw changedSession();
      const grant = result.grant;
      if (pendingRefused(grant) || !isDeepStrictEqual(ctx.lastGrant, grant) || activeModelRotation()
        || (refreshPromisePending?.store === targetStore && refreshPromisePending.grant.refreshToken === grant.refreshToken)) throw pendingRefusal;
      if (isAccessExpired(grant, now())) throw new IamError('IAM_UNREACHABLE', safeMessage('IAM_UNREACHABLE'));
      if (ctx.state !== 'ready') throw changedSession();
      return grant.accessToken;
    };
    const observationFor = (sessionId) => expected ? null : pendingObservationFor(targetStore, targetCredentials, sessionId);
    const useRefusedGrant = (grant) => {
      // A read or preflight that began before the panel saw pending must
      // follow its existing observation, with the same binding and deadline.
      const observed = observationFor(grant.sessionInstanceId);
      if (!observed) throw pendingRefusal;
      return usePendingObservation(observed);
    };
    const grantAtStart = ctx.lastGrant;
    const observation = observationFor();
    const replacementRecord = observation && await observation.readReplacement();
    if (observation && !replacementRecord) return usePendingObservation(observation);
    const consumption = beginConsumption(expectedIssuer, targetStore, targetCredentials);
    let refreshing = false;
    let refreshWriteAttempted = false;
    let unclaimedLockTimeout = false;
    let waitingForPending = false;
    let pendingBinding;
    let operationGrant = null;
    const staleSession = new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
    let authentication;
    const checkReplacement = () => {
      if (replacementRecord && ctx.lastGrant !== grantAtStart && !isDeepStrictEqual(ctx.lastGrant, replacementRecord.grant)) throw staleSession;
    };
    const alive = () => !ctx.disposed && !isSigningOut() && epoch === getSessionEpoch()
      && auth === getAuthEpoch() && ctx.state !== 'authenticating';
    const checkLifecycle = () => {
      if (!alive()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
      ctx.assertExclusive();
      if (pendingBinding !== undefined) {
        if (!pendingBinding || provider.atomicBinding(targetStore, targetCredentials) !== pendingBinding) {
          throw reauthenticationRequired();
        }
      } else if (refreshing) provider.assertAtomic(targetStore, targetCredentials);
      checkReplacement();
    };
    const checkAlive = () => { checkLifecycle(); assertClientAuthCurrent(authentication); };
    const recheck = () => withCurrentClientAuth(authentication, checkLifecycle);
    const rejectSession = (code = 'IAM_REAUTH_REQUIRED', reason = 'rejected', cause, signOutIdentity) => {
      reportFailure(code, reason, cause);
      const signOutPending = reason === 'sign-out-pending';
      // A late failure belongs to its original provider, not a newer session.
      const current = provider.ensure();
      if (!(code === 'IAM_NOT_SIGNED_IN' && ctx.state === 'signed-out')
        && alive() && current === targetStore && provider.storeCredentials === targetCredentials
        && (!ctx.lastGrant || ctx.lastGrant === grantAtStart
          || (operationGrant && sameGrantIgnoringRefreshMarker(ctx.lastGrant, operationGrant)))) {
        if (!signOutPending && code === 'IAM_REAUTH_REQUIRED' && operationGrant) refusePending(operationGrant);
        if (signOutPending) rememberPendingSignOut(targetStore, signOutIdentity ?? (operationGrant && grantIdentity(operationGrant)));
        clearObservation();
        ctx.lastGrant = null;
        ctx.state = 'error';
        ctx.error = signOutPending ? signOutPendingViewCode() : code;
        ctx.notify();
      }
      if (signOutPending) throw signOutPendingError(code);
      throw new IamError(code, safeMessage(code));
    };
    const adoptGrant = (grant, restored, adoptionReason) => {
      checkLifecycle();
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
      checkLifecycle();
      grants.assertGrantContext(grant, expectedIssuer);
      if (!waitingForPending && pendingRefused(grant)) throw pendingRefusal;
      const expired = isAccessExpired(grant, now());
      if (grant.refreshOperation?.state === 'pending' || (expired && !(restored && isRefreshUsable(grant, now())))) return rejectSession();
      if (waitingForPending) confirmPending(grant);
      publishGrant(grant, targetStore, authentication, consumption, { expired, restored });
      if (adoptionReason) trace('refresh-adopted', { reason: adoptionReason, ...renewalDeadlines(grant) });
      if (restored) scheduleRenewal({ retry: true, restored: true });
      if (expired) throw expiredAfterRestore;
      return grant.accessToken;
    };
    const useGrant = (grant, restored = false, adoptionReason) =>
      withCurrentClientAuth(authentication, () => adoptGrant(grant, restored, adoptionReason));
    // Do not make signOut wait for an unrelated, possibly stalled initial read.
    let record = replacementRecord;
    try {
      record ??= await targetStore.read({ includeSignOutIdentity: !grantAtStart });
    } catch (cause) {
      if (!alive()) throw new IamError(ctx.disposed ? 'IAM_DISPOSED' : 'IAM_NOT_SIGNED_IN', 'IAM session changed');
      const unchanged = provider.ensure() === targetStore && provider.storeCredentials === targetCredentials;
      if (unchanged && cause?.code === 'CRED_LOCK_TIMEOUT') {
        const scheduled = deferRead({ targetStore, targetCredentials, authEpoch: auth, grant: grantAtStart,
          renewalDue: expected?.renewalDue === true });
        const code = 'IAM_CREDENTIALS_UNAVAILABLE';
        if (scheduled) trace('refresh-retry', { reason: 'read-lock-timeout', code, ...renewalErrorFields(cause) });
        else reportFailure(code, 'store-read-failed', cause);
        throw new IamError(code, safeMessage(code));
      }
      return rejectSession(unchanged ? credentialReadError(cause) : 'IAM_CREDENTIALS_UNAVAILABLE',
        unchanged ? 'store-read-failed' : 'provider-changed', cause);
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
      checkReplacement();
    };
    checkReadContext();
    if (!expected && record.reason === 'sign-out-pending') {
      return rejectSession('IAM_INVALID_GRANT', 'sign-out-pending', undefined, record.signOutIdentity);
    }
    if (pendingRefused(record.grant)) return useRefusedGrant(record.grant);
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
      trace('refresh-reused', { reason: 'local-complete', ...renewalDeadlines(latest.grant) });
      return latest.grant.accessToken;
    }
    const completedExpected = expected && record.ok && completedRotationOf(expected.grant, record.grant)
      && !isAccessExpired(record.grant, now()) && isRefreshUsable(record.grant, now());
    if (expected && (!record.ok || !record.grant
      || !isDeepStrictEqual(grantIdentity(record.grant), expected.identity)
      || (record.grant.refreshToken !== expected.refreshToken && !completedExpected))) {
      // A different session may have been written without a local notification.
      // Do not claim it or discard it on behalf of this stale background timer.
      const reason = !record.ok ? 'grant-invalid' : !record.grant ? 'grant-missing' : 'stored-session-changed';
      reportFailure('IAM_NOT_SIGNED_IN', reason);
      throw new IamError('IAM_NOT_SIGNED_IN', 'IAM session changed');
    }
    const marker = record.grant?.refreshOperation;
    if (trigger === 'model' && expected && marker?.state === 'pending'
      && (!sameGrantIgnoringRefreshMarker(expected.grant, record.grant)
        || marker.base !== refreshBaseId(expected.grant, marker.id))) {
      throw unconfirmedRenewal();
    }
    if (refreshPromise && expected
      && (refreshPromiseStore !== expected.targetStore || refreshPromiseCredentials !== expected.targetCredentials)) {
      throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    }
    if (refreshPromise) return useSharedRefresh();
    if (expected?.expiredCode && !completedExpected && marker?.state !== 'pending' && !isRefreshUsable(record.grant, now())) {
      const code = expected.expiredCode;
      throw new IamError(code, code === 'IAM_REAUTH_REQUIRED' ? safeMessage(code) : '企业账号已过期，请重新登录。');
    }
    if (!record.grant && ctx.state === 'error' && ctx.error === pendingRefusal.code) throw pendingRefusal;
    refreshPromiseStore = targetStore;
    refreshPromiseCredentials = targetCredentials;
    refreshPromiseIssuer = expectedIssuer;
    const flightAuthentication = {};
    refreshPromiseAuthentication = flightAuthentication;
    const flight = Promise.resolve().then(async () => {
      try {
        checkAlive();
        if (!record.ok) return rejectSession('IAM_INVALID_GRANT', 'grant-invalid');
        if (!record.grant) return rejectSession('IAM_NOT_SIGNED_IN', 'grant-missing');
        operationGrant = record.grant;
        grants.assertGrantContext(record.grant, expectedIssuer);
        const initial = record.grant;
        // The background timer may renew before the on-demand window opens.
        // Take a completed rotation from another Host through the usual checks.
        const forcedRenewal = expected?.renewalDue === true
          && initial.refreshToken === expected.refreshToken;
        const waitingForReceipt = marker?.state === 'pending';
        // Model receipt adoption uses the original binding even if the old
        // refresh deadline passes while client authentication is in flight.
        if (waitingForReceipt || (expected?.expiredCode && completedExpected)) {
          pendingBinding = expected?.expiredCode ? expected.atomicBinding : provider.atomicBinding(targetStore, targetCredentials);
          checkAlive();
        }
        stage = 'client-auth';
        authentication = await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: initial, guard: checkLifecycle });
        checkLifecycle();
        if (pendingRefused(initial)) return useRefusedGrant(initial);
        flightAuthentication.value = clientAuthDescriptor(authentication);
        const observed = activeModelRotation();
        if (observed) {
          if (observed.store !== targetStore || observed.credentials !== targetCredentials
            || !sameGrantIgnoringRefreshMarker(initial, observed.pending)) throw staleSession;
          return await useObservedRotation(observed);
        }
        const decisionTime = now();
        if (initial.refreshOperation?.state !== 'pending'
          && (completedExpected || (!forcedRenewal && !shouldRefresh(initial, decisionTime, config.refreshSkewSeconds))
            || (!isRefreshUsable(initial, decisionTime) && !isAccessExpired(initial, decisionTime)))) {
          if (completedExpected) return await useGrant(initial, false, 'peer-complete');
          const access = await useGrant(initial);
          if (trigger !== 'request') trace('refresh-reused', { reason: 'access-still-valid', ...renewalDeadlines(initial) });
          return access;
        }
        // An expired token cannot start a new refresh. A model call with
        // the original baseline may still observe an already claimed one.
        if (!isRefreshUsable(initial, now()) && !(expected?.expiredCode && waitingForReceipt)) {
          return rejectSession(undefined, 'refresh-unusable');
        }
        refreshing = true;
        checkLifecycle();

        // Wait only for the observed operation; a timeout is never a lease or
        // permission to resend. Polling never holds the provider lock.
        const waitFor = async (pending) => {
          pendingBinding ??= provider.atomicBinding(targetStore, targetCredentials);
          checkAlive();
          if (pendingRefused(pending)) return useRefusedGrant(pending);
          const observed = observePendingRotation(targetStore, targetCredentials, pending);
          if (observed) {
            const latest = await observed.result;
            observed.assertBinding();
            checkAlive();
            if (ctx.state !== 'ready' || !isDeepStrictEqual(ctx.lastGrant, latest)) throw staleSession;
            return latest.accessToken;
          }
          // A pending rotation may already have consumed the refresh token.
          // Remove only the view belonging to this operation while awaiting it.
          checkAlive();
          advance('wait-for-peer', renewalDeadlines(pending));
          if ((!ctx.lastGrant || ctx.lastGrant === grantAtStart || sameGrantIgnoringRefreshMarker(ctx.lastGrant, pending))
            && (ctx.state !== 'error' || ctx.error === 'IAM_REAUTH_REQUIRED')) {
            waitingForPending = true;
            refusePending(pending);
            ctx.lastGrant = null;
            clearObservation();
            ctx.state = 'error';
            ctx.error = 'IAM_REAUTH_REQUIRED';
            ctx.notify();
          }
          const deadline = monotonic() + REFRESH_TIMEOUT_MS;
          const remaining = () => deadline - monotonic();
          while (remaining() > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
            checkAlive();
            const budget = remaining();
            if (budget <= 0) return rejectSession(undefined, 'peer-timeout');
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
            if (latest === timeout || remaining() <= 0) return rejectSession(undefined, 'peer-timeout');
            if (latest.reason === 'sign-out-pending') return rejectSession(undefined, 'sign-out-pending');
            if (!latest.ok || !latest.grant) return rejectSession(undefined, 'peer-record-invalid');
            grants.assertGrantContext(latest.grant, expectedIssuer);
            // The observed base binds the entire pre-claim record. A
            // participating owner restores it only after proving no send.
            const outcome = refreshOutcome(pending, latest.grant);
            if (outcome === 'pending') continue;
            if (outcome !== 'restored' && (outcome !== 'complete' || isAccessExpired(latest.grant, now()))) {
              return rejectSession(undefined, 'pending-result-unmatched');
            }
            if (remaining() <= 0) return rejectSession(undefined, 'peer-timeout');
            // The observer's pin check must finish within its existing deadline.
            checkAlive();
            if (remaining() <= 0) return rejectSession(undefined, 'peer-timeout');
            return outcome === 'restored' ? adoptGrant(latest.grant, true, 'peer-restored')
              : adoptGrant(latest.grant, false, 'peer-complete');
          }
          return rejectSession(undefined, 'peer-timeout');
        };
        if (initial.refreshOperation?.state === 'pending') return await waitFor(initial);

        // Preload metadata before claiming, never while a record lock is held.
        advance('discovery', renewalDeadlines(initial));
        const meta = await grants.metadata();
        if (authentication) await recheck();
        checkLifecycle();
        grants.assertGrantContext(initial, meta.issuer);
        assertClientAuthEndpoint(meta.tokenEndpoint, authentication);
        advance('jwks');
        const keys = await grants.jwks(meta.jwksUri);
        if (authentication) await recheck();
        checkLifecycle();
        if (pendingRefused(initial)) return useRefusedGrant(initial);
        const claimBinding = provider.atomicBinding(targetStore, targetCredentials);
        if (!claimBinding) throw new IamError('IAM_ATOMIC_STORE_UNVERIFIED', safeMessage('IAM_ATOMIC_STORE_UNVERIFIED'));
        pendingBinding = claimBinding;
        checkLifecycle();
        const operationId = randomToken(32);
        const operation = { version: 1, state: 'pending', id: operationId, base: refreshBaseId(initial, operationId) };
        const pending = { ...initial, refreshOperation: operation };
        refreshPromisePending = { store: targetStore, credentials: targetCredentials, grant: pending };
        const exchange = { store: targetStore, credentials: targetCredentials, binding: claimBinding,
          original: initial, pending, dispatched: false, signOut: false, complete: undefined };
        let claimed = false;
        let claimedGrant = null;
        let claimGateOpen = true;
        let claimCallbackUsed = false;
        refreshWriteAttempted = true;
        let claim;
        advance('claim');
        try {
          claim = await targetStore.mutate((current) => {
            // A provider that rejects and invokes its callback later must not
            // create a pending write after this flight has been abandoned.
            if (!claimGateOpen || claimCallbackUsed || pendingRefused(initial)) return undefined;
            claimCallbackUsed = true;
            checkAlive();
            if (!current) return undefined;
            grants.assertGrantContext(current, meta.issuer);
            if (current.refreshOperation?.state === 'pending' || !isDeepStrictEqual(current, initial)) return undefined;
            if ((!forcedRenewal && !shouldRefresh(current, now(), config.refreshSkewSeconds))
              || !isRefreshUsable(current, now())) return undefined;
            claimed = true;
            claimedGrant = current;
            // Sign-out may fence dispatch while this exact claim is being persisted.
            refreshExchange = exchange;
            return pending;
          }, { guard: () => { checkAlive(); return true; } });
        } catch (cause) {
          // Once the callback runs it may have observed a different or pending
          // grant, or produced a candidate that could still commit later.
          unclaimedLockTimeout = cause?.code === 'CRED_LOCK_TIMEOUT' && !claimCallbackUsed && !claimed;
          throw cause;
        } finally {
          claimGateOpen = false;
        }
        let claimPinReadTimeout;
        try {
          if (authentication) await recheck();
          else checkLifecycle();
        } catch (cause) {
          if (!claimed || !isClientAuthReadLockTimeout(cause)) throw cause;
          claimPinReadTimeout = cause;
        }
        const claimedRecord = claim.record?.kind === 'grant' ? claim.record.payload : null;
        if (!claimed) {
          if (pendingRefused(initial)) return useRefusedGrant(initial);
          const latest = await targetStore.read();
          checkAlive();
          if (latest.reason === 'sign-out-pending') return rejectSession(undefined, 'sign-out-pending');
          if (pendingRefused(initial)) return useRefusedGrant(initial);
          if (!latest.ok || !latest.grant) return rejectSession(undefined, 'claim-conflict');
          const decisionTime = now();
          if (isDeepStrictEqual(latest.grant, initial) && !isRefreshUsable(initial, decisionTime)
            && !isAccessExpired(initial, decisionTime)) {
            const access = await useGrant(initial);
            trace('refresh-reused', { reason: 'refresh-unusable', ...renewalDeadlines(initial) });
            return access;
          }
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
              || marker.base !== refreshBaseId(initial, marker.id)) return rejectSession(undefined, 'claim-conflict');
            return await waitFor(latest.grant);
          }
          if (completedFromInitial && isRefreshUsable(latest.grant, now())) {
            return await useGrant(latest.grant, false, 'peer-complete');
          }
          // A new login without our original record binding is not our result.
          return rejectSession(undefined, 'claim-conflict');
        }
        // A resolved provider call and its returned record are both required;
        // an exception or ambiguous result can never authorize the POST.
        if (!isDeepStrictEqual(claimedRecord, pending)) {
          return rejectSession(undefined, 'claim-unconfirmed');
        }
        trace('refresh-claimed');
        const restoreUnsent = async (cause) => {
          const checkOriginalBinding = () => {
            checkAlive();
            if (provider.atomicBinding(targetStore, targetCredentials) !== claimBinding) {
              throw new IamError('IAM_ATOMIC_STORE_UNVERIFIED', safeMessage('IAM_ATOMIC_STORE_UNVERIFIED'));
            }
            checkAlive();
            return true;
          };
          checkOriginalBinding();
          let restored = false;
          advance('restore', cause ? renewalErrorFields(cause) : { reason: 'refresh-unusable' });
          const result = await targetStore.mutate((current) => {
            checkOriginalBinding();
            if (!isDeepStrictEqual(current, pending)) return undefined;
            restored = true;
            return claimedGrant;
          }, { guard: checkOriginalBinding });
          checkOriginalBinding();
          if (!restored || result.record?.kind !== 'grant' || !isDeepStrictEqual(result.record.payload, claimedGrant)) {
            return rejectSession(undefined, 'commit-unconfirmed', cause);
          }
          if (cause) trace('refresh-retry', { reason: 'request-unsent', ...renewalErrorFields(cause) });
          else if (isAccessExpired(claimedGrant, now())) return rejectSession(undefined, 'refresh-unusable');
          return await useGrant(claimedGrant, Boolean(cause));
        };
        // A read error before POST can be rolled back with the original
        // still-current auth snapshot. A changed or unverified pin cannot.
        if (claimPinReadTimeout) {
          stage = 'client-auth-recheck';
          // Only the confirmed claim reaches here. Recheck its original pin before
          // starting the pending observer or preparing the token request.
          await recheck();
          return await restoreUnsent(claimPinReadTimeout);
        }
        observePendingRotation(targetStore, targetCredentials, claimedRecord);
        stage = 'client-auth-recheck';
        try {
          authentication = await grants.prepareAuthentication(meta.issuer, targetStore, targetCredentials, {
            grant: initial, expected: flightAuthentication.value, guard: checkLifecycle,
          });
        } catch (cause) {
          if (!isClientAuthReadUnavailable(cause)) throw cause;
          return await restoreUnsent(cause);
        }
        const timeoutMs = Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS);
        const clientAuthMethod = authentication?.pin.method ?? 'none';
        advance('token-endpoint', { timeoutMs, clientAuthMethod });
        // The claim and client-auth recheck can outlast the remaining refresh window.
        if (!isRefreshUsable(claimedGrant, now())) return await restoreUnsent();
        const expiredBeforeSend = new Error('IAM refresh token expired before dispatch');
        const ownsSignOut = () => !ctx.disposed && isSigningOut() && auth + 1 === getAuthEpoch()
          && epoch === getSessionEpoch() && ctx.state !== 'authenticating';
        const checkHandoff = () => {
          // The same Host can verify its dispatched result exclusively for
          // sign-out. It must never use normal token publication in that epoch.
          if (!ownsSignOut()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
          ctx.assertExclusive();
          if (provider.atomicBinding(targetStore, targetCredentials) !== claimBinding) throw reauthenticationRequired();
          if (!ownsSignOut()) throw new IamError('IAM_DISPOSED', 'IAM session changed');
        };
        const checkResult = () => exchange.signOut ? checkHandoff() : checkLifecycle();
        const recheckResult = async () => {
          try { await recheck(); }
          catch (cause) {
            // Sign-out may take ownership of a dispatched response while the read waits.
            if (!exchange.signOut || cause?.code !== 'IAM_DISPOSED') throw cause;
          }
          checkResult();
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
            timeoutMs,
            beforeSend: () => {
              checkLifecycle();
              if (pendingRefused(initial)) throw pendingRefusal;
              if (!isRefreshUsable(claimedGrant, now())) throw expiredBeforeSend;
              exchange.dispatched = true;
            },
          });
        } catch (cause) {
          // Preserve the observed HTTP response even if lifecycle checks change the local error.
          tokenEndpointFailure = tokenEndpointFailureFields(cause, clientAuthMethod);
          if (cause === expiredBeforeSend) return await restoreUnsent();
          if (!(cause instanceof OidcError) || cause.code !== 'IAM_UNREACHABLE' || cause.details.requestUnsent !== true) throw cause;
          return await restoreUnsent(cause);
        }
        advance('validate-response');
        if (authentication && !exchange.signOut) await recheckResult();
        else checkResult();
        // C9（2026-11-03 书面答复）已确认轮换：旧刷新令牌即时作废、重用只拒本次请求。
        // 因此响应里缺少新令牌、或原样返回旧令牌，都说明这条授权链不能再续用；
        // 不得把已经发出的刷新令牌当成可以再次使用。
        if (!token.refreshToken) return rejectSession(undefined, 'rotation-missing');
        if (token.refreshToken === claimedGrant.refreshToken) return rejectSession(undefined, 'rotation-unchanged');
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
        if (authentication && !exchange.signOut) await recheckResult();
        checkResult();
        if (exchange.signOut && authentication) {
          // The POST still uses the original guard. Only its received response
          // can be prepared for sign-out against that same authentication pin.
          const handoffAuthentication = await grants.prepareAuthentication(meta.issuer, targetStore, targetCredentials, {
            grant: initial, expected: flightAuthentication.value, guard: checkHandoff,
          });
          await withCurrentClientAuth(handoffAuthentication, checkHandoff);
          checkHandoff();
        }
        if (claims && claims.sub !== claimedGrant.subject) {
          throw new IamError('IAM_REFRESH_SUBJECT_MISMATCH', safeMessage('IAM_REFRESH_SUBJECT_MISMATCH'));
        }
        const next = grants.grantFromToken(claimedGrant, token, meta.issuer, nowIso(now()));
        if (claims) next.subject = claims.sub;
        next.refreshOperation = { ...operation, state: 'complete' };
        exchange.complete = next;
        if (exchange.signOut) {
          trace('refresh-handed-off', renewalDeadlines(next));
          throw handedToSignOut;
        }
        checkLifecycle();
        let committed = false;
        advance('commit');
        const result = await targetStore.mutate((current) => {
          checkAlive();
          if (!isDeepStrictEqual(current, pending)) return undefined;
          committed = true;
          return next;
        }, { guard: () => { checkAlive(); return true; } });
        if (authentication) await recheck();
        else checkLifecycle();
        if (!committed || result.record?.kind !== 'grant'
          || !isDeepStrictEqual(result.record.payload, next)) return rejectSession(undefined, 'commit-unconfirmed');
        const access = await useGrant(next);
        trace('refresh-committed', renewalDeadlines(next));
        return access;
      } catch (cause) {
        if (cause === handedToSignOut || cause === pendingRefusal || cause === expiredAfterRestore || cause?.code === 'IAM_RENEWAL_UNCONFIRMED') throw cause;
        if (cause instanceof IamError && cause.details?.reason === 'sign-out-pending') throw cause;
        if (cause === staleSession) {
          reportFailure('IAM_NOT_SIGNED_IN', 'session-changed');
          throw cause;
        }
        if (!alive()) {
          reportFailure('IAM_DISPOSED', 'session-inactive', cause);
          throw new IamError('IAM_DISPOSED', 'IAM session changed');
        }
        try {
          // A synchronous pin read would report the same lock as an auth change.
          if (isClientAuthReadLockTimeout(cause)) checkLifecycle();
          else checkAlive();
        } catch (currentCause) { cause = currentCause; }
        if (cause instanceof StoreError && cause.details?.reason === 'sign-out-pending') {
          return rejectSession(cause.code, 'sign-out-pending', cause);
        }
        if (!refreshWriteAttempted && !waitingForPending && pendingRefused(operationGrant)) return useRefusedGrant(operationGrant);
        if (isClientAuthReadLockTimeout(cause)) {
          return rejectSession('IAM_CREDENTIALS_UNAVAILABLE', 'read-lock-timeout', cause);
        }
        // Revoked trust before a claim cannot have consumed the refresh token.
        // Retain the session until a newly bound trusted provider can resume it.
        if (!refreshWriteAttempted && cause?.code === 'IAM_ATOMIC_STORE_UNVERIFIED') {
          reportFailure(cause.code, 'atomic-store-unverified');
          throw cause;
        }
        // The callback never ran, and the closed gate prevents a late callback
        // from producing a write candidate. Retry only the same adopted session;
        // keep the existing error contract for callers of this failed flight.
        if (unclaimedLockTimeout && cause?.code === 'CRED_LOCK_TIMEOUT'
          && ['ready', 'expired'].includes(ctx.state) && ctx.lastGrant && isRefreshUsable(ctx.lastGrant, now())
          && isDeepStrictEqual(ctx.lastGrant, operationGrant)
          && provider.ensure() === targetStore && provider.storeCredentials === targetCredentials
          && alive() && ['ready', 'expired'].includes(ctx.state) && ctx.lastGrant
          && isDeepStrictEqual(ctx.lastGrant, operationGrant)) {
          trace('refresh-retry', { reason: 'claim-lock-timeout', code: 'IAM_REAUTH_REQUIRED', ...renewalErrorFields(cause) });
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
          trace('refresh-retry', { reason: 'preflight', ...renewalErrorFields(cause) });
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
        if ((cause instanceof IamError && cause.code === 'IAM_CONFIG_INVALID')
          || ['IAM_GRANT_CONTEXT_MISMATCH', 'IAM_CLIENT_AUTH_CONTEXT_INVALID', 'IAM_CLIENT_AUTH_CHANGED', 'IAM_CLIENT_AUTH_UNVERIFIED', 'IAM_NOT_SIGNED_IN', 'IAM_INVALID_GRANT', 'IAM_ATOMIC_STORE_UNVERIFIED', 'IAM_CREDENTIALS_UNAVAILABLE', 'CRED_KEY_UNAVAILABLE', 'CRED_DECRYPT_FAILED'].includes(cause?.code)) {
          return rejectSession(cause.code, 'rejected', cause);
        }
        // Once a request might have been sent, pending remains authoritative;
        // do not erase it or fall back to an old access token.
        return rejectSession(undefined, 'rejected', cause);
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

    async function consumeModelGrant(consume, { signal, rotationOnly = false, beforeExpiry = false, confirmBinding } = {}) {
      let wait;
      let confirmed;
      const check = () => {
        (wait?.signal ?? signal)?.throwIfAborted();
        if (wait && monotonic() >= wait.deadline) throw unconfirmedRenewal();
        assertCurrent();
        wait?.assertBinding?.();
      };
      const awaitRotation = async (result, deadline = monotonic() + REFRESH_TIMEOUT_MS, assertBinding) => {
        if (wait) throw unconfirmedRenewal();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(unconfirmedRenewal()), Math.max(0, deadline - monotonic()));
        timer.unref?.();
        wait = { deadline, timer, assertBinding, signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal };
        confirmed = await raceCancellation(result, wait.signal);
        check();
        if (!confirmed || !isDeepStrictEqual(ctx.lastGrant, confirmed)) throw changedSession();
        if (confirmBinding) await raceCancellation(confirmBinding(), wait.signal);
        check();
      };
      try {
        let rereads = 0;
        while (rereads < 2) {
          check();
          const observation = activeModelRotation();
          if (observation) {
            if (rotationOnly) return false;
            await awaitRotation(observation.result, observation.deadline, observation.assertBinding);
          }
          const local = ctx.lastGrant;
          const claim = refreshPromisePending;
          let record;
          try { record = await raceCancellation(targetStore.read(), wait?.signal ?? signal); }
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
            ? await raceCancellation(grants.prepareAuthentication(issuer, targetStore, targetCredentials, { grant: latest, guard: check }), wait?.signal ?? signal)
            : undefined;
          check();
          assertClientAuthCurrent(authentication);
          if (!isDeepStrictEqual(local, ctx.lastGrant) || claim !== refreshPromisePending) {
            rereads += 1;
            continue;
          }
          if (beforeExpiry && isAccessExpired(local, now())) return false;
          const observedDuringRead = activeModelRotation();
          if (observedDuringRead) {
            if (rotationOnly) return false;
            await awaitRotation(observedDuringRead.result, observedDuringRead.deadline, observedDuringRead.assertBinding);
            continue;
          }
          if (latest.refreshOperation?.state === 'pending') {
            const rotation = observePendingRotation(targetStore, targetCredentials, latest);
            if (rotationOnly && (rotation || ownedPendingFlight(targetStore, targetCredentials, latest))) return false;
            if (!rotation) throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
            await awaitRotation(rotation.result, rotation.deadline, rotation.assertBinding);
            continue;
          }
          if (confirmed) {
            if (!isDeepStrictEqual(confirmed, latest)) throw unconfirmedRenewal();
            provider.assertAtomic(targetStore, targetCredentials);
            check();
          }
          if (rotationOnly && !completedRotationOf(local, latest)) return false;
          if (isAccessExpired(latest, now())) break;
          if (claim?.store === targetStore && claim.grant.refreshToken === latest.refreshToken) {
            // The owner may still be committing its claim. Wait without using
            // the previous token or starting a new refresh.
            if (rotationOnly) return false;
            await awaitRotation(refreshPromise.then(() => ctx.lastGrant));
            continue;
          }
          if (!isDeepStrictEqual(local, latest)) {
            if (rotationOnly) provider.assertAtomic(targetStore, targetCredentials);
            check();
            if (beforeExpiry && (isAccessExpired(local, now()) || isAccessExpired(latest, now()))) return false;
            const consumption = beginConsumption(issuer, targetStore, targetCredentials);
            publishGrant(latest, targetStore, authentication, consumption);
            check();
            if (!isDeepStrictEqual(ctx.lastGrant, latest) || claim !== refreshPromisePending) {
              rereads += 1;
              continue;
            }
          }
          return consume(latest);
        }
        if (rotationOnly) return false;
        throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
      } finally {
        clearTimeout(wait?.timer);
      }
    }

    return Object.freeze({
      assertCurrent,
      async waitForModelOutput(signal) {
        signal.throwIfAborted();
        assertCurrent();
        let observation = activeModelRotation();
        if (!observation) {
          const original = ctx.lastGrant;
          let record;
          try { record = await raceCancellation(readModelOutputGrant(targetStore, targetCredentials, original), signal); }
          catch (cause) {
            signal.throwIfAborted();
            assertCurrent();
            if (cause?.code === 'IAM_RENEWAL_UNCONFIRMED') throw cause;
            const code = credentialReadError(cause);
            throw new IamError(code, safeMessage(code));
          }
          signal.throwIfAborted();
          assertCurrent();
          const latest = record.grant;
          if (!record.ok || !latest || !isDeepStrictEqual(grantIdentity(latest), identity)) throw changedSession();
          observation = activeModelRotation();
          if (!observation && latest.refreshOperation?.state === 'pending') {
            observation = observePendingRotation(targetStore, targetCredentials, latest);
            if (!observation) {
              // Another read may have published this exact receipt while the
              // output read was still returning its previous snapshot.
              const outcome = refreshOutcome(latest, ctx.lastGrant);
              if (outcome !== 'complete' && outcome !== 'restored') throw unconfirmedRenewal();
            }
          }
        }
        if (!observation) return;
        const confirmed = await raceCancellation(observation.result, signal);
        signal.throwIfAborted();
        assertCurrent();
        observation.assertBinding();
        if (activeModelRotation() || !isDeepStrictEqual(ctx.lastGrant, confirmed)) throw unconfirmedRenewal();
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
      withDispatchAccessToken(dispatch, signal, confirmBinding) {
        // Use the durable version at the last local point before send.
        return consumeModelGrant(latest => dispatch(latest.accessToken), { signal, confirmBinding });
      },
      adoptCommittedRotation(signal) {
        return consumeModelGrant(() => true, { signal, rotationOnly: true, beforeExpiry: true });
      },
      async renew({ expiredCode = 'IAM_REAUTH_REQUIRED' } = {}) {
        assertCurrent();
        const current = ctx.lastGrant;
        if (ctx.state === 'ready' && !isAccessExpired(current, now())) return;
        const atomicBinding = provider.atomicBinding(targetStore, targetCredentials);
        await resolveToken({ auth, session, identity, targetStore, targetCredentials,
          recovering: ctx.state === 'expired', refreshToken: current.refreshToken, grant: current, expiredCode, atomicBinding }, 'model');
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
    scheduledRenewalAt,
    cancelRenewal,
    refusePending,
    confirmPending,
    pendingRefused,
    ownedPendingFlight,
    observePendingRotation,
    hasObservedRotation: () => Boolean(activeModelRotation()),
    takeRefreshForSignOut,
    get inFlight() { return refreshPromise; },
    get lastBackgroundRefreshAt() { return currentBackgroundRefreshAt(); },
    set lastBackgroundRefreshAt(next) { rememberBackgroundRefresh(next); },
  };
}
