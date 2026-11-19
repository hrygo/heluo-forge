import { promises as fs } from "node:fs";
function isPortableFileSegment(segment) {
  return !!segment && segment !== "." && segment !== ".." && !/[\\/:<>"|?*\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment);
}
function portablePathKey(path) {
  return path.normalize("NFC").toLowerCase();
}
function createPortablePathSet() {
  const entries = /* @__PURE__ */ new Set();
  const prefixes = /* @__PURE__ */ new Map();
  return {
    add(path) {
      const key = portablePathKey(path);
      if (entries.has(key)) return false;
      let prefix = "";
      for (const segment of path.split("/")) {
        prefix = prefix ? prefix + "/" + segment : segment;
        const identity = portablePathKey(prefix);
        const previous = prefixes.get(identity);
        if (previous !== void 0 && previous !== prefix) return false;
        prefixes.set(identity, prefix);
      }
      entries.add(key);
      return true;
    }
  };
}
function isMacSystemDirectoryAlias(path, target, platform) {
  return platform === "darwin" && ["/tmp", "/var", "/etc"].includes(path) && (target === "/private" + path || target === "private" + path);
}
async function isSafeAncestorDirectory(path, info) {
  if (!info.isSymbolicLink()) return info.isDirectory();
  if (process.platform !== "darwin") return false;
  return isMacSystemDirectoryAlias(path, await fs.readlink(path), process.platform) && (await fs.stat(path)).isDirectory();
}
export {
  createPortablePathSet,
  isMacSystemDirectoryAlias,
  isPortableFileSegment,
  isSafeAncestorDirectory,
  portablePathKey
};
