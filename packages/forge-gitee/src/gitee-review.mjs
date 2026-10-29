/**
 * `review.md` 产物模型（AC-19 / AC-20）。
 *
 * 三条纪律收在这里，而不是散到渲染与工具层：
 * 1. **AI 栏与人工栏各有一个入口**：`buildReviewRecord` 只产出 AI 栏（`aiColumn`），人工栏恒为空
 *    且只能由 `recordHumanConfirmation` 追加；后者要求显式 `origin` 属人工来源（`human` 等），
 *    声明 `model` / `ai` / `assistant` 一律拒绝，**不带 `origin` 同样拒绝**——"显式人工输入"是
 *    AC-20 的字面要求，默认值会让模型的自填与人的确认在代码里长得一样。
 * 2. **sha 变化即过期，`stale` 不落盘**：`reviewStaleness` 只比 commit，不猜；`current|stale` 是
 *    **派生状态**，写进 `review.md` 会让"确认后被改成通过"变成一个真实窗口。版本一致性
 *    （`current|stale`）与确认状态（`pending-human|confirmed|...`）是两个轴，合成一个字段会
 *    掩盖"确认过期但流程仍显示已确认"。
 * 3. **写盘前三道闸**：四段齐全（`REVIEW_INCOMPLETE`）、脱敏零命中（`REVIEW_REDACTION_BLOCKED`，
 *    阻断而不是替换——替换会把"泄漏过"变成"看起来干净"）、目标路径在仓库内且既有文件
 *    `provider` 为 `gitee`（`PROVIDER_CONFLICT`，跨 provider 不覆盖）。写入走"临时文件 + rename"
 *    并**读回同一份文件**算 sha256，证据来自磁盘而不是内存对象。
 *
 * 与 `@heluo/forge-devops` 的 `review.mjs` 是**受控重复**（PRD 非目标禁止改写 devops，D-3）：
 * 术语（四段、两栏、模型档位、`stale` 派生）对齐，实现各自一份；`test/review.test.mjs` 守住本
 * 文件的接口与不变量，跨包漂移由静态门禁而不是共享代码来兜。
 *
 * 除 `writeReviewFile` 外均为纯函数：不读时钟（时间由 `at` 注入）、不读文件。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** `review.md` 的四段（顺序即文档顺序，缺一即不合格）。 */
export const REVIEW_SECTIONS = Object.freeze(['问题', '风险', '意见', '结论']);

/** 两栏：AI 自述 / 人工确认。物理分节，不允许把人工结论混进 AI 栏。 */
export const REVIEW_COLUMNS = Object.freeze(['AI 意见', '人工确认']);

/** 人工确认结论（人工栏 `decision` 取值）。 */
export const REVIEW_DECISIONS = Object.freeze(['confirmed', 'changes-requested', 'rejected']);

/** 审查流程状态：`pending-human` 之外直接复用人工确认结论，避免再造一套映射。 */
export const REVIEW_STATUSES = Object.freeze(['pending-human', ...REVIEW_DECISIONS]);

/** 版本一致性两态：`stale` 只表示被审 sha 已不是当前 sha，不等于动作失败或无人确认。 */
export const REVIEW_STALENESS = Object.freeze(['current', 'stale']);

/** 可被认定为人触发的来源标签（`recordHumanConfirmation.origin` 白名单）。 */
export const HUMAN_ORIGINS = Object.freeze(['human', 'operator', 'reviewer', 'cli-human']);

/** 模型/自动化的来源标签：出现即拒绝（AC-20「模型自填路径必须拒绝」）。 */
export const MODEL_ORIGINS = Object.freeze(['model', 'ai', 'assistant', 'agent', 'bot', 'llm', 'auto', 'automatic']);

/** `buildReviewRecord` 入参里**不得出现**的人工栏字段：模型没有"给自己写已确认"的通道。 */
export const FORBIDDEN_HUMAN_KEYS = Object.freeze([
  'human',
  'humanColumn',
  'humanConfirmation',
  'humanConfirmations',
  'confirmedBy',
  'confirmations',
]);

/** 更强档位清单（与 devops 同一份名单）：只用于判断"模型名是否落在档内"，不代表强弱排序。 */
export const MODEL_TIERS = Object.freeze([
  'deepseek-v4-pro',
  'gpt-6.1-sol',
  'gpt-6-astra',
  'muse-spark-1.3-contributor',
]);

