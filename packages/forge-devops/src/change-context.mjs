/**
 * `@heluo/forge-devops` 的上下文卡（AC-11 业务侧 + AC-12 承建判定的展示面）。
 *
 * 只在这里做的三件事：
 * 1. **映射**：dop `change view --json` 的 2026-07-06 字段契约 → 内部 `Change`。snake_case 只在 `normalizeChangeRecord`
 *    里出现一次；契约外字段只留在 `raw` 供调试，进卡片前剥掉（卡会落盘成产物，不把企业侧多余字段带出去）。
 * 2. **规则**：`release_info` 取首个非空。`firstReleaseInfo` 是唯一实现，卡与报告都调它——两处各写一遍必然漂移。
 * 3. **构建与渲染**：事实 + 来源（版本/时间戳）+ 未知项 + 承建判定 + 已记录假设 + 下一步，固定结构的 Markdown。
 *
 * 纯函数：不读时钟、不读文件、不调平台；时间与来源版本由调用方传入，拿不到就写 `null` 并列进未知项。
 * 同输入必然同输出——上下文卡才能当产物落盘并逐字复核。
 *
 * 三条容易被顺手破坏的纪律：
 * - 取不到的事实**不静默省略**：要么进 `unknowns`（带 field/reason/command），要么构建时直接报错；
 * - 卡片 `blocked` **只阻断写动作**，读取与信息展示照常（AC-11"仓库侧取不到不阻塞业务侧"）；
 * - 渲染要**脱敏**：endpoint 与绝对路径不落文档（AC-22），命令只保留可核对的部分。
 */

import { createHash } from 'node:crypto';
import { normalizeReadError } from './read.mjs';
import { EVIDENCE_KINDS, RESOLVE_STATUSES, EVIDENCE_SOURCES } from './repository-resolver.mjs';

/** 事实来源只有两族：平台业务事实（dop）与仓库侧事实（gh）。 */
export const SOURCE_KINDS = Object.freeze(['dop', 'gh']);

/** 证据类型与 AC-23 一致：mock 实测与真实远端/企业实测分开记，不许合并成一个"已实测"。 */
export const CHANGE_SOURCE_TYPES = Object.freeze(['mock', 'enterprise']);

/** 卡片状态是流程态（与平台动作的 done/failed/denied/unknown 不是一套词，渲染时不得混用）。 */
export const CONTEXT_STATUSES = Object.freeze(['ready', 'blocked']);

/** `release_info` 的取值规则；写进卡片与报告，让人知道排期是怎么挑出来的。 */
export const RELEASE_RULE = 'first-non-empty';

/**
 * 平台方言的**唯一**别名表：dop 原生字段名 → 契约键（只收录 UAT 点名的四个键，不猜名字）。
 * 原生命名只在本模块入口出现一次；下游（flow / 渲染 / 报告）只该看到契约 snake_case 形状。
 * `summary` 是一对多：既兜 `description`，也在没有 `title` 时兜 `title`（UAT 报告未给标题字段；
 * 同一串喂两处不影响幂等键——键用的是调用方显式 title）。
 */
export const NATIVE_ALIASES = Object.freeze({
  code: 'id',
  state: 'status',
  summary: 'description',
  userStory: 'user_stories',
});

/** `summary` 的第二落点（见 `NATIVE_ALIASES` 注释）：单列出来，免得被当成笔误删掉。 */
const SUMMARY_TITLE_ALIAS = Object.freeze({ summary: 'title' });

/** 构建卡片时的拒绝原因（不是展示给用户的流程结论，是本模块的入参契约）。 */
export const CONTEXT_REASONS = Object.freeze({
  RECORD_INVALID: 'CONTEXT_RECORD_INVALID',
  ID_MISMATCH: 'CONTEXT_ID_MISMATCH',
  UNKNOWN_INVALID: 'CONTEXT_UNKNOWN_INVALID',
  SOURCE_INVALID: 'CONTEXT_SOURCE_INVALID',
  RELATED_INVALID: 'CONTEXT_RELATED_INVALID',
  ASSUMPTION_INVALID: 'CONTEXT_ASSUMPTION_INVALID',
  BUILDING_INVALID: 'CONTEXT_BUILDING_INVALID',
});

export class ContextError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'ContextError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 契约必填收敛为三项：没有它们无法判定"读到的是哪条变更"（缺失或类型错即拒绝，不用自由文本兜底）。
 * `description` / `acceptance_criteria` 缺失不是"记录坏了"而是"平台没给"——进 `missingFields`，
 * 卡片走既有「平台未提供 `acceptance_criteria`」分支（降级有现成渲染，不新增机制、不伪造字段）。
 */
