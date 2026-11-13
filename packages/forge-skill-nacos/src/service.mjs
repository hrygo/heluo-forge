/**
 * Host 业务服务（设计 §5.3）：页面、工具与后续 Client 面板共用的唯一真源。
 *
 * 写操作全部走"解析 → 校验 → staging 事务 → 台账提交 → invalidate"；
 * 任一步失败清理 staging、台账不变（拒绝即零副作用）。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REASONS, SkillNacosError, toSkillNacosError } from './errors.mjs';
import { directorySize, findProjectRoot } from './paths.mjs';
import { readZip } from './zip.mjs';
import { validateAndExtract } from './validate.mjs';

/**
 * @param {{config: {value: object}, catalog: object, ledger: object, dirs: object,
 *          skillsList?: (options: object) => Promise<Array<{name: string, provider?: string}>>,
 *          invalidate: () => void, logger?: {info?: Function, warn?: Function},
 *          providerName?: string, now?: () => number}} input
 */
export function createSkillNacosService({
  config, baseConfig, catalogRef, overlay, rebuildCatalog, ledger, dirs, skillsList, invalidate, logger, providerName = 'nacos', now = Date.now,
}) {
  let settings = config.value;
  let cache = { items: [], fetchedAt: 0, complete: true, error: undefined };
  const catalog = () => catalogRef.current;

  function log(event, detail) {
    logger?.info?.(`skill-nacos ${event}: ${JSON.stringify(detail)}`);
  }

  async function refreshCatalog() {
    try {
      const { items } = await catalog().list({ page: 1, pageSize: settings.catalogPageSize });
      cache = { items, fetchedAt: now(), complete: true, error: undefined };
      log('catalog-refresh', { count: items.length });
      return { ok: true, count: items.length };
    } catch (error) {
      const wrapped = toSkillNacosError(error);
      cache = { ...cache, complete: false, error: wrapped.code };
      log('catalog-refresh-failed', { code: wrapped.code });
      return { ok: false, code: wrapped.code, message: wrapped.message };
    }
  }

  async function ensureCatalog() {
    if (now() - cache.fetchedAt > settings.catalogCacheTtlMs || cache.items.length === 0) {
      await refreshCatalog();
    }
    return cache;
  }

  async function searchCatalog({ keyword, page = 1, pageSize = 20 } = {}) {
    const current = await ensureCatalog();
    const needle = typeof keyword === 'string' && keyword.length > 0 ? keyword.toLowerCase() : undefined;
    const matched = current.items.filter((item) => needle === undefined
      || item.name.toLowerCase().includes(needle)
      || item.description.toLowerCase().includes(needle));
    const start = (page - 1) * pageSize;
    return {
      stale: !current.complete,
      page,
      pageSize,
      total: matched.length,
      items: matched.slice(start, start + pageSize).map((item) => ({
        name: item.name,
        description: item.description,
        latestVersion: item.version,
        installed: describeLocal(item.name),
      })),
    };
  }

  function describeLocal(name) {
    const record = ledger.get(name);
    if (record === undefined) return null;
    return { version: record.version, enabled: record.enabled, scope: record.scope };
  }

  async function showSkill(name) {
    const meta = await catalog().getMeta(name);
    return { meta, local: describeLocal(name) };
  }

  function listInstalled() {
    return ledger.list().map((record) => ({ ...record }));
  }

  /** 作用域参数归一：'user' | 'project' | 已是对象（upgrade 沿用原作用域）。 */
  function resolveScope(scope, cwd) {
    if (scope !== null && typeof scope === 'object') return scope;
    if (scope === 'project') {
      const root = findProjectRoot(cwd);
      if (root === undefined) {
        throw new SkillNacosError(REASONS.NO_PROJECT_ROOT, '未识别到当前工作区项目根（找不到 .git），无法按项目作用域安装；请在项目会话内重试或保持全局');
      }
      return { kind: 'project', root };
    }
    return { kind: 'user' };
  }

  /**
   * 安装事务（设计 §7.2）。`allowUpgrade` 区分 install 与显式更版。
   * @returns {Promise<{ok: true, txId: string, name: string, version: string, contentSha256: string}>}
   */
  async function install({ name, ref, scope = 'user', cwd, enable = true, allowUpgrade = false }) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new SkillNacosError(REASONS.INVALID_PACKAGE, 'install 缺少技能名');
    }
    const meta = await catalog().getMeta(name);
    const { version, requestedRef } = catalog().resolveVersion(meta, ref);
    const existing = ledger.get(name);
    if (existing !== undefined && existing.version === version) {
      return { ok: true, alreadyInstalled: true, name, version, txId: '', contentSha256: existing.contentSha256 };
    }
    if (existing !== undefined && !allowUpgrade) {
      throw new SkillNacosError(REASONS.VERSION_MISMATCH, `已安装 ${name}@${existing.version}；更版到 ${version} 请显式 upgrade`);
    }
    const resolvedScope = resolveScope(scope, cwd);
    await assertNoLocalConflict(name, cwd);
    const storeBytes = directorySize(dirs.storeDir);
    if (storeBytes >= settings.installStoreQuotaBytes) {
      throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `受管目录已占用 ${storeBytes} 字节，达到配额 ${settings.installStoreQuotaBytes}`);
    }

    const txId = `${name}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const staging = join(dirs.stagingDir, txId);
    await mkdir(staging, { recursive: true });
    let staged;
    try {
      const bytes = await catalog().download(name, version);
      const zip = readZip(bytes, { maxFileCount: settings.maxFileCount, maxTotalBytes: settings.maxUncompressedBytes });
      const unpacked = join(staging, 'unpacked');
      staged = await validateAndExtract(zip, { expectedName: name, expectedVersion: version, targetDir: unpacked });
      if (storeBytes + staged.totalBytes > settings.installStoreQuotaBytes) {
        throw new SkillNacosError(REASONS.QUOTA_EXCEEDED, `安装后将超出受管目录配额（现有 ${storeBytes} + 本次 ${staged.totalBytes} > ${settings.installStoreQuotaBytes}）`);
      }
      const record = {
        name,
        version,
        requestedRef,
        scope: resolvedScope,
        origin: { endpoint: settings.endpoint, namespaceId: settings.namespaceId, catalogMode: settings.catalogMode },
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        skillMdSha256: staged.skillMdSha256,
        description: staged.description,
        installedAt: new Date(now()).toISOString(),
        enabled: enable === true,
        lastVerifiedAt: new Date(now()).toISOString(),
      };
      // 先落包目录、后写台账，两步在同一把文档锁内（跨进程原子）。
      await ledger.runExclusive(async () => {
        const destination = dirs.skillDir(name, version);
        if (existsSync(destination)) {
          await rm(unpacked, { recursive: true, force: true });
        } else {
          await mkdir(join(destination, '..'), { recursive: true });
          await rename(unpacked, destination);
        }
        await ledger.putDirect(record);
      });
      invalidate();
      log('install', { name, version, txId, sha256: record.contentSha256.slice(0, 8), scope: resolvedScope.kind });
      return { ok: true, txId, name, version, contentSha256: record.contentSha256 };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw toSkillNacosError(error, REASONS.INVALID_PACKAGE);
    }
  }

  async function assertNoLocalConflict(name, cwd) {
    if (typeof skillsList !== 'function') return;
    let summaries;
    try {
      summaries = await skillsList({ cwd });
    } catch {
      return; // 目录服务暂时不可用不阻塞安装；同名本地源由 registry 层 rank 兜底
    }
    const conflict = Array.isArray(summaries)
      ? summaries.find((summary) => summary?.name === name && summary?.provider !== providerName)
      : undefined;
    if (conflict !== undefined) {
      throw new SkillNacosError(
        REASONS.NAME_CONFLICT,
        `本地已存在同名技能 ${name}（来源 ${String(conflict.provider ?? 'unknown')}），企业技能不覆盖个人/项目技能`,
        { provider: conflict.provider, source: conflict.source },
      );
    }
  }

  async function upgrade({ name, ref, cwd }) {
    ledger.requireRecord(name);
    const existing = ledger.get(name);
    return install({ name, ref, scope: existing.scope, cwd, enable: existing.enabled, allowUpgrade: true });
  }

  async function setEnabled(name, enabled) {
    const record = await ledger.setEnabled(name, enabled);
    invalidate();
    log(enabled ? 'enable' : 'disable', { name, version: record.version });
    return { ...record };
  }

  async function uninstall(name) {
    const entry = await ledger.removeToTrash(name);
    invalidate();
    log('uninstall', { name, version: entry.version, trashId: entry.id });
    return { trashId: entry.id, name, version: entry.version };
  }

  async function restore(idOrName) {
    const entry = ledger.findTrashEntry(idOrName);
    if (entry === undefined) {
      throw new SkillNacosError(REASONS.NOT_FOUND, `回收站没有条目 ${idOrName}`);
    }
    const dir = dirs.skillDir(entry.name, entry.version);
    let raw;
    try {
      raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
    } catch {
      throw new SkillNacosError(REASONS.INVALID_PACKAGE, `回收站条目 ${entry.name}@${entry.version} 的包体缺失，无法恢复；请重新安装`);
    }
    const sha = createHash('sha256').update(raw).digest('hex');
    if (sha !== entry.skillMdSha256) {
      throw new SkillNacosError(REASONS.INVALID_PACKAGE, `${entry.name}@${entry.version} 的本地包体与安装记录不一致（可能被外部改动），拒绝恢复；请重新安装该版本`);
    }
    const record = await ledger.commitRestore(entry.id);
    invalidate();
    log('restore', { name: record.name, version: record.version });
    return { ...record };
  }

  async function purge(idOrName) {
    const entry = ledger.findTrashEntry(idOrName);
    if (entry === undefined) {
      throw new SkillNacosError(REASONS.NOT_FOUND, `回收站没有条目 ${idOrName}`);
    }
    const versionDir = dirs.skillDir(entry.name, entry.version);
    await rm(versionDir, { recursive: true, force: true });
    // 最后一版清掉后收走空的技能目录；仍有其它版本时保留。
    const parent = dirname(versionDir);
    const siblings = await readdir(parent).catch(() => undefined);
    if (Array.isArray(siblings) && siblings.length === 0) {
      await rm(parent, { recursive: true, force: true }).catch(() => undefined);
    }
    await ledger.purgeFromTrash(entry.id);
    invalidate();
    log('purge', { name: entry.name, version: entry.version });
    return { purged: entry.id, name: entry.name, version: entry.version };
  }

  async function changeScope({ name, to, cwd }) {
    ledger.requireRecord(name);
    const scope = to === 'project'
      ? resolveScope('project', cwd)
      : { kind: 'user' };
    const record = await ledger.changeScope(name, scope);
    invalidate();
    log('scope-change', { name, from: '…', to: scope.kind });
    return { ...record };
  }

  function status() {
    return {
      endpoint: settings.endpoint,
      namespaceId: settings.namespaceId,
      catalogMode: settings.catalogMode,
      cache: { fetchedAt: cache.fetchedAt, count: cache.items.length, complete: cache.complete, error: cache.error },
    };
  }

  /** 启动清理：删除全部 staging 残留（无台账引用即孤儿，设计 §7.5）。 */
  async function cleanStaging() {
    let entries = [];
    try {
      entries = await readdir(dirs.stagingDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      await rm(join(dirs.stagingDir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    return entries.length;
  }

  return {
    refreshCatalog,
    searchCatalog,
    showSkill,
    listInstalled,
    listTrash: () => ledger.listVisibleTrash().map((entry) => ({ ...entry })),
    install,
    upgrade,
    enable: (name) => setEnabled(name, true),
    disable: (name) => setEnabled(name, false),
    uninstall,
    restore,
    purge,
    changeScope,
    status,
    cleanStaging,
    /** 用户可调设置：环境列表 + 当前生效配置。 */
    getSettings: () => ({
      effective: { ...settings },
      overrides: overlay ? overlay.get() : {},
      environments: (baseConfig?.value?.environments ?? []).map((env) => ({
        id: env.id, label: env.label, namespaceId: env.namespaceId,
      })),
    }),
    /** 更新设置（环境切换 / 高级参数）→ 持久化 → 重建 catalog → 清缓存。 */
    async updateSettings(patch) {
      if (typeof overlay?.update !== 'function' || typeof rebuildCatalog !== 'function') {
        throw new SkillNacosError(REASONS.CONFIG_INVALID, '本部署不支持运行时修改配置');
      }
      if (patch?.activeEnvironmentId !== undefined) {
        const envs = baseConfig?.value?.environments ?? [];
        if (!envs.some((env) => env.id === patch.activeEnvironmentId)) {
          throw new SkillNacosError(REASONS.CONFIG_INVALID,
            `未知环境 ${patch.activeEnvironmentId}（可选：${envs.map((e) => e.id).join(', ') || '无'}）`);
        }
      }
      await overlay.update(patch);
      const next = overlay.merge(baseConfig.value);
      // 环境字段由 rebuildCatalog 内的 resolveEffective 解析
      const activeEnv = (next.environments ?? []).find((e) => e.id === next.activeEnvironmentId)
        ?? (next.environments ?? [])[0];
      settings = activeEnv !== undefined
        ? { ...next, endpoint: activeEnv.endpoint, consoleEndpoint: activeEnv.consoleEndpoint, namespaceId: activeEnv.namespaceId, credentialRecordId: activeEnv.credentialRecordId }
        : next;
      rebuildCatalog(next);
      cache = { items: [], fetchedAt: 0, complete: true, error: undefined };
      return { effective: { ...settings }, overrides: overlay.get(), environments: (baseConfig?.value?.environments ?? []).map((env) => ({ id: env.id, label: env.label, namespaceId: env.namespaceId })) };
    },
  };
}
