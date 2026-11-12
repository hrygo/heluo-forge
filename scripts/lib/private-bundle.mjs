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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { readBundleEntries } from './bundle-archive.mjs';
import { createBundleManifest, serializeBundleManifest, serializeSha256Sums } from './bundle-manifest.mjs';
import { writeBundleTarball } from './bundle-write.mjs';
import { atomicWrite, parseDigest, safeRelativePath, scanReleaseFiles, scanText, sha256, stableJson } from './release-support.mjs';

export const PRIVATE_SCHEMA = 'heluo-private-release/1';
export const PRIVATE_METADATA_FILE = 'heluo-private-release.json';
export const TOOL_NAME = 'heluo-forge-release-tools';
export const TOOL_VERSION = '1.0.0';
export const SUPPORTED_PLATFORMS = Object.freeze(['windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64']);

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

/** Parse one `.env` file strictly. No `export`, no escapes, no continuation lines. */
/**
 * Mirror of `isConfigured` in packages/forge-iam/src/config.mjs: the maker must
 * reject a release that the plugin would treat as unconfigured. Keep the two in
 * step; a package that installs but cannot start enterprise login is a failed
 * delivery, not a success.
 */
export function isLoginConfigured(iam) {
  if (typeof iam?.clientId !== 'string' || iam.clientId.trim() === '') return false;
  if (typeof iam.discoveryUrl === 'string' && iam.discoveryUrl.trim() !== '') return true;
  return ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri'].every(
    (key) => typeof iam[key] === 'string' && iam[key].trim() !== '',
  );
}

export const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Fetch the IAM Discovery document and check that it agrees with the enterprise
 * config the maker is about to bake into the private bundle. A package that
 * installs but cannot complete login is a failed delivery, so this runs before
 * anything is written. Offline packagers must opt out explicitly.
 */
export async function verifyDiscovery(iam, { fetchImpl = globalThis.fetch, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  if (typeof iam?.discoveryUrl !== 'string' || iam.discoveryUrl.trim() === '') {
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
    const aborted = error?.name === 'AbortError';
    const reason = aborted ? `timed out after ${timeoutMs} ms` : String(error?.cause?.code ?? error?.message ?? error);
    fail('DISCOVERY_UNREACHABLE', `cannot fetch ${iam.discoveryUrl}: ${reason}`);
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
  const sameUrl = (left, right) => left.replace(/\/+$/u, '') === right.replace(/\/+$/u, '');
  if (typeof iam.issuer === 'string' && iam.issuer.trim() !== '' && !sameUrl(document.issuer, iam.issuer)) {
    fail('DISCOVERY_ISSUER_MISMATCH', `discovery issuer ${document.issuer} does not match configured issuer ${iam.issuer}`);
  }
  const endpoints = {};
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const value = document[key];
    if (typeof value !== 'string' || value.trim() === '') fail('DISCOVERY_INVALID', `discovery document has no ${key}`);
    if (!isHttpUrl(value, { allowInsecureHttp: iam.allowInsecureHttp === true })) {
      fail('DISCOVERY_INVALID', `${key} is not an allowed URL: ${value}`);
    }
    endpoints[key] = value;
  }
  const mapping = { authorizationEndpoint: 'authorization_endpoint', tokenEndpoint: 'token_endpoint', jwksUri: 'jwks_uri' };
  for (const [field, key] of Object.entries(mapping)) {
    if (typeof iam[field] === 'string' && !sameUrl(iam[field], endpoints[key])) {
      fail('DISCOVERY_ENDPOINT_MISMATCH', `configured ${field} does not match discovery ${key}`);
    }
  }
  return { checked: true, issuer: document.issuer, endpoints };
}

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
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) fail('CONFIG_INVALID', `.env line ${index + 1}: invalid key name "${key}"`);
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
      if (scopes.length === 0) problems.push('HELUO_IAM_SCOPES must list at least one scope');
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
      if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) problems.push(`${envKey} must be comma-separated environment variable names`);
      else gitee[field] = names;
      continue;
    }
    if (envKey === 'HELUO_GITEE_PERSISTENT_TOKEN') {
      if (!['warn', 'block'].includes(raw)) problems.push(`${envKey} must be warn or block`);
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
  if (iam.redirectPath !== undefined && !iam.redirectPath.startsWith('/')) problems.push('HELUO_IAM_REDIRECT_PATH must start with /');
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
  if (problems.length > 0) fail('CONFIG_INVALID', `configuration is invalid:\n- ${problems.join('\n- ')}`);
  if (!isLoginConfigured(iam)) {
    fail('CONFIG_INVALID', 'configuration is invalid:\n- IAM login is incomplete: set HELUO_IAM_DISCOVERY_URL (preferred) or all of HELUO_IAM_ISSUER, HELUO_IAM_AUTHORIZATION_ENDPOINT, HELUO_IAM_TOKEN_ENDPOINT and HELUO_IAM_JWKS_URI');
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

function readConfigFile(path) {
  const stat = statSync(path);
  if (!stat.isFile()) fail('CONFIG_INVALID', 'configuration path must be a regular file');
  if ((stat.mode & 0o077) !== 0) {
    fail('CONFIG_PERMISSIONS', `configuration file permissions are too broad (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600`);
  }
  return readFileSync(path, 'utf8');
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
  if (requireVersionChange && version === root.version) {
    fail('VERSION_UNCHANGED', `private version must differ from the public version ${root.version}: same name+version must mean the same bytes`);
  }
  const patchEntry = entries.find((entry) => entry.path === 'cordis.patch.yml');
  if (patchEntry === undefined) fail('PUBLIC_TARBALL_INVALID', 'public tarball has no cordis.patch.yml');
  const neutral = assertNeutralPatch(patchEntry.content.toString('utf8'));
  if (neutral.length > 0) fail('PUBLIC_TARBALL_INVALID', `public tarball is not configuration-neutral: ${neutral.join('; ')}`);

  let patch = injectPatchConfig(patchEntry.content.toString('utf8'), 'heluo-iam', config.iam);
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
  const output = resolve(input.output);
  if (input.repoRoot !== undefined) {
    const repo = resolve(input.repoRoot);
    if (output === repo || output.startsWith(`${repo}/`)) fail('OUTPUT_INSIDE_REPO', 'output must be outside the source checkout');
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
  const patch = entries.find((entry) => entry.path === 'cordis.patch.yml');
  const problems = scanReleaseFiles(entries.map((entry) => ({ path: entry.path, body: entry.content })), { publicOnly: true });
  if (patch !== undefined) problems.push(...assertNeutralPatch(patch.content.toString('utf8')));
  return { sha256: sha256(bytes), version: root.version, name: root.name, files: entries.length, problems };
}

export { scanText };
