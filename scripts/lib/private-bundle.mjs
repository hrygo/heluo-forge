/**
 * Private-release maker (issue #222 work items ④ and ⑦).
 *
 * The maker runs on a release engineer's machine from a *downloaded* public
 * tarball, never from this source checkout. Its only jobs are:
 *
 *   1. prove the public input is the one the engineer expects (an expected digest
 *      supplied through a trusted channel, not a digest read next to the file);
 *   2. read the enterprise `.env` as **data** -- no shell, no `eval`, no whole-file
 *      substitution into the artifact;
 *   3. change exactly two documented locations inside the package
 *      (`cordis.patch.yml` plugin config and `package.json` version) plus add a
 *      redacted `heluo-private-release.json`;
 *   4. rebuild the archive from the original bytes and recompute the manifest.
 *
 * Confidential client secrets are deliberately NOT accepted yet: the IAM plugin
 * has no approved bundle-backed secret source (issue #222 work item ⑨), and
 * writing a secret into `cordis.patch.yml` would either be ignored or unlock
 * nothing. Refusing is the honest failure; see `BUNDLE_SECRET_EMBED_UNSUPPORTED`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isConfigured, validateConfig } from '../../packages/forge-iam/src/config.mjs';

import { verifyBundle } from '../verify-enterprise-bundle.mjs';
import { readBundleEntries } from './bundle-archive.mjs';
import { createBundleManifest, serializeBundleManifest, serializeSha256Sums } from './bundle-manifest.mjs';
import { writeBundleTarball } from './bundle-write.mjs';
import { assertOutsideDirectory, atomicWrite, parseDigest, safeRelativePath, scanReleaseFiles, scanText, sha256, stableJson } from './release-support.mjs';

export const PRIVATE_SCHEMA = 'heluo-private-release/1';
export const PRIVATE_METADATA_FILE = 'heluo-private-release.json';
export const TOOL_NAME = 'heluo-forge-release-tools';
export const TOOL_VERSION = '1.0.0';
export const SUPPORTED_PLATFORMS = Object.freeze(['windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64']);
export const IAM_VALIDATOR_MODULES = Object.freeze(['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs']);

export class PrivateBundleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PrivateBundleError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new PrivateBundleError(code, message, details);
};

/**
 * Enterprise `.env` keys -> IAM patch config keys.
 *
 * The table is the schema: an unknown `HELUO_` key is an error, not something
 * silently ignored, because a typo would otherwise ship a bundle that looks
 * configured but runs with public-auth defaults.
 */
export const IAM_ENV_MAP = Object.freeze({
  HELUO_IAM_AUTH_MODE: 'authMode',
  HELUO_IAM_ISSUER: 'issuer',
  HELUO_IAM_DISCOVERY_URL: 'discoveryUrl',
  HELUO_IAM_AUTHORIZATION_ENDPOINT: 'authorizationEndpoint',
  HELUO_IAM_TOKEN_ENDPOINT: 'tokenEndpoint',
  HELUO_IAM_JWKS_URI: 'jwksUri',
  HELUO_IAM_REVOCATION_ENDPOINT: 'revocationEndpoint',
  HELUO_IAM_END_SESSION_ENDPOINT: 'endSessionEndpoint',
  HELUO_IAM_USERINFO_ENDPOINT: 'userInfoEndpoint',
  HELUO_IAM_CLIENT_ID: 'clientId',
  HELUO_IAM_CLIENT_AUTH_METHOD: 'clientAuthMethod',
  HELUO_IAM_CLIENT_SECRET_REF: 'clientSecretRef',
  HELUO_IAM_SCOPES: 'scopes',
  HELUO_IAM_REDIRECT_PATH: 'redirectPath',
  HELUO_IAM_CALLBACK_PORT: 'callbackPort',
  HELUO_IAM_CALLBACK_ADDRESS: 'callbackAddress',
  HELUO_IAM_POST_LOGOUT_REDIRECT_URI: 'postLogoutRedirectUri',
  HELUO_IAM_GATEWAY_RESOURCE: 'gatewayResource',
  HELUO_IAM_GATEWAY_CONSOLE_URL: 'gatewayConsoleUrl',
  HELUO_IAM_DEFAULT_PROVIDER: 'defaultProvider',
  HELUO_IAM_DEFAULT_MODEL: 'defaultModel',
  HELUO_IAM_MANAGED_MODELS_BASE_URL: 'managedModels.baseURL',
  HELUO_IAM_ALLOW_INSECURE_HTTP: 'allowInsecureHttp',
});

export const GITEE_ENV_MAP = Object.freeze({
  HELUO_GITEE_CLI_PATH: 'cliPath',
  HELUO_GITEE_HOST: 'host',
  HELUO_GITEE_TIMEOUT_MS: 'timeoutMs',
  HELUO_GITEE_AUTH_ENV: 'authEnv',
  HELUO_GITEE_PERSISTENT_TOKEN: 'persistentToken',
});

/** Secret-bearing names are recognized so the maker can refuse them explicitly. */
export const SECRET_ENV_KEYS = Object.freeze(['HELUO_IAM_CLIENT_SECRET', 'HELUO_IAM_CLIENT_SECRET_FILE']);

