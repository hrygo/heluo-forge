/**
 * 交付面（AC-18 / AC-21）：提交信息 `[变更号]` 校验 + 关闭条件四项判定。
 *
 * 两条边界写死在这里：
 * 1. **只判定，不执行**。本模块没有关闭/合并/合并请求批准的任何通道，连 argv 都不构造——
 *    命令白名单 `DELIVERY_ALLOWED_VERBS` 只有 `view`/`list`，`close`/`merge` 在
 *    `DELIVERY_FORBIDDEN_VERBS` 里被逐字禁掉（AC-21 的"白名单无 close/merge"因此是静态可查的
 *    不变量，不是口头承诺）。判定结果里的 `executed: false` 是同一件事的运行时证据。
 * 2. **提交信息只校验、不改写**。自动补前缀会把"人写错了"变成"工具替人做主"，也让历史无法
 *    回溯真实意图；返回值里没有任何替换后的 message，只有一个 `subject` 供调用方自己决定。
 *
 * 与 `@heluo/forge-devops`（`commit-message.mjs` / `report.mjs#issueCloseReadiness`）是**受控
 * 重复**（PRD 非目标禁止改写 devops）：同义的拒绝码沿用同名（`CRITERION_NOT_PASSED` /
 * `PENDING_DELIVERY` / `HUMAN_CONFIRMATION_REQUIRED`），provider 语义各一份；跨包漂移由
 * `test/delivery.test.mjs` 的静态断言兜住，不靠共享代码。
 *
 * 除 `reviewStaleness` 的比较规则外不依赖其他模块；`judgeCloseReadiness` 不读时钟、不读网络。
 */
import { CHANGE_ID_PATTERN, reviewStaleness } from './gitee-review.mjs';

/** 提交信息校验的拒绝原因（`缺变更号` / `缺描述` / `前缀缺失`，AC-18 的三类）。 */
export const COMMIT_REASONS = Object.freeze({
  MISSING_CHANGE_ID: 'COMMIT_MISSING_CHANGE_ID',
  INVALID_CHANGE_ID: 'COMMIT_INVALID_CHANGE_ID',
  MISSING_MESSAGE: 'COMMIT_MISSING_MESSAGE',
  PREFIX_MISSING: 'COMMIT_PREFIX_MISSING',
  DESCRIPTION_MISSING: 'COMMIT_DESCRIPTION_MISSING',
});

/** 关闭条件四项（顺序即文档与报告顺序，AC-21）。 */
export const CLOSE_ITEMS = Object.freeze(['acceptance', 'merged', 'pendingDelivery', 'humanConfirmed']);

/**
 * 每一项在"通过"时意味着什么。写在代码里而不是注释里：报告要能解释"为什么这一项算过"。
 * 注意 `pendingDelivery` 的极性与其余三项相反——它是一个**事实**（还有没有未完成的交付），
 * 不是结论；极性写错会让"有未完成交付"被判成通过。
 */
export const CLOSE_EXPECTATIONS = Object.freeze({
  acceptance: '验收通过',
  merged: 'PR 已合入',
  pendingDelivery: '无未完成交付',
  humanConfirmed: '人工确认（针对当前 commit）',
});

/** 每项判定的三态。`unknown` 不计入通过（取不到证据不等于通过）。 */
export const CLOSE_STATUSES = Object.freeze(['passed', 'failed', 'unknown']);

/** 证据来源类型：报告要能说明"这条结论是谁说的"。 */
export const CLOSE_SOURCE_TYPES = Object.freeze([
  'cli',
  'plugin',
  'ci',
  'uat',
  'human',
  'model',
  'mock',
  'caller-declared',
  'unknown',
]);

/** 关闭判定的拒绝/缺项码。 */
export const CLOSE_REASONS = Object.freeze({
  CRITERION_NOT_PASSED: 'CRITERION_NOT_PASSED',
  PENDING_DELIVERY: 'PENDING_DELIVERY',
  HUMAN_CONFIRMATION_REQUIRED: 'HUMAN_CONFIRMATION_REQUIRED',
  STALE_CONFIRMATION: 'STALE_CONFIRMATION',
  EVIDENCE_UNAVAILABLE: 'CLOSE_EVIDENCE_UNAVAILABLE',
  INVALID_CRITERION: 'CLOSE_INVALID_CRITERION',
  INVALID_CHANGE_ID: 'CLOSE_INVALID_CHANGE_ID',
  INVALID_COMMIT: 'CLOSE_INVALID_COMMIT',
});

