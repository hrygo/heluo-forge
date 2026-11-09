/**
 * `@heluo/forge-gitee` 配置的宿主状态（T1）：装配期快照、revision 栅栏、增量保存编排。
 *
 * 与 `@heluo/forge-devops/src/cli-access.mjs` **同形**（TECHNICAL §3.1 要求逐字复用四件套：
 * `canonicalLayer` / `hashLayer` / `sameLayer` / `readRow`）。两包不跨源码导入（AGENTS §4），
 * 重复面由 `tests/ui-contract.test.mjs` 的文本契约守——漂移即红，而不是靠自觉。
 *
 * 三处与 devops 的差异，都是"Gitee 侧没有那个能力"造成的：
 *
 *   1. **没有发现层**（DESIGN §3.3：无自动发现）。所以 origin 词表只有
 *      `config / default / unset`，`snapshot({refresh})` 只重读磁盘、不扫文件系统——
 *      "刷新"在这里是零成本的，页面也就没有"重新自动发现"这个按钮。
 *   2. **多一列"公共参数"**（AC-4）：profile 补丁层的 `inherited` 是随包分发的公共层，
 *      `override` 是本机覆盖层，`entries[*]` 把三层都摊开，页面不必自己合并。
 *   3. **可写面只有两个键**（`cliPath` / `timeoutMs`）：`host`、`authEnv`、`persistentToken`
 *      是合规面的东西，本机页面只读呈现，`save()` 对这三个键仍接受（白名单是五键），
 *      但页面不发——"能写"与"该在这里写"是两件事。
 *
 * 回显边界（AC-12）：`snapshot()` 含配置值（含 `cliPath` 路径），只给同源 GET 路由；
 * `describe()` 是**结构化脱敏投影**，只有来源枚举、布尔位与变量名，结构上不读 `value`。
 * 两个方法故意不合并成一个带开关的函数。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  CONFIG_REASONS,
  DEFAULT_CLI_PATH,
  DEFAULT_PERSISTENT_TOKEN_POLICY,
  DEFAULT_TIMEOUT_MS,
  describeGiteeConfig,
  resolveGiteeConfig,
  validateGiteeConfig,
} from './runtime-config.mjs';

/** 默认条目 id：与 `cordis.patch.yml` 的 insert `id` / 清单 `name` 同源。 */
export const GITEE_ENTRY_ID = 'heluo-gitee';

/** 补丁层里本插件的五键配置面（白名单：多一个键直接 422，不猜"也许他想写点别的"）。 */
export const GITEE_CONFIG_KEYS = Object.freeze(['cliPath', 'host', 'timeoutMs', 'authEnv', 'persistentToken']);

/** 页面可写面（DESIGN §3.3）：只有入口与超时。 */
export const GITEE_PAGE_FIELDS = Object.freeze(['cliPath', 'timeoutMs']);

/** 三层来源词表：公共参数层也算 `config`（它就是补丁层里的配置），`unset` 只给没有默认的 `host`。 */
export const GITEE_ORIGINS = Object.freeze({
  CONFIG: 'config',
  DEFAULT: 'default',
  UNSET: 'unset',
});

/** 保存失败的三码（`http.mjs` 的 409/422/503 映射就用这三个）。 */
export const GITEE_ACCESS_REASONS = Object.freeze({
  UNAVAILABLE: 'GITEE_CONFIG_UNAVAILABLE',
  CONFLICT: 'GITEE_CONFIG_CONFLICT',
  INVALID: 'GITEE_CONFIG_INVALID',
});

/**
 * "已保存、未应用"的原因码（TECHNICAL §3.2 的 `applied.reason`）。
 *
 * 它不属于 `GITEE_ACCESS_REASONS` 的三码（那三个是**保存**的失败面）；这里说的是保存成功、
 * 重建读面失败——两个结论必须能同时出现，所以是两个字段而不是一个。
 */
export const GITEE_REBUILD_REASON = 'GITEE_REBUILD_FAILED';

/** 指引文案：页面与错误体共用一句，别在两处各写一个"去设置页"的说法。 */
export const GITEE_PAGE_HINT = '设置 → Gitee';

/** `revision` 取哈希的前多少个十六进制字符：够短可抄，够长不撞。 */
export const REVISION_LENGTH = 16;

/** 字段 ←→ 内置默认：`origin === 'default'` 的判定与"恢复继承"后的回落值都来自这里。 */
const DEFAULTS = Object.freeze({
  cliPath: DEFAULT_CLI_PATH,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  authEnv: Object.freeze([]),
  persistentToken: DEFAULT_PERSISTENT_TOKEN_POLICY,
});

