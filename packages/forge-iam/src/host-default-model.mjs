// Align DSH's "default model for new conversations" with the enterprise
// catalogue when, and only when, the current default provably cannot run.
//
// Why this exists: the enterprise patch disables the official providers, but
// DSH keeps its shipped default (an official model). New sessions then fail
// with `session/model-unavailable` until the person picks a model by hand.
// In an intranet deployment the official models can never work, so a default
// that points at an unregistered provider is not a choice worth preserving.
//
// Rules (each one is a test):
// - A default that is still usable is never touched, whatever its provider.
// - "Unusable" must be proven: provider not registered, the enterprise model
//   not enabled/advertised, or a registered provider listing models without it.
//   A provider whose listModels throws is "unknown" and is left alone.
// - At most one write per call; no retry, no compensation on failure.
// - The caller's isCurrent() is checked before the write so a sign-out or an
//   account switch during the async read cannot write for the wrong person.
// - Results are fixed codes; no selection, subject or SDK error text leaks.

export const HOST_DEFAULT_RESULTS = Object.freeze({
  ALIGNED: 'aligned',
  KEPT: 'kept',
  NO_TARGET: 'no-target',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
  STALE: 'stale',
  FAILED: 'failed',
});

const isSelection = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && typeof value.provider === 'string' && typeof value.model === 'string';

/**
 * Decide whether a non-enterprise selection is routable right now.
 * @returns {Promise<boolean|null>} true usable, false provably unusable, null unknown.
 */
async function foreignUsable(llm, selection) {
  let providers;
  try { providers = llm.listProviders(); } catch { return null; }
  if (!Array.isArray(providers)) return null;
  if (!providers.some(item => item?.id === selection.provider)) return false;
  try {
    const list = await llm.listModels(selection.provider);
    return Array.isArray(list) ? list.some(item => item?.id === selection.model) : null;
  } catch { return null; }
}

/**
 * @param {{ service: unknown, llm: unknown, provider: string, target: string|null,
 *   enterpriseUsable: (model: string) => boolean, isCurrent: () => boolean }} input
 * @returns {Promise<string>} one of HOST_DEFAULT_RESULTS.
 */
export async function alignHostDefaultModel({ service, llm, provider, target, enterpriseUsable, isCurrent }) {
  if (typeof service?.currentSelection !== 'function' || typeof service?.saveSelection !== 'function'
    || typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') {
    return HOST_DEFAULT_RESULTS.UNSUPPORTED;
  }
  if (typeof target !== 'string' || !target || !enterpriseUsable(target)) return HOST_DEFAULT_RESULTS.NO_TARGET;
  let current;
  try { current = service.currentSelection(); } catch { return HOST_DEFAULT_RESULTS.UNKNOWN; }
  if (current && typeof current.then === 'function') {
    Promise.resolve(current).catch(() => {});
    return HOST_DEFAULT_RESULTS.UNKNOWN;
  }
  if (!isSelection(current)) return HOST_DEFAULT_RESULTS.UNKNOWN;
  const usable = current.provider === provider
    ? enterpriseUsable(current.model)
    : await foreignUsable(llm, current);
  if (usable === null) return HOST_DEFAULT_RESULTS.UNKNOWN;
  if (usable) return HOST_DEFAULT_RESULTS.KEPT;
  if (!isCurrent() || !enterpriseUsable(target)) return HOST_DEFAULT_RESULTS.STALE;
  // reasoningEffort is omitted on purpose: the adapter then applies the
  // model's own lower bound, and an effort tied to the old model is dropped.
  try { await service.saveSelection({ provider, model: target }); }
  catch { return HOST_DEFAULT_RESULTS.FAILED; }
  return HOST_DEFAULT_RESULTS.ALIGNED;
}
