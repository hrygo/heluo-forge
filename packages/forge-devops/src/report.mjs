/**
 * `@heluo/forge-devops` 完成报告（AC-20 / AC-21 / AC-23，设计 §4.3 / §7.5）。
 *
 * 报告是"证据账本"，不是"完成声明"。四条纪律写进结构里：
 * 1. **逐条证据**：每条验收条件必须带 ≥1 条证据，证据强制六字段
 *    `{command, at, hostVersion, target, sourceType, result}`；缺任一字段即判不合格——
 *    不允许"已通过"却没有命令与时间（AC-23）。
 * 2. **mock 与 enterprise 分列**：`sourceType` 只有两值，逐条标注并按来源汇总；mock 结论不得
 *    冒充企业实测，渲染在无企业证据时显式写"本报告无企业实测证据"。
 * 3. **UAT 取不到即 `unknown`**：部署由企业既有 CI/CD 完成，本插件只读核对（AC-21）；
 *    无结果标 `unknown` + 原因，不写"通过"。
 * 4. **关闭只判定不执行**：`issueCloseReadiness` 只返回 `{ready, missing}`；本模块没有任何
 *    merge / close / release / deploy 通道（AC-19），渲染也明确写"不改变平台完成状态"。
 *
 * 纯函数：不读时钟（`at` 由调用方注入）、不读文件、不调平台。词表借用规则：
 * 平台动作四状态与流程态（`blocked` / `skipped` / `stale`）是两套词表，渲染时分开写。
 */
import { reviewStaleness } from './review.mjs';

/** 证据来源类型：与产物 front matter 的 `sourceType` 同一词表。 */
export const REPORT_SOURCE_TYPES = Object.freeze(['mock', 'enterprise']);

/** 每条验收条件的结论：通过 / 未通过 / 未验证（不猜：默认 `not-verified`）。 */
export const REPORT_CONCLUSIONS = Object.freeze(['passed', 'failed', 'not-verified']);

/** 交付分列（AC-20）：已提交 / 待审查 / 已合入。 */
export const DELIVERY_STATES = Object.freeze(['submitted', 'under-review', 'merged']);

/** UAT 只看得到这几种结果；取不到时统一 `unknown`。 */
export const UAT_STATUSES = Object.freeze(['passed', 'failed', 'unknown', 'skipped']);

/** 假设复核结论（AC-20 要求 H-* 逐条给结论）。 */
export const ASSUMPTION_RESULTS = Object.freeze(['confirmed', 'refuted', 'unknown']);

/** 证据六字段（定序）：缺一即不合格。 */
export const EVIDENCE_FIELDS = Object.freeze(['command', 'at', 'hostVersion', 'target', 'sourceType', 'result']);

/**
 * 平台动作四状态，与 `actions.ACTION_STATUSES` 逐值一致（`report.test.mjs` 断言两者相等）。
 * 这里不复用导入：报告渲染不应把写路径变成运行时依赖，但词表分叉由测试兜住。
 */
export const REPORT_ACTION_STATUSES = Object.freeze(['done', 'failed', 'denied', 'unknown']);

/**
 * 本流程可执行的平台写动作（**白名单**，真源在 `tools.FLOW_ACTIONS`；
 * `report.test.mjs` 断言两者逐值一致，防止词表分叉）。
 *
 * 用允许列表而不是禁止列表：合并、关闭、发布这类动作在本插件里根本没有对应命令，
 * 报告记录白名单外的动作即判越权（AC-19 / AC-21）——禁项不是"运行时拦截"，而是"代码里不存在"。
 */
export const PLATFORM_WRITE_ACTIONS = Object.freeze([
  'issue.create_or_update',
  'pr.create_or_update',
  'review.ai.publish',
  'change.clarification.write',
]);

/** 关闭就绪判定的缺项码（`missing[].code`）。 */
export const CLOSE_READINESS_REASONS = Object.freeze({
  NO_CRITERIA: 'NO_CRITERIA',
  CRITERION_NOT_PASSED: 'CRITERION_NOT_PASSED',
  NO_DELIVERY_PR: 'NO_DELIVERY_PR',
  PR_NOT_MERGED: 'PR_NOT_MERGED',
  PENDING_DELIVERY: 'PENDING_DELIVERY',
  HUMAN_CONFIRMATION_REQUIRED: 'HUMAN_CONFIRMATION_REQUIRED',
});

/** 关闭步骤的边界说明：本模块只判定，不执行（AC-19）。 */
export const CLOSE_READINESS_NOTE = '只判定关闭就绪性；关闭动作需人工确认后由人执行（`issue.close` 不在白名单）。';

/** UAT 边界说明（AC-21）。 */
export const UAT_NOTE = '部署由企业既有 CI/CD 完成，本插件只读核对结果、不发起部署。';