const REQUIRED_FIELDS = Object.freeze(['id', 'title', 'status']);
/** 契约可选（可缺失，但要进 `missingFields`，让"平台没给"和"我们没读"分得开）。 */
const OPTIONAL_FIELDS = Object.freeze(['type', 'owner', 'created_at', 'sub_systems', 'user_stories']);
const ENDPOINT_PLACEHOLDER = '<env:FORGE_DEVOPS_DOP_ENDPOINT>';

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 关联人字段可能是字符串，也可能是 `{name, code}`，两种都读成一行文字。 */
const who = (value) => text(value) || text(asObject(value).name) || text(asObject(value).code);

const sha12 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** 内容指纹要稳定：键序不同但内容相同必须给出同一串，否则每次读都像"新版本"。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * `release_info` 归一：只认字段契约里的名字（snake_case 与已归一化的 camelCase 两种读法）。
 * 不吸收 wrapper 的改名（`number`/`name` 之类）——那会把契约漂移掩盖成"读到排期了"。
 */
function releaseInfoOf(story) {
  const item = asObject(story);
  const source = asObject(item.release_info ?? item.releaseInfo);
  const value = {
    releaseNum: text(source.release_num) || text(source.releaseNum),
    releaseName: text(source.release_name) || text(source.releaseName),
    releaseDate: text(source.release_date) || text(source.releaseDate),
    releaseStage: text(source.release_stage) || text(source.releaseStage),
  };
  return Object.values(value).some((entry) => entry !== '') ? value : null;
}

/**
 * `release_info` 取首个非空故事（ARD222222 首故事为空 → 取第二条；ARD123456 单故事全非空 → 取它）。
 * `value` 与 `releaseInfo` 指向同一对象：`Change.releaseInfo.value` 与 `firstReleaseInfo().releaseInfo`
 * 是设计里出现的两种读法，用别名而不是两份数据，避免漂移。
 */
export function firstReleaseInfo(stories) {
  const list = asArray(stories);
  for (let index = 0; index < list.length; index += 1) {
    const story = asObject(list[index]);
    const info = releaseInfoOf(story);
    if (info === null) continue;
    // 卡片上"来自故事 X"的 X 与用户故事表的"故事"列必须是同一个串：优先业务编号 code（平台可查），id 兜底。
    const storyId = text(story.code) || text(story.id) || `#${index + 1}`;
    return { storyId, releaseInfo: info, value: info, rule: RELEASE_RULE };
  }
  return null;
}

/** "平台没给"的判定：未给 / 空白串 / 空数组；对象与数字等"给了值"一律不算空。 */
const isBlankField = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

/** 原生命名取值：空白按"没给"处理；`userStory` 允许单对象，按单元素数组（否则 `asArray` 会把它读成空）。 */
function nativeValue(record, nativeKey) {
  const value = record[nativeKey];
  if (isBlankField(value)) return null;
  if (nativeKey === 'userStory') {
    if (Array.isArray(value)) return value;
    return isPlainObject(value) ? [value] : null;
  }
  return value;
}

/**
 * 契约键优先的补别名：只有契约键为空（未给 / 空串 / 空数组）时才落别名，返回新对象、不改入参。
 * 故事项也过这张表（同一别名、同一优先级），见 `normalizeChangeRecord` 里的 `userStories`。
 */
function fillAliases(record) {
  const filled = { ...record };
  for (const [nativeKey, contractKey] of [...Object.entries(NATIVE_ALIASES), ...Object.entries(SUMMARY_TITLE_ALIAS)]) {
    if (!isBlankField(filled[contractKey])) continue;
    const value = nativeValue(record, nativeKey);
    if (value !== null) filled[contractKey] = value;
  }
  return filled;
}

/**
 * 入口别名层：把 dop 原生命名吸收成契约键（映射后仍是 AC-11 的 snake_case 契约，`Change` 形状不变）。
 * `id` 与 `code` 同时存在且不同：按契约键 `id` 取值并**显式**抛 `ID_MISMATCH`——不静默择一
 * （择一意味着可能读到另一条变更，这比报错糟得多）。故事项不做这条判定：故事的业务编号与内部 id 天然不同。
 */
export function aliasChangeRecord(raw) {
  if (!isPlainObject(raw)) return raw;
  const contractId = text(raw.id);
  const nativeCode = nativeValue(raw, 'code');
  if (contractId !== '' && typeof nativeCode === 'string' && text(nativeCode) !== contractId) {
    throw new ContextError(
      CONTEXT_REASONS.ID_MISMATCH,
      `id 与 code 不一致（id=${contractId}，code=${text(nativeCode)}）：按契约键 id 取值，不静默择一`,
      { field: 'code', expectedId: contractId, actualId: text(nativeCode) },
    );
  }
  return fillAliases(raw);
}

/**
 * dop 记录 → `Change`（2026-07-06 契约的唯一映射点）。
 * `expectedId` 用来核对"读到的就是请求的那条"：`id` 不等即拒绝，不静默改读别的变更。
 * `sourceRevision` 缺省时用记录内容派生 `dop:<sha12>`——dop 不返回版本号，但"事实冻结在哪一版"必须有串可引用。
 */
