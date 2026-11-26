// Compatibility parser for existing local records; no Git process or remote IO.
import type { CodedError,RepositoryInput,RepositorySource } from "./types.js";
function failure(message: string, code = "error.repo.invalid", params?: Record<string, unknown>): CodedError {
  return Object.assign(new Error(message), {
    code,
    statusCode: 400,
    ...(params && typeof params === "object" && !Array.isArray(params) ? { params } : {}),
  });
}

function safePath(value: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > 512 || (!value && !allowEmpty)) throw failure("仓库路径无效");
  if (!value) return value;
  const parts = value.split("/");
  if (
    parts.length > 64 ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[\\:<>\"|?*\x00-\x1f]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
    )
  ) {
    throw failure("仓库路径不安全");
  }
  return value;
}

export function parseGitUrl(input: RepositoryInput = {}): RepositorySource {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("仓库参数必须是对象");
  if (["ref", "subdirectory"].some((key) => input[key as keyof RepositoryInput] !== undefined && typeof input[key as keyof RepositoryInput] !== "string")) {
    throw failure("仓库分支和子目录必须是字符串");
  }
  let raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw || raw.length > 2048 || /[%?#\s]/.test(raw)) throw failure("仓库地址无效");
  const isLocalPath = raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw);
  if (!isLocalPath && /\\/.test(raw)) throw failure("仓库地址无效");
  if (raw.startsWith("-") || raw.includes("::")) throw failure("仓库地址不安全");
  if (/@/.test(raw)) throw failure("仓库地址不能包含用户名或密码");

  // 本地文件系统目录（支持测试环境或私有磁盘路径）
  if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) {
    const normalized = raw.replace(/\\/g, "/").replace(/\/$/, "");
    const parts = normalized.split("/");
    const name = (parts.pop() || "").replace(/\.git$/, "").toLowerCase();
    const owner = (parts.pop() || "local").toLowerCase();
    const ref = input.ref || "";
    const subdirectory = safePath(input.subdirectory || "", true);
    return { owner, name, ref, subdirectory, url: raw };
  }

  // GitHub 简写格式 owner/name
  if (!raw.includes("://")) {
    const parts = raw.replace(/\/$/, "").split("/");
    const owner = (parts[0] || "").toLowerCase();
    const name = (parts[1] || "").replace(/\.git$/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner) || !/^[a-z0-9_.-]{1,100}$/.test(name) || name === "." || name === ".." || parts.length !== 2) {
      throw failure("请输入公开 Git 仓库地址或 owner/repo");
    }
    const ref = input.ref || "";
    if (typeof ref !== "string" || ref.length > 200 || (ref && !/^[a-zA-Z0-9_./-]+$/.test(ref)) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
      throw failure("仓库分支无效");
    }
    const subdirectory = safePath(input.subdirectory || "", true);
    return { owner, name, ref, subdirectory };
  }

  // GitHub 官方标准 URL（保留原有无 url 字段的数据结构，保持历史 ID 不变）
  if (raw.startsWith("https://github.com/")) {
    const stripped = raw.slice(19);
    const parts = stripped.replace(/\/$/, "").split("/");
    const owner = (parts[0] || "").toLowerCase();
    const name = (parts[1] || "").replace(/\.git$/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner) || !/^[a-z0-9_.-]{1,100}$/.test(name) || name === "." || name === ".." || (parts.length > 2 && (parts[2] !== "tree" || !parts[3]))) {
      throw failure("请输入公开 GitHub 仓库地址或 owner/repo");
    }
    const ref = input.ref || parts[3] || "";
    if (typeof ref !== "string" || ref.length > 200 || (ref && !/^[a-zA-Z0-9_./-]+$/.test(ref)) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
      throw failure("仓库分支无效");
    }
    const subdirectory = safePath(input.subdirectory || parts.slice(4).join("/"), true);
    return { owner, name, ref, subdirectory };
  }

  // 通用 HTTPS / HTTP Git 仓库（如 Gitee、GitLab、自建 Git 服务、加速站前缀等）
  let urlObj: URL;
  try {
    urlObj = new URL(raw);
  } catch {
    throw failure("仓库地址无效");
  }
  if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") {
    throw failure("仅支持 HTTP 或 HTTPS 协议的 Git 仓库地址");
  }
  if (urlObj.hostname === "github.com" && urlObj.protocol !== "https:") {
    throw failure("GitHub 仓库仅支持 HTTPS 地址");
  }
  if (urlObj.hostname.startsWith("github.com.") || urlObj.hostname.endsWith(".evil")) {
    throw failure("仓库地址无效");
  }
  if (urlObj.username || urlObj.password) {
    throw failure("仓库地址不能包含用户名或密码");
  }
  if (!urlObj.hostname || urlObj.hostname.startsWith("-")) {
    throw failure("仓库地址无效");
  }

  let pathname = urlObj.pathname;
  let extractedRef = "";
  let extractedSubdir = "";

  // 识别并解构常见的代理/镜像前缀（如 https://gh-proxy.com/https://github.com/owner/name）
  let targetPath = pathname;
  const proxyMatch = raw.match(/^https?:\/\/[^/]+\/(https?:\/\/.+)$/i) || raw.match(/^https?:\/\/[^/]+\/(github\.com\/.+)$/i);
  if (proxyMatch) {
    try {
      const innerUrl = proxyMatch[1].startsWith("http") ? new URL(proxyMatch[1]) : new URL("https://" + proxyMatch[1]);
      targetPath = innerUrl.pathname;
    } catch {
      // 保持原有 pathname
    }
  }

  const treeMarkers = ["/-/tree/", "/-/blob/", "/src/branch/", "/src/tag/", "/tree/"];
  for (const marker of treeMarkers) {
    const idx = targetPath.indexOf(marker);
    if (idx !== -1) {
      const rest = targetPath.slice(idx + marker.length);
      targetPath = targetPath.slice(0, idx);
      const slash = rest.indexOf("/");
      if (slash !== -1) {
        extractedRef = decodeURIComponent(rest.slice(0, slash));
        extractedSubdir = decodeURIComponent(rest.slice(slash + 1));
      } else {
        extractedRef = decodeURIComponent(rest);
      }
      break;
    }
  }

  targetPath = targetPath.replace(/\/$/, "");
  const segments = targetPath.split("/").filter(Boolean);
  if (!segments.length) throw failure("仓库地址无效");
  const rawName = segments[segments.length - 1].replace(/\.git$/, "");
  const name = rawName.toLowerCase();
  if (!name || name === "." || name === "..") throw failure("仓库名称无效");

  const ownerSegments = segments.slice(0, -1);
  const owner = (ownerSegments.length ? ownerSegments.join("/") : urlObj.hostname).toLowerCase();

  const ref = input.ref || extractedRef || "";
  if (typeof ref !== "string" || ref.length > 200 || (ref && !/^[a-zA-Z0-9_./-]+$/.test(ref)) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
    throw failure("仓库分支无效");
  }
  const subdirectory = safePath(input.subdirectory || extractedSubdir || "", true);
  return { owner, name, ref, subdirectory, url: raw };
}
