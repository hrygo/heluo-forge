import { isDeepStrictEqual } from 'node:util';
import { isConfigured, validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';
import { assertClientAuthConfigured } from './client-auth.mjs';
import { isAccessExpired, summarizeGrant } from './record.mjs';
import { createServiceState } from './service-state.mjs';
import { createServiceGrant } from './service-grant.mjs';
import { createModelSelection } from './service-model-selection.mjs';
import { createServiceGateway } from './service-gateway.mjs';
import { createTokenResolver } from './service-token.mjs';
import { createReconciler } from './service-reconcile.mjs';
import { createSignIn } from './service-signin.mjs';
import { createSignOut } from './service-signout.mjs';
import { createServiceStore } from './service-store.mjs';
import { transition } from './state.mjs';
import { createConsumptionWitness } from './consumption-witness.mjs';
import { normalizeProfileFields } from './userinfo.mjs';
import { grantIdentity, safeMessage } from './service-helpers.mjs';

/**
 * Host-side IAM session. Login is OIDC authorization-code + PKCE against
 * configured endpoints; every unverified capability stays fail closed.
 *
 * @param {Record<string, unknown>} config normalized config
 * @param {{
 *   exclusive?: { ok: boolean, reason?: string },
 *   credentials?: object,
 *   getModelSelectionServices?: () => {llm: object, agentDefaultModel: object} | undefined,
 *   getOrigin?: () => string | undefined,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 * }} [options]
 */
export function createIamService(rawConfig, options = {}) {
  const checked = validateConfig(rawConfig);
  if ('issues' in checked) {
    throw new IamError('IAM_CONFIG_INVALID', safeMessage('IAM_CONFIG_INVALID'), { issues: checked.issues });
  }
  const config = checked.value;
  // Real apply supplies neither private function; configuration cannot unlock it.
  assertClientAuthConfigured(config, options);
  const configured = isConfigured(config).ok;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // Empty by default: IAM has not confirmed field names, so no name is shown.
  const profileFields = normalizeProfileFields(options.profileFields ?? Object.freeze({}));

  // Sign-in/out lifetimes: one attempt at a time, and an epoch pair that makes
  // a response belonging to a replaced session unable to publish.
  let signInPromise = null;
  let sessionEpoch = 0;
  let authEpoch = 0;
  let syncPublications = 0;
  let observedPending = null;
  const stopWaiters = new Set();

  // Credentials provider handles and their caches live in one module.
  const provider = createServiceStore({ options });

  // Every published-state read/write goes through ctx: the state module owns
  // the five scalars, the transition path and the listener set.
  const ctx = createServiceState({
    config,
    options,
    configured,
    now,
    getGatewaySummary: () => provider.gatewaySummary,
    getMetadataIssuer: () => grants.cachedIssuer(),
    scheduleReconcile: () => selection.schedule(),
    clearPendingObservation: () => { observedPending = null; },
    onFailReset: () => {
      observedPending = null;
      clearAttempt();
      grants.clearProfile();
    },
  });

  // Grants and the protocol caches: created after ctx because it depends on it,
  // and referenced lazily from ctx (issuer lookup) so the cycle stays a port.
  const grants = createServiceGrant({
    config,
    options,
    now,
    fetchImpl,
    profileFields,
    state: ctx,
    provider,
    getAuthEpoch: () => authEpoch,
  });


  // Default-model selection: created before the gateway module because the
  // gateway's change hook calls into it; the gateway read is a lazy port.
  const selection = createModelSelection({
    config,
    options,
    ctx,
    provider,
    grants,
    now,
    getAuthEpoch: () => authEpoch,
    isSigningOut: () => signout.signingOut,
    getLoadGateway: () => (opts) => gateway.load(opts),
    resolveToken: () => token.resolveToken(),
  });

  // Gateway credential reads: created after selection because its change hook
  // schedules reconciliation; the reverse edge is the lazy port above.
  const gateway = createServiceGateway({
    config,
    ctx,
    provider,
    grants,
    now,
    selection,
    configured,
    getAuthEpoch: () => authEpoch,
    isSigningOut: () => signout.signingOut,
    resolveToken: () => token.resolveToken(),
    bumpGeneration: () => { selection.generation += 1; },
    getManagedModelRuntime: () => options.getManagedModelRuntime?.(),
  });

  // Token refresh: the flight records its own provider, so it is created after
  // the provider and grant modules it validates against.
  const token = createTokenResolver({
    config,
    ctx,
    provider,
    grants,
    now,
    fetchImpl,
    isSigningOut: () => signout.signingOut,
    getSessionEpoch: () => sessionEpoch,
    getAuthEpoch: () => authEpoch,
    clearObservation: () => { observedPending = null; },
    beginConsumption,
    adoptConsumption,
  });

  // Sign-out: owns the flight and the "signing out" flag other axes read.
  const signout = createSignOut({
    config,
    ctx,
    provider,
    grants,
    gateway,
    token,
    now,
    fetchImpl,
    bumpAuthEpoch: () => { authEpoch += 1; },
    clearObservation: () => { observedPending = null; },
    clearAttempt,
    invalidateConsumption: () => consumptionWitness?.invalidate(),
  });

  // The reconciler owns every background adoption. It is created after the
  // modules it reads and publishes through.
  const reconcile = createReconciler({
    ctx,
    provider,
    grants,
    gateway,
    token,
    now,
    configured,
    hasSignInAttempt: () => Boolean(signInPromise),
    isSigningOut: () => signout.signingOut,
    getAuthEpoch: () => authEpoch,
    getObservation: () => observedPending,
    setObservation: (next) => { observedPending = next; },
    getPublications: () => syncPublications,
    bumpPublications: () => ++syncPublications,
    beginConsumption,
    adoptConsumption,
    resolveToken: () => service.resolveToken(),
  });

  // Sign-in/out attempt state: the attempt object is the only owner of its
  // verifier and nonce, so it lives in the module that consumes the callback.
  const signin = createSignIn({
    config,
    configured,
    ctx,
    provider,
    grants,
    gateway,
    token,
    now,
    fetchImpl,
    isSigningOut: () => signout.signingOut,
    getAuthEpoch: () => authEpoch,
    bumpAuthEpoch: () => { authEpoch += 1; },
    clearObservation: () => { observedPending = null; },
    getSignInPromise: () => signInPromise,
    setSignInPromise: (next) => { signInPromise = next; },
    invalidateConsumption: () => consumptionWitness?.invalidate(),
    beginConsumption,
    adoptConsumption,
  });

  // Absent in real apply: do not inspect private binding readers without opt-in.
  const consumptionWitness = typeof options.registerWitness === 'function'
    ? createConsumptionWitness(config, options, (adopted) => {
      ctx.recheckExclusive();
      return !ctx.disposed && !signout.signingOut && ctx.state === 'ready' && ctx.exclusive.ok
        && authEpoch === adopted.binding.authEpoch && sessionEpoch === adopted.binding.sessionEpoch
        && provider.store === adopted.binding.store && provider.storeCredentials === adopted.binding.credentials
        && ctx.lastGrant?.sessionInstanceId === adopted.sessionInstanceId
        && ctx.lastGrant.issuer === adopted.issuer && ctx.lastGrant.subject === adopted.subject
        && ctx.lastGrant.accessExpiresAt === adopted.accessExpiresAt && ctx.lastGrant.version === adopted.version
        && ctx.lastGrant.clientId === adopted.clientId && ctx.lastGrant.resource === adopted.resource
        && isDeepStrictEqual(ctx.lastGrant.authContext, adopted.authContext) && !isAccessExpired(ctx.lastGrant, now());
    }) : undefined;

  function beginConsumption(issuer, target, credentials, expected) {
    return consumptionWitness?.begin(issuer, credentials, target, authEpoch, sessionEpoch, expected);
  }

  function adoptConsumption(ticket, grant) {
    if (!consumptionWitness) return;
    const { issuer, subject, sessionInstanceId, accessExpiresAt, version, clientId, resource } = grant;
    const authContext = grant.authContext ? Object.freeze({ mode: grant.authContext.mode,
      method: grant.authContext.method, secretRef: grant.authContext.secretRef,
      secretRevision: grant.authContext.secretRevision }) : undefined;
    consumptionWitness.adopt(ticket, { issuer, subject, sessionInstanceId, accessExpiresAt,
      version, clientId, resource, authContext });
  }

  // The attempt timer is owned by the sign-in module; cancelling an attempt is
  // its job, so this only forwards.
  function clearAttempt() { signin.clearAttempt(); }

  /**
   * Verify an ID token, retrying once on a missing `kid`: the IdP may have
   * rotated keys after this process cached the JWKS document.
   */

  // The private composition getter keeps one binding object per scoped lifetime.

  const service = {
    getView() {
      return ctx.view();
    },
    getModelAccessEpoch() { return `${authEpoch}:${sessionEpoch}:${selection.generation}`; },

    /**
     * Identity and freshness only. Never a token, verifier or ID token: this is
     * the cross-module read surface, and it must not become a token channel by
     * accident. Use `resolveToken()` (or `getAccessToken()`) for the token.
     */
    getSession() {
      ctx.recheckExclusive();
      const summary = ctx.lastGrant ? summarizeGrant(ctx.lastGrant) : {};
      return {
        status: ctx.state,
        signedIn: summary.signedIn === true,
        principal: summary.principal
          ? { issuer: summary.issuer ?? null, subject: summary.principal }
          : undefined,
        accessExpiresAt: summary.accessExpiresAt ?? null,
        scope: summary.scope ?? null,
      };
    },

    hydrate: reconcile.hydrate,
    syncFromStore: reconcile.syncFromStore,
    loadGatewayCredential: gateway.load,
    /**
     * Host-only: push the current view after a change that never touched the
     * IAM state machine (the managed model catalogue is the only such source).
     * Without this, subscribers keep the last frame until an unrelated event.
     */
    /** Token resolution lives in service-token.mjs; these are the public edges. */
    resolveToken: token.resolveToken,
    getAccessToken: token.getAccessToken,
    notifyView() { return ctx.notify(); },
    // Host-only observation; intentionally absent from routes and IamView.
    reconcileDefaultModel: selection.reconcile,

    /** Host-only request credential; never exposed by management routes or IamView. */
    async resolveGatewayCredential() { return (await service.resolveGatewayConnection()).key; },

refreshGatewayModels: gateway.refreshModels,

    async updateModelOptions(nextOptions) {
      const runtime = options.getManagedModelRuntime?.();
      if (!runtime) throw new IamError('ENTERPRISE_MODELS_UNAVAILABLE', '企业模型暂不可用，请联系管理员。');
      return runtime.updateModelOptions(nextOptions);
    },

    getModelOptions() {
      const runtime = options.getManagedModelRuntime?.();
      return runtime?.getModelOptions?.() ?? {};
    },

    readModelSelection: selection.readSelection,

    /** Persist the enabled set. Never a token channel: only model ids and overrides. */
    saveModelSelection: selection.saveSelection,

resolveGatewayConnection: gateway.resolveConnection,

saveGatewayCredential: gateway.saveCredential,

clearGatewayCredential: gateway.clearCredential,

    /** Minimal principal for Host policy/audit; never tokens. */
    getPrincipal() {
      if (!ctx.lastGrant) return undefined;
      return { issuer: ctx.lastGrant.issuer, subject: ctx.lastGrant.subject };
    },

    /** Projected UserInfo for future display; empty until IAM confirms fields. */
    getIdentityProfile() {
      // A profile is only valid for the grant that produced it: every path that
      // clears or replaces lastGrant hides it, without touching each call site.
      if (!ctx.lastGrant || !grants.identityProfile) return undefined;
      if (!isDeepStrictEqual(grants.identityProfile.identity, grantIdentity(ctx.lastGrant))) return undefined;
      return { ...grants.identityProfile.profile };
    },

    /** Sign-out owns its flight and cleanup order. */
    signOut: signout.signOut,
    _signOutOnce: signout.signOutOnce,
    bridgeCapability: signout.bridgeCapability,

    /** Sign-in attempt and its callback live in service-signin.mjs. */
    startSignIn: signin.startSignIn,
    _startSignInOnce: signin.signInOnce,
    handleCallback: signin.handleCallback,
    cancelSignIn: signin.cancelSignIn,



    /**
     * Read (or lazily mint) the loopback bridge capability. The value lives in
     * the credential store, so a caller must already be able to read that store
     * to obtain it; this is not a second authorization model.
     */


    async *watch(signal) {
      const queue = [];
      let waiter = null;
      const stop = () => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(null);
        }
      };
      const listener = (value) => {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(value);
        } else {
          queue.push(value);
        }
      };
      const onAbort = () => stop();
      ctx.addListener(listener);
      stopWaiters.add(stop);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        yield ctx.view();
        for (;;) {
          if (signal?.aborted) return;
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          const value = await new Promise((resolve) => {
            waiter = resolve;
            if (signal?.aborted) {
              waiter = null;
              resolve(null);
            }
          });
          if (value === null || signal?.aborted) return;
          yield value;
        }
      } finally {
        stop();
        ctx.removeListener(listener);
        stopWaiters.delete(stop);
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async dispose() {
      consumptionWitness?.dispose();
      if (ctx.disposed) return;
      ctx.disposed = true;
      selection.clearQueue();
      sessionEpoch += 1;
      authEpoch += 1;
      observedPending = null;
      clearAttempt();
      // Stop subscribers before any await so unload cannot leave a watch()
      // caller parked forever. dispose() is lifecycle cleanup, not logout:
      // persisted credentials are cleared only by an explicit signOut() or by
      // the enterprise uninstall flow.
      ctx.clearListeners();
      for (const stop of [...stopWaiters]) stop();
      stopWaiters.clear();
      ctx.lastGrant = null;
      ctx.sessionAuthentication = null;
      grants.clearProfile();
      provider.gatewaySummary = null;
      ctx.state = 'signed-out';
      ctx.error = null;
      // Lifecycle cleanup only: the grant and the user's gateway credential
      // stay stored, so unload cannot silently discard them.
    },
  };

  consumptionWitness?.register(service);
  return service;
}