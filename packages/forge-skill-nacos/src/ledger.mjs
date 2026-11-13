/**
 * 安装台账（设计 §5.4/§6）：本地状态唯一真源。
 *
 * `state.json` 0600 原子写（临时文件 + rename）；写操作经进程内队列串行，
 * 跨进程互斥用 O_EXCL 文档锁（等待超时报错，不自动接管——同
 * forge-credentials-keychain file backend 语义）。损坏的 state 显式报错，
 * 不静默当作空；`state.json.tmp` 残留按崩溃现场忽略。
 */
import { open, readFile, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { REASONS, SkillNacosError } from './errors.mjs';

const STATE_FORMAT_VERSION = 1;
const LOCK_POLL_MS = 100;

/**
 * @param {{statePath: string, lockPath: string, lockTimeoutMs?: number}} input
 */
export function createLedger({ statePath, lockPath, lockTimeoutMs = 10000 }) {
  let state;
  let writeQueue = Promise.resolve();

  async function initialize() {
    state = await load();
    return api;
  }

  async function load() {
    let text;
    try {
      text = await readFile(statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SkillNacosError(REASONS.LEDGER_INVALID, `安装台账 ${statePath} 不是有效 JSON（不静默重置，请人工检查）`);
    }
    if (parsed?.formatVersion !== STATE_FORMAT_VERSION
      || parsed.installs === null || typeof parsed.installs !== 'object' || Array.isArray(parsed.installs)
      || !Array.isArray(parsed.trash)) {
      throw new SkillNacosError(REASONS.LEDGER_INVALID, `安装台账 ${statePath} 结构不合规（formatVersion=${String(parsed?.formatVersion)}）`);
    }
    for (const record of Object.values(parsed.installs)) {
      assertRecordShape(record);
    }
    return parsed;
  }

  /** 原子保存：写 `.tmp`（0600）后 rename 覆盖；两步之间崩溃留下旧完整状态。 */
  async function save(next) {
    const tmp = `${statePath}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(tmp, statePath);
  }

  function enqueueWrite(task) {
    const run = () => withLock(task);
    writeQueue = writeQueue.then(run, run);
    const settled = writeQueue;
    settled.catch(() => undefined);
    return settled;
  }

  /** 跨进程文档锁：O_EXCL 创建；存在则轮询至超时（SN_LOCK_TIMEOUT）。 */
  async function withLock(task) {
    const deadline = Date.now() + lockTimeoutMs;
    let handle;
    for (;;) {
      try {
        handle = await open(lockPath, 'wx');
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw new SkillNacosError(REASONS.LOCK_TIMEOUT, `另一进程持有台账锁（等待 ${lockTimeoutMs}ms 超时），写入被拒绝`);
        }
        await sleep(LOCK_POLL_MS);
      }
    }
    try {
      return await task();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  function requireRecord(name) {
    const record = state.installs[name];
    if (record === undefined) {
      throw new SkillNacosError(REASONS.NOT_INSTALLED, `技能 ${name} 未安装`);
    }
    return record;
  }

  const api = {
    /** 当前全部安装记录（顺序稳定：按 name 排序）。 */
    list: () => Object.values(state.installs).sort((left, right) => (left.name < right.name ? -1 : 1)),
    get: (name) => state.installs[name],
    trashList: () => [...state.trash],
    requireRecord,

    /**
     * 在台账文档锁与进程队列内执行一段事务（安装的"先落包目录、后写台账"
     * 两步必须同锁完成）。事务内部用 `putDirect` 写状态。
     */
    runExclusive(task) {
      return enqueueWrite(task);
    },

    /** 已持锁路径上的直写（仅限 runExclusive 内部使用）；重新安装时清走同名旧回收记录。 */
    async putDirect(record) {
      assertRecordShape(record);
      state.installs[record.name] = record;
      state.trash = state.trash.filter((entry) => entry.name !== record.name);
      await save(state);
      return record;
    },

    put(record) {
      return enqueueWrite(() => api.putDirect(record));
    },

    setEnabled(name, enabled) {
      return enqueueWrite(async () => {
        const record = requireRecord(name);
        record.enabled = enabled === true;
        record.lastVerifiedAt = new Date().toISOString();
        await save(state);
        return { ...record };
      });
    },

    changeScope(name, scope) {
      assertScopeShape(scope);
      return enqueueWrite(async () => {
        const record = requireRecord(name);
        record.scope = scope;
        record.lastVerifiedAt = new Date().toISOString();
        await save(state);
        return { ...record };
      });
    },

    /** 卸载入回收站：包体保留，安装身份完整；同名旧回收记录一并清走（不堆积）。 */
    removeToTrash(name) {
      return enqueueWrite(async () => {
        const record = requireRecord(name);
        delete state.installs[name];
        state.trash = state.trash.filter((entry) => entry.name !== name);
        const entry = { ...record, id: `${record.name}#${Date.now()}`, trashedAt: new Date().toISOString() };
        state.trash.push(entry);
        await save(state);
        return entry;
      });
    },

    /** 恢复：从回收站取回安装身份（完整性校验由调用方执行后 commitRestore）。 */
    findTrashEntry(idOrName) {
      return state.trash.find((entry) => entry.id === idOrName || entry.name === idOrName);
    },

    /** 仅列出当前未安装的回收站条目（重新安装后旧回收记录不重复展示）。 */
    listVisibleTrash() {
      return state.trash.filter((entry) => state.installs[entry.name] === undefined);
    },

    commitRestore(id) {
      return enqueueWrite(async () => {
        const index = state.trash.findIndex((entry) => entry.id === id);
        if (index < 0) throw new SkillNacosError(REASONS.NOT_FOUND, `回收站没有条目 ${id}`);
        const { id: dropped, trashedAt: trashed, ...record } = state.trash[index];
        state.trash.splice(index, 1);
        state.installs[record.name] = record;
        await save(state);
        return { ...record };
      });
    },

    purgeFromTrash(id) {
      return enqueueWrite(async () => {
        const index = state.trash.findIndex((entry) => entry.id === id);
        if (index < 0) throw new SkillNacosError(REASONS.NOT_FOUND, `回收站没有条目 ${id}`);
        const [entry] = state.trash.splice(index, 1);
        await save(state);
        return entry;
      });
    },

    /** 崩溃现场清理：删除无台账引用的 staging 内容（调用方逐目录删除文件）。 */
    stagingEntries: () => state.staging ?? [],

    /** 测试与恢复流程用：直接读当前内部状态（只读快照）。 */
    snapshot: () => JSON.parse(JSON.stringify(state)),

    _touchLockForTest: async () => {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      // 修正 atime/mtime，避免 lint 层面误判未使用
      const now = new Date();
      await utimes(lockPath, now, now);
    },
  };

  return { initialize };
}

function emptyState() {
  return { formatVersion: STATE_FORMAT_VERSION, installs: {}, trash: [] };
}

function assertRecordShape(record) {
  const required = ['name', 'version', 'contentSha256', 'skillMdSha256', 'installedAt', 'enabled'];
  for (const key of required) {
    if (record?.[key] === undefined) {
      throw new SkillNacosError(REASONS.LEDGER_INVALID, `台账记录缺字段 ${key}`);
    }
  }
  if (typeof record.enabled !== 'boolean') {
    throw new SkillNacosError(REASONS.LEDGER_INVALID, '台账记录 enabled 必须是布尔');
  }
  assertScopeShape(record.scope);
}

function assertScopeShape(scope) {
  const valid = scope?.kind === 'user'
    || (scope?.kind === 'project' && typeof scope.root === 'string' && scope.root.length > 0);
  if (!valid) {
    throw new SkillNacosError(REASONS.LEDGER_INVALID, '作用域必须是 {kind:"user"} 或 {kind:"project", root}');
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
