/**
 * `@heluo/forge-devops` 的澄清单（AC-13/14）：硬门禁项、`H-n` 假设、版本与修订标识。
 *
 * 三件事只在这里做，别处不得重写：
 * 1. **分流**：只有会改变验收结论或承建范围的歧义（`acceptance` / `scope`）进硬门禁，
 *    必须由人确认后才推进；其余歧义进「已记录假设」（`H-1…`，稳定编号、可原地替换），
 *    在上下文卡可见、完成报告逐条复核。
 * 2. **选项质量可机检**：硬门禁项必须 2–3 个 `effect` 互不相同的实质选项、利弊非空、
 *    推荐项属于选项、问句与依据非空；任一不满足即 `CLARIFY_INVALID`（等同"澄清单不通过"）。
 *    零选项的问题进 `rejected`（`reason:'no-options'`），同样判不通过——"无选项也放行"
 *    是本需求要根治的失败模式，不能靠调用方自律。
 * 3. **版本与修订标识**：`revisionId = <变更号>/<version>/<sha8>`，内容（含人工决定）一变
 *    旧版本自然失效；计划与报告只引用这一串，不复制清单正文。
 *
 * 纯函数：不读时钟、不读文件、不调平台、不调门禁。时间一律由调用方传入（拿不到即 `null`），
 * 因此同输入必然同输出——修订标识才有意义。
 */
import { createHash } from 'node:crypto';

/** 唯一两类硬门禁：只有改变验收结论或承建范围的歧义必须由人确认。 */
export const HARD_GATE_KINDS = Object.freeze(['acceptance', 'scope']);

/** 澄清单的拒绝与判不通过原因（`validateClarifySheet` 的 `code` 取值）。 */
export const CLARIFY_REASONS = Object.freeze({
  CLARIFY_INVALID: 'CLARIFY_INVALID',
  NO_OPTIONS: 'NO_OPTIONS',
  UNKNOWN_KIND: 'UNKNOWN_KIND',
  VERSION_INVALID: 'VERSION_INVALID',
});

/** 澄清单状态：`pending` 待人工确认（不得推进）；`ready` 无门禁项或已按本版本确认。 */
export const CLARIFY_STATUSES = Object.freeze(['pending', 'ready']);

/** 选项数量的硬边界：少于 2 个不是"选择"，多于 3 个是没想清楚。 */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 3;

/** 假设编号必须显式成 `H-n`，否则报告无法逐条复核。 */
const ASSUMPTION_ID = /^H-\d+$/;

/**
 * 澄清单的结构性错误（抛错，零副作用）：缺变更号、`findings` 不是数组、
 * 版本/修订标识无从计算。内容质量问题**不抛错**，由 `validateClarifySheet` 逐条报出，
 * 这样"判不通过"是数据而不是异常，QA 与工具面都能直接渲染。
 */
export class ClarifyError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'ClarifyError';
    this.code = code;
    this.detail = detail;
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const strings = (value) => asArray(value).map(text).filter((item) => item !== '');
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** 稳定序列化：键序无关，修订标识才不会因字段顺序变化而漂移。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha8 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);

/** 参与修订标识的内容投影：状态/确认时间/历史不进哈希（换状态不是换内容）。 */
function canonicalBody(sheet) {
  const source = asObject(sheet);
  return stableStringify({
    changeId: text(source.changeId),
    version: source.version,
    gate: asArray(source.gate).map((item) => {
      const gate = asObject(item);
      return {
        id: text(gate.id),
        kind: text(gate.kind),
        question: text(gate.question),
        basis: text(gate.basis),
        options: asArray(gate.options).map((option) => {
          const choice = asObject(option);
          return {
            id: text(choice.id),
            label: text(choice.label),
            effect: text(choice.effect),
            pros: strings(choice.pros),
            cons: strings(choice.cons),
          };
        }),
        recommendation: {
          optionId: text(asObject(gate.recommendation).optionId),
          why: text(asObject(gate.recommendation).why),
        },
      };
    }),
    assumptions: asArray(source.assumptions).map((item) => {
      const assumption = asObject(item);
      return {
        id: text(assumption.id),
        text: text(assumption.text),
        basis: text(assumption.basis),
        impactIfWrong: text(assumption.impactIfWrong),
      };
    }),
    rejected: asArray(source.rejected).map((item) => {
      const entry = asObject(item);
      return { findingId: text(entry.findingId), reason: text(entry.reason) };
    }),
    decisions: asArray(source.decisions).map((item) => {
      const decision = asObject(item);
      return { itemId: text(decision.itemId), optionId: text(decision.optionId), note: text(decision.note) };
    }),
  });
}