/** 报告缺口码（`validateReport` 的 `gaps[].code`）。 */
export const REPORT_GAP_REASONS = Object.freeze({
  INVALID_REPORT: 'INVALID_REPORT',
  MISSING_CHANGE_ID: 'MISSING_CHANGE_ID',
  NO_CRITERIA: 'NO_CRITERIA',
  DUPLICATE_CRITERION: 'DUPLICATE_CRITERION',
  MISSING_CRITERION_TEXT: 'MISSING_CRITERION_TEXT',
  INVALID_CONCLUSION: 'INVALID_CONCLUSION',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  MISSING_EVIDENCE_FIELDS: 'MISSING_EVIDENCE_FIELDS',
  INVALID_SOURCE_TYPE: 'INVALID_SOURCE_TYPE',
  INVALID_DELIVERY: 'INVALID_DELIVERY',
  DELIVERY_STATE_CONFLICT: 'DELIVERY_STATE_CONFLICT',
  MISSING_UAT: 'MISSING_UAT',
  INVALID_UAT: 'INVALID_UAT',
  ASSUMPTION_NOT_CHECKED: 'ASSUMPTION_NOT_CHECKED',
  INVALID_ASSUMPTION_RESULT: 'INVALID_ASSUMPTION_RESULT',
  INVALID_ASSUMPTION_ID: 'INVALID_ASSUMPTION_ID',
  INVALID_ACTION_STATUS: 'INVALID_ACTION_STATUS',
  ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED',
  REVIEW_NOT_BOUND: 'REVIEW_NOT_BOUND',
  HUMAN_CONFIRMATION_STALE: 'HUMAN_CONFIRMATION_STALE',
  CLOSING_INCONSISTENT: 'CLOSING_INCONSISTENT',
});

/** 报告的结构性错误（抛错，零副作用）：只有"无法形成报告"的情形才抛，缺项留给 `gaps`。 */
export class ReportError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'ReportError';
    this.code = code;
    this.detail = detail;
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const SHA_PATTERN = /^[0-9a-f]{7,40}$/iu;
const ASSUMPTION_ID = /^H-\d+$/u;

const shaOrNull = (value) => (SHA_PATTERN.test(text(value).toLowerCase()) ? text(value).toLowerCase() : null);
const isoOrNull = (value) => {
  const raw = text(value);
  return raw !== '' && !Number.isNaN(Date.parse(raw)) ? raw : null;
};

/** 交付状态 → 报告字段名（对象形态入参用）。 */
const DELIVERY_KEY_BY_STATE = Object.freeze({ submitted: 'submitted', 'under-review': 'underReview', merged: 'merged' });
const DELIVERY_STATE_BY_KEY = Object.freeze({ submitted: 'submitted', underReview: 'under-review', merged: 'merged' });

function inline(value) {
  return text(value).replace(/\s*\n\s*/gu, ' ').replace(/\|/gu, '\\|');
}

function code(value, fallback = '（未记录）') {
  const raw = inline(value);
  if (raw === '') return fallback;
  return raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``;
}

/**
 * 证据默认值：缺什么补什么，但只在"宿主上下文"能给的范围补
 * （`at` / `hostVersion` / `target` / `sourceType`）；`command` 与 `result` 不补——
 * 没有命令和结果摘要的证据不是证据，留给 `validateReport` 判缺项。
 */
function hostDefaults(host, changeId) {
  const raw = asObject(host);
  const declared = text(raw.sourceType);
  return {
    at: isoOrNull(raw.at),
    hostVersion: text(raw.hostVersion),
    target: changeId,
    sourceType: REPORT_SOURCE_TYPES.includes(declared) ? declared : 'mock',
    commit: shaOrNull(raw.commit),
  };
}

function normalizeEvidence(item, defaults) {
  const raw = typeof item === 'string' ? { command: item } : asObject(item);
  return {
    command: text(raw.command) || text(raw.cmd),
    at: text(raw.at) || defaults.at,
    hostVersion: text(raw.hostVersion) || defaults.hostVersion,
    target: text(raw.target) || defaults.target,
    sourceType: text(raw.sourceType) || defaults.sourceType,
    result: text(raw.result) || text(raw.detail) || text(raw.summary),
    link: text(raw.link) || text(raw.url),
  };
}

/** 结论不自动推断：缺失即 `not-verified`，"有证据"不能冒充"通过"。 */
function normalizeConclusion(value) {
  const conclusion = text(value);
  return conclusion === '' ? 'not-verified' : conclusion;
}

function normalizeCriteria(criteria, defaults) {
  return asArray(criteria).map((criterion, position) => {
    const raw = typeof criterion === 'string' ? { text: criterion } : asObject(criterion);
    return {
      index: Number.isInteger(raw.index) && raw.index > 0 ? raw.index : position + 1,
      text: text(raw.text) || text(raw.description),
      evidence: asArray(raw.evidence).map((item) => normalizeEvidence(item, defaults)),
      conclusion: normalizeConclusion(raw.conclusion),
    };
  });
}