/** 边界说明：只判定不关闭（与 devops 的 `CLOSE_READINESS_NOTE` 同口径）。 */
export const CLOSE_NOTE = '只判定关闭就绪性；关闭动作需人工确认后由人执行（`close`/`merge` 不在 gitee 白名单）。';

/** 判定结果的整体状态：`ready` 才可能被人工执行关闭；`unknown` 表示证据没到位。 */
export const CLOSE_STATUS_VALUES = Object.freeze(['ready', 'blocked', 'unknown']);

/**
 * 判定需要读的**事实**（由适配器/工具层去取，本模块不构造命令）。
 * `stale` 的审查记录不能作为 `humanConfirmed` 的依据——那条规则在 `evaluateHuman` 里执行。
 */
export const DELIVERY_READ_INTENTS = Object.freeze({
  PR_MERGE_STATE: 'pr-merge-state',
  PR_HEAD_BASE: 'pr-head-base',
  ACCEPTANCE: 'acceptance',
  HUMAN_REVIEW: 'human-review',
});

/** 允许出现的命令动词：只有读。 */
export const DELIVERY_ALLOWED_VERBS = Object.freeze(['view', 'list']);

/** 显式禁掉的动词：写动作一律不在本模块能力范围内。 */
export const DELIVERY_FORBIDDEN_VERBS = Object.freeze([
  'close',
  'reopen',
  'merge',
  'approve',
  'edit',
  'create',
  'comment',
  'delete',
  'push',
  'rebase',
  'label',
  'milestone',
  'release',
]);

/** 结构性错误（入参本身不成立）：证据缺口的正常形态是 `unknown`，不抛错。 */
export class DeliveryError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'DeliveryError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 提交信息不合规（AC-18）：`code` 即拒绝原因，`expectedFormat` 是给人照着改的那句话。
 *
 * 做成**异常**（而不是只返回 `{ok:false}`）是因为调用方（`gitee-actions` 的动作体）用
 * `try/catch` 判定"这次提交不许放行"——返回对象会被它当成通过，门禁静默失效；
 * 同时把 `ok/reason/expectedFormat/detail` 挂在异常上，需要对象形态的调用方直接读字段即可。
 */
