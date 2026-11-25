
import type { CatalogInstallation,CatalogInstallRecord,CodedError,InstallRecord,InstallSource,Log,MutationOptions,RepositoryState,SkillRoot } from "./types.js";
// Local installation, recovery and trash transactions. Historical records stay readable.
import { createHash,randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join,resolve } from "node:path";
import type { indexRegisteredWorkspaces } from "./core.js";
import type { InstallationPort } from "./local-ports.js";
import type { MutationInspection } from "./install-operations.js";
import { isExpectedOperationError } from "./operation-errors.js";
import { createInstallationRecords,fileIndex,installationSourceKey,isRepositoryRootKey,readSkillTree,signature } from "./installation-records.js";
import { parseGitUrl } from "./legacy-sources.js";


const STATE_LIMIT = 16 << 20;
const STATE_READ_LIMIT = 64 << 20;
const queuesKey = Symbol.for("heluo.forge-skills-manager.installations");
const queues = ((globalThis as typeof globalThis & { [queuesKey]?: Map<string, Promise<unknown>> })[queuesKey] ??= new Map());
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function failure(message: string, code = "error.repo.invalid", params?: unknown) {
  return Object.assign(new Error(message), { code, statusCode: 400, ...(params && typeof params === "object" && !Array.isArray(params) ? { params } : {}) });
}
function safePath(value: string, allowEmpty = false) {
  if (typeof value !== "string" || value.length > 512 || (!value && !allowEmpty)) throw failure("仓库路径无效");
  if (!value) return value;
  const parts = value.split("/");
  if (parts.length > 64 || parts.some((p) => !p || p === "." || p === ".." || /[\\:<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw failure("仓库路径不安全");
  return value;
}

function validateStoredState(input: unknown): asserts input is RepositoryState {
  // 所有字段仍逐项运行时验证；断言仅在全部检查通过后生效。
  const value = input as RepositoryState;
  if (!value || value.version !== 1 || !Array.isArray(value.repositories) || value.repositories.length > 30 || !Array.isArray(value.installs)) throw failure("仓库状态格式无效");
  for (const repo of value.repositories) {
    if (!repo || typeof repo.id !== "string" || !Array.isArray(repo.skills) || repo.skills.length > 500) throw failure("仓库状态格式无效");
    const source = parseGitUrl({ url: repo.url || `${repo.owner}/${repo.name}`, ref: repo.ref, subdirectory: repo.subdirectory });
    const expectedId = hash(JSON.stringify(source)).slice(0, 24);
    if (expectedId !== repo.id || (repo.commit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repo.commit))) throw failure("仓库状态来源无效");
    for (const skill of repo.skills) {
      if (!skill || typeof skill.name !== "string" || typeof skill.description !== "string" || typeof skill.body !== "string" || typeof skill.valid !== "boolean" || !/^[a-f0-9]{64}$/.test(skill.documentHash)) throw failure("仓库技能状态无效");
      safePath(skill.path, true);
    }
  }
  for (const record of value.installs) {
    if (!record || typeof record.id !== "string" || typeof record.complete !== "boolean" || !Array.isArray(record.files) || !record.files.length || record.files.length > 1000 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.commit || "")) throw failure("仓库安装记录无效");
    if (!isRepositoryRootKey(record.root)) throw failure("技能安装位置无效");
    if (record.workspace !== undefined && (typeof record.workspace !== "string" || !record.workspace || record.workspace.length > 1024 || record.root === "agents")) throw failure("仓库安装工作区无效");
    if (record.trashId !== undefined && (typeof record.trashId !== "string" || !/^\d+-[a-f0-9-]{36}$/.test(record.trashId))) throw failure("仓库回收记录无效");
    if (record.restoreFingerprint !== undefined && (typeof record.restoreFingerprint !== "string" || !record.trashId || !/^[a-f0-9]{64}$/.test(record.restoreFingerprint))) throw failure("仓库恢复记录无效");
    if (record.uninstallFingerprint !== undefined && (!record.trashId || !/^[a-f0-9]{64}$/.test(record.uninstallFingerprint))) throw failure("仓库卸载记录无效");
    safePath(record.path, true);
    safePath(record.name);
    if (record.name.includes("/")) throw failure("仓库安装名称无效");
    for (const entry of record.files) {
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.hash)) throw failure("仓库安装摘要无效");
      safePath(entry.path);
    }
  }
  if (value.catalogInstalls !== undefined) {
    if (!Array.isArray(value.catalogInstalls)) throw failure("目录安装状态格式无效");
    for (const item of value.catalogInstalls) {
      if (typeof item === "string") {
        if (!/^(?:clawhub|skillsh):[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,2}$/.test(item)) throw failure("目录安装记录格式无效");
      } else if (item && typeof item === "object") {
        if (typeof item.id !== "string" || !/^(?:nacos:[a-f0-9]{64}$|(?:clawhub|skillsh):[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,2}$)/.test(item.id)) throw failure("目录安装记录格式无效");
        if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 128) throw failure("目录安装技能名称无效");
        safePath(item.name);
        if (item.name.includes("/")) throw failure("目录安装技能名称无效");
        if (item.root !== undefined && !isRepositoryRootKey(item.root)) throw failure("技能安装位置无效");
        if (item.workspace !== undefined && (item.root !== "dsh" || typeof item.workspace !== "string" || !item.workspace || item.workspace.length > 1024)) throw failure("目录安装工作区无效");
        if (item.trashId !== undefined && (typeof item.trashId !== "string" || !/^\d+-[a-f0-9-]{36}$/.test(item.trashId))) throw failure("目录回收记录无效");
        if (item.restoreFingerprint !== undefined && (!item.trashId || !/^[a-f0-9]{64}$/.test(item.restoreFingerprint))) throw failure("目录恢复记录无效");
        if (item.disabledOnInstall !== undefined && typeof item.disabledOnInstall !== "boolean") throw failure("目录安装策略无效");
        if (item.complete !== undefined && typeof item.complete !== "boolean") throw failure("目录安装确认状态无效");
        if (item.complete === false && (!item.root || !item.files?.length)) throw failure("目录安装意图无效");
        if (item.files !== undefined) {
          if (!Array.isArray(item.files) || !item.files.length || item.files.length > 1000) throw failure("目录安装摘要无效");
          for (const file of item.files) {
            if (!file || !/^[a-f0-9]{64}$/.test(file.hash)) throw failure("目录安装摘要无效");
            safePath(file.path);
          }
        }
      } else {
        throw failure("目录安装记录格式无效");
      }
    }
  }
  if (value.pendingTrashDeletes !== undefined) {
    // 每个事务会触发若干次 lstat，条数必须有上限；但上限过低会让磁盘故障期间
    // 累积的事务把整份状态判为损坏、连页面都打不开，所以放宽到 256 同时仍是有界的。
    if (!Array.isArray(value.pendingTrashDeletes) || value.pendingTrashDeletes.length > 256) throw failure("永久删除事务无效");
    const ids = new Set<string>();
    for (const pending of value.pendingTrashDeletes) {
      if (!pending || typeof pending.id !== "string" || !/^\d+-[a-f0-9-]{36}$/.test(pending.id) || ids.has(pending.id) || !Array.isArray(pending.installs) || !Array.isArray(pending.catalogInstalls) || !pending.installs.length && !pending.catalogInstalls.length) throw failure("永久删除事务无效");
      ids.add(pending.id);
      if ([...pending.installs, ...pending.catalogInstalls].some(record => !record || record.trashId !== pending.id) || value.installs.some(record => record.trashId === pending.id) || value.catalogInstalls?.some(record => typeof record !== "string" && record.trashId === pending.id)) throw failure("永久删除事务身份无效");
      validateStoredState({ version: 1, repositories: [], installs: pending.installs, catalogInstalls: pending.catalogInstalls });
    }
  }
}