const ALL_KEYS = new Set([...Object.keys(IAM_ENV_MAP), ...Object.keys(GITEE_ENV_MAP), ...SECRET_ENV_KEYS]);
const INTEGER_KEYS = new Set(['HELUO_IAM_CALLBACK_PORT', 'HELUO_GITEE_TIMEOUT_MS']);
const BOOLEAN_KEYS = new Set(['HELUO_IAM_ALLOW_INSECURE_HTTP']);
// Mirror the plugin's callbackAddress enum. `auto` tries 127.0.0.1 first and
// only falls back to ::1 when that family is missing; a pinned literal is used
// verbatim. `localhost` is not a host the IAM prefix covers, and the bracketed
// `[::1]` form only appears inside a redirect URI, never as the bind address.
const CALLBACK_ADDRESSES = new Set(['auto', '127.0.0.1', '::1']);

// Mirrors of packages/forge-gitee/src/runtime-config.mjs. The maker bakes these
// values into `cordis.patch.yml`, so a value the plugin refuses at load time has
// to be refused here: otherwise the release "succeeds" and the Gitee capability
// silently never loads on the employee's machine.
const GITEE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/u;
const GITEE_HOST_MAX_LENGTH = 253;
const GITEE_MAX_AUTH_ENV = 8;
const GITEE_CLI_PATH_MAX_LENGTH = 4096;
const GITEE_SCHEME_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const GITEE_WRAPPER_SUFFIXES = Object.freeze(['.cmd', '.bat', '.ps1', '.com', '.vbs']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/**
 * Mirror of `isConfigured` in packages/forge-iam/src/config.mjs, plus the one
 * deliberate difference issue #254 requires: the private bundle must pin its
 * trust anchor, so a discovery URL alone is not "configured" here. Without an
 * explicit issuer the maker would adopt whatever the discovery document claims,
 * which is the trust decision this artifact exists to fix in advance.
 */
export function isLoginConfigured(iam) {
  if (typeof iam?.clientId !== 'string' || iam.clientId.trim() === '') return false;
  // The plugin's own validator decides whether the rest of the config is usable
  // at load time; re-implementing that rule here is what let the maker ship a
  // bundle the plugin refused (issue #254 item 7).
  const validated = validateConfig(iam);
  if (validated.issues || !isConfigured(validated.value).ok) return false;
  // On top of the runtime contract, the private bundle pins its trust anchor:
  // a discovery URL alone is "configured" for the plugin but never "ready" for
  // this artifact, because the only issuer would be the document itself
  // (issue #254 item 8).
  return typeof validated.value.issuer === 'string' && validated.value.issuer.trim() !== '';
}

export const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Fetch the IAM Discovery document and check that it agrees with the enterprise
 * config the maker is about to bake into the private bundle.
 *
 * Two rules come from the runtime, not from taste:
 *
 *   - the configured issuer is the trust target. `packages/forge-iam/src/oidc.mjs`
 *     compares `config.issuer !== document.issuer` strictly, so the maker uses
 *     the same exact comparison; tolerating a trailing slash here produced a
 *     bundle that installed and then failed login with
 *     `IAM_DISCOVERY_ISSUER_MISMATCH` (issue #254 item 9);
 *   - a missing issuer is a refusal, never "nothing to check" (item 8): the
 *     discovery document is data, not an authority.
 *
 * The result is redacted on purpose (item 10). It is printed into terminals,
 * assistant context and `private-release.json`, so it carries no issuer and no
 * endpoint value: only whether the check ran, which configured fields matched,
 * and where revocation came from (`configured` / `discovered` / `missing`).
 */
export async function verifyDiscovery(iam, { fetchImpl = globalThis.fetch, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  if (typeof iam?.issuer !== 'string' || iam.issuer.trim() === '') {
    fail(
      'DISCOVERY_ISSUER_REQUIRED',
      'HELUO_IAM_ISSUER must be configured: the discovery document is not a trust anchor, so the private bundle pins the trusted issuer explicitly',
    );
  }
  if (typeof iam.discoveryUrl !== 'string' || iam.discoveryUrl.trim() === '') {
    return { checked: false, reason: 'no-discovery-url' };
  }
  if (typeof fetchImpl !== 'function') {
    fail('DISCOVERY_UNAVAILABLE', 'this Node.js runtime has no fetch; upgrade Node.js or pass --skip-discovery-check');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(iam.discoveryUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    const safeCodes = new Set([
      'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
      'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
      'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
    ]);
    const code = error?.cause?.code;
    const reason = error?.name === 'AbortError' ? 'timed out' : (safeCodes.has(code) ? code : 'network request failed');
    fail('DISCOVERY_UNREACHABLE', `discovery request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) fail('DISCOVERY_HTTP', `discovery endpoint returned HTTP ${response.status}`);
  let document;
  try {
    document = await response.json();
  } catch {
    fail('DISCOVERY_INVALID', 'discovery response is not valid JSON');
  }
  if (typeof document?.issuer !== 'string' || document.issuer.trim() === '') {
    fail('DISCOVERY_INVALID', 'discovery document has no issuer');
  }
  if (!isHttpUrl(document.issuer, { allowInsecureHttp: iam.allowInsecureHttp === true })) {
    fail('DISCOVERY_INVALID', 'discovery issuer is not an allowed URL');
  }
  // Exact comparison, same as the runtime (`config.issuer !== document.issuer` in
  // packages/forge-iam/src/oidc.mjs): a trailing-slash difference is a real
  // mismatch, not something to normalize away (issue #254 item 9). The guard
  // above already refused an empty configured issuer (item 8).
  if (document.issuer !== iam.issuer) {
    fail('DISCOVERY_ISSUER_MISMATCH', 'discovery issuer does not exactly match the configured issuer');
  }
  const matched = ['issuer'];
  const endpoints = {};
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const value = document[key];
    if (typeof value !== 'string' || value.trim() === '') fail('DISCOVERY_INVALID', `discovery document has no ${key}`);
    if (!isHttpUrl(value, { allowInsecureHttp: iam.allowInsecureHttp === true })) {
      fail('DISCOVERY_INVALID', `${key} is not an allowed URL`);
    }
    endpoints[key] = value;
  }
  const mapping = { authorizationEndpoint: 'authorization_endpoint', tokenEndpoint: 'token_endpoint', jwksUri: 'jwks_uri' };
  for (const [field, key] of Object.entries(mapping)) {
    if (typeof iam[field] !== 'string') continue;
    if (iam[field] !== endpoints[key]) fail('DISCOVERY_ENDPOINT_MISMATCH', `configured ${field} does not match discovery ${key}`);
    matched.push(field);
  }
  for (const [field, key] of Object.entries({ revocationEndpoint: 'revocation_endpoint', endSessionEndpoint: 'end_session_endpoint', userInfoEndpoint: 'userinfo_endpoint' })) {
    if (!iam[field] && document[key] && !isHttpUrl(document[key], { allowInsecureHttp: iam.allowInsecureHttp === true })) {
      fail('DISCOVERY_INVALID', `${key} is not an allowed URL`);
    }
  }
  const revocationEndpoint = iam.revocationEndpoint ? 'configured' : (document.revocation_endpoint ? 'discovered' : 'missing');
  return { checked: true, matched, revocationEndpoint };
}

/** Parse one `.env` file strictly. No `export`, no escapes, no continuation lines. */
export function parseEnvConfig(text) {
  if (typeof text !== 'string') fail('CONFIG_INVALID', 'configuration must be text');
  const entries = [];
  const seen = new Set();
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/u, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^export\s/u.test(trimmed)) {
      fail('CONFIG_INVALID', `.env line ${index + 1}: "export" is not accepted; write KEY=VALUE so the file is parsed as data`);
    }
    const equals = trimmed.indexOf('=');
    if (equals <= 0) fail('CONFIG_INVALID', `.env line ${index + 1}: expected KEY=VALUE`);
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) fail('CONFIG_INVALID', `.env line ${index + 1}: invalid key name`);
    if (seen.has(key)) fail('CONFIG_INVALID', `.env line ${index + 1}: duplicate key "${key}"`);
    seen.add(key);
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value.includes('$(') || value.includes('${') || value.includes('`')) {
      fail('CONFIG_INVALID', `.env line ${index + 1}: command/expansion syntax is not accepted in "${key}"`);
    }
    if (value.includes('\0')) fail('CONFIG_INVALID', `.env line ${index + 1}: NUL byte in "${key}"`);
    entries.push({ key, value, line: index + 1 });
  }
  if (entries.length === 0) fail('CONFIG_EMPTY', 'configuration contains no KEY=VALUE entries');
  for (const entry of entries) {
    if (!ALL_KEYS.has(entry.key)) {
      fail('CONFIG_UNKNOWN_KEY', `.env line ${entry.line}: unknown key "${entry.key}" (refusing to guess where it belongs)`);
    }
    if (SECRET_ENV_KEYS.includes(entry.key)) {
      fail(
        'BUNDLE_SECRET_EMBED_UNSUPPORTED',
        `${entry.key} must not be written into a bundle yet: forge-iam has no approved bundle-backed client-secret source (issue #222 item 9). Keep the secret in the installer/credential backend and do not place it in this file.`,
      );
    }
  }
  return entries;
}

function isHttpUrl(value, { allowInsecureHttp = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && allowInsecureHttp;
}

/**
 * Mirror of the plugin's `redirectPath` rules. The value becomes both the
 * callback path and part of the redirect URI the IAM server registers, so a
 * shape the plugin rejects must never reach a private bundle.
 */
function redirectPathProblem(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return 'HELUO_IAM_REDIRECT_PATH must start with /';
  let parsed;
  try {
    parsed = new URL(value, 'https://callback.invalid');
  } catch {
    return 'HELUO_IAM_REDIRECT_PATH must be an absolute path without query or fragment';
  }
  if (parsed.pathname !== value || parsed.search !== '' || parsed.hash !== '') {
    return 'HELUO_IAM_REDIRECT_PATH must be an absolute path without query or fragment';
  }
  if (value !== '/' && value.endsWith('/')) return 'HELUO_IAM_REDIRECT_PATH must not end with /';
  if (value === '/') return 'HELUO_IAM_REDIRECT_PATH must not be the site root';
  if (value === '/api/forge-iam' || value.startsWith('/api/forge-iam/')) return 'HELUO_IAM_REDIRECT_PATH must not overlap /api/forge-iam';
  return null;
}

/**
 * Convert parsed entries into the two patch config objects, applying the same
 * constraints the plugins apply at load time. The maker validates *before*
 * writing, so an invalid private bundle never reaches a delivery directory.
 */
export function buildConfig(entries) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
  const allowInsecureHttp = byKey.get('HELUO_IAM_ALLOW_INSECURE_HTTP') === 'true';
  const iam = {};
  const gitee = {};
  const problems = [];
  const put = (target, key, value) => {
    if (value !== undefined && value !== '') target[key] = value;
  };
  for (const [envKey, field] of Object.entries(IAM_ENV_MAP)) {
    const raw = byKey.get(envKey);
    if (raw === undefined) continue;
    if (INTEGER_KEYS.has(envKey)) {
      if (!/^\d+$/u.test(raw)) problems.push(`${envKey} must be a non-negative integer`);
      else put(iam, field, Number(raw));
      continue;
    }
    if (BOOLEAN_KEYS.has(envKey)) {
      if (raw !== 'true' && raw !== 'false') problems.push(`${envKey} must be true or false`);
      else put(iam, field, raw === 'true');
      continue;
    }
    if (envKey === 'HELUO_IAM_SCOPES') {
      const scopes = raw.split(/[,\s]+/u).filter(Boolean);
      // The plugin refuses a scope list without `openid` (the flow verifies an
      // ID token), so shipping one would make the IAM capability fail to load.
      if (scopes.length === 0) problems.push('HELUO_IAM_SCOPES must list at least one scope');
      else if (!scopes.includes('openid')) problems.push('HELUO_IAM_SCOPES must include openid');
      else put(iam, field, scopes);
      continue;
    }
    if (envKey === 'HELUO_IAM_MANAGED_MODELS_BASE_URL') {
      if (!isHttpUrl(raw, { allowInsecureHttp })) problems.push(`${envKey} must be an https URL, or http with HELUO_IAM_ALLOW_INSECURE_HTTP=true`);
      else iam.managedModels = { baseURL: raw.replace(/\/+$/u, '') };
      continue;
    }
    put(iam, field, raw);
  }
  for (const [envKey, field] of Object.entries(GITEE_ENV_MAP)) {
    const raw = byKey.get(envKey);
    if (raw === undefined) continue;
    if (envKey === 'HELUO_GITEE_TIMEOUT_MS') {
      if (!/^\d+$/u.test(raw) || Number(raw) < 1000 || Number(raw) > 600000) problems.push(`${envKey} must be an integer between 1000 and 600000`);
      else gitee[field] = Number(raw);
      continue;
    }
    if (envKey === 'HELUO_GITEE_AUTH_ENV') {
      const names = raw.split(/[,\s]+/u).filter(Boolean);
      if (names.length > GITEE_MAX_AUTH_ENV) problems.push(`HELUO_GITEE_AUTH_ENV must name at most ${GITEE_MAX_AUTH_ENV} environment variables`);
      else if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) problems.push('HELUO_GITEE_AUTH_ENV must be comma-separated environment variable names');
      else gitee[field] = [...new Set(names)];
      continue;
    }
    if (envKey === 'HELUO_GITEE_PERSISTENT_TOKEN') {
      if (!['warn', 'block'].includes(raw)) problems.push('HELUO_GITEE_PERSISTENT_TOKEN must be warn or block');
      else gitee[field] = raw;
      continue;
    }
    if (envKey === 'HELUO_GITEE_HOST') {
      // Hostname only, optional port. The plugin lowercases and refuses a scheme,
      // a path or credentials, so `https://gitee.corp.example` is a release that
      // cannot load (issue #254 item 7).
      const host = raw.toLowerCase();
      if (host.length > GITEE_HOST_MAX_LENGTH || !GITEE_HOST.test(host)) {
        problems.push('HELUO_GITEE_HOST must be a bare hostname with an optional port (for example gitee.corp.example); no scheme, path or credentials');
      } else gitee[field] = host;
      continue;
    }
    if (envKey === 'HELUO_GITEE_CLI_PATH') {
      const lower = raw.toLowerCase();
      const wrapper = GITEE_WRAPPER_SUFFIXES.find((suffix) => lower.endsWith(suffix));
      if (raw.length > GITEE_CLI_PATH_MAX_LENGTH) problems.push(`HELUO_GITEE_CLI_PATH must be at most ${GITEE_CLI_PATH_MAX_LENGTH} characters`);
      else if (CONTROL_CHARS.test(raw)) problems.push('HELUO_GITEE_CLI_PATH must not contain control characters');
      else if (raw.startsWith('-')) problems.push('HELUO_GITEE_CLI_PATH must not start with a hyphen (it would be read as a flag)');
      else if (GITEE_SCHEME_LIKE.test(raw)) problems.push('HELUO_GITEE_CLI_PATH must be an executable name or path, not a URL');
      else if (wrapper !== undefined) problems.push(`HELUO_GITEE_CLI_PATH must not be a ${wrapper} wrapper script`);
      else gitee[field] = raw;
      continue;
    }
    put(gitee, field, raw);
  }

  const mode = iam.authMode ?? 'public';
  if (!['public', 'confidential'].includes(mode)) problems.push('HELUO_IAM_AUTH_MODE must be public or confidential');
  if (mode === 'public') {
    if (iam.clientAuthMethod !== undefined && iam.clientAuthMethod !== 'none') problems.push('public authentication only permits clientAuthMethod=none');
    if (iam.clientSecretRef !== undefined) problems.push('public authentication must not contain HELUO_IAM_CLIENT_SECRET_REF');
  } else {
    if (!['client_secret_basic', 'client_secret_post'].includes(iam.clientAuthMethod)) problems.push('confidential authentication requires HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_basic|client_secret_post');
    if (typeof iam.clientSecretRef !== 'string' || iam.clientSecretRef.trim() === '') problems.push('confidential authentication requires HELUO_IAM_CLIENT_SECRET_REF');
    problems.push('confidential authentication is not supported by this maker yet (issue #222 item 9: no approved bundle-backed secret source)');
  }
  for (const field of ['issuer', 'discoveryUrl', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri', 'revocationEndpoint', 'endSessionEndpoint', 'userInfoEndpoint', 'gatewayConsoleUrl']) {
    const value = iam[field];
    if (value === undefined) continue;
    if (!isHttpUrl(value, { allowInsecureHttp })) problems.push(`HELUO_IAM_${field.replace(/[A-Z]/gu, (letter) => `_${letter}`).toUpperCase()} must be an https URL (or http with HELUO_IAM_ALLOW_INSECURE_HTTP=true) without userinfo/query/hash`);
  }
  if (iam.gatewayResource !== undefined && (typeof iam.gatewayResource !== 'string' || iam.gatewayResource.trim() === '')) problems.push('HELUO_IAM_GATEWAY_RESOURCE must be a non-empty string');
  if (iam.redirectPath !== undefined) {
    const problem = redirectPathProblem(iam.redirectPath);
    if (problem !== null) problems.push(problem);
  }
  // The trust anchor is not optional (issue #254 item 8): with a discovery URL
  // alone the maker would have to adopt whatever issuer the document claims.
  if (typeof iam.issuer !== 'string' || iam.issuer.trim() === '') {
    problems.push('HELUO_IAM_ISSUER is required: the private bundle pins the trusted issuer instead of adopting the discovery document');
  }
  if (iam.callbackAddress !== undefined && !CALLBACK_ADDRESSES.has(iam.callbackAddress)) {
    problems.push('HELUO_IAM_CALLBACK_ADDRESS must be auto, 127.0.0.1 or ::1 (localhost and [::1] are not accepted)');
  }
  // 0 asks the plugin for an OS-assigned loopback port, which is the production
  // form: IAM registers the `http://127.0.0.1:` prefix and accepts any port. A
  // pinned port is only for an authorisation server that demands an exact
  // registered URI, so the maker must accept both and keep the plugin's floor.
  if (iam.callbackPort !== undefined && iam.callbackPort !== 0 && (iam.callbackPort < 1024 || iam.callbackPort > 65535)) {
    problems.push('HELUO_IAM_CALLBACK_PORT must be 0 (OS-assigned) or between 1024 and 65535');
  }
  if (iam.managedModels !== undefined && (typeof iam.defaultProvider !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(iam.defaultProvider))) {
    problems.push('HELUO_IAM_DEFAULT_PROVIDER must be an exact route ID when managed models are configured');
  }
  // Run the actual IAM schema shipped with this toolchain; do not mirror its
  // evolving scopes, callback and managed-model constraints in a second schema.
  // Report only known field names, never issue messages that may contain values.
  const runtime = validateConfig(iam);
  if (runtime.issues) {
    const fields = new Set(runtime.issues.map((item) => item.path?.[0]).filter((field) => Object.values(IAM_ENV_MAP).includes(field)));
    problems.push(`IAM runtime validation rejected ${fields.size > 0 ? [...fields].sort().join(', ') : 'configuration'}`);
  }
  if (problems.length > 0) fail('CONFIG_INVALID', `configuration is invalid:\n- ${problems.join('\n- ')}`);
  if (!isLoginConfigured(iam)) {
    fail('CONFIG_INVALID', 'configuration is invalid:\n- IAM login is incomplete: set HELUO_IAM_ISSUER plus HELUO_IAM_DISCOVERY_URL (preferred) or HELUO_IAM_AUTHORIZATION_ENDPOINT, HELUO_IAM_TOKEN_ENDPOINT and HELUO_IAM_JWKS_URI');
  }

  return {
    iam,
    gitee,
    keys: [
      ...Object.keys(iam).map((key) => `iam.${key}`),
      ...Object.keys(gitee).map((key) => `gitee.${key}`),
    ].sort(),
  };
}

/** Only double-quoted JSON strings are emitted; JSON escapes are valid YAML scalars. */
function emitScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  fail('PATCH_EMIT_INVALID', `config value of type ${typeof value} is not supported`);
}

function emitMapping(object, indent) {
  const lines = [];
  for (const [key, value] of Object.entries(object)) {
    if (!/^[A-Za-z0-9_.-]+$/u.test(key)) fail('PATCH_EMIT_INVALID', `config key "${key}" cannot be emitted safely`);
    if (Array.isArray(value)) {
      lines.push(`${' '.repeat(indent)}${key}:`);
      for (const item of value) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const nested = emitMapping(item, indent + 4);
          lines.push(`${' '.repeat(indent + 2)}- ${nested[0].trimStart()}`);
          lines.push(...nested.slice(1));
        } else {
          lines.push(`${' '.repeat(indent + 2)}- ${emitScalar(item)}`);
        }
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      lines.push(`${' '.repeat(indent)}${key}:`);
      lines.push(...emitMapping(value, indent + 2));
      continue;
    }
    lines.push(`${' '.repeat(indent)}${key}: ${emitScalar(value)}`);
  }
  return lines;
}

/** Replace (or add) `config:` for one `- id:` entry inside the insert list. */
export function injectPatchConfig(text, id, config) {
  if (typeof text !== 'string') fail('PATCH_INVALID', 'patch must be text');
  const lines = text.split('\n');
  const idPattern = new RegExp(`^(\\s*)- id: ${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*$`, 'u');
  const index = lines.findIndex((line) => idPattern.test(line));
  if (index === -1) fail('PATCH_INVALID', `patch has no insert entry with id "${id}"`);
  const baseIndent = idPattern.exec(lines[index])[1].length;
  const childIndent = baseIndent + 2;
  let nameIndex = -1;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent < childIndent) break;
    if (indent === childIndent && trimmed.startsWith('name:')) {
      nameIndex = cursor;
      break;
    }
    if (indent === childIndent && trimmed.startsWith('- id:')) break;
  }
  if (nameIndex === -1) fail('PATCH_INVALID', `patch entry "${id}" has no name line to attach config to`);
  let end = nameIndex + 1;
  let configIndex = -1;
  while (end < lines.length) {
    const line = lines[end];
    const trimmed = line.trim();
    if (trimmed === '') {
      end += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < childIndent) break;
    if (indent === childIndent) {
      if (trimmed.startsWith('config:')) configIndex = end;
      else if (!(configIndex !== -1 && end > configIndex)) break;
    }
    end += 1;
  }
  const block = [`${' '.repeat(childIndent)}config:`, ...emitMapping(config, childIndent + 2)];
  if (configIndex !== -1) {
    // Remove the existing config line and every continuation line that belongs to it.
    let stop = configIndex + 1;
    while (stop < lines.length) {
      const line = lines[stop];
      if (line.trim() === '') break;
      if (line.length - line.trimStart().length <= childIndent) break;
      stop += 1;
    }
    lines.splice(configIndex, stop - configIndex, ...block);
  } else {
    lines.splice(nameIndex + 1, 0, ...block);
  }
  return lines.join('\n');
}

