import { isDeepStrictEqual } from 'node:util';
import { assertClientAuthCurrent } from './client-auth.mjs';
import { isConfigured } from './config.mjs';
import { IamError } from './errors.mjs';
import { normalizeGatewayBaseURL } from './managed-models.mjs';
import { StoreError } from './store.mjs';
import { addSeconds, nowIso, safeMessage } from './service-helpers.mjs';

const GATEWAY_RELOAD_MS = 5000;

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
    configured, getAuthEpoch, isSigningOut, resolveToken, bumpGeneration, getManagedModelRuntime,
  } = env;

  async function read(targetGatewayStore, targetStore, isCurrent) {
    if (!isCurrent()) return null;
    const record = await targetGatewayStore.read().catch(() => ({ ok: false, reason: 'unreadable' }));
    if (!isCurrent()) return null;
    if (!record.ok) return { state: 'invalid' };
    const resolved = await targetGatewayStore.resolve(record.credential).catch(() => undefined);
    if (!isCurrent()) return null;
    const credential = record.credential ?? {};
    if (resolved?.invalid) return { state: 'invalid' };
    if (!resolved?.value) return { state: 'unconfigured' };
    // A keychain value without metadata is still unattributable. This status is
    // informational; it does not prevent another consumer resolving the ref.
    if (!record.credential) return { state: 'invalid', matchesAccount: false };
    const storage = await targetGatewayStore.describe().catch(() => null);
    if (!isCurrent()) return null;
    const signedInSubject = ctx.lastGrant && grants.ownerOf(ctx.lastGrant) === targetStore ? ctx.lastGrant.subject : null;
    const matchesAccount = Boolean(credential.ownerSubject && signedInSubject && credential.ownerSubject === signedInSubject);
    return {
      // Without a session the stored key is still "configured"; it only becomes
      // a mismatch once a different subject is known.
      state: !signedInSubject || matchesAccount ? 'configured' : 'owner-mismatch',
      ownerSubject: credential.ownerSubject ?? null,
      baseURL: credential.baseURL ?? config.managedModels?.baseURL ?? null,
      generation: credential.writeOperationId ?? null,
      deviceLabel: credential.deviceLabel ?? null,
      enteredAt: credential.enteredAt ?? null,
      suggestedExpiry: credential.suggestedExpiry ?? null,
      // 'keychain' is the only source that keeps the value out of plaintext
      // files; the account page warns for the dev/pilot fallbacks.
      storage: storage?.configured ? (storage.source ?? null) : null,
      matchesAccount,
    };
  }

  async function load({ force = false } = {}) {
    if (ctx.disposed) return null;
    // Cache hits and singleflight reuse must belong to the live provider too.
    const targetStore = provider.ensure();
    if (ctx.disposed || !targetStore || !provider.gatewayStore) return null;
    if (!force && provider.gatewayLoadedAt > 0 && now() - provider.gatewayLoadedAt < GATEWAY_RELOAD_MS) return provider.gatewaySummary;
    if (provider.gatewayLoading) return provider.gatewayLoading;
    const targetGatewayStore = provider.gatewayStore;
    const targetCredentials = provider.storeCredentials;
    const epoch = provider.gatewayEpoch;
    const isCurrent = () => {
      if (ctx.disposed || epoch !== provider.gatewayEpoch) return false;
      const current = provider.ensure();
      return !ctx.disposed && epoch === provider.gatewayEpoch && current === targetStore
        && provider.gatewayStore === targetGatewayStore && provider.storeCredentials === targetCredentials;
    };
    const request = read(targetGatewayStore, targetStore, isCurrent)
      .then((summary) => {
        if (!isCurrent()) return null;
        const changed = !isDeepStrictEqual(provider.gatewaySummary, summary);
        provider.gatewaySummary = summary;
        provider.gatewayLoadedAt = now();
        // Own forced reads do not feed back into another observation.
        if (changed && !selection.inFlight) selection.schedule();
        return summary;
      })
      .catch(() => {
        if (isCurrent()) { provider.gatewaySummary = null; provider.gatewayLoadedAt = 0; }
        return null;
      })
      .finally(() => { if (provider.gatewayLoading === request) provider.gatewayLoading = null; });
    provider.gatewayLoading = request;
    return request;
  }
  async function refreshModels() {
    const runtime = getManagedModelRuntime?.();
    if (!runtime) throw new IamError('ENTERPRISE_MODELS_UNAVAILABLE', '企业模型暂不可用，请联系管理员。');
    return runtime.refresh();
  }

  async function resolveConnection() {
    // Refresh and validate the current grant through the existing authoritative path.
    // This returns only the personal Key; the IAM token has its own per-request
    // resolver and never passes through this return value.
    await resolveToken();
    const epoch = getAuthEpoch();
    const targetStore = provider.require();
    const targetGatewayStore = provider.gatewayStore;
    const targetCredentials = provider.storeCredentials;
    const subject = ctx.lastGrant?.subject;
    const generation = selection.generation;
    const check = () => {
      if (ctx.disposed || isSigningOut() || getAuthEpoch() !== epoch || selection.generation !== generation
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
  }

  async function saveCredential({ key: value, deviceLabel, baseURL: address } = {}) {
    const baseURL = address === undefined ? undefined : normalizeGatewayBaseURL(address, config.allowInsecureHttp);
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
    await load({ force: true });
    assertCurrent();
    assertClientAuthCurrent(authentication);
    ctx.notify();
    return ctx.view();
  }

  async function clearCredential() {
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    bumpGeneration();
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
    await load({ force: true });
    assertCurrent();
    ctx.notify();
    return ctx.view();
  }

  return {
    read, load, refreshModels, resolveConnection, saveCredential, clearCredential,
  };
}
