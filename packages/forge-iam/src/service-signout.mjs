import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { IamError } from './errors.mjs';
import { BRIDGE_REF } from './bridge.mjs';
import { assertClientAuthCurrent } from './client-auth.mjs';
import { parseHttpUrl } from './http-url.mjs';
import { revokeSessionToken } from './oidc.mjs';
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
    config, ctx, provider, grants, gateway, token, fetchImpl, getBridgeAtomicStore, verifyBridgeAtomicStore,
    bumpAuthEpoch, clearObservation, clearAttempt, invalidateConsumption,
  } = env;

  let signOutPromise = null;
  let signingOut = false;
  // Retain a token-free target across unconfirmed attempts even after the view
  // stops showing the adopted grant. A new local adoption can replace it.
  let logoutTarget = null;
  let bridgePromise = null;
  let bridgeProvider = null;

  function rememberPendingSignOut(store, identity) {
    const adopted = ctx.lastGrant;
    // Preserve the original login before the observer drops its token snapshot.
    // A cold observer can use the identity from that same validated pending read.
    if (adopted) {
      store = grants.ownerOf(adopted);
      identity = grantIdentity(adopted);
    } else if (logoutTarget) return;
    if (identity) logoutTarget = { store, identity: structuredClone(identity), pendingOnly: true };
  }

  async function signOut() {
    invalidateConsumption();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    if (signOutPromise) return signOutPromise;
    const adopted = ctx.lastGrant;
    if (adopted) logoutTarget = { store: grants.ownerOf(adopted), identity: structuredClone(grantIdentity(adopted)) };
    const ownedRefresh = token.takeRefreshForSignOut();
    signingOut = true;
    bumpAuthEpoch();
    clearObservation();
    clearAttempt();
    // Register before running any work: provider checks and notifications can
    // synchronously reenter signOut. All callers observe the final outcome.
    signOutPromise = Promise.resolve().then(() => signOutOnce(ownedRefresh)).finally(() => {
      signingOut = false;
      signOutPromise = null;
    });
    // Fence local consumers while refresh handoff and remote revocation are
    // still running. The published result comes from signOutOnce.
    if (ctx.lastGrant) ctx.notify();
    return signOutPromise;
  }

  async function signOutOnce(ownedRefresh) {
    const checkDisposed = () => {
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    };
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
    let expectedIssuer = ctx.knownIssuer();
    const targetStore = provider.ensure();
    const targetCredentials = provider.storeCredentials;
    const storeBinding = provider.atomicBinding(targetStore, targetCredentials);
    checkDisposed();
    if (!storeBinding) return unknownSignOut();
    const assertCurrent = () => {
      checkDisposed();
      if (provider.atomicBinding(targetStore, targetCredentials) !== storeBinding) {
        throw new IamError('IAM_ATOMIC_STORE_UNVERIFIED', safeMessage('IAM_ATOMIC_STORE_UNVERIFIED'));
      }
      checkDisposed();
      return true;
    };
    const refresh = token.inFlight;
    if (refresh) {
      let timer;
      const settled = await Promise.race([
        refresh.then(() => true, () => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), REFRESH_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (!settled) return unknownSignOut();
      try { assertCurrent(); } catch { return unknownSignOut(); }
    }
    const snapshot = await targetStore.readSignOutSnapshot().catch(() => ({ ok: false }));
    checkDisposed();
    if (!snapshot.ok) return unknownSignOut();
    let { record, grant } = snapshot;
    try {
      assertCurrent();
      if (logoutTarget && (targetStore !== logoutTarget.store
        || (grant && (!isDeepStrictEqual(grantIdentity(grant), logoutTarget.identity)
          || (logoutTarget.pendingOnly && !grant.signOutOperation))))) return unknownSignOut();
      // Discovery can establish the issuer below. Client and resource checks
      // must not use the stored issuer as evidence.
      grants.assertGrantBinding(grant);
      if (expectedIssuer) grants.assertGrantContext(grant, expectedIssuer);
    } catch { return unknownSignOut(); }
    const handoff = ownedRefresh?.(targetStore, targetCredentials);
    // Waiting for our flight must not retarget logout to a concurrently
    // installed login, even when the subject is identical.
    if (ownedRefresh && (!handoff || !(isDeepStrictEqual(grant, handoff.pending)
      || isDeepStrictEqual(grant, handoff.complete)
      || isDeepStrictEqual(grant, handoff.unsentGrant)))) return unknownSignOut();
    // A locally authenticated session must not clear a grant that another
    // process replaced; the check needs no client secret.
    if (ctx.sessionAuthentication && grant
      && (ctx.sessionAuthentication.credentials !== targetCredentials
        || !isDeepStrictEqual(ctx.sessionAuthentication.identity, grantIdentity(grant)))) {
      return unknownSignOut();
    }
    // Remember the local snapshot so a failed lookup cannot retarget a retry.
    // This identity comparison does not establish issuer trust for any effect.
    if (grant && !logoutTarget) {
      logoutTarget = { store: targetStore, identity: structuredClone(grantIdentity(grant)) };
    }
    ctx.lastGrant = null;
    let revocation = 'skipped';
    let revocationError = null;
    const revocationMode = config.revocationMode ?? 'access_token_query';
    const confidentialRevocation = revocationMode === 'rfc7009' && config.authMode === 'confidential';
    const refusesEndpoint = (target) => confidentialRevocation && target?.protocol === 'http:'
      && config.allowInsecureClientAuthHttp !== true;
    let endpoint = parseHttpUrl(config.revocationEndpoint);
    if (config.revocationEndpoint && !endpoint) return unknownSignOut();
    const localContext = { mode: revocationMode, endpoint: endpoint?.href ?? null, resource: config.gatewayResource || null };
    const preflightIntent = endpoint && confidentialRevocation ? { ...localContext, endpoint: null, endpointRefused: true } : undefined;
    let discoveryIntent;
    let revocationContext = localContext;
    if (grant && config.discoveryUrl && (!endpoint || !config.issuer)) {
      const url = parseHttpUrl(config.discoveryUrl);
      if (!url) return unknownSignOut();
      const source = { url: url.href, issuer: config.issuer || null, configuredEndpoint: localContext.endpoint };
      discoveryIntent = { ...localContext, discovery: { ...source, stage: 'intent' } };
      if (preflightIntent) preflightIntent.discovery = { ...source, configuredEndpoint: null, stage: 'intent' };
      // Optional discovery may fail without affecting an otherwise usable
      // grant. Fence it first when its issuer is already independently known.
      // A cold discovery-only Host must establish the issuer before any write.
      if (expectedIssuer && !grant.signOutOperation) {
        const fenced = await targetStore.fenceSignOut(grant, handoff,
          { expectedRecord: record, revocationContext: refusesEndpoint(endpoint) ? preflightIntent : discoveryIntent, guard: assertCurrent });
        checkDisposed();
        if (!fenced.ok || !fenced.pending) return unknownSignOut();
        record = fenced.pending;
        grant = record.payload;
      }
      try {
        assertCurrent();
        const meta = await grants.metadata({ optional: 'revocationEndpoint' });
        expectedIssuer = meta.issuer;
        endpoint = parseHttpUrl(meta.revocationEndpoint);
        if (meta.revocationEndpoint && !endpoint) return unknownSignOut();
        revocationContext = { ...localContext, endpoint: endpoint?.href ?? null, discovery: { ...source, stage: 'pinned' } };
      } catch {
        // Discovery failure cannot establish an issuer or endpoint absence.
        return unknownSignOut();
      }
    }
    try { grants.assertGrantContext(grant, expectedIssuer); } catch { return unknownSignOut(); }
    checkDisposed();
    const revocable = Boolean(grant && endpoint && (revocationMode === 'rfc7009' || (handoff?.complete ?? grant).accessToken));
    const requiresClientAuthentication = revocable && confidentialRevocation;
    const revocationIntents = [discoveryIntent, preflightIntent].filter(Boolean);
    const operation = grant?.signOutOperation;
    // Legacy markers predate protocol/endpoint pinning. Their only supported
    // retry uses a configured, same-origin D1 endpoint for the verified issuer.
    const allowLegacyRecovery = Boolean(operation && revocable && revocationMode === 'access_token_query'
      && endpoint.href === localContext.endpoint
      && endpoint.origin === parseHttpUrl(expectedIssuer)?.origin
      && (grant.resource || '') === (config.gatewayResource || ''));
    if (operation && !targetStore.canResumeSignOut(grant, revocationContext, allowLegacyRecovery)
      && !revocationIntents.some((intent) => targetStore.canResumeSignOut(grant, intent))) {
      return unknownSignOut();
    }

    if (revocable && refusesEndpoint(endpoint)) {
      // Fence further local use without pinning an endpoint that cannot receive a request.
      if (!operation) {
        const fenced = await targetStore.fenceSignOut(grant, handoff,
          { expectedRecord: record, revocationContext: preflightIntent ?? discoveryIntent, guard: assertCurrent });
        checkDisposed();
        if (!fenced.ok || !fenced.pending) return unknownSignOut();
      }
      return unknownSignOut({ state: 'failed', code: 'IAM_REVOKE_ENDPOINT_INVALID' });
    }

    let authentication;
    const guard = () => {
      if (authentication) {
        assertCurrent();
        assertClientAuthCurrent(authentication);
      }
      return assertCurrent();
    };
    try {
      assertCurrent();
      if (requiresClientAuthentication) {
        // Client authentication can also be unavailable. Pin before reading
        // it, and verify that exact record again after the lock-free lookup.
        const pinned = await targetStore.fenceSignOut(grant, handoff,
          { expectedRecord: record, revocationContext, revocationIntents, guard: assertCurrent });
        if (!pinned.ok || !pinned.pending) return unknownSignOut();
        record = pinned.pending;
        grant = record.payload;
        authentication = await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant, guard: assertCurrent });
      }
      guard();
    } catch { return unknownSignOut(); }
    const revokeCurrent = async (current) => {
      guard();
      grants.assertGrantContext(current, expectedIssuer);
      grant = current;
      if (revocable) {
        const outcome = await revokeSessionToken({
          revocationMode,
          revocationEndpoint: endpoint.href,
          accessToken: current.accessToken,
          refreshToken: current.refreshToken,
          clientId: config.clientId,
          clientAuthentication: authentication,
          fetchImpl,
          timeoutMs: Math.min(config.httpTimeoutMs, REFRESH_TIMEOUT_MS),
        });
        revocation = outcome.state;
        if (outcome.code) revocationError = outcome.code;
        // A failed or unconfirmed remote operation cannot authorize the local
        // completion; the pending grant stays fenced for explicit retry.
        if (outcome.state !== 'ok') throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', 'revocation was not confirmed');
      }
      guard();
    };
    const cleared = await targetStore.signOutSnapshot(grant, revokeCurrent, handoff,
      { expectedRecord: record, revocationContext, revocationIntents, allowLegacyRecovery, guard });
    checkDisposed();
    try { assertCurrent(); } catch { return unknownSignOut(); }
    if (!cleared.ok || !['cleared', 'absent'].includes(cleared.decision)) {
      return unknownSignOut(revocation === 'failed' || revocation === 'unknown'
        ? { state: revocation, code: revocationError } : undefined);
    }
    checkDisposed();
    // Sign-out keeps the gateway credential, but the summary must stop
    // claiming it matches the (now absent) session.
    await gateway.load({ force: true });
    checkDisposed();
    try { assertCurrent(); } catch { return unknownSignOut(); }
    checkDisposed();
    let logoutUrl = null;
    if (config.logoutMode === 'rp' && grant?.idToken) {
      try {
        const logoutMetadata = config.endSessionEndpoint ? null : await grants.metadata({ optional: 'endSessionEndpoint' });
        grants.assertGrantContext(grant, logoutMetadata?.issuer ?? expectedIssuer);
        const endSessionEndpoint = config.endSessionEndpoint || logoutMetadata?.endSessionEndpoint;
        if (endSessionEndpoint) {
          // Optional Discovery can outlive a new login in another Host.
          const current = await targetStore.read();
          if (current.ok && current.grant === null) {
            const url = new URL(endSessionEndpoint);
            url.searchParams.set('client_id', config.clientId);
            url.searchParams.set('id_token_hint', grant.idToken);
            if (config.postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', config.postLogoutRedirectUri);
            logoutUrl = url.href;
          }
        }
      } catch {
        logoutUrl = null;
      }
    }
    checkDisposed();
    try { assertCurrent(); } catch { return unknownSignOut(); }
    checkDisposed();
    logoutTarget = null;
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
    rememberPendingSignOut,
    bridgeCapability,
    get inFlight() { return signOutPromise; },
    get signingOut() { return signingOut; },
  };
}