export class CommitMessageError extends DeliveryError {
  constructor({ reason, expectedFormat, detail }) {
    super(reason, detail, { expectedFormat });
    this.name = 'CommitMessageError';
    this.reason = reason;
    this.expectedFormat = expectedFormat;
    this.ok = false;
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u;

/** 证据文字：单行、限长（判定结果会进工具返回体，不把整段输入原样回显）。 */
function evidenceText(value) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** 期望格式：给人看的同一句话，测试与提示共用（不各写一份）。 */
export function expectedCommitFormat(changeId) {
  return `[${text(changeId) || '<变更号>'}] 一句话说明`;
}

/**
 * 校验提交信息首行是否以**本变更号**为前缀（AC-18）。
 *
 * 规则（与 devops 同源）：首行 `[<本变更号>]` + 至少一个空白 + 非空描述；方括号里写别的变更号
 * 同样拒绝（避免把改动记到另一个需求名下）。只认首行——git 的 subject 就是首行，正文多行不校验。
 * **不改写 message**：返回值里没有任何替换后的提交信息，只有一个 `subject` 供调用方自己决定。
 *
 * @param {{ changeId?: string, change?: string, message?: string }} input
 * @returns {{ ok: true, changeId: string, expectedFormat: string, subject: string }}
 * @throws {CommitMessageError} 不合规：`code` = 拒绝原因，`expectedFormat` = 期望格式
 */
export function assertCommitMessage(input = {}) {
  const result = evaluateCommitMessage(input);
  if (!result.ok) throw new CommitMessageError(result);
  return result;
}

/**
 * `assertCommitMessage` 的不抛错形态：给"想先看结论再决定要不要拦"的调用方用，
 * 结论与抛错形态**同源**（同一个判定函数），不会出现一处放过一处拦住。
 *
 * @param {{ changeId?: string, change?: string, message?: string }} input
 * @returns {{ ok: true, changeId: string, expectedFormat: string, subject: string }
 *   | { ok: false, reason: string, expectedFormat: string, detail: string }}
 */
export function verifyCommitMessage(input = {}) {
  return evaluateCommitMessage(input);
}

/**
 * `assertCommitMessage` 的判定本体（不抛错的内部形态）：每个拒绝理由都带期望格式，
 * 测试与异常构造共用同一份文字。
 */
function evaluateCommitMessage({ changeId, change, message } = {}) {
  const id = text(changeId) || text(change);
  const expectedFormat = expectedCommitFormat(id);
  if (id === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.MISSING_CHANGE_ID,
      expectedFormat,
      detail: '没有变更号：无法确认这条提交属于哪个需求，拒绝（并给不出期望格式里的具体号）',
    };
  }
  if (!CHANGE_ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason: COMMIT_REASONS.INVALID_CHANGE_ID,
      expectedFormat,
      detail: `变更号「${id}」不是合法格式（字母或数字开头，只含字母/数字/下划线/连字符，2–64 位）`,
    };
  }
  if (typeof message !== 'string' || message.trim() === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.MISSING_MESSAGE,
      expectedFormat,
      detail: `提交信息为空（${typeof message === 'string' ? '仅空白' : typeof message}）`,
    };
  }

  // 只剥掉首部空行：带空行开头的提交信息仍按"首行无前缀"拒绝，不替调用方整理格式。
  const subject = message.replace(/^(?:[ \t]*\r?\n)+/u, '').split(/\r?\n/u)[0].trimEnd();
  const matched = /^\[([^\]]*)\]([ \t\u3000]*)([\s\S]*)$/u.exec(subject);
  if (matched === null) {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `首行必须以 \`[${id}]\` 开头，当前首行：${subject === '' ? '（空）' : evidenceText(subject)}`,
    };
  }
  const found = matched[1];
  // 方括号内容逐字比较（不 trim）：`[ CHG-2026-0042 ]` 这类空白错误要显出来，否则前缀看着对、
  // 抄进日志却对不上变更号。
  if (found === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `首行的方括号是空的：必须写本变更号 ${id}`,
    };
  }
  if (found.toUpperCase() !== id.toUpperCase()) {
    return {
      ok: false,
      reason: COMMIT_REASONS.PREFIX_MISSING,
      expectedFormat,
      detail: `方括号内是本变更号之外的值：${evidenceText(found)}（应为 ${id}）`,
    };
  }
  if (matched[2] === '' || matched[3].trim() === '') {
    return {
      ok: false,
      reason: COMMIT_REASONS.DESCRIPTION_MISSING,
      expectedFormat,
      detail: `前缀后必须接空格与非空描述，当前首行：${evidenceText(subject)}`,
    };
  }
  return { ok: true, changeId: id, expectedFormat, subject: evidenceText(matched[3]) };
}

/* ------------------------------------------------------------------ 关闭判定 */

const statusOf = (value) => {
  const status = text(value).toLowerCase();
  return status === 'passed' || status === 'failed' || status === 'unknown' ? status : null;
};

/** 标记"这一项没证据"：`unknown` + 原因，而不是猜一个通过。 */
function unavailable(detail) {
  return {
    status: 'unknown',
    reason: CLOSE_REASONS.EVIDENCE_UNAVAILABLE,
    evidence: detail,
    sourceType: 'unknown',
  };
}

/**
 * 单个条件的归一化判定。
 *
 * 入参两种写法都收：**结论**（`true`/`false`/`'passed'`/`'merged'`/`{status}`）与**事实**
 * （`{count}`/`{prs}`/`{decision}`）。不认识的写法一律 `unknown`——判定器不替调用方翻译含义。
 */