export function normalizeChangeRecord(raw, { at = null, sourceRevision = null, sourceType = 'mock', expectedId = null } = {}) {
  if (!isPlainObject(raw)) {
    throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, 'dop 记录必须是 JSON 对象', { expectedId });
  }
  // 原生命名只在这一步入契约；之后一律读 `record`，别名不往下游漏。
  const record = aliasChangeRecord(raw);
  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, `缺少契约必填字段 ${field}`, { field, expectedId });
    }
  }
  // 必填 = 存在 + 是非空字符串：`''`（以及纯空白，按 `text()` 的 trim 约定）等于"这条记录看不出是哪条"，
  // 不能让它带着空标题/空状态流到卡片上被当成 `ready`（空串进去只会留在 missingFields 里被静默放行）。
  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== 'string' || text(record[field]) === '') {
      throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, `必填字段 ${field} 必须是非空字符串`, { field });
    }
  }
  // 降级字段：未给 / null 视为"平台没给"（进 missingFields）；给了就必须是对的类型，非字符串照旧拒绝。
  if (record.description !== undefined && record.description !== null && typeof record.description !== 'string') {
    throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, '字段 description 必须是字符串', { field: 'description' });
  }
  if (record.acceptance_criteria !== undefined && record.acceptance_criteria !== null) {
    const criteria = record.acceptance_criteria;
    if (!Array.isArray(criteria) || criteria.some((entry) => typeof entry !== 'string')) {
      throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, '字段 acceptance_criteria 必须是字符串数组', {
        field: 'acceptance_criteria',
      });
    }
  }
  const wantedId = text(expectedId);
  if (wantedId !== '' && record.id !== wantedId) {
    throw new ContextError(CONTEXT_REASONS.ID_MISMATCH, `读到的记录是 ${record.id}，不是请求的 ${wantedId}`, {
      expectedId: wantedId,
      actualId: record.id,
    });
  }
  const kind = text(sourceType);
  if (!CHANGE_SOURCE_TYPES.includes(kind)) {
    throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, `sourceType 必须是 ${CHANGE_SOURCE_TYPES.join('/')}`, { sourceType });
  }

  const acceptanceCriteria = asArray(record.acceptance_criteria)
    .map((entry) => text(entry))
    .filter((entry) => entry !== '')
    .map((entry, index) => ({ index: index + 1, text: entry }));

  const subSystems = asArray(record.sub_systems)
    .map((entry) => (typeof entry === 'string' ? { code: text(entry), name: '' } : { code: text(asObject(entry).code), name: text(asObject(entry).name) }))
    .filter((entry) => entry.code !== '' || entry.name !== '');

  const userStories = asArray(record.user_stories).map((entry, index) => {
    // 故事项过同一张别名表（`summary` → `title` 在原生故事里同样成立），契约键优先。
    const story = fillAliases(asObject(entry));
    const code = text(story.code);
    return {
      id: text(story.id) || code || `#${index + 1}`,
      code,
      title: text(story.title),
      type: text(story.type),
      state: text(story.state),
      stage: text(story.stage),
      team: who(story.team),
      assignee: who(story.assignee),
      businessOwner: who(story.business_owner ?? story.businessOwner),
      releaseInfo: releaseInfoOf(story),
    };
  });

  const missingFields = [];
  // 只列"平台没给"的可选字段：`title`/`status` 上面已判为非空，永远不会出现在这里。
  for (const field of ['description', ...OPTIONAL_FIELDS]) {
    if (field === 'sub_systems' || field === 'user_stories') continue;
    if (text(record[field]) === '') missingFields.push(field);
  }
  if (acceptanceCriteria.length === 0) missingFields.push('acceptance_criteria');
  if (subSystems.length === 0) missingFields.push('sub_systems');
  if (userStories.length === 0) missingFields.push('user_stories');

  const revision = text(sourceRevision);
  const change = {
    changeId: text(record.id),
    title: text(record.title),
    status: text(record.status),
    type: text(record.type),
    owner: text(record.owner),
    description: text(record.description),
    createdAt: text(record.created_at),
    acceptanceCriteria,
    subSystems,
    userStories,
    releaseInfo: firstReleaseInfo(userStories),
    missingFields,
    // 指纹取**收到的原样**（`raw`）：契约键记录与旧行为逐字节一致，别名是我们对平台的解读，不是平台事实。
    sourceRevision: revision !== '' ? revision : `dop:${sha12(stableStringify(raw))}`,
    observedAt: text(at) || null,
    sourceType: kind,
    raw,
  };
  return change;
}

