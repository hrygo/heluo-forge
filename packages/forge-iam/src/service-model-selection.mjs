import { IamError } from './errors.mjs';
import { inspectReadonlyModelSelection, readonlyModelResult } from './model-selection-host.mjs';
import { isAccessExpired, isRefreshUsable } from './record.mjs';

/**
 * The durable default-model selection and its single-flight reconciliation.
 *
 * A catalogue read is the only place that writes a default model, so the flight
 * lives next to it: a forced gateway read or a second caller joins the current
 * flight instead of starting a competing one, and a queued request re-runs once
 * the flight settles. Reconciliation is deliberately detached from login
 * failure handling, so a read-only observation can never discard a grant.
 */
export function createModelSelection(env) {
  const { config, options, ctx, provider, grants, now, getAuthEpoch, isSigningOut, getLoadGateway, resolveToken } = env;

  let flight = null;
  let queued = false;
  let generation = 0;

  async function owner() {
    const target = provider.ensure();
    if (!target) return null;
    const credentials = provider.storeCredentials;
    const record = await target.read().catch(() => null);
    if (!record?.ok || !record.grant?.subject) return null;
    try { grants.assertGrantContext(record.grant, ctx.knownIssuer()); } catch { return null; }
    const expires = Date.parse(record.grant.accessExpiresAt);
    return { subject: record.grant.subject, credentials, expired: !Number.isFinite(expires) || expires <= now() };
  }

  function services() {
    try {
      if (typeof options.getModelSelectionServices !== 'function') return undefined;
      const binding = options.getModelSelectionServices();
      if (binding && typeof binding.then === 'function') {
        Promise.resolve(binding).catch(() => {});
        return undefined;
      }
      if (!binding || typeof binding !== 'object') return undefined;
      // Retain the binding identity too: an injected scope may be removed and
      // rebound with the same two SDK instances while an old read is pending.
      const llm = binding.llm;
      const agentDefaultModel = binding.agentDefaultModel;
      return llm && agentDefaultModel ? { binding, llm, agentDefaultModel } : undefined;
    } catch {
      return undefined;
    }
  }

  function schedule() {
    if (ctx.disposed || !config.defaultModel.trim()) return;
    if (flight) {
      queued = true;
      return;
    }
    // Deliberately detached from login/callback failure handling. A read-only
    // model observation must never discard a grant or revoke a token.
    void reconcile().catch(() => {});
  }

  async function reconcile() {
    if (!config.defaultModel.trim() || !config.defaultProvider.trim()) {
      return readonlyModelResult('default-model-unconfigured');
    }
    if (ctx.disposed || isSigningOut() || ctx.state !== 'ready') return readonlyModelResult('iam-not-ready');
    const targetStore = provider.ensure();
    const targetCredentials = provider.storeCredentials;
    const grant = ctx.lastGrant;
    if (!targetStore || !grant || grants.ownerOf(grant) !== targetStore
      || isAccessExpired(grant, now())) return readonlyModelResult('iam-not-ready');
    const current = services();
    if (!current) return readonlyModelResult('model-services-unavailable');
    if (flight) {
      queued = true;
      return flight.promise;
    }
    const auth = getAuthEpoch();
    const epochGeneration = generation;
    const gateway = provider.gatewayEpoch;
    const active = () => !ctx.disposed && !isSigningOut() && ctx.state === 'ready' && ctx.exclusive.ok
      && getAuthEpoch() === auth && generation === epochGeneration && provider.gatewayEpoch === gateway
      && ctx.lastGrant === grant && !isAccessExpired(grant, now());
    const isCurrent = () => {
      try {
        if (!active()) return false;
        ctx.assertExclusive();
        if (!active() || provider.ensure() !== targetStore || provider.storeCredentials !== targetCredentials) return false;
        const serving = services();
        return active() && serving?.binding === current.binding && serving.llm === current.llm
          && serving.agentDefaultModel === current.agentDefaultModel;
      } catch { return false; }
    };
    const request = Promise.resolve().then(async () => {
      if (!isCurrent()) return readonlyModelResult('model-context-changed');
      const summary = await getLoadGateway()({ force: true });
      if (!isCurrent()) return readonlyModelResult('model-context-changed');
      if (summary?.state !== 'configured' || summary.matchesAccount !== true) {
        return readonlyModelResult('gateway-credential-unavailable');
      }
      return inspectReadonlyModelSelection(current, {
        provider: config.defaultProvider, model: config.defaultModel,
      }, isCurrent);
    }).catch(() => readonlyModelResult(isCurrent() ? 'model-read-failed' : 'model-context-changed'))
      .finally(() => {
        if (flight?.promise !== request) return;
        flight = null;
        const pending = queued;
        queued = false;
        if (pending) schedule();
      });
    flight = { promise: request };
    return request;
  }
  /**
   * Durable selection for the signed-in person. The record is bound to one
   * subject, so another person's saved choice is never adopted: it reads as
   * "nothing saved" and the runtime starts from the catalogue.
   */
  async function readSelection() {
    const current = await owner();
    if (!current) return { subject: null, saved: false, models: {}, defaultModelId: null };
    const target = provider.ensure() ? provider.modelSelectionStore : null;
    if (!target || provider.storeCredentials !== current.credentials) {
      return { subject: current.subject, saved: false, models: {}, defaultModelId: null };
    }
    const record = await target.read();
    if (!record.ok || !record.selection || record.selection.subject !== current.subject) {
      // Nothing stored for this subject (or the record belongs to someone else
      // or is unreadable): the caller decides the first-run default.
      return { subject: current.subject, saved: false, models: {}, defaultModelId: null };
    }
    return { subject: current.subject, saved: true, models: record.selection.models, defaultModelId: record.selection.defaultModelId };
  }

  /** Persist the enabled set. Never a token channel: only model ids and overrides. */
  async function saveSelection({ models, defaultModelId } = {}) {
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    let current = await owner();
    if (current?.expired && ctx.lastGrant && isRefreshUsable(ctx.lastGrant, now())) {
      try {
        await resolveToken();
        current = await owner();
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
  }

  return {
    get inFlight() { return Boolean(flight); },
    get generation() { return generation; },
    set generation(next) { generation = next; },
    clearQueue() { queued = false; },
    owner,
    services,
    readSelection,
    saveSelection,
    schedule,
    reconcile,
  };
}
