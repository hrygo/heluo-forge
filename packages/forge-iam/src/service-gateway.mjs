import { isDeepStrictEqual } from 'node:util';
import { assertClientAuthCurrent } from './client-auth.mjs';
import { isConfigured } from './config.mjs';
import { IamError } from './errors.mjs';
import { evaluateGatewayBinding, resolveTargetBaseURL } from './gateway-binding.mjs';
import { normalizeGatewayBaseURL } from './model-options.mjs';
import { isAccessExpired, isRefreshUsable } from './record.mjs';
import { StoreError } from './store.mjs';
import { addSeconds, grantIdentity, nowIso, safeMessage } from './service-helpers.mjs';

const GATEWAY_RELOAD_MS = 5000;
const GATEWAY_CONFIRM_TIMEOUT_MS = 10000;

/**
 * The gateway credential as the panel sees it: one cached summary, one read at
 * a time, and an epoch that makes a revoked provider's in-flight read unable to
 * repopulate the cache.
 *
 * Every state here is display state. Reading it never authorizes anything; the
 * authorization decision stays with the grant owner map.
 */
export function createServiceGateway(env) {
  const {
    config, ctx, provider, grants, now, selection,
    configured, getAuthEpoch, isSigningOut, resolveToken, bumpGeneration, getManagedModelRuntime, logGatewayStage, syncSession, pendingObservationFor, captureModelSession,
  } = env;
  let cancelConfirmation = null;
  let summaryRead = null;
  let sessionSummaryRead = null;

  /**
   * Normalized enterprise address. `undefined` means this deployment has no
   * preset; a preset that cannot be normalized is a configuration error, not a
   * reason to fall back to an editable or inherited address (fail closed).
   */
  function authoritativeBaseURL() {
    const configuredAddress = config.managedModels?.baseURL;
    if (typeof configuredAddress !== 'string' || configuredAddress.length === 0) return undefined;
    try {
      return normalizeGatewayBaseURL(configuredAddress);
    } catch {
      throw new IamError('IAM_CONFIG_INVALID', '企业预置的网关地址无效，请联系管理员检查配置。');
    }
  }

  async function read(targetGatewayStore, targetStore, isCurrent) {
    if (!isCurrent()) return null;
    const record = await targetGatewayStore.read().catch(() => ({ ok: false, reason: 'unreadable' }));
    if (!isCurrent()) return null;
    // The UI needs the address ownership before any record exists: with an
    // enterprise preset the first configuration must already be read-only.
    const preset = authoritativeBaseURL();
    const ownership = { baseURL: preset ?? null, addressAuthoritative: preset !== undefined };
    if (!record.ok) return { state: 'invalid', ...ownership };
    if (!record.credential) {
      const storage = await targetGatewayStore.describe().catch(() => null);
      if (!isCurrent()) return null;
      return storage?.configured ? { state: 'invalid', matchesAccount: false, ...ownership } : { state: 'unconfigured', ...ownership };
    }
    const resolved = await targetGatewayStore.resolve(record.credential).catch(() => undefined);
    if (!isCurrent()) return null;
    const credential = record.credential;
    if (resolved?.invalid) return { state: 'invalid', ...ownership };
    if (!resolved?.value) return { state: 'unconfigured', ...ownership };
    const storage = await targetGatewayStore.describe().catch(() => null);
    if (!isCurrent()) return null;
    const signedInSubject = ctx.lastGrant && grants.ownerOf(ctx.lastGrant) === targetStore ? ctx.lastGrant.subject : null;
    const matchesAccount = Boolean(credential.ownerSubject && signedInSubject && credential.ownerSubject === signedInSubject);
    // Which target does this Key belong to, and can the Host still prove it?
    const authoritative = preset;
    const binding = evaluateGatewayBinding({
      credential: record.credential,
      expectedIssuer: ctx.knownIssuer(),
      authoritativeBaseURL: authoritative,
    });
    const targetBaseURL = resolveTargetBaseURL({ credentialBaseURL: credential.baseURL, authoritativeBaseURL: authoritative });
    return {
      // Without a session the stored key is still "configured"; it only becomes
      // a mismatch once a different subject is known.
      state: !signedInSubject || matchesAccount
        ? (binding.bound ? 'configured' : 'rebind-required')
        : 'owner-mismatch',
      // Why the Key must be entered again; the client maps it to one prompt and
      // the Host never sends the Key while this is present.
      ...(binding.bound ? {} : { rebindReason: binding.reason }),
      // The address that calls will actually use, and whether a person could
      // change it here at all. The UI must not offer an address editor when the
      // enterprise configuration owns the target.
      baseURL: targetBaseURL ?? null,
      addressAuthoritative: authoritative !== undefined && authoritative === targetBaseURL,
      issuer: credential.issuer ?? null,
      ownerSubject: credential.ownerSubject ?? null,
      generation: credential.writeOperationId ?? null,
      deviceLabel: credential.deviceLabel ?? null,
      enteredAt: credential.enteredAt ?? null,
      suggestedExpiry: credential.suggestedExpiry ?? null,
      // The account page distinguishes OS keychain from other sources; a
      // file-backed source does not imply that its contents are plaintext.
      storage: storage?.configured ? (storage.source ?? null) : null,
      matchesAccount,
    };
  }

  async function load({ force = false, sessionRefresh = false } = {}) {
    if (ctx.disposed) return null;
    // Cache hits and singleflight reuse must belong to the live provider too.
    const targetStore = provider.ensure();
    if (ctx.disposed || !targetStore || !provider.gatewayStore) return null;
    // Panel polling shares the session's storage backoff. Its recovery read
    // reloads this summary against the newly adopted grant.
    if (!force && ctx.state === 'unreachable' && ctx.error === 'IAM_CREDENTIALS_UNAVAILABLE') return provider.gatewaySummary;
    if (!force && sessionSummaryRead && provider.gatewayLoading === sessionSummaryRead) return provider.gatewaySummary;
    if (!force && provider.gatewayLoadedAt > 0 && now() - provider.gatewayLoadedAt < GATEWAY_RELOAD_MS) return provider.gatewaySummary;
    if (provider.gatewayLoading) return provider.gatewayLoading;
    const targetGatewayStore = provider.gatewayStore;
    const targetCredentials = provider.storeCredentials;
    const epoch = provider.gatewayEpoch;
    const isCurrent = () => {
      if (ctx.disposed || epoch !== provider.gatewayEpoch || provider.gatewayLoading !== request) return false;
      const current = provider.ensure();
      return !ctx.disposed && epoch === provider.gatewayEpoch && provider.gatewayLoading === request && current === targetStore
        && provider.gatewayStore === targetGatewayStore && provider.storeCredentials === targetCredentials;
    };
    const request = Promise.resolve().then(() => read(targetGatewayStore, targetStore, isCurrent))
      .then((summary) => {
        if (!isCurrent()) return null;
        const changed = !isDeepStrictEqual(provider.gatewaySummary, summary);
        provider.gatewaySummary = summary;
        provider.gatewayLoadedAt = now();
        // Own forced reads do not feed back into another observation.
        if (changed && sessionRefresh) ctx.notify();
        else if (changed && !selection.inFlight) selection.schedule();
        return summary;
      })
      .catch(() => {
        if (isCurrent()) { provider.gatewaySummary = null; provider.gatewayLoadedAt = 0; }
        return null;
      })
      .finally(() => {
        if (provider.gatewayLoading === request) provider.gatewayLoading = null;
        if (summaryRead === request) summaryRead = null;
        if (sessionSummaryRead === request) sessionSummaryRead = null;
      });
    provider.gatewayLoading = request;
    summaryRead = request;
    if (sessionRefresh) sessionSummaryRead = request;
    return request;
  }

  function refreshSessionSummary() {
    // The restored session can renew while this independent display read runs.
    // Retire older summary reads and let any credential mutation confirm itself.
    provider.gatewaySummary = null;
    provider.gatewayLoadedAt = 0;
    if (provider.gatewayLoading === summaryRead) provider.gatewayLoading = null;
    return Promise.resolve().then(() => load({ force: true, sessionRefresh: true })).catch(() => null);
  }

  function invalidateGatewayReads({ clearSummary = false } = {}) {
    // A read begun before a commit must neither satisfy its confirmation nor
    // publish over a later read, even when the provider itself has not changed.
    const cancel = cancelConfirmation;
    cancelConfirmation = null;
    cancel?.();
    provider.gatewayEpoch += 1;
    // Keep the last verified display snapshot while confirmation is pending.
    // Existing model streams must not observe a synthetic credential removal.
    if (clearSummary) provider.gatewaySummary = null;
    provider.gatewayLoadedAt = 0;
    provider.gatewayLoading = null;
    return provider.gatewayEpoch;
  }

  function publishUnknown(targetStore, targetGatewayStore, targetCredentials, epoch) {
    if (provider.gatewayEpoch !== epoch || !boundTo(targetStore, targetGatewayStore, targetCredentials)
      || provider.gatewayEpoch !== epoch) return;
    invalidateGatewayReads({ clearSummary: true });
    if (!ctx.disposed) ctx.notify();
  }

  function boundTo(targetStore, targetGatewayStore, targetCredentials) {
    return provider.ensure() === targetStore && provider.gatewayStore === targetGatewayStore
      && provider.storeCredentials === targetCredentials;
  }

  function fenceUnknown(targetStore, targetGatewayStore, targetCredentials, mutationEpoch) {
    // A later local mutation or provider change already fenced the old flight.
    // Do not erase a newer operation's confirmed cache or interrupt its flight.
    if (boundTo(targetStore, targetGatewayStore, targetCredentials) && provider.gatewayEpoch === mutationEpoch) {
      publishUnknown(targetStore, targetGatewayStore, targetCredentials, mutationEpoch);
    }
  }

  function writeUnknown() {
    return new IamError('IAM_GATEWAY_WRITE_UNKNOWN', safeMessage('IAM_GATEWAY_WRITE_UNKNOWN'));
  }

  function sessionIdentity(grant) {
    return grant && ({
      version: grant.version, issuer: grant.issuer, clientId: grant.clientId,
      resource: grant.resource, subject: grant.subject, sessionInstanceId: grant.sessionInstanceId,
      authContext: grant.authContext,
    });
  }

  function postCommitCurrent(assertCurrent, authentication) {
    try {
      assertCurrent();
      assertClientAuthCurrent(authentication);
    } catch (error) {
      // The transaction is already confirmed; lifecycle errors no longer mean
      // that the attempted mutation did not happen.
      if (error instanceof IamError) throw writeUnknown();
      throw error;
    }
  }

  async function confirmMutation({ assertCurrent, authentication, targetStore, targetGatewayStore, targetCredentials, mutationEpoch, expectedIdentity, accepts }) {
    const bound = boundTo(targetStore, targetGatewayStore, targetCredentials);
    // Never invalidate the replacement provider, but do fence this provider's
    // old reads even when the authentication changed just after the commit.
    // A receipt from an older operation may arrive after a newer one has
    // published. Verify it independently before touching that newer cache.
    const ownsFlight = bound && provider.gatewayEpoch === mutationEpoch;
    let epoch = ownsFlight ? invalidateGatewayReads() : provider.gatewayEpoch;
    try { postCommitCurrent(assertCurrent, authentication); }
    catch (error) {
      if (ownsFlight) publishUnknown(targetStore, targetGatewayStore, targetCredentials, epoch);
      throw error;
    }
    if (!bound) throw writeUnknown();
    let timer;
    let expired = false;
    let published = false;
    const timedOut = Symbol('gateway confirmation timed out');
    const invalidated = Symbol('gateway confirmation invalidated');
    const isCurrent = () => {
      if (expired || ctx.disposed || provider.gatewayEpoch !== epoch) return false;
      return boundTo(targetStore, targetGatewayStore, targetCredentials) && provider.gatewayEpoch === epoch;
    };
    const confirmation = (async () => {
      if (expectedIdentity) {
        // A different process can replace the stored session without advancing
        // this instance's auth epoch. Verify the same non-secret session before
        // reporting a successful write; token renewal may change token fields.
        const current = await targetStore.read().catch(() => null);
        if (!current?.ok || !isDeepStrictEqual(sessionIdentity(current.grant), expectedIdentity)) throw writeUnknown();
      }
      postCommitCurrent(assertCurrent, authentication);
      if (!isCurrent()) throw writeUnknown();
      const summary = await read(targetGatewayStore, targetStore, isCurrent);
      if (!isCurrent() || !accepts(summary)) throw writeUnknown();
      // `read` includes an async storage description after resolving the pair.
      // Recheck the record after it: a newer joint write during that await must
      // not turn an old configured/empty summary into a successful response.
      const record = await targetGatewayStore.read().catch(() => null);
      const matches = summary.state === 'unconfigured'
        ? record?.ok && record.credential === null
        : record?.ok && record.credential?.writeOperationId === summary.generation;
      postCommitCurrent(assertCurrent, authentication);
      if (!isCurrent() || !matches) throw writeUnknown();
      if (!ownsFlight) epoch = invalidateGatewayReads();
      const changed = !isDeepStrictEqual(provider.gatewaySummary, summary);
      provider.gatewaySummary = summary;
      published = true;
      provider.gatewayLoadedAt = now();
      if (changed && !selection.inFlight) selection.schedule();
      return summary;
    })();
    let cancel;
    const cancellation = new Promise((resolve) => { cancel = () => { expired = true; resolve(invalidated); }; });
    const bounded = Promise.race([
      confirmation,
      cancellation,
      new Promise((resolve) => { timer = setTimeout(() => { expired = true; resolve(timedOut); }, GATEWAY_CONFIRM_TIMEOUT_MS); }),
    ]).then((value) => {
      if ((ownsFlight || published) && (value === timedOut || value === invalidated)) {
        publishUnknown(targetStore, targetGatewayStore, targetCredentials, epoch);
      }
      return value;
    }, (error) => {
      if (ownsFlight || published) publishUnknown(targetStore, targetGatewayStore, targetCredentials, epoch);
      throw error;
    });
    // Readers that join this flight retain load()'s null-on-failure contract;
    // only the mutation caller receives the specific write outcome.
    const flight = bounded.then((value) => value === timedOut || value === invalidated ? null : value, () => null)
      .finally(() => {
        if (provider.gatewayLoading === flight) provider.gatewayLoading = null;
        if (cancelConfirmation === cancel) cancelConfirmation = null;
      });
    if (ownsFlight) {
      cancelConfirmation = cancel;
      provider.gatewayLoading = flight;
    }
    let summary;
    try { summary = await bounded; }
    finally { clearTimeout(timer); }
    if (summary === timedOut || summary === invalidated) {
      // A late read is still running and cannot be cancelled through the
      // credentials interface. Fence it only if no newer mutation replaced it.
      throw writeUnknown();
    }
    try {
      if (provider.gatewayEpoch !== epoch || !accepts(summary)) throw writeUnknown();
      postCommitCurrent(assertCurrent, authentication);
      ctx.notify();
      const view = ctx.view();
      if (provider.gatewayEpoch !== epoch || !accepts(view.gatewayCredential)) throw writeUnknown();
      return view;
    } catch (error) {
      if (ownsFlight || published) publishUnknown(targetStore, targetGatewayStore, targetCredentials, epoch);
      throw error;
    }
  }
  async function withModelSettings(use, { readGateway = true, signedOutCode = 'IAM_LOGIN_REQUIRED' } = {}) {
    const epoch = getAuthEpoch();
    const assertActive = () => {
      ctx.assertExclusive();
      if (ctx.disposed || isSigningOut() || getAuthEpoch() !== epoch) {
        throw new IamError('IAM_MODEL_CONTEXT_CHANGED', '企业账号状态已变化，请重新登录。');
      }
    };
    assertActive();
    const cold = !ctx.lastGrant;
    if (cold) {
      const pendingAtStart = pendingObservationFor(provider.store, provider.storeCredentials);
      if (!pendingAtStart) await syncSession();
      assertActive();
      const targetStore = provider.store;
      const credentials = provider.storeCredentials;
      const pending = pendingAtStart ?? pendingObservationFor(targetStore, credentials);
      if (pending) {
        // A cold caller may join only this operation's receipt. General token
        // resolution can adopt a distinct login while the receipt is pending.
        const receipt = await pending.wait();
        assertActive();
        assertClientAuthCurrent(receipt?.authentication);
        if (!receipt || provider.atomicBinding(targetStore, credentials) !== pending.atomicBinding
          || !ctx.lastGrant || !isDeepStrictEqual(grantIdentity(ctx.lastGrant), grantIdentity(receipt.grant))) {
          throw new IamError('IAM_RENEWAL_UNCONFIRMED', safeMessage('IAM_RENEWAL_UNCONFIRMED'));
        }
      }
    }
    const settings = selection.captureSettings(signedOutCode);
    const expired = isAccessExpired(ctx.lastGrant, now());
    const modelSession = expired ? captureModelSession() : null;
    try {
      await settings.verify({ allowExpired: expired });
    } catch (error) {
      // Only the bound renewal may wait for a pending rotation. Settings
      // reads, writes and gateway dispatch still require a confirmed grant.
      if (!expired || !(error instanceof IamError) || error.code !== 'IAM_RENEWAL_UNCONFIRMED') throw error;
    }
    if (expired) {
      settings.assertCurrent();
      if (isAccessExpired(ctx.lastGrant, now())) {
        await modelSession.renew({ expiredCode: signedOutCode });
      }
      await settings.verify();
    }
    if (readGateway) await (sessionSummaryRead ?? load({ force: cold }));
    settings.assertCurrent();
    const result = await use(settings);
    await settings.verify();
    return result;
  }

  async function refreshModels() {
    const runtime = getManagedModelRuntime?.();
    if (!runtime) throw new IamError('ENTERPRISE_MODELS_UNAVAILABLE', '企业模型暂不可用，请联系管理员。');
    return withModelSettings((settings) => runtime.refresh(settings));
  }

  async function resolveConnection() {
    // This returns only the personal Key; the IAM token has its own per-request
    // resolver and never passes through this return value. A cold start still
    // adopts the stored session first, but once a grant is in memory the key is
    // not made to wait on a token round trip: a failing preflight is the token
    // layer's error to report, not "cannot read the credential".
    if (!ctx.lastGrant) await resolveToken();
    const epoch = getAuthEpoch();
    const targetStore = provider.require();
    const targetGatewayStore = provider.gatewayStore;
    const targetCredentials = provider.storeCredentials;
    const subject = ctx.lastGrant?.subject;
    const generation = selection.generation;
    const check = () => {
      // A session is continuable while either factor still works: a valid
      // access token serves the request as-is, and a valid refresh token is
      // renewed by the token resolver before the request is sent. Only a dead
      // session (both expired) is rejected here.
      const grant = ctx.lastGrant;
      const continuable = Boolean(grant) && (isRefreshUsable(grant, now()) || !isAccessExpired(grant, now()));
      if (ctx.disposed || isSigningOut() || getAuthEpoch() !== epoch || selection.generation !== generation
        || !['ready', 'expired'].includes(ctx.state) || !subject || !grant || grant.subject !== subject
        || !continuable) {
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
    // A Key is only ever sent to the target it was bound to (issue #226). An
    // unprovable binding — address changed, issuer changed, or a record written
    // before the binding existed — stops the call instead of guessing, and the
    // person is asked to re-enter the Key once.
    const authoritative = authoritativeBaseURL();
    const binding = evaluateGatewayBinding({
      credential: record.credential,
      expectedIssuer: ctx.knownIssuer(),
      authoritativeBaseURL: authoritative,
    });
    if (!binding.bound) {
      throw new IamError('IAM_GATEWAY_CREDENTIAL_REBIND_REQUIRED', safeMessage('IAM_GATEWAY_CREDENTIAL_REBIND_REQUIRED'), { reason: binding.reason });
    }
    const address = resolveTargetBaseURL({ credentialBaseURL: record.credential.baseURL, authoritativeBaseURL: authoritative });
    if (!address) throw new IamError('IAM_GATEWAY_URL_INVALID', '请先设置网关地址。');
    const baseURL = normalizeGatewayBaseURL(address);
    return { key: resolved.value, baseURL, generation: record.credential.writeOperationId ?? null, subject };
  }

  async function saveCredential({ key: value, deviceLabel, baseURL: address } = {}) {
    const started = performance.now();
    const trace = (stage) => {
      try {
        const result = logGatewayStage?.(stage, Math.max(0, Math.round(performance.now() - started)));
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      } catch { /* Diagnostics must not affect a credential mutation. */ }
    };
    trace('start');
    // The enterprise configuration owns the target whenever it exists: a request
    // that carries a different address is rejected as a whole, and the Key in
    // that request is not saved (issue #226).
    const authoritative = authoritativeBaseURL();
    const requested = address === undefined ? undefined : normalizeGatewayBaseURL(address);
    if (authoritative !== undefined && requested !== undefined && requested !== authoritative) {
      throw new IamError(
        'IAM_GATEWAY_URL_MISMATCH',
        '保存的网关地址与企业配置不一致，本次未保存凭证。',
        { authoritative: true },
      );
    }
    const baseURL = authoritative ?? requested;
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    bumpGeneration();
    if (!configured) {
      throw new IamError('IAM_UNCONFIGURED', safeMessage('IAM_UNCONFIGURED'), {
        missing: isConfigured(config).missing,
      });
    }
    const expectedIssuer = ctx.knownIssuer();
    const epoch = getAuthEpoch();
    const targetStore = provider.require();
    const targetGatewayStore = provider.gatewayStore;
    const targetCredentials = provider.storeCredentials;
    const mutationEpoch = provider.gatewayEpoch;
    if (!targetGatewayStore) {
      throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'));
    }
    const assertCurrent = () => {
      const active = () => {
        if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
        if (isSigningOut() || getAuthEpoch() !== epoch || ctx.state === 'authenticating') {
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
    trace('grant-read');
    assertCurrent();
    if (!record?.ok) throw new IamError('IAM_GRANT_INVALID', safeMessage('IAM_GRANT_INVALID'));
    grants.assertGrantContext(record.grant, expectedIssuer);
    const authentication = await grants.prepareAuthentication(expectedIssuer, targetStore, targetCredentials, { grant: record.grant, guard: assertCurrent });
    trace('authentication-ready');
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
    const issuer = ctx.knownIssuer();
    // Without a preset, falling back to the stored address is only safe for the
    // same account and issuer: another person's or a stale issuer's target must
    // not be inherited silently.
    const previous = (await targetGatewayStore.read().catch(() => null))?.credential;
    const inheritable = previous
      && previous.version === 3
      && previous.ownerSubject === subject
      && previous.issuer === issuer
      ? previous.baseURL
      : undefined;
    const targetAddress = baseURL ?? inheritable;
    // Without a trusted issuer and a concrete target there is nothing to bind,
    // so the Key is not stored rather than stored unbound.
    if (typeof issuer !== 'string' || issuer.length === 0 || typeof targetAddress !== 'string' || targetAddress.length === 0) {
      throw new IamError('IAM_GATEWAY_BINDING_INCOMPLETE', '缺少可信的企业身份或网关地址，凭证未保存。');
    }
    assertCurrent();
    let saved;
    try {
      trace('write-start');
      saved = await targetGatewayStore.save({
        value,
        baseURL: targetAddress,
        ownerSubject: subject,
        issuer,
        deviceLabel: label,
        enteredAt,
        suggestedExpiry,
      }, { guard: () => { assertCurrent(); assertClientAuthCurrent(authentication); return true; } });
      trace('write-confirmed');
    } catch (cause) {
      trace('write-unconfirmed');
      if (cause instanceof StoreError && cause.code === 'IAM_GATEWAY_WRITE_UNKNOWN') {
        fenceUnknown(targetStore, targetGatewayStore, targetCredentials, mutationEpoch);
      }
      if (cause instanceof StoreError) throw new IamError(cause.code, safeMessage(cause.code));
      throw cause;
    }
    trace('confirmation-start');
    try {
      const view = await confirmMutation({
        assertCurrent, authentication, targetStore, targetGatewayStore, targetCredentials, mutationEpoch,
        expectedIdentity: sessionIdentity(record.grant),
        accepts: (summary) => summary?.state === 'configured'
          && summary.generation === saved.credential.writeOperationId,
      });
      trace('confirmation-confirmed');
      return view;
    } catch (error) {
      trace('confirmation-unconfirmed');
      throw error;
    }
  }

  async function clearCredential() {
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    bumpGeneration();
    const targetStore = provider.require();
    const targetGatewayStore = provider.gatewayStore;
    const targetCredentials = provider.storeCredentials;
    const mutationEpoch = provider.gatewayEpoch;
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
      if (cause instanceof StoreError && cause.code === 'IAM_GATEWAY_WRITE_UNKNOWN') {
        fenceUnknown(targetStore, targetGatewayStore, targetCredentials, mutationEpoch);
      }
      if (cause instanceof StoreError) throw new IamError(cause.code, safeMessage(cause.code));
      throw cause;
    }
    if (!cleared.ok) {
      throw new IamError('IAM_CREDENTIALS_CLEAR_FAILED', safeMessage('IAM_CREDENTIALS_CLEAR_FAILED'));
    }
    return confirmMutation({
      assertCurrent, targetStore, targetGatewayStore, targetCredentials, mutationEpoch,
      accepts: (summary) => summary?.state === 'unconfigured',
    });
  }

  return {
    read, load, refreshSessionSummary, withModelSettings, refreshModels, resolveConnection, saveCredential, clearCredential,
  };
}
