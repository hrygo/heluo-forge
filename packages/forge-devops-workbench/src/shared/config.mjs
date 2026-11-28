/**
 * `@heluo/forge-devops-workbench` 配置校验、环境变量读取与 Standard-Schema 定义。
 *
 * 严格遵循零内置 Mock 与纯 IAM 统一认证红线：
 *   1. 公版仅保留脱敏占位符（PLACEHOLDER_API_BASE_URL），绝不硬编码任何真实企业内网域名；
 *   2. 认证方式固定为企业账号（IAM），拒绝任何 mock/credential/分队/明文凭据字段；
 *   3. 支持 3 层内网快速切换：本机连接配置覆写 > 插件配置 (apiBaseUrl) > 环境变量 (HELUO_DOP_BASE_URL / FORGE_DEVOPS_DOP_ENDPOINT)。
 */

export const PLACEHOLDER_API_BASE_URL = 'https://dop.corp.example';

export const ENV_KEYS = Object.freeze({
  apiBaseUrl: Object.freeze(['HELUO_DOP_BASE_URL', 'FORGE_DEVOPS_DOP_ENDPOINT']),
  requestTimeoutMs: Object.freeze(['HELUO_DOP_TIMEOUT_MS']),
});

export const CONFIG_FIELDS = Object.freeze([
  'enabled',
  'apiBaseUrl',
  'requestTimeoutMs',
]);

export const DEFAULTS = Object.freeze({
  enabled: true,
  apiBaseUrl: '',
  authMode: 'iam',
  requestTimeoutMs: 10000,
});

const FORBIDDEN_KEYS = new Set([
  'allowMock',
  'allow_mock',
  'mock',
  'mockMode',
  'mock_mode',
  'mockEndpoint',
  'fixture',
  'fixturesDir',
  'credentialRef',
  'squadId',
  'activeSquadId',
  'squad',
  'token',
  'authorization',
  'Authorization',
  'secret',
  'password',
]);

const ALLOWED_SET = new Set([...CONFIG_FIELDS, 'authMode']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 判定给定基准 URL 是否指向本机回环地址（仅用于 UI 渲染只读防混淆提示，不改变取数行为）。
 *
 * @param {string} urlString
 * @returns {boolean}
 */
export function isLoopbackUrl(urlString) {
  if (typeof urlString !== 'string' || urlString.trim() === '') return false;
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function issue(path, message) {
  return { path: [path], message };
}

/**
 * 校验并标准化工作台配置；若失败返回 issues 数组。
 *
 * @param {unknown} raw
 * @returns {{ value: object } | { issues: Array<{ path: string[], message: string }> }}
 */
export function validateConfigResult(raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(input)) {
    return { issues: [issue('config', 'workbench config must be a plain object')] };
  }

  const issues = [];
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.has(key)) {
      issues.push(issue(key, `forbidden config field: ${key}`));
    } else if (!ALLOWED_SET.has(key)) {
      issues.push(issue(key, `unknown config field: ${key}`));
    }
  }

  const enabled = input.enabled === undefined ? DEFAULTS.enabled : input.enabled;
  if (typeof enabled !== 'boolean') {
    issues.push(issue('enabled', 'enabled must be a boolean'));
  }

  const rawAuthMode = input.authMode === undefined ? 'iam' : input.authMode;
  if (rawAuthMode !== 'iam') {
    issues.push(issue('authMode', "authMode must be 'iam' (unified enterprise IAM authentication only)"));
  }

  let apiBaseUrl = input.apiBaseUrl === undefined ? DEFAULTS.apiBaseUrl : input.apiBaseUrl;
  if (typeof apiBaseUrl !== 'string') {
    issues.push(issue('apiBaseUrl', 'apiBaseUrl must be a string'));
    apiBaseUrl = '';
  } else {
    apiBaseUrl = apiBaseUrl.trim();
    if (apiBaseUrl !== '') {
      try {
        const parsed = new URL(apiBaseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          issues.push(issue('apiBaseUrl', 'apiBaseUrl must use http: or https: scheme'));
        }
        if (parsed.username !== '' || parsed.password !== '') {
          issues.push(issue('apiBaseUrl', 'apiBaseUrl must not contain userinfo'));
        }
        if (parsed.search !== '' || parsed.hash !== '') {
          issues.push(issue('apiBaseUrl', 'apiBaseUrl must not contain query string or hash'));
        }
        if (issues.length === 0) {
          const pathPart = parsed.pathname.replace(/\/+$/u, '');
          apiBaseUrl = `${parsed.origin}${pathPart === '/' ? '' : pathPart}`;
        }
      } catch {
        issues.push(issue('apiBaseUrl', 'apiBaseUrl must be a valid URL'));
      }
    }
  }

  const requestTimeoutMs = input.requestTimeoutMs === undefined
    ? DEFAULTS.requestTimeoutMs
    : input.requestTimeoutMs;
  if (
    typeof requestTimeoutMs !== 'number'
    || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs < 1000
    || requestTimeoutMs > 60000
  ) {
    issues.push(issue('requestTimeoutMs', 'requestTimeoutMs must be an integer between 1000 and 60000'));
  }

  if (issues.length > 0) return { issues };

  return {
    value: Object.freeze({
      enabled,
      apiBaseUrl,
      authMode: 'iam',
      requestTimeoutMs,
    }),
  };
}