function deliveryEntry(entry, state) {
  const raw = typeof entry === 'string' ? { ref: entry } : asObject(entry);
  const ref = text(raw.ref) || text(raw.title) || text(raw.id);
  if (ref === '') {
    throw new ReportError(REPORT_GAP_REASONS.INVALID_DELIVERY, `交付记录缺少 ref（状态 ${state}）`, { state });
  }
  return { ref, title: text(raw.title) === ref ? '' : text(raw.title), url: text(raw.url) || text(raw.link) || '', state };
}

/**
 * 交付分列归一化：对象形态 `{submitted, underReview, merged}`，或数组形态
 * `[{ref, state}]`。数组形态必须显式给 `state`——状态不明就分列等于让报告猜。
 */
function normalizeDelivery(delivery) {
  const grouped = { submitted: [], underReview: [], merged: [] };
  if (Array.isArray(delivery)) {
    delivery.forEach((entry) => {
      const state = text(asObject(entry).state);
      if (!DELIVERY_STATES.includes(state)) {
        throw new ReportError(REPORT_GAP_REASONS.INVALID_DELIVERY, `交付记录缺少合法 state（${DELIVERY_STATES.join(' / ')}）：${state || '（空）'}`, { entry: asObject(entry) });
      }
      grouped[DELIVERY_KEY_BY_STATE[state]].push(deliveryEntry(entry, state));
    });
    return grouped;
  }
  const raw = asObject(delivery);
  DELIVERY_STATES.forEach((state) => {
    const key = DELIVERY_KEY_BY_STATE[state];
    grouped[key] = asArray(raw[key] ?? raw[state]).map((entry) => deliveryEntry(entry, state));
  });
  return grouped;
}

/** 取不到 UAT 就 `unknown` + 原因；给了但非法同样落 `unknown`，并保留原始值便于排查。 */
function normalizeUat(uat) {
  if (uat === null || uat === undefined) {
    return { status: 'unknown', detail: `未取到 UAT 结果；${UAT_NOTE}`, sourceType: null };
  }
  const raw = typeof uat === 'string' ? { status: uat } : asObject(uat);
  const status = text(raw.status) || text(raw.state);
  const detail = text(raw.detail) || text(raw.reason) || text(raw.note);
  const sourceType = REPORT_SOURCE_TYPES.includes(text(raw.sourceType)) ? text(raw.sourceType) : null;
  if (!UAT_STATUSES.includes(status)) {
    // 非法状态一律落 unknown：不认识的值更像"没取到"而不是"已通过"，同时保留原始值便于排查。
    const rawNote = `原始状态：${status || '空'}；按 unknown 记账，不当作通过`;
    return { status: 'unknown', detail: detail ? `${detail}（${rawNote}）` : `UAT 状态无法判定（${rawNote}）`, sourceType };
  }
  if (status === 'unknown') {
    return { status, detail: detail || `UAT 结果不可确认（AC-21：${UAT_NOTE}）`, sourceType };
  }
  return { status, detail, sourceType };
}

/**
 * 假设复核：`result` 缺失保持 `null`（渲染写"未复核"，`validateReport` 判缺口）——
 * 不用 `unknown` 默认值盖住"没人复核"这件事。
 */
function normalizeAssumptions(assumptions) {
  return asArray(assumptions).map((item, position) => {
    const raw = typeof item === 'string' ? { text: item } : asObject(item);
    return {
      id: text(raw.id) || `H-${position + 1}`,
      text: text(raw.text) || text(raw.statement),
      result: text(raw.result) || text(raw.conclusion) || null,
      note: text(raw.note) || text(raw.basis),
    };
  });
}

function normalizeAction(action) {
  const raw = asObject(action);
  return {
    status: text(raw.status),
    action: text(raw.action),
    target: text(raw.target),
    objectRef: text(raw.objectRef) || text(raw.object) || null,
    reason: text(raw.reason) || null,
    rule: text(raw.rule) || null,
    reused: raw.reused === true,
    key: text(raw.key) || text(raw.idempotencyKey) || null,
  };
}

/** 报告里的审查摘要：只留可核对字段，不复制整份 AI 栏（正文留在 `review.md`）。 */
function normalizeReviewInReport(review, headCommit) {
  if (review === null || review === undefined) return null;
  const raw = asObject(review);
  const model = asObject(raw.model);
  const humans = asArray(raw.humanColumn).map(asObject);
  return {
    changeId: text(raw.changeId),
    commit: shaOrNull(raw.commit),
    model: {
      name: text(model.name),
      tier: text(model.tier) || null,
      degraded: model.degraded === true,
      note: text(model.note),
    },
    status: text(raw.status) || 'pending-human',
    staleness: headCommit === null ? null : reviewStaleness(raw, headCommit),
    humanCount: humans.length,
    conclusion: text(raw.conclusion),
  };
}

