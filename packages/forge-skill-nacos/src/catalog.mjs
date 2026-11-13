/**
 * Nacos 目录客户端（设计 §5.1：三路线 + 唯一下载通道）。
 *
 * 端点契约（2026-10-29 本地 Nacos 3.2 实测）：
 * - console 面（list/detail）在 console 端口（如 `http://host:8080`，无 `/nacos` 前缀）；
 * - client 面（ZIP 下载、config 读取、登录）在主端口（如 `http://host:8848/nacos`）；
 * - 鉴权：`/v3/auth/user/login`（form 的 username/password）换 accessToken（顶层
 *   `{accessToken, tokenTtl}`），后续请求带 `accessToken` 查询参数；token 形态凭据直用。
 * 响应字段名与 3.2 源码核对一致（pageItems/totalCount/versions[].status），企业实例
 * 差异仍以 P0 取证为准。
 */
import { REASONS, SkillNacosError } from './errors.mjs';

const CONSOLE_LIST_PATH = '/v3/console/ai/skills/list';
const CONSOLE_DETAIL_PATH = '/v3/console/ai/skills';
const CLIENT_SEARCH_PATH = '/v3/client/ai/skills/search';
// 3.x Config Client API 路径待实测（P0）；此处集中一处便于替换。
const CONFIG_READ_PATH = '/v3/client/cs/config';
const CLIENT_DOWNLOAD_PATH = '/v3/client/ai/skills';
const LOGIN_PATH = '/v3/auth/user/login';
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * @param {{value: object}} configInput validateConfig 的产物
 * @param {() => Promise<{kind:'password',username,password}|{kind:'token',token}>} readCredential
 * @param {typeof fetch} [fetchImpl] 测试注入
 */
export function createCatalog(configInput, readCredential, fetchImpl = globalThis.fetch) {
  const config = configInput.value;
  const consoleEndpoint = config.consoleEndpoint ?? config.endpoint;
  let cachedToken;
  let cachedTokenExpire = 0;

  /** 登录换 accessToken（缓存复用，提前 tokenTtl 一分钟刷新）。 */
  async function accessToken() {
    const credential = await readCredential();
    if (credential.kind === 'token') return credential.token;
    if (cachedToken !== undefined && Date.now() < cachedTokenExpire) return cachedToken;
    const url = new URL(config.endpoint + LOGIN_PATH);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: credential.username, password: credential.password }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      throw new SkillNacosError(REASONS.NETWORK, `登录技能源失败：${error.message}`);
    }
    if (!response.ok) {
      throw new SkillNacosError(REASONS.AUTH_MISSING, `登录技能源失败（HTTP ${response.status}），请检查凭据记录`, { status: response.status });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SkillNacosError(REASONS.AUTH_MISSING, '登录响应不是有效 JSON');
    }
    const token = payload?.accessToken ?? payload?.data?.accessToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw new SkillNacosError(REASONS.AUTH_MISSING, '登录响应缺少 accessToken');
    }
    const ttlMs = (Number(payload?.tokenTtl ?? payload?.data?.tokenTtl) || 18000) * 1000;
    cachedToken = token;
    cachedTokenExpire = Date.now() + Math.max(ttlMs - TOKEN_REFRESH_MARGIN_MS, 0);
    return token;
  }

  async function requestJson(base, path, params) {
    const response = await rawRequest(base, path, params, { Accept: 'application/json' });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SkillNacosError(REASONS.CATALOG_INVALID, `目录响应不是有效 JSON（${path}）`);
    }
    const data = unwrapResult(payload, path);
    if (data === undefined) {
      throw new SkillNacosError(REASONS.CATALOG_INVALID, `目录响应缺少 data（${path}）`, { code: payload?.code });
    }
    return data;
  }

  /** Nacos v2/3 Result 外壳 `{code, message, data}`；code 非 0 视为目录失败。 */
  function unwrapResult(payload, path) {
    if (payload === null || typeof payload !== 'object') return undefined;
    if ('code' in payload && payload.code !== 0) {
      throw new SkillNacosError(REASONS.CATALOG_INVALID, `目录返回错误码 ${String(payload.code)}：${String(payload.message ?? '')}（${path}）`, { code: payload.code });
    }
    return payload.data;
  }

  async function rawRequest(base, path, params, extraHeaders) {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    url.searchParams.set('accessToken', await accessToken());
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { ...extraHeaders },
        redirect: 'error',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof SkillNacosError) throw error;
      throw new SkillNacosError(REASONS.NETWORK, `请求技能源失败（${path}）：${error.message}`);
    }
    assertAcceptable(response, path);
    return response;
  }

  function assertAcceptable(response, path) {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new SkillNacosError(REASONS.FORBIDDEN, `无权限访问技能源（${path}，HTTP ${response.status}），请检查凭据与账号权限`, { status: response.status });
    }
    if (response.status === 404) {
      throw new SkillNacosError(REASONS.NOT_FOUND, `技能源未找到该资源（${path}）`);
    }
    throw new SkillNacosError(REASONS.NETWORK, `技能源返回 HTTP ${response.status}（${path}）`, { status: response.status });
  }

  /** 目录列举：三路线归一化为 `{items, total}`。 */
  async function list({ page = 1, pageSize = config.catalogPageSize } = {}) {
    if (config.catalogMode === 'console-list') {
      const data = await requestJson(consoleEndpoint, CONSOLE_LIST_PATH, { namespaceId: config.namespaceId, pageNo: page, pageSize });
      return { items: pageItems(data).map(normalizeSummary), total: totalOf(data) };
    }
    if (config.catalogMode === 'client-search') {
      const data = await requestJson(config.endpoint, CLIENT_SEARCH_PATH, { namespaceId: config.namespaceId, pageNo: page, pageSize });
      return { items: pageItems(data).map(normalizeSummary), total: totalOf(data) };
    }
    const index = await fetchConfigIndex();
    return { items: index.skills.map(normalizeIndexEntry), total: index.skills.length };
  }

  /** 技能详情：版本清单（含状态）；`client-search` 模式的详情通道待实测，暂复用 console 面。 */
  async function getMeta(name) {
    if (config.catalogMode === 'config-index') {
      const index = await fetchConfigIndex();
      const entry = index.skills.find((skill) => skill.name === name);
      if (entry === undefined) throw new SkillNacosError(REASONS.NOT_FOUND, `目录中没有技能 ${name}`);
      return normalizeIndexEntry(entry);
    }
    const data = await requestJson(consoleEndpoint, CONSOLE_DETAIL_PATH, { namespaceId: config.namespaceId, skillName: name });
    return normalizeMeta(data);
  }

  async function fetchConfigIndex() {
    const data = await requestJson(config.endpoint, CONFIG_READ_PATH, {
      dataId: config.configIndexDataId,
      groupName: 'SKILL_NACOS',
      namespaceId: config.namespaceId,
    });
    const index = typeof data === 'string' ? JSON.parse(data) : data;
    if (index === null || typeof index !== 'object' || !Array.isArray(index.skills)) {
      throw new SkillNacosError(REASONS.CATALOG_INVALID, 'config-index 索引不是 {skills:[…]} JSON');
    }
    return index;
  }

  /**
   * 版本解析（设计 §7.2 C 步）：精确版本必须存在且 online；label 取最新 online 版本
   * 并记录 requestedRef（服务端标签语义待 P0 实测）。
   */
  function resolveVersion(meta, ref) {
    const online = meta.versions.filter((entry) => isOnline(entry));
    if (online.length === 0) {
      throw new SkillNacosError(REASONS.NOT_FOUND, `技能 ${meta.name} 没有 online 版本`);
    }
    if (ref !== undefined && typeof ref.version === 'string' && ref.version.length > 0) {
      const exact = meta.versions.find((entry) => entry.version === ref.version);
      if (exact === undefined) {
        throw new SkillNacosError(REASONS.NOT_FOUND, `技能 ${meta.name} 没有版本 ${ref.version}`);
      }
      if (!isOnline(exact)) {
        throw new SkillNacosError(REASONS.NOT_FOUND, `技能 ${meta.name}@${ref.version} 不在线（状态 ${exact.status}）`);
      }
      return { version: exact.version, requestedRef: `version:${ref.version}` };
    }
    const latest = online.reduce((best, entry) => (best === undefined || Number(entry.updateTime ?? 0) >= Number(best.updateTime ?? 0) ? entry : best), undefined);
    const label = ref?.label ?? 'latest';
    return { version: latest.version, requestedRef: `label:${label}` };
  }

  /** ZIP 下载（唯一包体通道，client 主端口）：有界读取，超限即时中止。 */
  async function download(name, version) {
    const response = await rawRequest(
      config.endpoint,
      CLIENT_DOWNLOAD_PATH,
      { namespaceId: config.namespaceId, name, version },
      { Accept: 'application/zip' },
    );
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > config.downloadMaxBytes) {
      throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `技能包 ${name}@${version} 大小超过下载上限 ${config.downloadMaxBytes} 字节`);
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return new Uint8Array(await response.arrayBuffer());
    }
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.downloadMaxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `技能包 ${name}@${version} 下载超过上限（疑似超大包）`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  return { list, getMeta, resolveVersion, download };
}