/** 卡片里只保留契约内字段：`raw` 可能含企业侧额外字段，落盘产物不展示（AC-22/23）。 */
function displayableChange(change) {
  const item = asObject(change);
  if (!isPlainObject(change)) {
    throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, 'change 必须是 normalizeChangeRecord 的产物', {});
  }
  const releaseInfo = asObject(item.releaseInfo);
  return {
    changeId: text(item.changeId),
    title: text(item.title),
    status: text(item.status),
    type: text(item.type),
    owner: text(item.owner),
    description: text(item.description),
    createdAt: text(item.createdAt),
    acceptanceCriteria: asArray(item.acceptanceCriteria).map((entry) => ({ index: Number(asObject(entry).index) || 0, text: text(asObject(entry).text) })),
    subSystems: asArray(item.subSystems).map((entry) => ({ code: text(asObject(entry).code), name: text(asObject(entry).name) })),
    userStories: asArray(item.userStories).map((entry) => {
      const story = asObject(entry);
      return {
        id: text(story.id),
        code: text(story.code),
        title: text(story.title),
        type: text(story.type),
        state: text(story.state),
        stage: text(story.stage),
        team: text(story.team),
        assignee: text(story.assignee),
        businessOwner: text(story.businessOwner),
        releaseInfo: releaseInfoOf(story),
      };
    }),
    releaseInfo:
      text(releaseInfo.storyId) === ''
        ? null
        : { storyId: text(releaseInfo.storyId), value: releaseInfoOf({ releaseInfo: releaseInfo.value }), rule: text(releaseInfo.rule) || RELEASE_RULE },
    missingFields: asArray(item.missingFields).map((entry) => text(entry)).filter((entry) => entry !== ''),
    sourceRevision: text(item.sourceRevision) || null,
    observedAt: text(item.observedAt) || null,
    sourceType: text(item.sourceType) || null,
  };
}

/** 未知项三种入参：Error（适配器抛错）、读信封（service.read 的 unknown）、{field,reason,command}。 */
function toUnknown(entry, index) {
  const fail = (message) => new ContextError(CONTEXT_REASONS.UNKNOWN_INVALID, message, { index });
  if (entry instanceof Error) {
    const detail = asObject(entry.detail);
    const envelope = normalizeReadError({ action: entry.action ?? null, target: entry.target ?? null, error: entry });
    const field = text(detail.field) || who(entry.action) || who(entry.target);
    if (field === '') throw fail(`unknowns[${index}] 是错误对象但没有 field/action，无法指明哪项事实缺失`);
    return { field, reason: envelope.error_code, command: text(detail.command) || null };
  }
  if (!isPlainObject(entry)) throw fail(`unknowns[${index}] 必须是 Error、读信封或 {field,reason,command}`);
  const detail = asObject(entry.detail);
  const field = text(entry.field) || text(detail.field) || text(entry.action) || text(entry.target_ref);
  const reason = text(entry.reason) || text(entry.error_code);
  if (field === '' || reason === '') throw fail(`unknowns[${index}] 必须带 field 与 reason（取不到事实不得静默省略）`);
  return { field, reason, command: text(entry.command) || text(detail.command) || null };
}

function normalizeUnknowns(unknowns) {
  return asArray(unknowns).map((entry, index) => toUnknown(entry, index));
}

/** 承建判定必须是 `resolveBuildingRepository` 的产物：状态、候选、证据三样都要对得上。 */
function normalizeBuilding(building) {
  if (!isPlainObject(building)) {
    throw new ContextError(CONTEXT_REASONS.BUILDING_INVALID, '上下文卡必须带承建判定（先调 resolveBuildingRepository）', {});
  }
  const status = text(building.status);
  if (!RESOLVE_STATUSES.includes(status)) {
    throw new ContextError(CONTEXT_REASONS.BUILDING_INVALID, `building.status 必须是 ${RESOLVE_STATUSES.join('/')}`, { status });
  }
  const selected = text(building.selected) || null;
  const candidates = asArray(building.candidates).map((entry, index) => {
    const candidate = asObject(entry);
    const repo = text(candidate.repo);
    if (repo === '') throw new ContextError(CONTEXT_REASONS.BUILDING_INVALID, `candidates[${index}] 缺少仓库标识`, { index });
    const evidence = asArray(candidate.evidence).map((item) => {
      const evidenceItem = asObject(item);
      const kind = text(evidenceItem.kind);
      if (!EVIDENCE_KINDS.includes(kind)) {
        throw new ContextError(CONTEXT_REASONS.BUILDING_INVALID, `证据种类 ${kind || '（空）'} 未登记`, { kind });
      }
      return { kind, value: text(evidenceItem.value), source: text(evidenceItem.source) };
    });
    return { repo, evidence };
  });
  const reasons = asArray(building.reasons).map((entry) => text(entry)).filter((entry) => entry !== '');
  if (status === 'resolved' && selected === null) {
    throw new ContextError(CONTEXT_REASONS.BUILDING_INVALID, 'resolved 必须给出 selected', {});
  }
  if (status === 'blocked' && reasons.length === 0) {
    throw new ContextError(CONTEXT_REASONS.BUILDING_INVALID, 'blocked 必须给出至少一条原因', {});
  }
  if (selected !== null && candidates.length > 0) {
    const wanted = selected.toLowerCase();
    if (!candidates.some((candidate) => candidate.repo.toLowerCase() === wanted)) {
      throw new ContextError(CONTEXT_REASONS.BUILDING_INVALID, `selected ${selected} 不在候选里（不得引入候选之外的仓库）`, { selected });
    }
  }
  return { status, selected, candidates, reasons };
}