/** 值是一条命令行入口的字段（快照要按 `path` 命名，页面直接填进输入框）。 */
const PATH_FIELDS = Object.freeze(['cliPath']);

/** 路径字段对应的工具名：Gitee 侧唯一入口是 `gh`（没有发现层，所以没有候选列表）。 */
const TOOL_BY_FIELD = Object.freeze({ cliPath: 'gh' });

/** `config-editor` 在条目被并发替换时抛出的两类文案（其余一律按"写不进去"处理）。 */
const REPLACED_PATTERN = /no longer available|changed during reload/iu;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const has = (layer, key) => Object.prototype.hasOwnProperty.call(layer, key);

/** `validateGiteeConfig` 的 issues → 页面的按字段错误；同一字段只留第一条。 */
function fieldErrorsOf(issues) {
  const errors = {};
  for (const issue of issues) {
    const path = Array.isArray(issue?.path) && issue.path.length > 0 ? issue.path[0] : 'fields';
    if (!has(errors, path)) errors[path] = typeof issue.message === 'string' ? issue.message : '配置项不合法';
  }
  return Object.freeze(errors);
}

/**
 * 锁内中止用：`configEditor.edit` 的回调只能"返回新层"，要中止只能抛。
 *
 * 用一个带标记的私有错误把"锁内发现 revision 已变 / 层不合法"和"宿主写盘失败"分开，
 * 否则两者会被同一个 `catch` 都报成 503，页面就分不清该刷新还是该重试。
 */
function editAbort(outcome) {
  const error = new Error('gitee config edit aborted');
  error.name = 'GiteeConfigEditAbortError';
  error.giteeEditOutcome = outcome;
  return error;
}

/**
 * 本包自己的 `{name, version}`：**唯一**来源（TECHNICAL §3.5）。
 *
 * 浏览器半不读 `package.json`——版本若有两个来源，页脚就能在"分区由谁提供"上撒谎。
 * `npm pack` 恒包含 `package.json`，所以这个相对路径在分发形态里也成立；读不到时给一个
 * 明显是占位的版本号，而不是编一个像真的。
 */
export const GITEE_PLUGIN = Object.freeze(readPlugin());

function readPlugin() {
  try {
    const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed) && typeof parsed.name === 'string' && typeof parsed.version === 'string') {
      return { name: parsed.name, version: parsed.version };
    }
  } catch {
    // 只影响页脚的一行字，不该让整条 entry 装配失败。
  }
  return { name: '@heluo/forge-gitee', version: '0.0.0' };
}

/**
 * 用户层的规范化形态：丢掉 `null`/`undefined`/空串（等价于"没有这个键"），键按名字排序。
 *
 * 排序不是为了好看：`revision` 是 `JSON.stringify` 的哈希，YAML 里键的书写顺序会随着手工
 * 编辑变化，不排序就会"内容没变、revision 变了"→ 用户每次保存都先吃一个假冲突。
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

/** `revision`：`sha256(规范化用户层)` 前 16 位。空层也有值（空对象的哈希）。 */
function hashLayer(layer) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalLayer(layer)))
    .digest('hex')
    .slice(0, REVISION_LENGTH);
}

/**
 * 两个层是否"内容相同"（同一组键、同一批值）。用于等值噪声判定与写后回读。
 *
 * 用规范化 JSON 比较而不是逐键 `===`：`authEnv` 是数组，引用比较会让"内容没变"的保存
 * 每次都真的写盘——这正是等值跳过要防的那件事。
 */
function sameLayer(left, right) {
  return JSON.stringify(canonicalLayer(left)) === JSON.stringify(canonicalLayer(right));
}

/** 单字段的"层里声明的值"（按该字段自己的校验器归一；非法值在层里就是不可展示的）。 */
function layerValueOf(field, layer) {
  if (!has(layer, field)) return null;
  const verified = validateGiteeConfig({ [field]: layer[field] });
  const accepted = isPlainObject(verified.value) ? verified.value : null;
  if (accepted === null || !has(accepted, field)) return null;
  return accepted[field];
}

/** 生效值（来自 `resolveGiteeConfig()`：它已经算好默认回落，页面不再推导第二套）。 */
function effectiveValueOf(field, resolved) {
  if (field === 'cliPath') return resolved.cliPath;
  if (field === 'host') return resolved.host;
  if (field === 'timeoutMs') return resolved.timeoutMs;
  if (field === 'authEnv') return [...resolved.authEnv];
  if (field === 'persistentToken') return resolved.persistentToken;
  return null;
}