/** 证据来源类型：`model` = 模型自述；`mock` = 夹具/离线演示（联调与实测另记）。 */
export const REVIEW_SOURCE_TYPES = Object.freeze(['model', 'mock']);

/** 脱敏类别：写盘前命中任一即阻断（AC-19）。 */
export const REDACTION_CATEGORIES = Object.freeze(['token', 'internal-host', 'absolute-path']);

/** `review.md` 在仓库内的固定位置：`docs/teamflow/<变更号>/review.md`（TECHNICAL §4.1）。 */
export const REVIEW_DIR_SEGMENTS = Object.freeze(['docs', 'teamflow']);

/** 产物文件名（与工具返回值、测试共用这一个字符串）。 */
export const REVIEW_FILE_NAME = 'review.md';

/** 变更号：字母或数字开头，其后允许 `[A-Za-z0-9_-]`，总长 2–64（与 devops 同源，不按前缀推断语义）。 */
export const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/u;

/** commit 只收真实 sha：7–40 位十六进制（`HEAD`、分支名、空串一律拒）。 */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u;

/** 审查记录的结构性错误码（固定枚举；自由文本只进 message / detail）。 */
export const REVIEW_REASONS = Object.freeze({
  MISSING_CHANGE_ID: 'REVIEW_MISSING_CHANGE_ID',
  INVALID_CHANGE_ID: 'REVIEW_INVALID_CHANGE_ID',
  INVALID_COMMIT: 'REVIEW_INVALID_COMMIT',
  INVALID_MODEL: 'REVIEW_INVALID_MODEL',
  MODEL_NOT_RECORDED: 'REVIEW_MODEL_NOT_RECORDED',
  DEGRADED_NOTE_REQUIRED: 'REVIEW_DEGRADED_NOTE_REQUIRED',
  MISSING_CONCLUSION: 'REVIEW_MISSING_CONCLUSION',
  AI_ENTRY_INVALID: 'REVIEW_AI_ENTRY_INVALID',
  HUMAN_ORIGIN_REQUIRED: 'REVIEW_HUMAN_ORIGIN_REQUIRED',
  HUMAN_ORIGIN_FORBIDDEN: 'REVIEW_HUMAN_ORIGIN_FORBIDDEN',
  HUMAN_FILL_FORBIDDEN: 'REVIEW_HUMAN_FILL_FORBIDDEN',
  HUMAN_ENTRY_INVALID: 'REVIEW_HUMAN_ENTRY_INVALID',
  INVALID_REVIEW: 'REVIEW_INVALID',
  REVIEW_INCOMPLETE: 'REVIEW_INCOMPLETE',
  REDACTION_BLOCKED: 'REVIEW_REDACTION_BLOCKED',
  PROVIDER_CONFLICT: 'REVIEW_PROVIDER_CONFLICT',
  INVALID_ROOT: 'REVIEW_INVALID_ROOT',
  PATH_ESCAPE: 'REVIEW_PATH_ESCAPE',
  WRITE_FAILED: 'REVIEW_WRITE_FAILED',
});

/** 审查记录的结构性错误（抛错，零副作用）。 */
export class ReviewError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'ReviewError';
    this.code = code;
    this.detail = detail;
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

function shaOrNull(value) {
  const raw = text(value).toLowerCase();
  return SHA_PATTERN.test(raw) ? raw : null;
}

function assertSha(value, field, message) {
  const sha = shaOrNull(value);
  if (sha === null) {
    const shown = text(value);
    throw new ReviewError(REVIEW_REASONS.INVALID_COMMIT, `${message}：${shown === '' ? '（空）' : shown}（需要 7–40 位十六进制 commit sha）`, { field });
  }
  return sha;
}

function assertChangeId(value, reason, message) {
  const id = text(value);
  if (id === '') throw new ReviewError(REVIEW_REASONS.MISSING_CHANGE_ID, message, { field: 'changeId' });
  if (!CHANGE_ID_PATTERN.test(id)) {
    throw new ReviewError(reason, `${message}：「${id}」不是合法变更号（字母或数字开头，只含字母/数字/下划线/连字符，2–64 位）`, {
      field: 'changeId',
      changeId: id,
    });
  }
  return id;
}

