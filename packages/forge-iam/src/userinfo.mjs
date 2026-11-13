// UserInfo 只在登录成功后取一次，失败只丢弃画像，不影响登录。
// 字段口径已定稿（issue #160）：内部键 user_id/user_name/work_no，
// 默认映射企业 IAM 的 employeeNumber（工号）/displayName（姓名）/giveName（OA 账号）。
// 只保留这一套映射，不做猜测性回退链；宿主可用 profileFields 覆盖，
// 显式传空对象则保持不请求、不投影。
import { IamError } from './errors.mjs';

export const PROFILE_FIELD_KEYS = Object.freeze(['user_id', 'user_name', 'work_no']);

export const DEFAULT_PROFILE_FIELDS = Object.freeze({
  user_id: 'employeeNumber',
  user_name: 'displayName',
  work_no: 'giveName',
});

const MAX_PROFILE_VALUE = 128;

/** 只保留已知键的字符串值；空映射表示不请求、不投影。 */
export function normalizeProfileFields(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return Object.freeze({});
  const normalized = {};
  for (const key of PROFILE_FIELD_KEYS) {
    const source = fields[key];
    if (typeof source === 'string' && source.length > 0) normalized[key] = source;
  }
  return Object.freeze(normalized);
}

/** 严格投影：只取字符串、去空白、限长，不做嵌套或类型转换。 */
export function projectUserInfo(raw, fields) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const profile = {};
  for (const key of PROFILE_FIELD_KEYS) {
    const source = fields?.[key];
    if (typeof source !== 'string') continue;
    const value = raw[source];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    profile[key] = trimmed.slice(0, MAX_PROFILE_VALUE);
  }
  return Object.keys(profile).length === 0 ? undefined : Object.freeze(profile);
}

/**
 * 令牌传递方式：标准 OIDC 用 Authorization Bearer 头（header）；
 * 企业 IAM 的 profile 端点实测要求 query 参数（?access_token=...）。
 */
export async function fetchUserInfo({
  userInfoEndpoint,
  accessToken,
  tokenTransport = 'header',
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new IamError('IAM_USERINFO_UNAVAILABLE', 'userinfo fetch is unavailable');
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new IamError('IAM_USERINFO_UNAVAILABLE', 'userinfo needs an access token');
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response;
  try {
    const url = new URL(userInfoEndpoint);
    const headers = { accept: 'application/json' };
    if (tokenTransport === 'query') {
      url.searchParams.set('access_token', accessToken);
    } else {
      headers.authorization = `Bearer ${accessToken}`;
    }
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.any(signals),
    });
  } catch {
    throw new IamError('IAM_USERINFO_UNAVAILABLE', 'userinfo endpoint is unreachable');
  }
  if (!response.ok) {
    throw new IamError('IAM_USERINFO_REJECTED', `userinfo returned ${response.status}`);
  }
  let raw;
  try {
    raw = await response.json();
  } catch {
    throw new IamError('IAM_USERINFO_MALFORMED', 'userinfo is not JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IamError('IAM_USERINFO_MALFORMED', 'userinfo is not an object');
  }
  return raw;
}