/**
 * 被压过的下层（按"低 → 高"排列，与 devops 的 `overrides` 语义一致）。
 *
 * 三层里只有两层会出现在这里：公共参数层（`inherited`）与内置默认。本机覆盖层是赢家时
 * 才列下层；没有本机覆盖时赢家就是公共参数层或默认层，`overrides` 为空。
 */
function losingLayers(field, inherited, override) {
  const out = [];
  if (has(override, field)) {
    if (has(inherited, field)) {
      const value = layerValueOf(field, inherited);
      if (value !== null) out.push(Object.freeze({ origin: GITEE_ORIGINS.CONFIG, value }));
    }
    if (has(DEFAULTS, field) && DEFAULTS[field] !== undefined) {
      const value = DEFAULTS[field];
      if (!has(inherited, field)) out.push(Object.freeze({ origin: GITEE_ORIGINS.DEFAULT, value }));
    }
    return out;
  }
  if (has(inherited, field) && has(DEFAULTS, field) && DEFAULTS[field] !== undefined) {
    out.push(Object.freeze({ origin: GITEE_ORIGINS.DEFAULT, value: DEFAULTS[field] }));
  }
  return out;
}

/**
 * 建立 Gitee 配置的宿主状态。
 *
 * @param {object} [options]
 * @param {object|null} [options.config] 装配期配置层（loader 传入；无补丁条目时它是唯一来源）
 * @param {object|null} [options.env] 环境变量表；缺省读 `process.env`（显式传入便于离线复现）
 * @param {string} [options.platform] `process.platform` 口径（注入以便用例覆盖）
 * @param {object|null} [options.configEditor] 宿主 `ctx.get('configEditor')`；缺失即只读
 * @param {string} [options.entryId] 本插件在 profile 补丁里的条目 id
 * @param {{name:string,version:string}} [options.plugin] 插件版本投影；缺省取本包 `package.json`
 * @returns {{
 *   entryId: string,
 *   revision: () => string|null,
 *   snapshot: (options?: {refresh?: boolean}) => object,
 *   describe: () => object,
 *   save: (options?: {revision?: string, fields?: object}) => Promise<object>,
 * }}
 */
