function failure(message, code = "error.repo.invalid", params) {
  return Object.assign(new Error(message), {
    code,
    statusCode: 400,
    ...params && typeof params === "object" && !Array.isArray(params) ? { params } : {}
  });
}
function safePath(value, allowEmpty = false) {
  if (typeof value !== "string" || value.length > 512 || !value && !allowEmpty) throw failure("\u4ED3\u5E93\u8DEF\u5F84\u65E0\u6548");
  if (!value) return value;
  const parts = value.split("/");
  if (parts.length > 64 || parts.some(
    (p) => !p || p === "." || p === ".." || /[\\:<>\"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
  )) {
    throw failure("\u4ED3\u5E93\u8DEF\u5F84\u4E0D\u5B89\u5168");
  }
  return value;
}
function parseGitUrl(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("\u4ED3\u5E93\u53C2\u6570\u5FC5\u987B\u662F\u5BF9\u8C61");
  if (["ref", "subdirectory"].some((key) => input[key] !== void 0 && typeof input[key] !== "string")) {
    throw failure("\u4ED3\u5E93\u5206\u652F\u548C\u5B50\u76EE\u5F55\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  }
  let raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw || raw.length > 2048 || /[%?#\s]/.test(raw)) throw failure("\u4ED3\u5E93\u5730\u5740\u65E0\u6548");
  const isLocalPath = raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw);
  if (!isLocalPath && /\\/.test(raw)) throw failure("\u4ED3\u5E93\u5730\u5740\u65E0\u6548");
  if (raw.startsWith("-") || raw.includes("::")) throw failure("\u4ED3\u5E93\u5730\u5740\u4E0D\u5B89\u5168");
  if (/@/.test(raw)) throw failure("\u4ED3\u5E93\u5730\u5740\u4E0D\u80FD\u5305\u542B\u7528\u6237\u540D\u6216\u5BC6\u7801");
  if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) {
    const normalized = raw.replace(/\\/g, "/").replace(/\/$/, "");
    const parts = normalized.split("/");
    const name2 = (parts.pop() || "").replace(/\.git$/, "").toLowerCase();
    const owner2 = (parts.pop() || "local").toLowerCase();
    const ref2 = input.ref || "";
    const subdirectory2 = safePath(input.subdirectory || "", true);
    return { owner: owner2, name: name2, ref: ref2, subdirectory: subdirectory2, url: raw };
  }
  if (!raw.includes("://")) {
    const parts = raw.replace(/\/$/, "").split("/");
    const owner2 = (parts[0] || "").toLowerCase();
    const name2 = (parts[1] || "").replace(/\.git$/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner2) || !/^[a-z0-9_.-]{1,100}$/.test(name2) || name2 === "." || name2 === ".." || parts.length !== 2) {
      throw failure("\u8BF7\u8F93\u5165\u516C\u5F00 Git \u4ED3\u5E93\u5730\u5740\u6216 owner/repo");
    }
    const ref2 = input.ref || "";
    if (typeof ref2 !== "string" || ref2.length > 200 || ref2 && !/^[a-zA-Z0-9_./-]+$/.test(ref2) || ref2.includes("..") || ref2.startsWith("/") || ref2.endsWith("/")) {
      throw failure("\u4ED3\u5E93\u5206\u652F\u65E0\u6548");
    }
    const subdirectory2 = safePath(input.subdirectory || "", true);
    return { owner: owner2, name: name2, ref: ref2, subdirectory: subdirectory2 };
  }
  if (raw.startsWith("https://github.com/")) {
    const stripped = raw.slice(19);
    const parts = stripped.replace(/\/$/, "").split("/");
    const owner2 = (parts[0] || "").toLowerCase();
    const name2 = (parts[1] || "").replace(/\.git$/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner2) || !/^[a-z0-9_.-]{1,100}$/.test(name2) || name2 === "." || name2 === ".." || parts.length > 2 && (parts[2] !== "tree" || !parts[3])) {
      throw failure("\u8BF7\u8F93\u5165\u516C\u5F00 GitHub \u4ED3\u5E93\u5730\u5740\u6216 owner/repo");
    }
    const ref2 = input.ref || parts[3] || "";
    if (typeof ref2 !== "string" || ref2.length > 200 || ref2 && !/^[a-zA-Z0-9_./-]+$/.test(ref2) || ref2.includes("..") || ref2.startsWith("/") || ref2.endsWith("/")) {
      throw failure("\u4ED3\u5E93\u5206\u652F\u65E0\u6548");
    }
    const subdirectory2 = safePath(input.subdirectory || parts.slice(4).join("/"), true);
    return { owner: owner2, name: name2, ref: ref2, subdirectory: subdirectory2 };
  }
  let urlObj;
  try {
    urlObj = new URL(raw);
  } catch {
    throw failure("\u4ED3\u5E93\u5730\u5740\u65E0\u6548");
  }
  if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") {
    throw failure("\u4EC5\u652F\u6301 HTTP \u6216 HTTPS \u534F\u8BAE\u7684 Git \u4ED3\u5E93\u5730\u5740");
  }
  if (urlObj.hostname === "github.com" && urlObj.protocol !== "https:") {
    throw failure("GitHub \u4ED3\u5E93\u4EC5\u652F\u6301 HTTPS \u5730\u5740");
  }
  if (urlObj.hostname.startsWith("github.com.") || urlObj.hostname.endsWith(".evil")) {
    throw failure("\u4ED3\u5E93\u5730\u5740\u65E0\u6548");
  }
  if (urlObj.username || urlObj.password) {
    throw failure("\u4ED3\u5E93\u5730\u5740\u4E0D\u80FD\u5305\u542B\u7528\u6237\u540D\u6216\u5BC6\u7801");
  }
  if (!urlObj.hostname || urlObj.hostname.startsWith("-")) {
    throw failure("\u4ED3\u5E93\u5730\u5740\u65E0\u6548");
  }
  let pathname = urlObj.pathname;
  let extractedRef = "";
  let extractedSubdir = "";
  let targetPath = pathname;
  const proxyMatch = raw.match(/^https?:\/\/[^/]+\/(https?:\/\/.+)$/i) || raw.match(/^https?:\/\/[^/]+\/(github\.com\/.+)$/i);
  if (proxyMatch) {
    try {
      const innerUrl = proxyMatch[1].startsWith("http") ? new URL(proxyMatch[1]) : new URL("https://" + proxyMatch[1]);
      targetPath = innerUrl.pathname;
    } catch {
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
  if (!segments.length) throw failure("\u4ED3\u5E93\u5730\u5740\u65E0\u6548");
  const rawName = segments[segments.length - 1].replace(/\.git$/, "");
  const name = rawName.toLowerCase();
  if (!name || name === "." || name === "..") throw failure("\u4ED3\u5E93\u540D\u79F0\u65E0\u6548");
  const ownerSegments = segments.slice(0, -1);
  const owner = (ownerSegments.length ? ownerSegments.join("/") : urlObj.hostname).toLowerCase();
  const ref = input.ref || extractedRef || "";
  if (typeof ref !== "string" || ref.length > 200 || ref && !/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
    throw failure("\u4ED3\u5E93\u5206\u652F\u65E0\u6548");
  }
  const subdirectory = safePath(input.subdirectory || extractedSubdir || "", true);
  return { owner, name, ref, subdirectory, url: raw };
}
export {
  parseGitUrl
};
