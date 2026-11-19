import { isDeepStrictEqual } from 'node:util';
import { assertClientAuthCurrent } from './client-auth.mjs';
import { IamError } from './errors.mjs';
import { inspectReadonlyModelSelection, readonlyModelResult } from './model-selection-host.mjs';
import { isAccessExpired } from './record.mjs';
import { grantIdentity, safeMessage } from './service-helpers.mjs';
import { StoreError } from './store.mjs';

/**
 * Account-scoped model-selection storage and single-flight Host observation.
 *
 * A forced gateway read or a second caller joins the current observation
 * instead of starting a competing one; a queued request re-runs once the flight
 * settles. Observation is detached from login failure handling, so it cannot
 * discard a grant or write the Host default model.
 */
export function createModelSelection(env) {
  const { config, options, ctx, provider, grants, now, getAuthEpoch, isSigningOut, getLoadGateway } = env;

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
    return { subject: record.grant.subject, credentials };
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
    if (!current) return { subject: null, saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 };
    const target = provider.ensure() ? provider.modelSelectionStore : null;
    if (!target || provider.storeCredentials !== current.credentials) {
      return { subject: current.subject, saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 };
    }
    return readStoredSelection(target, current.subject);
  }

  async function readStoredSelection(target, subject) {
    const record = await target.read();
    if (!record.ok) {
      const code = record.error?.code;
      // A record owned by someone else, or one whose payload cannot be parsed,
      // reads as "nothing stored for this subject": the caller may then start a
      // fresh record. A storage failure is different — the record may well exist
      // and be fine, so answering "nothing stored" would let the next save
      // replace choices this session never saw.
      if (code === 'IAM_MODEL_SELECTION_FOREIGN' || code === 'IAM_MODEL_SELECTION_INVALID') {
        return { subject, saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 };
      }
      throw new IamError('IAM_MODEL_SELECTION_UNREADABLE', '模型设置暂时无法读取，请稍后重试。');
    }
    if (!record.selection || record.selection.subject !== subject) {
      // Nothing stored for this subject (or the record belongs to someone else):
      // the caller decides the first-run default.
      return { subject, saved: false, models: {}, defaultModelId: null, manual: [], manualTruncated: 0 };
    }
    return {
      subject,
      saved: true,
      models: record.selection.models,
      defaultModelId: record.selection.defaultModelId,
      manual: record.selection.manual ?? [],
      manualTruncated: record.selection.manualTruncated ?? 0,
    };
  }

  function captureSettings(signedOutCode = 'IAM_LOGIN_REQUIRED') {
    ctx.assertExclusive();
    if (ctx.disposed) throw new IamError('IAM_DISPOSED', 'IAM service is disposed');
    const grant = ctx.lastGrant;
    if (!grant || isSigningOut()) throw new IamError(signedOutCode, '企业账号状态已变化，请重新登录。');
    const epoch = getAuthEpoch();
    const target = grants.ownerOf(grant);
    const credentials = provider.storeCredentials;
    const selectionStore = provider.modelSelectionStore;
    const identity = grantIdentity(grant);
    const atomicBinding = provider.atomicBinding(target, credentials);
    const changed = () => new IamError('IAM_MODEL_CONTEXT_CHANGED', '企业账号状态已变化，请重新登录。');
    const unavailable = () => new IamError('IAM_CREDENTIALS_UNAVAILABLE', '暂时无法读取企业会话。');
    const assertBinding = () => {
      const active = () => !ctx.disposed && !isSigningOut() && getAuthEpoch() === epoch
        && ['ready', 'expired'].includes(ctx.state) && ctx.lastGrant
        && isDeepStrictEqual(grantIdentity(ctx.lastGrant), identity)
        && grants.ownerOf(ctx.lastGrant) === target;
      ctx.assertExclusive();
      if (!active()) throw changed();
      if (!target || provider.ensure() !== target || provider.storeCredentials !== credentials
        || provider.modelSelectionStore !== selectionStore
        || provider.atomicBinding(target, credentials) !== atomicBinding) throw unavailable();
      if (!active()) throw changed();
      return true;
    };

    let authentication;
    function assertCurrent() {
      assertBinding();
      assertClientAuthCurrent(authentication);
    }

    async function readCurrent(allowExpired = false) {
      assertCurrent();
      let record;
      try { record = await target.read(); }
      catch (cause) {
        assertCurrent();
        throw new IamError('IAM_CREDENTIALS_UNAVAILABLE', safeMessage('IAM_CREDENTIALS_UNAVAILABLE'), { cause: cause?.code });
      }
      assertCurrent();
      const latest = record.grant;
      if (!record.ok || !latest || !isDeepStrictEqual(grantIdentity(latest), identity)) throw changed();
      grants.assertGrantContext(latest, ctx.knownIssuer());
      if (latest.refreshOperation?.state === 'pending') {
        throw new IamError('IAM_RENEWAL_UNCONFIRMED', safeMessage('IAM_RENEWAL_UNCONFIRMED'));
      }
      if (!allowExpired && isAccessExpired(latest, now())) {
        throw new IamError(signedOutCode, '企业账号已过期，请重新登录。');
      }
      return latest;
    }

    async function verify({ allowExpired = false } = {}) {
      const latest = await readCurrent(allowExpired);
      if (config.authMode === 'confidential' && !authentication) {
        authentication = await grants.prepareAuthentication(ctx.knownIssuer(), target, credentials, {
          grant: latest, guard: assertBinding,
        });
      }
      assertCurrent();
    }

    return Object.freeze({
      assertCurrent,
      verify,
      async readSelection() {
        assertCurrent();
        const saved = await readStoredSelection(selectionStore, identity.subject);
        await verify();
        return saved;
      },
      async saveSelection({ models, defaultModelId, manual } = {}) {
        assertCurrent();
        if (!atomicBinding) throw new IamError('IAM_ATOMIC_STORE_UNVERIFIED', safeMessage('IAM_ATOMIC_STORE_UNVERIFIED'));
        if (config.authMode === 'confidential' && !authentication) await verify();
        // The verified backend serializes all writers to this database. Read
        // the original session after acquiring that lock, without nesting a
        // write or holding the lock over client-auth material lookup.
        const guard = async () => {
          try {
            await readCurrent();
          } catch (cause) {
            if (cause instanceof IamError) throw new StoreError(cause.code, cause.message);
            throw cause;
          }
        };
        try {
          const saved = await selectionStore.save({ subject: identity.subject, models, defaultModelId, manual }, { guard });
          return saved.selection;
        } catch (cause) {
          if (cause instanceof StoreError) throw new IamError(cause.code, cause.message);
          throw cause;
        }
      },
    });
  }

  return {
    get inFlight() { return Boolean(flight); },
    get generation() { return generation; },
    set generation(next) { generation = next; },
    clearQueue() { queued = false; },
    owner,
    services,
    readSelection,
    captureSettings,
    schedule,
    reconcile,
  };
}
