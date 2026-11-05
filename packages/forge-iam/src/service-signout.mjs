import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { IamError } from './errors.mjs';
import { revokeAccessToken } from './oidc.mjs';
import { StoreError } from './store.mjs';
import { grantIdentity, safeMessage } from './service-helpers.mjs';

const BRIDGE_REF = 'iam.bridge.capability';
const REFRESH_TIMEOUT_MS = 5000;

/**
 * Sign-out: one flight, registered before any work runs so that a provider that
 * reenters synchronously observes the same promise.
 *
 * A cleanup that cannot be confirmed is never reported as a successful exit:
 * the view says `unknown` and keeps the error, because claiming success would
 * hide a credential that may still be readable.
 */
export function createSignOut(env) {
  const {
    config, ctx, provider, grants, gateway, token, now, fetchImpl,
    bumpAuthEpoch, clearObservation, clearAttempt, invalidateConsumption,
  } = env;

  let signOutPromise = null;
  let signingOut = false;

  async function signOut() {
    invalidateConsumption();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (signOutPromise) return signOutPromise;
    signingOut = true;
    bumpAuthEpoch();
    clearObservation();
    clearAttempt();
    // Register before running any work: provider checks and notifications can
    // synchronously reenter signOut. All callers observe the final outcome.
    signOutPromise = Promise.resolve().then(() => signOutOnce()).finally(() => {
      signingOut = false;
      signOutPromise = null;
    });
    return signOutPromise;
  }

  async function signOutOnce() {
    const checkDisposed = () => {
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    };
    checkDisposed();
    let expectedIssuer = ctx.knownIssuer();
    if (token.inFlight) await token.inFlight.catch(() => {});
    checkDisposed();
    let grant = null;
    const targetStore = provider.ensure();
    const targetCredentials = provider.storeCredentials;
    checkDisposed();
    const unknownSignOut = () => {
      checkDisposed();
      ctx.lastGrant = null;
      grants.clearProfile();
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
        grants.assertGrantBinding(grant);
        if (config.issuer) grants.assertGrantContext(grant, expectedIssuer);
      } catch { return unknownSignOut(); }
    }
    checkDisposed();
    try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
    checkDisposed();
    ctx.lastGrant = null;
    let revocation = 'skipped';
    let revocationError = null;
    let meta = grants.metadataCache;
    let revocationEndpoint = meta?.revocationEndpoint ?? config.revocationEndpoint;
    if (grant && config.discoveryUrl && (!revocationEndpoint || !config.issuer)) {
      try {
        meta = await grants.metadata();
        revocationEndpoint = meta.revocationEndpoint ?? config.revocationEndpoint;
      } catch {
        // An explicit endpoint cannot authenticate an otherwise unbound issuer.
        if (!config.issuer) return unknownSignOut();
        revocationEndpoint = undefined;
      }
    }
    expectedIssuer = meta?.issuer || expectedIssuer;
    try { grants.assertGrantContext(grant, expectedIssuer); } catch { return unknownSignOut(); }
    checkDisposed();
    // A locally authenticated session must not clear a grant that another
    // process replaced; the check needs no client secret.
    if (ctx.sessionAuthentication && grant
      && (ctx.sessionAuthentication.credentials !== targetCredentials
        || !isDeepStrictEqual(ctx.sessionAuthentication.identity, grantIdentity(grant)))) {
      return unknownSignOut();
    }
    // D1 (2026-11-04): revoke the local access token with a GET that carries
    // the token itself and no client authentication. A missing client secret
    // must not stop sign-out, and the refresh token cannot be revoked here.
    const revokeCurrent = async (current) => {
      checkDisposed();
      provider.assertAtomic(targetStore, targetCredentials);
      checkDisposed();
      grants.assertGrantContext(current, expectedIssuer);
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
    await gateway.load({ force: true });
    checkDisposed();
    try { provider.assertAtomic(targetStore, targetCredentials); } catch { return unknownSignOut(); }
    checkDisposed();
    let logoutUrl = null;
    if (config.logoutMode === 'rp' && grant?.idToken) {
      try {
        const meta = grants.metadataCache ?? await grants.metadata();
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
    ctx.sessionAuthentication = null;
    grants.clearProfile();
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
  }

  async function bridgeCapability() {
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
  }
  return {
    signOut,
    signOutOnce,
    bridgeCapability,
    get inFlight() { return signOutPromise; },
    get signingOut() { return signingOut; },
  };
}
