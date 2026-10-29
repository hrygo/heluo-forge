/**
 * 三个平台写动作 + 两个受控判定动作的四状态机（AC-16 / AC-17）。
 *
 * ## 状态机（每个写动作都走同一条，没有第二条路）
 *
 * ```
 * 入参校验 → 幂等台账(done 复用 / unknown 不重放) → 门禁 admission → 确认（门禁内）
 *   → preflight（令牌/持久凭据，零子进程）→ invoke（唯一 execFile 出口）
 *   → 回读（只读动作，核对写进去的东西）→ 台账登记 → done | failed | denied | unknown
 * ```
 *
 * 四条硬规矩：
 * 1. **`done` 必须"成功 + 回读一致"**。退出码 0 只说明命令跑了，不说明写到了哪里；没有
 *    回读或回读对不上，一律降格 `unknown`（AC-16）。
 * 2. **`unknown` 不重放**。超时、非零退出、畸形输出、回读不一致都可能已经落地；台账记
 *    `unknown`，下次命中直接 `replay_blocked`，零子进程（重复建单比"没做成"更贵）。
 * 3. **`failed` 才是确定没生效**（preflight 拒绝、命令未启动），所以它可以重试，也不写台账。
 * 4. **默认禁用靠门禁**。五个动作在分发目录里不登记 → 门禁 `denied`（`unregistered-action`），
 *    本文件一行都不执行，适配器与 `execFile` 0 次调用（AC-17）。
 *
 * ## 与 r1 的关系
 *
 * 不复用 `forge-devops` 的源码（PRD 非目标），但语义必须对齐：幂等键公式、四状态名、
 * "确认 = repo + object 逐字相符"、`unknown` 不重放。漂移由测试守：`test/session.test.mjs`
 * 锁住幂等键向量，`test/actions.test.mjs` 锁住四状态矩阵与"唯一准入点"静态不变量。
 *
 * ## 审查与交付的语义在哪
 *
 * `review_record` / `delivery_gate` 的模型与判定在 `gitee-review.mjs` / `gitee-delivery.mjs`
 * （TK6）。本模块只做**门禁 + 归一**，并且**惰性加载**那两个模块：装配期（AC-6 的 import
 * 探针、`--dump-config`）不该因为一个只有调用时才用到的语义模块而整体不可加载；默认目录下
 * 这两个工具压根到不了加载那一步（未登记即 `denied`）。
 */
import { createHash } from 'node:crypto';
import { GITEE_COMMANDS, GITEE_PROVIDER } from './gitee-adapter.mjs';
import { GUARD_REASONS } from './gitee-guard.mjs';
import { REPLAY_BLOCKED_STATUSES, buildEvidence, idempotencyKey } from './gitee-session.mjs';

/** 五个受控动作（名字即策略目录里的 `action`，也是审计里的一等公民）。 */
export const GITEE_ACTIONS = Object.freeze({
  ISSUE_WRITE: 'gitee.issue.write',
  PR_WRITE: 'gitee.pr.write',
  REVIEW_PUBLISH: 'gitee.review.publish',
  REVIEW_RECORD: 'gitee.review.record',
  DELIVERY_JUDGE: 'gitee.delivery.judge',
});

/** 平台动作状态；顺序即文档顺序（`done`/`failed`/`denied`/`unknown`），不含任何流程态。 */
export const ACTION_STATUSES = Object.freeze(['done', 'failed', 'denied', 'unknown']);

/** 幂等键的对象类型词表（同一变更下的不同对象必须落不同的键）。 */
export const GITEE_OBJECT_TYPES = Object.freeze({
  ISSUE: 'issue',
  PR: 'pull-request',
  ISSUE_COMMENT: 'issue-comment',
  PR_COMMENT: 'pr-comment',
  REVIEW: 'review',
  DELIVERY: 'delivery',
});

/** 动作层原因码（固定枚举；自由文本只进 `detail`）。 */
export const ACTION_REASONS = Object.freeze({
  MISSING_ARGUMENT: 'MISSING_ARGUMENT',
  MISSING_TARGET: 'MISSING_TARGET',
  INVALID_TARGET: 'INVALID_TARGET',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CONFIRMATION_REQUIRED: GUARD_REASONS.CONFIRMATION_REQUIRED,
  HUMAN_CONFIRMATION_FORBIDDEN: 'HUMAN_CONFIRMATION_FORBIDDEN',
  AUTH_MISSING: 'AUTH_MISSING',
  PERSISTENT_TOKEN: 'GITEE_PERSISTENT_TOKEN',
  REPLAY_BLOCKED: 'REPLAY_BLOCKED',
  READBACK_MISMATCH: 'READBACK_MISMATCH',
  READBACK_UNAVAILABLE: 'READBACK_UNAVAILABLE',
  MALFORMED_RESULT: 'MALFORMED_RESULT',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  COMMAND_FAILED: 'COMMAND_FAILED',
  SPAWN_FAILED: 'SPAWN_FAILED',
  REVIEW_INVALID: 'REVIEW_INVALID',
  COMMIT_MESSAGE_INVALID: 'COMMIT_MESSAGE_INVALID',
  DELIVERY_UNAVAILABLE: 'DELIVERY_UNAVAILABLE',
  MODULE_UNAVAILABLE: 'MODULE_UNAVAILABLE',
  DISPOSED: 'GITEE_STATUS_DISPOSED',
  INTERNAL: 'INTERNAL',
});

