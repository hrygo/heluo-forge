import { isDeepStrictEqual } from 'node:util';

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
  const { config, ctx, provider, grants, now, selection } = env;

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
  return { read, load };
}