/** Public bundles must be configuration-neutral; the check is the acceptance gate. */
export function assertNeutralPatch(text) {
  const problems = [];
  const required = new Set(['heluo-iam', 'forge-devops', 'heluo-gitee']);
  for (const id of ['heluo-credentials-keychain', ...required]) {
    const index = text.split('\n').findIndex((line) => new RegExp(`^\\s*- id: ${id}$`, 'u').test(line));
    if (index === -1) {
      if (required.has(id)) problems.push(`patch has no insert entry "${id}"`);
      continue;
    }
    const lines = text.split('\n');
    const baseIndent = lines[index].length - lines[index].trimStart().length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;
      if (indent < baseIndent + 2) break;
      if (indent === baseIndent + 2 && line.trim().startsWith('config:')) {
        if (line.trim() !== 'config: {}') problems.push(`public bundle entry "${id}" carries a non-empty config`);
      }
    }
  }
  return problems;
}

export function readConfigFile(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    fail('CONFIG_UNREADABLE', 'cannot read configuration file; check that it exists and is accessible');
  }
  if (!stat.isFile()) fail('CONFIG_INVALID', 'configuration path must be a regular file');
  if ((stat.mode & 0o077) !== 0) {
    fail('CONFIG_PERMISSIONS', `configuration file permissions are too broad (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600`);
  }
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail('CONFIG_UNREADABLE', 'cannot read configuration file; check that it exists and is accessible');
  }
}

