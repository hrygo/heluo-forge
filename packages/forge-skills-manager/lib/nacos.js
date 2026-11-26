import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { parseSkillDoc } from "./skill-document.js";
import { readZip, ZipReadError } from "./zip.js";
import { createPortablePathSet, isPortableFileSegment } from "./filesystem-paths.js";
class NacosError extends Error {
  code;
  statusCode;
  constructor(code, message, statusCode = 502) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}
const error = (code, message, status = 502) => new NacosError(`error.nacos.${code}`, message, status);
const validName = (v) => typeof v === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v.length <= 64;
const validVersion = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function bundledCredentials() {
  const invalid = () => error("config", "\u4F01\u4E1A\u6280\u80FD\u5E93\u5305\u5185\u51ED\u636E\u4E0D\u53EF\u7528\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458", 503);
  let descriptor;
  try {
    const directory = lstatSync(new URL("../private/", import.meta.url));
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
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!object(value) || Object.keys(value).sort().join(",") !== "password,username" || typeof value.username !== "string" || !value.username.trim() || typeof value.password !== "string" || !value.password.trim()) throw invalid();
    return { username: value.username, password: value.password };
  } catch (caught) {
    if (caught instanceof SyntaxError || caught instanceof TypeError && "code" in caught && caught.code === "ERR_ENCODING_INVALID_ENCODED_DATA" || caught instanceof Error && !(caught instanceof TypeError) && !(caught instanceof ReferenceError) && "code" in caught && typeof caught.code === "string" && /^(?:ENOENT|ENOTDIR|EACCES|EPERM|ELOOP|EISDIR|EIO|EMFILE|ENFILE)$/.test(caught.code)) throw invalid();
    throw caught;
  } finally {
    if (descriptor !== void 0) closeSync(descriptor);
  }
}
function validateNamespace(item, namespace) {
  if (item.namespaceId != null && item.namespaceId !== namespace) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u6761\u76EE\u547D\u540D\u7A7A\u95F4\u4E0D\u5339\u914D");
}
function validateNacosSelection(input) {
  if (!validName(input?.skillName) || !validVersion(input?.version)) throw error("query", "\u6280\u80FD\u540D\u79F0\u6216\u7248\u672C\u65E0\u6548", 400);
  return { name: input.skillName, version: input.version };
}
function createNacosClient(config, fetcher = (...args) => fetch(...args)) {
  let token;
  function identity(input) {
    const selected = validateNacosSelection(input);
    const cfg = settings();
    return "nacos:" + createHash("sha256").update(JSON.stringify([cfg.base, cfg.namespace, selected.name, selected.version])).digest("hex");
  }
  function settings() {
    if (!config) throw error("unconfigured", "\u4F01\u4E1A\u6280\u80FD\u5E93\u5C1A\u672A\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458", 503);
    try {
      const url = new URL(config.serverUrl);
      if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw 0;
      const namespace = config.namespaceId ?? "public";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace)) throw 0;
      if (config.credentialsRef !== void 0 && (config.credentialsRef !== "bundled" || [config.username, config.password, config.usernameEnv, config.passwordEnv].some((value) => value !== void 0))) throw 0;
      const usernameEnv = config.usernameEnv ?? "FORGE_NACOS_USERNAME";
      const passwordEnv = config.passwordEnv ?? "FORGE_NACOS_PASSWORD";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(usernameEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnv)) throw 0;
      const timeout = config.timeoutMs ?? 15e3;
      if (!Number.isInteger(timeout) || timeout < 100 || timeout > 12e4) throw 0;
      return { base: url.href.replace(/\/$/, ""), namespace, usernameEnv, passwordEnv, timeout };
    } catch (caught) {
      if (caught !== 0 && !(caught instanceof TypeError && "code" in caught && caught.code === "ERR_INVALID_URL")) throw caught;
      throw error("config", "\u4F01\u4E1A\u6280\u80FD\u5E93\u914D\u7F6E\u4E0D\u5B8C\u6574\u6216\u4E0D\u5B89\u5168\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458", 503);
    }
  }
  function credentials() {
    const cfg = settings();
    if (config?.credentialsRef === "bundled") {
      try {
        return bundledCredentials();
      } catch (caught) {
        token = void 0;
        throw caught;
      }
    }
    const explicit = config?.username !== void 0 || config?.password !== void 0;
    const username = explicit ? config?.username : process.env[cfg.usernameEnv];
    const password = explicit ? config?.password : process.env[cfg.passwordEnv];
    if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password.trim()) {
      token = void 0;
      throw error("config", "\u4F01\u4E1A\u6280\u80FD\u5E93\u51ED\u636E\u672A\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458", 503);
    }
    return { username, password };
  }
  async function bounded(response, limit, signal) {
    const reader = response.body?.getReader();
    if (!reader) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u54CD\u5E94\u65E0\u6548");
    let size = 0;
    const chunks = [];
    try {
      if (Number(response.headers.get("content-length")) > limit) throw error("size", "\u4F01\u4E1A\u6280\u80FD\u5E93\u54CD\u5E94\u8D85\u51FA\u5927\u5C0F\u9650\u5236");
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw error("size", "\u4F01\u4E1A\u6280\u80FD\u5E93\u54CD\u5E94\u8D85\u51FA\u5927\u5C0F\u9650\u5236");
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } catch (caught) {
      signal.throwIfAborted();
      if (caught instanceof TypeError && caught.cause && typeof caught.cause === "object" && "code" in caught.cause && typeof caught.cause.code === "string" && /^(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|BODY_TIMEOUT))$/.test(caught.cause.code)) {
        throw error("unavailable", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u8BF7\u6062\u590D\u7F51\u7EDC\u540E\u91CD\u8BD5");
      }
      throw caught;
    } finally {
      await reader.cancel().catch(() => void 0);
      reader.releaseLock();
    }
  }
  async function request(path, params, signal, auth, form, limit = 2 << 20) {
    const cfg = settings();
    const url = new URL(cfg.base + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response;
    try {
      response = await fetcher(url.href, {
        method: form ? "POST" : "GET",
        redirect: "error",
        signal,
        headers: { ...auth ? { Authorization: `Bearer ${auth}` } : {}, ...form ? { "content-type": "application/x-www-form-urlencoded" } : {} },
        ...form ? { body: form } : {}
      });
    } catch (caught) {
      if (caught instanceof TypeError && caught.cause) throw error("unavailable", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u8054\u7CFB\u7EF4\u62A4\u4EBA\u5458");
      throw caught;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => void 0);
      if (response.status === 401 || response.status === 403) {
        token = void 0;
        throw error("auth", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8BA4\u8BC1\u5931\u8D25\u6216\u53EA\u8BFB\u8D26\u53F7\u6743\u9650\u4E0D\u8DB3", 403);
      }
      if (response.status === 404) throw error("notFound", "\u6280\u80FD\u7248\u672C\u4E0D\u5B58\u5728\uFF0C\u6216\u670D\u52A1\u672A\u63D0\u4F9B Nacos 3.2 \u6280\u80FD\u63A5\u53E3", 404);
      throw error("unavailable", "\u4F01\u4E1A\u6280\u80FD\u5E93\u6682\u65F6\u4E0D\u53EF\u7528");
    }
    return bounded(response, limit, signal);
  }
  function json(bytes) {
    try {
      const v = JSON.parse(decodeUtf8(bytes, "response"));
      if (object(v)) return v;
    } catch (caught) {
      if (!(caught instanceof SyntaxError)) throw caught;
    }
    throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8FD4\u56DE\u65E0\u6548\u6570\u636E");
  }
  function decodeUtf8(bytes, code) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (caught) {
      if (!(caught instanceof TypeError) || !("code" in caught) || caught.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw caught;
      throw error(code, "\u4F01\u4E1A\u6280\u80FD\u5E93\u5185\u5BB9\u4E0D\u662F\u6709\u6548 UTF-8");
    }
  }
  async function access(signal) {
    const resolved = credentials();
    signal.throwIfAborted();
    const credentialKey = createHash("sha256").update(JSON.stringify([resolved.username, resolved.password])).digest("hex");
    if (token && token.until > Date.now() && token.credentialKey === credentialKey) return token.value;
    token = void 0;
    const pending = (async () => {
      const v = json(await request("/v3/auth/user/login", {}, signal, void 0, new URLSearchParams(resolved), 64 << 10));
      if (typeof v.accessToken !== "string" || !v.accessToken || /[\r\n]/.test(v.accessToken) || v.accessToken.length > 16384 || typeof v.tokenTtl !== "number" || !Number.isFinite(v.tokenTtl) || v.tokenTtl <= 0) throw error("auth", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8BA4\u8BC1\u54CD\u5E94\u65E0\u6548", 403);
      token = { value: v.accessToken, until: Date.now() + Math.max(0, Math.min(v.tokenTtl, 86400) * 1e3 - 3e4), credentialKey };
      return v.accessToken;
    })();
    return pending;
  }
  async function run(signal, action) {
    const combined = AbortSignal.any([AbortSignal.timeout(settings().timeout), ...signal ? [signal] : []]);
    try {
      combined.throwIfAborted();
      return await action(combined);
    } catch (caught) {
      if (signal?.aborted) throw error("cancelled", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8BF7\u6C42\u5DF2\u53D6\u6D88", 499);
      if (combined.aborted) throw error("timeout", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8BF7\u6C42\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5", 504);
      if (caught instanceof NacosError) throw caught;
      throw caught;
    }
  }
  async function online(item, name, version, signal, auth) {
    const namespace = settings().namespace;
    let meta = item;
    if (!Array.isArray(meta.versions)) {
      const result = json(await request("/v3/admin/ai/skills", { namespaceId: namespace, skillName: name }, signal, auth));
      if (result.code === 401 || result.code === 403) {
        token = void 0;
        throw error("auth", "\u4F01\u4E1A\u6280\u80FD\u5E93\u53EA\u8BFB\u8D26\u53F7\u6743\u9650\u4E0D\u8DB3", 403);
      }
      if (result.code !== 0 || !object(result.data)) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8BE6\u60C5\u683C\u5F0F\u4E0D\u517C\u5BB9");
      meta = result.data;
    }
    validateNamespace(meta, namespace);
    if (meta.name !== name) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u8BE6\u60C5\u540D\u79F0\u4E0D\u5339\u914D");
    return meta.enable === true && object(meta.labels) && meta.labels.latest === version && Array.isArray(meta.versions) && meta.versions.some((v) => object(v) && v.version === version && v.status === "online");
  }
  async function load(input, signal) {
    const selected = validateNacosSelection(input);
    return run(signal, async (combined) => {
      const cfg = settings();
      const auth = await access(combined);
      const metadata = json(await request("/v3/admin/ai/skills/list", { namespaceId: cfg.namespace, skillName: selected.name, search: "accurate", pageNo: "1", pageSize: "20" }, combined, auth));
      if (metadata.code === 401 || metadata.code === 403) {
        token = void 0;
        throw error("auth", "\u4F01\u4E1A\u6280\u80FD\u5E93\u53EA\u8BFB\u8D26\u53F7\u6743\u9650\u4E0D\u8DB3", 403);
      }
      if (metadata.code !== 0 || !object(metadata.data) || !Array.isArray(metadata.data.pageItems)) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u5217\u8868\u683C\u5F0F\u4E0D\u517C\u5BB9");
      const item = metadata.data.pageItems.find((item2) => object(item2) && item2.name === selected.name);
      if (object(item)) validateNamespace(item, cfg.namespace);
      if (!object(item) || item.enable !== true || !object(item.labels) || item.labels.latest !== selected.version || !await online(item, selected.name, selected.version, combined, auth)) throw error("notFound", "\u6280\u80FD\u7248\u672C\u5DF2\u53D8\u66F4\u3001\u4E0B\u7EBF\u6216\u672A\u53D1\u5E03\uFF0C\u8BF7\u5237\u65B0\u516C\u5171\u5E93", 404);
      const bytes = await request("/v3/client/ai/skills", { namespaceId: cfg.namespace, name: selected.name, version: selected.version }, combined, auth, void 0, 10 << 20);
      const entries = [];
      const seen = createPortablePathSet();
      let count = 0, total = 0;
      let files;
      try {
        files = await readZip(bytes, { filter(info) {
          const path = info.name.replace(/\/$/, "");
          const parts = path.split("/");
          if (!path || path.length > 512 || parts.length > 64 || parts.some((p) => !isPortableFileSegment(p))) throw 0;
          if (++count > 1e3 || info.originalSize > 32 << 20 || (total += info.originalSize) > 64 << 20 || !seen.add(path)) throw 0;
          return !info.name.endsWith("/");
        } });
      } catch (caught) {
        if (caught !== 0 && !(caught instanceof ZipReadError)) throw caught;
        throw error("package", "\u6280\u80FD ZIP \u5305\u65E0\u6548\u3001\u8DEF\u5F84\u4E0D\u5B89\u5168\u6216\u5927\u5C0F\u8D85\u9650");
      }
      const names = Object.keys(files);
      const prefix = names.includes("SKILL.md") ? "" : selected.name + "/";
      if (!names.length || names.some((p) => !p.startsWith(prefix)) || !files[prefix + "SKILL.md"] || files[prefix + "SKILL.md"].length > 256 << 10) throw error("package", "\u6280\u80FD\u5305\u5FC5\u987B\u53EA\u5305\u542B\u6240\u9009\u6280\u80FD\u53CA\u5176\u5B8C\u6574\u8D44\u6E90");
      const document = parseSkillDoc(decodeUtf8(files[prefix + "SKILL.md"], "package"));
      if (document.map.name !== selected.name || typeof document.map.description !== "string" || !document.map.description.trim() || !document.body.trim()) throw error("package", "\u6280\u80FD\u5305\u540D\u79F0\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4\uFF0C\u6216\u7F3A\u5C11\u6709\u6548\u8BF4\u660E");
      const digest = createHash("sha256");
      for (const name of names.sort()) {
        const path = name.slice(prefix.length);
        digest.update(JSON.stringify([path, createHash("sha256").update(files[name]).digest("hex")]));
        entries.push({ path, data: Buffer.from(files[name]).toString("base64") });
      }
      const id = identity(input);
      const detail = { ...selected, description: document.map.description, body: document.body, files: entries.map((e) => e.path), digest: digest.digest("hex") };
      return { id, pack: { name: selected.name, entries }, detail };
    });
  }
  return {
    async list(query = "", page = 1, signal) {
      if (typeof query !== "string" || query.length > 100 || /[\x00-\x1f]/.test(query) || !Number.isInteger(page) || page < 1 || page > 1e4) throw error("query", "\u641C\u7D22\u6761\u4EF6\u6216\u9875\u7801\u65E0\u6548", 400);
      if (!config) return { configured: false, items: [], total: 0, page, pageSize: 20 };
      return run(signal, async (combined) => {
        const namespace = settings().namespace;
        const auth = await access(combined);
        const v = json(await request("/v3/admin/ai/skills/list", { namespaceId: namespace, skillName: query, search: "blur", orderBy: "download_count", pageNo: String(page), pageSize: "20" }, combined, auth));
        if (v.code === 401 || v.code === 403) {
          token = void 0;
          throw error("auth", "\u4F01\u4E1A\u6280\u80FD\u5E93\u53EA\u8BFB\u8D26\u53F7\u6743\u9650\u4E0D\u8DB3", 403);
        }
        const data = v.data;
        if (v.code !== 0 || !object(data) || !Array.isArray(data.pageItems) || data.pageItems.length > 20 || !Number.isSafeInteger(data.totalCount) || Number(data.totalCount) < 0) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u5217\u8868\u683C\u5F0F\u4E0D\u517C\u5BB9");
        const items = [];
        for (const item of data.pageItems) {
          if (!object(item) || !validName(item.name) || typeof item.description !== "string" || item.description.length > 16384) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u6761\u76EE\u683C\u5F0F\u4E0D\u517C\u5BB9");
          if (item.enable !== true || item.labels == null) continue;
          if (!object(item.labels)) throw error("response", "\u4F01\u4E1A\u6280\u80FD\u5E93\u6761\u76EE\u683C\u5F0F\u4E0D\u517C\u5BB9");
          if (!validVersion(item.labels.latest)) continue;
          validateNamespace(item, namespace);
          if (!await online(item, item.name, item.labels.latest, combined, auth)) continue;
          items.push({
            name: item.name,
            description: item.description,
            version: item.labels.latest,
            namespaceId: namespace,
            ...Number.isSafeInteger(item.downloadCount) && Number(item.downloadCount) >= 0 ? { downloadCount: Number(item.downloadCount) } : {}
          });
        }
        return { configured: true, items, page, total: Number(data.totalCount), pageSize: 20 };
      });
    },
    async detail(input, signal) {
      return (await load(input, signal)).detail;
    },
    identity,
    load
  };
}
export {
  createNacosClient,
  validateNacosSelection
};
