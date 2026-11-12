import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { IamError } from './errors.mjs';
import { BRIDGE_REF } from './bridge.mjs';
import { revokeAccessToken } from './oidc.mjs';
import { grantIdentity, REFRESH_TIMEOUT_MS, safeMessage } from './service-helpers.mjs';

const BRIDGE_RECORD = 'heluo-iam/bridge-capability';
const BRIDGE_VALUE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const BRIDGE_SCOPE = Object.freeze({ recordKey: BRIDGE_RECORD, ref: BRIDGE_REF });

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
    config, ctx, provider, grants, gateway, token, now, fetchImpl, getBridgeAtomicStore, verifyBridgeAtomicStore,
    bumpAuthEpoch, clearObservation, clearAttempt, invalidateConsumption,
  } = env;

  let signOutPromise = null;
  let signingOut = false;
  let bridgePromise = null;
  let bridgeProvider = null;

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
    const unknownSignOut = (remote) => {
      checkDisposed();
      ctx.lastGrant = null;
      grants.clearProfile();
      ctx.error = 'IAM_CREDENTIALS_CLEAR_FAILED';
      ctx.state = 'error';
      ctx.notify();
      return { view: ctx.view(), logoutUrl: null, revocation: remote?.state === 'failed' ? 'failed' : 'unknown',
        ...(remote?.code ? { revocationError: remote.code } : {}) };
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
        // A failed or unconfirmed remote operation cannot authorize the local
        // completion; the durable pending grant prevents replay after restart.
        if (outcome.state !== 'ok') throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', 'revocation was not confirmed');
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
    if (!cleared.ok || !['cleared', 'absent'].includes(cleared.decision)) {
      return unknownSignOut(revocation === 'failed' || revocation === 'unknown'
        ? { state: revocation, code: revocationError } : undefined);
    }
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
    const store = provider.require();
    const credentials = provider.storeCredentials;
    const unavailable = () => new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    const checkCurrent = () => {
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      provider.assertAtomic(store, credentials);
    };
    const requireAdapter = () => {
      checkCurrent();
      let adapter;
      let verified;
      try {
        adapter = getBridgeAtomicStore?.(credentials);
        if (adapter && typeof adapter.then === 'function') { Promise.resolve(adapter).catch(() => {}); throw unavailable(); }
        verified = verifyBridgeAtomicStore?.(credentials, adapter, BRIDGE_SCOPE);
        if (verified && typeof verified.then === 'function') { Promise.resolve(verified).catch(() => {}); throw unavailable(); }
      } catch { throw unavailable(); }
      if (verified !== true || typeof adapter?.snapshot !== 'function' || typeof adapter?.compareAndSwap !== 'function') throw unavailable();
      checkCurrent();
      return adapter;
    };
    const inspect = (pair) => {
      if (!pair || typeof pair !== 'object' || !Object.hasOwn(pair, 'record') || !Object.hasOwn(pair, 'value')) throw unavailable();
      const { record, value } = pair;
      if (value !== undefined && (typeof value !== 'string' || !BRIDGE_VALUE_PATTERN.test(value))) throw unavailable();
      let stored;
      if (record !== undefined) {
        const payload = record?.payload;
        if (record?.kind !== 'grant' || Object.keys(record).length !== 2
          || !payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).sort().join(',') !== 'type,value,version'
          || payload.version !== 1 || payload.type !== 'heluo-iam-bridge-capability'
          || typeof payload.value !== 'string' || !BRIDGE_VALUE_PATTERN.test(payload.value)) throw unavailable();
        stored = payload.value;
      }
      if (stored !== undefined && value !== undefined && stored !== value) throw unavailable();
      return { value: stored ?? value, complete: stored !== undefined && value !== undefined };
    };
    checkCurrent();
    if (bridgePromise && bridgeProvider === credentials) return bridgePromise;
    const flight = Promise.resolve().then(async () => {
      const adapter = requireAdapter();
      const snapshot = async () => {
        let pair;
        try { pair = await adapter.snapshot(BRIDGE_SCOPE); } catch { throw unavailable(); }
        if (requireAdapter() !== adapter) throw unavailable();
        try { return structuredClone(pair); } catch { throw unavailable(); }
      };
      const expected = await snapshot();
      const state = inspect(expected);
      if (state.complete) return state.value;
      const value = state.value ?? randomBytes(32).toString('base64url');
      const next = { record: { kind: 'grant', payload: { version: 1, type: 'heluo-iam-bridge-capability', value } }, value };
      const requestedExpected = structuredClone(expected);
      const requestedNext = structuredClone(next);
      let calls = 0;
      let permitted = false;
      const guard = () => {
        if (++calls !== 1 || requireAdapter() !== adapter
          || !isDeepStrictEqual(requestedExpected, expected) || !isDeepStrictEqual(requestedNext, next)) throw unavailable();
        permitted = true;
        return true;
      };
      let receipt;
      try { receipt = await adapter.compareAndSwap(BRIDGE_SCOPE, requestedExpected, requestedNext, guard); }
      catch { throw unavailable(); }
      if (requireAdapter() !== adapter) throw unavailable();
      if (receipt?.ok === false && calls === 0) {
        // A known comparison conflict permits one read, never another write.
        const observed = inspect(await snapshot());
        if (observed.complete) return observed.value;
        throw unavailable();
      }
      if (receipt?.ok !== true || calls !== 1 || !permitted || !isDeepStrictEqual(receipt.snapshot, next)) throw unavailable();
      return value;
    }).finally(() => {
      if (bridgePromise === flight) { bridgePromise = null; bridgeProvider = null; }
    });
    bridgeProvider = credentials;
    bridgePromise = flight;
    return flight;
  }
  return {
    signOut,
    signOutOnce,
    bridgeCapability,
    get inFlight() { return signOutPromise; },
    get signingOut() { return signingOut; },
  };
}
