// Composition-level exclusivity check. The official account service is a Host
// service, so a leftover `deepseekAccount` means the official login path is
// still mounted even when the four rows were supposedly disabled.

/**
 * @param {{ get?: (name: string) => unknown } | undefined} ctx
 * @param {Record<string, unknown>} config
 * @returns {{ ok: true } | { ok: false, reason: 'exclusive-violation' | 'exclusive-check-unavailable' }}
 */
/** Host services that prove an official login path is still mounted. */
export const DEFAULT_EXCLUSIVE_SERVICES = Object.freeze(['deepseekAccount']);

/**
 * @param {Record<string, unknown>} [config]
 * @returns {string[]} the services this composition must keep absent
 */
export function exclusiveServices(config) {
  const configured = config?.exclusiveServices;
  if (!Array.isArray(configured) || configured.length === 0) return [...DEFAULT_EXCLUSIVE_SERVICES];
  return configured;
}

/**
 * Names the first official service still mounted, so the caller can report it
 * without widening the check result.
 *
 * @param {{ get?: (name: string) => unknown } | undefined} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {string | undefined}
 */
export function officialServicePresent(ctx, config) {
  if (!ctx || typeof ctx.get !== 'function') return undefined;
  for (const name of exclusiveServices(config)) {
    let service;
    try {
      service = ctx.get(name);
    } catch {
      // An unreadable lookup proves nothing; the caller's fail-closed path
      // reports the unavailable check separately.
      continue;
    }
    if (service !== undefined && service !== null) return name;
  }
  return undefined;
}

export function checkExclusive(ctx, config) {
  if (config?.requireExclusive === false) return { ok: true };

  if (!ctx || typeof ctx.get !== 'function') {
    return { ok: false, reason: 'exclusive-check-unavailable' };
  }

  try {
    for (const name of exclusiveServices(config)) {
      const service = ctx.get(name);
      if (service !== undefined && service !== null) {
        return { ok: false, reason: 'exclusive-violation' };
      }
    }
    return { ok: true };
  } catch {
    // A context that cannot answer the service lookup must not be treated as
    // proof that the official account path is absent.
    return { ok: false, reason: 'exclusive-check-unavailable' };
  }
}
// Official bypasses that live in the environment rather than in a Host service:
// a real key here still lets a caller reach a model without the enterprise IAM
// path, so the composition reports it instead of assuming the disabled rows are
// the only bypass. Only names cross this boundary, never values.
export const ENV_BYPASS_VARIABLES = Object.freeze(['DEEPSEEK_API_KEY']);

/**
 * @param {Record<string, unknown>} [env]
 * @returns {string[]} names of bypass variables that hold a non-empty value
 */
export function detectEnvBypass(env = {}) {
  return ENV_BYPASS_VARIABLES.filter((name) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * @param {string[]} names
 * @returns {string} a fixed diagnostic line, or an empty string when nothing is
 * detected; variable names only so no secret can reach a log
 */
export function formatEnvBypassWarning(names) {
  if (names.length === 0) return '';
  return `forge-iam: official bypass variables present: ${names.join(', ')}`;
}