function evaluateCriterion(item, raw, currentCommit = null) {
  if (raw === undefined || raw === null) return unavailable(`未提供「${CLOSE_EXPECTATIONS[item]}」的证据（CI/UAT 取不到时按 unknown，不计入通过）`);
  if (raw === 'unknown') return unavailable(`调用方明确标 unknown：「${CLOSE_EXPECTATIONS[item]}」没有可用证据`);

  if (typeof raw === 'boolean') {
    if (item === 'pendingDelivery') {
      // 事实项：true = 还有未完成交付 → 不通过。
      return raw
        ? { status: 'failed', reason: CLOSE_REASONS.PENDING_DELIVERY, evidence: '仍有未完成的交付项', sourceType: 'caller-declared' }
        : { status: 'passed', evidence: '没有未完成的交付项', sourceType: 'caller-declared' };
    }
    return raw
      ? { status: 'passed', evidence: `调用方声明：${CLOSE_EXPECTATIONS[item]}`, sourceType: 'caller-declared' }
      : { status: 'failed', reason: CLOSE_REASONS.CRITERION_NOT_PASSED, evidence: `调用方声明：${CLOSE_EXPECTATIONS[item]} 未成立`, sourceType: 'caller-declared' };
  }

  if (typeof raw === 'number') {
    if (item !== 'pendingDelivery') return unavailable(`「${CLOSE_EXPECTATIONS[item]}」不接受数字证据：${raw}`);
    return raw > 0
      ? { status: 'failed', reason: CLOSE_REASONS.PENDING_DELIVERY, evidence: `未完成交付 ${raw} 项`, sourceType: 'caller-declared' }
      : { status: 'passed', evidence: '未完成交付 0 项', sourceType: 'caller-declared' };
  }

  if (Array.isArray(raw)) {
    if (item !== 'pendingDelivery') return unavailable(`「${CLOSE_EXPECTATIONS[item]}」不接受数组证据`);
    return raw.length > 0
      ? {
          status: 'failed',
          reason: CLOSE_REASONS.PENDING_DELIVERY,
          evidence: `未完成交付 ${raw.length} 项：${raw.slice(0, 3).map((entry) => evidenceText(typeof entry === 'string' ? entry : asObject(entry).ref ?? asObject(entry).title ?? '')).filter(Boolean).join(' / ') || '（未命名）'}`,
          sourceType: 'caller-declared',
        }
      : { status: 'passed', evidence: '未完成交付 0 项', sourceType: 'caller-declared' };
  }

  const source = asObject(raw);
  const sourceType = text(source.sourceType) || text(source.source) || text(source.from) || 'caller-declared';
  const declared = statusOf(source.status) ?? statusOf(source.state) ?? statusOf(source.verdict?.status ?? source.verdict);
  const flag = typeof source.ok === 'boolean' ? source.ok : typeof source.passed === 'boolean' ? source.passed : undefined;
  const evidence = evidenceText(source.evidence) || evidenceText(source.detail) || '';

  if (item === 'humanConfirmed') return evaluateHuman(raw, source, sourceType, declared, evidence, currentCommit);

  if (item === 'pendingDelivery') {
    const count = Number.isInteger(source.count) ? source.count : Array.isArray(source.items) ? source.items.length : undefined;
    if (count !== undefined) {
      return count > 0
        ? { status: 'failed', reason: CLOSE_REASONS.PENDING_DELIVERY, evidence: evidence || `未完成交付 ${count} 项`, sourceType }
        : { status: 'passed', evidence: evidence || '未完成交付 0 项', sourceType };
    }
  }

  if (declared !== null) {
    if (declared === 'unknown') return unavailable(evidence || `调用方标 unknown：「${CLOSE_EXPECTATIONS[item]}」`);
    if (declared === 'passed') return { status: 'passed', evidence: evidence || `调用方声明：${CLOSE_EXPECTATIONS[item]}`, sourceType };
    return { status: 'failed', reason: CLOSE_REASONS.CRITERION_NOT_PASSED, evidence: evidence || `调用方声明：${CLOSE_EXPECTATIONS[item]} 未成立`, sourceType };
  }
  if (flag !== undefined) {
    return flag
      ? { status: 'passed', evidence: evidence || `调用方声明：${CLOSE_EXPECTATIONS[item]}`, sourceType }
      : { status: 'failed', reason: CLOSE_REASONS.CRITERION_NOT_PASSED, evidence: evidence || `调用方声明：${CLOSE_EXPECTATIONS[item]} 未成立`, sourceType };
  }
  if (text(source.value) !== '' || typeof source.value === 'boolean' || typeof source.value === 'number') {
    const nested = evaluateCriterion(item, source.value, currentCommit);
    return { ...nested, sourceType, evidence: evidence || nested.evidence };
  }
  return unavailable(`「${CLOSE_EXPECTATIONS[item]}」的证据写法无法识别（需要 status/ok/count/decision/value）`);
}

/**
 * 人工确认项：唯一会因为 **sha 变化**而翻成不通过的条件（AC-20「`stale` 不得作为通过依据」）。
 *
 * `commit`（别名 `forCommit` / `confirmedAtCommit`）在这里是"确认针对哪个 sha"，与判定入口的
 * "当前 commit"分开传：混成一个参数就只能靠猜它在说哪一个。判定知道当前 commit、却拿不到确认
 * 绑定的 sha 时给 `unknown`——无法证明确认不是针对旧版本，就不能算通过。
 */