/** 模型入参兼容 `'模型名'` 与 `{name,tier,degraded,note}`；`degraded` 只认布尔 `true`。 */
function normalizeModel(model) {
  const raw = typeof model === 'string' ? { name: model } : asObject(model);
  return {
    name: text(raw.name) || text(raw.modelName),
    tier: text(raw.tier) || null,
    degraded: raw.degraded === true,
    note: text(raw.note) || text(raw.reason),
  };
}

/**
 * 模型入参校验。
 *
 * AC-19 要的是"**实际**模型名"与"降级须明示"，所以这里只做两件不可能造假的事：
 * 名字必须有值；声明了 `degraded` 就必须写清原因。档位**不**用来拒绝记录——记录里的
 * `档位未声明（不在更强档清单）` 是文档对读者的显式交代，而硬拒会让"记下来但标清楚"
 * 这条更诚实的路走不通（模型名本来就不一定在四档名单里）。
 *
 * @param {{ name?: string, tier?: string|null, degraded?: boolean, note?: string }} recorded
 * @returns {'degraded'|'declared'|'outside-tiers'} 档位状态（渲染与测试共用）
 */
function assertModelRecorded(recorded) {
  if (recorded.name === '') {
    throw new ReviewError(REVIEW_REASONS.MODEL_NOT_RECORDED, '审查记录必须写明实际使用的模型名（model）');
  }
  if (recorded.degraded) {
    if (recorded.note === '') {
      throw new ReviewError(
        REVIEW_REASONS.DEGRADED_NOTE_REQUIRED,
        `已声明降级但未说明原因（模型 ${recorded.name}）：必须写明"未使用更强模型"的理由`,
        { modelName: recorded.name },
      );
    }
    return 'degraded';
  }
  return MODEL_TIERS.includes(recorded.name) ? 'declared' : 'outside-tiers';
}

const AI_PREFIX = Object.freeze({ issue: 'A', risk: 'R', opinion: 'O' });

/** AI 栏：`'文本'` 或 `{text}` 均可；空条目直接判不成立（不允许静默丢一条意见）。 */
function aiEntries(value, kind, section) {
  return asArray(value).map((entry, position) => {
    const raw = typeof entry === 'string' ? { text: entry } : asObject(entry);
    const body = text(raw.text) || text(raw.detail);
    if (body === '') {
      throw new ReviewError(REVIEW_REASONS.AI_ENTRY_INVALID, `AI 栏「${section}」第 ${position + 1} 条没有文字`, { section, position });
    }
    return { id: `${AI_PREFIX[kind]}-${position + 1}`, kind, section, text: body };
  });
}

function inline(value) {
  return text(value).replace(/\s*\n\s*/gu, ' ').replace(/\|/gu, '\\|');
}

function code(value, fallback = '（未记录）') {
  const raw = inline(value);
  if (raw === '') return fallback;
  return raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``;
}

/**
 * 组装审查记录：AI 栏在这里写满，人工栏留空（只能由 `recordHumanConfirmation` 追加）。
 *
 * @param {{ changeId?: string, commit?: string, model?: string|object, findings?: Array,
 *   risks?: Array, opinion?: string|Array|object, conclusion?: string, at?: string,
 *   sourceType?: string }} input
 * @returns {object} 冻结的审查记录（`kind:'review'`、`provider:'gitee'`、`status:'pending-human'`）
 */
