
import type { Archive,FileDigest,RepositoryRoot,SkillRoot } from "./types.js";
// Local installation identities, complete file digests and safe root resolution.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname,join,resolve } from "node:path";
import type { indexRegisteredWorkspaces } from "./core.js";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const repositoryInstallKeys = new Set(["dsh", "agents"]);
/** 纯静态判定是否为合法的仓库安装来源键，专供持久化数据格式校验。 */
export function isRepositoryRootKey(key: unknown): boolean {
  const normalized = key === undefined ? "dsh" : key;
  if (typeof normalized !== "string") return false;
  if (normalized.startsWith("preset-") || normalized === "preset") return true;
  return repositoryInstallKeys.has(normalized);
}
export function createInstallationRecords(local: typeof import('./core.js')) {
const { checkedRepositoryRootDefinition,projectRootForRecord,userRoots } = local;
/** 解析 DSH、公共 Agent 以及用户自建的自定义预设模式。缺省和旧记录都属于 DSH。 */
function repositoryInstallRoot(key: unknown = "dsh", presetRoots?: SkillRoot[]) {
  const normalized = key === undefined ? "dsh" : key;
  if (typeof normalized !== "string") throw failure("技能安装位置无效");
  if (normalized.startsWith("preset-") || normalized === "preset") {
    if (presetRoots) {
      const preset = presetRoots.find((item) => item.key === normalized);
      if (preset && preset.mutable && preset.native === false) {
        return { ...preset, key: preset.key as RepositoryRoot };
      }
    }
    throw failure("技能安装位置无效");
  }
  if (!repositoryInstallKeys.has(normalized)) throw failure("技能安装位置无效");
  const root = userRoots().find(item => item.key === normalized);
  if (!root) throw failure("技能安装位置无效");
  return { ...root, key: root.key as RepositoryRoot };
}
/**
 * 解析安装记录所在的可写根：工作区记录按保存的项目根重新校验，其余走用户目录或预设目录。
 * 返回值的 path 即技能所在目录；工作区路径失效时抛出明确错误，不回退到全局。
 */
async function recordInstallRoot(record: { root?: unknown; workspace?: string }, registered?: string[], indexed?: Awaited<ReturnType<typeof indexRegisteredWorkspaces>>, presetRoots?: SkillRoot[]) {
  if (record.workspace === undefined) {
    const root = repositoryInstallRoot(record.root, presetRoots);
    const checked = await checkedRepositoryRootDefinition(root);
    if (!checked) throw failure("技能安装位置不可用", "error.root.unsafe");
    if (checked.ok === false) throw Object.assign(failure(checked.error, checked.code || "error.root.unsafe"), { params: checked.params });
    return root;
  }
  const resolved = await projectRootForRecord(record.workspace, registered, indexed);
  if ("ok" in resolved && resolved.ok === false) throw Object.assign(failure(resolved.error, resolved.code || "error.workspace.unavailable"), { params: resolved.params });
  return (resolved as { root: any }).root;
}
return { repositoryInstallRoot,recordInstallRoot };
}
const targetIdentity = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
export const installationSourceKey = (rootPath: string, name: string) => JSON.stringify([targetIdentity(rootPath), name]);
export const fileIndex = (entries: Archive) => Object.entries(entries!).map(([path, bytes]) => ({ path, hash: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path, "en"));
export const signature = (files: FileDigest[]) => hash(JSON.stringify([...files].map(({ path, hash }) => ({ path, hash })).sort((a, b) => a.path.localeCompare(b.path, "en"))));
function failure(message: string, code = "error.repo.invalid") { return Object.assign(new Error(message), { code, statusCode: 400 }); }
function safePath(path: string) {
  if (typeof path !== "string" || !path || path.length > 512 || path.split("/").length > 64 || path.split("/").some(p => !p || p === "." || p === ".." || /[\\:<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw failure("技能文件路径无效");
}
async function safeDirectory(root: string) {
  for (let p = root; ; p = dirname(p)) {
    const info = await fs.lstat(p);
    if (info.isSymbolicLink() || !info.isDirectory()) throw failure("技能或备份目录包含链接");
    if (dirname(p) === p) break;
  }
}
/** 完整读取目录，新增文件参与冲突检测，禁止跟随链接。 */
export async function readSkillTree(root: string) {
  await safeDirectory(root);
  const result: Archive = Object.create(null); let size = 0, count = 0;
  async function walk(dir: string, prefix = "") {
    for (const entry of await fs.readdir(dir)) {
      const path = prefix + entry; safePath(path);
      if (++count > 2000) throw failure("技能目录数量超限");
      const target = join(dir, entry), info = await fs.lstat(target);
      if (info.isSymbolicLink()) throw failure("技能包含链接，拒绝更新");
      if (info.isDirectory()) await walk(target, path + "/");
      else {
        if (!info.isFile() || info.size > 32 << 20 || (size += info.size) > 64 << 20 || Object.keys(result).length >= 1000) throw failure("技能文件数量或大小超限");
        result[path] = await fs.readFile(target);
      }
    }
  }
  await walk(root); return result;
}
