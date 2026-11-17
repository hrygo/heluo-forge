import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repositoryInstallKeys = /* @__PURE__ */ new Set(["dsh", "agents"]);
function isRepositoryRootKey(key) {
  const normalized = key === void 0 ? "dsh" : key;
  if (typeof normalized !== "string") return false;
  if (normalized.startsWith("preset-") || normalized === "preset") return true;
  return repositoryInstallKeys.has(normalized);
}
function createInstallationRecords(local) {
  const { checkedRepositoryRootDefinition, projectRootForRecord, userRoots } = local;
  function repositoryInstallRoot(key = "dsh", presetRoots) {
    const normalized = key === void 0 ? "dsh" : key;
    if (typeof normalized !== "string") throw failure("\u6280\u80FD\u5B89\u88C5\u4F4D\u7F6E\u65E0\u6548");
    if (normalized.startsWith("preset-") || normalized === "preset") {
      if (presetRoots) {
        const preset = presetRoots.find((item) => item.key === normalized);
        if (preset && preset.mutable && preset.native === false) {
          return { ...preset, key: preset.key };
        }
      }
      throw failure("\u6280\u80FD\u5B89\u88C5\u4F4D\u7F6E\u65E0\u6548");
    }
    if (!repositoryInstallKeys.has(normalized)) throw failure("\u6280\u80FD\u5B89\u88C5\u4F4D\u7F6E\u65E0\u6548");
    const root = userRoots().find((item) => item.key === normalized);
    if (!root) throw failure("\u6280\u80FD\u5B89\u88C5\u4F4D\u7F6E\u65E0\u6548");
    return { ...root, key: root.key };
  }
  async function recordInstallRoot(record, registered, indexed, presetRoots) {
    if (record.workspace === void 0) {
      const root = repositoryInstallRoot(record.root, presetRoots);
      const checked = await checkedRepositoryRootDefinition(root);
      if (!checked) throw failure("\u6280\u80FD\u5B89\u88C5\u4F4D\u7F6E\u4E0D\u53EF\u7528", "error.root.unsafe");
      if (checked.ok === false) throw Object.assign(failure(checked.error, checked.code || "error.root.unsafe"), { params: checked.params });
      return root;
    }
    const resolved = await projectRootForRecord(record.workspace, registered, indexed);
    if ("ok" in resolved && resolved.ok === false) throw Object.assign(failure(resolved.error, resolved.code || "error.workspace.unavailable"), { params: resolved.params });
    return resolved.root;
  }
  return { repositoryInstallRoot, recordInstallRoot };
}
const targetIdentity = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const installationSourceKey = (rootPath, name) => JSON.stringify([targetIdentity(rootPath), name]);
const fileIndex = (entries) => Object.entries(entries).map(([path, bytes]) => ({ path, hash: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path, "en"));
const signature = (files) => hash(JSON.stringify([...files].map(({ path, hash: hash2 }) => ({ path, hash: hash2 })).sort((a, b) => a.path.localeCompare(b.path, "en"))));
function failure(message, code = "error.repo.invalid") {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}
function safePath(path) {
  if (typeof path !== "string" || !path || path.length > 512 || path.split("/").length > 64 || path.split("/").some((p) => !p || p === "." || p === ".." || /[\\:<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw failure("\u6280\u80FD\u6587\u4EF6\u8DEF\u5F84\u65E0\u6548");
}
async function safeDirectory(root) {
  for (let p = root; ; p = dirname(p)) {
    const info = await fs.lstat(p);
    if (info.isSymbolicLink() || !info.isDirectory()) throw failure("\u6280\u80FD\u6216\u5907\u4EFD\u76EE\u5F55\u5305\u542B\u94FE\u63A5");
    if (dirname(p) === p) break;
  }
}
async function readSkillTree(root) {
  await safeDirectory(root);
  const result = /* @__PURE__ */ Object.create(null);
  let size = 0, count = 0;
  async function walk(dir, prefix = "") {
    for (const entry of await fs.readdir(dir)) {
      const path = prefix + entry;
      safePath(path);
      if (++count > 2e3) throw failure("\u6280\u80FD\u76EE\u5F55\u6570\u91CF\u8D85\u9650");
      const target = join(dir, entry), info = await fs.lstat(target);
      if (info.isSymbolicLink()) throw failure("\u6280\u80FD\u5305\u542B\u94FE\u63A5\uFF0C\u62D2\u7EDD\u66F4\u65B0");
      if (info.isDirectory()) await walk(target, path + "/");
      else {
        if (!info.isFile() || info.size > 32 << 20 || (size += info.size) > 64 << 20 || Object.keys(result).length >= 1e3) throw failure("\u6280\u80FD\u6587\u4EF6\u6570\u91CF\u6216\u5927\u5C0F\u8D85\u9650");
        result[path] = await fs.readFile(target);
      }
    }
  }
  await walk(root);
  return result;
}
export {
  createInstallationRecords,
  fileIndex,
  installationSourceKey,
  isRepositoryRootKey,
  readSkillTree,
  signature
};
