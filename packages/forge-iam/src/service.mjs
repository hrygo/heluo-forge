import { normalizeGatewayBaseURL } from './managed-models.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isConfigured, validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';
import { assertClientAuthConfigured, assertClientAuthCurrent } from './client-auth.mjs';
import { StoreError } from './store.mjs';
import { isAccessExpired, isRefreshUsable, summarizeGrant } from './record.mjs';
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
import {
  grantIdentity,
  nowIso,
  addSeconds,
  safeMessage,
} from './service-helpers.mjs';

const REFRESH_TIMEOUT_MS = 5000;
const AUTO_REFRESH_BACKOFF_MS = 30000;

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
  });

  // Gateway credential reads: created after selection because its change hook
  // schedules reconciliation; the reverse edge is the lazy port above.
  const gateway = createServiceGateway({ config, ctx, provider, grants, now, selection });

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

  // Sign-in/out lifetimes: one attempt at a time, and an epoch pair that makes
  // a response belonging to a replaced session unable to publish.
  let signInPromise = null;
  let sessionEpoch = 0;
  let authEpoch = 0;
  let syncPublications = 0;
  let observedPending = null;
  const stopWaiters = new Set();
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

    async refreshGatewayModels() {
      const runtime = options.getManagedModelRuntime?.();
      if (!runtime) throw new IamError('ENTERPRISE_MODELS_UNAVAILABLE', '企业模型暂不可用，请联系管理员。');
      return runtime.refresh();
    },

    async updateModelOptions(nextOptions) {
      const runtime = options.getManagedModelRuntime?.();
      if (!runtime) throw new IamError('ENTERPRISE_MODELS_UNAVAILABLE', '企业模型暂不可用，请联系管理员。');
      return runtime.updateModelOptions(nextOptions);
    },

    getModelOptions() {
      const runtime = options.getManagedModelRuntime?.();
      return runtime?.getModelOptions?.() ?? {};
    },

    /**
     * Durable model selection for the signed-in person. The record is bound to
     * one subject, so another person's saved choice is never adopted: it simply
     * reads as "nothing saved" and the runtime starts from the catalogue.
     */
    async readModelSelection() {
      const current = await selection.owner();
      if (!current) return { subject: null, saved: false, models: {}, defaultModelId: null };
      const target = provider.ensure() ? provider.modelSelectionStore : null;
      if (!target || provider.storeCredentials !== current.credentials) {
        return { subject: current.subject, saved: false, models: {}, defaultModelId: null };
      }
      const record = await target.read();
      if (!record.ok || !record.selection || record.selection.subject !== current.subject) {
        // Nothing stored for this subject (or the record belongs to someone
        // else / is unreadable): the caller decides the first-run default.
        return { subject: current.subject, saved: false, models: {}, defaultModelId: null };
      }
      return { subject: current.subject, saved: true, models: record.selection.models, defaultModelId: record.selection.defaultModelId };
    },

    /** Persist the enabled set. Never a token channel: only model ids and overrides. */
    async saveModelSelection({ models, defaultModelId } = {}) {
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      let current = await selection.owner();
      if (current?.expired && ctx.lastGrant && isRefreshUsable(ctx.lastGrant, now())) {
        try {
          await service.resolveToken();
          current = await selection.owner();
        } catch {
          // keep expired status if refresh fails
        }
      }
      if (!current || current.expired) throw new IamError('IAM_NOT_SIGNED_IN', '企业账号状态已变化，请重新登录。');
      const target = provider.ensure() ? provider.modelSelectionStore : null;
      if (!target || provider.storeCredentials !== current.credentials) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', '暂时无法写入模型设置。');
      }
      const saved = await target.save({ subject: current.subject, models, defaultModelId });
      return saved.selection;
    },

    async resolveGatewayConnection() {
      // Refresh and validate the current grant through the existing authoritative path.
      // V1 sends only the personal Key to UAG; the IAM token never leaves this method.
      await service.resolveToken();
      const epoch = authEpoch;
      const targetStore = provider.require();
      const targetGatewayStore = provider.gatewayStore;
      const targetCredentials = provider.storeCredentials;
      const subject = ctx.lastGrant?.subject;
      const generation = selection.generation;
      const check = () => {
        if (ctx.disposed || signout.signingOut || authEpoch !== epoch || selection.generation !== generation
          || ctx.state !== 'ready' || !subject || ctx.lastGrant?.subject !== subject || Date.parse(ctx.lastGrant.accessExpiresAt) <= now()) {
          throw new IamError('IAM_NOT_SIGNED_IN', '企业账号状态已变化，请重新登录。');
        }
        ctx.assertExclusive();
        if (provider.ensure() !== targetStore || provider.gatewayStore !== targetGatewayStore || provider.storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', '暂时无法读取个人访问凭证。');
        }
      };
      check();
      const record = await targetGatewayStore?.read();
      check();
      if (!record?.ok || record.credential?.ownerSubject !== subject) {
        throw new IamError('IAM_GATEWAY_CREDENTIAL_REQUIRED', '请保存当前账号的个人访问凭证。');
      }
      const resolved = await targetGatewayStore.resolve(record.credential);
      check();
      if (resolved?.invalid || !resolved?.value) {
        throw new IamError('IAM_GATEWAY_CREDENTIAL_REQUIRED', '请保存当前账号的个人访问凭证。');
      }
      const address = record.credential.baseURL ?? config.managedModels?.baseURL;
      if (!address) throw new IamError('IAM_GATEWAY_URL_INVALID', '请先设置网关地址。');
      const baseURL = normalizeGatewayBaseURL(address, config.allowInsecureHttp);
      return { key: resolved.value, baseURL, generation: record.credential.writeOperationId ?? null };
    },

    /**
     * Store the UAG personal credential the user pasted. IAM only records it;
     * it never issues or refreshes the key. Model discovery/calls use the
     * independently guarded runtime, after this storage transaction.
     */
    async saveGatewayCredential({ key: value, deviceLabel, baseURL: address } = {}) {
      const baseURL = address === undefined ? undefined : normalizeGatewayBaseURL(address, config.allowInsecureHttp);
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      selection.generation += 1;
      if (!configured) {
        throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
          missing: isConfigured(config).missing,
        });
      }
      const expectedIssuer = ctx.knownIssuer();
      const epoch = authEpoch;
      const targetStore = provider.require();
      const targetGatewayStore = provider.gatewayStore;
      const targetCredentials = provider.storeCredentials;
      if (!targetGatewayStore) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      const assertCurrent = () => {
        const active = () => {
          if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
          if (signout.signingOut || authEpoch !== epoch || ctx.state === 'authenticating') {
            throw new IamError('IAM_REAUTH_REQUIRED', safeMessage('IAM_REAUTH_REQUIRED'));
          }
          ctx.assertExclusive();
        };
        active();
        if (provider.ensure() !== targetStore || provider.gatewayStore !== targetGatewayStore || provider.storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
        }
        active();
      };
      assertCurrent();
      // A cached subject may belong to an earlier provider or shared session.
      const record = await targetStore.read().catch(() => null);
      assertCurrent();
      if (!record?.ok) throw new IamError('IAM_GRANT_INVALID', safeMessage('IAM_GRANT_INVALID'));
      grants.assertGrantContext(record.grant, expectedIssuer);
      const authentication = await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: record.grant, guard: assertCurrent });
      assertCurrent();
      const subject = record.grant?.subject;
      if (!subject) {
        throw new IamError('IAM_NOT_SIGNED_IN', 'sign in before saving a gateway credential');
      }
      // Labels are display-only: drop control characters and bound the length so
      // a pasted newline cannot break the account page layout.
      const label = typeof deviceLabel === 'string'
        ? deviceLabel.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64)
        : '';
      const enteredAt = nowIso(now());
      const suggestedExpiry = addSeconds(now(), 90 * 24 * 60 * 60).slice(0, 10);
      assertCurrent();
      try {
        await targetGatewayStore.save({
          value,
          baseURL,
          ownerSubject: subject,
          deviceLabel: label,
          enteredAt,
          suggestedExpiry,
        }, { guard: () => { assertCurrent(); assertClientAuthCurrent(authentication); return true; } });
      } catch (cause) {
        if (cause instanceof StoreError) throw new IamError(cause.code, safeMessage(cause.code));
        throw cause;
      }
      // A post-commit lifecycle change does not roll back a confirmed transaction.
      assertCurrent();
      assertClientAuthCurrent(authentication);
      await gateway.load({ force: true });
      assertCurrent();
      assertClientAuthCurrent(authentication);
      ctx.notify();
      return ctx.view();
    },

    async clearGatewayCredential() {
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      selection.generation += 1;
      const targetStore = provider.require();
      const targetGatewayStore = provider.gatewayStore;
      const targetCredentials = provider.storeCredentials;
      if (!targetGatewayStore) {
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
      }
      const assertCurrent = () => {
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
        ctx.assertExclusive();
        if (provider.ensure() !== targetStore || provider.gatewayStore !== targetGatewayStore || provider.storeCredentials !== targetCredentials) {
          throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
        }
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      };
      assertCurrent();
      let cleared;
      try {
        cleared = await targetGatewayStore.clear({ guard: () => { assertCurrent(); return true; } });
      } catch (cause) {
        if (cause instanceof StoreError) throw new IamError(cause.code, safeMessage(cause.code));
        throw cause;
      }
      assertCurrent();
      if (!cleared.ok) {
        throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
      }
      await gateway.load({ force: true });
      assertCurrent();
      ctx.notify();
      return ctx.view();
    },

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