/** 修订标识：`<变更号>/<version>/<sha8(内容)>`；后续计划/报告只引用这一串。 */
export function clarifyRevisionId(sheet) {
  const changeId = text(asObject(sheet).changeId);
  if (changeId === '') {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '澄清单缺少变更号，无法生成修订标识', { field: 'changeId' });
  }
  const version = asObject(sheet).version;
  if (!Number.isInteger(version) || version < 1) {
    throw new ClarifyError(CLARIFY_REASONS.VERSION_INVALID, '澄清单版本号必须是 ≥1 的整数', { version });
  }
  return `${changeId}/${version}/${sha8(canonicalBody(sheet))}`;
}

function normalizeOption(option, index) {
  const raw = asObject(option);
  return {
    id: text(raw.id) || `O-${index + 1}`,
    label: text(raw.label),
    effect: text(raw.effect),
    pros: strings(raw.pros),
    cons: strings(raw.cons),
  };
}

/**
 * 把调用方交来的歧义发现分流成澄清单。
 *
 * `findings[]` 每项：`{id?, kind, question|text, basis, options?[], recommendation?{optionId,why},
 * assumptionId?, impactIfWrong?}`。
 * - `kind ∈ HARD_GATE_KINDS` → 硬门禁项；零选项进 `rejected(no-options)`。
 * - 其它非空 `kind` → 假设 `H-n`（传 `assumptionId:'H-3'` 即原地替换该条，不新增）。
 * - 缺 `kind` → `rejected(unknown-kind)`：分不清类别就不许静默放行。
 */
export function createClarifySheet({ changeId, findings } = {}) {
  const id = text(changeId);
  if (id === '') {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '澄清单缺少变更号', { field: 'changeId' });
  }
  if (findings !== undefined && !Array.isArray(findings)) {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, 'findings 必须是数组', { field: 'findings' });
  }

  const gate = [];
  const assumptions = [];
  const rejected = [];
  const assumptionIndex = new Map();
  const reservedIds = new Set();

  // 先登记显式假设编号，自动编号才能跳过它们，保证编号稳定。
  for (const finding of asArray(findings)) {
    const raw = asObject(finding);
    const kind = text(raw.kind);
    const explicitId = text(raw.assumptionId);
    if (kind !== '' && !HARD_GATE_KINDS.includes(kind) && ASSUMPTION_ID.test(explicitId)) {
      reservedIds.add(explicitId);
    }
  }

  let cursor = 1;
  const nextAssumptionId = () => {
    while (assumptionIndex.has(`H-${cursor}`) || reservedIds.has(`H-${cursor}`)) cursor += 1;
    const next = `H-${cursor}`;
    cursor += 1;
    return next;
  };

  asArray(findings).forEach((finding, index) => {
    const raw = asObject(finding);
    const findingId = text(raw.id) || `F-${index + 1}`;
    const kind = text(raw.kind);

    if (kind === '') {
      rejected.push({ findingId, reason: 'unknown-kind' });
      return;
    }

    if (!HARD_GATE_KINDS.includes(kind)) {
      const explicitId = text(raw.assumptionId);
      const assumption = {
        id: ASSUMPTION_ID.test(explicitId) ? explicitId : nextAssumptionId(),
        text: text(raw.text) || text(raw.assumption) || text(raw.question),
        basis: text(raw.basis),
        impactIfWrong: text(raw.impactIfWrong) || text(raw.impact),
      };
      // 显式编号即"原地替换"：同号后一条覆盖前一条，不新增行。
      const existing = assumptionIndex.get(assumption.id);
      if (existing === undefined) {
        assumptionIndex.set(assumption.id, assumptions.length);
        assumptions.push(assumption);
      } else {
        assumptions[existing] = assumption;
      }
      return;
    }

    const options = asArray(raw.options).map((option, optionIndex) => normalizeOption(option, optionIndex));
    if (options.length === 0) {
      rejected.push({ findingId, reason: 'no-options' });
      return;
    }
    const recommendation = asObject(raw.recommendation);
    gate.push({
      id: findingId,
      kind,
      question: text(raw.question) || text(raw.text),
      basis: text(raw.basis),
      options,
      recommendation: { optionId: text(recommendation.optionId), why: text(recommendation.why) },
    });
  });

  const sheet = {
    changeId: id,
    version: 1,
    status: 'pending',
    gate,
    assumptions,
    rejected,
    decisions: [],
    confirmedBy: null,
    confirmedAt: null,
    history: [],
    revisionId: null,
  };
  sheet.revisionId = clarifyRevisionId(sheet);
  // 有硬门禁项即"待人工确认"；无需确认且自身合格才是 ready。
  sheet.status = gate.length === 0 && validateClarifySheet(sheet).ok ? 'ready' : 'pending';
  return sheet;
}

