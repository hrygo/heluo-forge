/**
 * `@heluo/forge-devops` 的交付计划（AC-15）：验收条件 → 实现项 → 验证方式；按真实交付边界拆分。
 *
 * 三个刻意的取舍：
 * 1. **没有 `stages` 字段**：不引入"需求/实现/测试/发布"这类固定阶段模板，计划只绑验收条件。
 *    手工塞进 `stages`（或实现项带 `stage`）会被判 `FIXED_STAGE_TEMPLATE`——需求明确写了
 *    "不引入与本次变更无关的固定阶段、模板或文档"，字段存在即诱导下游按模板执行。
 * 2. **逐条映射是硬要求**：每条验收条件至少一个实现项，每个实现项至少一种验证方式；
 *    `validatePlan` 返回逐条 `{criterionIndex, reason}` 的 `gaps`，不做"看起来像计划"的放行。
 * 3. **拆分只按真实边界**：实现项声明的 `boundary` 相同即同一交付单元；简单变更自然收敛成
 *    1 个 Issue + 1 个 PR，复杂变更按边界分组，绝不按阶段拆。分组是覆盖性的：
 *    每个实现项必落在且仅落在一个 Issue 与一个 PR 里。
 *
 * 纯函数：不读时钟、不读文件、不调平台。同输入必然同输出，便于逐条核对与幂等创建。
 */

/** 验证方式词表：已知种类之外的 `kind` 判不合格（避免"验证方式"退化成自由文本）。 */
export const VERIFICATION_KINDS = Object.freeze(['unit', 'integration', 'e2e', 'command', 'manual']);

/** 计划的缺口原因（`validatePlan` 的 `gaps[].reason` 取值）。 */
export const PLAN_GAP_REASONS = Object.freeze({
  INVALID_PLAN: 'INVALID_PLAN',
  MISSING_CHANGE_ID: 'MISSING_CHANGE_ID',
  NO_CRITERIA: 'NO_CRITERIA',
  MISSING_CRITERION: 'MISSING_CRITERION',
  UNKNOWN_CRITERION: 'UNKNOWN_CRITERION',
  NO_VERIFICATION: 'NO_VERIFICATION',
  INVALID_ITEM: 'INVALID_ITEM',
  DUPLICATE_ITEM_ID: 'DUPLICATE_ITEM_ID',
  NO_DELIVERY_SPLIT: 'NO_DELIVERY_SPLIT',
  FIXED_STAGE_TEMPLATE: 'FIXED_STAGE_TEMPLATE',
});

/** 实现项未声明交付边界时的默认分组名。 */
export const DEFAULT_BOUNDARY = 'default';

/** 计划的结构性错误（抛错，零副作用）：缺变更号、`criteria` / `items` 不是数组。 */
export class PlanError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'PlanError';
    this.code = code;
    this.detail = detail;
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const strings = (value) => asArray(value).map(text).filter((item) => item !== '');

/** 验收条件兼容两种入参：`'文本'` 或 `{index, text}`（后者来自 `Change.acceptanceCriteria`）。 */
function normalizeCriteria(criteria) {
  return asArray(criteria).map((criterion, position) => {
    if (typeof criterion === 'string') return { index: position + 1, text: text(criterion) };
    const raw = asObject(criterion);
    const index = Number.isInteger(raw.index) && raw.index > 0 ? raw.index : position + 1;
    return { index, text: text(raw.text) };
  });
}

/** 验证方式：对象 `{kind, command}`；也接受裸字符串（等价 `kind:'command'`），减少调用方负担。 */
function normalizeVerification(verification) {
  if (typeof verification === 'string') return { kind: 'command', command: text(verification) };
  const raw = asObject(verification);
  return { kind: text(raw.kind), command: text(raw.command) || text(raw.detail) };
}

function normalizeItem(item, position) {
  const raw = asObject(item);
  const criterionIndex = Number.isInteger(raw.criterionIndex) && raw.criterionIndex > 0 ? raw.criterionIndex : null;
  return {
    id: text(raw.id) || `P-${position + 1}`,
    criterionIndex,
    change: text(raw.change) || text(raw.description) || text(raw.text),
    verification: asArray(raw.verification).map(normalizeVerification),
    files: strings(raw.files),
    boundary: text(raw.boundary) || DEFAULT_BOUNDARY,
  };
}

function splitTitle(changeId, boundary, groups) {
  return groups > 1 ? `${changeId} 交付（${boundary}）` : `${changeId} 交付`;
}