export function buildReviewRecord(input = {}) {
  // 收**整个对象**而不是只解构已知字段：AC-20 要拒的是"入参里出现了人工栏字段"，
  // 先解构会把多余的键丢掉，于是"静默忽略"看起来和"拒绝"一模一样。
  const source = asObject(input);
  const { changeId, commit, model, findings, risks, opinion, conclusion, at, sourceType } = source;
  // AC-20：模型自填人工确认——在**入口**就拒绝，而不是"忽略后当没发生"。
  const forbidden = FORBIDDEN_HUMAN_KEYS.filter((key) => source[key] !== undefined);
  if (forbidden.length > 0) {
    throw new ReviewError(
      REVIEW_REASONS.HUMAN_FILL_FORBIDDEN,
      `审查记录不接受人工栏入参（${forbidden.join(' / ')}）：人工确认只能由人调用 recordHumanConfirmation 写入`,
      { forbidden },
    );
  }
  const id = assertChangeId(changeId, REVIEW_REASONS.INVALID_CHANGE_ID, '审查记录缺少变更号');
  const sha = assertSha(commit, 'commit', '审查记录必须绑定被审代码的 commit sha');
  const recorded = normalizeModel(model);
  const tierStatus = assertModelRecorded(recorded);
  const conclusionText = text(conclusion);
  if (conclusionText === '') {
    throw new ReviewError(REVIEW_REASONS.MISSING_CONCLUSION, '审查记录缺少审查结论（conclusion）', { field: 'conclusion' });
  }
  const origin = text(sourceType) || 'model';
  if (!REVIEW_SOURCE_TYPES.includes(origin)) {
    throw new ReviewError(REVIEW_REASONS.INVALID_MODEL, `来源类型必须是 ${REVIEW_SOURCE_TYPES.join('|')}，收到 ${origin}`, {
      field: 'sourceType',
    });
  }
  const stamp = text(at) || new Date().toISOString();
  if (Number.isNaN(Date.parse(stamp))) {
    throw new ReviewError(REVIEW_REASONS.INVALID_REVIEW, `记录时间（at）不是可解析的时间：${stamp}`, { field: 'at' });
  }

  return Object.freeze({
    kind: 'review',
    provider: 'gitee',
    changeId: id,
    commit: sha,
    model: Object.freeze({ ...recorded, tierStatus }),
    sourceType: origin,
    updatedAt: stamp,
    aiColumn: Object.freeze([
      ...aiEntries(findings, 'issue', '问题'),
      ...aiEntries(risks, 'risk', '风险'),
      // `opinion` 可以是单条字符串，也可以是数组；两种都进「意见」段。
      ...aiEntries(opinion, 'opinion', '意见'),
    ]),
    humanColumn: Object.freeze([]),
    conclusion: conclusionText,
    status: 'pending-human',
  });
}

/**
 * 记录一次人工确认（**唯一**写 `humanColumn` 的入口，AC-20）。
 *
 * 返回新对象，不改入参：同一份 AI 审查可以有多条人工确认（不同人、不同 sha、不同结论），
 * 历史保留才看得出"谁在哪个 sha 上确认过什么"。
 *
 * @param {object} review `buildReviewRecord` 产出的记录
 * @param {{ by?: string, at?: string, commit?: string, decision?: string, note?: string,
 *   origin?: string }} input
 */
export function recordHumanConfirmation(review, { by, at, commit, decision, note = '', origin } = {}) {
  const source = asObject(review);
  if (source.kind !== 'review' || source.provider !== 'gitee') {
    throw new ReviewError(
      REVIEW_REASONS.INVALID_REVIEW,
      '人工确认必须挂在 buildReviewRecord 产出的 gitee 审查记录上（kind/provider 不符）',
      { kind: text(source.kind) || null, provider: text(source.provider) || null },
    );
  }
  assertChangeId(source.changeId, REVIEW_REASONS.INVALID_REVIEW, '人工确认的记录缺少变更号');

  const declared = text(origin);
  if (declared === '') {
    throw new ReviewError(
      REVIEW_REASONS.HUMAN_ORIGIN_REQUIRED,
      `人工确认必须显式声明来源（origin ∈ ${HUMAN_ORIGINS.join('|')}）：不设默认值，否则模型自填与人的确认在代码里无法区分`,
      { field: 'origin', accepted: [...HUMAN_ORIGINS] },
    );
  }
  if (MODEL_ORIGINS.includes(declared.toLowerCase()) || !HUMAN_ORIGINS.includes(declared.toLowerCase())) {
    throw new ReviewError(
      REVIEW_REASONS.HUMAN_ORIGIN_FORBIDDEN,
      `人工确认栏只能由显式人工输入写入，origin="${declared}" 不被接受（人工来源：${HUMAN_ORIGINS.join('|')}）`,
      { field: 'origin', origin: declared, accepted: [...HUMAN_ORIGINS] },
    );
  }

  const who = text(by);
  if (who === '') {
    throw new ReviewError(REVIEW_REASONS.HUMAN_ENTRY_INVALID, '人工确认必须记录确认人（by）', { field: 'by' });
  }
  const when = text(at);
  if (when === '' || Number.isNaN(Date.parse(when))) {
    throw new ReviewError(
      REVIEW_REASONS.HUMAN_ENTRY_INVALID,
      `人工确认时间（at）不是可解析的时间：${when === '' ? '（空）' : when}`,
      { field: 'at' },
    );
  }
  const sha = assertSha(commit, 'commit', '人工确认必须记录针对哪个 commit sha');
  if (!REVIEW_DECISIONS.includes(decision)) {
    throw new ReviewError(
      REVIEW_REASONS.HUMAN_ENTRY_INVALID,
      `人工确认结论（decision）只接受 ${REVIEW_DECISIONS.join(' / ')}：${text(decision) || '（空）'}`,
      { field: 'decision' },
    );
  }

  return Object.freeze({
    ...source,
    humanColumn: Object.freeze([
      ...asArray(source.humanColumn),
      Object.freeze({ by: who, at: when, commit: sha, decision, note: text(note), origin: declared.toLowerCase() }),
    ]),
    status: decision,
  });
}