const RELATED_KINDS = Object.freeze(['issues', 'prs']);

function normalizeRelated(related) {
  const item = asObject(related);
  const result = {};
  for (const kind of RELATED_KINDS) {
    result[kind] = asArray(item[kind])
      .map((entry, index) => {
        const object = asObject(entry);
        const number = Number.isInteger(object.number) ? object.number : Number.parseInt(text(object.number), 10);
        if (!Number.isInteger(number) || number <= 0) {
          throw new ContextError(CONTEXT_REASONS.RELATED_INVALID, `related.${kind}[${index}] 缺少正整数 number`, { kind, index });
        }
        return {
          number,
          title: text(object.title),
          state: text(object.state),
          url: text(object.url),
          matchedBy: text(object.matchedBy) || null,
        };
      })
      .sort((left, right) => left.number - right.number);
  }
  return result;
}

/** 来源必须能核对：种类、命令、时间或版本、证据类型，缺一不进卡片。 */
function normalizeSources(sources) {
  return asArray(sources).map((entry, index) => {
    const item = asObject(entry);
    const kind = text(item.kind);
    if (!SOURCE_KINDS.includes(kind)) {
      throw new ContextError(CONTEXT_REASONS.SOURCE_INVALID, `sources[${index}].kind 必须是 ${SOURCE_KINDS.join('/')}`, { index });
    }
    const command = text(item.command);
    if (command === '') throw new ContextError(CONTEXT_REASONS.SOURCE_INVALID, `sources[${index}] 必须带 command，否则无法复核`, { index });
    const at = text(item.at) || null;
    const sourceRevision = text(item.sourceRevision) || null;
    if (at === null && sourceRevision === null) {
      throw new ContextError(CONTEXT_REASONS.SOURCE_INVALID, `sources[${index}] 必须带 at 或 sourceRevision`, { index });
    }
    const sourceType = text(item.sourceType);
    if (!CHANGE_SOURCE_TYPES.includes(sourceType)) {
      throw new ContextError(CONTEXT_REASONS.SOURCE_INVALID, `sources[${index}].sourceType 必须是 ${CHANGE_SOURCE_TYPES.join('/')}`, { index });
    }
    return { kind, command, at, sourceRevision, sourceType };
  });
}

/** 假设来自澄清单（或调用方直接传入）：`H-n` 是唯一编号真源，文本/依据/影响缺一即不合格。 */
function normalizeAssumptions(assumptions, clarify) {
  // 调用方没给（或给了空表）时以澄清单为准：卡片上不能少掉清单里已记录的假设。
  const source = asArray(assumptions).length > 0 ? assumptions : asObject(clarify).assumptions;
  return asArray(source).map((entry, index) => {
    if (typeof entry === 'string') {
      if (text(entry) === '') throw new ContextError(CONTEXT_REASONS.ASSUMPTION_INVALID, `assumptions[${index}] 是空文本`, { index });
      return { id: `H-${index + 1}`, text: text(entry), basis: '', impactIfWrong: '' };
    }
    const item = asObject(entry);
    const value = text(item.text) || text(item.statement) || text(item.assumption);
    if (value === '') throw new ContextError(CONTEXT_REASONS.ASSUMPTION_INVALID, `assumptions[${index}] 缺少假设文本`, { index });
    return {
      id: text(item.id) || `H-${index + 1}`,
      text: value,
      basis: text(item.basis),
      impactIfWrong: text(item.impactIfWrong) || text(item.impact),
    };
  });
}

/** 澄清单进度进卡片是为了"别把未确认的歧义当已定"，不复制清单内容本身。 */
function normalizeClarify(clarify, assumptionCount) {
  const item = asObject(clarify);
  const gates = asArray(item.gate).length;
  const assumptions = asArray(item.assumptions).length;
  const version = Number.isInteger(item.version) ? item.version : null;
  const status = text(item.status);
  return {
    version,
    status: status === 'ready' || status === 'pending' ? status : 'pending',
    gateCount: gates,
    assumptionCount: item.assumptions === undefined ? assumptionCount : assumptions,
    revisionId: text(item.revisionId) || null,
  };
}

