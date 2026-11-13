/**
 * Gateway credential binding (issue #226).
 *
 * A stored personal Key is only meaningful for the exact target it was entered
 * for. Three facts pin that target, all read by the Host rather than the UI:
 *
 *   - `issuer`      the trusted IAM issuer this deployment authenticates against
 *                   (`config.issuer` or the validated discovery metadata);
 *   - `baseURL`     the normalized gateway address the Key was saved for, which
 *                   must equal the enterprise-configured authoritative address
 *                   whenever that address is configured;
 *   - `ownerSubject` the signed-in person who entered it (existing check).
 *
 * Records written before the binding existed (version 1 and 2) cannot prove any
 * of this, so they are reported as unbound and the Key is never sent until the
 * person re-enters it once. Nothing here is inferred from the grant or from a
 * discovery document: a pin must come from normalized configuration or from
 * data this instance validated.
 *
 * The evaluation is pure and total: every input combination yields either
 * `bound: true` or a stable reason. Callers translate the reason into an error
 * code and a user-facing prompt; they never re-derive the comparison.
 */

/** Version that carries the full binding; earlier versions cannot prove it. */
export const BOUND_RECORD_VERSION = 3;

export const BINDING_REASONS = Object.freeze({
  LEGACY_UNBOUND: 'legacy-unbound',
  ISSUER_MISSING: 'issuer-missing',
  ISSUER_CHANGED: 'issuer-changed',
  ADDRESS_MISSING: 'address-missing',
  ADDRESS_CHANGED: 'address-changed',
});

const nonEmpty = value => typeof value === 'string' && value.length > 0;

/**
 * @param {object} input
 * @param {object|undefined} input.credential stored record payload
 * @param {string} [input.expectedIssuer] trusted issuer known to this instance
 * @param {string} [input.authoritativeBaseURL] normalized enterprise address, when configured
 * @returns {{ bound: boolean, reason?: string, addressMatches: boolean }}
 */
export function evaluateGatewayBinding(input = {}) {
  const { credential, expectedIssuer, authoritativeBaseURL } = input;
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    return { bound: false, reason: BINDING_REASONS.LEGACY_UNBOUND, addressMatches: false };
  }
  // A record without the bound version cannot prove issuer or address, even if
  // the fields were hand-added: the write generation that produced it was not
  // checked against this binding.
  if (credential.version !== BOUND_RECORD_VERSION) {
    return { bound: false, reason: BINDING_REASONS.LEGACY_UNBOUND, addressMatches: false };
  }
  if (!nonEmpty(credential.issuer)) {
    return { bound: false, reason: BINDING_REASONS.ISSUER_MISSING, addressMatches: false };
  }
  if (!nonEmpty(expectedIssuer) || credential.issuer !== expectedIssuer) {
    return { bound: false, reason: BINDING_REASONS.ISSUER_CHANGED, addressMatches: false };
  }
  if (!nonEmpty(credential.baseURL)) {
    return { bound: false, reason: BINDING_REASONS.ADDRESS_MISSING, addressMatches: false };
  }
  // The enterprise-configured address is the anchor whenever it exists. Without
  // one (no preset deployment) the saved address is the only anchor there is,
  // and a change of target can only happen by re-saving, which re-enters the
  // Key; that limitation is documented rather than papered over.
  if (nonEmpty(authoritativeBaseURL) && credential.baseURL !== authoritativeBaseURL) {
    return { bound: false, reason: BINDING_REASONS.ADDRESS_CHANGED, addressMatches: false };
  }
  return { bound: true, addressMatches: true };
}

/**
 * The address a personal Key may be sent to. The authoritative enterprise
 * address wins whenever it is configured; a stored address never redefines the
 * target on its own. Returns `undefined` when neither exists, so the caller
 * fails closed instead of inventing one.
 */
export function resolveTargetBaseURL({ credentialBaseURL, authoritativeBaseURL } = {}) {
  if (nonEmpty(authoritativeBaseURL)) return authoritativeBaseURL;
  return nonEmpty(credentialBaseURL) ? credentialBaseURL : undefined;
}
