/**
 * `@heluo/forge-devops` 命令行配置的宿主状态（T3）：装配期快照、刷新、revision 栅栏、保存编排。
 *
 * 这个模块是**唯一**知道 `configEditor` 的地方——把"宿主怎么写配置"收进一个适配器，
 * `index.mjs` 只做装配。三个判断决定了它的形状：
 *
 *   1. **发现只在两个时刻发生**（AC-4）：`createCliAccess()` 构造时一次，以及页面显式
 *      `snapshot({ refresh: true })`。工具调用、保存、`describe()` 都不会触发文件系统扫描——
 *      `access.save()` 成功后只**重新合并**（配置层变了），不重扫。这让"成本有界"成为结构事实，
 *      而不是靠调用方记得别多扫。
 *   2. **revision 是自算的栅栏**（§2.5）：`config-editor` 不走 `settings.update`，没有宿主给的
 *      revision，所以用 `sha256(用户层)` 前 16 位替代。保存前现算一次比对（不等 → 409 且不写盘），
 *      保存后再读一次比对（写后回读，才敢对页面说"已保存"）。键序按名字排序后再哈希：
 *      同一组键换个顺序写进 YAML 仍是同一个 revision，不会凭空报冲突。
 *   3. **读面不因写面缺失而关闭**：`configEditor` 是可选服务，缺失时 `snapshot()` 照常返回
 *      （`writable.ok=false` + `CLI_CONFIG_UNAVAILABLE`），页面降级为只读；只有 `save()` 会失败。
 *      一个可选服务缺失就让整片只读面 503，会让"看不到当前生效哪一层"这种无害的诉求也失败。
 *
 * 回显边界（AC-10）：`snapshot()` 含路径，只给同源 GET 路由；`describe()` 走
 * `cli-config.describeCliAccess()`（结构上不读 `value`）。两个方法，故意不合并成一个带开关的函数。
 *
 * 零子进程、零缓存文件：文件系统只经注入的同步 `fs`（`statSync` / `readdirSync`）读；
 * 发现结果只驻内存，运行插件不会让 `git status` 多出新文件（PRD §10）。
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';

import {
  CLI_FIELDS,
  CLI_REASONS,
  buildCliPatch,
  describeCliAccess,
  resolveCliAccess,
} from './cli-config.mjs';
import { discoverCli } from './cli-discovery.mjs';

/** 默认条目 id：与 `cordis.patch.yml` 的 insert `name` / 清单 `name` 同源。 */
export const DEFAULT_ENTRY_ID = 'forge-devops';

/** `revision` 取哈希的前多少个十六进制字符：够短可抄，够长不撞。 */
export const REVISION_LENGTH = 16;

/** 六个字段里"值是一条命令行路径"的两个（快照要给候选与拒收项，其余只给值）。 */
const PATH_FIELDS = Object.freeze(['dopBin', 'ghBin']);

/** 路径字段 ←→ 发现工具名：与 `cli-config` 的 `TOOL_BY_FIELD` 同源，快照要用它挑候选。 */
const TOOL_BY_FIELD = Object.freeze({ dopBin: 'dop', ghBin: 'gh' });

/** 默认注入的同步 fs 面：只读、同步、无子进程（发现与保存校验共用）。 */
const NODE_FS = Object.freeze({ statSync, readdirSync });

/** `config-editor` 在条目被并发替换时抛出的两类文案（其余一律按"写不进去"处理）。 */
const REPLACED_PATTERN = /no longer available|changed during reload/iu;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 用户层的规范化形态：丢掉 `null`/`undefined`/空串（等价于"没有这个键"），键按名字排序。
 *
 * 排序不是为了好看：revision 是 `JSON.stringify` 的哈希，YAML 里键的书写顺序会随着
 * 手工编辑变化，不排序就会"内容没变、revision 变了"→ 用户每次保存都先吃一个假冲突。
 */
function canonicalLayer(layer) {
  const source = isPlainObject(layer) ? layer : {};
  const out = {};
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

/** `revision`（§2.5）：`sha256(规范化用户层)` 前 16 位。空层也有值（空对象的哈希）。 */
function hashLayer(layer) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalLayer(layer)))
    .digest('hex')
    .slice(0, REVISION_LENGTH);
}