/** 工具名（与 `gitee-tools.mjs` 的 `GITEE_WRITE_TOOLS` 同名同序，装配期由那张表校验）。 */
const TOOL_NAMES = Object.freeze({
  ISSUE_WRITE: 'forge_gitee_issue_write',
  PR_WRITE: 'forge_gitee_pr_write',
  REVIEW_PUBLISH: 'forge_gitee_review_publish',
  REVIEW_RECORD: 'forge_gitee_review_record',
  DELIVERY_GATE: 'forge_gitee_delivery_gate',
});

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 工作项引用：`owner/name#12` 或 `owner/name!12`（`!` 是工具面对 PR 的写法，见 `refForCli`）。 */
const QUALIFIED_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)[#!](\d{1,9})$/u;
/** 写命令输出里可能是可回读对象的链接（Issue 的 id 在 Gitee 上可能不是纯数字，一并认）。 */
const OBJECT_LINK_PATTERN = /https?:\/\/[^\s<>"'`]+\/(?:issues|issue|pulls|pull)\/[A-Za-z0-9_-]+/u;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u;
const TRAILING_PUNCTUATION = /[.。,，;；:：!！?？、]+$/u;
/** 回读里的"评论数"字段：Gitee 侧叫 `comments`，拿不到就不猜（降 `unknown`）。 */
const COMMENTS_FIELD = 'comments';

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const describeError = (error) => text(error?.message) || text(error?.code) || '未知错误';
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * 写工具的 `output` 声明（D-1）：宿主 `tools.register()` 对**每个**工具都要求
 * `output.render` 是函数（`tool "<name>" must declare output { schema, render }`），缺一个
 * 就整条 entry 不激活、连读工具一起消失。形状与 `gitee-read.mjs` 的读工具逐字一致：
 * `schema` 只写宿主支持的 `{ type: 'object' }`，渲染把工具返回的信封原样转成文本块。
 */
const WRITE_TOOL_OUTPUT = Object.freeze({
  schema: Object.freeze({ type: 'object' }),
  render: (_args, value) => json(value).content,
});

/** 标题归一化（与 r1 同式）：只用于"是不是同一个对象"，不改变写出去的标题。 */
function normalizeTitle(title) {
  return (typeof title === 'string' ? title : '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

/** 空标题永远不算命中（否则会把"没有标题"的对象当成复用对象）。 */
function sameTitle(candidate, expected) {
  const left = normalizeTitle(candidate);
  return left !== '' && left === normalizeTitle(expected);
}

/**
 * 正文摘要：评论类幂等键用它（`\r\n` 归一、大小写敏感）。
 *
 * 与 `gitee-session.mjs` 的 `idempotencyKey` 用同一套 sha256：评论没有"标题"，
 * 用"正文指纹"代替，才既不会把重复评论当新评论、也不会把两条不同评论并成一条。
 */
function bodyDigest(body) {
  const normalized = typeof body === 'string' ? body.normalize('NFKC').replace(/\r\n/gu, '\n').trim() : '';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 动作信封（唯一形状）。
 *
 * `evidence` 只在**真的执行过命令**或**从台账复用**时出现：被拒的动作没有证据，
 * 留一个 `null` 会被误读成"执行过但没证据"，所以被拒时这个字段根本不出现。
 */
function actionResult({
  tool,
  action,
  status,
  target,
  objectRef = null,
  reason = null,
  rule = null,
  detail = null,
  reused = false,
  replayBlocked = false,
  key = null,
  readback,
  evidence,
  remoteCalls = 0,
} = {}) {
  return {
    ok: status === 'done',
    provider: GITEE_PROVIDER,
    tool,
    action,
    status,
    target,
    object_ref: objectRef,
    reason,
    rule,
    detail,
    idempotency_key: key,
    reused,
    replay_blocked: replayBlocked,
    readback,
    evidence,
    remote_calls: remoteCalls,
  };
}

/** 入参不成立：门禁都还没问，适配器零调用。 */
function denyInput(spec, reason, detail, { target = '', key = null } = {}) {
  return actionResult({
    tool: spec.tool,
    action: spec.action,
    status: 'denied',
    target,
    reason,
    rule: 'argument-invalid',
    detail,
    key,
  });
}

/** 内部错误（含 TK6 模块缺失）：确定没走通，按 `failed` 报，不假装成功。 */
class GiteeActionError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'GiteeActionError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** `owner/name!12` → `owner/name#12`：工具面用 `!` 区分 PR，CLI 的限定引用只认 `#`。 */
function refForCli(target) {
  return target.replace('!', '#');
}

/**
 * 写命令输出的可回读引用。
 *
 * 写命令没有 `--json`（输出是人类文本），所以只能从输出里取链接与编号；两者都取不到就是
 * **畸形结果**，只能 `unknown`——绝不能因为"退出码 0"就当写成功了。
 */
function parseCreatedRef(stdout, repo) {
  const raw = typeof stdout === 'string' ? stdout : '';
  const link = OBJECT_LINK_PATTERN.exec(raw)?.[0] ?? '';
  const qualified = QUALIFIED_PATTERN.exec(link);
  const tail = link === '' ? '' : (link.split('/').pop() ?? '');
  const number = /^\d{1,9}$/u.test(tail) ? Number.parseInt(tail, 10) : null;
  if (link !== '') {
    return {
      ref: number === null ? link : `${repo}#${number}`,
      link,
      number,
    };
  }
  if (qualified !== null) {
    return { ref: `${qualified[1]}#${qualified[2]}`, link: '', number: Number.parseInt(qualified[2], 10) };
  }
  return null;
}

/** 适配器错误 → 四状态分类：**只有确定没启动**才记 `failed`，其余一律 `unknown`。 */
function classifyCommandError(error, what) {
  const detail = isPlainObject(error?.detail) ? error.detail : {};
  const code = text(error?.code) || ACTION_REASONS.COMMAND_FAILED;
  const message = describeError(error);
  if (detail.timedOut === true) {
    return {
      status: 'unknown',
      reason: ACTION_REASONS.COMMAND_TIMEOUT,
      rule: 'command-timeout',
      detail: `${what}超时，写入可能已发生，转人工核对（不自动重放）：${message}`,
    };
  }
  if (code === 'SPAWN_FAILED') {
    return {
      status: 'failed',
      reason: ACTION_REASONS.SPAWN_FAILED,
      rule: 'spawn-failed',
      detail: `${what}命令未启动（无副作用）：${message}`,
    };
  }
  if (detail.mayHaveSideEffect === true) {
    return {
      status: 'unknown',
      reason: code,
      rule: 'command-uncertain',
      detail: `${what}结果不确定，转人工核对（不自动重放）：${message}`,
    };
  }
  return { status: 'failed', reason: code, rule: 'command-failed', detail: `${what}失败：${message}` };
}

function requireService(service) {
  if (service === null || typeof service !== 'object') {
    throw new TypeError('gitee 写动作需要 service（门禁唯一准入点），不允许直接调适配器');
  }
  for (const member of ['execute', 'invoke', 'preflight', 'adapter', 'session']) {
    if (typeof service[member] !== 'function') {
      throw new TypeError(`gitee 写动作需要 service.${member}()：缺少即拒绝执行（不降级绕过门禁）`);
    }
  }
  return service;
}

/**
 * 一次写动作的完整流程（唯一实现，三个平台动作共用）。
 *
 * @param {object} service 插件服务端口（`index.mjs` 的 `createService`）
 * @param {object} spec `{ tool, action, target, objectType, title, confirm, command, params, readback }`
 * @returns {Promise<object>} 动作信封
 */
async function executeWrite(service, spec) {
  const session = service.session();
  const { tool, action, target, objectType, title, confirm, command, params, readback } = spec;
  const key = idempotencyKey({ change: spec.change, objectType, title });

  // 台账先看：命中的两种结果都不该再碰门禁与子进程。
  const prior = session.lookup(key);
  if (prior !== undefined) {
    if (prior.status === 'done') {
      return actionResult({
        tool,
        action,
        status: 'done',
        target: prior.target ?? target,
        objectRef: prior.objectRef,
        reused: true,
        key,
        detail: '同一变更的同一对象已经写过（幂等命中），复用既有结果，未再触碰远端',
        readback: { via: 'session-ledger', ok: true, reused_of: key },
        evidence: prior.evidence ?? undefined,
      });
    }
    if (REPLAY_BLOCKED_STATUSES.includes(prior.status)) {
      return actionResult({
        tool,
        action,
        status: 'unknown',
        target: prior.target ?? target,
        objectRef: prior.objectRef,
        reason: ACTION_REASONS.REPLAY_BLOCKED,
        rule: 'replay-blocked',
        detail: '上一次的结果不确定（可能已落地），按 AC-16 转人工核对，不重放',
        replayBlocked: true,
        key,
        readback: { via: 'session-ledger', ok: false, blocked_of: prior.status },
        evidence: prior.evidence ?? undefined,
      });
    }
  }

  let verdict;
  try {
    verdict = await service.execute({
      action,
      target,
      tool,
      confirm,
      payload: {
        // 策略只看业务坐标（目标 + 动作），正文不进审计摘要。
        arguments: { target, change: spec.change, op: spec.op },
        run: async () => runWrite(service, spec),
      },
    });
  } catch (error) {
    const denied = error?.denied === true;
    return actionResult({
      tool,
      action,
      status: denied ? 'denied' : 'failed',
      target,
      reason: text(error?.code) || ACTION_REASONS.INTERNAL,
      rule: denied ? 'service-refused' : 'internal-error',
      detail: describeError(error),
      key,
    });
  }

  if (!isPlainObject(verdict) || text(verdict.status) !== 'done') {
    const status = text(verdict?.status) === 'failed' && verdict?.mayHaveSideEffect === true
      ? 'unknown'
      : (text(verdict?.status) === 'denied' ? 'denied' : 'failed');
    const promoted = status === 'unknown' && text(verdict?.status) !== 'unknown';
    // 有副作用痕迹的失败升格 `unknown` 并写台账：下次不许重放。
    if (status === 'unknown') {
      session.record({ key, status: 'unknown', action, target, evidence: undefined });
    }
    return actionResult({
      tool,
      action,
      status,
      target,
      reason: text(verdict?.reason) || ACTION_REASONS.INTERNAL,
      rule: text(verdict?.rule) || (promoted ? 'possibly-landed' : 'guard-failed'),
      detail: text(verdict?.detail) || null,
      replayBlocked: status === 'unknown',
      key,
      readback: status === 'unknown' ? { via: 'guard', ok: false } : undefined,
    });
  }

  const produced = isPlainObject(verdict.value) ? verdict.value : null;
  if (produced === null || !ACTION_STATUSES.includes(text(produced.status))) {
    session.record({ key, status: 'unknown', action, target, evidence: undefined });
    return actionResult({
      tool,
      action,
      status: 'unknown',
      target,
      reason: ACTION_REASONS.INTERNAL,
      rule: 'malformed-outcome',
      detail: '门禁已放行但下游没有返回可识别的动作状态，无法核对（不重放）',
      replayBlocked: true,
      key,
      readback: { via: 'service', ok: false },
    });
  }

  // 台账登记放在这里（门禁裁决之后、唯一一处）：`done` 可复用，`unknown` 阻断重放，
  // `failed`（确定未生效）不写台账，于是"重试"永远不会被自己的失败记录挡住。
  if (produced.status === 'done' || produced.status === 'unknown') {
    session.record({
      key,
      status: produced.status,
      action,
      target: produced.target ?? target,
      objectRef: produced.object_ref ?? null,
      evidence: produced.evidence ?? undefined,
    });
  }

  return actionResult({
    tool,
    action,
    status: produced.status,
    target: produced.target ?? target,
    objectRef: produced.object_ref ?? null,
    reason: produced.reason ?? null,
    rule: produced.rule ?? null,
    detail: produced.detail ?? null,
    reused: produced.reused === true,
    replayBlocked: produced.replay_blocked === true,
    key,
    readback: produced.readback,
    evidence: produced.evidence,
    remoteCalls: produced.remote_calls ?? 0,
  });
}

/**
 * 门禁 operation 的内部实现：preflight → invoke → 回读。
 *
 * 它返回的是"半成品"（不含 tool/action/key），最终信封由 `executeWrite` 在门禁裁决之后拼；
 * 这样"台账登记"只有一个位置，不会出现"操作里记了一次、外面又记一次"的双写。
 */
async function runWrite(service, spec) {
  const { command, params, readback, title, objectType, target } = spec;

  if (!Object.hasOwn(GITEE_COMMANDS, command)) {
    return {
      status: 'failed',
      target,
      reason: ACTION_REASONS.INTERNAL,
      rule: 'unknown-command',
      detail: `动作 ${spec.action} 映射到了命令面里不存在的命令 ${command}（实现缺陷，零子进程）`,
      remote_calls: 0,
    };
  }

  // preflight：令牌与持久凭据（零子进程）。缺令牌是 `failed`（确定没生效），不是 `denied`：
  // 门禁已经放行了，拒它的是环境而不是策略。
  const pre = service.preflight();
  if (isPlainObject(pre) && pre.ok !== true) {
    return {
      status: 'failed',
      target,
      reason: text(pre.reason) || ACTION_REASONS.AUTH_MISSING,
      rule: 'preflight-failed',
      detail: text(pre.message) || 'CLI/凭据预检未通过，未发起任何写入',
      remote_calls: 0,
    };
  }

  let outcome;
  try {
    outcome = await service.invoke(command, params, spec.action);
  } catch (error) {
    const classified = classifyCommandError(error, `${command} `);
    return {
      status: classified.status,
      target,
      reason: classified.reason,
      rule: classified.rule,
      detail: classified.detail,
      remote_calls: 1,
    };
  }

  const repo = repoOf(target);
  const created = spec.refFromOutput === true ? parseCreatedRef(outcome?.stdout, repo) : null;
  const observedRef = created?.ref ?? spec.readbackTarget ?? target;
  if (spec.refFromOutput === true && (created === null || text(created.ref) === '')) {
    return {
      status: 'unknown',
      target,
      reason: ACTION_REASONS.MALFORMED_RESULT,
      rule: 'malformed-result',
      detail: '写命令跑完但输出里没有可回读的编号或链接，转人工核对（不重放）',
      remote_calls: 1,
      readback: { via: readback.action, ok: false, target: observedRef },
      evidence: buildEvidence({
        command: outcome?.label,
        at: outcome?.observedAt,
        target,
        sourceType: 'gitee-cli',
      }),
    };
  }

  // 回读：只读动作，走同一条唯一子进程出口；失败即 `unknown`（不猜"应该写成功了"）。
  let observed;
  try {
    observed = await service.adapter().read(readback.action, observedRef, readback.params ?? {});
  } catch (error) {
    return {
      status: 'unknown',
      target,
      object_ref: observedRef,
      reason: ACTION_REASONS.READBACK_UNAVAILABLE,
      rule: 'readback-unavailable',
      detail: `写入后回读失败，无法确认（不重放）：${describeError(error)}`,
      remote_calls: 2,
      readback: { via: readback.action, ok: false, target: observedRef },
      evidence: buildEvidence({
        command: outcome?.label,
        at: outcome?.observedAt,
        target,
        sourceType: 'gitee-cli',
      }),
    };
  }

  const object = isPlainObject(observed?.object) ? observed.object : {};
  const verification = readback.verify(object, { title, target, repo, created, objectType });
  const evidence = buildEvidence({
    command: outcome?.label,
    at: outcome?.observedAt,
    target: observedRef,
    sourceType: 'gitee-cli',
  });
  const summary = {
    via: readback.action,
    ok: verification.ok === true,
    target: observedRef,
    revision: text(observed?.source_revision) || null,
    title: text(object.title) || null,
    state: text(object.state) || null,
    comments: typeof object[COMMENTS_FIELD] === 'number' ? object[COMMENTS_FIELD] : null,
  };

  if (verification.ok !== true) {
    return {
      status: 'unknown',
      target,
      object_ref: observedRef,
      reason: verification.reason ?? ACTION_REASONS.READBACK_MISMATCH,
      rule: 'readback-mismatch',
      detail: verification.detail,
      remote_calls: 2,
      readback: summary,
      evidence,
    };
  }

  return {
    status: 'done',
    target,
    object_ref: observedRef,
    remote_calls: 2,
    readback: summary,
    evidence,
  };
}

/** `owner/name#12` → `owner/name`（无分隔时原样返回）。 */
function repoOf(target) {
  const raw = text(target);
  const cut = raw.search(/[#!]/u);
  return cut === -1 ? raw : raw.slice(0, cut);
}

function assertChangeId(value, spec) {
  const changeId = text(value);
  if (changeId === '') return { error: denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少变更号（changeId）') };
  return { changeId };
}

function assertTargetShape(target, spec, { allowRepo = true } = {}) {
  const raw = text(target);
  if (raw === '') return { error: denyInput(spec, ACTION_REASONS.MISSING_TARGET, '缺少目标（target）') };
  if (allowRepo && REPO_PATTERN.test(raw)) return { target: raw, repo: raw, qualified: false };
  const matched = QUALIFIED_PATTERN.exec(raw);
  if (matched === null) {
    return {
      error: denyInput(spec, ACTION_REASONS.INVALID_TARGET, `目标必须是 owner/name 或 owner/name#12，收到 ${raw}`, {
        target: raw,
      }),
    };
  }
  return { target: raw, repo: matched[1], qualified: true, ref: refForCli(raw) };
}

function assertBody(value, spec, what = '正文（body）') {
  const body = typeof value === 'string' ? value : '';
  if (body.trim() === '') return { error: denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, `缺少${what}，拒绝写入空内容`) };
  return { body };
}

/**
 * 建 Issue / 追加评论（幂等 + 回读）。
 *
 * @returns {{ tool: string, action: string, run: (args: object, service: object) => Promise<object> }}
 */
export function createIssueWrite() {
  const spec = { tool: TOOL_NAMES.ISSUE_WRITE, action: GITEE_ACTIONS.ISSUE_WRITE };
  return Object.freeze({
    ...spec,
    async run(args = {}, service) {
      requireService(service);
      const input = isPlainObject(args) ? args : {};
      const op = text(input.op) || 'create';
      const shape = assertTargetShape(input.target, spec);
      if (shape.error !== undefined) return shape.error;
      const change = assertChangeId(input.changeId, spec);
      if (change.error !== undefined) return change.error;

      if (op === 'create') {
        if (!REPO_PATTERN.test(shape.target)) {
          return denyInput(spec, ACTION_REASONS.INVALID_TARGET, '创建 Issue 的 target 必须是仓库（owner/name）', {
            target: shape.target,
          });
        }
        const title = text(input.title);
        if (title === '') return denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少标题（title）', { target: shape.target });
        const body = assertBody(input.body, spec);
        if (body.error !== undefined) return body.error;
        return executeWrite(service, {
          ...spec,
          op,
          change: change.changeId,
          target: shape.target,
          objectType: GITEE_OBJECT_TYPES.ISSUE,
          title,
          confirm: input.confirm,
          command: 'issueCreate',
          params: { target: shape.target, title, body: body.body },
          refFromOutput: true,
          readback: {
            action: 'gitee.issue.read',
            verify: (object, { title: expected }) => (sameTitle(object.title, expected)
              ? { ok: true }
              : { ok: false, reason: ACTION_REASONS.READBACK_MISMATCH, detail: `回读标题与写入不一致（写入「${expected}」/ 回读「${text(object.title)}」），转人工核对` }),
          },
        });
      }

      if (op === 'comment') {
        if (!shape.qualified) {
          return denyInput(spec, ACTION_REASONS.INVALID_TARGET, '评论 Issue 的 target 必须是 owner/name#12', {
            target: shape.target,
          });
        }
        const body = assertBody(input.body, spec);
        if (body.error !== undefined) return body.error;
        return executeWrite(service, {
          ...spec,
          op,
          change: change.changeId,
          target: shape.target,
          objectType: GITEE_OBJECT_TYPES.ISSUE_COMMENT,
          title: `${shape.ref} ${bodyDigest(body.body)}`,
          confirm: input.confirm,
          command: 'issueComment',
          params: { target: shape.ref, body: body.body },
          readbackTarget: shape.ref,
          readback: {
            action: 'gitee.issue.read',
            verify: (object, { target }) => verifyComment(object, target),
          },
        });
      }

      return denyInput(spec, ACTION_REASONS.INVALID_ARGUMENT, `op 只能是 create|comment，收到 ${op}`, {
        target: shape.target,
      });
    },
  });
}

/**
 * 建 PR / 追加评论（幂等 + 回读）。
 *
 * 与 Issue 同一套语义，差别有两处：创建必须带 `head`/`base`（否则建出来的 PR 指向不明），
 * 回读除标题外还要核对 `head`——同标题不同分支是两次交付。
 */
export function createPrWrite() {
  const spec = { tool: TOOL_NAMES.PR_WRITE, action: GITEE_ACTIONS.PR_WRITE };
  return Object.freeze({
    ...spec,
    async run(args = {}, service) {
      requireService(service);
      const input = isPlainObject(args) ? args : {};
      const op = text(input.op) || 'create';
      const shape = assertTargetShape(input.target, spec);
      if (shape.error !== undefined) return shape.error;
      const change = assertChangeId(input.changeId, spec);
      if (change.error !== undefined) return change.error;

      if (op === 'create') {
        if (!REPO_PATTERN.test(shape.target)) {
          return denyInput(spec, ACTION_REASONS.INVALID_TARGET, '创建 PR 的 target 必须是仓库（owner/name）', {
            target: shape.target,
          });
        }
        const title = text(input.title);
        if (title === '') return denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少标题（title）', { target: shape.target });
        const body = assertBody(input.body, spec);
        if (body.error !== undefined) return body.error;
        const head = text(input.head);
        const base = text(input.base);
        if (head === '') return denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少源分支（head）', { target: shape.target });
        if (base === '') return denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少目标分支（base）', { target: shape.target });
        const params = { target: shape.target, title, body: body.body, head, base };
        if (input.draft === true) params.draft = true;
        return executeWrite(service, {
          ...spec,
          op,
          change: change.changeId,
          target: shape.target,
          objectType: GITEE_OBJECT_TYPES.PR,
          title,
          confirm: input.confirm,
          command: 'prCreate',
          params,
          refFromOutput: true,
          readback: {
            action: 'gitee.pr.read',
            verify: (object, { title: expected }) => {
              if (!sameTitle(object.title, expected)) {
                return {
                  ok: false,
                  reason: ACTION_REASONS.READBACK_MISMATCH,
                  detail: `回读标题与写入不一致（写入「${expected}」/ 回读「${text(object.title)}」），转人工核对`,
                };
              }
              const observedHead = text(object.head);
              if (observedHead !== '' && observedHead !== head) {
                return {
                  ok: false,
                  reason: ACTION_REASONS.READBACK_MISMATCH,
                  detail: `回读源分支与写入不一致（写入「${head}」/ 回读「${observedHead}」），转人工核对`,
                };
              }
              return { ok: true };
            },
          },
        });
      }

      if (op === 'comment') {
        if (!shape.qualified) {
          return denyInput(spec, ACTION_REASONS.INVALID_TARGET, '评论 PR 的 target 必须是 owner/name#12 或 owner/name!12', {
            target: shape.target,
          });
        }
        const body = assertBody(input.body, spec);
        if (body.error !== undefined) return body.error;
        return executeWrite(service, {
          ...spec,
          op,
          change: change.changeId,
          target: shape.target,
          objectType: GITEE_OBJECT_TYPES.PR_COMMENT,
          title: `${shape.ref} ${bodyDigest(body.body)}`,
          confirm: input.confirm,
          command: 'prComment',
          params: { target: shape.ref, body: body.body },
          readbackTarget: shape.ref,
          readback: {
            action: 'gitee.pr.read',
            verify: (object, { target }) => verifyComment(object, target),
          },
        });
      }

      return denyInput(spec, ACTION_REASONS.INVALID_ARGUMENT, `op 只能是 create|comment，收到 ${op}`, {
        target: shape.target,
      });
    },
  });
}

/**
 * 发布审查评论（AI 结论写进 PR 评论，人工结论不在这里代写）。
 *
 * 幂等键用 `变更号@commit`：同一个提交重复发布是同一件事（复用），换了提交就是新结论。
 * 评论正文尾部追加一行 AI 溯源（模型名不在入参里，故只标 `[AI]` + 变更号 + 短 sha），
 * 让人一眼看出这条结论不是人工写的。
 */
export function publishReview() {
  const spec = { tool: TOOL_NAMES.REVIEW_PUBLISH, action: GITEE_ACTIONS.REVIEW_PUBLISH };
  return Object.freeze({
    ...spec,
    async run(args = {}, service) {
      requireService(service);
      const input = isPlainObject(args) ? args : {};
      const shape = assertTargetShape(input.target, spec);
      if (shape.error !== undefined) return shape.error;
      if (!shape.qualified) {
        return denyInput(spec, ACTION_REASONS.INVALID_TARGET, '发布审查评论的 target 必须是 owner/name#12 或 owner/name!12', {
          target: shape.target,
        });
      }
      const change = assertChangeId(input.changeId, spec);
      if (change.error !== undefined) return change.error;
      const commit = text(input.commit).toLowerCase();
      if (!SHA_PATTERN.test(commit)) {
        return denyInput(spec, ACTION_REASONS.INVALID_ARGUMENT, 'commit 必须是 7..40 位十六进制 sha', {
          target: shape.target,
        });
      }
      const body = assertBody(input.body, spec);
      if (body.error !== undefined) return body.error;
      if (isPlainObject(input.human)) {
        return denyInput(spec, ACTION_REASONS.HUMAN_CONFIRMATION_FORBIDDEN, '人工结论只能人工自己写，模型不得代填（human 不入参）', {
          target: shape.target,
        });
      }

      const footer = `\n\n---\n> [AI] provider=gitee · 变更 ${change.changeId} · commit ${commit.slice(0, 7)} · 人工结论不在此处代写`;
      return executeWrite(service, {
        ...spec,
        op: 'publish',
        change: change.changeId,
        target: shape.target,
        objectType: GITEE_OBJECT_TYPES.REVIEW,
        title: `${change.changeId}@${commit.slice(0, 7)}`,
        confirm: input.confirm,
        command: 'prComment',
        params: { target: shape.ref, body: `${body.body}${footer}` },
        readbackTarget: shape.ref,
        readback: {
          action: 'gitee.pr.read',
          verify: (object, { target }) => verifyComment(object, target),
        },
      });
    },
  });
}

/**
 * 评论类回读：确认"评论数 ≥ 1"。
 *
 * Gitee 的字段稳定性未联调（TECHNICAL R-1）：字段缺失一律 `unknown`（`readback-unavailable`），
 * 不把"取不到"当成"写成功"。
 */
function verifyComment(object, target) {
  const comments = object?.[COMMENTS_FIELD];
  if (typeof comments !== 'number') {
    return {
      ok: false,
      reason: ACTION_REASONS.READBACK_UNAVAILABLE,
      detail: `回读结果里没有可用的 ${COMMENTS_FIELD} 计数，无法确认评论已落地（不重放）`,
    };
  }
  if (comments < 1) {
    return {
      ok: false,
      reason: ACTION_REASONS.READBACK_MISMATCH,
      detail: `回读显示 ${COMMENTS_FIELD}=0，评论未落地（不当作成功，转人工核对）`,
    };
  }
  return { ok: true };
}

/** 惰性加载审查/交付语义模块：只有真正调用时才需要它们存在。 */
async function loadModule(name, reason) {
  try {
    return await import(name);
  } catch (error) {
    throw new GiteeActionError(reason, `语义模块 ${name} 不可用：${describeError(error)}`);
  }
}

/**
 * 记录 `review.md`（`gitee.review.record`，AC-19）。
 *
 * 入参**不接受**人工确认：AI 段落由模型写，人工段只能人工自己填（`human` 出现即拒绝）。
 */
function createReviewRecord() {
  const spec = { tool: TOOL_NAMES.REVIEW_RECORD, action: GITEE_ACTIONS.REVIEW_RECORD };
  return Object.freeze({
    ...spec,
    async run(args = {}, service) {
      requireService(service);
      const input = isPlainObject(args) ? args : {};
      const target = text(input.repoRoot);
      const change = assertChangeId(input.changeId, spec);
      if (change.error !== undefined) return change.error;
      if (target === '') return denyInput(spec, ACTION_REASONS.MISSING_TARGET, '缺少仓库根（repoRoot）', { target: '' });
      const commit = text(input.commit).toLowerCase();
      if (!SHA_PATTERN.test(commit)) {
        return denyInput(spec, ACTION_REASONS.INVALID_ARGUMENT, 'commit 必须是 7..40 位十六进制 sha', { target });
      }
      if (text(input.model) === '') return denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少模型名（model）', { target });
      if (isPlainObject(input.human) || input.human !== undefined) {
        return denyInput(spec, ACTION_REASONS.HUMAN_CONFIRMATION_FORBIDDEN, '人工确认只能人工自己写，模型不得代填（human 不入参）', { target });
      }
      for (const field of ['findings', 'risks']) {
        if (input[field] !== undefined && !Array.isArray(input[field])) {
          return denyInput(spec, ACTION_REASONS.INVALID_ARGUMENT, `${field} 必须是数组`, { target });
        }
      }

      const key = idempotencyKey({ change: change.changeId, objectType: GITEE_OBJECT_TYPES.REVIEW, title: `${change.changeId}@${commit.slice(0, 7)}` });
      const session = service.session();
      const prior = session.lookup(key);
      if (prior !== undefined && prior.status === 'done') {
        return actionResult({
          tool: spec.tool,
          action: spec.action,
          status: 'done',
          target,
          objectRef: prior.objectRef,
          reused: true,
          key,
          detail: '同一变更同一提交的 review.md 已经写过（幂等命中），未再写盘',
          readback: { via: 'session-ledger', ok: true, reused_of: key },
          evidence: prior.evidence ?? undefined,
        });
      }
      if (prior !== undefined && REPLAY_BLOCKED_STATUSES.includes(prior.status)) {
        return actionResult({
          tool: spec.tool,
          action: spec.action,
          status: 'unknown',
          target,
          reason: ACTION_REASONS.REPLAY_BLOCKED,
          rule: 'replay-blocked',
          detail: '上一次写 review.md 的结果不确定，转人工核对，不重放',
          replayBlocked: true,
          key,
        });
      }

      let verdict;
      try {
        verdict = await service.execute({
          action: spec.action,
          target,
          tool: spec.tool,
          payload: {
            arguments: { target, repoRoot: target, change: change.changeId },
            run: async () => {
              try {
                const review = await loadModule('./gitee-review.mjs', ACTION_REASONS.MODULE_UNAVAILABLE);
                const record = review.buildReviewRecord({
                  changeId: change.changeId,
                  commit,
                  model: text(input.model),
                  findings: input.findings ?? [],
                  risks: input.risks ?? [],
                  opinion: input.opinion,
                  conclusion: input.conclusion,
                });
                const written = review.writeReviewFile({ repoRoot: target, changeId: change.changeId, review: record });
                return {
                  status: 'done',
                  target,
                  object_ref: text(written?.path) || null,
                  readback: { via: 'review.md', ok: true, sha256: text(written?.sha256) || null },
                  evidence: buildEvidence({
                    command: 'gitee.review.record',
                    at: new Date().toISOString(),
                    target,
                    sourceType: 'none',
                  }),
                  remote_calls: 0,
                };
              } catch (error) {
                return {
                  status: 'failed',
                  target,
                  reason: text(error?.code) || ACTION_REASONS.REVIEW_INVALID,
                  rule: 'review-invalid',
                  detail: describeError(error),
                  remote_calls: 0,
                };
              }
            },
          },
        });
      } catch (error) {
        return actionResult({
          tool: spec.tool,
          action: spec.action,
          status: error?.denied === true ? 'denied' : 'failed',
          target,
          reason: text(error?.code) || ACTION_REASONS.INTERNAL,
          rule: error?.denied === true ? 'service-refused' : 'internal-error',
          detail: describeError(error),
          key,
        });
      }
      return settleVerdict(spec, verdict, { target, key, session });
    },
  });
}

/**
 * 交付判定（`gitee.delivery.judge`，AC-18/21）：**只判定不执行**。
 *
 * - 提交信息必须带 `[变更号]`：驳回 → `failed`（确定没做任何事，可以改完再来）。
 * - 四项关闭条件：全过 → `done`；有 `unknown` → `unknown`（不计入通过）；有未过 → `failed`。
 * - 白名单里没有 close/merge，本动作也从不调用它们。
 */
function createDeliveryGate() {
  const spec = { tool: TOOL_NAMES.DELIVERY_GATE, action: GITEE_ACTIONS.DELIVERY_JUDGE };
  return Object.freeze({
    ...spec,
    async run(args = {}, service) {
      requireService(service);
      const input = isPlainObject(args) ? args : {};
      const change = assertChangeId(input.changeId, spec);
      if (change.error !== undefined) return change.error;
      const target = change.changeId;
      const message = typeof input.message === 'string' ? input.message : '';
      if (message.trim() === '') return denyInput(spec, ACTION_REASONS.MISSING_ARGUMENT, '缺少提交信息（message）', { target });
      if (!isPlainObject(input.criteria)) {
        return denyInput(spec, ACTION_REASONS.INVALID_ARGUMENT, '缺失关闭条件（criteria）：四项必须显式给出', { target });
      }

      let verdict;
      try {
        verdict = await service.execute({
          action: spec.action,
          target,
          tool: spec.tool,
          payload: {
            arguments: { target, change: change.changeId },
            run: async () => {
              try {
                const delivery = await loadModule('./gitee-delivery.mjs', ACTION_REASONS.DELIVERY_UNAVAILABLE);
                let commitOk = true;
                let commitDetail = null;
                if (typeof delivery.assertCommitMessage === 'function') {
                  try {
                    delivery.assertCommitMessage({ changeId: change.changeId, message });
                  } catch (error) {
                    commitOk = false;
                    commitDetail = describeError(error);
                  }
                }
                const judged = typeof delivery.judgeCloseReadiness === 'function'
                  ? delivery.judgeCloseReadiness({ criteria: input.criteria })
                  : null;
                const ready = judged?.ready === true;
                const items = Array.isArray(judged?.items) ? judged.items : [];
                const unknownItems = items.filter((item) => text(item?.status) === 'unknown').map((item) => text(item?.key) || null);
                const status = !commitOk || judged === null
                  ? 'failed'
                  : ready && unknownItems.length === 0
                    ? 'done'
                    : unknownItems.length > 0
                      ? 'unknown'
                      : 'failed';
                return {
                  status,
                  target,
                  reason: !commitOk
                    ? ACTION_REASONS.COMMIT_MESSAGE_INVALID
                    : judged === null
                      ? ACTION_REASONS.DELIVERY_UNAVAILABLE
                      : status === 'unknown'
                        ? ACTION_REASONS.DELIVERY_UNAVAILABLE
                        : null,
                  rule: !commitOk ? 'commit-message-invalid' : status === 'done' ? 'ready' : 'not-ready',
                  detail: commitDetail,
                  readback: {
                    via: 'gitee-delivery',
                    ok: status === 'done',
                    ready,
                    commit: text(input.commit).toLowerCase() || null,
                    unknown_items: unknownItems,
                  },
                  remote_calls: 0,
                };
              } catch (error) {
                return {
                  status: 'failed',
                  target,
                  reason: text(error?.code) || ACTION_REASONS.DELIVERY_UNAVAILABLE,
                  rule: 'delivery-invalid',
                  detail: describeError(error),
                  remote_calls: 0,
                };
              }
            },
          },
        });
      } catch (error) {
        return actionResult({
          tool: spec.tool,
          action: spec.action,
          status: error?.denied === true ? 'denied' : 'failed',
          target,
          reason: text(error?.code) || ACTION_REASONS.INTERNAL,
          rule: error?.denied === true ? 'service-refused' : 'internal-error',
          detail: describeError(error),
        });
      }
      return settleVerdict(spec, verdict, { target, key: null, session: null });
    },
  });
}

/** 门禁裁决 → 动作信封（本地/判定类动作共用；幂等台账由各自处理）。 */
function settleVerdict(spec, verdict, { target, key }) {
  if (!isPlainObject(verdict) || text(verdict.status) !== 'done') {
    const status = text(verdict?.status) === 'failed' && verdict?.mayHaveSideEffect === true
      ? 'unknown'
      : (text(verdict?.status) === 'denied' ? 'denied' : 'failed');
    return actionResult({
      tool: spec.tool,
      action: spec.action,
      status,
      target,
      reason: text(verdict?.reason) || ACTION_REASONS.INTERNAL,
      rule: text(verdict?.rule) || 'guard-failed',
      detail: text(verdict?.detail) || null,
      replayBlocked: status === 'unknown',
      key,
    });
  }
  const produced = isPlainObject(verdict.value) ? verdict.value : null;
  if (produced === null || !ACTION_STATUSES.includes(text(produced.status))) {
    return actionResult({
      tool: spec.tool,
      action: spec.action,
      status: 'unknown',
      target,
      reason: ACTION_REASONS.INTERNAL,
      rule: 'malformed-outcome',
      detail: '门禁已放行但下游没有返回可识别的动作状态，无法核对',
      replayBlocked: true,
      key,
    });
  }
  return actionResult({
    tool: spec.tool,
    action: spec.action,
    status: produced.status,
    target: produced.target ?? target,
    objectRef: produced.object_ref ?? null,
    reason: produced.reason ?? null,
    rule: produced.rule ?? null,
    detail: produced.detail ?? null,
    reused: produced.reused === true,
    replayBlocked: produced.replay_blocked === true,
    key,
    readback: produced.readback,
    evidence: produced.evidence,
    remoteCalls: produced.remote_calls ?? 0,
  });
}

const PARAMETERS = Object.freeze({
  target: { type: 'string', description: '目标：仓库 owner/name，或工作项 owner/name#12（PR 也可写 owner/name!12）' },
  changeId: { type: 'string', description: '变更号（如 CHG-2026-001）。幂等键的第一段，必填。' },
  confirm: {
    type: 'object',
    description: '确认块：{ repo: owner/name, object: 本次写入的完整目标 }。两者必须与 target 逐字相符，否则直接拒绝。',
    properties: { repo: { type: 'string' }, object: { type: 'string' } },
    required: ['repo', 'object'],
    additionalProperties: false,
  },
  body: { type: 'string', description: '正文（Markdown）。空正文一律拒绝。' },
});

/**
 * 五个受控动作的模型可见定义（顺序与 `GITEE_WRITE_TOOLS` 一致）。
 *
 * 每个定义只有 `name` / `description` / `parameters` / `output` / `execute`：没有 argv、没有
 * 命令名、没有"重试上一次"这种入口。模型能表达的最坏输入，仍要过门禁的目录与确认两道门。
 * `output` 是宿主 `register()` 的硬判据（D-1），参数面只使用宿主支持的 JSON Schema 子集。
 *
 * @param {object} service 插件服务端口
 * @returns {Array<object>} 工具定义
 */
export function writeToolDefinitions(service) {
  requireService(service);
  const issueWrite = createIssueWrite();
  const prWrite = createPrWrite();
  const reviewPublish = publishReview();
  const reviewRecord = createReviewRecord();
  const deliveryGate = createDeliveryGate();

  return [
    {
      name: issueWrite.tool,
      description:
        '在 Gitee 仓库创建 Issue 或给既有 Issue 追加评论（受控写）。默认未登记即 denied；done 表示写入成功且回读一致。同一变更的同一对象重复调用会复用上一次结果（reused=true，零远端调用）。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'comment'], description: 'create=建 Issue（target 为 owner/name）；comment=追加评论（target 为 owner/name#12）' },
          target: PARAMETERS.target,
          changeId: PARAMETERS.changeId,
          title: { type: 'string', description: 'Issue 标题（op=create 必填）' },
          body: PARAMETERS.body,
          confirm: PARAMETERS.confirm,
        },
        required: ['op', 'target', 'changeId', 'body', 'confirm'],
        additionalProperties: false,
      },
      output: WRITE_TOOL_OUTPUT,
      execute: async (args) => json(await issueWrite.run(args ?? {}, service)),
    },
    {
      name: prWrite.tool,
      description:
        '在 Gitee 创建 PR 或给既有 PR 追加评论（受控写）。创建必须带 head/base；done 表示写入成功且回读的标题与源分支都一致。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'comment'], description: 'create=建 PR（target 为 owner/name）；comment=追加评论（target 为 owner/name#12 或 !12）' },
          target: PARAMETERS.target,
          changeId: PARAMETERS.changeId,
          title: { type: 'string', description: 'PR 标题（op=create 必填）' },
          body: PARAMETERS.body,
          head: { type: 'string', description: '源分支（op=create 必填）' },
          base: { type: 'string', description: '目标分支（op=create 必填）' },
          draft: { type: 'boolean', description: '是否创建为草稿 PR' },
          confirm: PARAMETERS.confirm,
        },
        required: ['op', 'target', 'changeId', 'body', 'confirm'],
        additionalProperties: false,
      },
      output: WRITE_TOOL_OUTPUT,
      execute: async (args) => json(await prWrite.run(args ?? {}, service)),
    },
    {
      name: reviewPublish.tool,
      description:
        '把 AI 审查结论发布为 PR 评论（受控写）。正文尾部会追加一行 AI 溯源（变更号 + 短 sha + "人工结论不在此处代写"）。人工结论只能人工自己写。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标 PR：owner/name#12 或 owner/name!12' },
          changeId: PARAMETERS.changeId,
          commit: { type: 'string', description: '被审查的提交 sha（7..40 位十六进制）' },
          body: PARAMETERS.body,
          confirm: PARAMETERS.confirm,
        },
        required: ['target', 'changeId', 'commit', 'body', 'confirm'],
        additionalProperties: false,
      },
      output: WRITE_TOOL_OUTPUT,
      execute: async (args) => json(await reviewPublish.run(args ?? {}, service)),
    },
    {
      name: reviewRecord.tool,
      description:
        '把审查记录写成 review.md（AI 段由模型填，人工段留空待人工确认）。不接受 human 入参：人工确认只能人工自己写。',
      parameters: {
        type: 'object',
        properties: {
          repoRoot: { type: 'string', description: '仓库根目录（review.md 落在其中）' },
          changeId: PARAMETERS.changeId,
          commit: { type: 'string', description: '被审查的提交 sha（7..40 位十六进制）' },
          model: { type: 'string', description: '写这段结论的模型名（AI 段必须可追溯）' },
          findings: { type: 'array', items: { type: 'string' }, description: '发现的问题' },
          risks: { type: 'array', items: { type: 'string' }, description: '风险项' },
          opinion: { type: 'string', description: '审查意见（approve / comment / request-changes 等，#gitee-review 定义）' },
          conclusion: { type: 'string', description: '结论（pass / fail 等）' },
        },
        required: ['repoRoot', 'changeId', 'commit', 'model', 'opinion', 'conclusion'],
        additionalProperties: false,
      },
      output: WRITE_TOOL_OUTPUT,
      execute: async (args) => json(await reviewRecord.run(args ?? {}, service)),
    },
    {
      name: deliveryGate.tool,
      description:
        '判定交付是否满足关闭条件（只判定，不关闭、不合并）：提交信息是否带 [变更号] + 关闭四项。有 unknown 项即返回 unknown（不计入通过）。',
      parameters: {
        type: 'object',
        properties: {
          changeId: PARAMETERS.changeId,
          commit: { type: 'string', description: '交付提交 sha' },
          message: { type: 'string', description: '提交信息（校验 [变更号] 前缀）' },
          criteria: {
            type: 'object',
            description: '关闭四项：{ acceptance, merged, pendingDelivery, humanConfirmed }，取值 pass|fail|unknown',
            additionalProperties: true,
          },
        },
        required: ['changeId', 'message', 'criteria'],
        additionalProperties: false,
      },
      output: WRITE_TOOL_OUTPUT,
      execute: async (args) => json(await deliveryGate.run(args ?? {}, service)),
    },
  ];
}