/**
 * 版本一致性：被审 commit 与当前 commit 是否同一版本。
 *
 * 短 sha 是长 sha 的前缀即视为一致（`git rev-parse --short` 的常见形态）；任一缺失或不可解析
 * 一律 `stale`——无法核对时不得沿用旧确认（AC-20「`stale` 不得作为通过依据」）。
 *
 * @param {object} review
 * @param {string} currentCommit
 * @returns {'current'|'stale'}
 */
export function reviewStaleness(review, currentCommit) {
  const reviewed = shaOrNull(asObject(review).commit);
  const head = shaOrNull(currentCommit);
  if (reviewed === null || head === null) return 'stale';
  if (reviewed === head) return 'current';
  const [shorter, longer] = reviewed.length <= head.length ? [reviewed, head] : [head, reviewed];
  return longer.startsWith(shorter) ? 'current' : 'stale';
}

/** front matter 的值：出现换行/控制字符即拒绝（否则正文可以伪造头部字段）。 */
function frontMatterValue(value, field) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/[\r\n\u0000]/u.test(raw)) {
    throw new ReviewError(REVIEW_REASONS.INVALID_REVIEW, `front matter 字段 ${field} 不允许换行`, { field });
  }
  if (raw === '') throw new ReviewError(REVIEW_REASONS.INVALID_REVIEW, `front matter 字段 ${field} 不允许为空`, { field });
  // YAML 里 `:`+空格、`#`、引号开头会改变语义：加引号并转义，保持"值就是值"。
  return /^[A-Za-z0-9<][A-Za-z0-9._@/+-]*$/u.test(raw) ? raw : `"${raw.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/**
 * 渲染 `review.md` 全文（含 front matter，AC-19）。
 *
 * 版式固定：front matter → 概述 → 四段（问题/风险/意见/结论）→ `## AI 意见`（模型名与该栏 sha）
 * → `## 人工确认`。两栏是**同级**标题、物理分开；未确认时明确写"尚无"，不留给人猜。
 */
