/**
 * `@heluo/forge-devops` 就绪证据（r16 / D-4）：四层证据的唯一生产者。
 *
 * 这个模块只回答一个问题：**"本机能不能读"这件事，现在有哪些可复核的证据？**
 * 它不发起任何请求、不起子进程、不读环境变量、不读凭据——证据只来自三处注入：
 *   - `snapshot`：`cli-access` 已经算好的三层合并快照（含 revision 与 entries）；
 *   - `row`：`config-editor` 读到的 `{ inherited, override }` 两层（只投影**键名**）；
 *   - `statSync` / `admit`：文件系统与策略门禁两个只读探针（都可缺席）。
 *
 * 四层证据是**独立**的，任一层失败都不能被另一层的"看起来还行"盖掉：
 *
 *   | 层         | pass 的依据                                   | 失败原因码                     |
 *   |------------|-----------------------------------------------|--------------------------------|
 *   | file       | 可解析路径 + 普通文件（文件系统只读探测）     | FILE_NOT_FOUND / IS_DIRECTORY  |
 *   | executable | `entry-form.isDirectlyExecutable` 为真         | NOT_EXECUTABLE                 |
 *   | target     | 来源类型可判定 + endpoint 形状合法             | SOURCE_TYPE_UNKNOWN            |
 *   | readonly   | 策略准入返回 allowed（**不发起真实请求**）     | POLICY_DENIED                  |
 *
 * `readonly: pass` 只表示"策略准入允许读"，**不是**"上游接口可达"：真实探测在 `admit`
 * 里一次都不发生（`policy-guard.admit` 结构上没有下游调用）。页面必须把依据一起显示，
 * 否则一个绿点会被读成"企业联调已通过"——那正是 PRD 反面目标第 1 条。
 *
 * `verdict` 由证据唯一决定（不另设开关）：任一 fail → `fail`（`blockedBy` = 第一层 fail）；
 * 否则任一 not-run → `incomplete`；全 pass → `pass`。`reason` 恒等于 `blockedBy` 层的原因码，
 * 因此"结论"与"证据"不可能各说一套。
 *
 * 零 IO、零缓存：`statSync` 由调用方注入，模块本身不 import `node:fs`；
 * `now` 同样注入，`at` 每次调用只取一次时间。
 */
import { CLI_FIELDS, deriveSourceType } from './cli-config.mjs';
import { isDirectlyExecutable } from './entry-form.mjs';
import { validateConfigField } from './runtime-config.mjs';

/** 契约版本：页面按它判断"这份 readiness 是不是我认识的形状"。 */
export const READINESS_CONTRACT = 1;

/** 对象标识：快照只描述本插件（DevOps）这一面。 */
export const READINESS_OBJECT = 'devops';

/**
 * 来源类型四枚举。`enterprise-evidence` 是**保留位**：本轮没有任何真实企业证据，
 * 生产代码永远不会产出它；页面照常显示（否则用户看不出"本地诊断"与"企业证据"的差别）。
 */
export const READINESS_SOURCE_TYPES = Object.freeze([
  'local-diagnostic',
  'fixture',
  'enterprise-evidence',
  'unknown',
]);

/**
 * 装配层词表 → 就绪词表的唯一映射（r16 / PR #215 review §3）。
 *
 * 装配层拿到的来源是 `cli-config.deriveSourceType()` 的结论（`mock | enterprise`），
 * 就绪视图却按四枚举对外承诺；不在这一处翻译，`buildReadiness()` 会把两者都记成
 * `unknown`，target 层于是恒 fail、verdict 永远不等于 pass。
 *
 * `enterprise` 在这里的含义只是"本机配置诊断"——dop 入口已就绪，**不是**企业证据；
 * 企业证据（`enterprise-evidence`）要等真实探测执行后才可能产生，本轮不产出。
 */
export const CLI_SOURCE_TYPE_TO_READINESS = Object.freeze({
  enterprise: 'local-diagnostic',
  mock: 'fixture',
});

/**
 * 把来源收敛到四枚举：已是四枚举的原样返回，装配层词表按映射翻译，其余记 `unknown`。
 * @param {string} value
 * @returns {string} `READINESS_SOURCE_TYPES` 之一
 */
export function normalizeSourceType(value) {
  if (READINESS_SOURCE_TYPES.includes(value)) return value;
  return CLI_SOURCE_TYPE_TO_READINESS[value] ?? 'unknown';
}

