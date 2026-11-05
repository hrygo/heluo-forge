import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertClientAuthCurrent } from './client-auth.mjs';
import { IamError } from './errors.mjs';
import { isAccessExpired, isRefreshUsable } from './record.mjs';
import { AUTO_REFRESH_BACKOFF_MS, grantIdentity, REFRESH_TIMEOUT_MS, safeMessage } from './service-helpers.mjs';

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
    getPublications, bumpPublications, beginConsumption, adoptConsumption, resolveToken,
  } = env;

  async function syncFromStore() {
    if (ctx.disposed || isSigningOut()) return ctx.view();
    if (!configured || !ctx.exclusive.ok) return ctx.view();
    // A user-triggered sign-in owns the state machine until its callback,
    // cancellation, or timeout; a background hydration must not clobber it.
    if (ctx.state === 'authenticating' || hasSignInAttempt()) return ctx.view();
    // Only an error created by this instance observing pending can recover.
    const observation = ctx.state === 'error' ? getObservation() : null;
    if (ctx.state === 'error' && (!observation || ctx.error !== 'IAM_REAUTH_REQUIRED'
      || observation.authEpoch !== getAuthEpoch() || now() >= observation.deadline)) {
      setObservation(null);
      return ctx.view();
    }
    const expectedIssuer = ctx.knownIssuer();
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
    const discardIdentity = () => {
      // Store lookups can be rebound independently. Clear only the adopted
      // identity this sync still owns, never a later publication (even null).
      if (expectedGrant && ctx.lastGrant === expectedGrant && grants.had(expectedGrant)) {
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
      setObservation(null);
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
      if (observation && getObservation() === observation) setObservation(null);
      return false;
    };
    try {
      const record = await targetStore.read();
      ctx.recheckExclusive();
      if (!isCurrent()) return ctx.view();
      if (!record.ok) {
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
      const refreshDigest = (grant, id) => createHmac('sha256', id).update(grant.refreshToken).digest('base64url');
      if (observation) {
        if (!marker || marker.version !== observation.version || marker.id !== observation.id
          || marker.base !== observation.base || !isDeepStrictEqual(identity, observation.identity)) {
          setObservation(null);
          return ctx.view();
        }
        const sameRefresh = refreshDigest(record.grant, marker.id) === observation.refreshDigest;
        if (marker.state === 'pending' && sameRefresh) return ctx.view();
        if (marker.state !== 'complete' || sameRefresh
          || isAccessExpired(record.grant, now()) || !isRefreshUsable(record.grant, now())) {
          setObservation(null);
          return ctx.view();
        }
      } else if (marker?.state === 'pending') {
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
      const previousSubject = ctx.lastGrant?.subject ?? null;
      const previous = `${ctx.state}|${ctx.error}|${previousSubject}`;
      ctx.lastGrant = record.grant;
      grants.own(record.grant, targetStore);
      published();
      // An adopted subject changes the displayed match, not the stored key.
      if (observation || (previousSubject !== null && record.grant.subject !== previousSubject)) {
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
      // With a usable refresh token an expired session is recoverable; without
      // this, the interim client would only ever offer a full re-login.
      if (ctx.state === 'expired' && isRefreshUsable(record.grant, now())
        && now() - token.lastBackgroundRefreshAt >= AUTO_REFRESH_BACKOFF_MS) {
        token.lastBackgroundRefreshAt = now();
        void resolveToken().catch(() => {});
      }
      if (previous !== `${ctx.state}|${ctx.error}|${ctx.lastGrant.subject ?? ''}`) ctx.notify();
    } catch (cause) {
      if (!isCurrent()) return ctx.view();
      setObservation(null);
      ctx.lastGrant = null;
      ctx.error = ['IAM_GRANT_CONTEXT_MISMATCH', 'IAM_CLIENT_AUTH_CONTEXT_INVALID', 'IAM_CLIENT_AUTH_UNVERIFIED', 'IAM_CLIENT_AUTH_CHANGED'].includes(cause?.code)
        ? cause.code : 'IAM_CREDENTIALS_UNAVAILABLE';
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

  return { syncFromStore, hydrate };
}
