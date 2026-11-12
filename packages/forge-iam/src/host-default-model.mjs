// Observe DSH's new-conversation default without changing it. The user chooses
// a model even when the previous selection is unavailable. The legacy function
// name and result codes remain available to existing callers; `kept` means the
// selection was left unchanged, not that it is usable or authorized.

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
  if (typeof service?.currentSelection !== 'function'
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
  return HOST_DEFAULT_RESULTS.KEPT;
}