/** 四层证据，顺序即页面渲染顺序（也是 `evidence[]` 的契约顺序）。 */
export const EVIDENCE_LAYERS = Object.freeze(['file', 'executable', 'target', 'readonly']);

/** 三态：pass / fail / not-run。`not-run` 不是失败，也不是通过。 */
export const EVIDENCE_STATES = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  NOT_RUN: 'not-run',
});

/** 证据依据：页面必须能说出"这层是怎么判的"，否则绿点等于空口断言。 */
export const EVIDENCE_BASIS = Object.freeze({
  FILESYSTEM_STAT: 'filesystem-stat',
  CONFIG_SHAPE: 'config-shape',
  POLICY_ADMISSION: 'policy-admission',
});

/** 原因码（页面按码选文案；新增码必须同时补 zh/en 两条文案，`client-shape` 守）。 */
export const EVIDENCE_REASONS = Object.freeze({
  NO_DOP_BIN: 'no-dop-bin',
  PATH_RESOLUTION_REQUIRED: 'path-resolution-required',
  FILE_NOT_FOUND: 'file-not-found',
  IS_DIRECTORY: 'is-directory',
  NOT_EXECUTABLE: 'not-executable',
  SOURCE_TYPE_UNKNOWN: 'source-type-unknown',
  POLICY_UNAVAILABLE: 'policy-unavailable',
  POLICY_DENIED: 'policy-denied',
  CONFIRMATION_REQUIRED: 'confirmation-required',
  NO_EVIDENCE: 'no-evidence',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 空层判定与 `cli-access.canonicalLayer` 同口径：null/undefined/空白串 = 没有这个键。 */
function hasLayerValue(layer, field) {
  if (!Object.hasOwn(layer, field)) return false;
  const value = layer[field];
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

/**
 * 三层视图的**键名**投影（§3.2 / AC-6）。值永远不进快照：路径与 endpoint 属于回显边界。
 *
 * @param {{inherited?:object,override?:object}|null} row `config-editor` 的条目行
 * @param {readonly string[]} [fields] 参与投影的字段（默认与服务端 `CLI_FIELDS` 同序）
 * @returns {{inherited:string[],override:string[],missing:string[]}}
 *   `missing` 是**原因码**（不是字段名）：整行读不到 → `LAYERS_UNAVAILABLE`；
 *   某层为空 → `INHERITED_EMPTY` / `OVERRIDE_EMPTY`；行里根本没有 `override` 键 → `NO_REVISION`。
 */
export function projectLayers(row, fields = CLI_FIELDS) {
  const list = Array.isArray(fields) && fields.length > 0 ? fields : CLI_FIELDS;
  if (row === null || row === undefined) {
    return Object.freeze({
      inherited: Object.freeze([]),
      override: Object.freeze([]),
      missing: Object.freeze(['LAYERS_UNAVAILABLE']),
    });
  }
  const inheritedLayer = isPlainObject(row.inherited) ? row.inherited : {};
  const overrideLayer = isPlainObject(row.override) ? row.override : {};
  const inherited = list.filter((field) => hasLayerValue(inheritedLayer, field)).sort();
  const override = list.filter((field) => hasLayerValue(overrideLayer, field)).sort();
  const missing = [];
  if (inherited.length === 0) missing.push('INHERITED_EMPTY');
  if (override.length === 0) missing.push('OVERRIDE_EMPTY');
  if (!Object.hasOwn(row, 'override')) missing.push('NO_REVISION');
  return Object.freeze({
    inherited: Object.freeze(inherited),
    override: Object.freeze(override),
    missing: Object.freeze(missing),
  });
}

/** 一条证据。`basis` 只在"真的用了某个探针"时才有值。 */
function evidence(id, state, reason, basis) {
  return Object.freeze({
    id,
    state,
    reason: reason ?? null,
    basis: basis ?? null,
  });
}

/** 路径样子的判定：带目录分隔符或盘符才算"可解析"，裸命令名需要 PATH 解析（not-run）。 */
function isPathLike(value) {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/u.test(value);
}

/** 从快照 entries 里取 dopBin 的当前值（devops 快照用 `path`，原始合并态用 `value`）。 */
function binPathOf(entries) {
  const entry = isPlainObject(entries.dopBin) ? entries.dopBin : {};
  if (typeof entry.path === 'string' && entry.path.trim() !== '') return entry.path;
  if (typeof entry.value === 'string' && entry.value.trim() !== '') return entry.value;
  return null;
}

/** 从快照 entries 里取 dopEndpoint 的当前值（形状判定用；值本身不外泄）。 */
function endpointValueOf(entries) {
  const entry = isPlainObject(entries.dopEndpoint) ? entries.dopEndpoint : {};
  if (typeof entry.value === 'string' && entry.value.trim() !== '') return entry.value;
  return null;
}

/** 只读探测一次文件形态：失败不抛（返回 `null` = 读不到）。 */
function statOnce(statSync, file) {
  if (typeof statSync !== 'function') return null;
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function fileEvidence(binPath, statSync) {
  if (binPath === null) return evidence('file', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.NO_DOP_BIN, null);
  if (!isPathLike(binPath)) {
    return evidence('file', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.PATH_RESOLUTION_REQUIRED, null);
  }
  if (typeof statSync !== 'function') {
    return evidence('file', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.NO_EVIDENCE, null);
  }
  const stat = statOnce(statSync, binPath);
  if (stat === null || typeof stat !== 'object') {
    return evidence('file', EVIDENCE_STATES.FAIL, EVIDENCE_REASONS.FILE_NOT_FOUND, EVIDENCE_BASIS.FILESYSTEM_STAT);
  }
  if (typeof stat.isDirectory === 'function' && stat.isDirectory() === true) {
    return evidence('file', EVIDENCE_STATES.FAIL, EVIDENCE_REASONS.IS_DIRECTORY, EVIDENCE_BASIS.FILESYSTEM_STAT);
  }
  if (typeof stat.isFile !== 'function' || stat.isFile() !== true) {
    // 目录以外的非常规文件（socket/fifo/设备）同样不是可启动的普通文件。
    return evidence('file', EVIDENCE_STATES.FAIL, EVIDENCE_REASONS.FILE_NOT_FOUND, EVIDENCE_BASIS.FILESYSTEM_STAT);
  }
  return evidence('file', EVIDENCE_STATES.PASS, null, EVIDENCE_BASIS.FILESYSTEM_STAT);
}

function executableEvidence(file, binPath, stat, platform) {
  if (file.state === EVIDENCE_STATES.NOT_RUN) {
    return evidence('executable', EVIDENCE_STATES.NOT_RUN, file.reason, null);
  }
  if (file.state === EVIDENCE_STATES.FAIL || stat === null) {
    // 文件层已经不成立：可执行性无从判定，如实记 not-run，不猜。
    return evidence('executable', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.NO_EVIDENCE, null);
  }
  if (isDirectlyExecutable({ path: binPath, platform, stat }) === true) {
    return evidence('executable', EVIDENCE_STATES.PASS, null, EVIDENCE_BASIS.FILESYSTEM_STAT);
  }
  return evidence('executable', EVIDENCE_STATES.FAIL, EVIDENCE_REASONS.NOT_EXECUTABLE, EVIDENCE_BASIS.FILESYSTEM_STAT);
}

function targetEvidence(binPath, endpointValue, sourceType) {
  if (binPath === null && endpointValue === null) {
    return evidence('target', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.NO_EVIDENCE, null);
  }
  if (sourceType === 'unknown') {
    return evidence('target', EVIDENCE_STATES.FAIL, EVIDENCE_REASONS.SOURCE_TYPE_UNKNOWN, null);
  }
  if (endpointValue !== null && validateConfigField('dopEndpoint', endpointValue).ok !== true) {
    return evidence('target', EVIDENCE_STATES.FAIL, EVIDENCE_REASONS.SOURCE_TYPE_UNKNOWN, null);
  }
  return evidence('target', EVIDENCE_STATES.PASS, null, EVIDENCE_BASIS.CONFIG_SHAPE);
}

function readonlyEvidence(admit) {
  if (typeof admit !== 'function') {
    return evidence('readonly', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.NO_EVIDENCE, null);
  }
  let admission;
  try {
    admission = admit({ action: 'change.read', target: 'dop:change.read' });
  } catch {
    return evidence('readonly', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.POLICY_UNAVAILABLE, null);
  }
  const status = isPlainObject(admission) ? admission.status : null;
  const code = isPlainObject(admission) ? admission.code : null;
  if (status === 'allowed') {
    return evidence('readonly', EVIDENCE_STATES.PASS, null, EVIDENCE_BASIS.POLICY_ADMISSION);
  }
  if (status === 'confirm') {
    return evidence('readonly', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.CONFIRMATION_REQUIRED, null);
  }
  if (code === 'POLICY_UNAVAILABLE') {
    return evidence('readonly', EVIDENCE_STATES.NOT_RUN, EVIDENCE_REASONS.POLICY_UNAVAILABLE, null);
  }
  return evidence('readonly', EVIDENCE_STATES.FAIL, EVIDENCE_REASONS.POLICY_DENIED, EVIDENCE_BASIS.POLICY_ADMISSION);
}

/** 结论只由证据算：任一 fail → fail；否则任一 not-run → incomplete；全 pass → pass。 */
export function verdictOf(items) {
  const list = Array.isArray(items) ? items : [];
  const failed = list.find((item) => item?.state === EVIDENCE_STATES.FAIL);
  if (failed !== undefined) return Object.freeze({ verdict: 'fail', blockedBy: failed.id ?? null, reason: failed.reason ?? null });
  const pending = list.find((item) => item?.state !== EVIDENCE_STATES.PASS);
  if (pending !== undefined) {
    return Object.freeze({ verdict: 'incomplete', blockedBy: pending.id ?? null, reason: pending.reason ?? null });
  }
  return Object.freeze({ verdict: 'pass', blockedBy: null, reason: null });
}

/**
 * 生成一份就绪视图（`ReadinessView`，§5.1）。
 *
 * @param {object} input
 * @param {object|null} [input.snapshot] `cli-access` 快照（取 revision / entries / host）
 * @param {{inherited?:object,override?:object}|null} [input.row] 两层原始行（只投影键名）
 * @param {string} [input.sourceType] `deriveSourceType()` 的结果（`mock`/`enterprise` 经 `normalizeSourceType()` 翻译，越界记 unknown）
 * @param {{name?:string,version?:string}} [input.plugin] 本包版本投影
 * @param {string} [input.platform] 目标平台（注入以便用例覆盖 Windows）
 * @param {Function|null} [input.statSync] 同步 stat（只读、只判形态）
 * @param {Function|null} [input.admit] 策略准入（`policy-guard.admit`；不发起下游调用）
 * @param {() => Date} [input.now] 时钟（`at` 只取一次）
 * @returns {object} 冻结的 ReadinessView
 */
export function buildReadiness(input = {}) {
  const {
    snapshot = null,
    row = null,
    sourceType = 'unknown',
    plugin = null,
    platform = process.platform,
    statSync = null,
    admit = null,
    now = () => new Date(),
  } = input ?? {};

  const safeSnapshot = isPlainObject(snapshot) ? snapshot : {};
  const entries = isPlainObject(safeSnapshot.entries) ? safeSnapshot.entries : {};
  const binPath = binPathOf(entries);
  const endpointValue = endpointValueOf(entries);
  const resolvedSourceType = normalizeSourceType(sourceType);

  const file = fileEvidence(binPath, statSync);
  const stat = file.state === EVIDENCE_STATES.PASS ? statOnce(statSync, binPath) : null;
  const executable = executableEvidence(file, binPath, stat, platform);
  const target = targetEvidence(binPath, endpointValue, resolvedSourceType);
  const readonly = readonlyEvidence(admit);
  const items = Object.freeze([file, executable, target, readonly]);
  const conclusion = verdictOf(items);

  const pluginInfo = isPlainObject(plugin)
    ? Object.freeze({
        name: typeof plugin.name === 'string' && plugin.name !== '' ? plugin.name : null,
        version: typeof plugin.version === 'string' && plugin.version !== '' ? plugin.version : null,
      })
    : Object.freeze({ name: null, version: null });

  let at;
  try {
    at = new Date(now()).toISOString();
  } catch {
    at = new Date(0).toISOString();
  }

  return Object.freeze({
    contract: READINESS_CONTRACT,
    at,
    object: READINESS_OBJECT,
    revision: typeof safeSnapshot.revision === 'string' ? safeSnapshot.revision : null,
    sourceType: resolvedSourceType,
    plugin: pluginInfo,
    layers: projectLayers(row),
    evidence: items,
    verdict: conclusion.verdict,
    blockedBy: conclusion.blockedBy,
    reason: conclusion.reason,
  });
}