/**
 * 逐条机检：返回 `{ok, problems[{code, rule, detail}]}`。
 *
 * `code` 取 `CLARIFY_REASONS`：选项/依据/推荐类问题一律 `CLARIFY_INVALID`（附 `rule` 便于定位），
 * 零选项与缺类别分别 `NO_OPTIONS` / `UNKNOWN_KIND`，版本类 `VERSION_INVALID`。
 * `rejected` 非空即判不通过（AC-13：一条"怎么办"式问题即判不通过）。
 */
export function validateClarifySheet(sheet) {
  if (sheet === null || typeof sheet !== 'object' || Array.isArray(sheet)) {
    return {
      ok: false,
      problems: [{ code: CLARIFY_REASONS.CLARIFY_INVALID, rule: 'sheet-missing', detail: {} }],
    };
  }

  const source = asObject(sheet);
  const problems = [];
  const invalid = (rule, detail = {}) => problems.push({ code: CLARIFY_REASONS.CLARIFY_INVALID, rule, detail });

  if (text(source.changeId) === '') invalid('change-id-missing');
  if (!Number.isInteger(source.version) || source.version < 1) {
    problems.push({ code: CLARIFY_REASONS.VERSION_INVALID, rule: 'version-invalid', detail: { version: source.version } });
  }
  if (!CLARIFY_STATUSES.includes(text(source.status))) {
    invalid('status-invalid', { status: source.status });
  }

  const gateIds = new Set();
  asArray(source.gate).forEach((item, index) => {
    const entry = asObject(item);
    const where = { index, itemId: text(entry.id) };
    const id = text(entry.id);
    if (id === '') invalid('gate-id-missing', where);
    else if (gateIds.has(id)) invalid('gate-id-duplicate', where);
    else gateIds.add(id);

    if (!HARD_GATE_KINDS.includes(text(entry.kind))) invalid('gate-kind', { ...where, kind: entry.kind });
    if (text(entry.question) === '') invalid('question-missing', where);
    if (text(entry.basis) === '') invalid('basis-missing', where);

    const options = asArray(entry.options);
    if (options.length < MIN_OPTIONS) invalid('options-min', { ...where, count: options.length });
    else if (options.length > MAX_OPTIONS) invalid('options-max', { ...where, count: options.length });

    const optionIds = new Set();
    const effects = new Set();
    options.forEach((option, optionIndex) => {
      const choice = asObject(option);
      const at = { ...where, optionIndex };
      const optionId = text(choice.id);
      if (optionId === '') invalid('option-id-missing', at);
      else if (optionIds.has(optionId)) invalid('option-id-duplicate', at);
      else optionIds.add(optionId);
      if (text(choice.label) === '') invalid('option-label-missing', at);
      const effect = text(choice.effect);
      if (effect === '') invalid('option-effect-missing', at);
      else if (effects.has(effect)) invalid('option-effect-duplicate', { ...where, effect });
      else effects.add(effect);
      if (strings(choice.pros).length === 0) invalid('option-pros-empty', at);
      if (strings(choice.cons).length === 0) invalid('option-cons-empty', at);
    });

    const recommendation = asObject(entry.recommendation);
    const recommended = text(recommendation.optionId);
    if (recommended === '' || !optionIds.has(recommended)) {
      invalid('recommendation-not-in-options', { ...where, optionId: recommended });
    }
    if (text(recommendation.why) === '') invalid('recommendation-why-missing', where);
  });

  const assumptionIds = new Set();
  asArray(source.assumptions).forEach((item, index) => {
    const entry = asObject(item);
    const where = { index, assumptionId: text(entry.id) };
    const id = text(entry.id);
    if (!ASSUMPTION_ID.test(id)) invalid('assumption-id-invalid', where);
    else if (assumptionIds.has(id)) invalid('assumption-id-duplicate', where);
    else assumptionIds.add(id);
    if (text(entry.text) === '') invalid('assumption-text-missing', where);
    if (text(entry.basis) === '') invalid('assumption-basis-missing', where);
    if (text(entry.impactIfWrong) === '') invalid('assumption-impact-missing', where);
  });

  asArray(source.rejected).forEach((item) => {
    const entry = asObject(item);
    const reason = text(entry.reason);
    const code =
      reason === 'no-options'
        ? CLARIFY_REASONS.NO_OPTIONS
        : reason === 'unknown-kind'
          ? CLARIFY_REASONS.UNKNOWN_KIND
          : CLARIFY_REASONS.CLARIFY_INVALID;
    problems.push({ code, rule: 'rejected', detail: { findingId: text(entry.findingId), reason } });
  });

  // 人工决定必须落在本版本的门禁项与选项内；ready 就意味着门禁项已全部决断。
  const decided = new Set();
  asArray(source.decisions).forEach((item, index) => {
    const entry = asObject(item);
    const where = { index, itemId: text(entry.itemId) };
    const gateItem = asArray(source.gate).map(asObject).find((candidate) => text(candidate.id) === text(entry.itemId));
    if (!gateItem) {
      invalid('decision-unknown-item', where);
    } else {
      const optionId = text(entry.optionId);
      if (!asArray(gateItem.options).map(asObject).some((option) => text(option.id) === optionId)) {
        invalid('decision-option-unknown', { ...where, optionId });
      }
    }
    if (decided.has(text(entry.itemId))) invalid('decision-duplicate', where);
    else decided.add(text(entry.itemId));
  });
  if (text(source.status) === 'ready' && gateIds.size > 0) {
    for (const id of gateIds) {
      if (!decided.has(id)) invalid('confirmation-incomplete', { itemId: id });
    }
  }

  if (text(source.changeId) !== '' && Number.isInteger(source.version) && source.version >= 1) {
    const expected = clarifyRevisionId(source);
    if (text(source.revisionId) !== expected) {
      invalid('revision-mismatch', { expected, actual: text(source.revisionId) });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 人工确认：只由这个函数写「已确认」与逐项决定，模型没有自填入口。
 *
 * 要求清单本身合格（`validateClarifySheet`）、确认人非空、每个门禁项都有决定且决定属于选项；
 * 决定进入修订标识，因此改答案必然产生新修订。
 */
export function confirmClarifySheet(sheet, { by, at = null, decisions } = {}) {
  const check = validateClarifySheet(sheet);
  if (!check.ok) {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '澄清单未通过校验，不能确认', { problems: check.problems });
  }
  const name = text(by);
  if (name === '') {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '确认人必填（人工确认不能由模型代填）', { field: 'by' });
  }

  const source = asObject(sheet);
  const choices = new Map();
  asArray(decisions).forEach((item) => {
    const decision = asObject(item);
    choices.set(text(decision.itemId), { itemId: text(decision.itemId), optionId: text(decision.optionId), note: text(decision.note) });
  });

  const ordered = asArray(source.gate).map((item) => text(asObject(item).id)).filter((id) => id !== '');
  const missing = ordered.filter((id) => !choices.has(id));
  if (missing.length > 0) {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '硬门禁项尚未逐项决断，不能确认', { missing });
  }
  const unknown = [...choices.keys()].filter((id) => !ordered.includes(id));
  if (unknown.length > 0) {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '决定指向不存在的门禁项', { unknown });
  }
  for (const [itemId, choice] of choices) {
    const gateItem = asArray(source.gate).map(asObject).find((candidate) => text(candidate.id) === itemId);
    if (!asArray(gateItem?.options).map(asObject).some((option) => text(option.id) === choice.optionId)) {
      throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, `决定 ${itemId} 的选项 ${choice.optionId} 不属于该门禁项`, {
        itemId,
        optionId: choice.optionId,
      });
    }
  }

  const confirmed = {
    ...source,
    status: 'ready',
    confirmedBy: name,
    confirmedAt: at === null || at === undefined ? null : String(at),
    decisions: ordered.map((id) => choices.get(id)),
    revisionId: null,
  };
  confirmed.revisionId = clarifyRevisionId(confirmed);
  const recheck = validateClarifySheet(confirmed);
  if (!recheck.ok) {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '确认后的澄清单不合格', { problems: recheck.problems });
  }
  return confirmed;
}