/**
 * 组装上下文卡。
 *
 * `changeId` 与 `change` 至少给一个：dop 读失败时卡片仍要能显示"你刚才问的是哪条变更"，
 * 此时 `change` 为 `null`，且必须至少带一条未知项（取不到事实却不写未知项 = 静默省略）。
 * `building` 必填（先跑 `resolveBuildingRepository`），状态 `blocked` 会把卡片标成 `blocked`。
 */
export function buildContextCard({
  changeId = null,
  change = null,
  building = null,
  related = {},
  sources = [],
  unknowns = [],
  assumptions = [],
  clarify = null,
} = {}) {
  const displayable = change === null || change === undefined ? null : displayableChange(change);
  const requested = text(changeId) || (displayable === null ? '' : text(displayable.changeId));
  if (requested === '') {
    throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, '上下文卡至少要给出请求的变更号', {});
  }
  const normalizedUnknowns = normalizeUnknowns(unknowns);
  if (displayable === null && normalizedUnknowns.length === 0) {
    throw new ContextError(CONTEXT_REASONS.UNKNOWN_INVALID, '取不到变更记录时必须给出可见未知项（field/reason/command）', { changeId: requested });
  }
  const normalizedBuilding = normalizeBuilding(building);
  const normalizedAssumptions = normalizeAssumptions(assumptions, clarify);
  const status = displayable === null || normalizedBuilding.status === 'blocked' ? 'blocked' : 'ready';
  if (!CONTEXT_STATUSES.includes(status)) {
    throw new ContextError(CONTEXT_REASONS.RECORD_INVALID, `卡片状态必须是 ${CONTEXT_STATUSES.join('/')}`, { status });
  }
  return {
    changeId: requested,
    change: displayable,
    building: normalizedBuilding,
    related: normalizeRelated(related),
    sources: normalizeSources(sources),
    unknowns: normalizedUnknowns,
    assumptions: normalizedAssumptions,
    clarify: normalizeClarify(clarify, normalizedAssumptions.length),
    status,
  };
}

