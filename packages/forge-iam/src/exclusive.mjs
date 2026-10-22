// Composition-level exclusivity check. The official account service is a Host
// service, so a leftover `deepseekAccount` means the official login path is
// still mounted even when the four rows were supposedly disabled.

/**
 * @param {{ get?: (name: string) => unknown } | undefined} ctx
 * @param {Record<string, unknown>} config
 * @returns {{ ok: true } | { ok: false, reason: 'exclusive-violation' | 'exclusive-check-unavailable' }}
 */
export function checkExclusive(ctx, config) {
  if (config?.requireExclusive === false) return { ok: true };

  if (!ctx || typeof ctx.get !== 'function') {
    return { ok: false, reason: 'exclusive-check-unavailable' };
  }

  try {
    const account = ctx.get('deepseekAccount');
    if (account !== undefined && account !== null) {
      return { ok: false, reason: 'exclusive-violation' };
    }
    return { ok: true };
  } catch {
    // A context that cannot answer the service lookup must not be treated as
    // proof that the official account path is absent.
    return { ok: false, reason: 'exclusive-check-unavailable' };
  }
}