function membersOf(entries) {
  const members = {};
  let root;
  for (const entry of entries) {
    if (entry.path === 'package.json') {
      try {
        root = JSON.parse(entry.content.toString('utf8'));
      } catch {
        fail('PUBLIC_TARBALL_INVALID', 'package/package.json is not valid JSON');
      }
    }
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/u.exec(entry.path);
    if (match === null) continue;
    try {
      const manifest = JSON.parse(entry.content.toString('utf8'));
      if (typeof manifest.version === 'string') members[manifest.name ?? match[1]] = manifest.version;
    } catch {
      fail('PUBLIC_TARBALL_INVALID', `node_modules/${match[1]}/package.json is not valid JSON`);
    }
  }
  if (root === undefined) fail('PUBLIC_TARBALL_INVALID', 'public tarball has no package/package.json');
  members[root.name] = root.version;
  return { root, members };
}

// Preserve all bytes except CRLF versus LF, which has the same JavaScript
// meaning but may differ between a standalone toolchain and its public bundle.
function normalizeValidatorNewlines(content) {
  return Buffer.from(content.toString('latin1').replace(/\r\n/gu, '\n'), 'latin1');
}

/** Bind the maker's validation code to the runtime inside the public artifact. */
export function assertIamValidatorMatches(entries, { toolRoot } = {}) {
  for (const name of IAM_VALIDATOR_MODULES) {
    const entry = entries.find((item) => item.path === `node_modules/@heluo/forge-iam/src/${name}`);
    const path = toolRoot === undefined
      ? new URL(`../../packages/forge-iam/src/${name}`, import.meta.url)
      : join(toolRoot, 'packages/forge-iam/src', name);
    let expected;
    try {
      expected = readFileSync(path);
    } catch {
      fail('IAM_VALIDATOR_MISMATCH', `IAM runtime validator ${name} is unavailable; use the toolchain paired with the public release`);
    }
    if (!entry?.content || (!expected.equals(entry.content)
      && !normalizeValidatorNewlines(expected).equals(normalizeValidatorNewlines(entry.content)))) {
      fail('IAM_VALIDATOR_MISMATCH', `IAM runtime validator ${name} differs from the public bundle; use the toolchain paired with the public release`);
    }
  }
}