export function createInstallationManager({ local, log, registeredWorkspaces, onWorkspaceIndexBuild, getPresetRoots }: {
  local: InstallationPort;
  log?: Log; registeredWorkspaces?: () => string[] | undefined;
  onWorkspaceIndexBuild?: () => void; getPresetRoots?: () => Promise<SkillRoot[] | undefined>;
}) {
  const { createWorkspaceIndex,deleteSkill,importUploadedSkill,listTrash,managerHomePath,permanentlyDeleteTrash,readManagerState,resolveWorkspaceTarget,restoreTrash: restoreSkillTrash,setSkillEnabled,trashRootPath } = local;
  const { recordInstallRoot,repositoryInstallRoot } = createInstallationRecords(local);
  const fetchPresetRoots = async () => (getPresetRoots ? (await getPresetRoots()) || [] : []);
  const file = join(managerHomePath(), "repositories.json");
  const managerPath = resolve(managerHomePath());
  const queueKey = process.platform === "win32" ? managerPath.toLowerCase() : managerPath;
  let catalogWarnings: Array<{ id: string; code: string; error: string }> = [];
  let activeIndex: ReturnType<typeof createWorkspaceIndex> | undefined;
  const serialize = <T>(task: () => T | Promise<T>, recover = true, recoverDeletes = true): Promise<T> => {
    const run = async () => {
      stateCache = undefined;
      const index = createWorkspaceIndex(registeredWorkspaces?.(), { onBuild: onWorkspaceIndexBuild });
      const previous = activeIndex;
      activeIndex = index;
      try {
        if (recoverDeletes) await recoverTrashDeletes(await preloadedState());
        if (recover) await recoverPending(await preloadedState());
        return await task();
      } finally { activeIndex = previous; }
    };
    const next = (queues.get(queueKey) ?? Promise.resolve()).then(run, run);
    queues.set(queueKey, next);
    const release = () => { if (queues.get(queueKey) === next) queues.delete(queueKey); };
    void next.then(release, release);
    return next;
  };
  function requestIndex() { return activeIndex ?? createWorkspaceIndex(registeredWorkspaces?.(), { onBuild: onWorkspaceIndexBuild }); }
  async function indexedFor(record: { workspace?: string }) { return record.workspace === undefined ? undefined : requestIndex().load(); }
  const resolveInstallRoot = async (
    record: { root?: unknown; workspace?: string },
    registered?: string[],
    indexed?: Awaited<ReturnType<typeof indexRegisteredWorkspaces>>,
    presetRoots?: SkillRoot[],
  ) => {
    const presets = presetRoots ?? await fetchPresetRoots();
    return recordInstallRoot(record, registered, indexed, presets);
  };
  async function read(): Promise<RepositoryState> {
    try {
      const homeInfo = await fs.lstat(managerHomePath());
      if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) throw failure("仓库状态目录不安全");
      const info = await fs.lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > STATE_READ_LIMIT) throw failure("仓库状态文件不安全");
      const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      validateStoredState(value);
      for (const repo of value.repositories) {
        if (repo.url) {
          try {
            const fresh = parseGitUrl({ url: repo.url, ref: repo.ref, subdirectory: repo.subdirectory });
            repo.owner = fresh.owner;
            repo.name = fresh.name;
          } catch (error) { if (!isExpectedOperationError(error)) throw error; }
        }
      }
      return value;
    } catch (caught) { const error = caught as CodedError;
      if (!(caught instanceof SyntaxError) && !isExpectedOperationError(caught)) throw caught;
      if (error.code === "ENOENT") return { version: 1, repositories: [], installs: [] };
      throw failure("仓库状态文件损坏或无法读取，请保留文件并修复后重试", "error.repo.state");
    }
  }
  async function write(value: RepositoryState, allowShrink = false, deleteCommit?: RepositoryState, compact = false) {
    validateStoredState(value);
    // 只有永久删除事务用紧凑格式腾出临时空间。其他清理路径必须保持缩进，
    // 否则「压缩后必然变小」会让 16 MiB 闸门对它们形同虚设。
    const indent = compact ? undefined : 2;
    const text = JSON.stringify(value, null, indent);
    const bytes = Buffer.byteLength(text, "utf8");
    const currentBytes = allowShrink ? await currentStateBytes() : 0;
    // The prepared delete can grow briefly, but only if its exact commit shrinks
    // the pre-transaction file; the hard read limit still applies to both writes.
    const commitBytes = deleteCommit ? Buffer.byteLength(JSON.stringify(deleteCommit, null, indent), "utf8") : Infinity;
    if (bytes > STATE_READ_LIMIT || bytes > STATE_LIMIT && !(allowShrink && (bytes < currentBytes || deleteCommit && commitBytes < currentBytes))) throw failure("安装来源状态超过 16 MiB。请先清理不需要的回收记录或旧身份，仍有效的安装副本会保留。", "error.repo.capacity");
    await fs.mkdir(managerHomePath(), { recursive: true });
    if ((await fs.lstat(managerHomePath())).isSymbolicLink()) throw failure("仓库状态目录不能是链接");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, file);
      // 失效缓存是防呆：当前所有写入都是就地改缓存里的同一个对象，这次清空观察不到差别；
      // 留给将来把写出对象做成副本的调用方，避免它们读到写盘前的解析结果。
      stateGeneration += 1;
      stateCache = undefined;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function currentStateBytes() {
    try { return (await fs.lstat(file)).size; } catch (error) { if (isExpectedOperationError(error) && error.code === "ENOENT") return 0; throw error; }
  }
  // 同一次 serialize 内复用同一次解析：恢复流程与任务体都要读状态，重复解析在
  // 接近 16 MiB 时是每请求上百毫秒。
  // 作用域严格是一次请求：run 开始时清空、每次写盘后清空。否则写失败留下的
  // 脏对象会被下一次请求当成真实状态复用，恢复重试就被静默吞掉了。
  let stateGeneration = 0;
  let stateCache: { generation: number; value: RepositoryState } | undefined;
  async function preloadedState(): Promise<RepositoryState> {
    if (stateCache && stateCache.generation === stateGeneration) return stateCache.value;
    const value = await read();
    stateCache = { generation: stateGeneration, value };
    return value;
  }
  async function matches(record: InstallRecord, fingerprint = signature(record.files), registered = registeredWorkspaces?.(), indexed?: Awaited<ReturnType<typeof indexRegisteredWorkspaces>>) {
    try {
      safePath(record.name);
      const rootPath = (await resolveInstallRoot(record, registered, indexed)).path;
      // 一次完整遍历同时检查链接、额外文件和内容变化，不能只检查已知文件。
      return signature(fileIndex(await readSkillTree(join(rootPath, record.name)))) === fingerprint;
    } catch (error) { if (!isExpectedOperationError(error)) throw error; return false; }
  }
  async function absentTrashPath(path: string) {
    try { await fs.lstat(path); return false; }
    catch (error) { if (!isExpectedOperationError(error)) throw error; return error.code === "ENOENT"; }
  }
  async function recoverTrashDeletes(loaded?: RepositoryState) {
    const data = loaded ?? await read();
    if (!data.pendingTrashDeletes?.length) return;
    for (const pending of data.pendingTrashDeletes) {
      let exists: boolean;
      try { await fs.lstat(join(trashRootPath(), pending.id)); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
      if (exists) {
        data.installs.push(...pending.installs);
        (data.catalogInstalls ||= []).push(...pending.catalogInstalls);
      }
    }
    delete data.pendingTrashDeletes;
    await write(data, true, undefined, true);
  }
  async function hasRestoreReceipt(record: InstallRecord | CatalogInstallRecord) {
    try {
      const receipt = join(trashRootPath(), `.restored-${record.trashId}`);
      const directory = await fs.lstat(receipt), file = await fs.lstat(join(receipt, "metadata.json"));
      if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 32 << 10) return false;
      const metadata = JSON.parse(await fs.readFile(join(receipt, "metadata.json"), "utf8"));
      return metadata.id === record.trashId && metadata.name === record.name && (record.workspace ? metadata.root?.scope === "project" && metadata.root.projectRoot === record.workspace : (metadata.root?.scope === "user" || metadata.root?.scope === "preset") && metadata.root.key === (record.root || "dsh")) && ("path" in record ? metadata.repository?.id === record.id && metadata.repository.path === record.path : Array.isArray(metadata.catalog) && metadata.catalog.includes(record.id)) && metadata.entries?.length === 1 && metadata.entries[0] === record.name;
    } catch (error) { if (!(error instanceof SyntaxError) && !isExpectedOperationError(error)) throw error; return false; }
  }
  async function recoverPending(loaded?: RepositoryState) {
    catalogWarnings = [];
    const data = loaded ?? await read(); let recovered = false;
    const recoveredCatalogIds: string[] = [];
    const recoveredInstallIds: string[] = [];
    const restoredIds: string[] = [];
    const registered = requestIndex().registered;
    for (const record of data.installs.filter(item => item.trashId && item.uninstallFingerprint && !item.restoreFingerprint)) {
      const id = record.trashId!;
      const occupied = data.installs.some(other => other !== record && !other.trashId && (other.root || "dsh") === (record.root || "dsh") && (other.workspace ?? null) === (record.workspace ?? null) && other.name.toLowerCase() === record.name.toLowerCase());
      if (!occupied && await absentTrashPath(join(trashRootPath(), id)) && await absentTrashPath(join(trashRootPath(), `.stage-${id}`)) && await matches(record, record.uninstallFingerprint, registered, await indexedFor(record))) {
        delete record.trashId; delete record.uninstallFingerprint;
        for (const item of catalogRecords(data).filter(item => item.trashId === id)) delete item.trashId;
        recovered = true; recoveredInstallIds.push(`${record.id}:${record.path}`);
      }
    }
    for (const record of data.installs.filter(record => !record.complete && !record.trashId)) {
      if (await matches(record, signature(record.files), registered, await indexedFor(record))) { record.complete = true; recovered = true; recoveredInstallIds.push(`${record.id}:${record.path}`); }
    }
    for (const record of data.installs.filter(record => record.trashId && record.restoreFingerprint)) {
      // Intent or Trash absence alone cannot authorize a same-name replacement.
      // Require the atomic successful-restore receipt and exact restored files.
      if (await hasRestoreReceipt(record) && await matches(record, record.restoreFingerprint, registered, await indexedFor(record))) {
        restoredIds.push(record.trashId!);
        delete record.trashId; delete record.restoreFingerprint; delete record.uninstallFingerprint; recovered = true;
      }
    }
    for (const record of catalogRecords(data)) {
      if (record.complete === false && !record.trashId && record.files?.length && record.root) {
        if (await catalogMatches(record, signature(record.files))) {
          try {
            const root = await resolveInstallRoot(record, registered, await indexedFor(record));
            if (!record.disabledOnInstall) await enableCatalog(root, record.name, true);
            record.complete = true; recovered = true; recoveredCatalogIds.push(record.id);
          } catch (error) {
            if (!isExpectedOperationError(error)) throw error;
            // 单个副本恢复失败不能拦截列表或无关事务；持久意图仍保留未确认状态。
            catalogWarnings.push({ id: record.id, code: "error.repo.installState", error: "技能文件和安装意图已保留，启用策略暂时不可写；修复策略后重试" });
          }
        }
      }
    }
    for (const record of catalogRecords(data).filter(record => record.root && record.trashId && record.restoreFingerprint)) {
      if (await hasRestoreReceipt(record) && await catalogMatches(record, record.restoreFingerprint!)) {
        restoredIds.push(record.trashId!);
        delete record.trashId; delete record.restoreFingerprint; recovered = true;
      }
    }
    // 仅恢复与安装/恢复意图完全相同的目录；保留任何本地修改，不删除或覆盖文件。
    if (recovered) {
      try { await write(data, true); }
      catch (error) {
        if (!isExpectedOperationError(error)) throw error;
        for (const id of [...new Set([...recoveredCatalogIds, ...restoredIds, ...recoveredInstallIds])]) catalogWarnings.push({ id, code: "error.repo.installState", error: "技能文件已保留，恢复确认暂时无法写入；恢复磁盘写入后重试" });
        return; // 不删除恢复凭据，让下一次读取仍可重试。
      }
      for (const id of restoredIds) await fs.rm(join(trashRootPath(), `.restored-${id}`), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  function catalogRecords(data: RepositoryState): CatalogInstallRecord[] {
    return (data.catalogInstalls || []).filter((record): record is CatalogInstallRecord => typeof record !== "string");
  }
  const locationKey = (record: { root?: string; workspace?: string; name: string }) => JSON.stringify([
    record.root, record.workspace === undefined ? null : process.platform === "win32" ? resolve(record.workspace).toLowerCase() : resolve(record.workspace), record.name,
  ]);
  async function catalogLocation(input: { root?: unknown; workspace?: string } = {}) {
    if (input.workspace !== undefined) {
      if (input.root !== undefined && input.root !== "dsh") throw failure("工作区只能安装到项目 DSH skills");
      const target = await resolveWorkspaceTarget(input.workspace, requestIndex().registered);
      if ("ok" in target && target.ok === false) throw failure(target.error, target.code, target.params);
      return { root: "dsh" as const, workspace: (target as { root: { projectRoot: string } }).root.projectRoot };
    }
    const presetRoots = await fetchPresetRoots();
    return { root: repositoryInstallRoot(input.root, presetRoots).key };
  }
  async function enableCatalog(root: SkillRoot, name: string, respectDisabled = false) {
    try {
      if (respectDisabled) {
        const current = await readManagerState();
        if (!current.writable) throw failure("启用策略不可写", "error.repo.installState");
        // 来源确认失败后，用户的新停用选择优先于原安装的启用意图。
        if (current.state.disabledSkills[root.key]?.includes(name)) return;
      }
      if (root.toggleable !== false && root.kind !== "preset") {
        const result = await setSkillEnabled(root, name, true, log);
        if (result && "ok" in result && result.ok === false) throw failure(result.error, result.code || "error.repo.installState");
      }
    } catch (error) {
      if (!isExpectedOperationError(error)) throw error;
      throw Object.assign(failure("技能文件和安装意图已保留，启用状态无法写入；恢复磁盘写入后重新打开发现页", "error.repo.installState"), { statusCode: 500 });
    }
  }
  async function catalogMatches(record: CatalogInstallRecord, fingerprint: string) {
    try {
      const presetRoots = await fetchPresetRoots();
      const root = await recordInstallRoot(record, requestIndex().registered, await indexedFor(record), presetRoots);
      return signature(fileIndex(await readSkillTree(join(root.path, record.name)))) === fingerprint;
    } catch (error) {
      if (!isExpectedOperationError(error)) throw error;
      return false;
    }
  }
  function catalogCopies(data: RepositoryState, root: SkillRoot, name: string) {
    const target = { root: root.scope === "project" ? "dsh" : root.key, workspace: root.projectRoot, name };
    return catalogRecords(data).filter(record => record.root && !record.trashId && locationKey(record) === locationKey(target));
  }
  async function restoreCatalogTrash(id: string, options: MutationOptions) {
      const metadata = (await listTrash()).find(item => item.id === id);
      const data = await read();
      const records = catalogRecords(data).filter(record => record.trashId === id && metadata?.catalog?.includes(record.id));
      if (!records.length) return restoreSkillTrash(id, log, options);
      for (const record of records) {
        if (metadata!.name !== record.name || (record.workspace ? metadata!.root?.projectRoot !== record.workspace || metadata!.root.scope !== "project" : (metadata!.root?.scope !== "user" && metadata!.root?.scope !== "preset") || metadata!.root.key !== record.root)) throw failure("回收站来源与目录身份不一致");
        record.restoreFingerprint = signature(fileIndex(await readSkillTree(join(trashRootPath(), id, record.name))));
      }
      await write(data);
      const result = await restoreSkillTrash(id, log, { ...options, repositoryRestore: true });
      if ("ok" in result && result.ok === false) {
        if (result.code === "error.repo.installState") return result;
        for (const record of records) delete record.restoreFingerprint;
        await write(data); return result;
      }
      for (const record of records) { delete record.trashId; delete record.restoreFingerprint; }
      try { await write(data); }
      catch (error) { if (!isExpectedOperationError(error)) throw error; throw failure("技能已恢复，目录身份等待校验；恢复磁盘写入后重新打开发现页", "error.repo.installState"); }
      await fs.rm(join(trashRootPath(), `.restored-${id}`), { recursive: true, force: true });
      return result;
  }
  async function sources() {
    const data = await read(), result: Record<string, InstallSource> = Object.create(null);
    const index = createWorkspaceIndex(registeredWorkspaces?.(), { onBuild: onWorkspaceIndexBuild });
    for (const record of data.installs.filter(i => i.complete && !i.trashId)) {
      const source = record.source || data.repositories.find(r => r.id === record.id);
      if (!source) continue;
      const parsed = parseGitUrl({ url: source.url || `${source.owner}/${source.name}`, ref: source.ref, subdirectory: source.subdirectory });
      try {
        const presetRoots = await fetchPresetRoots();
        const root = await recordInstallRoot(record, index.registered, record.workspace === undefined ? undefined : await index.load(), presetRoots);
        const realRoot = await fs.realpath(root.path);
        result[installationSourceKey(realRoot, record.name)] = { ...parsed, id: record.id, path: record.path, commit: record.commit, root: record.root || "dsh", ...(record.workspace ? { workspace: record.workspace } : {}) };
      } catch (error) { if (!isExpectedOperationError(error)) throw error; }
    }
    return result;
  }
return {
 managerPath,
 sources,
prepareRestoreInspection: (id: string) => serialize(async () => {
      const metadata = (await listTrash()).find(item => item.id === id);
      if (!metadata || metadata.entries.length !== 1 || metadata.entries[0] !== metadata.name || (!metadata.repository && !metadata.catalog?.length)) return undefined;
      const data = await read();
      const installs = data.installs.filter(record => record.trashId === id && record.id === metadata.repository?.id && record.path === metadata.repository.path);
      const catalogs = catalogRecords(data).filter(record => record.trashId === id && metadata.catalog?.includes(record.id));
      if (!installs.length && !catalogs.length) return undefined;
      const fingerprint = signature(fileIndex(await readSkillTree(join(trashRootPath(), id, metadata.name))));
      // Capture the exact pre-restore identities and resource digest, including local edits.
      // Status reads verify the recovered records and files; they never perform recovery.
      return (): Promise<MutationInspection | undefined> => serialize(async () => {
        const current = await read();
        if (!await absentTrashPath(join(trashRootPath(), id))) return undefined;
        for (const before of installs) {
          const record = current.installs.find(item => item.id === before.id && item.path === before.path && item.commit === before.commit && locationKey(item) === locationKey(before));
          if (!record?.complete || record.trashId || record.restoreFingerprint || record.uninstallFingerprint || !await matches(record, fingerprint)) return undefined;
        }
        for (const before of catalogs) {
          const record = catalogRecords(current).find(item => item.id === before.id && locationKey(item) === locationKey(before));
          if (record?.complete !== true || record.trashId || record.restoreFingerprint || !await catalogMatches(record, fingerprint)) return undefined;
        }
        return { state: "succeeded", result: { id, name: metadata.name, root: metadata.root } };
      }, false, false);
    }, false, false),
catalogInstallations: (ids: string[]) => serialize(async () => {
      const data = await read();
      const selected = new Set(ids);
      const result: Record<string, CatalogInstallation[]> = Object.create(null);
      for (const record of catalogRecords(data)) {
        if (!selected.has(record.id) || record.root !== "dsh" || record.trashId) continue;
        let state: CatalogInstallation["state"] = "pending";
        if (record.complete === true && record.files?.length) {
          try {
            const root = await resolveInstallRoot(record, requestIndex().registered, await indexedFor(record));
            const path = join(root.path, record.name);
            try { await fs.lstat(path); }
            catch (error) { if (isExpectedOperationError(error) && error.code === "ENOENT") continue; throw error; }
            const files = fileIndex(await readSkillTree(path));
            state = signature(files) === signature(record.files) ? "downloaded" : "modified";
          } catch (error) {
            if (!isExpectedOperationError(error)) throw error;
            state = "unavailable";
          }
        }
        (result[record.id] ||= []).push({ ...(record.workspace === undefined ? {} : { workspace: record.workspace }), state });
      }
      return result;
    }),
catalogReceipt: (id: string, target: { root?: unknown; workspace?: string } = {}) => serialize(async () => {
      const location = await catalogLocation(target);
      const data = await read();
      const record = catalogRecords(data).find(record => record.id === id && record.root === location.root && record.workspace === location.workspace && record.complete === true && !record.trashId);
      if (!record?.files?.length || !await catalogMatches(record, signature(record.files))) return undefined;
      const root = await resolveInstallRoot(record, requestIndex().registered, await indexedFor(record));
      return { name: record.name, root: root.path };
    }, false, false),
installCatalog: (id: string, pack: import("./types.js").UploadInput, target: { root?: unknown; workspace?: string; disabledOnInstall?: boolean; signal?: AbortSignal } = {}) => serialize(async () => {
      const presetRoots = await fetchPresetRoots();
      const location = await catalogLocation(target);
      const root = await recordInstallRoot(location, requestIndex().registered, await indexedFor(location), presetRoots);
      const data = await read();
      const previousCatalog = data.catalogInstalls;
      let intent: CatalogInstallRecord | undefined;
      let reusedLegacy = false;
      // 下载或状态读写可能让出执行权；在实际写入前再次校验目标路径。
      await recordInstallRoot(location, requestIndex().registered, undefined, presetRoots);
      const imported = await importUploadedSkill(pack, log, {
        conflict: "skip", root, disabledOnImport: target.disabledOnInstall === true,
        beforeImport: async (pending, conflicts, failed) => {
          if (target.signal?.aborted) throw Object.assign(new Error("下载已取消"), { code: "error.nacos.cancelled", statusCode: 499 });
          const legacy = (data.catalogInstalls || []).some(record => typeof record === "string" ? record === id : record.id === id && !record.root);
          const candidate = pending.length === 1 && !conflicts.length ? pending[0] :
            !pending.length && conflicts.length === 1 && legacy ? { ...conflicts[0], isDir: conflicts[0].isDir } : undefined;
          if (!candidate?.isDir || failed.length) throw failure("目录安装必须是单个完整技能，且不能覆盖已有副本", "error.repo.conflict");
          const files = fileIndex(await readSkillTree(candidate.source));
          if (!files.some(file => file.path === "SKILL.md")) throw failure("目录安装包缺少 SKILL.md", "error.catalog.response");
          if (conflicts.length) {
            const local = fileIndex(await readSkillTree(join(root.path, candidate.name)));
            if (signature(local) !== signature(files)) throw failure("旧安装内容与目录包不一致，不会覆盖或猜测身份", "error.repo.conflict");
            reusedLegacy = true;
          }
          intent = { id, name: candidate.name, ...location, complete: false, files, ...(target.disabledOnInstall ? { disabledOnInstall: true } : {}) };
          data.catalogInstalls = (data.catalogInstalls || []).filter(record => typeof record === "string" ? record !== id :
            record.trashId || (record.root ? locationKey(record) !== locationKey(intent!) : record.id !== id));
          data.catalogInstalls.push(intent);
          try { await write(data); }
          catch (caught) {
            if (!isExpectedOperationError(caught)) throw caught;
            if ((caught as CodedError).code === "error.repo.capacity") throw caught;
            let persisted: RepositoryState | undefined;
            try { persisted = await read(); }
            catch (verificationError) { if (!isExpectedOperationError(verificationError)) throw verificationError; }
            if (persisted && !catalogRecords(persisted).some(record => record.id === id && record.root === location.root && record.workspace === location.workspace)) {
              data.catalogInstalls = previousCatalog;
              intent = undefined; // Nothing was committed, so a rollback write is unnecessary.
              throw Object.assign(failure("安装意图未写入，技能文件未复制；恢复磁盘写入后重试", "error.repo.state"), { statusCode: 500 });
            }
            throw failure("安装意图无法写入，未复制技能文件", "error.repo.installState");
          }
        },
      });
      const completedName = reusedLegacy ? imported.skipped?.length === 1 ? imported.skipped[0].name : undefined : imported.imported?.length === 1 ? imported.imported[0].name : undefined;
      if (imported.ok === false && imported.code === "error.repo.installState") throw failure(imported.error || "安装结果尚待确认", "error.repo.installState");
      if (imported.ok === false || !intent || completedName !== intent.name) {
        if (intent) {
          data.catalogInstalls = previousCatalog;
          try { await write(data); }
          catch (error) { if (!isExpectedOperationError(error)) throw error; throw failure("安装未完成且身份意图无法撤销，请恢复磁盘写入后重试", "error.repo.installState"); }
        }
        throw Object.assign(failure(imported.error || "同名技能已存在，不会覆盖本地文件", imported.code || "error.repo.conflict", imported.params), { statusCode: imported.code === "error.repo.installState" ? 500 : imported.code === "error.repo.capacity" ? 413 : 409 });
      }
      if (!intent.disabledOnInstall) await enableCatalog(root, intent.name);
      intent.complete = true;
      try { await write(data); }
      catch (error) { if (!isExpectedOperationError(error)) throw error; throw Object.assign(failure("技能文件已安装但身份未确认；恢复磁盘写入后重新打开发现页", "error.repo.installState"), { statusCode: 500 }); }
      return { name: intent.name, root: root.path };
    }),
recoverLocal: () => serialize(async () => ({ warnings: [...catalogWarnings] })),
trashSkill: (root: SkillRoot | undefined, name: string) => serialize(async () => {
      const data = await read();
      const records = root ? catalogCopies(data, root, name) : [];
      if (!records.length) return deleteSkill(root, name, log);
      const id = `${Date.now()}-${randomUUID()}`;
      for (const record of records) record.trashId = id;
      await write(data);
      try {
        const result = await deleteSkill(root, name, log, { catalogTrash: { id, ids: records.map(record => record.id) } });
        if ("ok" in result && result.ok === false) {
          if (result.code === "error.repo.installState") return result;
          for (const record of records) delete record.trashId;
          await write(data);
        }
        return result;
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
        if (error.code === "error.repo.installState") throw error;
        if (!(await listTrash()).some(item => item.id === id)) {
          for (const record of records) delete record.trashId;
          await write(data);
        }
        throw error;
      }
    }, false),
permanentlyDeleteTrash: (id: string) => serialize(async () => {
      const data = await read();
      const installs = data.installs.filter(record => record.trashId === id);
      const catalogInstalls = catalogRecords(data).filter(record => record.trashId === id);
      const hasIdentity = installs.length > 0 || catalogInstalls.length > 0;
      if (hasIdentity) {
        // 不覆盖其他实例已登记的事务，否则它们退回的身份会丢失。
        data.pendingTrashDeletes = [...(data.pendingTrashDeletes || []).filter(pending => pending.id !== id), { id, installs, catalogInstalls }];
        data.installs = data.installs.filter(record => record.trashId !== id);
        data.catalogInstalls = (data.catalogInstalls || []).filter(record => typeof record === "string" || record.trashId !== id);
        const afterCommit = data.pendingTrashDeletes.filter(pending => pending.id !== id);
        const commit: RepositoryState = { ...data, pendingTrashDeletes: afterCommit };
        if (!afterCommit.length) delete commit.pendingTrashDeletes;
        await write(data, true, commit, true);
      }
      // 回滚失败不能顶替真正的失败原因：附在 cause 上，让调用方仍看到原始错误。
      const rollback = async (original: unknown) => {
        if (!hasIdentity) return;
        try { await recoverTrashDeletes(); }
        catch (rollbackError) {
          throw new Error(`永久删除失败，且来源身份回滚未完成；请恢复磁盘写入后重试。原始错误：${(original as Error)?.message ?? original}`, { cause: rollbackError });
        }
      };
      let result: Awaited<ReturnType<typeof permanentlyDeleteTrash>>;
      try { result = await permanentlyDeleteTrash(id, log); }
      catch (error) {
        if (!isExpectedOperationError(error) || error.code === "error.repo.installState") throw error;
        await rollback(error);
        throw error;
      }
      if ("ok" in result && result.ok === false) {
        if (result.code === "error.repo.installState") return result;
        await rollback(result.error);
        return result;
      }
      if (hasIdentity) {
        const remaining = data.pendingTrashDeletes!.filter(pending => pending.id !== id);
        if (remaining.length) data.pendingTrashDeletes = remaining;
        else delete data.pendingTrashDeletes;
        await write(data, true, undefined, true);
      }
      return result;
    }, false),
restoreTrash: (id: string, options: MutationOptions = {}) => serialize(async () => {
      const metadata = (await listTrash()).find(item => item.id === id);
      // Ordinary trash remains restorable even if repository state is corrupt.
      // Provenance-bearing entries must recover pending deletes under the lock first.
      if (!metadata?.repository && !metadata?.catalog?.length) return restoreSkillTrash(id, log, options);
      await recoverTrashDeletes();
      if (metadata?.catalog?.length && !metadata.repository) return restoreCatalogTrash(id, options);
        const data = await read();
        const record = data.installs.find(item => item.trashId === id && item.id === metadata.repository!.id && item.path === metadata.repository!.path);
        if (!record) return restoreSkillTrash(id, log, options);
        if (metadata.name !== record.name || (record.workspace ? metadata.root?.scope !== "project" || metadata.root.projectRoot !== record.workspace : (metadata.root?.scope !== "user" && metadata.root?.scope !== "preset") || metadata.root.key !== (record.root || "dsh")) || metadata.entries.length !== 1 || metadata.entries[0] !== record.name) throw failure("回收站来源与安装记录不一致");
        // Journal the exact local edits being restored before moving any files.
        record.restoreFingerprint = signature(fileIndex(await readSkillTree(join(trashRootPath(), id, record.name))));
        const catalog = catalogRecords(data).filter(item => item.trashId === id && metadata.catalog?.includes(item.id));
        for (const item of catalog) item.restoreFingerprint = record.restoreFingerprint;
        await write(data);
        const result = await restoreSkillTrash(id, log, { ...options, repositoryRestore: true });
        if ("ok" in result && result.ok === false) {
          if (result.code === "error.repo.installState") return result;
          delete record.restoreFingerprint;
          for (const item of catalog) delete item.restoreFingerprint;
          await write(data); return result;
        }
        delete record.trashId; delete record.restoreFingerprint; delete record.uninstallFingerprint;
        for (const item of catalog) { delete item.trashId; delete item.restoreFingerprint; }
        try { await write(data); }
        catch (error) { if (!isExpectedOperationError(error)) throw error; throw failure("技能已恢复，来源状态等待校验；恢复磁盘写入后重新打开仓库页", "error.repo.installState"); }
        await fs.rm(join(trashRootPath(), `.restored-${id}`), { recursive: true, force: true }).catch(() => undefined);
        return result;
    }, false, false)
};
}