export function renderReview(review) {
  const source = asObject(review);
  const model = asObject(source.model);
  const ai = asArray(source.aiColumn).map(asObject);
  const human = asArray(source.humanColumn).map(asObject);
  const changeId = text(source.changeId);
  const lines = [];

  lines.push(
    '---',
    'kind: review',
    `changeId: ${frontMatterValue(changeId, 'changeId')}`,
    'provider: gitee',
    `sourceType: ${frontMatterValue(text(source.sourceType) || 'model', 'sourceType')}`,
    `commit: ${frontMatterValue(text(source.commit), 'commit')}`,
    `model: ${frontMatterValue(text(model.name), 'model')}`,
    `updatedAt: ${frontMatterValue(text(source.updatedAt), 'updatedAt')}`,
    '---',
    '',
  );

  lines.push(`# 交叉审查 — ${changeId || '（缺变更号）'}`, '');
  lines.push(`- provider：${code('gitee')}`);
  lines.push(`- 来源类型：${code(source.sourceType, 'model')}`);
  lines.push(`- 被审 commit：${code(source.commit, '**缺失**')}`);
  lines.push(`- 实际模型：${code(model.name, '**未记录（不合格）**')}`);
  const tierStatus = text(model.tierStatus) || (model.degraded === true ? 'degraded' : MODEL_TIERS.includes(text(model.name)) ? 'declared' : 'outside-tiers');
  if (tierStatus === 'degraded') {
    lines.push(`- 档位：**已声明降级**，未使用更强模型 —— ${inline(model.note) || '**缺少说明**'}`);
  } else if (tierStatus === 'declared') {
    lines.push(`- 档位：更强档清单内${text(model.tier) === '' ? '' : `（档位 ${inline(model.tier)}）`}`);
  } else {
    lines.push(`- 档位：**未声明**（不在更强档清单：${MODEL_TIERS.join(' / ')}），按原文记录，不代为声明`);
  }
  lines.push(`- 确认状态：${code(source.status, 'pending-human')}`);
  lines.push(`- 版本一致性：\`current\`/\`stale\` 由 commit 比对得出，不写入本文件`);
  lines.push('');

  REVIEW_SECTIONS.forEach((section) => {
    lines.push(`## ${section}`, '');
    if (section === '结论') {
      lines.push(inline(source.conclusion) || '**缺失**', '');
      return;
    }
    const entries = ai.filter((entry) => text(entry.section) === section);
    if (entries.length === 0) {
      lines.push('（无）', '');
      return;
    }
    entries.forEach((entry) => lines.push(`- ${code(entry.id, '')} ${inline(entry.text)}`));
    lines.push('');
  });

  lines.push(`## ${REVIEW_COLUMNS[0]}`, '');
  lines.push(
    `本栏由模型产出（模型 ${code(model.name, '**未记录**')}，该栏 commit ${code(source.commit, '**缺失**')}）；` +
      '未经人工确认不得当作结论。',
    '',
  );
  lines.push(`- 问题 ${ai.filter((entry) => text(entry.kind) === 'issue').length} 条`);
  lines.push(`- 风险 ${ai.filter((entry) => text(entry.kind) === 'risk').length} 条`);
  lines.push(`- 意见 ${ai.filter((entry) => text(entry.kind) === 'opinion').length} 条`);
  lines.push('');

  lines.push(`## ${REVIEW_COLUMNS[1]}`, '');
  if (human.length === 0) {
    lines.push('尚无人工确认：本栏由人触发，模型不得自填"已确认"。', '');
  } else {
    lines.push('| 时间 | 确认人 | 针对 commit | 结论 | 备注 |', '|---|---|---|---|---|');
    human.forEach((entry) => {
      lines.push(
        `| ${inline(entry.at) || '—'} | ${inline(entry.by) || '—'} | ${code(entry.commit, '—')} | ` +
          `${code(entry.decision, '—')} | ${inline(entry.note) || '—'} |`,
      );
    });
    lines.push('');
  }

  lines.push('> 版本一致性 `current|stale` 与确认状态 `pending-human|confirmed|...` 是两个轴：');
  lines.push('> `stale` 表示被审 sha 已变化，旧确认不得沿用，需按新 sha 重新确认。');
  return lines.join('\n');
}

/** 段落标题的精确匹配（`## 意见` 不得被 `## AI 意见` 命中）。 */
const sectionPattern = (section) => new RegExp(`^##\\s*${section}\\s*$`, 'mu');

/**
 * 校验渲染结果四段齐全（AC-19）。
 *
 * @param {string} text `renderReview` 的输出（或磁盘上的 `review.md`）
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function assertReviewSections(text) {
  const body = typeof text === 'string' ? text : '';
  const missing = REVIEW_SECTIONS.filter((section) => !sectionPattern(section).test(body));
  return { ok: missing.length === 0, missing };
}

/** 解析 `review.md` 的 front matter；没有 front matter 返回 `null`（= 不是本插件产的文件）。 */
export function parseReviewFrontMatter(content) {
  const body = typeof content === 'string' ? content : '';
  const matched = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(body);
  if (matched === null) return null;
  const fields = {};
  for (const line of matched[1].split(/\r?\n/u)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (pair === null) continue;
    const raw = pair[2].trim();
    const quoted = /^"(.*)"$/u.exec(raw);
    fields[pair[1]] = quoted === null ? raw : quoted[1].replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
  }
  return fields;
}

/* ------------------------------------------------------------------ 脱敏 */

/** 本机绝对路径的常见根：命中即说明文档把"我这台机器"当成了事实。 */
const ABSOLUTE_ROOTS = 'Users|home|root|opt|srv|private|var|tmp|mnt|media|Volumes|Applications|System|Library';

