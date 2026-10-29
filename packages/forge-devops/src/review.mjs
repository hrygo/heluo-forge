/**
 * `@heluo/forge-devops` 的交叉审查记录（AC-18，设计 §4.3 / §7.5）。
 *
 * 三条纪律集中在这里，而不是散到渲染与工具层：
 * 1. **AI 栏与人工栏各有一个入口**：`buildReviewRecord` 只产出 `aiColumn`，`humanColumn` 恒为空
 *    且只能由 `recordHumanConfirmation` 追加。模型在代码里没有"给自己写已确认"的通道。
 * 2. **实际模型名与 commit 是必填**：`assertModelRecorded` 不接受空模型名，也不接受"用了档位外
 *    模型却不声明降级"。降级可以发生，但必须显式（`degraded:true` + 说明），因为"悄悄降级"
 *    正是 AC-18 要防的。
 * 3. **sha 变化即过期**：`reviewStaleness` 只比 commit，不猜。版本一致性（`current` / `stale`）
 *    与人工确认状态（`pending-human` / `confirmed` / ...）是**两个轴**，合成一个字段会掩盖
 *    "确认过期但流程仍显示已确认"。`stale` 属流程态，不进平台动作四状态词表。
 *
 * 纯函数：不读时钟、不读文件、不调平台。`at` 由调用方注入，测试可固定。
 */

/** 更强档位清单（PRD AC-18 原文名单）：只用于判断"模型名是否记录到档内"，不代表强弱排序。 */
export const MODEL_TIERS = Object.freeze([
  'deepseek-v4-pro',
  'gpt-6.1-sol',
  'gpt-6-astra',
  'muse-spark-1.3-contributor',
]);

/** AI 栏条目种类：问题 / 风险 / 审查意见。 */
export const AI_KINDS = Object.freeze(['issue', 'risk', 'opinion']);

/** 人工确认结论（人工栏 `decision` 取值）。 */
export const HUMAN_DECISIONS = Object.freeze(['confirmed', 'changes-requested', 'rejected']);

/** 审查流程状态：`pending-human` 之外直接复用人工确认结论，避免再造一套映射。 */
export const REVIEW_STATUSES = Object.freeze(['pending-human', ...HUMAN_DECISIONS]);

/** 版本一致性两态：`stale` 只表示被审 sha 已不是当前 sha，不等于动作失败或无人确认。 */
export const REVIEW_STALENESS = Object.freeze(['current', 'stale']);