/** 两个层是否"内容相同"（同一组键、同一批值）。用于等值噪声判定与写后回读。 */
function sameLayer(left, right) {
  const a = canonicalLayer(left);
  const b = canonicalLayer(right);
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/**
 * 建立命令行配置的宿主状态。
 *
 * @param {object} [options]
 * @param {object|{ok:boolean,value?:object}|null} [options.config] 装配期配置层（loader 的原始配置
 *   或 `resolveRuntimeConfig()` 信封；两种都接受，判断只在 `cli-config` 里做一次）
 * @param {object|null} [options.env] 环境变量表；缺省读 `process.env`（显式传入便于离线复现）
 * @param {string} [options.platform] `process.platform` 口径（注入以便用用例覆盖 Windows）
 * @param {{statSync:Function,readdirSync:Function}} [options.fs] 同步 fs 面；缺省用 `node:fs`
 * @param {() => number} [options.now] 时钟（发现预算用；用例注入假时钟）
 * @param {object|null} [options.configEditor] 宿主 `ctx.get('configEditor')`；缺失即只读
 * @param {string} [options.entryId] 本插件在 profile 补丁里的条目 id
 * @returns {{
 *   entryId: string,
 *   revision: () => string|null,
 *   snapshot: (options?: {refresh?: boolean}) => object,
 *   describe: () => object,
 *   save: (options?: {revision?: string, fields?: object}) => Promise<object>,
 * }}
 */
export function createCliAccess(options = {}) {
  const {
    config = null,
    env = null,
    platform = null,
    fs = null,
    now = Date.now,
    configEditor = null,
    entryId = DEFAULT_ENTRY_ID,
  } = options ?? {};

  const resolvedPlatform = typeof platform === 'string' && platform !== '' ? platform : process.platform;
  const resolvedEnv = isPlainObject(env) ? env : process.env;
  const resolvedFs = isPlainObject(fs) || (fs !== null && typeof fs === 'object') ? fs : NODE_FS;
  const clock = typeof now === 'function' ? now : Date.now;
  const editor = isPlainObject(configEditor) || (configEditor !== null && typeof configEditor === 'object')
    ? configEditor
    : null;

  /** 配置层：装配期来自 loader，保存/刷新后来自 `configEditor` 的 `inherited + override`。 */
  let configLayer = config;
  /** 发现结果：只在构造与 `refresh` 时更换；`null` = 这次发现没跑起来（回落到配置/环境变量）。 */
  let discovery = discoverOnce();
  /** 合并结果（含路径，主机内）。 */
  let access = merge();

  function discoverOnce() {
    try {
      return discoverCli({
        platform: resolvedPlatform,
        env: resolvedEnv,
        fs: resolvedFs,
        now: clock,
      });
    } catch {
      // 发现是"尽力而为"：注入的 fs 不可用只该让结果退化成配置/环境变量，不该让 apply 崩掉。
      return null;
    }
  }

  function merge() {
    return resolveCliAccess({
      config: configLayer,
      env: resolvedEnv,
      discovery,
      platform: resolvedPlatform,
    });
  }

  /**
   * 读本条目在 profile 补丁里的三层视图（`config-editor` 的 `{ entry, inherited, override }`）。
   * 每次调用都现读：`revision` 必须反映**此刻**的磁盘内容，缓存会让栅栏形同虚设。
   */
  function readRow() {
    if (editor === null || typeof editor.configuration !== 'function') return null;
    let rows;
    try {
      rows = editor.configuration();
    } catch {
      // 补丁 YAML 坏了 / profile 目录不可读：页面应当降级为只读，而不是整片 500。
      return null;
    }
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      const rowOptions = isPlainObject(row) && isPlainObject(row.entry) ? row.entry.options : null;
      if (!isPlainObject(rowOptions)) continue;
      if (rowOptions.id === entryId || rowOptions.name === entryId) return row;
    }
    return null;
  }

  /** 写面可用性：无 `configEditor`、无本条目、或补丁不可读，一律"只读"。 */
  function writableOf(row) {
    if (row === null) return Object.freeze({ ok: false, reason: CLI_REASONS.UNAVAILABLE, documentPath: false });
    const documentPath = editor !== null && typeof editor.documentPath === 'string' ? editor.documentPath : '';
    // 文档路径本身不外泄（AC-10）：只给"有没有"这一个布尔。
    return Object.freeze({ ok: true, documentPath: documentPath !== '' });
  }

  /** 保存后的配置层 = 继承层 + 用户层（后者逐键覆盖），与 loader 组合补丁的口径一致。 */
  function mergedLayer(row) {
    const inherited = isPlainObject(row?.inherited) ? row.inherited : {};
    const override = canonicalLayer(row?.override);
    return { ...inherited, ...override };
  }

  /** 重新合并（不重扫发现）——保存成功与刷新读面共用。 */
  function remerge(row) {
    if (row !== null) configLayer = mergedLayer(row);
    access = merge();
  }

  function pathEntry(field) {
    const entry = access.entries[field] ?? {};
    const tool = TOOL_BY_FIELD[field] ?? (typeof entry.tool === 'string' ? entry.tool : field);
    const toolDiscovery = isPlainObject(discovery) && isPlainObject(discovery[tool]) ? discovery[tool] : null;
    const candidates = Array.isArray(toolDiscovery?.found)
      ? toolDiscovery.found
          .filter((item) => isPlainObject(item) && typeof item.path === 'string')
          .map((item) => Object.freeze({ path: item.path, tier: item.tier }))
      : [];
    const rejected = Array.isArray(toolDiscovery?.rejected)
      ? toolDiscovery.rejected
          .filter((item) => isPlainObject(item) && typeof item.path === 'string')
          .map((item) => Object.freeze({ path: item.path, why: item.why }))
      : [];
    return Object.freeze({
      origin: entry.origin,
      path: typeof entry.value === 'string' ? entry.value : null,
      tool,
      overrides: entry.overrides,
      candidates: Object.freeze(candidates),
      rejected: Object.freeze(rejected),
    });
  }

  function valueEntry(field) {
    const entry = access.entries[field] ?? {};
    return Object.freeze({
      origin: entry.origin,
      value: entry.value === null || entry.value === undefined ? null : entry.value,
      overrides: entry.overrides,
    });
  }

  /** 给页面的快照（含路径，只经同源 GET 出网）。`row` 由调用方传入，避免一次请求里读两遍磁盘。 */
  function buildSnapshot(row) {
    const entries = {};
    for (const field of CLI_FIELDS) {
      entries[field] = PATH_FIELDS.includes(field) ? pathEntry(field) : valueEntry(field);
    }
    return Object.freeze({
      revision: row === null ? null : hashLayer(row.override),
      writable: writableOf(row),
      ready: access.ready === true,
      reason: typeof access.reason === 'string' ? access.reason : null,
      guidance: typeof access.guidance === 'string' ? access.guidance : '',
      entries: Object.freeze(entries),
      host: Object.freeze({ platform: resolvedPlatform, arch: process.arch, node: process.version }),
    });
  }

  function revision() {
    const row = readRow();
    return row === null ? null : hashLayer(row.override);
  }

  function snapshot(snapshotOptions = {}) {
    if (snapshotOptions?.refresh === true) {
      discovery = discoverOnce();
      const refreshed = readRow();
      remerge(refreshed);
      return buildSnapshot(refreshed);
    }
    return buildSnapshot(readRow());
  }

  function describe() {
    return describeCliAccess(access);
  }

  /**
   * 保存（§5 五步）：栅栏 → 校验 → 等值跳过 → 写 → 写后回读。
   *
   * 顺序上先把"有没有可写条目"放在栅栏前面：没有可写条目时，revision 无从谈起，
   * 报 409「配置已在别处修改」会把用户引向一个不存在的原因；503「这里不可写」才是事实。
   *
   * @param {{revision?: string, fields?: object}} [saveOptions]
   * @returns {Promise<{ok:true, snapshot:object}|{ok:false, code:string, message?:string, errors?:object}>}
   */
  async function save(saveOptions = {}) {
    const expected = saveOptions?.revision;
    const fields = saveOptions?.fields;

    const row = readRow();
    if (row === null || typeof editor?.edit !== 'function') {
      return {
        ok: false,
        code: CLI_REASONS.UNAVAILABLE,
        message: '当前 profile 没有可写的插件条目，配置只能读取',
      };
    }

    const current = hashLayer(row.override);
    if (typeof expected !== 'string' || expected !== current) {
      return { ok: false, code: CLI_REASONS.CONFLICT, message: '配置已在别处修改，请刷新后重试' };
    }

    if (!isPlainObject(fields)) {
      return { ok: false, code: CLI_REASONS.INVALID, errors: Object.freeze({ fields: '请求体缺少字段对象' }) };
    }

    const built = buildCliPatch({
      current: canonicalLayer(row.override),
      patch: fields,
      platform: resolvedPlatform,
      fs: resolvedFs,
    });
    if (built.ok !== true) {
      return { ok: false, code: CLI_REASONS.INVALID, errors: built.errors };
    }

    // 等值噪声（AC-15）：算出来的用户层与现存的一模一样 → 不碰磁盘，直接回快照。
    // 仍然用刚读到的用户层刷新一次合并结果：快照不能与它自己刚给出的 revision 互相矛盾。
    if (sameLayer(built.next, row.override)) {
      remerge(row);
      return { ok: true, snapshot: buildSnapshot(row) };
    }

    try {
      // `config-editor` 负责注释保留、原子写、失败回滚与条目热调和；这里只给"要写成什么"。
      await editor.edit(row.entry, () => built.next);
    } catch (error) {
      const replaced = typeof error?.message === 'string' && REPLACED_PATTERN.test(error.message);
      return {
        ok: false,
        code: replaced ? CLI_REASONS.CONFLICT : CLI_REASONS.UNAVAILABLE,
        message: replaced ? '配置条目已被替换，请刷新后重试' : '写入配置失败，请检查 profile 权限',
      };
    }

    const after = readRow();
    if (after === null || !sameLayer(after.override, built.next)) {
      return { ok: false, code: CLI_REASONS.UNAVAILABLE, message: '写入后回读与预期不一致，请刷新确认' };
    }

    remerge(after);
    return { ok: true, snapshot: buildSnapshot(after) };
  }

  return Object.freeze({ entryId, revision, snapshot, describe, save });
}
