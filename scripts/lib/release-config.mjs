/**
 * Enterprise configuration keys of the unified build (CORP-DSH-PLAN-026 §4.0).
 *
 * One list serves both consumers: `check:repo` admits exactly these names as
 * `secrets.*` references in the release-bundle workflow, and the employee
 * package builder turns the mapped environment variables into maker entries.
 * A key missing here can be neither read by the workflow nor injected.
 *
 * `HELUO_IAM_ISSUER` is listed so that setting it is *refused* by name: the
 * issuer comes from the Discovery document, and the maker rejects both keys
 * together. `HELUO_IAM_ALLOW_INSECURE_HTTP` is a maker-side switch that never
 * reaches the patch layer as such; confidential mode writes it as the plugin's
 * `allowInsecureClientAuthHttp`. `HELUO_IAM_CLIENT_SECRET` never enters the
 * patch layer: it travels beside the plugin tarball for first-run provisioning.
 * Nacos configuration belongs to the standalone Skill Manager package builder;
 * the employee build neither maps nor reads those environment variables.
 */
export const RELEASE_CONFIG_KEYS = Object.freeze([
  'HELUO_IAM_AUTH_MODE',
  'HELUO_IAM_ISSUER',
  'HELUO_IAM_DISCOVERY_URL',
  'HELUO_IAM_REVOCATION_ENDPOINT',
  'HELUO_IAM_CLIENT_ID',
  'HELUO_IAM_SCOPES',
  'HELUO_IAM_CALLBACK_PORT',
  'HELUO_IAM_CALLBACK_ADDRESS',
  'HELUO_IAM_MANAGED_MODELS_BASE_URL',
  'HELUO_IAM_DEFAULT_PROVIDER',
  'HELUO_IAM_ALLOW_INSECURE_HTTP',
  'HELUO_IAM_CLIENT_AUTH_METHOD',
  'HELUO_IAM_CLIENT_SECRET_REF',
  'HELUO_IAM_CLIENT_SECRET',
]);

/** The runner token: the only secret the workflow may map that is not configuration. */
export const RELEASE_TOKEN_SECRET = 'GITHUB_TOKEN';

export function isReleaseSecret(name) {
  return name === RELEASE_TOKEN_SECRET || RELEASE_CONFIG_KEYS.includes(name);
}

/**
 * Render the mapped environment in the `.env` text format the maker parses.
 *
 * Unset and empty variables are skipped, so a packager who has not configured
 * an optional key needs no placeholder. Keys outside the list are ignored by
 * construction: they cannot be mapped into the workflow in the first place.
 * A value with a line break becomes a second, malformed line and is refused by
 * the maker's parser under the key's name, never with the value.
 */
export function configTextFromEnv(env) {
  const lines = [];
  for (const key of RELEASE_CONFIG_KEYS) {
    const value = env[key];
    if (typeof value !== 'string' || value === '') continue;
    lines.push(`${key}=${value}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