/** 按 `boundary` 分组：1 组 = 1 Issue + 1 PR；分组是覆盖性的（每个实现项恰好出现一次）。 */
function buildSplit({ changeId, items }) {
  const order = [];
  const groups = new Map();
  items.forEach((item) => {
    if (!groups.has(item.boundary)) {
      groups.set(item.boundary, []);
      order.push(item.boundary);
    }
    groups.get(item.boundary).push(item.id);
  });
  const issues = order.map((boundary, index) => ({
    id: `I-${index + 1}`,
    boundary,
    title: splitTitle(changeId, boundary, order.length),
    itemIds: groups.get(boundary),
  }));
  const prs = order.map((boundary, index) => ({
    id: `PR-${index + 1}`,
    issueId: issues[index].id,
    boundary,
    title: splitTitle(changeId, boundary, order.length),
    itemIds: groups.get(boundary),
  }));
  return { issues, prs };
}

/**
 * 组装计划：验收条件逐条入位，实现项保留 `criterionIndex` / `verification` / `files` / `boundary`，
 * 交付拆分由边界推导。契约外字段（尤其 `stage` / `stages`）一律不进入计划。
 */
export function buildDeliveryPlan({ changeId, criteria, items } = {}) {
  const id = text(changeId);
  if (id === '') {
    throw new PlanError(PLAN_GAP_REASONS.MISSING_CHANGE_ID, '交付计划缺少变更号', { field: 'changeId' });
  }
  if (criteria !== undefined && !Array.isArray(criteria)) {
    throw new PlanError(PLAN_GAP_REASONS.INVALID_PLAN, 'criteria 必须是数组', { field: 'criteria' });
  }
  if (items !== undefined && !Array.isArray(items)) {
    throw new PlanError(PLAN_GAP_REASONS.INVALID_PLAN, 'items 必须是数组', { field: 'items' });
  }

  const normalizedItems = asArray(items).map((item, position) => normalizeItem(item, position));
  return {
    changeId: id,
    criteria: normalizeCriteria(criteria),
    items: normalizedItems,
    split: buildSplit({ changeId: id, items: normalizedItems }),
  };
}

/**
 * 逐条机检：返回 `{ok, gaps[{criterionIndex, reason, ...定位字段}]}`。
 *
 * `criterionIndex` 为验收条件序号（计划级缺口为 `null`）；`itemId` 等附加字段只用于定位，
 * 不影响判定。任一 gap 即判不通过——"没有验证方式的条目"不许混过。
 */