/** 审查记录的结构性错误码（缺字段即抛错，不产出半截记录）。 */
export const REVIEW_REASONS = Object.freeze({
  MISSING_CHANGE_ID: 'MISSING_CHANGE_ID',
  INVALID_COMMIT: 'INVALID_COMMIT',
  MISSING_CONCLUSION: 'MISSING_CONCLUSION',
  MODEL_NOT_RECORDED: 'MODEL_NOT_RECORDED',
  DEGRADED_NOT_DECLARED: 'DEGRADED_NOT_DECLARED',
  DEGRADED_NOTE_REQUIRED: 'DEGRADED_NOTE_REQUIRED',
  AI_ENTRY_INVALID: 'AI_ENTRY_INVALID',
  HUMAN_ENTRY_INVALID: 'HUMAN_ENTRY_INVALID',
  INVALID_REVIEW: 'INVALID_REVIEW',
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
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** commit 只收真实 sha：7–40 位十六进制（`HEAD`、分支名、空串一律拒）。 */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/iu;

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

const AI_PREFIX = Object.freeze({ issue: 'A', risk: 'R', opinion: 'O' });
const AI_KIND_TITLES = Object.freeze({ issue: '问题', risk: '风险', opinion: '审查意见' });

/** AI 栏：`'文本'` 或 `{text}` 均可；空条目直接判不成立（不允许静默丢一条意见）。 */
function aiEntries(value, kind) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map((entry, position) => {
    const raw = typeof entry === 'string' ? { text: entry } : asObject(entry);
    const body = text(raw.text) || text(raw.detail);
    if (body === '') {
      throw new ReviewError(REVIEW_REASONS.AI_ENTRY_INVALID, `AI 栏 ${kind} 第 ${position + 1} 条没有文字`, { kind, position });
    }
    return { id: `${AI_PREFIX[kind] ?? 'X'}-${position + 1}`, kind, text: body };
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
 * 校验"实际模型已记录"：档位外模型必须显式降级并说明。
 *
 * @param {{ modelName?: string, degraded?: boolean, note?: string }} input
 * @returns {void} 不合法即抛 `ReviewError`
 */
export function assertModelRecorded({ modelName, degraded = false, note = '' } = {}) {
  const name = text(modelName);
  if (name === '') {
    throw new ReviewError(REVIEW_REASONS.MODEL_NOT_RECORDED, '审查记录必须写明实际使用的模型名');
  }
  if (degraded === true) {
    if (text(note) === '') {
      throw new ReviewError(REVIEW_REASONS.DEGRADED_NOTE_REQUIRED, `已声明降级但未说明原因（模型 ${name}）：必须写明"未使用更强模型"`, { modelName: name });
    }
    return;
  }
  if (!MODEL_TIERS.includes(name)) {
    throw new ReviewError(
      REVIEW_REASONS.DEGRADED_NOT_DECLARED,
      `模型 ${name} 不在更强档位清单内，必须显式声明 degraded:true 并说明未使用更强模型`,
      { modelName: name, tiers: [...MODEL_TIERS] },
    );
  }
}

/**
 * 组装审查记录：AI 栏在这里写满，人工栏留空（只能由 `recordHumanConfirmation` 追加）。
 *
 * @param {{ changeId?: string, commit?: string, model?: string|object, findings?: Array, risks?: Array,
 *   opinion?: string|Array|object, conclusion?: string }} input
 */
export function buildReviewRecord({ changeId, commit, model, findings, risks, opinion, conclusion } = {}) {
  const id = text(changeId);
  if (id === '') {
    throw new ReviewError(REVIEW_REASONS.MISSING_CHANGE_ID, '审查记录缺少变更号', { field: 'changeId' });
  }
  const sha = assertSha(commit, 'commit', '审查记录必须绑定被审代码的 commit sha');
  const recorded = normalizeModel(model);
  assertModelRecorded({ modelName: recorded.name, degraded: recorded.degraded, note: recorded.note });
  const conclusionText = text(conclusion);
  if (conclusionText === '') {
    throw new ReviewError(REVIEW_REASONS.MISSING_CONCLUSION, '审查记录缺少审查结论', { field: 'conclusion' });
  }

  return {
    changeId: id,
    commit: sha,
    model: recorded,
    aiColumn: [...aiEntries(findings, 'issue'), ...aiEntries(risks, 'risk'), ...aiEntries(opinion, 'opinion')],
    humanColumn: [],
    conclusion: conclusionText,
    status: 'pending-human',
  };
}

/**
 * 记录一次人工确认（**唯一**写 `humanColumn` 的入口）。
 *
 * 返回新对象，不改入参：同一份 AI 审查可以有多条人工确认（不同人、不同 sha、不同结论），
 * 历史保留才看得出"谁在哪个 sha 上确认过什么"。
 */
export function recordHumanConfirmation(review, { by, at, commit, decision, note = '' } = {}) {
  const source = asObject(review);
  if (text(source.changeId) === '') {
    throw new ReviewError(REVIEW_REASONS.INVALID_REVIEW, '人工确认必须挂在 buildReviewRecord 产出的审查记录上（缺变更号）');
  }
  const who = text(by);
  if (who === '') {
    throw new ReviewError(REVIEW_REASONS.HUMAN_ENTRY_INVALID, '人工确认必须记录确认人（by）', { field: 'by' });
  }
  const when = text(at);
  if (when === '' || Number.isNaN(Date.parse(when))) {
    throw new ReviewError(REVIEW_REASONS.HUMAN_ENTRY_INVALID, `人工确认时间（at）不是可解析的时间：${when === '' ? '（空）' : when}`, { field: 'at' });
  }
  const sha = assertSha(commit, 'commit', '人工确认必须记录针对哪个 commit sha');
  if (!HUMAN_DECISIONS.includes(decision)) {
    throw new ReviewError(REVIEW_REASONS.HUMAN_ENTRY_INVALID, `人工确认结论（decision）只接受 ${HUMAN_DECISIONS.join(' / ')}：${text(decision) || '（空）'}`, { field: 'decision' });
  }

  return {
    ...source,
    humanColumn: [...asArray(source.humanColumn), { by: who, at: when, commit: sha, decision, note: text(note) }],
    status: decision,
  };
}

/**
 * 版本一致性：被审 commit 与当前 commit 是否同一版本。
 *
 * 短 sha 是长 sha 的前缀即视为一致（`git rev-parse --short` 的常见形态）；任一缺失或不可解析
 * 一律 `stale`——无法核对时不得沿用旧确认。
 *
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

/**
 * 渲染 `review.md` 正文（front matter 由 `artifacts.mjs` 统一加）。
 *
 * 两栏必须肉眼可分：AI 栏是"模型自述"，人工栏是"人确认过的"；未确认时明确写"尚无"，
 * 而不是留给读者猜。
 */
export function renderReview(review) {
  const source = asObject(review);
  const model = asObject(source.model);
  const ai = asArray(source.aiColumn).map(asObject);
  const human = asArray(source.humanColumn).map(asObject);
  const lines = [];

  lines.push(`# 交叉审查 — ${text(source.changeId) || '（缺变更号）'}`, '');
  lines.push(`- 被审 commit：${code(source.commit, '**缺失**')}`);
  const tier = text(model.tier);
  lines.push(`- 实际模型：${code(model.name, '**未记录（不合格）**')}${tier === '' ? '' : `（档位 ${inline(tier)}）`}`);
  if (model.degraded === true) {
    lines.push(`- 降级声明：**已声明**，未使用更强模型 —— ${inline(model.note) || '**缺少说明**'}`);
  } else {
    lines.push('- 降级声明：未声明（使用档内更强模型）');
  }
  lines.push(`- 确认状态：${code(source.status, 'pending-human')}`, '');

  lines.push('## AI 审查栏（模型自述；未经人工确认不得当作结论）', '');
  AI_KINDS.forEach((kind) => {
    lines.push(`### ${AI_KIND_TITLES[kind]}`, '');
    const entries = ai.filter((entry) => entry.kind === kind);
    if (entries.length === 0) {
      lines.push('（无）', '');
      return;
    }
    entries.forEach((entry) => lines.push(`- ${code(entry.id, '')} ${inline(entry.text)}`));
    lines.push('');
  });

  lines.push('## 人工确认栏（只由 `recordHumanConfirmation` 写入）', '');
  if (human.length === 0) {
    lines.push('尚无人工确认：本栏由人触发，AI 不得自填"已确认"。', '');
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

  lines.push('## 结论', '', inline(source.conclusion) || '**缺失**', '');
  lines.push('> 版本一致性 `current|stale` 与确认状态 `pending-human|confirmed|...` 是两个轴：');
  lines.push('> `stale` 表示被审 sha 已变化，旧确认不得沿用，需按新 sha 重新确认。');
  return lines.join('\n');
}