function planSummary(plan) {
  if (plan === null || plan === undefined) return null;
  const raw = asObject(plan);
  if (Object.keys(raw).length === 0) return null;
  const split = asObject(raw.split);
  const ids = (list) => asArray(list).map((entry) => text(asObject(entry).id)).filter((id) => id !== '');
  return {
    changeId: text(raw.changeId),
    itemCount: asArray(raw.items).length,
    issueIds: ids(split.issues),
    prIds: ids(split.prs),
  };
}

/** 失败与阻塞单列（AC-20）：非 `done` 的动作、未合入的交付、非通过的 UAT。 */
function collectBlockers(actions, delivery, uat) {
  const blockers = [];
  actions.forEach((action) => {
    if (action.status === 'done') return;
    blockers.push({
      code: `ACTION_${action.status === '' ? 'UNKNOWN' : action.status.toUpperCase()}`,
      detail: `${action.action || '（缺动作名）'} → ${action.target || '（缺目标）'}：${action.reason || '未给原因'}`,
    });
  });
  delivery.submitted.concat(delivery.underReview).forEach((entry) => {
    blockers.push({ code: 'DELIVERY_PENDING', detail: `${entry.ref} 未合入（${entry.state}）` });
  });
  if (uat.status !== 'passed') {
    blockers.push({ code: `UAT_${uat.status.toUpperCase()}`, detail: uat.detail || 'UAT 未通过或未取到结果' });
  }
  return blockers;
}

/**
 * 关闭就绪判定（AC-20）：三个条件同时成立才算就绪——对应验收通过、交付 PR 已合入、
 * 无未完成交付；关闭动作还需人工确认（`humanConfirmed`）。
 *
 * **只判定，不执行**：本函数没有、也不接受任何关闭/合并通道；`missing` 列出每个缺项，
 * 不把"还差什么"藏进布尔里。
 *
 * @returns {{ ready: boolean, missing: Array<{code: string, detail: string}> }}
 */
export function issueCloseReadiness({ criteria, prs, pending, humanConfirmed } = {}) {
  const missing = [];
  const criterionList = asArray(criteria).map((criterion) =>
    typeof criterion === 'string' ? { text: criterion, conclusion: '' } : asObject(criterion),
  );
  if (criterionList.length === 0) {
    missing.push({ code: CLOSE_READINESS_REASONS.NO_CRITERIA, detail: '没有验收条件：无法判定完成' });
  }
  criterionList.forEach((criterion, position) => {
    const index = Number.isInteger(criterion.index) && criterion.index > 0 ? criterion.index : position + 1;
    const conclusion = text(criterion.conclusion);
    if (conclusion !== 'passed') {
      missing.push({ code: CLOSE_READINESS_REASONS.CRITERION_NOT_PASSED, detail: `AC-${index}：结论 ${conclusion || '未给出'}` });
    }
  });

  const prList = asArray(prs).map((pr) => (typeof pr === 'string' ? { ref: pr, state: '' } : asObject(pr)));
  if (prList.length === 0) {
    missing.push({ code: CLOSE_READINESS_REASONS.NO_DELIVERY_PR, detail: '没有交付 PR 记录：不能据此关闭' });
  }
  prList.forEach((pr) => {
    const state = text(pr.state);
    if (state !== 'merged') {
      missing.push({ code: CLOSE_READINESS_REASONS.PR_NOT_MERGED, detail: `${text(pr.ref) || '（缺 ref）'}：${state || '状态未知'}` });
    }
  });

  asArray(pending).forEach((entry) => {
    const raw = typeof entry === 'string' ? { ref: entry } : asObject(entry);
    missing.push({
      code: CLOSE_READINESS_REASONS.PENDING_DELIVERY,
      detail: `${text(raw.ref) || text(raw.title) || '（缺 ref）'}：${text(raw.detail) || text(raw.state) || '未完成交付'}`,
    });
  });

  if (humanConfirmed !== true) {
    missing.push({ code: CLOSE_READINESS_REASONS.HUMAN_CONFIRMATION_REQUIRED, detail: CLOSE_READINESS_NOTE });
  }

  return { ready: missing.length === 0, missing };
}

/**
 * 组装报告：逐条验收条件 + 证据、交付分列、UAT、假设复核、平台动作、审查摘要、关闭就绪性。
 *
 * @param {{ changeId?: string, criteria?: Array, plan?: object, actions?: Array, review?: object,
 *   assumptions?: Array, delivery?: object|Array, uat?: object|string, host?: object }} input
 */
