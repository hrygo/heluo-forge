import { isDeepStrictEqual } from 'node:util';
import { assertClientAuthCurrent, clientAuthDescriptor } from './client-auth.mjs';
import { isConfigured } from './config.mjs';
import { IamError } from './errors.mjs';
import { OidcError, buildAuthorizationUrl, createPkce, exchangeCode, parseCallbackUrl, randomToken, revokeSessionToken, safeStateEqual } from './oidc.mjs';
import { nowIso, safeMessage, tokenErrorMessage } from './service-helpers.mjs';
import { credentialStoreUnavailable, transition } from './state.mjs';

/**
 * The sign-in attempt: one at a time, cancellable, and provably the same attempt
 * when its callback arrives.
 *
 * The attempt object is the only place the verifier, nonce and expected issuer
 * live, so a callback that does not match it cannot adopt a grant. Every await
 * re-checks the epoch pair, which is what makes a replaced provider or a
 * cancelled attempt unable to publish late.
 */
export function createSignIn(env) {
  const {
    config, configured, ctx, provider, grants, gateway, token, now, fetchImpl,
    openCallback, closeCallback, recoverCredentialStore, isSigningOut, getAuthEpoch, bumpAuthEpoch,
    clearObservation,
    getSignInPromise, setSignInPromise, invalidateConsumption, beginConsumption, adoptConsumption,
  } = env;

  let attempt = null;
  let recoveryRequestEpoch = 0;

  function clearAttempt(responseDone) {
    const current = attempt;
    if (!current) return;
    attempt = null;
    clearTimeout(current.timer);
    // A terminal callback defers its own drain until the HTML is flushed.
    // Cancellation and teardown can release immediately.
    closeCallback?.(current.listenerOwner, responseDone);
  }

  async function startSignIn() {
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (!configured) {
      throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
        missing: isConfigured(config).missing,
      });
    }
    if (isSigningOut()) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
    const targetStore = provider.ensure();
    const credentials = provider.storeCredentials;
    if (credentialStoreUnavailable(ctx.state, ctx.error)) {
      const epoch = getAuthEpoch();
      const requestEpoch = recoveryRequestEpoch;
      const binding = provider.atomicBinding(targetStore, credentials);
      if (!binding) throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      await recoverCredentialStore();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      ctx.assertExclusive();
      if (provider.atomicBinding(targetStore, credentials) !== binding) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      if (isSigningOut() || requestEpoch !== recoveryRequestEpoch) {
        throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      }
      if (epoch !== getAuthEpoch()) {
        if (getSignInPromise()) return getSignInPromise();
        throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      }
      if (!['signed-out', 'ready', 'expired'].includes(ctx.state)) {
        const code = ctx.error ?? 'IAM_CREDENTIALS_UNAVAILABLE';
        throw new IamError(code, safeMessage(code));
      }
    }
    if (attempt && (attempt.targetStore !== targetStore || attempt.credentials !== credentials)) {
      bumpAuthEpoch();
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
      const current = attempt;
      const epoch = getAuthEpoch();
      const assertCurrent = () => {
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
        if (attempt !== current || epoch !== getAuthEpoch() || isSigningOut()) {
          throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
        }
      };
      if (config.authMode === 'confidential') {
        const authentication = await grants.prepareAuthentication(current.metadata.issuer, targetStore, credentials, { expected: current.authentication, guard: () => {
          assertCurrent();
          provider.assertAtomic(targetStore, credentials);
        } });
        assertClientAuthCurrent(authentication);
      }
      let redirectUri;
      try {
        redirectUri = grants.redirectUri();
      } catch (error) {
        assertCurrent();
        await cancelSignIn();
        throw error;
      }
      assertCurrent();
      if (redirectUri !== current.redirectUri) {
        await cancelSignIn();
        throw new IamError('IAM_CALLBACK_UNAVAILABLE', safeMessage('IAM_CALLBACK_UNAVAILABLE'));
      }
      return { view: ctx.view(), authorizationUrl: current.authorizationUrl };
    }
    if (getSignInPromise()) return getSignInPromise();
    bumpAuthEpoch();
    clearObservation();
    invalidateConsumption();
    const consumption = beginConsumption(ctx.knownIssuer(), targetStore, credentials);
    const pending = startSignInOnce(targetStore, credentials, consumption);
    // Only the attempt that still owns the slot clears it: a cancel or a newer
    // sign-in must not be overwritten by a superseded attempt settling late.
    const settle = () => { if (getSignInPromise() === pending) setSignInPromise(null); };
    pending.then(settle, settle);
    setSignInPromise(pending);
    return getSignInPromise();
  }

  async function startSignInOnce(targetStore, credentials, consumption) {
    const startEpoch = getAuthEpoch();
    if (ctx.state === 'unreachable') {
      throw new IamError('IAM_UNREACHABLE', safeMessage('IAM_UNREACHABLE'));
    }
    let meta;
    try {
      meta = await grants.metadata();
    } catch (err) {
      const code = tokenErrorMessage(err);
      const mapped = code === 'IAM_HTTP_ERROR' || code === 'IAM_DISCOVERY_INVALID' ? 'IAM_UNREACHABLE' : code;
      throw new IamError(mapped, safeMessage(mapped));
    }
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (getAuthEpoch() !== startEpoch || isSigningOut()) {
      throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
    }
    provider.assertAtomic(targetStore, credentials);
    const authentication = await grants.prepareAuthentication(meta.issuer, targetStore, credentials, { expected: null, guard: () => {
      if (getAuthEpoch() !== startEpoch || isSigningOut()) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      provider.assertAtomic(targetStore, credentials);
    } });
    assertClientAuthCurrent(authentication);
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (getAuthEpoch() !== startEpoch || isSigningOut()) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
    if (ctx.state === 'ready') return { view: ctx.view(), authorizationUrl: null };
    // A stale attempt must be dropped before the new bind: clearing it releases
    // the listener, and doing that afterwards would release the new one.
    if (attempt) clearAttempt();
    // The callback listener exists only while an attempt is open, so it binds
    // here: a failed bind refuses the sign-in before any URL is produced. Every
    // await re-checks the same guards.
    const listenerOwner = {};
    try {
      await openCallback?.(listenerOwner);
    } catch (error) {
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      throw error;
    }
    if (ctx.disposed) {
      closeCallback?.(listenerOwner);
      throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    }
    if (getAuthEpoch() !== startEpoch || isSigningOut()) {
      closeCallback?.(listenerOwner);
      throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
    }
    if (!transition(ctx.state, 'SIGN_IN').ok) {
      closeCallback?.(listenerOwner);
      throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
    }
    const oauthState = randomToken(32);
    const nonce = randomToken(32);
    const pkce = createPkce();
    let callbackUri;
    let authorizationUrl;
    try {
      assertClientAuthCurrent(authentication);
      callbackUri = grants.redirectUri();
      authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: meta.authorizationEndpoint,
        clientId: config.clientId,
        redirectUri: callbackUri,
        scopes: config.scopes,
        state: oauthState,
        nonce,
        codeChallenge: pkce.challenge,
        resource: config.gatewayResource,
      });
    } catch (error) {
      // No attempt owns the listener yet, so unwind both the bind and the state
      // transition here; otherwise the port stays open with nothing to close it.
      closeCallback?.(listenerOwner);
      if (transition(ctx.state, 'CANCEL').ok) ctx.notify();
      throw error;
    }
    attempt = {
      listenerOwner,
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
        clearAttempt(scheduledAttempt.responseDone);
        ctx.error = 'IAM_ATTEMPT_EXPIRED';
        if (ctx.state === 'authenticating') ctx.state = 'error';
        ctx.notify();
      }
    }, config.attemptTimeoutSeconds * 1000);
    attempt.timer.unref?.();
    ctx.publish('SIGN_IN');
    return { view: ctx.view(), authorizationUrl };
  }

  async function handleCallback(rawUrl, responseDone) {
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
      clearAttempt(responseDone);
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
      if (code === 'IAM_AUTHORIZATION_ERROR') {
        clearAttempt(responseDone);
        ctx.fail(code);
      }
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
    current.responseDone = responseDone;
    const attemptEpoch = getAuthEpoch();
    const consumption = beginConsumption(current.metadata.issuer, current.targetStore, current.credentials, current.consumption ?? null);
    const isCurrent = () => {
      if (attempt === current && getAuthEpoch() === attemptEpoch && ctx.state === 'authenticating'
        && now() > current.expiresAt) {
        current.expired = true;
        clearAttempt(responseDone);
        ctx.error = 'IAM_ATTEMPT_EXPIRED';
        ctx.state = 'error';
        ctx.notify();
      }
      return attempt === current && getAuthEpoch() === attemptEpoch && ctx.state === 'authenticating';
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
    let exchangeBinding;
    const callbackGuard = () => {
      if (!isCurrent()) throw interrupted();
      ctx.assertExclusive();
      provider.assertAtomic(current.targetStore, current.credentials);
      if (!isCurrent()) throw interrupted();
    };
    const cleanupBindingCurrent = () => {
      if (!exchangeBinding || provider.atomicBinding(current.targetStore, current.credentials) !== exchangeBinding) return false;
      try {
        return assertClientAuthCurrent(authentication);
      } catch (error) {
        if (!(error instanceof IamError)) throw error;
        return false;
      }
    };
    try {
      authentication = await grants.prepareAuthentication(current.metadata.issuer, current.targetStore, current.credentials, { expected: current.authentication, guard: callbackGuard });
      exchangeBinding = provider.atomicBinding(current.targetStore, current.credentials);
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
      const claims = await grants.verifyWithJwks(token.idToken, {
        uri: current.metadata.jwksUri,
        issuer: current.metadata.issuer,
        clientId: config.clientId,
        nonce: current.nonce,
        guard: () => { callbackGuard(); assertClientAuthCurrent(authentication); },
        accessToken: token.accessToken,
      });
      assertClientAuthCurrent(authentication);
      const grant = await grants.buildGrant(token, claims, current.metadata, nowIso(now()), authentication);
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
      grants.own(grant, current.targetStore);
      await gateway.load({ force: true });
      assertClientAuthCurrent(authentication);
      provider.assertAtomic(current.targetStore, current.credentials);
      if (!isCurrent()) throw interrupted();
      grants.rememberAuthentication(authentication, grant);
      if (current.metadata.userInfoEndpoint) await grants.loadIdentityProfile(grant);
      if (!isCurrent()) throw interrupted();
      clearAttempt(responseDone);
      ctx.publish('SIGN_IN_SUCCESS');
      adoptConsumption(consumption, grant);
      if (!current.metadata.userInfoEndpoint && config.discoveryUrl) {
        // Discovery of optional profile data does not consume the login deadline.
        void grants.loadIdentityProfile(grant);
      }
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
      if (issuedToken && cleanupBindingCurrent()) {
        // Revoke only the tokens issued under the original callback binding.
        // RFC 7009 uses the
        // very same bound authentication as the exchange. The enterprise
        // endpoint only receives this callback's access token.
        let revocationEndpoint = current.metadata.revocationEndpoint;
        if (!revocationEndpoint && config.discoveryUrl) {
          const metadata = await grants.metadata({ optional: 'revocationEndpoint' }).catch((error) => {
            // A discovery protocol failure leaves cleanup unconfirmed.
            if (!(error instanceof OidcError)) throw error;
            return null;
          });
          if (metadata?.issuer === current.metadata.issuer && cleanupBindingCurrent()) {
            revocationEndpoint = metadata.revocationEndpoint;
          }
        }
        if (revocationEndpoint) {
          await revokeSessionToken({
            revocationMode: config.revocationMode,
            revocationEndpoint,
            accessToken: issuedToken.accessToken,
            refreshToken: issuedToken.refreshToken,
            clientAuthentication: authentication,
            clientId: config.clientId,
            fetchImpl,
            timeoutMs: config.httpTimeoutMs,
          });
        }
      }
      const stillCurrent = isCurrent();
      if (cleanupUnknown) {
        if (!ctx.disposed && !isSigningOut() && (stillCurrent || (!attempt && (ctx.state === 'signed-out' || ctx.state === 'error')))) {
          if (stillCurrent) clearAttempt(responseDone);
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
      clearAttempt(responseDone);
      ctx.fail(failureCode);
      throw new IamError(failureCode, safeMessage(failureCode));
    }
  }

  async function cancelSignIn() {
    // A user can cancel their explicit sign-in while the shared storage read
    // is pending. The background reader keeps its retry and renewal schedule.
    recoveryRequestEpoch += 1;
    if (ctx.state === 'unreachable' && ctx.error === 'IAM_CREDENTIALS_UNAVAILABLE') return ctx.view();
    invalidateConsumption();
    if (ctx.disposed) return ctx.view();
    bumpAuthEpoch();
    clearObservation();
    // A cancelled attempt no longer owns the state machine, even when it never
    // reached `authenticating` (discovery or client-auth was still pending):
    // leaving its promise registered would keep blocking background hydration.
    setSignInPromise(null);
    if (ctx.state !== 'authenticating') {
      const view = ctx.view();
      // Closing onboarding may cancel after sign-in completed. The epoch bump
      // invalidates older observers, including the existing renewal binding;
      // schedule the current session again without publishing a state change.
      if (ctx.state === 'ready' || ctx.state === 'expired') token.scheduleRenewal();
      return view;
    }
    clearAttempt();
    ctx.lastGrant = null;
    provider.gatewayEpoch += 1;
    provider.gatewaySummary = null;
    provider.gatewayLoadedAt = 0;
    return ctx.publish('CANCEL');
  }
  return {
    startSignIn,
    signInOnce: startSignInOnce,
    handleCallback,
    cancelSignIn,
    clearAttempt,
    get attempt() { return attempt; },
  };
}
