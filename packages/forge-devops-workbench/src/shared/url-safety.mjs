/**
 * 外部页面直跳 URL 安全过滤与基准路径拼接基元（零内置 Mock，绝不附加 Token/Secret）。
 */

export function normalizeSafeBase(apiBaseUrl) {
  if (typeof apiBaseUrl !== 'string' || apiBaseUrl.trim() === '') return '';
  try {
    const parsed = new URL(apiBaseUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username !== '' || parsed.password !== '') return '';
    if (parsed.search !== '' || parsed.hash !== '') return '';
    const pathPart = parsed.pathname.replace(/\/+$/u, '');
    return `${parsed.origin}${pathPart === '/' ? '' : pathPart}`;
  } catch {
    return '';
  }
}

/**
 * 校验浏览器即将弹出的外链地址安全性，防止 javascript:/data: 等伪协议注入。
 *
 * @param {unknown} rawUrl
 * @returns {string} 合法 HTTP(S) URL 或空串
 */
export function sanitizePortalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return '';
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username !== '' || parsed.password !== '') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * 基于 `apiBaseUrl` 构造安全路径拼接器供各业务域外链模块复用。
 *
 * @param {string} apiBaseUrl
 */
export function createBaseJoiner(apiBaseUrl) {
  const base = normalizeSafeBase(apiBaseUrl);
  return Object.freeze({
    base,
    isConfigured: base !== '',
    join: (subPath) => (base ? `${base}${subPath}` : ''),
  });
}