export function validatePlan(plan) {
  const gaps = [];
  const push = (criterionIndex, reason, extra = {}) => gaps.push({ criterionIndex, reason, ...extra });

  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    push(null, PLAN_GAP_REASONS.INVALID_PLAN);
    return { ok: false, gaps };
  }

  const source = asObject(plan);
  if (text(source.changeId) === '') push(null, PLAN_GAP_REASONS.MISSING_CHANGE_ID);
  if ('stages' in source || 'stage' in source) push(null, PLAN_GAP_REASONS.FIXED_STAGE_TEMPLATE);

  const criteria = asArray(source.criteria).map(asObject);
  if (criteria.length === 0) push(null, PLAN_GAP_REASONS.NO_CRITERIA);
  const criterionIndexes = new Set(
    criteria.map((criterion, position) => (Number.isInteger(criterion.index) && criterion.index > 0 ? criterion.index : position + 1)),
  );

  const items = asArray(source.items);
  const itemIds = new Set();
  items.forEach((item, position) => {
    const raw = asObject(item);
    const itemId = text(raw.id) || `#${position + 1}`;
    const criterionIndex = Number.isInteger(raw.criterionIndex) ? raw.criterionIndex : null;

    if (itemIds.has(itemId)) push(criterionIndex, PLAN_GAP_REASONS.DUPLICATE_ITEM_ID, { itemId });
    else itemIds.add(itemId);

    // 实现项带阶段字段 = 变相的固定阶段模板，同样判不合格。
    if ('stage' in raw || 'stages' in raw) push(criterionIndex, PLAN_GAP_REASONS.FIXED_STAGE_TEMPLATE, { itemId });

    if (text(raw.change) === '') push(criterionIndex, PLAN_GAP_REASONS.INVALID_ITEM, { itemId, field: 'change' });

    if (criterionIndex === null || criterionIndex < 1) {
      push(null, PLAN_GAP_REASONS.INVALID_ITEM, { itemId, field: 'criterionIndex' });
    } else if (!criterionIndexes.has(criterionIndex)) {
      push(criterionIndex, PLAN_GAP_REASONS.UNKNOWN_CRITERION, { itemId });
    }

    const verification = asArray(raw.verification);
    if (verification.length === 0) {
      push(criterionIndex, PLAN_GAP_REASONS.NO_VERIFICATION, { itemId });
    }
    verification.forEach((entry) => {
      const method = asObject(entry);
      const kind = text(method.kind);
      if (!VERIFICATION_KINDS.includes(kind)) push(criterionIndex, PLAN_GAP_REASONS.NO_VERIFICATION, { itemId, kind });
      if (text(method.command) === '') push(criterionIndex, PLAN_GAP_REASONS.NO_VERIFICATION, { itemId, field: 'command' });
    });
  });

  // 内容为空的条目不算映射：一个没有"做什么"的行不能证明这条验收条件有人接。
  for (const index of criterionIndexes) {
    const mapped = items.filter((item) => {
      const raw = asObject(item);
      return raw.criterionIndex === index && text(raw.change) !== '';
    });
    if (mapped.length === 0) push(index, PLAN_GAP_REASONS.MISSING_CRITERION);
  }

  if (items.length > 0) {
    const split = asObject(source.split);
    if (asArray(split.issues).length === 0 || asArray(split.prs).length === 0) {
      push(null, PLAN_GAP_REASONS.NO_DELIVERY_SPLIT);
    }
  }

  const seen = new Set();
  const unique = gaps.filter((gap) => {
    const key = `${gap.criterionIndex}|${gap.reason}|${gap.itemId ?? ''}|${gap.field ?? ''}|${gap.kind ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ok: unique.length === 0, gaps: unique };
}

/** 单元格/行内文本转义：Markdown 表格里的竖线与换行会把结构撑坏。 */
const inline = (value) => (text(value) === '' ? '（缺失）' : text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));

const codeOrPlain = (method) =>
  text(method.kind) === 'manual' ? inline(method.command) : `\`${inline(method.command)}\``;

/** 渲染 Markdown 计划：先给"逐条映射"表，再给实现项明细与交付拆分。畸形计划不抛错。 */
export function renderPlan(plan) {
  const source = asObject(plan);
  const criteria = asArray(source.criteria).map(asObject);
  const items = asArray(source.items).map(asObject);
  const split = asObject(source.split);
  const lines = [];

  const covering = (index) => items.filter((item) => item.criterionIndex === index);
  const evidence = (item) =>
    asArray(item.verification)
      .map(asObject)
      .map((method) => `${text(method.kind) || '?'} ${inline(method.command)}`)
      .join('；');

  lines.push(`# 交付计划 — ${text(source.changeId) || '（缺变更号）'}`, '');
  lines.push('## 验收条件 → 实现 → 验证', '');
  if (criteria.length === 0) {
    lines.push('无验收条件：计划不成立（缺验收条件与实现项的映射）。', '');
  } else {
    lines.push('| # | 验收条件 | 实现项 | 验证方式 |', '|---|---|---|---|');
    criteria.forEach((criterion, position) => {
      const index = Number.isInteger(criterion.index) && criterion.index > 0 ? criterion.index : position + 1;
      const mapped = covering(index);
      const itemText = mapped.map((item) => text(item.id) || '?').join('、') || '**缺失**';
      const verifyText = mapped.map(evidence).filter((entry) => entry !== '').join('；') || '**缺失**';
      lines.push(`| ${index} | ${inline(criterion.text)} | ${itemText} | ${verifyText} |`);
    });
    lines.push('');
  }

  lines.push('## 实现项明细', '');
  if (items.length === 0) {
    lines.push('无实现项：计划不成立。', '');
  }
  items.forEach((item, position) => {
    const criterionIndex = Number.isInteger(item.criterionIndex) ? item.criterionIndex : '?';
    lines.push(`### ${text(item.id) || `#${position + 1}`} — AC-${criterionIndex}（边界：${text(item.boundary) || DEFAULT_BOUNDARY}）`, '');
    lines.push(`- 内容：${inline(item.change)}`);
    const files = strings(item.files);
    lines.push(`- 文件：${files.length === 0 ? '—' : files.map((file) => `\`${file}\``).join('、')}`);
    const methods = asArray(item.verification).map(asObject);
    if (methods.length === 0) {
      lines.push('- 验证：**缺失**');
    } else {
      lines.push('- 验证：');
      methods.forEach((method) => lines.push(`  - ${text(method.kind) || '?'}：${codeOrPlain(method)}`));
    }
    lines.push('');
  });

  lines.push('## 交付拆分', '');
  const issues = asArray(split.issues).map(asObject);
  const prs = asArray(split.prs).map(asObject);
  if (issues.length === 0 || prs.length === 0) {
    lines.push('缺失：至少需要 1 个 Issue 与 1 个 PR。', '');
  } else {
    issues.forEach((issue) => {
      lines.push(`- Issue ${text(issue.id) || '?'}「${text(issue.title) || '（缺标题）'}」：${strings(issue.itemIds).join('、') || '—'}`);
    });
    prs.forEach((pr) => {
      lines.push(
        `- PR ${text(pr.id) || '?'}（对应 ${text(pr.issueId) || '?'}）「${text(pr.title) || '（缺标题）'}」：` +
          (strings(pr.itemIds).join('、') || '—'),
      );
    });
    lines.push('');
  }

  return lines.join('\n');
}
