import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { parseSkillDoc } from "./skill-document.js";
import type { CatalogInstallation, UploadInput } from "./types.js";
import { readZip, ZipReadError } from "./zip.js";
import { createPortablePathSet,isPortableFileSegment } from "./filesystem-paths.js";

export interface NacosConfig {
  serverUrl: string;
  namespaceId?: string;
  username?: string;
  password?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  credentialsRef?: "bundled";
  timeoutMs?: number;
}
export interface NacosSkill { name: string; description: string; version: string; namespaceId?: string; downloadCount?: number; installations?: CatalogInstallation[] }
export interface NacosPage { configured: boolean; items: NacosSkill[]; page: number; total: number; pageSize: number }
export interface NacosDetail extends NacosSkill { body: string; files: string[]; digest: string }
export type NacosSelection = { skillName?: unknown; version?: unknown };
class NacosError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 502) { super(message); this.code = code; this.statusCode = statusCode; }
}
const error = (code: string, message: string, status = 502) => new NacosError(`error.nacos.${code}`, message, status);
const validName = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v.length <= 64;
const validVersion = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Fixed package-owned location; secrets never become properties of Host config. */
function bundledCredentials(): { username: string; password: string } {
  const invalid = () => error("config", "企业技能库包内凭据不可用，请联系维护人员", 503);
  let descriptor: number | undefined;
  try {
    // A trailing slash makes POSIX follow directory links even for lstat.
    const directory = lstatSync(new URL("../private", import.meta.url));
    const path = new URL("../private/nacos-credentials.json", import.meta.url);
    if (!directory.isDirectory() || directory.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw invalid();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor), limit = 16 << 10;
    if (!info.isFile() || info.size > limit) throw invalid();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw invalid();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!object(value) || Object.keys(value).sort().join(",") !== "password,username" ||
        typeof value.username !== "string" || !value.username.trim() || typeof value.password !== "string" || !value.password.trim()) throw invalid();
    return { username: value.username, password: value.password };
  } catch (caught) {
    // Only file/encoding/JSON failures are sanitized; programming defects stay visible.
    if (caught instanceof SyntaxError || (caught instanceof TypeError && "code" in caught && caught.code === "ERR_ENCODING_INVALID_ENCODED_DATA") ||
        (caught instanceof Error && !(caught instanceof TypeError) && !(caught instanceof ReferenceError) && "code" in caught &&
          typeof caught.code === "string" && /^(?:ENOENT|ENOTDIR|EACCES|EPERM|ELOOP|EISDIR|EIO|EMFILE|ENFILE)$/.test(caught.code))) throw invalid();
    throw caught;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function validateNamespace(item: Record<string, unknown>, namespace: string) {
  if (item.namespaceId != null && item.namespaceId !== namespace) throw error("response", "企业技能库条目命名空间不匹配");
}
export function validateNacosSelection(input: NacosSelection) {
  if (!validName(input?.skillName) || !validVersion(input?.version)) throw error("query", "技能名称或版本无效", 400);
  return { name: input.skillName, version: input.version };
}

/** No configurable request paths or mutation methods. Only login and read APIs. */
export function createNacosClient(config?: NacosConfig, fetcher: typeof fetch = (...args) => fetch(...args)) {
  let token: { value: string; until: number; credentialKey: string } | undefined;
  function identity(input: NacosSelection) {
    const selected = validateNacosSelection(input);
    const cfg = settings();
    return "nacos:" + createHash("sha256").update(JSON.stringify([cfg.base, cfg.namespace, selected.name, selected.version])).digest("hex");
  }
  function settings() {
    if (!config) throw error("unconfigured", "企业技能库尚未配置，请联系维护人员", 503);
    try {
      const url = new URL(config.serverUrl);
      if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw 0;
      const namespace = config.namespaceId ?? "public";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace)) throw 0;
      if (config.credentialsRef !== undefined && (config.credentialsRef !== "bundled" ||
          [config.username, config.password, config.usernameEnv, config.passwordEnv].some(value => value !== undefined))) throw 0;
      const usernameEnv = config.usernameEnv ?? "FORGE_NACOS_USERNAME";
      const passwordEnv = config.passwordEnv ?? "FORGE_NACOS_PASSWORD";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(usernameEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnv)) throw 0;
      const timeout = config.timeoutMs ?? 15000;
      if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) throw 0;
      return { base: url.href.replace(/\/$/, ""), namespace, usernameEnv, passwordEnv, timeout };
    } catch (caught) {
      if (caught !== 0 && !(caught instanceof TypeError && "code" in caught && caught.code === "ERR_INVALID_URL")) throw caught;
      throw error("config", "企业技能库配置不完整或不安全，请联系维护人员", 503);
    }
  }
  function credentials() {
    const cfg = settings();
    if (config?.credentialsRef === "bundled") {
      try { return bundledCredentials(); }
      catch (caught) { token = undefined; throw caught; }
    }
    const explicit = config?.username !== undefined || config?.password !== undefined;
    const username = explicit ? config?.username : process.env[cfg.usernameEnv];
    const password = explicit ? config?.password : process.env[cfg.passwordEnv];
    if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password.trim()) {
      token = undefined;
      throw error("config", "企业技能库凭据未配置，请联系维护人员", 503);
    }
    return { username, password };
  }
  async function bounded(response: Response, limit: number, signal: AbortSignal) {
    const reader = response.body?.getReader();
    if (!reader) throw error("response", "企业技能库响应无效");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (Number(response.headers.get("content-length")) > limit) throw error("size", "企业技能库响应超出大小限制");
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw error("size", "企业技能库响应超出大小限制");
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } catch (caught) {
      // Abort/timeout classification belongs to run(); programming defects stay visible.
      signal.throwIfAborted();
      if (caught instanceof TypeError && caught.cause && typeof caught.cause === "object" && "code" in caught.cause &&
          typeof caught.cause.code === "string" && /^(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|BODY_TIMEOUT))$/.test(caught.cause.code)) {
        throw error("unavailable", "企业技能库连接中断，请恢复网络后重试");
      }
      throw caught;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async function request(path: string, params: Record<string, string>, signal: AbortSignal, auth?: string, form?: URLSearchParams, limit = 2 << 20) {
    const cfg = settings();
    const url = new URL(cfg.base + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // Nacos default auth accepts Authorization: Bearer; never put tokens in URLs.
    let response: Response;
    try { response = await fetcher(url.href, { method: form ? "POST" : "GET", redirect: "error", signal,
      headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(form ? { body: form } : {}) }); }
    catch (caught) {
      // Native fetch reports network failures as TypeError with a system cause.
      // Programming errors in providers remain visible rather than becoming network errors.
      if (caught instanceof TypeError && caught.cause) throw error("unavailable", "企业技能库连接失败，请检查网络或联系维护人员");
      throw caught;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) { token = undefined; throw error("auth", "企业技能库认证失败或只读账号权限不足", 403); }
      if (response.status === 404) throw error("notFound", "技能版本不存在，或服务未提供 Nacos 3.2 技能接口", 404);
      throw error("unavailable", "企业技能库暂时不可用");
    }
    return bounded(response, limit, signal);
  }
  function json(bytes: Uint8Array): Record<string, unknown> {
    try { const v: unknown = JSON.parse(decodeUtf8(bytes, "response")); if (object(v)) return v; }
    catch (caught) { if (!(caught instanceof SyntaxError)) throw caught; }
    throw error("response", "企业技能库返回无效数据");
  }
  function decodeUtf8(bytes: Uint8Array, code: "response" | "package") {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (caught) {
      if (!(caught instanceof TypeError) || !("code" in caught) || caught.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw caught;
      throw error(code, "企业技能库内容不是有效 UTF-8");
    }
  }
  async function access(signal: AbortSignal) {
    const resolved = credentials();
    signal.throwIfAborted();
    const credentialKey = createHash("sha256").update(JSON.stringify([resolved.username, resolved.password])).digest("hex");
    if (token && token.until > Date.now() && token.credentialKey === credentialKey) return token.value;
    token = undefined;
    const pending = (async () => {
      const v = json(await request("/v3/auth/user/login", {}, signal, undefined, new URLSearchParams(resolved), 64 << 10));
      if (typeof v.accessToken !== "string" || !v.accessToken || /[\r\n]/.test(v.accessToken) || v.accessToken.length > 16384 || typeof v.tokenTtl !== "number" || !Number.isFinite(v.tokenTtl) || v.tokenTtl <= 0) throw error("auth", "企业技能库认证响应无效", 403);
      token = { value: v.accessToken, until: Date.now() + Math.max(0, Math.min(v.tokenTtl, 86400) * 1000 - 30000), credentialKey };
      return v.accessToken;
    })();
    return pending;
  }
  async function run<T>(signal: AbortSignal | undefined, action: (combined: AbortSignal) => Promise<T>) {
    const combined = AbortSignal.any([AbortSignal.timeout(settings().timeout), ...(signal ? [signal] : [])]);
    try { combined.throwIfAborted(); return await action(combined); }
    catch (caught) {
      if (signal?.aborted) throw error("cancelled", "企业技能库请求已取消", 499);
      if (combined.aborted) throw error("timeout", "企业技能库请求超时，请重试", 504);
      if (caught instanceof NacosError) throw caught;
      throw caught;
    }
  }
  async function online(item: Record<string, unknown>, name: string, version: string, signal: AbortSignal, auth: string) {
    const namespace = settings().namespace;
    let meta = item;
    if (!Array.isArray(meta.versions)) {
      const result = json(await request("/v3/admin/ai/skills", { namespaceId: namespace, skillName: name }, signal, auth));
      if (result.code === 401 || result.code === 403) { token = undefined; throw error("auth", "企业技能库只读账号权限不足", 403); }
      if (result.code !== 0 || !object(result.data)) throw error("response", "企业技能库详情格式不兼容");
      meta = result.data;
    }
    validateNamespace(meta, namespace);
    if (meta.name !== name) throw error("response", "企业技能库详情名称不匹配");
    return meta.enable === true && object(meta.labels) && meta.labels.latest === version &&
      Array.isArray(meta.versions) && meta.versions.some(v => object(v) && v.version === version && v.status === "online");
  }
  async function load(input: NacosSelection, signal?: AbortSignal) {
    const selected = validateNacosSelection(input);
    return run(signal, async combined => {
      const cfg = settings();
      const auth = await access(combined);
      const metadata = json(await request("/v3/admin/ai/skills/list", { namespaceId: cfg.namespace, skillName: selected.name, search: "accurate", pageNo: "1", pageSize: "20" }, combined, auth));
      if (metadata.code === 401 || metadata.code === 403) { token = undefined; throw error("auth", "企业技能库只读账号权限不足", 403); }
      if (metadata.code !== 0 || !object(metadata.data) || !Array.isArray(metadata.data.pageItems)) throw error("response", "企业技能库列表格式不兼容");
      const item = metadata.data.pageItems.find(item => object(item) && item.name === selected.name);
      if (object(item)) validateNamespace(item, cfg.namespace);
      if (!object(item) || item.enable !== true || !object(item.labels) || item.labels.latest !== selected.version ||
          !await online(item, selected.name, selected.version, combined, auth)) throw error("notFound", "技能版本已变更、下线或未发布，请刷新公共库", 404);
      // Client API enforces the exact version's online state again at download.
      const bytes = await request("/v3/client/ai/skills", { namespaceId: cfg.namespace, name: selected.name, version: selected.version }, combined, auth, undefined, 10 << 20);
      const entries: NonNullable<UploadInput["entries"]> = [];
      const seen = createPortablePathSet();
      let count = 0, total = 0;
      let files: Record<string, Uint8Array>;
      try {
        files = await readZip(bytes, { filter(info) {
          const path = info.name.replace(/\/$/, "");
          const parts = path.split("/");
          if (!path || path.length > 512 || parts.length > 64 || parts.some(p => !isPortableFileSegment(p))) throw 0;
          if (++count > 1000 || info.originalSize > (32 << 20) || (total += info.originalSize) > (64 << 20) || !seen.add(path)) throw 0;
          return !info.name.endsWith("/");
        } });
      } catch (caught) {
        if (caught !== 0 && !(caught instanceof ZipReadError)) throw caught;
        throw error("package", "技能 ZIP 包无效、路径不安全或大小超限");
      }
      // Nacos wraps exports in <skillName>/. Accept root layout too, without flattening resources.
      const names = Object.keys(files);
      const prefix = names.includes("SKILL.md") ? "" : selected.name + "/";
      if (!names.length || names.some(p => !p.startsWith(prefix)) || !files[prefix + "SKILL.md"] || files[prefix + "SKILL.md"].length > (256 << 10)) throw error("package", "技能包必须只包含所选技能及其完整资源");
      const document = parseSkillDoc(decodeUtf8(files[prefix + "SKILL.md"], "package"));
      if (document.map.name !== selected.name || typeof document.map.description !== "string" || !document.map.description.trim() || !document.body.trim()) throw error("package", "技能包名称与请求不一致，或缺少有效说明");
      const digest = createHash("sha256");
      for (const name of names.sort()) {
        const path = name.slice(prefix.length);
        digest.update(JSON.stringify([path, createHash("sha256").update(files[name]).digest("hex")]));
        entries.push({ path, data: Buffer.from(files[name]).toString("base64") });
      }
      const id = identity(input);
      const detail: NacosDetail = { ...selected, description: document.map.description, body: document.body, files: entries.map(e => e.path), digest: digest.digest("hex") };
      return { id, pack: { name: selected.name, entries } satisfies UploadInput, detail };
    });
  }
  return {
    async list(query = "", page = 1, signal?: AbortSignal): Promise<NacosPage> {
      if (typeof query !== "string" || query.length > 100 || /[\x00-\x1f]/.test(query) || !Number.isInteger(page) || page < 1 || page > 10000) throw error("query", "搜索条件或页码无效", 400);
      if (!config) return { configured: false, items: [], total: 0, page, pageSize: 20 };
      return run(signal, async combined => {
        const namespace = settings().namespace;
        const auth = await access(combined);
        const v = json(await request("/v3/admin/ai/skills/list", { namespaceId: namespace, skillName: query, search: "blur", orderBy: "download_count", pageNo: String(page), pageSize: "20" }, combined, auth));
        if (v.code === 401 || v.code === 403) { token = undefined; throw error("auth", "企业技能库只读账号权限不足", 403); }
        const data = v.data;
        if (v.code !== 0 || !object(data) || !Array.isArray(data.pageItems) || data.pageItems.length > 20 || !Number.isSafeInteger(data.totalCount) || Number(data.totalCount) < 0) throw error("response", "企业技能库列表格式不兼容");
        const items: NacosSkill[] = [];
        for (const item of data.pageItems) {
          if (!object(item) || !validName(item.name) || typeof item.description !== "string" || item.description.length > 16384) throw error("response", "企业技能库条目格式不兼容");
          // Expose only enabled skills with a published latest label; never offer drafts.
          if (item.enable !== true || item.labels == null) continue;
          if (!object(item.labels)) throw error("response", "企业技能库条目格式不兼容");
          if (!validVersion(item.labels.latest)) continue;
          validateNamespace(item, namespace);
          if (!await online(item, item.name, item.labels.latest, combined, auth)) continue;
          items.push({ name: item.name, description: item.description, version: item.labels.latest, namespaceId: namespace,
            ...(Number.isSafeInteger(item.downloadCount) && Number(item.downloadCount) >= 0 ? { downloadCount: Number(item.downloadCount) } : {}) });
        }
        return { configured: true, items, page, total: Number(data.totalCount), pageSize: 20 };
      });
    },
    async detail(input: NacosSelection, signal?: AbortSignal) { return (await load(input, signal)).detail; },
    identity,
    load,
  };
}