/** 脱敏规则表（阻断用，不做替换）。顺序即报告顺序。 */
const REDACTION_RULES = Object.freeze([
  {
    category: 'token',
    patterns: [
      /\bgh[pousr]_[A-Za-z0-9]{16,}\b/u,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
      /\bglpat-[A-Za-z0-9_-]{16,}\b/u,
      /\b(?:AKID|AK|ASIA)[A-Za-z0-9]{12,}\b/u,
      /(?:access_token|private_token|auth_token|api_key|apikey|password|passwd|secret)\s*[=:]\s*\S{6,}/iu,
      /\bauthorization\s*:\s*\S+/iu,
      /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/u,
    ],
  },
  {
    category: 'internal-host',
    patterns: [
      // 只认 `http(s)://` 后面的主机：公网域名（含 example.com）放行，内网字面量一律拦。
      /\bhttps?:\/\/(?:[^\s/@]*@)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[::1\]|\[f[cd][0-9a-f:]*\])(?::\d+)?/iu,
      /\bhttps?:\/\/(?:[^\s/@]*@)?[A-Za-z0-9-]+(?::\d+)?(?=[/\s)\]"'<>|]|$)/u,
      /\bhttps?:\/\/(?:[^\s/@]*@)?[^\s/]*\.(?:local|internal|intranet|corp|lan|localdomain|svc|cluster\.local)\b/iu,
      // 裸 IP：不带 scheme 的内网地址同样是内网事实。
      /(?<![\d.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127\.0\.0\.1)(?![\d.])/u,
      /file:\/\/[^\s)\]"'<>|]+/iu,
    ],
  },
  {
    category: 'absolute-path',
    patterns: [
      // 前面必须是行首/空白/引号/括号/反引号：避免把 `https://gitee.com/home/x` 误判成路径。
      new RegExp(`(?:^|[\\s(（"'\`])\/(?:${ABSOLUTE_ROOTS})\\/[^\\s)\\]"'\`<>]+`, 'mu'),
      /(?:^|[\s(（"'])[A-Za-z]:[\\/](?:Users|Documents|Windows|Program)[^\\s)"']*/u,
      /~\/\.(?:ssh|config|aws|kube|docker)\b/u,
    ],
  },
]);

/**
 * 脱敏扫描（AC-19）：返回命中类别与计数，**不返回命中文本**——把泄漏内容再回显一次
 * 是同一个错误犯两遍。
 *
 * @param {string} content
 * @returns {{ ok: boolean, hits: Array<{ category: string, count: number }> }}
 */
export function scanRedactions(content) {
  const body = typeof content === 'string' ? content : '';
  const hits = [];
  for (const rule of REDACTION_RULES) {
    let count = 0;
    for (const pattern of rule.patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const matches = body.match(new RegExp(pattern.source, flags));
      count += matches === null ? 0 : matches.length;
    }
    if (count > 0) hits.push({ category: rule.category, count });
  }
  return { ok: hits.length === 0, hits };
}

/* ------------------------------------------------------------------ 落盘 */

/**
 * 路径包含校验：解析后必须仍在仓库根内。
 *
 * `..`、绝对路径、带分隔符的变更号都会在解析后落到根外，这里统一拒绝一次（纵深防御：
 * 变更号本身已经限定了字符集，但"限定了字符集"不是"永远不会漏"）。
 */
function assertInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ReviewError(REVIEW_REASONS.PATH_ESCAPE, `产物路径越出仓库根：${candidate}`, { root, candidate });
  }
  return candidate;
}

