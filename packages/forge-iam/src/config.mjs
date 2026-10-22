// Cordis 用 standard-schema 校验插件配置：Config['~standard'].validate(config)
// 必须同步返回 { value } 或 { issues }。这里不依赖外部校验库，保持包骨架可在
// 没有 DSH 运行时的环境下测试。

export const CONFIG_FIELDS = [
  'discoveryUrl',
  'authorizationEndpoint',
  'tokenEndpoint',
  'jwksUri',
  'revocationEndpoint',
  'endSessionEndpoint',
  'clientId',
  'scopes',
  'redirectPath',
  'postLogoutRedirectUri',
  'gatewayResource',
  'defaultProvider',
  'defaultModel',
  'refreshSkewSeconds',
  'attemptTimeoutSeconds',
  'httpTimeoutMs',
  'logoutMode',
  'requireExclusive',
];

const STRING_FIELDS = [
  'discoveryUrl',
  'authorizationEndpoint',
  'tokenEndpoint',
  'jwksUri',
  'revocationEndpoint',
  'endSessionEndpoint',
  'clientId',
  'postLogoutRedirectUri',
  'gatewayResource',
  'defaultProvider',
  'defaultModel',
];

const DEFAULTS = {
  discoveryUrl: '',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  jwksUri: '',
  revocationEndpoint: '',
  endSessionEndpoint: '',
  clientId: '',
  scopes: ['openid', 'profile', 'offline_access'],
  redirectPath: '/iam/callback',
  postLogoutRedirectUri: '',
  gatewayResource: '',
  defaultProvider: 'enterprise',
  defaultModel: '',
  refreshSkewSeconds: 60,
  attemptTimeoutSeconds: 300,
  httpTimeoutMs: 10000,
  logoutMode: 'local',
  requireExclusive: true,
};

function issue(path, message) {
  return { message, path: [path] };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    } else {
      value.scopes = [...scopes];
    }
  }

  const redirectPath = source.redirectPath;
  if (redirectPath !== undefined && redirectPath !== null) {
    if (typeof redirectPath !== 'string' || !redirectPath.startsWith('/')) {
      issues.push(issue('redirectPath', 'redirectPath must start with /'));
    } else {
      value.redirectPath = redirectPath;
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

  if (source.requireExclusive !== undefined && source.requireExclusive !== null) {
    if (typeof source.requireExclusive !== 'boolean') {
      issues.push(issue('requireExclusive', 'requireExclusive must be a boolean'));
    } else {
      value.requireExclusive = source.requireExclusive;
    }
  }

  if (issues.length) return { issues };
  return { value };
}

/**
 * A config is usable only when the client id, gateway audience and either a
 * discovery URL or all three explicit OIDC endpoints are present. Missing
 * values keep the plugin in `unconfigured` rather than falling back.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function isConfigured(config) {
  const value = config ?? {};
  const missing = [];
  if (!value.clientId) missing.push('clientId');
  if (!value.gatewayResource) missing.push('gatewayResource');
  if (!value.discoveryUrl) {
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