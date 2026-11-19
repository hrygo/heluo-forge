import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertClientAuthCurrent } from './client-auth.mjs';
import { IamError } from './errors.mjs';
import { isAccessExpired, isRefreshUsable } from './record.mjs';
import { AUTO_REFRESH_BACKOFF_MS, CREDENTIAL_READ_BACKOFF_MS, grantIdentity, refreshBaseId, REFRESH_TIMEOUT_MS, safeMessage } from './service-helpers.mjs';
import { renewalDeadlines, renewalErrorFields } from './session-renewal-log.mjs';

/**
 * The reconciler between the stored record and the live view.
 *
 * It is the only background writer of the session: every adoption, discard and
 * pending observation happens here, gated on an epoch pair that makes a read
 * belonging to a replaced provider unable to publish. The state it publishes is
 * still owned by service-state.mjs; this module only decides when to write.
 */
export function createReconciler(env) {
  const {
    ctx, provider, grants, gateway, token, now,
    configured, hasSignInAttempt, isSigningOut, getAuthEpoch, getObservation, setObservation,
    getPublications, bumpPublications, beginConsumption, adoptConsumption, resolveToken, logRenewal,
  } = env;
  // A discovery-only process resolves the document issuer at most once. The
  // shared promise also makes concurrent cold syncs wait for the same fetch
  // instead of asserting an empty context; a failed attempt stays failed for
  // this process, so background syncs do not become probes.
  let issuerResolution = null;

  let readRetry = null;

  function cancelReadRetry() {
    if (!readRetry) return;
    clearTimeout(readRetry.timer);
    readRetry = null;
  }

  // All callers share one deferred read. Only a fresh durable read can restore
  // the view or put a renewal back on the timer after a storage timeout.
  function deferRead({ targetStore, targetCredentials, authEpoch, grant, renewGrant = null, observation = null }, previous = null) {
    if (ctx.disposed || !configured || !ctx.exclusive.ok || isSigningOut() || hasSignInAttempt()
      || ctx.state === 'authenticating' || getAuthEpoch() !== authEpoch || ctx.lastGrant !== grant
      || (observation ? getObservation() !== observation || now() >= observation.deadline : ctx.state === 'error')) return false;
    if (readRetry && readRetry !== previous) {
      return readRetry.store === targetStore && readRetry.credentials === targetCredentials && readRetry.authEpoch === authEpoch;
    }
    const delay = observation ? Math.min(CREDENTIAL_READ_BACKOFF_MS, observation.deadline - now()) : CREDENTIAL_READ_BACKOFF_MS;
    const next = { store: targetStore, credentials: targetCredentials, authEpoch, observation, renewGrant, timer: null };
    readRetry = next;
    next.timer = setTimeout(() => {
      void syncFromStore(next).finally(() => {
        if (readRetry === next) cancelReadRetry();
      }).catch(() => {});
    }, delay);
    next.timer.unref?.();
    if (!observation && (ctx.state !== 'unreachable' || ctx.error !== 'IAM_CREDENTIALS_UNAVAILABLE')) {
      setObservation(null);
      ctx.lastGrant = null;
      ctx.state = 'unreachable';
      ctx.error = 'IAM_CREDENTIALS_UNAVAILABLE';
      bumpPublications();
      ctx.notify();
    }
    logRenewal?.('store-sync', { stage: 'store-read', reason: 'read-lock-timeout',
      causeCode: 'CRED_LOCK_TIMEOUT', delayMs: delay, state: ctx.state });
    return true;
  }

  async function syncFromStore(retry = null) {
    if (retry && readRetry !== retry) return ctx.view();
    if (ctx.disposed || isSigningOut()) return ctx.view();
    if (!configured || !ctx.exclusive.ok) return ctx.view();
    // A user-triggered sign-in owns the state machine until its callback,
    // cancellation, or timeout; a background hydration must not clobber it.
    if (ctx.state === 'authenticating' || hasSignInAttempt()) return ctx.view();
    // Only an error created by this instance observing pending can recover.
    const observation = ctx.state === 'error' ? getObservation() : null;
    if (ctx.state === 'error' && (!observation || ctx.error !== 'IAM_REAUTH_REQUIRED'
      || observation.authEpoch !== getAuthEpoch() || now() >= observation.deadline)) {
      if (observation) logRenewal?.('store-sync', { reason: 'pending-window-ended', state: ctx.state, code: ctx.error });
      setObservation(null);
      return ctx.view();
    }
    let expectedIssuer = ctx.knownIssuer();
    const syncEpoch = getAuthEpoch();
    let publication = getPublications();
    let expectedGrant = ctx.lastGrant;
    const isActive = () => !ctx.disposed && !isSigningOut() && ctx.exclusive.ok && getAuthEpoch() === syncEpoch
      && getPublications() === publication && ctx.lastGrant === expectedGrant
      && (observation ? ctx.state === 'error' && ctx.error === 'IAM_REAUTH_REQUIRED'
        && getObservation() === observation && now() < observation.deadline
        : ctx.state !== 'authenticating' && ctx.state !== 'error' && !hasSignInAttempt());
    const published = () => {
      publication = bumpPublications();
      expectedGrant = ctx.lastGrant;
    };
    const discardIdentity = (reason) => {
      // Store lookups can be rebound independently. Clear only the adopted
      // identity this sync still owns, never a later publication (even null).
      if (expectedGrant && ctx.lastGrant === expectedGrant && grants.had(expectedGrant)) {
        logRenewal?.('store-sync', { reason, ...renewalDeadlines(expectedGrant) });
        ctx.lastGrant = null;
        ctx.state = 'signed-out';
        ctx.error = null;
        published();
        ctx.notify();
      }
    };
    if (!expectedIssuer) {
      if (!issuerResolution) {
        // Resolve it before reading the saved grant; otherwise every restart
        // rejects a valid session as a context mismatch. A failed fetch leaves
        // the issuer empty, so the assertion below still fails closed for a
        // saved grant.
        issuerResolution = grants.metadata().catch(() => {});
      }
      await issuerResolution;
      expectedIssuer = ctx.knownIssuer();
      if (!isActive()) return ctx.view();
    }
    const targetStore = provider.ensure();
    if (!isActive()) return ctx.view();
    const targetCredentials = provider.storeCredentials;
    if (readRetry) {
      const current = readRetry.store === targetStore && readRetry.credentials === targetCredentials
        && readRetry.authEpoch === syncEpoch && readRetry.observation === observation
        && (observation || (ctx.state === 'unreachable' && ctx.error === 'IAM_CREDENTIALS_UNAVAILABLE'));
      if (!current) {
        cancelReadRetry();
        if (retry) return ctx.view();
      } else if (!retry) return ctx.view();
    }
    if (!targetStore || (observation && targetStore !== observation.store)) {
      if (!targetStore) discardIdentity('credentials-unavailable');
      setObservation(null);
      return ctx.view();
    }
    const consumption = beginConsumption(expectedIssuer, targetStore, targetCredentials);
    // Re-read the live provider after each await; the lookup itself may also
    // synchronously dispose this service or start a newer auth operation.
    const isCurrent = () => {
      if (!isActive()) return false;
      const currentStore = provider.ensure();
      if (!isActive()) return false;
      if (currentStore === targetStore && provider.storeCredentials === targetCredentials) return true;
      discardIdentity('provider-changed');
      if (observation && getObservation() === observation) setObservation(null);
      return false;
    };
    let reading = true;
    try {
      const record = await targetStore.read();
      reading = false;
      ctx.recheckExclusive();
      if (!isCurrent()) return ctx.view();
      if (retry) logRenewal?.('store-sync', { stage: 'store-read', reason: 'store-read-recovered' });
      if (!record.ok) {
        logRenewal?.('store-sync', { reason: 'grant-invalid', code: 'IAM_GRANT_INVALID' });
        setObservation(null);
        ctx.lastGrant = null;
        ctx.error = 'IAM_GRANT_INVALID';
        ctx.state = 'error';
        published();
        ctx.notify();
        return ctx.view();
      }
      if (!record.grant) {
        if (observation) {
          setObservation(null);
          return ctx.view();
        }
        const changed = ctx.lastGrant !== null || ctx.state !== 'signed-out';
        ctx.lastGrant = null;
        published();
        if (changed) {
          logRenewal?.('store-sync', { reason: 'grant-missing' });
          ctx.error = null;
          ctx.state = 'signed-out';
          ctx.notify();
        }
        return ctx.view();
      }
      grants.assertGrantContext(record.grant, expectedIssuer);
      const authentication = await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: record.grant, guard: () => {
        if (!isCurrent()) throw new IamError('IAM_CLIENT_AUTH_CHANGED', safeMessage('IAM_CLIENT_AUTH_CHANGED'));
      } });
      if (!isCurrent()) return ctx.view();
      assertClientAuthCurrent(authentication);
      const marker = record.grant.refreshOperation;
      const identity = grantIdentity(record.grant);
      // The token resolver owns confirmation for this already-adopted login.
      // Other logins and missing records still take the normal invalidation path.
      if (!observation && marker?.state !== 'pending' && expectedGrant && token.hasObservedRotation()
        && isDeepStrictEqual(identity, grantIdentity(expectedGrant))) return ctx.view();
      const refreshDigest = (grant, id) => createHmac('sha256', id).update(grant.refreshToken).digest('base64url');
      const restored = observation && marker?.state !== 'pending' && isDeepStrictEqual(identity, observation.identity)
        && refreshBaseId(record.grant, observation.id) === observation.base
        && (!isAccessExpired(record.grant, now()) || isRefreshUsable(record.grant, now()));
      if (observation && !restored) {
        if (!marker || marker.version !== observation.version || marker.id !== observation.id
          || marker.base !== observation.base || !isDeepStrictEqual(identity, observation.identity)) {
          logRenewal?.('store-sync', { reason: 'pending-result-unmatched' });
          setObservation(null);
          return ctx.view();
        }
        const sameRefresh = refreshDigest(record.grant, marker.id) === observation.refreshDigest;
        if (marker.state === 'pending' && sameRefresh) return ctx.view();
        if (marker.state !== 'complete' || sameRefresh
          || isAccessExpired(record.grant, now()) || !isRefreshUsable(record.grant, now())) {
          logRenewal?.('store-sync', { reason: 'pending-result-unmatched' });
          setObservation(null);
          return ctx.view();
        }
      } else if (marker?.state === 'pending') {
        const ownFlight = token.ownedPendingFlight(targetStore, targetCredentials, record.grant);
        if (ownFlight) {
          // Avoid presenting our own in-progress rotation as a sign-out. Wait
          // only a bounded time; an unconfirmed operation still fails closed.
          let timer;
          const finished = await Promise.race([
            ownFlight.then(() => true, () => true),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), REFRESH_TIMEOUT_MS); }),
          ]).finally(() => clearTimeout(timer));
          if (!isCurrent() || finished) return ctx.view();
        }
        const observing = !ownFlight && token.observePendingRotation(targetStore, targetCredentials, record.grant);
        logRenewal?.('store-sync', { reason: ownFlight ? 'local-pending-timeout' : 'peer-pending',
          code: observing ? undefined : 'IAM_REAUTH_REQUIRED', ...renewalDeadlines(record.grant) });
        if (observing) return ctx.view();
        setObservation({ version: marker.version, id: marker.id, base: marker.base,
          identity, refreshDigest: refreshDigest(record.grant, marker.id), authEpoch: getAuthEpoch(), store: targetStore,
          deadline: now() + REFRESH_TIMEOUT_MS });
        ctx.lastGrant = null;
        ctx.state = 'error';
        ctx.error = 'IAM_REAUTH_REQUIRED';
        published();
        ctx.notify();
        return ctx.view();
      }
      const previousGrant = ctx.lastGrant;
      const previousSubject = ctx.lastGrant?.subject ?? null;
      const previousExpiry = ctx.lastGrant?.accessExpiresAt ?? null;
      const previousRefreshExpiry = ctx.lastGrant?.refreshExpiresAt ?? null;
      const previousRefreshToken = ctx.lastGrant?.refreshToken ?? null;
      const previous = `${ctx.state}|${ctx.error}|${previousSubject}`;
      ctx.lastGrant = record.grant;
      grants.own(record.grant, targetStore);
      published();
      // An adopted subject changes the displayed match, not the stored key.
      if (retry || observation || (previousSubject !== null && record.grant.subject !== previousSubject)) {
        await gateway.load({ force: true });
        if (!isCurrent()) {
          if (ctx.lastGrant === record.grant) ctx.lastGrant = null;
          return ctx.view();
        }
        assertClientAuthCurrent(authentication);
      }
      grants.rememberAuthentication(authentication, record.grant);
      if (observation) setObservation(null);
      // `expired` means the access token is no longer usable, not merely inside
      // the refresh skew: a token request renews the latter, and showing "expired"
      // while the token still works would send the user through a needless login.
      ctx.state = isAccessExpired(record.grant, now()) ? 'expired' : 'ready';
      ctx.error = null;
      adoptConsumption(consumption, record.grant);
      if (logRenewal && (observation || (marker?.state === 'complete' && previousGrant
        && previousRefreshToken !== record.grant.refreshToken && isDeepStrictEqual(grantIdentity(previousGrant), identity)))) {
        logRenewal('store-sync', { reason: restored ? 'peer-restored' : 'peer-complete',
          state: ctx.state, ...renewalDeadlines(record.grant) });
      }
      if (restored) token.lastBackgroundRefreshAt = now();
      // With a usable refresh token an expired session is recoverable; without
      // this, the interim client would only ever offer a full re-login.
      if (ctx.state === 'expired' && isRefreshUsable(record.grant, now())
        && now() - token.lastBackgroundRefreshAt >= AUTO_REFRESH_BACKOFF_MS
        && provider.atomicVerified(targetCredentials)) {
        if (!isCurrent()) return ctx.view();
        token.lastBackgroundRefreshAt = now();
        logRenewal?.('store-sync', { reason: 'expired-recovery', state: ctx.state, ...renewalDeadlines(record.grant) });
        void resolveToken().catch(() => {});
      }
      if (previous !== `${ctx.state}|${ctx.error}|${ctx.lastGrant.subject ?? ''}`
        || previousExpiry !== (ctx.lastGrant.accessExpiresAt ?? null)
        || previousRefreshExpiry !== (ctx.lastGrant.refreshExpiresAt ?? null)
        || previousRefreshToken !== (ctx.lastGrant.refreshToken ?? null)) ctx.notify();
      // A due timer that failed before reading can renew immediately after its
      // exact grant is read back. A replacement follows its own cadence.
      if (retry?.renewGrant && ctx.state === 'ready' && isDeepStrictEqual(retry.renewGrant, record.grant) && isCurrent()) {
        token.scheduleRenewal({ immediate: true });
      }
    } catch (cause) {
      if (!isCurrent()) return ctx.view();
      if (reading && cause?.code === 'CRED_LOCK_TIMEOUT' && deferRead({ targetStore, targetCredentials,
        authEpoch: syncEpoch, grant: expectedGrant, renewGrant: retry?.renewGrant, observation }, retry)) return ctx.view();
      setObservation(null);
      ctx.lastGrant = null;
      ctx.error = ['IAM_GRANT_CONTEXT_MISMATCH', 'IAM_CLIENT_AUTH_CONTEXT_INVALID', 'IAM_CLIENT_AUTH_UNVERIFIED', 'IAM_CLIENT_AUTH_CHANGED', 'CRED_KEY_UNAVAILABLE', 'CRED_DECRYPT_FAILED'].includes(cause?.code)
        ? cause.code : 'IAM_CREDENTIALS_UNAVAILABLE';
      logRenewal?.('store-sync', { reason: reading ? 'store-read-failed' : 'rejected',
        code: ctx.error, ...renewalErrorFields(cause) });
      ctx.state = 'error';
      published();
      ctx.notify();
    }
    return ctx.view();
  }
  async function hydrate() {
    // Preserve any pre-existing legacy reference; its migration or deletion
    // requires a separate decision and does not make it safe to consume.
    await syncFromStore();
    await gateway.load({ force: true });
    return ctx.view();
  }

  return { syncFromStore, hydrate, deferRead, cancelReadRetry };
}