export function createGiteeAccess(options = {}) {
  const {
    config = null,
    env = null,
    platform = null,
    configEditor = null,
    entryId = GITEE_ENTRY_ID,
    plugin = GITEE_PLUGIN,
    now = null,
  } = options ?? {};

  const clock = typeof now === 'function' ? now : () => Date.now();

  const resolvedPlatform = typeof platform === 'string' && platform !== '' ? platform : process.platform;
  const resolvedEnv = isPlainObject(env) ? env : process.env;
  const editor = isPlainObject(configEditor) || (configEditor !== null && typeof configEditor === 'object')
    ? configEditor
    : null;
  const projected = isPlainObject(plugin) && typeof plugin.name === 'string' && typeof plugin.version === 'string'
    ? Object.freeze({ name: plugin.name, version: plugin.version })
    : GITEE_PLUGIN;

  /** 配置层：装配期来自 loader，保存/刷新后来自 `configEditor` 的 `inherited + override`。 */
  let configLayer = canonicalLayer(config);

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
    if (row === null) {
      return Object.freeze({ ok: false, reason: GITEE_ACCESS_REASONS.UNAVAILABLE });
    }
    const documentPath = editor !== null && typeof editor.documentPath === 'string' ? editor.documentPath : '';
    // 文档路径本身不外泄（AC-12）：只给"有没有"这一个布尔。
    return Object.freeze({ ok: true, documentPath: documentPath !== '' });
  }

  /** 保存后的配置层 = 继承层 + 用户层（后者逐键覆盖），与 loader 组合补丁的口径一致。 */
  function mergedLayer(row) {
    const inherited = isPlainObject(row?.inherited) ? canonicalLayer(row.inherited) : {};
    const override = canonicalLayer(row?.override);
    return { ...inherited, ...override };
  }

  /** 重新合并（不重扫任何东西）——保存成功与刷新读面共用。 */
  function remerge(row) {
    configLayer = row !== null ? mergedLayer(row) : canonicalLayer(config);
  }

  function buildSnapshot(row) {
    const inherited = isPlainObject(row?.inherited) ? canonicalLayer(row.inherited) : {};
    const override = canonicalLayer(row?.override);
    const effective = row === null ? configLayer : { ...inherited, ...override };
    const resolved = resolveGiteeConfig({ config: effective, env: resolvedEnv });
    const verified = validateGiteeConfig(effective);
    const invalid = Array.isArray(verified.issues) && verified.issues.length > 0;

    const entries = {};
    for (const field of GITEE_CONFIG_KEYS) {
      // `origin` 说的是**生效值**来自哪一层，口径与 devops 的 `resolveField` 一致：
      // 配置层（公共参数 ∪ 本机覆盖）有键就是 `config`，否则内置缺省 `default`，再否则 `unset`。
      // "这一键是本机覆盖还是公共参数"是**另一列**（`override` / `inherited`），不挤进 origin——
      // 否则同一份词表在两处表示两件事，页面与企业研发汇总各读一半就会互相矛盾。
      const origin = has(effective, field)
        ? GITEE_ORIGINS.CONFIG
        : has(DEFAULTS, field) ? GITEE_ORIGINS.DEFAULT : GITEE_ORIGINS.UNSET;
      const value = effectiveValueOf(field, resolved);
      const overrides = losingLayers(field, inherited, override);
      const base = {
        origin,
        overrides: Object.freeze(overrides),
        // 三列展示（AC-4）：公共参数层 / 本机覆盖层各是什么，页面不再自己合并。
        inherited: layerValueOf(field, inherited),
        override: layerValueOf(field, override),
      };
      entries[field] = PATH_FIELDS.includes(field)
        ? Object.freeze({
            ...base,
            path: typeof value === 'string' ? value : null,
            value: typeof value === 'string' ? value : null,
            tool: TOOL_BY_FIELD[field] ?? field,
            candidates: Object.freeze([]),
            rejected: Object.freeze([]),
          })
        : Object.freeze({
            ...base,
            value: Array.isArray(value) ? Object.freeze([...value]) : value,
          });
    }

    return Object.freeze({
      entryId,
      revision: row === null ? null : hashLayer(row.override),
      plugin: projected,
      // 页面页脚要显示"读取于 <时间>"：给一个服务端时刻，别让浏览器自己编一个。
      readAt: new Date(clock()).toISOString(),
      writable: writableOf(row),
      // "已配置" = 配置层里有本插件认识的键，且它们都通过校验；没有键就是"未配置"，
      // 不是"通过"（AC-10：页面永远不把"装上了"写成"就绪"）。
      ready: !invalid && Object.keys(effective).length > 0,
      reason: invalid ? CONFIG_REASONS.INVALID : null,
      guidance: GITEE_PAGE_HINT,
      editable: Object.freeze([...GITEE_PAGE_FIELDS]),
      missing: Object.freeze([...resolved.missing]),
      entries: Object.freeze(entries),
      host: Object.freeze({ platform: resolvedPlatform, arch: process.arch, node: process.version }),
    });
  }

  function revision() {
    const row = readRow();
    return row === null ? null : hashLayer(row.override);
  }

  function snapshot(snapshotOptions = {}) {
    // `refresh` 在这里只意味着"重新读一次磁盘 + 重新合并"：没有发现层可扫，成本为零。
    const row = readRow();
    if (snapshotOptions?.refresh === true) remerge(row);
    return buildSnapshot(row);
  }

  /**
   * 结构化脱敏投影（AC-12）：只出来源枚举、布尔位与变量名。
   *
   * 结构上不把任何 `value` 读进返回值——配置值只经 `snapshot()` 出网给同源 GET。
   */
  function describe() {
    const row = readRow();
    const built = buildSnapshot(row);
    const entries = {};
    for (const field of GITEE_CONFIG_KEYS) {
      const entry = built.entries[field] ?? {};
      entries[field] = Object.freeze({
        origin: typeof entry.origin === 'string' ? entry.origin : GITEE_ORIGINS.UNSET,
        configured: entry.value !== null && entry.value !== undefined,
        overrides: Object.freeze(
          (Array.isArray(entry.overrides) ? entry.overrides : [])
            .map((item) => (isPlainObject(item) && typeof item.origin === 'string' ? item.origin : null))
            .filter((item) => item !== null),
        ),
      });
    }
    return Object.freeze({
      entryId,
      revision: built.revision,
      plugin: built.plugin,
      writable: built.writable,
      ready: built.ready,
      reason: built.reason,
      guidance: built.guidance,
      editable: built.editable,
      missing: built.missing,
      entries: Object.freeze(entries),
      host: built.host,
      // 保留一行"给人看"的描述（脱敏口径与 `describeGiteeConfig` 同源），排障时不必再看快照。
      text: describeGiteeConfig(resolveGiteeConfig({ config: configLayer, env: resolvedEnv })),
    });
  }

  /**
   * 保存（TECHNICAL §3.1 八步）：可写面 → 栅栏 → 形状 → 校验 → 等值跳过 → 写 → 回读。
   *
   * 顺序上先把"有没有可写条目"放在栅栏前面：没有可写条目时 revision 无从谈起，报 409
   * "配置已在别处修改"会把用户引向一个不存在的原因；503"这里不可写"才是事实。
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
        code: GITEE_ACCESS_REASONS.UNAVAILABLE,
        message: '当前 profile 没有可写的插件条目，配置只能读取',
      };
    }

    const observed = hashLayer(row.override);
    if (typeof expected !== 'string' || expected !== observed) {
      // 快照已明确过期：连锁都不用拿（AC-6 要求 409 时 editor 调用 0 次）。
      // 但这只是快速路径——**权威栅栏在锁内**，见下面的 `editAbort({ conflict: true })`。
      return { ok: false, code: GITEE_ACCESS_REASONS.CONFLICT, message: '配置已在别处修改，请刷新后重试' };
    }

    if (!isPlainObject(fields)) {
      return { ok: false, code: GITEE_ACCESS_REASONS.INVALID, errors: Object.freeze({ fields: '请求体缺少字段对象' }) };
    }

    const unknown = Object.keys(fields).filter((key) => !GITEE_CONFIG_KEYS.includes(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        code: GITEE_ACCESS_REASONS.INVALID,
        errors: Object.freeze({ [unknown[0]]: '未知配置项' }),
      };
    }

    /**
     * 把提交的键叠加到**锁内读到的当前层**上。
     *
     * `null` = 删除该键（恢复继承）；空串同义（页面把"清空"发成 `null`，这里两种都收）。
     * 不能基于预检时的 `row.override` 算整层：预检到拿锁之间别的请求可能已经落盘，
     * 用旧快照整层覆盖会把对方刚写的字段恢复回去。
     */
    const applyFields = (base) => {
      const next = canonicalLayer(base);
      for (const [key, value] of Object.entries(fields)) {
        if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
          delete next[key];
          continue;
        }
        next[key] = value;
      }
      return next;
    };

    // 等值噪声与不合法输入在拿锁前就能判定：这两种都要求 editor 调用 0 次（AC-6）。
    const preview = validateGiteeConfig(applyFields(row.override));
    if (Array.isArray(preview.issues) && preview.issues.length > 0) {
      return { ok: false, code: GITEE_ACCESS_REASONS.INVALID, errors: fieldErrorsOf(preview.issues) };
    }
    if (sameLayer(isPlainObject(preview.value) ? preview.value : {}, row.override)) {
      remerge(row);
      return { ok: true, snapshot: buildSnapshot(row) };
    }

    /** 锁内实际算出的写入层；`null` 表示锁内发现与当前层等价、这次没有写。 */
    let written = null;

    try {
      // `config-editor` 负责注释保留、原子写、失败回滚与条目热调和；这里只给"要写成什么"。
      // revision 栅栏必须与写入同在一个临界区，否则两个并发保存都能以同一 revision 通过检查。
      await editor.edit(row.entry, (current) => {
        if (hashLayer(current) !== expected) throw editAbort({ conflict: true });
        const verified = validateGiteeConfig(applyFields(current));
        if (Array.isArray(verified.issues) && verified.issues.length > 0) {
          throw editAbort({ errors: fieldErrorsOf(verified.issues) });
        }
        const normalized = isPlainObject(verified.value) ? verified.value : {};
        if (sameLayer(normalized, current)) return current;
        written = normalized;
        return normalized;
      });
    } catch (error) {
      const outcome = error?.giteeEditOutcome;
      if (outcome?.conflict === true) {
        return { ok: false, code: GITEE_ACCESS_REASONS.CONFLICT, message: '配置已在别处修改，请刷新后重试' };
      }
      if (outcome !== null && typeof outcome === 'object' && isPlainObject(outcome.errors)) {
        return { ok: false, code: GITEE_ACCESS_REASONS.INVALID, errors: outcome.errors };
      }
      const replaced = typeof error?.message === 'string' && REPLACED_PATTERN.test(error.message);
      return {
        ok: false,
        code: replaced ? GITEE_ACCESS_REASONS.CONFLICT : GITEE_ACCESS_REASONS.UNAVAILABLE,
        message: replaced ? '配置条目已被替换，请刷新后重试' : '写入配置失败，请检查 profile 权限',
      };
    }

    const after = readRow();
    if (after === null || (written !== null && !sameLayer(after.override, written))) {
      return { ok: false, code: GITEE_ACCESS_REASONS.UNAVAILABLE, message: '写入后回读与预期不一致，请刷新确认' };
    }

    remerge(after);
    return { ok: true, snapshot: buildSnapshot(after) };
  }

  return Object.freeze({ entryId, revision, snapshot, describe, save });
}
