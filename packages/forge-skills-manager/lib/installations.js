import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { isExpectedOperationError } from "./operation-errors.js";
import { createInstallationRecords, fileIndex, installationSourceKey, isRepositoryRootKey, readSkillTree, signature } from "./installation-records.js";
import { parseGitUrl } from "./legacy-sources.js";
const STATE_LIMIT = 16 << 20;
const STATE_READ_LIMIT = 64 << 20;
const queuesKey = Symbol.for("heluo.forge-skills-manager.installations");
const queues = globalThis[queuesKey] ??= /* @__PURE__ */ new Map();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function failure(message, code = "error.repo.invalid", params) {
  return Object.assign(new Error(message), { code, statusCode: 400, ...params && typeof params === "object" && !Array.isArray(params) ? { params } : {} });
}
function safePath(value, allowEmpty = false) {
  if (typeof value !== "string" || value.length > 512 || !value && !allowEmpty) throw failure("\u4ED3\u5E93\u8DEF\u5F84\u65E0\u6548");
  if (!value) return value;
  const parts = value.split("/");
  if (parts.length > 64 || parts.some((p) => !p || p === "." || p === ".." || /[\\:<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw failure("\u4ED3\u5E93\u8DEF\u5F84\u4E0D\u5B89\u5168");
  return value;
}
function validateStoredState(input) {
  const value = input;
  if (!value || value.version !== 1 || !Array.isArray(value.repositories) || value.repositories.length > 30 || !Array.isArray(value.installs)) throw failure("\u4ED3\u5E93\u72B6\u6001\u683C\u5F0F\u65E0\u6548");
  for (const repo of value.repositories) {
    if (!repo || typeof repo.id !== "string" || !Array.isArray(repo.skills) || repo.skills.length > 500) throw failure("\u4ED3\u5E93\u72B6\u6001\u683C\u5F0F\u65E0\u6548");
    const source = parseGitUrl({ url: repo.url || `${repo.owner}/${repo.name}`, ref: repo.ref, subdirectory: repo.subdirectory });
    const expectedId = hash(JSON.stringify(source)).slice(0, 24);
    if (expectedId !== repo.id || repo.commit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repo.commit)) throw failure("\u4ED3\u5E93\u72B6\u6001\u6765\u6E90\u65E0\u6548");
    for (const skill of repo.skills) {
      if (!skill || typeof skill.name !== "string" || typeof skill.description !== "string" || typeof skill.body !== "string" || typeof skill.valid !== "boolean" || !/^[a-f0-9]{64}$/.test(skill.documentHash)) throw failure("\u4ED3\u5E93\u6280\u80FD\u72B6\u6001\u65E0\u6548");
      safePath(skill.path, true);
    }
  }
  for (const record of value.installs) {
    if (!record || typeof record.id !== "string" || typeof record.complete !== "boolean" || !Array.isArray(record.files) || !record.files.length || record.files.length > 1e3 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.commit || "")) throw failure("\u4ED3\u5E93\u5B89\u88C5\u8BB0\u5F55\u65E0\u6548");
    if (!isRepositoryRootKey(record.root)) throw failure("\u6280\u80FD\u5B89\u88C5\u4F4D\u7F6E\u65E0\u6548");
    if (record.workspace !== void 0 && (typeof record.workspace !== "string" || !record.workspace || record.workspace.length > 1024 || record.root === "agents")) throw failure("\u4ED3\u5E93\u5B89\u88C5\u5DE5\u4F5C\u533A\u65E0\u6548");
    if (record.trashId !== void 0 && (typeof record.trashId !== "string" || !/^\d+-[a-f0-9-]{36}$/.test(record.trashId))) throw failure("\u4ED3\u5E93\u56DE\u6536\u8BB0\u5F55\u65E0\u6548");
    if (record.restoreFingerprint !== void 0 && (typeof record.restoreFingerprint !== "string" || !record.trashId || !/^[a-f0-9]{64}$/.test(record.restoreFingerprint))) throw failure("\u4ED3\u5E93\u6062\u590D\u8BB0\u5F55\u65E0\u6548");
    if (record.uninstallFingerprint !== void 0 && (!record.trashId || !/^[a-f0-9]{64}$/.test(record.uninstallFingerprint))) throw failure("\u4ED3\u5E93\u5378\u8F7D\u8BB0\u5F55\u65E0\u6548");
    safePath(record.path, true);
    safePath(record.name);
    if (record.name.includes("/")) throw failure("\u4ED3\u5E93\u5B89\u88C5\u540D\u79F0\u65E0\u6548");
    for (const entry of record.files) {
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.hash)) throw failure("\u4ED3\u5E93\u5B89\u88C5\u6458\u8981\u65E0\u6548");
      safePath(entry.path);
    }
  }
  if (value.catalogInstalls !== void 0) {
    if (!Array.isArray(value.catalogInstalls)) throw failure("\u76EE\u5F55\u5B89\u88C5\u72B6\u6001\u683C\u5F0F\u65E0\u6548");
    for (const item of value.catalogInstalls) {
      if (typeof item === "string") {
        if (!/^(?:clawhub|skillsh):[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,2}$/.test(item)) throw failure("\u76EE\u5F55\u5B89\u88C5\u8BB0\u5F55\u683C\u5F0F\u65E0\u6548");
      } else if (item && typeof item === "object") {
        if (typeof item.id !== "string" || !/^(?:nacos:[a-f0-9]{64}$|(?:clawhub|skillsh):[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,2}$)/.test(item.id)) throw failure("\u76EE\u5F55\u5B89\u88C5\u8BB0\u5F55\u683C\u5F0F\u65E0\u6548");
        if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 128) throw failure("\u76EE\u5F55\u5B89\u88C5\u6280\u80FD\u540D\u79F0\u65E0\u6548");
        safePath(item.name);
        if (item.name.includes("/")) throw failure("\u76EE\u5F55\u5B89\u88C5\u6280\u80FD\u540D\u79F0\u65E0\u6548");
        if (item.root !== void 0 && !isRepositoryRootKey(item.root)) throw failure("\u6280\u80FD\u5B89\u88C5\u4F4D\u7F6E\u65E0\u6548");
        if (item.workspace !== void 0 && (item.root !== "dsh" || typeof item.workspace !== "string" || !item.workspace || item.workspace.length > 1024)) throw failure("\u76EE\u5F55\u5B89\u88C5\u5DE5\u4F5C\u533A\u65E0\u6548");
        if (item.trashId !== void 0 && (typeof item.trashId !== "string" || !/^\d+-[a-f0-9-]{36}$/.test(item.trashId))) throw failure("\u76EE\u5F55\u56DE\u6536\u8BB0\u5F55\u65E0\u6548");
        if (item.restoreFingerprint !== void 0 && (!item.trashId || !/^[a-f0-9]{64}$/.test(item.restoreFingerprint))) throw failure("\u76EE\u5F55\u6062\u590D\u8BB0\u5F55\u65E0\u6548");
        if (item.disabledOnInstall !== void 0 && typeof item.disabledOnInstall !== "boolean") throw failure("\u76EE\u5F55\u5B89\u88C5\u7B56\u7565\u65E0\u6548");
        if (item.complete !== void 0 && typeof item.complete !== "boolean") throw failure("\u76EE\u5F55\u5B89\u88C5\u786E\u8BA4\u72B6\u6001\u65E0\u6548");
        if (item.complete === false && (!item.root || !item.files?.length)) throw failure("\u76EE\u5F55\u5B89\u88C5\u610F\u56FE\u65E0\u6548");
        if (item.files !== void 0) {
          if (!Array.isArray(item.files) || !item.files.length || item.files.length > 1e3) throw failure("\u76EE\u5F55\u5B89\u88C5\u6458\u8981\u65E0\u6548");
          for (const file of item.files) {
            if (!file || !/^[a-f0-9]{64}$/.test(file.hash)) throw failure("\u76EE\u5F55\u5B89\u88C5\u6458\u8981\u65E0\u6548");
            safePath(file.path);
          }
        }
      } else {
        throw failure("\u76EE\u5F55\u5B89\u88C5\u8BB0\u5F55\u683C\u5F0F\u65E0\u6548");
      }
    }
  }
  if (value.pendingTrashDeletes !== void 0) {
    if (!Array.isArray(value.pendingTrashDeletes) || value.pendingTrashDeletes.length > 256) throw failure("\u6C38\u4E45\u5220\u9664\u4E8B\u52A1\u65E0\u6548");
    const ids = /* @__PURE__ */ new Set();
    for (const pending of value.pendingTrashDeletes) {
      if (!pending || typeof pending.id !== "string" || !/^\d+-[a-f0-9-]{36}$/.test(pending.id) || ids.has(pending.id) || !Array.isArray(pending.installs) || !Array.isArray(pending.catalogInstalls) || !pending.installs.length && !pending.catalogInstalls.length) throw failure("\u6C38\u4E45\u5220\u9664\u4E8B\u52A1\u65E0\u6548");
      ids.add(pending.id);
      if ([...pending.installs, ...pending.catalogInstalls].some((record) => !record || record.trashId !== pending.id) || value.installs.some((record) => record.trashId === pending.id) || value.catalogInstalls?.some((record) => typeof record !== "string" && record.trashId === pending.id)) throw failure("\u6C38\u4E45\u5220\u9664\u4E8B\u52A1\u8EAB\u4EFD\u65E0\u6548");
      validateStoredState({ version: 1, repositories: [], installs: pending.installs, catalogInstalls: pending.catalogInstalls });
    }
  }
}
function createInstallationManager({ local, log, registeredWorkspaces, onWorkspaceIndexBuild, getPresetRoots }) {
  const { createWorkspaceIndex, deleteSkill, importUploadedSkill, listTrash, managerHomePath, permanentlyDeleteTrash, readManagerState, resolveWorkspaceTarget, restoreTrash: restoreSkillTrash, setSkillEnabled, trashRootPath } = local;
  const { recordInstallRoot, repositoryInstallRoot } = createInstallationRecords(local);
  const fetchPresetRoots = async () => getPresetRoots ? await getPresetRoots() || [] : [];
  const file = join(managerHomePath(), "repositories.json");
  const managerPath = resolve(managerHomePath());
  const queueKey = process.platform === "win32" ? managerPath.toLowerCase() : managerPath;
  let catalogWarnings = [];
  let activeIndex;
  const serialize = (task, recover = true, recoverDeletes = true) => {
    const run = async () => {
      stateCache = void 0;
      const index = createWorkspaceIndex(registeredWorkspaces?.(), { onBuild: onWorkspaceIndexBuild });
      const previous = activeIndex;
      activeIndex = index;
      try {
        if (recoverDeletes) await recoverTrashDeletes(await preloadedState());
        if (recover) await recoverPending(await preloadedState());
        return await task();
      } finally {
        activeIndex = previous;
      }
    };
    const next = (queues.get(queueKey) ?? Promise.resolve()).then(run, run);
    queues.set(queueKey, next);
    const release = () => {
      if (queues.get(queueKey) === next) queues.delete(queueKey);
    };
    void next.then(release, release);
    return next;
  };
  function requestIndex() {
    return activeIndex ?? createWorkspaceIndex(registeredWorkspaces?.(), { onBuild: onWorkspaceIndexBuild });
  }
  async function indexedFor(record) {
    return record.workspace === void 0 ? void 0 : requestIndex().load();
  }
  const resolveInstallRoot = async (record, registered, indexed, presetRoots) => {
    const presets = presetRoots ?? await fetchPresetRoots();
    return recordInstallRoot(record, registered, indexed, presets);
  };
  async function read() {
    try {
      const homeInfo = await fs.lstat(managerHomePath());
      if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) throw failure("\u4ED3\u5E93\u72B6\u6001\u76EE\u5F55\u4E0D\u5B89\u5168");
      const info = await fs.lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > STATE_READ_LIMIT) throw failure("\u4ED3\u5E93\u72B6\u6001\u6587\u4EF6\u4E0D\u5B89\u5168");
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      validateStoredState(value);
      for (const repo of value.repositories) {
        if (repo.url) {
          try {
            const fresh = parseGitUrl({ url: repo.url, ref: repo.ref, subdirectory: repo.subdirectory });
            repo.owner = fresh.owner;
            repo.name = fresh.name;
          } catch (error) {
            if (!isExpectedOperationError(error)) throw error;
          }
        }
      }
      return value;
    } catch (caught) {
      const error = caught;
      if (!(caught instanceof SyntaxError) && !isExpectedOperationError(caught)) throw caught;
      if (error.code === "ENOENT") return { version: 1, repositories: [], installs: [] };
      throw failure("\u4ED3\u5E93\u72B6\u6001\u6587\u4EF6\u635F\u574F\u6216\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u8BF7\u4FDD\u7559\u6587\u4EF6\u5E76\u4FEE\u590D\u540E\u91CD\u8BD5", "error.repo.state");
    }
  }
  async function write(value, allowShrink = false, deleteCommit, compact = false) {
    validateStoredState(value);
    const indent = compact ? void 0 : 2;
    const text = JSON.stringify(value, null, indent);
    const bytes = Buffer.byteLength(text, "utf8");
    const currentBytes = allowShrink ? await currentStateBytes() : 0;
    const commitBytes = deleteCommit ? Buffer.byteLength(JSON.stringify(deleteCommit, null, indent), "utf8") : Infinity;
    if (bytes > STATE_READ_LIMIT || bytes > STATE_LIMIT && !(allowShrink && (bytes < currentBytes || deleteCommit && commitBytes < currentBytes))) throw failure("\u5B89\u88C5\u6765\u6E90\u72B6\u6001\u8D85\u8FC7 16 MiB\u3002\u8BF7\u5148\u6E05\u7406\u4E0D\u9700\u8981\u7684\u56DE\u6536\u8BB0\u5F55\u6216\u65E7\u8EAB\u4EFD\uFF0C\u4ECD\u6709\u6548\u7684\u5B89\u88C5\u526F\u672C\u4F1A\u4FDD\u7559\u3002", "error.repo.capacity");
    await fs.mkdir(managerHomePath(), { recursive: true });
    if ((await fs.lstat(managerHomePath())).isSymbolicLink()) throw failure("\u4ED3\u5E93\u72B6\u6001\u76EE\u5F55\u4E0D\u80FD\u662F\u94FE\u63A5");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, file);
      stateGeneration += 1;
      stateCache = void 0;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async function currentStateBytes() {
    try {
      return (await fs.lstat(file)).size;
    } catch (error) {
      if (isExpectedOperationError(error) && error.code === "ENOENT") return 0;
      throw error;
    }
  }
  let stateGeneration = 0;
  let stateCache;
  async function preloadedState() {
    if (stateCache && stateCache.generation === stateGeneration) return stateCache.value;
    const value = await read();
    stateCache = { generation: stateGeneration, value };
    return value;
  }
  async function matches(record, fingerprint = signature(record.files), registered = registeredWorkspaces?.(), indexed) {
    try {
      safePath(record.name);
      const rootPath = (await resolveInstallRoot(record, registered, indexed)).path;
      return signature(fileIndex(await readSkillTree(join(rootPath, record.name)))) === fingerprint;
    } catch (error) {
      if (!isExpectedOperationError(error)) throw error;
      return false;
    }
  }
  async function absentTrashPath(path) {
    try {
      await fs.lstat(path);
      return false;
    } catch (error) {
      if (!isExpectedOperationError(error)) throw error;
      return error.code === "ENOENT";
    }
  }
  async function recoverTrashDeletes(loaded) {
    const data = loaded ?? await read();
    if (!data.pendingTrashDeletes?.length) return;
    for (const pending of data.pendingTrashDeletes) {
      let exists;
      try {
        await fs.lstat(join(trashRootPath(), pending.id));
        exists = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        exists = false;
      }
      if (exists) {
        data.installs.push(...pending.installs);
        (data.catalogInstalls ||= []).push(...pending.catalogInstalls);
      }
    }
    delete data.pendingTrashDeletes;
    await write(data, true, void 0, true);
  }
  async function hasRestoreReceipt(record) {
    try {
      const receipt = join(trashRootPath(), `.restored-${record.trashId}`);
      const directory = await fs.lstat(receipt), file2 = await fs.lstat(join(receipt, "metadata.json"));
      if (!directory.isDirectory() || directory.isSymbolicLink() || !file2.isFile() || file2.isSymbolicLink() || file2.size > 32 << 10) return false;
      const metadata = JSON.parse(await fs.readFile(join(receipt, "metadata.json"), "utf8"));
      return metadata.id === record.trashId && metadata.name === record.name && (record.workspace ? metadata.root?.scope === "project" && metadata.root.projectRoot === record.workspace : (metadata.root?.scope === "user" || metadata.root?.scope === "preset") && metadata.root.key === (record.root || "dsh")) && ("path" in record ? metadata.repository?.id === record.id && metadata.repository.path === record.path : Array.isArray(metadata.catalog) && metadata.catalog.includes(record.id)) && metadata.entries?.length === 1 && metadata.entries[0] === record.name;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isExpectedOperationError(error)) throw error;
      return false;
    }
  }
  async function recoverPending(loaded) {
    catalogWarnings = [];
    const data = loaded ?? await read();
    let recovered = false;
    const recoveredCatalogIds = [];
    const recoveredInstallIds = [];
    const restoredIds = [];
    const registered = requestIndex().registered;
    for (const record of data.installs.filter((item) => item.trashId && item.uninstallFingerprint && !item.restoreFingerprint)) {
      const id = record.trashId;
      const occupied = data.installs.some((other) => other !== record && !other.trashId && (other.root || "dsh") === (record.root || "dsh") && (other.workspace ?? null) === (record.workspace ?? null) && other.name.toLowerCase() === record.name.toLowerCase());
      if (!occupied && await absentTrashPath(join(trashRootPath(), id)) && await absentTrashPath(join(trashRootPath(), `.stage-${id}`)) && await matches(record, record.uninstallFingerprint, registered, await indexedFor(record))) {
        delete record.trashId;
        delete record.uninstallFingerprint;
        for (const item of catalogRecords(data).filter((item2) => item2.trashId === id)) delete item.trashId;
        recovered = true;
        recoveredInstallIds.push(`${record.id}:${record.path}`);
      }
    }
    for (const record of data.installs.filter((record2) => !record2.complete && !record2.trashId)) {
      if (await matches(record, signature(record.files), registered, await indexedFor(record))) {
        record.complete = true;
        recovered = true;
        recoveredInstallIds.push(`${record.id}:${record.path}`);
      }
    }
    for (const record of data.installs.filter((record2) => record2.trashId && record2.restoreFingerprint)) {
      if (await hasRestoreReceipt(record) && await matches(record, record.restoreFingerprint, registered, await indexedFor(record))) {
        restoredIds.push(record.trashId);
        delete record.trashId;
        delete record.restoreFingerprint;
        delete record.uninstallFingerprint;
        recovered = true;
      }
    }
    for (const record of catalogRecords(data)) {
      if (record.complete === false && !record.trashId && record.files?.length && record.root) {
        if (await catalogMatches(record, signature(record.files))) {
          try {
            const root = await resolveInstallRoot(record, registered, await indexedFor(record));
            if (!record.disabledOnInstall) await enableCatalog(root, record.name, true);
            record.complete = true;
            recovered = true;
            recoveredCatalogIds.push(record.id);
          } catch (error) {
            if (!isExpectedOperationError(error)) throw error;
            catalogWarnings.push({ id: record.id, code: "error.repo.installState", error: "\u6280\u80FD\u6587\u4EF6\u548C\u5B89\u88C5\u610F\u56FE\u5DF2\u4FDD\u7559\uFF0C\u542F\u7528\u7B56\u7565\u6682\u65F6\u4E0D\u53EF\u5199\uFF1B\u4FEE\u590D\u7B56\u7565\u540E\u91CD\u8BD5" });
          }
        }
      }
    }
    for (const record of catalogRecords(data).filter((record2) => record2.root && record2.trashId && record2.restoreFingerprint)) {
      if (await hasRestoreReceipt(record) && await catalogMatches(record, record.restoreFingerprint)) {
        restoredIds.push(record.trashId);
        delete record.trashId;
        delete record.restoreFingerprint;
        recovered = true;
      }
    }
    if (recovered) {
      try {
        await write(data, true);
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
        for (const id of [.../* @__PURE__ */ new Set([...recoveredCatalogIds, ...restoredIds, ...recoveredInstallIds])]) catalogWarnings.push({ id, code: "error.repo.installState", error: "\u6280\u80FD\u6587\u4EF6\u5DF2\u4FDD\u7559\uFF0C\u6062\u590D\u786E\u8BA4\u6682\u65F6\u65E0\u6CD5\u5199\u5165\uFF1B\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u8BD5" });
        return;
      }
      for (const id of restoredIds) await fs.rm(join(trashRootPath(), `.restored-${id}`), { recursive: true, force: true }).catch(() => void 0);
    }
  }
  function catalogRecords(data) {
    return (data.catalogInstalls || []).filter((record) => typeof record !== "string");
  }
  const locationKey = (record) => JSON.stringify([
    record.root,
    record.workspace === void 0 ? null : process.platform === "win32" ? resolve(record.workspace).toLowerCase() : resolve(record.workspace),
    record.name
  ]);
  async function catalogLocation(input = {}) {
    if (input.workspace !== void 0) {
      if (input.root !== void 0 && input.root !== "dsh") throw failure("\u5DE5\u4F5C\u533A\u53EA\u80FD\u5B89\u88C5\u5230\u9879\u76EE DSH skills");
      const target = await resolveWorkspaceTarget(input.workspace, requestIndex().registered);
      if ("ok" in target && target.ok === false) throw failure(target.error, target.code, target.params);
      return { root: "dsh", workspace: target.root.projectRoot };
    }
    const presetRoots = await fetchPresetRoots();
    return { root: repositoryInstallRoot(input.root, presetRoots).key };
  }
  async function enableCatalog(root, name, respectDisabled = false) {
    try {
      if (respectDisabled) {
        const current = await readManagerState();
        if (!current.writable) throw failure("\u542F\u7528\u7B56\u7565\u4E0D\u53EF\u5199", "error.repo.installState");
        if (current.state.disabledSkills[root.key]?.includes(name)) return;
      }
      if (root.toggleable !== false && root.kind !== "preset") {
        const result = await setSkillEnabled(root, name, true, log);
        if (result && "ok" in result && result.ok === false) throw failure(result.error, result.code || "error.repo.installState");
      }
    } catch (error) {
      if (!isExpectedOperationError(error)) throw error;
      throw Object.assign(failure("\u6280\u80FD\u6587\u4EF6\u548C\u5B89\u88C5\u610F\u56FE\u5DF2\u4FDD\u7559\uFF0C\u542F\u7528\u72B6\u6001\u65E0\u6CD5\u5199\u5165\uFF1B\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u65B0\u6253\u5F00\u53D1\u73B0\u9875", "error.repo.installState"), { statusCode: 500 });
    }
  }
  async function catalogMatches(record, fingerprint) {
    try {
      const presetRoots = await fetchPresetRoots();
      const root = await recordInstallRoot(record, requestIndex().registered, await indexedFor(record), presetRoots);
      return signature(fileIndex(await readSkillTree(join(root.path, record.name)))) === fingerprint;
    } catch (error) {
      if (!isExpectedOperationError(error)) throw error;
      return false;
    }
  }
  function catalogCopies(data, root, name) {
    const target = { root: root.scope === "project" ? "dsh" : root.key, workspace: root.projectRoot, name };
    return catalogRecords(data).filter((record) => record.root && !record.trashId && locationKey(record) === locationKey(target));
  }
  async function restoreCatalogTrash(id, options) {
    const metadata = (await listTrash()).find((item) => item.id === id);
    const data = await read();
    const records = catalogRecords(data).filter((record) => record.trashId === id && metadata?.catalog?.includes(record.id));
    if (!records.length) return restoreSkillTrash(id, log, options);
    for (const record of records) {
      if (metadata.name !== record.name || (record.workspace ? metadata.root?.projectRoot !== record.workspace || metadata.root.scope !== "project" : metadata.root?.scope !== "user" && metadata.root?.scope !== "preset" || metadata.root.key !== record.root)) throw failure("\u56DE\u6536\u7AD9\u6765\u6E90\u4E0E\u76EE\u5F55\u8EAB\u4EFD\u4E0D\u4E00\u81F4");
      record.restoreFingerprint = signature(fileIndex(await readSkillTree(join(trashRootPath(), id, record.name))));
    }
    await write(data);
    const result = await restoreSkillTrash(id, log, { ...options, repositoryRestore: true });
    if ("ok" in result && result.ok === false) {
      if (result.code === "error.repo.installState") return result;
      for (const record of records) delete record.restoreFingerprint;
      await write(data);
      return result;
    }
    for (const record of records) {
      delete record.trashId;
      delete record.restoreFingerprint;
    }
    try {
      await write(data);
    } catch (error) {
      if (!isExpectedOperationError(error)) throw error;
      throw failure("\u6280\u80FD\u5DF2\u6062\u590D\uFF0C\u76EE\u5F55\u8EAB\u4EFD\u7B49\u5F85\u6821\u9A8C\uFF1B\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u65B0\u6253\u5F00\u53D1\u73B0\u9875", "error.repo.installState");
    }
    await fs.rm(join(trashRootPath(), `.restored-${id}`), { recursive: true, force: true });
    return result;
  }
  async function sources() {
    const data = await read(), result = /* @__PURE__ */ Object.create(null);
    const index = createWorkspaceIndex(registeredWorkspaces?.(), { onBuild: onWorkspaceIndexBuild });
    for (const record of data.installs.filter((i) => i.complete && !i.trashId)) {
      const source = record.source || data.repositories.find((r) => r.id === record.id);
      if (!source) continue;
      const parsed = parseGitUrl({ url: source.url || `${source.owner}/${source.name}`, ref: source.ref, subdirectory: source.subdirectory });
      try {
        const presetRoots = await fetchPresetRoots();
        const root = await recordInstallRoot(record, index.registered, record.workspace === void 0 ? void 0 : await index.load(), presetRoots);
        const realRoot = await fs.realpath(root.path);
        result[installationSourceKey(realRoot, record.name)] = { ...parsed, id: record.id, path: record.path, commit: record.commit, root: record.root || "dsh", ...record.workspace ? { workspace: record.workspace } : {} };
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
      }
    }
    return result;
  }
  return {
    managerPath,
    sources,
    catalogInstallations: (ids) => serialize(async () => {
      const data = await read();
      const selected = new Set(ids);
      const result = /* @__PURE__ */ Object.create(null);
      for (const record of catalogRecords(data)) {
        if (!selected.has(record.id) || record.root !== "dsh" || record.trashId) continue;
        let state = "pending";
        if (record.complete === true && record.files?.length) {
          try {
            const root = await resolveInstallRoot(record, requestIndex().registered, await indexedFor(record));
            const path = join(root.path, record.name);
            try {
              await fs.lstat(path);
            } catch (error) {
              if (isExpectedOperationError(error) && error.code === "ENOENT") continue;
              throw error;
            }
            const files = fileIndex(await readSkillTree(path));
            state = signature(files) === signature(record.files) ? "downloaded" : "modified";
          } catch (error) {
            if (!isExpectedOperationError(error)) throw error;
            state = "unavailable";
          }
        }
        (result[record.id] ||= []).push({ ...record.workspace === void 0 ? {} : { workspace: record.workspace }, state });
      }
      return result;
    }),
    catalogReceipt: (id, target = {}) => serialize(async () => {
      const location = await catalogLocation(target);
      const data = await read();
      const record = catalogRecords(data).find((record2) => record2.id === id && record2.root === location.root && record2.workspace === location.workspace && record2.complete === true && !record2.trashId);
      if (!record?.files?.length || !await catalogMatches(record, signature(record.files))) return void 0;
      const root = await resolveInstallRoot(record, requestIndex().registered, await indexedFor(record));
      return { name: record.name, root: root.path };
    }, false, false),
    installCatalog: (id, pack, target = {}) => serialize(async () => {
      const presetRoots = await fetchPresetRoots();
      const location = await catalogLocation(target);
      const root = await recordInstallRoot(location, requestIndex().registered, await indexedFor(location), presetRoots);
      const data = await read();
      const previousCatalog = data.catalogInstalls;
      let intent;
      let reusedLegacy = false;
      await recordInstallRoot(location, requestIndex().registered, void 0, presetRoots);
      const imported = await importUploadedSkill(pack, log, {
        conflict: "skip",
        root,
        disabledOnImport: target.disabledOnInstall === true,
        beforeImport: async (pending, conflicts, failed) => {
          if (target.signal?.aborted) throw Object.assign(new Error("\u4E0B\u8F7D\u5DF2\u53D6\u6D88"), { code: "error.nacos.cancelled", statusCode: 499 });
          const legacy = (data.catalogInstalls || []).some((record) => typeof record === "string" ? record === id : record.id === id && !record.root);
          const candidate = pending.length === 1 && !conflicts.length ? pending[0] : !pending.length && conflicts.length === 1 && legacy ? { ...conflicts[0], isDir: conflicts[0].isDir } : void 0;
          if (!candidate?.isDir || failed.length) throw failure("\u76EE\u5F55\u5B89\u88C5\u5FC5\u987B\u662F\u5355\u4E2A\u5B8C\u6574\u6280\u80FD\uFF0C\u4E14\u4E0D\u80FD\u8986\u76D6\u5DF2\u6709\u526F\u672C", "error.repo.conflict");
          const files = fileIndex(await readSkillTree(candidate.source));
          if (!files.some((file2) => file2.path === "SKILL.md")) throw failure("\u76EE\u5F55\u5B89\u88C5\u5305\u7F3A\u5C11 SKILL.md", "error.catalog.response");
          if (conflicts.length) {
            const local2 = fileIndex(await readSkillTree(join(root.path, candidate.name)));
            if (signature(local2) !== signature(files)) throw failure("\u65E7\u5B89\u88C5\u5185\u5BB9\u4E0E\u76EE\u5F55\u5305\u4E0D\u4E00\u81F4\uFF0C\u4E0D\u4F1A\u8986\u76D6\u6216\u731C\u6D4B\u8EAB\u4EFD", "error.repo.conflict");
            reusedLegacy = true;
          }
          intent = { id, name: candidate.name, ...location, complete: false, files, ...target.disabledOnInstall ? { disabledOnInstall: true } : {} };
          data.catalogInstalls = (data.catalogInstalls || []).filter((record) => typeof record === "string" ? record !== id : record.trashId || (record.root ? locationKey(record) !== locationKey(intent) : record.id !== id));
          data.catalogInstalls.push(intent);
          try {
            await write(data);
          } catch (caught) {
            if (!isExpectedOperationError(caught)) throw caught;
            if (caught.code === "error.repo.capacity") throw caught;
            throw failure("\u5B89\u88C5\u610F\u56FE\u65E0\u6CD5\u5199\u5165\uFF0C\u672A\u590D\u5236\u6280\u80FD\u6587\u4EF6", "error.repo.installState");
          }
        }
      });
      const completedName = reusedLegacy ? imported.skipped?.length === 1 ? imported.skipped[0].name : void 0 : imported.imported?.length === 1 ? imported.imported[0].name : void 0;
      if (imported.ok === false && imported.code === "error.repo.installState") throw failure(imported.error || "\u5B89\u88C5\u7ED3\u679C\u5C1A\u5F85\u786E\u8BA4", "error.repo.installState");
      if (imported.ok === false || !intent || completedName !== intent.name) {
        if (intent) {
          data.catalogInstalls = previousCatalog;
          try {
            await write(data);
          } catch (error) {
            if (!isExpectedOperationError(error)) throw error;
            throw failure("\u5B89\u88C5\u672A\u5B8C\u6210\u4E14\u8EAB\u4EFD\u610F\u56FE\u65E0\u6CD5\u64A4\u9500\uFF0C\u8BF7\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u8BD5", "error.repo.installState");
          }
        }
        throw Object.assign(failure(imported.error || "\u540C\u540D\u6280\u80FD\u5DF2\u5B58\u5728\uFF0C\u4E0D\u4F1A\u8986\u76D6\u672C\u5730\u6587\u4EF6", imported.code || "error.repo.conflict", imported.params), { statusCode: imported.code === "error.repo.installState" ? 500 : imported.code === "error.repo.capacity" ? 413 : 409 });
      }
      if (!intent.disabledOnInstall) await enableCatalog(root, intent.name);
      intent.complete = true;
      try {
        await write(data);
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
        throw Object.assign(failure("\u6280\u80FD\u6587\u4EF6\u5DF2\u5B89\u88C5\u4F46\u8EAB\u4EFD\u672A\u786E\u8BA4\uFF1B\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u65B0\u6253\u5F00\u53D1\u73B0\u9875", "error.repo.installState"), { statusCode: 500 });
      }
      return { name: intent.name, root: root.path };
    }),
    recoverLocal: () => serialize(async () => ({ warnings: [...catalogWarnings] })),
    trashSkill: (root, name) => serialize(async () => {
      const data = await read();
      const records = root ? catalogCopies(data, root, name) : [];
      if (!records.length) return deleteSkill(root, name, log);
      const id = `${Date.now()}-${randomUUID()}`;
      for (const record of records) record.trashId = id;
      await write(data);
      try {
        const result = await deleteSkill(root, name, log, { catalogTrash: { id, ids: records.map((record) => record.id) } });
        if ("ok" in result && result.ok === false) {
          if (result.code === "error.repo.installState") return result;
          for (const record of records) delete record.trashId;
          await write(data);
        }
        return result;
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
        if (error.code === "error.repo.installState") throw error;
        if (!(await listTrash()).some((item) => item.id === id)) {
          for (const record of records) delete record.trashId;
          await write(data);
        }
        throw error;
      }
    }, false),
    permanentlyDeleteTrash: (id) => serialize(async () => {
      const data = await read();
      const installs = data.installs.filter((record) => record.trashId === id);
      const catalogInstalls = catalogRecords(data).filter((record) => record.trashId === id);
      const hasIdentity = installs.length > 0 || catalogInstalls.length > 0;
      if (hasIdentity) {
        data.pendingTrashDeletes = [...(data.pendingTrashDeletes || []).filter((pending) => pending.id !== id), { id, installs, catalogInstalls }];
        data.installs = data.installs.filter((record) => record.trashId !== id);
        data.catalogInstalls = (data.catalogInstalls || []).filter((record) => typeof record === "string" || record.trashId !== id);
        const afterCommit = data.pendingTrashDeletes.filter((pending) => pending.id !== id);
        const commit = { ...data, pendingTrashDeletes: afterCommit };
        if (!afterCommit.length) delete commit.pendingTrashDeletes;
        await write(data, true, commit, true);
      }
      const rollback = async (original) => {
        if (!hasIdentity) return;
        try {
          await recoverTrashDeletes();
        } catch (rollbackError) {
          throw new Error(`\u6C38\u4E45\u5220\u9664\u5931\u8D25\uFF0C\u4E14\u6765\u6E90\u8EAB\u4EFD\u56DE\u6EDA\u672A\u5B8C\u6210\uFF1B\u8BF7\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u8BD5\u3002\u539F\u59CB\u9519\u8BEF\uFF1A${original?.message ?? original}`, { cause: rollbackError });
        }
      };
      let result;
      try {
        result = await permanentlyDeleteTrash(id, log);
      } catch (error) {
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
        const remaining = data.pendingTrashDeletes.filter((pending) => pending.id !== id);
        if (remaining.length) data.pendingTrashDeletes = remaining;
        else delete data.pendingTrashDeletes;
        await write(data, true, void 0, true);
      }
      return result;
    }, false),
    restoreTrash: (id, options = {}) => serialize(async () => {
      const metadata = (await listTrash()).find((item) => item.id === id);
      if (!metadata?.repository && !metadata?.catalog?.length) return restoreSkillTrash(id, log, options);
      await recoverTrashDeletes();
      if (metadata?.catalog?.length && !metadata.repository) return restoreCatalogTrash(id, options);
      const data = await read();
      const record = data.installs.find((item) => item.trashId === id && item.id === metadata.repository.id && item.path === metadata.repository.path);
      if (!record) return restoreSkillTrash(id, log, options);
      if (metadata.name !== record.name || (record.workspace ? metadata.root?.scope !== "project" || metadata.root.projectRoot !== record.workspace : metadata.root?.scope !== "user" && metadata.root?.scope !== "preset" || metadata.root.key !== (record.root || "dsh")) || metadata.entries.length !== 1 || metadata.entries[0] !== record.name) throw failure("\u56DE\u6536\u7AD9\u6765\u6E90\u4E0E\u5B89\u88C5\u8BB0\u5F55\u4E0D\u4E00\u81F4");
      record.restoreFingerprint = signature(fileIndex(await readSkillTree(join(trashRootPath(), id, record.name))));
      const catalog = catalogRecords(data).filter((item) => item.trashId === id && metadata.catalog?.includes(item.id));
      for (const item of catalog) item.restoreFingerprint = record.restoreFingerprint;
      await write(data);
      const result = await restoreSkillTrash(id, log, { ...options, repositoryRestore: true });
      if ("ok" in result && result.ok === false) {
        if (result.code === "error.repo.installState") return result;
        delete record.restoreFingerprint;
        for (const item of catalog) delete item.restoreFingerprint;
        await write(data);
        return result;
      }
      delete record.trashId;
      delete record.restoreFingerprint;
      delete record.uninstallFingerprint;
      for (const item of catalog) {
        delete item.trashId;
        delete item.restoreFingerprint;
      }
      try {
        await write(data);
      } catch (error) {
        if (!isExpectedOperationError(error)) throw error;
        throw failure("\u6280\u80FD\u5DF2\u6062\u590D\uFF0C\u6765\u6E90\u72B6\u6001\u7B49\u5F85\u6821\u9A8C\uFF1B\u6062\u590D\u78C1\u76D8\u5199\u5165\u540E\u91CD\u65B0\u6253\u5F00\u4ED3\u5E93\u9875", "error.repo.installState");
      }
      await fs.rm(join(trashRootPath(), `.restored-${id}`), { recursive: true, force: true }).catch(() => void 0);
      return result;
    }, false, false)
  };
}
export {
  createInstallationManager
};