function evaluateHuman(raw, source, sourceType, declared, evidence, currentCommit) {
  const humanSource = sourceType === 'caller-declared' ? 'human' : sourceType;
  const decision = text(source.decision) || text(source.conclusion) || (typeof raw === 'string' ? text(raw) : '');
  const boundCommit = text(source.commit) || text(source.forCommit) || text(source.confirmedAtCommit) || null;

  if (source.stale === true || decision === 'stale') {
    return {
      status: 'failed',
      reason: CLOSE_REASONS.STALE_CONFIRMATION,
      evidence: evidence || '人工确认针对的 commit 已变化（stale）：不得作为通过依据，需按当前 commit 重新确认',
      sourceType: humanSource,
    };
  }
  if (decision === 'unknown') return unavailable(evidence || '调用方标 unknown：人工确认没有可用证据');

  const positive = decision === 'confirmed' || declared === 'passed' || source.ok === true || source.passed === true;
  if (positive) {
    if (currentCommit === null) {
      return { status: 'passed', evidence: evidence || `人工确认（${CLOSE_EXPECTATIONS.humanConfirmed}）`, sourceType: humanSource };
    }
    if (boundCommit === null) {
      return unavailable('人工确认未绑定 commit sha：判定已知当前 commit，无法证明确认不是针对旧版本（按 unknown 处理）');
    }
    if (reviewStaleness({ commit: boundCommit }, currentCommit) === 'stale') {
      return {
        status: 'failed',
        reason: CLOSE_REASONS.STALE_CONFIRMATION,
        evidence: `人工确认针对 ${boundCommit}，与当前 commit ${currentCommit} 不一致（stale）`,
        sourceType: 'human',
      };
    }
    return { status: 'passed', evidence: evidence || `人工确认针对 ${boundCommit}（与当前 commit 一致）`, sourceType: humanSource };
  }

  if (decision !== '' || declared === 'failed' || source.ok === false || source.passed === false) {
    return {
      status: 'failed',
      reason: CLOSE_REASONS.HUMAN_CONFIRMATION_REQUIRED,
      evidence: evidence || `最近一次人工结论：${evidenceText(decision) || '未确认'}（不是 confirmed）`,
      sourceType: humanSource,
    };
  }
  return unavailable('人工确认项需要 decision（confirmed/changes-requested/rejected）或 status');
}

/** 从 `review.md` 记录里取人工确认：显式条件优先，其次是 review 记录。 */
function humanFromReview(review, commit) {
  const entries = asArray(asObject(review).humanColumn).map(asObject);
  if (entries.length === 0) {
    return {
      status: 'failed',
      reason: CLOSE_REASONS.HUMAN_CONFIRMATION_REQUIRED,
      evidence: 'review.md 人工确认栏为空：尚无人工确认',
      sourceType: 'plugin',
    };
  }
  const last = entries[entries.length - 1];
  const decision = text(last.decision);
  if (decision !== 'confirmed') {
    return {
      status: 'failed',
      reason: CLOSE_REASONS.HUMAN_CONFIRMATION_REQUIRED,
      evidence: `最近一次人工结论：${evidenceText(decision) || '（空）'}（不是 confirmed）`,
      sourceType: 'human',
    };
  }
  if (commit !== null && reviewStaleness({ commit: last.commit }, commit) === 'stale') {
    return {
      status: 'failed',
      reason: CLOSE_REASONS.STALE_CONFIRMATION,
      evidence: `人工确认针对 ${text(last.commit)}，与当前 commit ${commit} 不一致（stale）`,
      sourceType: 'human',
    };
  }
  return {
    status: 'passed',
    evidence: `人工确认：${text(last.by) || '（缺确认人）'} @ ${text(last.at) || '（缺时间）'}（commit ${text(last.commit)}）`,
    sourceType: 'human',
  };
}