const inline = (value) => text(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ') || '（缺失）';
const cell = (value) => text(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ') || '—';

/** 行内代码：值里带反引号时改用双反引号围栏，避免把 Markdown 结构顶坏。 */
function code(value, fallback = '（缺失）') {
  const raw = text(value).replace(/\s*\n\s*/g, ' ');
  if (raw === '') return fallback;
  return raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``;
}

/**
 * 命令脱敏：endpoint 值、URL、绝对路径一律不进卡片（AC-22"路径与 endpoint 不落文档"）。
 * 只保留命令动作本身，人仍能照着复核；具体取值由环境注入，不在产物里留痕。
 */
function redactCommand(value) {
  const command = text(value);
  if (command === '') return '';
  return command
    .replace(/--endpoint(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g, `--endpoint ${ENDPOINT_PLACEHOLDER}`)
    .replace(/https?:\/\/\S+/g, ENDPOINT_PLACEHOLDER)
    .replace(/(^|\s)((?:~\/|\/|[A-Za-z]:[\\/])[^\s"'`]+)/g, (match, prefix, path) => {
      const parts = path.split(/[\\/]/).filter((part) => part !== '');
      return `${prefix}${parts.length > 0 ? parts[parts.length - 1] : path}`;
    });
}

/** 一条证据的读法：`kind` = `value`（来源）。照着就能回平台查。 */
const evidenceLine = (item) => `${code(item.kind)} = ${code(item.value)}（来源 ${code(item.source, '（未标注）')}）`;

function releaseText(release) {
  const value = asObject(release);
  const parts = [code(value.releaseNum), inline(value.releaseName)];
  if (text(value.releaseDate) !== '') parts.push(`日期 ${inline(value.releaseDate)}`);
  if (text(value.releaseStage) !== '') parts.push(`阶段 ${inline(value.releaseStage)}`);
  return parts.join(' · ');
}

/**
 * 渲染成 Markdown（`context.md` 正文）。结构固定：卡 → 验收条件 → 用户故事 → 承建判定 →
 * 关联 Issue/PR → 已记录假设 → 未知项 → 来源 → 下一步，空段显式写"无"而不留白。
 */
export function renderContextCard(card) {
  const source = asObject(card);
  const change = isPlainObject(source.change) ? source.change : null;
  const building = asObject(source.building);
  const related = asObject(source.related);
  const unknowns = asArray(source.unknowns).map(asObject);
  const sources = asArray(source.sources).map(asObject);
  const assumptions = asArray(source.assumptions).map(asObject);
  const clarify = asObject(source.clarify);
  const status = text(source.status) || 'blocked';
  const changeId = text(source.changeId) || text(change?.changeId) || '（缺变更号）';
  const lines = [];

  lines.push(`# 上下文卡 — ${changeId}`, '');
  if (status === 'ready') {
    lines.push('- 状态：`ready`（可推进）');
  } else {
    lines.push('- 状态：`blocked`（**只阻断写动作**，读取与信息展示照常）');
  }
  if (change === null) {
    lines.push('- 变更：（读取失败，见"未知项"）');
  } else {
    lines.push(`- 变更：${inline(change.title)}`);
    const platform = [`状态 ${code(change.status)}`];
    if (text(change.type) !== '') platform.push(`类型 ${code(change.type)}`);
    if (text(change.owner) !== '') platform.push(`负责人 ${inline(change.owner)}`);
    if (text(change.createdAt) !== '') platform.push(`创建 ${inline(change.createdAt)}`);
    lines.push(`- 平台字段：${platform.join('；')}`);
    if (text(change.description) !== '') lines.push(`- 描述：${inline(change.description)}`);
    if (asArray(change.missingFields).length > 0) {
      lines.push(`- 缺失字段：${asArray(change.missingFields).map((field) => code(field)).join('、')}`);
    }
    const release = change.releaseInfo === null || change.releaseInfo === undefined ? null : asObject(change.releaseInfo);
    if (release === null) {
      lines.push(`- 排期：（所有故事的 \`release_info\` 均为空；规则 \`${RELEASE_RULE}\`）`);
    } else {
      lines.push(`- 排期：${releaseText(release.value)}（来自故事 ${code(release.storyId)}；规则 \`${RELEASE_RULE}\`）`);
    }
    const subSystems = asArray(change.subSystems).map(asObject);
    lines.push(
      `- 承建系统：${subSystems.length === 0 ? '（平台未给 `sub_systems`，承建判定只能 blocked）' : subSystems.map((item) => [code(item.code, ''), inline(item.name)].filter((part) => part !== '').join(' · ')).join('；')}`,
    );
  }
  if (text(building.status) === 'resolved') {
    lines.push(`- 承建仓库：${code(building.selected)}（候选 ${asArray(building.candidates).length} 个，依据见"承建判定"）`);
  } else {
    lines.push(`- 承建仓库：（未确定：${asArray(building.reasons).map((reason) => code(reason)).join('、') || '（缺原因）'}）`);
  }
  if (clarify.version === null || clarify.version === undefined) {
    lines.push('- 澄清单：尚未生成（硬门禁项与已记录假设以本卡的"已记录假设"为准）');
  } else {
    const revision = text(clarify.revisionId) === '' ? '' : ` · 修订标识 ${code(clarify.revisionId)}`;
    lines.push(`- 澄清单：v${clarify.version} · ${code(clarify.status)} · 硬门禁 ${clarify.gateCount} 项 · 已记录假设 ${clarify.assumptionCount} 条${revision}`);
  }
  lines.push('');

  lines.push('## 验收条件（逐条编号；交付计划必须逐条绑定）', '');
  const criteria = change === null ? [] : asArray(change.acceptanceCriteria).map(asObject);
  if (criteria.length === 0) {
    lines.push('（平台未提供 `acceptance_criteria`：不能据此制定交付计划，见"未知项"。）', '');
  } else {
    criteria.forEach((item) => lines.push(`${Number(item.index) || 0}. ${inline(item.text)}`));
    lines.push('');
  }

  lines.push(`## 用户故事（排期取自 \`release_info\` 首个非空：\`${RELEASE_RULE}\`）`, '');
  const stories = change === null ? [] : asArray(change.userStories).map(asObject);
  if (stories.length === 0) {
    lines.push('无：平台未返回 `user_stories`（排期因此不可得）。', '');
  } else {
    const releaseAnchor = change === null ? '' : text(asObject(change.releaseInfo).storyId);
    lines.push('| # | 故事 | 标题 | 状态 | 阶段 | 排期 |', '|---|---|---|---|---|---|');
    stories.forEach((story, index) => {
      const info = asObject(story.releaseInfo);
      const release = Object.keys(info).length === 0 ? '—' : releaseText(info);
      const anchor = releaseAnchor !== '' && (text(story.id) === releaseAnchor || text(story.code) === releaseAnchor) ? '（首个非空）' : '';
      const title = text(story.title) === '' ? '—' : `${cell(story.title)}${anchor}`;
      lines.push(`| ${index + 1} | ${code(story.code || story.id, '—')} | ${title} | ${cell(story.state)} | ${cell(story.stage)} | ${release} |`);
    });
    lines.push('');
  }

  lines.push('## 承建判定（候选只来自 `dop.sub_systems` × `gh` 可见仓库）', '');
  if (text(building.status) === 'resolved') {
    lines.push(`- 结果：\`resolved\` → ${code(building.selected)}`);
  } else {
    lines.push(`- 结果：\`blocked\`（写动作全部阻断，不猜仓库）`);
    lines.push(`- 原因：${asArray(building.reasons).map((reason) => code(reason)).join('、') || '（缺原因）'}`);
  }
  const candidates = asArray(building.candidates).map(asObject);
  if (candidates.length === 0) {
    lines.push('- 候选：无（承建系统未声明，或可见仓库清单为空/不可得）');
  } else {
    if (candidates.length > 1) lines.push('- 候选（按仓库名排序；由人在候选中选定后重跑）：');
    else lines.push('- 候选与依据：');
    candidates.forEach((candidate, index) => {
      const evidence = asArray(candidate.evidence).map(asObject);
      const prefix = candidates.length > 1 ? `  ${index + 1}. ${code(candidate.repo)}` : `  - ${code(candidate.repo)}`;
      lines.push(prefix);
      if (evidence.length === 0) {
        lines.push('    - 依据：（缺失：没有命中证据的候选不可当作已确定）');
      } else {
        evidence.forEach((item) => lines.push(`    - ${evidenceLine(item)}`));
      }
    });
  }
  lines.push(`- 证据来源：${code(EVIDENCE_SOURCES.SUB_SYSTEMS)} + ${code(EVIDENCE_SOURCES.REPOSITORIES)}；不按变更号文本推断仓库（AC-12）`);
  lines.push('');

  lines.push('## 关联 Issue / PR（`gh` 只读；只列能对应上本变更的对象）', '');
  const issues = asArray(related.issues).map(asObject);
  const prs = asArray(related.prs).map(asObject);
  const relatedLine = (label, list) => {
    if (list.length === 0) return `- ${label}：无`;
    return `- ${label}：${list
      .map((item) => `#${item.number}「${inline(item.title)}」（${cell(item.state)}${text(item.matchedBy) === '' ? '' : `；对应依据 ${code(item.matchedBy)}`}）`)
      .join('；')}`;
  };
  lines.push(relatedLine('Issue', issues), relatedLine('PR', prs), '');

  lines.push('## 已记录假设（H-n；不阻断推进，完成报告逐条复核）', '');
  if (assumptions.length === 0) {
    lines.push('无：当前没有需要记录为假设的取舍。', '');
  } else {
    assumptions.forEach((item, index) => {
      const extra = [];
      if (text(item.basis) !== '') extra.push(`依据：${inline(item.basis)}`);
      if (text(item.impactIfWrong) !== '') extra.push(`若不成立：${inline(item.impactIfWrong)}`);
      lines.push(`- ${code(item.id || `H-${index + 1}`)} ${inline(item.text)}${extra.length === 0 ? '' : `（${extra.join('；')}）`}`);
    });
    lines.push('');
  }

  lines.push('## 未知项（取不到的事实不省略）', '');
  if (unknowns.length === 0) {
    lines.push('无：本次读取没有失败项（事实仍以"来源"的时间戳与版本为准）。', '');
  } else {
    unknowns.forEach((item) => {
      const command = text(item.command) === '' ? '' : `（命令：${code(redactCommand(item.command))}）`;
      lines.push(`- ${code(item.field)}：${code(item.reason)}${command}`);
    });
    lines.push('');
  }

  lines.push('## 来源（可核对）', '');
  if (sources.length === 0) {
    lines.push('无：本卡没有任何带来源的事实，不得作为完成证据。', '');
  } else {
    sources.forEach((item) => {
      const parts = [code(item.kind), code(redactCommand(item.command))];
      if (text(item.at) !== '') parts.push(`at=${inline(item.at)}`);
      if (text(item.sourceRevision) !== '') parts.push(`rev=${code(item.sourceRevision)}`);
      parts.push(`类型 ${code(item.sourceType)}`);
      lines.push(`- ${parts.join(' · ')}`);
    });
    lines.push('');
  }

  lines.push('## 下一步（按顺序，不跳步）', '');
  if (change === null) {
    lines.push('1. 先恢复业务事实读取：确认 dop 已配置且可用（路径与 endpoint 由环境注入，不在本卡展示）；');
    lines.push(`2. 重跑 \`devops-change ${changeId}\` 重新聚合，不手工补写上下文卡；`);
    lines.push('3. 事实恢复前不创建 Issue/PR、不写澄清记录。');
  } else if (text(building.status) === 'blocked') {
    lines.push('1. 先解决"承建判定"的阻断原因：在候选里由人选定承建仓库，或补齐 `sub_systems`/仓库范围；');
    lines.push(`2. 重跑 \`devops-change ${changeId}\` 重新判定；`);
    lines.push('3. 阻断期间写动作全部拒绝（`BUILDING_NOT_RESOLVED`），不得手工开 Issue 绕过。');
  } else {
    lines.push('1. 生成澄清单：硬门禁项须人工确认，其余歧义记为 `H-n` 假设；');
    lines.push('2. 生成交付计划：逐条验收条件绑定实现项与验证方式；');
    lines.push(`3. 实现并提交：提交信息以 \`[${changeId}]\` 开头，不合规即拒绝；`);
    lines.push('4. 交叉审查：模型名与 commit 绑定，人工确认栏单独填写；');
    lines.push('5. 完成报告：逐条证据 + 假设复核，关闭就绪只判定不执行。');
  }
  return lines.join('\n');
}
