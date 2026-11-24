// Composition-level exclusivity check. The official account service is a Host
// service, so a leftover `deepseekAccount` means the official login path is
// still mounted even when the four rows were supposedly disabled.

import { DEFAULT_EXCLUSIVE_SERVICES } from './config.mjs';

export { DEFAULT_EXCLUSIVE_SERVICES };

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
 * Single-pass scan over configured exclusive services so naming diagnostics and
 * fail-closed exclusivity verdicts share identical traversal and error semantics.
 *
 * @param {{ get?: (name: string) => unknown } | undefined} ctx
 * @param {Record<string, unknown>} [config]
 * @param {(name: string) => void} [onUnreadable]
 * @returns {{ status: 'ok' } | { status: 'violation', mounted: string } | { status: 'unavailable' }}
 */
function scanExclusiveServices(ctx, config, onUnreadable) {
  if (!ctx || typeof ctx.get !== 'function') {
    return { status: 'unavailable' };
  }
  let unreadable = false;
  for (const name of exclusiveServices(config)) {
    let service;
    try {
      service = ctx.get(name);
    } catch {
      // An unreadable lookup proves nothing; keep scanning so an explicitly
      // mounted official service still produces a violation verdict, and fall
      // back to unavailable (fail-closed) if none is found.
      unreadable = true;
      onUnreadable?.(name);
      continue;
    }
    if (service !== undefined && service !== null) {
      return { status: 'violation', mounted: name };
    }
  }
  return unreadable ? { status: 'unavailable' } : { status: 'ok' };
}

/**
 * Names the first official service still mounted, so the caller can report it
 * without widening the check result.
 *
 * @param {{ get?: (name: string) => unknown } | undefined} ctx
 * @param {Record<string, unknown>} [config]
 * @param {(name: string) => void} [onUnreadable] told which lookup threw, so the
 *   caller can attribute the fail-closed result instead of logging a bare
 *   "unavailable"
 * @returns {string | undefined}
 */
export function officialServicePresent(ctx, config, onUnreadable) {
  const scan = scanExclusiveServices(ctx, config, onUnreadable);
  return scan.status === 'violation' ? scan.mounted : undefined;
}

/**
 * @param {{ get?: (name: string) => unknown } | undefined} ctx
 * @param {Record<string, unknown>} config
 * @param {{
 *   onMounted?: (name: string) => void,
 *   onUnreadable?: (name: string) => void,
 * }} [diagnostics]
 * @returns {{ ok: true } | { ok: false, reason: 'exclusive-violation' | 'exclusive-check-unavailable' }}
 */
export function checkExclusive(ctx, config, diagnostics) {
  if (config?.requireExclusive === false) return { ok: true };

  const scan = scanExclusiveServices(ctx, config, diagnostics?.onUnreadable);
  if (scan.status === 'violation') {
    diagnostics?.onMounted?.(scan.mounted);
    return { ok: false, reason: 'exclusive-violation' };
  }
  if (scan.status === 'unavailable') {
    // A context that cannot answer the service lookup must not be treated as
    // proof that the official account path is absent.
    return { ok: false, reason: 'exclusive-check-unavailable' };
  }
  return { ok: true };
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
