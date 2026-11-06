import { validateManagedModels } from './managed-models.mjs';

// Cordis 用 standard-schema 校验插件配置：Config['~standard'].validate(config)
// 必须同步返回 { value } 或 { issues }。这里不依赖外部校验库，保持包骨架可在
// 没有 DSH 运行时的环境下测试。

// Authentication configuration is a tagged union. This schema alone never
// supplies a secret or enables the staged confidential service implementation.
const FORBIDDEN_AUTH_FIELDS = [
  'clientSecret', 'client_secret', 'Authorization', 'authorization', 'headers', 'body',
  'authorizationHeader', 'tokenHeaders', 'tokenBody', 'clientAuthBody', 'clientAuthentication',
  'pkce', 'pkceMethod', 'codeChallengeMethod', 'code_challenge_method', 'disablePkce',
];

export const CONFIG_FIELDS = [
  'authMode',
  'clientAuthMethod',
  'clientSecretRef',
  'discoveryUrl',
  'issuer',
  'authorizationEndpoint',
  'tokenEndpoint',
  'jwksUri',
  'revocationEndpoint',
  'endSessionEndpoint',
  'userInfoEndpoint',
  'clientId',
  'scopes',
  'redirectPath',
  'callbackPort',
  'callbackAddress',
  'postLogoutRedirectUri',
  'redirectUri',
  'gatewayResource',
  'gatewayConsoleUrl',
  'defaultProvider',
  'defaultModel',
  'managedModels',
  'refreshSkewSeconds',
  'attemptTimeoutSeconds',
  'httpTimeoutMs',
  'logoutMode',
  'requireExclusive',
  'allowInsecureHttp',
];

const STRING_FIELDS = [
  'discoveryUrl',
  'issuer',
  'authorizationEndpoint',
  'tokenEndpoint',
  'jwksUri',
  'revocationEndpoint',
  'endSessionEndpoint',
  'userInfoEndpoint',
  'clientId',
  'postLogoutRedirectUri',
  'redirectUri',
  'gatewayResource',
  'gatewayConsoleUrl',
  'defaultProvider',
  'defaultModel',
];

const DEFAULTS = {
  authMode: 'public',
  clientAuthMethod: 'none',
  discoveryUrl: '',
  issuer: '',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  jwksUri: '',
  revocationEndpoint: '',
  endSessionEndpoint: '',
  userInfoEndpoint: '',
  clientId: '',
  scopes: ['openid', 'profile', 'offline_access'],
  redirectPath: '/iam/callback',
  postLogoutRedirectUri: '',
  redirectUri: '',
  gatewayResource: '',
  gatewayConsoleUrl: '',
  defaultProvider: 'enterprise',
  defaultModel: '',
  managedModels: null,
  refreshSkewSeconds: 60,
  attemptTimeoutSeconds: 300,
  httpTimeoutMs: 10000,
  logoutMode: 'local',
  requireExclusive: true,
  allowInsecureHttp: false,
};