/**
 * 关闭条件四项判定（AC-21）。**只判定、不执行**：没有任何关闭/合并通道，`executed` 恒为 `false`。
 *
 * 极性约定（写在这里，避免"有未完成交付"被判成通过）：
 * - `acceptance` / `merged` / `humanConfirmed`：`true` = 该条件成立。
 * - `pendingDelivery`：`true`（或 `count>0`、非空数组）= **还有**未完成交付 → 不通过。
 *
 * 证据缺口的正常形态是 `unknown`（CI/UAT 取不到），**`unknown` 不计入通过**，整体状态降为
 * `unknown` 而不是 `blocked`：分不清"没做"与"没证据"会把报告说成事实。
 *
 * @param {{ criteria?: object, changeId?: string, commit?: string, review?: object, at?: string }} input
 * @returns {object} `{kind, provider, changeId, commit, status, ready, items, blocking, unknown, executed, note, judgedAt}`
 */
export function judgeCloseReadiness({ criteria, changeId, commit, review, at } = {}) {
  // 变更号是**可选**的：调用方（`gitee.delivery.judge`）可能只传四项条件来找"还差什么"。
  // 给了就必须合法——判定结果要能对上需求，写错的号不能当没写。
  const declaredId = text(changeId) || text(asObject(criteria).changeId) || text(asObject(review).changeId);
  const id = declaredId === '' ? null : declaredId;
  if (id !== null && !CHANGE_ID_PATTERN.test(id)) {
    throw new DeliveryError(
      CLOSE_REASONS.INVALID_CHANGE_ID,
      `变更号「${id}」不是合法格式（字母或数字开头，只含字母/数字/下划线/连字符，2–64 位）`,
      { changeId: id },
    );
  }
  const head = text(commit) || text(asObject(review).commit);
  if (head !== '' && !SHA_PATTERN.test(head.toLowerCase())) {
    throw new DeliveryError(CLOSE_REASONS.INVALID_COMMIT, `commit 必须是 7–40 位十六进制 sha：${head}`, { commit: head });
  }
  const currentCommit = head === '' ? null : head.toLowerCase();
  const input = asObject(criteria);

  const items = CLOSE_ITEMS.map((item) => {
    const raw = input[item];
    // 人工确认：显式条件优先；没给就退回 review.md 的人工栏（判定器不替调用方编一个确认）。
    // 布尔 `true` 是"调用方声明"，在不知道当前 commit 时按声明收下；知道当前 commit 时它没有绑定
    // sha，无法排除"针对旧版本"，降为 unknown——AC-20「`stale` 不得作为通过依据」。
    let verdict;
    if (item === 'humanConfirmed' && raw === undefined && review !== undefined) {
      verdict = humanFromReview(review, currentCommit);
    } else if (item === 'humanConfirmed' && raw === true && currentCommit !== null) {
      verdict = unavailable('人工确认只有布尔 true：判定已知当前 commit，但该声明未绑定 sha，无法排除 stale（按 unknown）');
    } else {
      verdict = evaluateCriterion(item, raw, currentCommit);
    }
    const declaredSource = text(asObject(raw).sourceType) || text(asObject(raw).source);
    const sourceType = CLOSE_SOURCE_TYPES.includes(declaredSource)
      ? declaredSource
      : CLOSE_SOURCE_TYPES.includes(verdict.sourceType)
        ? verdict.sourceType
        : 'unknown';
    return Object.freeze({
      item,
      // `key` 是同一件事的别名：动作层（`gitee-actions`）用 `key` 回填"哪些项缺证据"，
      // 两个名字都留着，免得消费方为了取一个标识去猜字段名。
      key: item,
      expectation: CLOSE_EXPECTATIONS[item],
      status: CLOSE_STATUSES.includes(verdict.status) ? verdict.status : 'unknown',
      evidence: evidenceText(verdict.evidence) || '（无证据）',
      sourceType,
      reason: verdict.reason ?? null,
    });
  });

  const blocking = items.filter((entry) => entry.status === 'failed').map((entry) => entry.item);
  const unknown = items.filter((entry) => entry.status === 'unknown').map((entry) => entry.item);
  const status = blocking.length > 0 ? 'blocked' : unknown.length > 0 ? 'unknown' : 'ready';
  const ready = status === 'ready';

  return Object.freeze({
    kind: 'close-readiness',
    provider: 'gitee',
    changeId: id,
    commit: currentCommit,
    status,
    ready,
    items: Object.freeze(items),
    blocking: Object.freeze(blocking),
    unknown: Object.freeze(unknown),
    // 只判定：这两个字段是"不执行"的运行时证据，不是装饰。
    executed: false,
    note: CLOSE_NOTE,
    judgedAt: text(at) || null,
  });
}
