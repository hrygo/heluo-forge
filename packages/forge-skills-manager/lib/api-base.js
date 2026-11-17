function pageBaseHref() {
  if (typeof document === "undefined") return void 0;
  const raw = document.baseURI;
  if (typeof raw !== "string" || raw === "") return void 0;
  try {
    const url = new URL(raw);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  } catch {
    return void 0;
  }
}
function resolveApiUrl(path) {
  if (typeof path !== "string" || path.charAt(0) !== "/" || path.charAt(1) === "/") return path;
  const base = pageBaseHref();
  if (base === void 0) return path;
  try {
    return new URL(path.slice(1), base).href;
  } catch {
    return path;
  }
}
export {
  resolveApiUrl
};