/** 取最近的已存在祖先目录的真实路径：符号链接只有存在才能被解析。 */
function realpathOfNearestExisting(target) {
  let current = target;
  for (;;) {
    if (existsSync(current)) return realpathSync(current);
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** 计算摘要（写盘与读回共用同一函数，避免"算的是内存、读的是磁盘"）。 */
function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 写 `review.md`（AC-19 / AC-20）。**同步**实现：调用方（`gitee-actions` 的动作体）在
 * `run()` 里同步取 `path`/`sha256`，异步接口会让"写完才算 done"变成竞态。
 *
 * @param {{ repoRoot?: string, changeId?: string, review?: object }} input
 * @returns {{ path: string, sha256: string, bytes: number, changeId: string }}
 */
export function writeReviewFile({ repoRoot, changeId, review } = {}) {
  const rootInput = text(repoRoot);
  if (rootInput === '') throw new ReviewError(REVIEW_REASONS.INVALID_ROOT, '缺少仓库根（repoRoot）：review.md 只能落在仓库内', { field: 'repoRoot' });
  const root = path.resolve(rootInput);

  const source = asObject(review);
  const id = assertChangeId(
    text(changeId) || text(source.changeId),
    REVIEW_REASONS.INVALID_CHANGE_ID,
    'review.md 缺少变更号',
  );
  if (source.kind !== 'review' || source.provider !== 'gitee') {
    throw new ReviewError(
      REVIEW_REASONS.INVALID_REVIEW,
      '只写本插件产出的 gitee 审查记录（kind/provider 不符）：不把别的语义写进 review.md',
      { kind: text(source.kind) || null, provider: text(source.provider) || null },
    );
  }
  if (text(source.changeId) !== '' && text(source.changeId) !== id) {
    throw new ReviewError(REVIEW_REASONS.INVALID_REVIEW, `变更号不一致：入参 ${id}，记录 ${text(source.changeId)}`, {
      changeId: id,
      reviewChangeId: text(source.changeId),
    });
  }

  // 仓库根必须是已存在的目录：替调用方"顺手建一个仓库根"，等于把产物写进一个看起来像仓库的新目录。
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ReviewError(REVIEW_REASONS.INVALID_ROOT, `仓库根不是已存在的目录：${root}`, { field: 'repoRoot', root });
  }

  const directory = path.join(root, ...REVIEW_DIR_SEGMENTS, id);
  const target = path.join(directory, REVIEW_FILE_NAME);
  assertInsideRoot(root, target);
  // 目录里的符号链接可能把"仓库内路径"指向仓库外：按真实路径再断言一次（目录可能尚未创建，取最近的
  // 已存在祖先）。
  const realRoot = realpathSync(root);
  const assertRealInside = (candidate) => {
    if (path.relative(realRoot, candidate).startsWith('..')) {
      throw new ReviewError(REVIEW_REASONS.PATH_ESCAPE, `产物路径的真实位置越出仓库根：${candidate}`, {
        root: realRoot,
        candidate,
      });
    }
  };
  assertRealInside(realpathOfNearestExisting(directory));
  if (existsSync(target)) assertRealInside(realpathSync(target));

  const rendered = renderReview({ ...source, changeId: id });
  const sections = assertReviewSections(rendered);
  if (!sections.ok) {
    throw new ReviewError(REVIEW_REASONS.REVIEW_INCOMPLETE, `review.md 缺少段落：${sections.missing.join(' / ')}`, {
      missing: sections.missing,
    });
  }
  const scanned = scanRedactions(rendered);
  if (!scanned.ok) {
    throw new ReviewError(
      REVIEW_REASONS.REDACTION_BLOCKED,
      `review.md 正文命中脱敏规则（${scanned.hits.map((hit) => `${hit.category}×${hit.count}`).join(' / ')}）：阻断写盘，先删掉这些内容`,
      { hits: scanned.hits },
    );
  }

  // 跨 provider 保护：目标已存在且不是 gitee 产的文件，不覆盖（AC-19）。
  if (existsSync(target)) {
    if (statSync(target).isDirectory()) {
      throw new ReviewError(REVIEW_REASONS.INVALID_REVIEW, `目标路径是目录而不是文件：${target}`, { path: target });
    }
    const existing = parseReviewFrontMatter(readFileSync(target, 'utf8'));
    const existingProvider = text(existing?.provider);
    if (existingProvider !== 'gitee') {
      throw new ReviewError(
        REVIEW_REASONS.PROVIDER_CONFLICT,
        `目标 review.md 属于其他 provider（${existingProvider === '' ? '未声明 provider' : existingProvider}）：gitee 侧不覆盖，请人工确认归属`,
        { path: target, existingProvider: existingProvider === '' ? null : existingProvider },
      );
    }
  }

  const temporary = path.join(directory, `.${REVIEW_FILE_NAME}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, rendered, 'utf8');
    renameSync(temporary, target);
  } catch (error) {
    try {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw new ReviewError(REVIEW_REASONS.WRITE_FAILED, `review.md 写入失败：${text(error?.message) || error}`, {
      path: target,
    });
  }

  // 证据来自磁盘：读回同一份文件算摘要，而不是相信内存里的字符串。
  const written = readFileSync(target, 'utf8');
  return {
    path: target,
    sha256: sha256(written),
    bytes: Buffer.byteLength(written, 'utf8'),
    changeId: id,
  };
}