/**
 * Build the private tarball bytes from public entries.
 *
 * @param {{entries: Array<{path: string, content: Buffer, mode: string}>, version: string,
 *   config: {iam: object, gitee: object, keys: string[]}, baseSha256: string, requireVersionChange?: boolean}} input
 */
export function buildPrivateTarball({ entries, version, config, baseSha256, requireVersionChange = true }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    fail('VERSION_INVALID', 'private version must be a semver string with an explicit bump');
  }
  const { root, members } = membersOf(entries);
  if (root.name !== '@heluo/forge-enterprise') fail('PUBLIC_TARBALL_INVALID', `unexpected entry package "${root.name}"`);
  assertIamValidatorMatches(entries);
  if (requireVersionChange && version === root.version) {
    fail('VERSION_UNCHANGED', `private version must differ from the public version ${root.version}: same name+version must mean the same bytes`);
  }
  const patchEntry = entries.find((entry) => entry.path === 'cordis.patch.yml');
  if (patchEntry === undefined) fail('PUBLIC_TARBALL_INVALID', 'public tarball has no cordis.patch.yml');
  const neutral = assertNeutralPatch(patchEntry.content.toString('utf8'));
  if (neutral.length > 0) fail('PUBLIC_TARBALL_INVALID', `public tarball is not configuration-neutral: ${neutral.join('; ')}`);

  const runtimeIam = { ...config.iam };
  // The opt-in controls packaging and Discovery validation only. The runtime
  // ignores this field, so emitting it would falsely imply a runtime guard.
  delete runtimeIam.allowInsecureHttp;
  let patch = injectPatchConfig(patchEntry.content.toString('utf8'), 'heluo-iam', runtimeIam);
  patch = injectPatchConfig(patch, 'heluo-gitee', config.gitee);
  const manifest = { ...root, version };
  // The manifest is generated after the version bump, so its member map must
  // match the rewritten package.json rather than the public base version.
  const releaseMembers = { ...members, [root.name]: version };
  const metadata = {
    schema: PRIVATE_SCHEMA,
    entry: { name: root.name, version },
    base: { version: root.version, tarballSha256: baseSha256 },
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    config: { keys: config.keys, secretEmbedded: false },
  };

  const replaced = new Map([
    ['package.json', Buffer.from(stableJson(manifest), 'utf8')],
    ['cordis.patch.yml', Buffer.from(patch, 'utf8')],
    [PRIVATE_METADATA_FILE, Buffer.from(stableJson(metadata), 'utf8')],
  ]);
  const changed = [...replaced.keys()].sort();
  const files = entries.map((entry) => {
    const body = replaced.get(entry.path) ?? entry.content;
    return { path: entry.path, body, mode: Number.parseInt(entry.mode, 8) };
  });
  for (const [path, body] of replaced) {
    if (!entries.some((entry) => entry.path === path)) files.push({ path, body, mode: 0o644 });
  }
  const tar = writeBundleTarball(files);
  return { tar, patch, manifest, metadata, changed, members: releaseMembers, files };
}