export function buildReport({ changeId, criteria, plan, actions, review, assumptions, delivery, uat, host } = {}) {
  const hostInfo = asObject(host);
  const id = text(changeId) || text(asObject(plan).changeId) || text(asObject(review).changeId);
  if (id === '') {
    throw new ReportError(REPORT_GAP_REASONS.MISSING_CHANGE_ID, '完成报告缺少变更号', { field: 'changeId' });
  }
  if (criteria !== undefined && !Array.isArray(criteria)) {
    throw new ReportError(REPORT_GAP_REASONS.INVALID_REPORT, 'criteria 必须是数组', { field: 'criteria' });
  }

  const defaults = hostDefaults(hostInfo, id);
  const normalizedCriteria = normalizeCriteria(criteria, defaults);
  const normalizedDelivery = normalizeDelivery(delivery);
  const normalizedUat = normalizeUat(uat);
  const normalizedActions = asArray(actions).map(normalizeAction);
  const reviewRecord = normalizeReviewInReport(review, defaults.commit);

  const evidenceTotals = { mock: 0, enterprise: 0 };
  normalizedCriteria.forEach((criterion) => {
    criterion.evidence.forEach((item) => {
      if (REPORT_SOURCE_TYPES.includes(item.sourceType)) evidenceTotals[item.sourceType] += 1;
    });
  });

  const humanConfirmed =
    reviewRecord !== null && reviewRecord.status === 'confirmed' && reviewRecord.staleness !== 'stale';
  const allEntries = [...normalizedDelivery.submitted, ...normalizedDelivery.underReview, ...normalizedDelivery.merged];
  const closing = issueCloseReadiness({
    criteria: normalizedCriteria,
    prs: allEntries,
    pending: [...normalizedDelivery.submitted, ...normalizedDelivery.underReview].map((entry) => entry.ref),
    humanConfirmed,
  });

  return {
    changeId: id,
    host: {
      hostVersion: defaults.hostVersion,
      at: defaults.at,
      commit: defaults.commit,
      sourceType: defaults.sourceType,
    },
    criteria: normalizedCriteria,
    evidenceTotals,
    delivery: normalizedDelivery,
    deliveryTotals: {
      submitted: normalizedDelivery.submitted.length,
      underReview: normalizedDelivery.underReview.length,
      merged: normalizedDelivery.merged.length,
    },
    uat: normalizedUat,
    assumptionsChecked: normalizeAssumptions(assumptions),
    actions: normalizedActions,
    blockers: collectBlockers(normalizedActions, normalizedDelivery, normalizedUat),
    review: reviewRecord,
    plan: planSummary(plan),
    closing,
    note: '本报告只汇总证据与关闭就绪性，不改变系统变更/用户故事状态，也不执行合并或关闭（AC-19）。',
  };
}

/** 交付分列的扁平视图（校验与就绪一致性复查共用）。 */
function deliveryEntries(delivery) {
  const grouped = asObject(delivery);
  const entries = [];
  DELIVERY_STATES.forEach((state) => {
    asArray(grouped[DELIVERY_KEY_BY_STATE[state]]).forEach((entry) => {
      const raw = asObject(entry);
      entries.push({ ref: text(raw.ref), state: text(raw.state) || state });
    });
  });
  return entries;
}

/**
 * 逐条机检：返回 `{ok, gaps[]}`；`gaps[].code` 见 `REPORT_GAP_REASONS`。
 *
 * 检查的是"报告能不能当证据用"，不是"报告写得好不好"：缺证据、来源未标注、UAT 缺失、
 * H-* 未复核、关闭结论与内容矛盾、出现越权动作，任一成立即 `ok:false`。
 */
