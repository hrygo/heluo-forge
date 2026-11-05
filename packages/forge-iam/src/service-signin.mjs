import { isDeepStrictEqual } from 'node:util';
import { assertClientAuthCurrent, clientAuthDescriptor } from './client-auth.mjs';
import { isConfigured } from './config.mjs';
import { IamError } from './errors.mjs';
import { buildAuthorizationUrl, createPkce, exchangeCode, parseCallbackUrl, randomToken, revokeToken, safeStateEqual } from './oidc.mjs';
import { nowIso, safeMessage, tokenErrorMessage } from './service-helpers.mjs';
import { transition } from './state.mjs';

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
    isSigningOut, getAuthEpoch, bumpAuthEpoch, clearObservation,
    getSignInPromise, setSignInPromise, invalidateConsumption, beginConsumption, adoptConsumption,
  } = env;

  let attempt = null;

  function clearAttempt() {
    if (!attempt) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt = null;
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
      if (config.authMode === 'confidential') {
        const current = attempt; const epoch = getAuthEpoch();
        const authentication = await grants.prepareAuthentication(current.metadata.issuer, targetStore, credentials, { expected: current.authentication, guard: () => {
          if (attempt !== current || epoch !== getAuthEpoch() || isSigningOut()) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
          provider.assertAtomic(targetStore, credentials);
        } });
        assertClientAuthCurrent(authentication);
      }
      return { view: ctx.view(), authorizationUrl: attempt.authorizationUrl };
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
    if (!transition(ctx.state, 'SIGN_IN').ok) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
    const oauthState = randomToken(32);
    const nonce = randomToken(32);
    const pkce = createPkce();
    const callbackUri = grants.redirectUri();
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
  }

  async function handleCallback(rawUrl) {
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
    const attemptEpoch = getAuthEpoch();
    const consumption = beginConsumption(current.metadata.issuer, current.targetStore, current.credentials, current.consumption ?? null);
    const isCurrent = () => {
      if (attempt === current && getAuthEpoch() === attemptEpoch && ctx.state === 'authenticating'
        && now() > current.expiresAt) {
        current.expired = true;
        clearAttempt();
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
    const callbackGuard = () => {
      if (!isCurrent()) throw interrupted();
      ctx.assertExclusive();
      provider.assertAtomic(current.targetStore, current.credentials);
      if (!isCurrent()) throw interrupted();
    };
    try {
      authentication = await grants.prepareAuthentication(current.metadata.issuer, current.targetStore, current.credentials, { expected: current.authentication, guard: callbackGuard });
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
      await grants.loadIdentityProfile(grant);
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
          const cleanupAuthentication = await grants.prepareAuthentication(current.metadata.issuer, current.targetStore, current.credentials, { expected: current.authentication, guard: callbackGuard });
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
        if (!ctx.disposed && !isSigningOut() && (stillCurrent || (!attempt && (ctx.state === 'signed-out' || ctx.state === 'error')))) {
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
  }

  async function cancelSignIn() {
    invalidateConsumption();
    if (ctx.disposed) return ctx.view();
    bumpAuthEpoch();
    clearObservation();
    // A cancelled attempt no longer owns the state machine, even when it never
    // reached `authenticating` (discovery or client-auth was still pending):
    // leaving its promise registered would keep blocking background hydration.
    setSignInPromise(null);
    if (ctx.state !== 'authenticating') return ctx.view();
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
