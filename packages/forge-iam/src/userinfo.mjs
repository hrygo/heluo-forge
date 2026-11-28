// UserInfo 只在登录成功后取一次，失败只丢弃画像，不影响登录。
// 内部键固定为 workNo/name（issue #160）；映射到哪个企业 IAM 声明由配置
// profileFields 给出，未配置则不取 UserInfo、不投影。口径已由 IAM 确认
// （2026-11-24）：employeeNumber=工号、displayName=姓名、giveName=OA 账号
// （暂无投影槽位），见 deploy/private-bundle.env.example。
// （#433 第 3 项），因此不写死任何候选声明名，也不维护猜测性回退链。
import { IamError } from './errors.mjs';

export const PROFILE_FIELD_KEYS = Object.freeze(['workNo', 'name']);

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