export function validateReport(report) {
  const gaps = [];
  const push = (code, extra = {}) => gaps.push({ code, ...extra });

  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    push(REPORT_GAP_REASONS.INVALID_REPORT);
    return { ok: false, gaps };
  }
  const source = asObject(report);
  if (text(source.changeId) === '') push(REPORT_GAP_REASONS.MISSING_CHANGE_ID);

  const criteria = asArray(source.criteria).map(asObject);
  if (criteria.length === 0) push(REPORT_GAP_REASONS.NO_CRITERIA);
  const seen = new Set();
  criteria.forEach((criterion, position) => {
    const index = Number.isInteger(criterion.index) && criterion.index > 0 ? criterion.index : position + 1;
    if (seen.has(index)) push(REPORT_GAP_REASONS.DUPLICATE_CRITERION, { criterionIndex: index });
    seen.add(index);
    if (text(criterion.text) === '') push(REPORT_GAP_REASONS.MISSING_CRITERION_TEXT, { criterionIndex: index });
    if (!REPORT_CONCLUSIONS.includes(text(criterion.conclusion))) {
      push(REPORT_GAP_REASONS.INVALID_CONCLUSION, { criterionIndex: index, detail: text(criterion.conclusion) || '（空）' });
    }
    const evidence = asArray(criterion.evidence).map(asObject);
    if (evidence.length === 0) push(REPORT_GAP_REASONS.MISSING_EVIDENCE, { criterionIndex: index });
    evidence.forEach((item, evidenceIndex) => {
      const missingFields = EVIDENCE_FIELDS.filter((field) => text(item[field]) === '');
      if (missingFields.length > 0) {
        push(REPORT_GAP_REASONS.MISSING_EVIDENCE_FIELDS, { criterionIndex: index, evidenceIndex, detail: missingFields.join('、') });
      }
      if (!REPORT_SOURCE_TYPES.includes(text(item.sourceType))) {
        push(REPORT_GAP_REASONS.INVALID_SOURCE_TYPE, { criterionIndex: index, evidenceIndex, detail: text(item.sourceType) || '（空）' });
      }
    });
  });

  const delivery = deliveryEntries(source.delivery);
  const statesByRef = new Map();
  delivery.forEach((entry) => {
    if (entry.ref === '') {
      push(REPORT_GAP_REASONS.INVALID_DELIVERY, { detail: `交付记录缺少 ref（${entry.state}）` });
      return;
    }
    const known = statesByRef.get(entry.ref) ?? new Set();
    known.add(entry.state);
    statesByRef.set(entry.ref, known);
  });
  statesByRef.forEach((states, ref) => {
    if (states.size > 1) {
      push(REPORT_GAP_REASONS.DELIVERY_STATE_CONFLICT, { detail: `${ref}：${[...states].join(' / ')}` });
    }
  });

  const uat = asObject(source.uat);
  const uatStatus = text(uat.status);
  if (uatStatus === '') push(REPORT_GAP_REASONS.MISSING_UAT);
  else if (!UAT_STATUSES.includes(uatStatus)) push(REPORT_GAP_REASONS.INVALID_UAT, { detail: uatStatus });
  else if (uatStatus === 'unknown' && text(uat.detail) === '') {
    push(REPORT_GAP_REASONS.INVALID_UAT, { detail: 'unknown 必须写明原因（AC-21）' });
  }

  asArray(source.assumptionsChecked).map(asObject).forEach((assumption) => {
    const id = text(assumption.id);
    if (!ASSUMPTION_ID.test(id)) push(REPORT_GAP_REASONS.INVALID_ASSUMPTION_ID, { detail: id || '（空）' });
    const result = text(assumption.result);
    if (result === '') push(REPORT_GAP_REASONS.ASSUMPTION_NOT_CHECKED, { detail: id || '（缺 id）' });
    else if (!ASSUMPTION_RESULTS.includes(result)) {
      push(REPORT_GAP_REASONS.INVALID_ASSUMPTION_RESULT, { detail: `${id || '（缺 id）'}：${result}` });
    }
  });

  asArray(source.actions).map(asObject).forEach((action) => {
    const status = text(action.status);
    if (!REPORT_ACTION_STATUSES.includes(status)) {
      push(REPORT_GAP_REASONS.INVALID_ACTION_STATUS, { detail: `${text(action.action) || '（缺动作名）'}：${status || '（空）'}` });
    }
    const name = text(action.action).toLowerCase();
    if (name !== '' && !PLATFORM_WRITE_ACTIONS.includes(name)) {
      push(REPORT_GAP_REASONS.ACTION_NOT_ALLOWED, { detail: `${text(action.action)}（${status || '（空）'}）` });
    }
  });

  if (source.review !== null && source.review !== undefined) {
    const review = asObject(source.review);
    if (revealMissing(review)) push(REPORT_GAP_REASONS.REVIEW_NOT_BOUND, { detail: revealMissing(review) });
    if (text(review.staleness) === 'stale') {
      push(REPORT_GAP_REASONS.HUMAN_CONFIRMATION_STALE, {
        detail: `旧人工确认针对 ${text(review.commit) || '（缺 commit）'} 已过期；需按当前 sha 重新确认`,
      });
    }
  }

  const closing = asObject(source.closing);
  if (closing.ready === true) {
    const allPassed = criteria.length > 0 && criteria.every((criterion) => text(criterion.conclusion) === 'passed');
    const merged = delivery.filter((entry) => entry.state === 'merged');
    const allMerged = delivery.length > 0 && merged.length === delivery.length;
    if (!allPassed || !allMerged) {
      push(REPORT_GAP_REASONS.CLOSING_INCONSISTENT, {
        detail: `关闭就绪与内容矛盾：验收${allPassed ? '全部通过' : '未全部通过'}；交付${allMerged ? '全部合入' : '未全部合入'}`,
      });
    }
  }

  return { ok: gaps.length === 0, gaps };
}

/** 审查摘要是否缺少 commit / 模型名（缺一项即"未绑定版本与模型"）。 */
function revealMissing(review) {
  const missing = [];
  if (shaOrNull(review.commit) === null) missing.push('commit');
  if (text(asObject(review.model).name) === '') missing.push('model');
  return missing.length === 0 ? null : missing.join('、');
}