function issue(path, message) {
  return { message, path: [path] };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/**
 * Validate and normalize plugin config. Unknown keys are ignored so a future
 * DSH profile can carry forward-compatible settings without failing startup.
 *
 * @param {unknown} input
 * @returns {{ value: Record<string, unknown> } | { issues: Array<{ message: string, path: string[] }> }}
 */
export function validateConfig(input) {
  if (input === null) {
    return { issues: [issue('', 'config must be an object')] };
  }
  const source = input ?? {};
  if (!isPlainObject(source)) {
    return { issues: [issue('', 'config must be an object')] };
  }

  const issues = [];
  const value = { ...DEFAULTS, scopes: [...DEFAULTS.scopes] };

  for (const key of FORBIDDEN_AUTH_FIELDS) {
    if (Object.hasOwn(source, key)) issues.push(issue(key, 'authentication overrides and PKCE switches are not supported'));
  }
  const mode = source.authMode === undefined ? 'public' : source.authMode;
  const method = source.clientAuthMethod === undefined ? 'none' : source.clientAuthMethod;
  if (!['public', 'confidential'].includes(mode)) {
    issues.push(issue('authMode', 'authMode must be public or confidential'));
  } else if (mode === 'public') {
    if (method !== 'none') issues.push(issue('clientAuthMethod', 'public authentication only permits none'));
    if (Object.hasOwn(source, 'clientSecretRef')) issues.push(issue('clientSecretRef', 'public authentication must not contain a secret reference'));
  } else {
    const validMethod = ['client_secret_basic', 'client_secret_post'].includes(method);
    const validRef = typeof source.clientSecretRef === 'string' && source.clientSecretRef.trim().length > 0;
    if (!validMethod || !validRef) {
      issues.push(issue('authMode', 'confidential authentication requires an explicit method and reference'));
      if (!validMethod) issues.push(issue('clientAuthMethod', 'confidential authentication requires an explicit supported method'));
      issues.push(issue('clientSecretRef', 'a confidential reference requires the complete authentication configuration'));
    } else {
      value.clientAuthMethod = method;
      value.clientSecretRef = source.clientSecretRef;
    }
  }
  if (mode === 'confidential') value.authMode = mode;

  for (const key of STRING_FIELDS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      issues.push(issue(key, `${key} must be a string`));
      continue;
    }
    value[key] = raw;
  }

  const scopes = source.scopes;
  if (scopes !== undefined && scopes !== null) {
    if (!Array.isArray(scopes) || scopes.some((item) => typeof item !== 'string' || item.length === 0)) {
      issues.push(issue('scopes', 'scopes must be an array of non-empty strings'));
    } else if (!scopes.includes('openid')) {
      // The flow verifies an ID token; without `openid` the IdP returns none and
      // every login would fail later with a confusing token error.
      issues.push(issue('scopes', 'scopes must include openid'));
    } else {
      value.scopes = [...scopes];
    }
  }

  const redirectPath = source.redirectPath;
  if (redirectPath !== undefined && redirectPath !== null) {
    if (typeof redirectPath !== 'string' || !redirectPath.startsWith('/')) {
      issues.push(issue('redirectPath', 'redirectPath must start with /'));
    } else {
      let parsedPath;
      try {
        parsedPath = new URL(redirectPath, 'https://callback.invalid');
      } catch {
        parsedPath = null;
      }
      if (!parsedPath || parsedPath.pathname !== redirectPath || parsedPath.search || parsedPath.hash) {
        issues.push(issue('redirectPath', 'redirectPath must be an absolute path without query or fragment'));
      } else if (redirectPath !== '/' && redirectPath.endsWith('/')) {
        // dsh-host-webserver routes are absolute pathnames without a trailing
        // slash; registering `/x/` would not match the URL the IdP returns.
        issues.push(issue('redirectPath', 'redirectPath must not end with /'));
      } else if (redirectPath === '/') {
        issues.push(issue('redirectPath', 'redirectPath must not be the site root'));
      } else if (redirectPath === '/api/forge-iam' || redirectPath.startsWith('/api/forge-iam/')) {
        // That prefix is the authenticated management API; a callback there
        // would be rejected by connection authentication in the browser.
        issues.push(issue('redirectPath', 'redirectPath must not overlap /api/forge-iam'));
      } else {
        value.redirectPath = redirectPath;
      }
    }
  }

  // Absent means the host web server keeps the callback. 0 asks the plugin to
  // bind a loopback listener on an OS-assigned port, which is what IAM accepts
  // and what the native-app best practice recommends; 1024-65535 pins the port
  // for an authorization server that still needs a pre-registered value.
  if (source.callbackPort !== undefined && source.callbackPort !== null) {
    if (!Number.isInteger(source.callbackPort)
      || (source.callbackPort !== 0 && (source.callbackPort < 1024 || source.callbackPort > 65535))) {
      issues.push(issue('callbackPort', 'callbackPort must be 0 (OS-assigned) or an integer between 1024 and 65535'));
    } else {
      value.callbackPort = source.callbackPort;
    }
  }

  if (source.callbackAddress !== undefined && source.callbackAddress !== null) {
    if (!['auto', '127.0.0.1', '::1'].includes(source.callbackAddress)) {
      issues.push(issue('callbackAddress', "callbackAddress must be 'auto', '127.0.0.1' or '::1'"));
    } else {
      value.callbackAddress = source.callbackAddress;
    }
  }

  // A pinned port makes the redirect URI a derived value, not a preference.
  // An OS-assigned port cannot appear in config at all: it is only known after
  // binding, so an explicit redirectUri would be stale.
  const pinnedPort = typeof value.callbackPort === 'number' && value.callbackPort > 0;
  const fixedRedirect = pinnedPort
    ? `http://${value.callbackAddress === '::1' ? '[::1]' : '127.0.0.1'}:${value.callbackPort}${value.redirectPath}`
    : '';

  if (value.redirectUri) {
    let parsed;
    try {
      parsed = new URL(value.redirectUri);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      issues.push(issue('redirectUri', 'redirectUri must be an absolute http(s) URL'));
    } else if (parsed.pathname !== value.redirectPath || parsed.search || parsed.hash) {
      issues.push(issue('redirectUri', 'redirectUri path must equal redirectPath and carry no query or fragment'));
    } else if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      issues.push(issue('redirectUri', 'redirectUri must use HTTPS unless it is loopback'));
    } else if (value.callbackPort === 0) {
      issues.push(issue('redirectUri', 'redirectUri cannot be set when callbackPort is 0: the port is assigned at run time'));
    } else if (fixedRedirect && value.redirectUri !== fixedRedirect) {
      issues.push(issue('redirectUri', `redirectUri must equal ${fixedRedirect} when callbackPort is set`));
    }
  }

  if (value.postLogoutRedirectUri) {
    let parsed;
    try {
      parsed = new URL(value.postLogoutRedirectUri);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      issues.push(issue('postLogoutRedirectUri', 'postLogoutRedirectUri must be an absolute http(s) URL'));
    } else if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      issues.push(issue('postLogoutRedirectUri', 'postLogoutRedirectUri must use HTTPS unless it is loopback'));
    }
  }

  if (value.gatewayConsoleUrl) {
    let parsed;
    try {
      parsed = new URL(value.gatewayConsoleUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      issues.push(issue('gatewayConsoleUrl', 'gatewayConsoleUrl must be an absolute http(s) URL'));
    }
  }

  for (const key of ['refreshSkewSeconds', 'attemptTimeoutSeconds', 'httpTimeoutMs']) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    const minimum = key === 'refreshSkewSeconds' ? 0 : 1;
    if (!Number.isInteger(raw) || raw < minimum) {
      issues.push(issue(key, `${key} must be an integer >= ${minimum}`));
      continue;
    }
    value[key] = raw;
  }

  if (source.logoutMode !== undefined && source.logoutMode !== null) {
    if (source.logoutMode !== 'local' && source.logoutMode !== 'rp') {
      issues.push(issue('logoutMode', 'logoutMode must be local or rp'));
    } else {
      value.logoutMode = source.logoutMode;
    }
  }

  if (source.allowInsecureHttp !== undefined && source.allowInsecureHttp !== null) {
    if (typeof source.allowInsecureHttp !== 'boolean') {
      issues.push(issue('allowInsecureHttp', 'allowInsecureHttp must be a boolean'));
    } else {
      value.allowInsecureHttp = source.allowInsecureHttp;
    }
  }

  if (source.requireExclusive !== undefined && source.requireExclusive !== null) {
    if (typeof source.requireExclusive !== 'boolean') {
      issues.push(issue('requireExclusive', 'requireExclusive must be a boolean'));
    } else {
      value.requireExclusive = source.requireExclusive;
    }
  }

  if (value.logoutMode === 'rp' && !value.endSessionEndpoint) {
    issues.push(issue('endSessionEndpoint', 'RP-initiated logout requires endSessionEndpoint'));
  }

  const managed = validateManagedModels(source.managedModels, value.allowInsecureHttp);
  if (managed.issues) issues.push(...managed.issues);
  else value.managedModels = managed.value;
  if (value.managedModels && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value.defaultProvider)) {
    issues.push(issue('defaultProvider', 'managed model provider must be an exact route ID'));
  }

  if (issues.length) return { issues };
  return { value };
}

/**
 * A config is usable only when the client id and either a discovery URL or all
 * three explicit OIDC endpoints are present. Missing values keep the plugin in
 * `unconfigured` rather than falling back. `gatewayResource` is optional: V1
 * authenticates model traffic with a UAG personal credential, so login must not
 * depend on a gateway audience.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function isConfigured(config) {
  const value = config ?? {};
  const missing = [];
  if (!value.clientId) missing.push('clientId');
  if (!value.discoveryUrl) {
    if (!value.issuer) missing.push('issuer');
    if (!value.authorizationEndpoint) missing.push('authorizationEndpoint');
    if (!value.tokenEndpoint) missing.push('tokenEndpoint');
    if (!value.jwksUri) missing.push('jwksUri');
  }
  return { ok: missing.length === 0, missing };
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'heluo',
    validate: validateConfig,
  },
};