/**
 * 版本递增：内容变了就升版，**旧确认与旧决定一起失效**（版本号变了就不许继续推进）。
 * 原清单不被修改，返回新对象。
 */
export function bumpClarifyVersion(sheet, { reason, at = null } = {}) {
  const source = asObject(sheet);
  if (text(source.changeId) === '') {
    throw new ClarifyError(CLARIFY_REASONS.CLARIFY_INVALID, '澄清单缺少变更号', { field: 'changeId' });
  }
  if (!Number.isInteger(source.version) || source.version < 1) {
    throw new ClarifyError(CLARIFY_REASONS.VERSION_INVALID, '澄清单版本号必须是 ≥1 的整数', { version: source.version });
  }
  const next = {
    ...source,
    version: source.version + 1,
    status: 'pending',
    decisions: [],
    confirmedBy: null,
    confirmedAt: null,
    history: [
      ...asArray(source.history),
      {
        version: source.version,
        revisionId: text(source.revisionId),
        reason: text(reason) || 'content-changed',
        at: at === null || at === undefined ? null : String(at),
      },
    ],
    revisionId: null,
  };
  next.revisionId = clarifyRevisionId(next);
  return next;
}

/** 把清单渲染成人工可读的 Markdown（`clarify.md` 正文）；空段显式写"无"，不留白。 */
export function renderClarifySheet(sheet) {
  const source = asObject(sheet);
  const gate = asArray(source.gate).map(asObject);
  const assumptions = asArray(source.assumptions).map(asObject);
  const rejected = asArray(source.rejected).map(asObject);
  const decisions = new Map(asArray(source.decisions).map((item) => {
    const decision = asObject(item);
    return [text(decision.itemId), decision];
  }));
  const status = text(source.status);
  const lines = [];

  lines.push(`# 澄清单 — ${text(source.changeId) || '（缺变更号）'}`, '');
  lines.push(`- 版本：v${Number.isInteger(source.version) ? source.version : 0}`);
  lines.push(`- 修订标识：\`${text(source.revisionId) || '（未生成）'}\``);
  lines.push(`- 状态：${status === 'ready' ? '已就绪' : '待人工确认'}（${status || 'unknown'}）`);
  if (text(source.confirmedBy) !== '') {
    lines.push(`- 确认：${text(source.confirmedBy)} @ ${text(source.confirmedAt) || '时间未记录'}`);
  }
  lines.push(
    `- 硬门禁 ${gate.length} 项 / 已记录假设 ${assumptions.length} 条 / 未纳入 ${rejected.length} 项`,
    '',
  );

  lines.push('## 硬门禁项（须人工确认后推进）', '');
  if (gate.length === 0) {
    lines.push('无：没有会改变验收结论或承建范围的歧义。', '');
  }
  gate.forEach((item) => {
    lines.push(`### ${text(item.id)}　${text(item.question) || '（缺问句）'}`, '');
    lines.push(`- 类别：${text(item.kind)}`);
    lines.push(`- 依据：${text(item.basis) || '（缺失）'}`, '');
    const recommendation = asObject(item.recommendation);
    asArray(item.options).map(asObject).forEach((option, index) => {
      const recommended = text(option.id) === text(recommendation.optionId);
      const pros = strings(option.pros).join('；');
      const cons = strings(option.cons).join('；');
      lines.push(`${index + 1}. **${text(option.id)} ${text(option.label) || '（缺标题）'}**`);
      lines.push(`   - 影响：${text(option.effect) || '（缺失）'}`);
      lines.push(`   - 利：${pros || '（缺失）'}；弊：${cons || '（缺失）'}`);
      lines.push(
        recommended
          ? `   - 推荐：是${text(recommendation.why) === '' ? '' : ` —— ${text(recommendation.why)}`}`
          : '   - 推荐：否',
      );
    });
    const decision = decisions.get(text(item.id));
    if (decision) {
      const note = text(decision.note);
      lines.push('', `- 已选：${text(decision.optionId)}${note === '' ? '' : ` —— ${note}`}`);
    }
    lines.push('');
  });

  lines.push('## 已记录假设（不阻断推进，完成报告逐条复核）', '');
  if (assumptions.length === 0) {
    lines.push('无。', '');
  }
  assumptions.forEach((item) => {
    lines.push(`- **${text(item.id)}** ${text(item.text) || '（缺失）'}`);
    lines.push(`  - 依据：${text(item.basis) || '（缺失）'}`);
    lines.push(`  - 若不成立：${text(item.impactIfWrong) || '（缺失）'}`);
  });
  if (assumptions.length > 0) lines.push('');

  lines.push('## 未纳入（判不通过）', '');
  if (rejected.length === 0) {
    lines.push('无。', '');
  }
  rejected.forEach((item) => {
    const reason = text(item.reason);
    const label = reason === 'no-options' ? '无选项（no-options）' : reason === 'unknown-kind' ? '类别不明（unknown-kind）' : reason;
    lines.push(`- ${text(item.findingId) || '（缺编号）'}：${label}`);
  });
  if (rejected.length > 0) lines.push('');

  return lines.join('\n');
}