/**
 * 渲染 `report.md` 正文（front matter 由 `artifacts.mjs` 统一加）。
 *
 * 刻意避免"系统变更已完成 / 用户故事已完成"这类结论：报告只给证据与就绪性，
 * 平台完成状态由用户故事既有流程决定（AC-19）。
 */
export function renderReport(report) {
  const source = asObject(report);
  const host = asObject(source.host);
  const criteria = asArray(source.criteria).map(asObject);
  const delivery = asObject(source.delivery);
  const uat = asObject(source.uat);
  const assumptions = asArray(source.assumptionsChecked).map(asObject);
  const actions = asArray(source.actions).map(asObject);
  const blockers = asArray(source.blockers).map(asObject);
  const plan = source.plan === null || source.plan === undefined ? null : asObject(source.plan);
  const review = source.review === null || source.review === undefined ? null : asObject(source.review);
  const closing = asObject(source.closing);
  const totals = asObject(source.evidenceTotals);
  const mockTotal = Number(totals.mock) || 0;
  const enterpriseTotal = Number(totals.enterprise) || 0;
  const lines = [];

  lines.push(`# 完成报告 — ${text(source.changeId) || '（缺变更号）'}`, '');
  lines.push('> 本报告只汇总验收证据与关闭就绪性，**不改变**系统变更/用户故事状态，也不执行合并或关闭（AC-19）。', '');
  lines.push(`- 宿主版本：${code(host.hostVersion, '（未记录）')}`);
  lines.push(`- 证据时间：${inline(host.at) || '（未记录）'}`);
  lines.push(
    `- 来源类型：mock 实测 ${mockTotal} 条 / 企业实测 ${enterpriseTotal} 条` +
      (enterpriseTotal === 0 ? ' —— **本报告无企业实测证据**；mock 结论不得当作企业已联调（AC-23）' : ''),
  );
  lines.push(`- 当前 commit：${host.commit === null || host.commit === undefined || text(host.commit) === '' ? '（未提供）' : code(host.commit)}`);
  lines.push('');

  lines.push('## 验收条件与证据', '');
  if (criteria.length === 0) {
    lines.push('无验收条件：报告不成立。', '');
  } else {
    lines.push('| # | 验收条件 | 结论 | 证据（mock / 企业） |', '|---|---|---|---|');
    criteria.forEach((criterion, position) => {
      const index = Number.isInteger(criterion.index) && criterion.index > 0 ? criterion.index : position + 1;
      const evidence = asArray(criterion.evidence).map(asObject);
      const mock = evidence.filter((item) => text(item.sourceType) === 'mock').length;
      const enterprise = evidence.filter((item) => text(item.sourceType) === 'enterprise').length;
      lines.push(
        `| ${index} | ${inline(criterion.text) || '**（缺文本）**'} | ${code(criterion.conclusion, 'not-verified')} | ` +
          `${evidence.length === 0 ? '**缺失**' : `${mock} / ${enterprise}`} |`,
      );
    });
    lines.push('');
  }

  criteria.forEach((criterion, position) => {
    const index = Number.isInteger(criterion.index) && criterion.index > 0 ? criterion.index : position + 1;
    lines.push(`### AC-${index} ${inline(criterion.text) || '（缺文本）'}`, '');
    lines.push(`- 结论：${code(criterion.conclusion, 'not-verified')}`);
    const evidence = asArray(criterion.evidence).map(asObject);
    if (evidence.length === 0) {
      lines.push('- 证据：**缺失**（无证据不得判通过）');
    } else {
      lines.push('- 证据：');
      evidence.forEach((item) => {
        const sourceType = text(item.sourceType);
        const label = sourceType === 'enterprise' ? '企业实测' : sourceType === 'mock' ? 'mock 实测' : `来源未标注（${sourceType || '空'}）`;
        lines.push(
          `  - [${label}] ${code(item.command, '（缺命令）')} @ ${inline(item.at) || '（缺时间）'}；` +
            `宿主 ${inline(item.hostVersion) || '（缺版本）'}；目标 ${inline(item.target) || '（缺目标）'} → ` +
            `${inline(item.result) || '（缺结果摘要）'}${text(item.link) === '' ? '' : `（${inline(item.link)}）`}`,
        );
      });
    }
    lines.push('');
  });

  lines.push('## 交付分列', '');
  [
    ['submitted', '已提交'],
    ['underReview', '待审查'],
    ['merged', '已合入'],
  ].forEach(([key, title]) => {
    const entries = asArray(delivery[key]).map(asObject);
    lines.push(`### ${title}（${entries.length}）`, '');
    if (entries.length === 0) {
      lines.push('（无）', '');
      return;
    }
    entries.forEach((entry) => {
      const titleText = text(entry.title);
      const url = text(entry.url);
      lines.push(`- ${inline(entry.ref) || '（缺 ref）'}${titleText === '' ? '' : `「${inline(titleText)}」`}${url === '' ? '' : `：${inline(url)}`}`);
    });
    lines.push('');
  });

  if (plan !== null) {
    lines.push('## 交付计划引用', '');
    const issueIds = asArray(plan.issueIds).map((id) => text(id)).filter((id) => id !== '');
    const prIds = asArray(plan.prIds).map((id) => text(id)).filter((id) => id !== '');
    lines.push(
      `- 计划：${code(plan.changeId, '（缺变更号）')}；实现项 ${Number(plan.itemCount) || 0} 条；` +
        `Issue ${issueIds.length === 0 ? '—' : issueIds.map((id) => code(id)).join('、')}；` +
        `PR ${prIds.length === 0 ? '—' : prIds.map((id) => code(id)).join('、')}`,
    );
    lines.push('');
  }

  lines.push('## UAT 与部署边界（只读核对）', '');
  lines.push(`- 状态：${code(uat.status, 'unknown')}`);
  lines.push(`- 说明：${inline(uat.detail) || '（未给原因）'}`);
  lines.push(`- 边界：${inline(UAT_NOTE)}`);
  lines.push('');

  lines.push('## 假设复核（H-*）', '');
  if (assumptions.length === 0) {
    lines.push('（本次没有已记录假设）', '');
  } else {
    lines.push('| 假设 | 内容 | 复核结论 | 备注 |', '|---|---|---|---|');
    assumptions.forEach((assumption) => {
      const result = text(assumption.result);
      lines.push(
        `| ${code(assumption.id, '（缺 id）')} | ${inline(assumption.text) || '—'} | ` +
          `${result === '' ? '**未复核**' : code(result)} | ${inline(assumption.note) || '—'} |`,
      );
    });
    lines.push('');
  }

  lines.push('## 平台动作（四状态）', '');
  lines.push('> 平台动作状态 `done/failed/denied/unknown` 与流程态 `blocked/skipped/stale` 是两套词表，分栏书写、不混用。', '');
  if (actions.length === 0) {
    lines.push('（无平台动作）', '');
  } else {
    lines.push('| 状态 | 动作 | 目标 | 对象 | 复用 | 原因 |', '|---|---|---|---|---|---|');
    actions.forEach((action) => {
      lines.push(
        `| ${code(action.status, '—')} | ${code(action.action, '—')} | ${inline(action.target) || '—'} | ` +
          `${inline(action.objectRef) || '—'} | ${action.reused === true ? '是' : '否'} | ${inline(action.reason) || '—'} |`,
      );
    });
    lines.push('');
  }

  lines.push('## 失败与阻塞', '');
  if (blockers.length === 0) {
    lines.push('（无）', '');
  } else {
    blockers.forEach((blocker) => lines.push(`- ${code(blocker.code, '—')} ${inline(blocker.detail)}`));
    lines.push('');
  }

  lines.push('## 交叉审查', '');
  if (review === null) {
    lines.push('**缺失**：没有审查记录（AC-18 要求模型名与被审 commit 绑定）。', '');
  } else {
    const model = asObject(review.model);
    const tier = text(model.tier);
    lines.push(
      `- 实际模型：${code(model.name, '**未记录**')}${tier === '' ? '' : `（档位 ${inline(tier)}）`}` +
        (model.degraded === true ? ` —— 降级：未使用更强模型（${inline(model.note) || '**缺少说明**'}）` : ''),
    );
    lines.push(`- 被审 commit：${code(review.commit, '**缺失**')}`);
    lines.push(`- 人工确认：${Number(review.humanCount) || 0} 条（状态 ${code(review.status, 'pending-human')}）`);
    if (text(review.staleness) === 'stale') {
      lines.push('- **确认已过期**：被审 sha 已变化，旧确认不得沿用，需按当前 sha 重新确认（AC-18）。');
    } else if (review.staleness === null) {
      lines.push('- 版本一致性：未提供当前 commit，无法判定；不把旧确认当作有效依据。');
    } else {
      lines.push('- 版本一致性：`current`（被审 commit 与当前 commit 一致）。');
    }
    lines.push(`- 结论：${inline(review.conclusion) || '（缺结论）'}`);
    lines.push('');
  }

  lines.push('## 关闭就绪性（只判定，不执行）', '');
  lines.push(`- 就绪：${closing.ready === true ? '**是**' : '**否**'}`);
  const missing = asArray(closing.missing).map(asObject);
  if (missing.length === 0) {
    lines.push('- 缺项：无');
  } else {
    lines.push('- 缺项：');
    missing.forEach((item) => lines.push(`  - ${code(item.code, '—')} ${inline(item.detail)}`));
  }
  lines.push(`- 边界：${inline(`${CLOSE_READINESS_NOTE}（AC-19：不合并 PR、不关闭 Issue、不标 change done）`)}`, '');
  lines.push('> 平台完成状态与结束时间随所属用户故事既有流程联动；本报告不声明、也不改变平台完成状态。');

  return lines.join('\n');
}