/** Page 模型的条目字段名与 3.2 源码/本地实测一致（pageItems）；防御式兼容其余命名。 */
function pageItems(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['pageItems', 'items', 'list']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function totalOf(data) {
  if (data === null || typeof data !== 'object') return 0;
  for (const key of ['totalCount', 'total']) {
    if (Number.isFinite(Number(data[key]))) return Number(data[key]);
  }
  return pageItems(data).length;
}

function normalizeSummary(entry) {
  return {
    name: String(entry?.name ?? ''),
    description: String(entry?.description ?? ''),
    // editingVersion 为 null 时从 labels.latest 取（2026-10-29 本地 Nacos 实测形态）
    version: entry?.editingVersion !== undefined && entry.editingVersion !== null
      ? String(entry.editingVersion)
      : (typeof entry?.labels?.latest === 'string' ? entry.labels.latest : undefined),
    updateTime: entry?.updateTime,
  };
}

function normalizeMeta(data) {
  const versions = Array.isArray(data?.versions) ? data.versions : [];
  return {
    name: String(data?.name ?? ''),
    description: String(data?.description ?? ''),
    versions: versions.map((entry) => ({
      version: String(entry?.version ?? ''),
      status: String(entry?.status ?? ''),
      updateTime: entry?.updateTime,
    })),
  };
}

function normalizeIndexEntry(entry) {
  const versions = Array.isArray(entry?.versions) ? entry.versions : [];
  return {
    name: String(entry?.name ?? ''),
    description: String(entry?.description ?? ''),
    sha256: typeof entry?.sha256 === 'string' ? entry.sha256 : undefined,
    versions: versions.map((version) =>
      typeof version === 'string'
        ? { version, status: 'online', updateTime: undefined }
        : { version: String(version?.version ?? ''), status: String(version?.status ?? 'online'), updateTime: version?.updateTime },
    ),
  };
}

function isOnline(entry) {
  const status = entry.status.toLowerCase();
  return status === '' || status === 'online' || status === 'published';
}