/**
 * Verify artifact bytes with the independent verifier the delivery pipeline
 * already trusts (`scripts/verify-enterprise-bundle.mjs`).
 *
 * The bytes go into a throwaway directory so no sibling `bundle-manifest.json`
 * is picked up by accident: this is a closure check of the artifact itself, not
 * a comparison against a manifest that may belong to a different download.
 */
function assertArtifactClosure(bytes, { code, label }) {
  const work = mkdtempSync(join(tmpdir(), 'heluo-closure-'));
  try {
    const artifact = join(work, 'artifact.tgz');
    writeFileSync(artifact, bytes);
    const verdict = verifyBundle(artifact);
    if (!verdict.ok) fail(code, `${label} failed the artifact closure check:\n- ${verdict.errors.join('\n- ')}`);
    return verdict;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Full maker flow. Returns the written paths and a redacted summary.
 *
 * @param {{publicPath: string, expectedSha256: string, configPath: string, version: string,
 *   output: string, repoRoot?: string, requireVersionChange?: boolean}} input
 */
export function makePrivateBundle(input) {
  const publicPath = resolve(input.publicPath);
  if (!existsSync(publicPath)) fail('PUBLIC_MISSING', `public tarball not found: ${publicPath}`);
  const expected = parseDigest(input.expectedSha256, 'public tarball digest');
  const publicBytes = readFileSync(publicPath);
  const actual = sha256(publicBytes);
  if (actual !== expected) {
    fail('PUBLIC_DIGEST_MISMATCH', `public tarball digest ${actual} does not match the trusted digest ${expected}; do not continue from this file`);
  }
  // A digest proves identity, not completeness: a public tarball with a dropped
  // native addon and a recomputed digest still matches its own digest. The input
  // is checked against the same closure rules as the output (issue #254 item 15).
  assertArtifactClosure(publicBytes, { code: 'PUBLIC_INCOMPLETE', label: 'public tarball' });
  const output = resolve(input.output);
  if (input.repoRoot !== undefined) {
    // Component-wise comparison on the canonical paths; a `..secret` sibling or
    // an out-of-checkout symlink back into the checkout both land here.
    try {
      assertOutsideDirectory(output, resolve(input.repoRoot), 'output');
    } catch {
      fail('OUTPUT_INSIDE_REPO', 'output must be outside the source checkout');
    }
  }
  if (existsSync(output)) {
    const entries = readdirSync(output);
    if (entries.length > 0) fail('OUTPUT_EXISTS', `output directory is not empty: ${output}`);
  }
  const text = readConfigFile(resolve(input.configPath));
  const entries = parseEnvConfig(text);
  const config = buildConfig(entries);
  const privateEntries = readBundleEntries(publicBytes, { withContent: true });
  const built = buildPrivateTarball({
    entries: privateEntries,
    version: input.version,
    config,
    baseSha256: expected,
    requireVersionChange: input.requireVersionChange ?? true,
  });
  const scan = scanReleaseFiles(built.files.map((file) => ({ path: file.path, body: file.body })), { publicOnly: false });
  if (scan.length > 0) fail('ARTIFACT_SENSITIVE', `private artifact failed the sensitive scan:\n- ${scan.join('\n- ')}`);

  const digest = sha256(built.tar);
  const tarName = `${built.manifest.name.slice(1).replace('/', '-')}-${input.version}.tgz`;
  const tarballEntries = built.files.map((file) => {
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8');
    return { path: file.path, size: body.length, sha256: sha256(body), mode: file.mode.toString(8).padStart(4, '0') };
  });
  const manifest = createBundleManifest({
    entry: { name: built.manifest.name, version: input.version },
    members: built.members,
    tarball: { name: tarName, sha256: digest, bytes: built.tar.length },
    entries: tarballEntries,
    toolchain: { node: process.version, npm: 'private-maker' },
  });
  const manifestText = serializeBundleManifest(manifest);
  const sidecar = {
    schema: PRIVATE_SCHEMA,
    entry: built.metadata.entry,
    base: built.metadata.base,
    tool: built.metadata.tool,
    config: built.metadata.config,
    changed: built.changed,
    tarball: { name: tarName, sha256: digest, bytes: built.tar.length },
    manifestSha256: sha256(Buffer.from(manifestText, 'utf8')),
    generatedAt: new Date().toISOString(),
  };
  const sumsText = serializeSha256Sums([
    { name: tarName, sha256: digest },
    { name: 'bundle-manifest.json', sha256: sha256(Buffer.from(manifestText, 'utf8')) },
    { name: 'private-release.json', sha256: sha256(Buffer.from(stableJson(sidecar), 'utf8')) },
  ]);

  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.heluo-private-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(staging, tarName), built.tar);
    writeFileSync(join(staging, 'bundle-manifest.json'), manifestText);
    writeFileSync(join(staging, 'private-release.json'), stableJson(sidecar));
    writeFileSync(join(staging, 'SHA256SUMS'), sumsText);
    // Success is reported only for bytes that were verified as written: the same
    // independent verifier, against the manifest generated next to them.
    const verdict = verifyBundle(join(staging, tarName), { manifestPath: join(staging, 'bundle-manifest.json') });
    if (!verdict.ok) fail('ARTIFACT_VERIFY_FAILED', `private artifact failed verification:\n- ${verdict.errors.join('\n- ')}`);
    if (existsSync(output)) rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    output,
    tarball: join(output, tarName),
    sha256: digest,
    version: input.version,
    base: built.metadata.base,
    changed: built.changed,
    configKeys: built.metadata.config.keys,
    manifest: join(output, 'bundle-manifest.json'),
    release: join(output, 'private-release.json'),
    verified: true,
  };
}

/** Plan digest binds confirmation to the actual inputs without exposing values. */
export function planDigest({ publicSha256, version, config, platforms }) {
  const canonical = JSON.stringify({
    publicSha256,
    version,
    config,
    platforms: [...platforms].sort(),
  });
  return sha256(Buffer.from(canonical, 'utf8'));
}

export function safeConfigSummary(config) {
  return { keys: config.keys, values: undefined };
}

/** Used by tests and by the CLI's "public input" preflight. */
export function inspectPublicTarball(publicPath) {
  const bytes = readFileSync(publicPath);
  const entries = readBundleEntries(bytes, { withContent: true });
  const { root } = membersOf(entries);
  assertIamValidatorMatches(entries);
  const patch = entries.find((entry) => entry.path === 'cordis.patch.yml');
  const problems = scanReleaseFiles(entries.map((entry) => ({ path: entry.path, body: entry.content })), { publicOnly: true });
  if (patch !== undefined) problems.push(...assertNeutralPatch(patch.content.toString('utf8')));
  return { sha256: sha256(bytes), version: root.version, name: root.name, files: entries.length, problems };
}

export { scanText };