/**
 * 同步校验并返回规范化配置；不合法直接抛出 TypeError（Fail-Closed）。
 *
 * @param {unknown} raw
 * @returns {Readonly<{ enabled: boolean, apiBaseUrl: string, authMode: 'iam', requestTimeoutMs: number }>}
 */
export function validateConfig(raw) {
  const result = validateConfigResult(raw);
  if ('issues' in result) {
    const summary = result.issues.map((item) => `${item.path.join('.')}: ${item.message}`).join('; ');
    throw new TypeError(`Invalid workbench config: ${summary}`);
  }
  return result.value;
}

export const normalizeConfig = validateConfig;

/**
 * 从环境变量按优先级解析 DOP 工作台连接配置（HELUO_DOP_BASE_URL > FORGE_DEVOPS_DOP_ENDPOINT），
 * 用于企业内网一键切换，格式不合法的环境变量不盲用。
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveEnvConfig(env = process.env) {
  const src = env && typeof env === 'object' ? env : {};
  let apiBaseUrl = '';
  let matchedEnvKey = '';
  let requestTimeoutMs;
  const matchedEnvKeys = [];
  const invalidEnvKeys = [];

  for (const key of ENV_KEYS.apiBaseUrl) {
    const raw = src[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const res = validateConfigResult({ apiBaseUrl: raw.trim() });
    if ('value' in res && res.value.apiBaseUrl !== '') {
      apiBaseUrl = res.value.apiBaseUrl;
      matchedEnvKey = key;
      matchedEnvKeys.push(key);
      break;
    }
    invalidEnvKeys.push(key);
  }

  for (const key of ENV_KEYS.requestTimeoutMs) {
    const raw = src[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const num = Number(raw.trim());
    const res = validateConfigResult({ requestTimeoutMs: num });
    if ('value' in res) {
      requestTimeoutMs = res.value.requestTimeoutMs;
      matchedEnvKeys.push(key);
      break;
    }
    invalidEnvKeys.push(key);
  }

  return Object.freeze({
    apiBaseUrl,
    requestTimeoutMs,
    matchedEnvKey,
    matchedEnvKeys: Object.freeze(matchedEnvKeys),
    invalidEnvKeys: Object.freeze(invalidEnvKeys),
  });
}

/**
 * Cordis 兼容 Standard-Schema 对象。
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'heluo-forge',
    validate(input) {
      return validateConfigResult(input);
    },
  }),
});
