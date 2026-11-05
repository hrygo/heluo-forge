import { normalizeGatewayBaseURL } from './managed-models.mjs';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isConfigured, validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';
import { assertClientAuthConfigured, assertClientAuthCurrent, clientAuthDescriptor } from './client-auth.mjs';
import { StoreError } from './store.mjs';
import { isAccessExpired, isRefreshUsable, shouldRefresh, summarizeGrant } from './record.mjs';
import { createServiceState } from './service-state.mjs';
import { createServiceGrant } from './service-grant.mjs';
import { createModelSelection } from './service-model-selection.mjs';
import { createServiceGateway } from './service-gateway.mjs';
import { createTokenResolver } from './service-token.mjs';
import { createReconciler } from './service-reconcile.mjs';
import { createServiceStore } from './service-store.mjs';
import { transition } from './state.mjs';
import { createConsumptionWitness } from './consumption-witness.mjs';
import { normalizeProfileFields } from './userinfo.mjs';
import {
  buildAuthorizationUrl,
  createPkce,
  exchangeCode,
  parseCallbackUrl,
  randomToken,
  revokeAccessToken,
  revokeToken,
  safeStateEqual,
} from './oidc.mjs';

import {
  grantIdentity,
  nowIso,
  addSeconds,
  tokenErrorMessage,
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
    isSigningOut: () => signingOut,
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
    isSigningOut: () => signingOut,
    getSessionEpoch: () => sessionEpoch,
    getAuthEpoch: () => authEpoch,
    clearObservation: () => { observedPending = null; },
    beginConsumption,
    adoptConsumption,
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
    isSigningOut: () => signingOut,
    getAuthEpoch: () => authEpoch,
    getObservation: () => observedPending,
    setObservation: (next) => { observedPending = next; },
    getPublications: () => syncPublications,
    bumpPublications: () => ++syncPublications,
    beginConsumption,
    adoptConsumption,
    resolveToken: () => service.resolveToken(),
  });

  // Sign-in/out lifetimes: one attempt at a time, and an epoch pair that makes
  // a response belonging to a replaced session unable to publish.
  let attempt = null;
  let signInPromise = null;
  let signOutPromise = null;
  let signingOut = false;
  let sessionEpoch = 0;
  let authEpoch = 0;
  let syncPublications = 0;
  let observedPending = null;
  const stopWaiters = new Set();
  // Absent in real apply: do not inspect private binding readers without opt-in.
  const consumptionWitness = typeof options.registerWitness === 'function'
    ? createConsumptionWitness(config, options, (adopted) => {
      ctx.recheckExclusive();
      return !ctx.disposed && !signingOut && ctx.state === 'ready' && ctx.exclusive.ok
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

  function clearAttempt() {
    if (attempt?.timer) clearTimeout(attempt.timer);
    attempt = null;
  }




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
        if (ctx.disposed || signingOut || authEpoch !== epoch || selection.generation !== generation
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
          if (signingOut || authEpoch !== epoch || ctx.state === 'authenticating') {
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

    async startSignIn() {
      ctx.assertExclusive();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (!configured) {
        throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
          missing: isConfigured(config).missing,
        });
      }
      if (signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      const targetStore = provider.ensure();
      const credentials = provider.storeCredentials;
      if (attempt && (attempt.targetStore !== targetStore || attempt.credentials !== credentials)) {
        authEpoch += 1;
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
          const current = attempt; const epoch = authEpoch;
          const authentication = await grants.prepareAuthentication(current.metadata.issuer, targetStore, credentials, { expected: current.authentication, guard: () => {
            if (attempt !== current || epoch !== authEpoch || signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
            provider.assertAtomic(targetStore, credentials);
          } });
          assertClientAuthCurrent(authentication);
        }
        return { view: ctx.view(), authorizationUrl: attempt.authorizationUrl };
      }
      if (signInPromise) return signInPromise;
      authEpoch += 1;
      observedPending = null;
      consumptionWitness?.invalidate();
      const consumption = beginConsumption(ctx.knownIssuer(), targetStore, credentials);
      const pending = service._startSignInOnce(targetStore, credentials, consumption);
      // Only the attempt that still owns the slot clears it: a cancel or a newer
      // sign-in must not be overwritten by a superseded attempt settling late.
      const settle = () => { if (signInPromise === pending) signInPromise = null; };
      pending.then(settle, settle);
      signInPromise = pending;
      return signInPromise;
    },

    async _startSignInOnce(targetStore, credentials, consumption) {
      const startEpoch = authEpoch;
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
      if (authEpoch !== startEpoch || signingOut) {
        throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
      }
      provider.assertAtomic(targetStore, credentials);
      const authentication = await grants.prepareAuthentication(meta.issuer, targetStore, credentials, { expected: null, guard: () => {
        if (authEpoch !== startEpoch || signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
        provider.assertAtomic(targetStore, credentials);
      } });
      assertClientAuthCurrent(authentication);
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (authEpoch !== startEpoch || signingOut) throw new IamError('IAM_ATTEMPT_CANCELLED', 'IAM sign-in was cancelled');
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
    },

    async handleCallback(rawUrl) {
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
      const attemptEpoch = authEpoch;
      const consumption = beginConsumption(current.metadata.issuer, current.targetStore, current.credentials, current.consumption ?? null);
      const isCurrent = () => {
        if (attempt === current && authEpoch === attemptEpoch && ctx.state === 'authenticating'
          && now() > current.expiresAt) {
          current.expired = true;
          clearAttempt();
          ctx.error = 'IAM_ATTEMPT_EXPIRED';
          ctx.state = 'error';
          ctx.notify();
        }
        return attempt === current && authEpoch === attemptEpoch && ctx.state === 'authenticating';
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
          if (!ctx.disposed && !signingOut && (stillCurrent || (!attempt && (ctx.state === 'signed-out' || ctx.state === 'error')))) {
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
    },

    async cancelSignIn() {
      consumptionWitness?.invalidate();
      if (ctx.disposed) return ctx.view();
      authEpoch += 1;
      observedPending = null;
      // A cancelled attempt no longer owns the state machine, even when it never
      // reached `authenticating` (discovery or client-auth was still pending):
      // leaving its promise registered would keep blocking background hydration.
      signInPromise = null;
      if (ctx.state !== 'authenticating') return ctx.view();
      clearAttempt();
      ctx.lastGrant = null;
      provider.gatewayEpoch += 1;
      provider.gatewaySummary = null;
      provider.gatewayLoadedAt = 0;
      return ctx.publish('CANCEL');
    },

    async signOut() {
      consumptionWitness?.invalidate();
      if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
      if (signOutPromise) return signOutPromise;
      signingOut = true;
      authEpoch += 1;
      observedPending = null;
      clearAttempt();
      // Register before running any work: provider checks and notifications can
      // synchronously reenter signOut. All callers observe the final outcome.
      signOutPromise = Promise.resolve().then(() => service._signOutOnce()).finally(() => {
        signingOut = false;
        signOutPromise = null;
      });
      return signOutPromise;
    },

    async _signOutOnce() {
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
    },

    /**
     * Read (or lazily mint) the loopback bridge capability. The value lives in
     * the credential store, so a caller must already be able to read that store
     * to obtain it; this is not a second authorization model.
     */
    async bridgeCapability() {
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
    },


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