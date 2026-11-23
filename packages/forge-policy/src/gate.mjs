/**
 * 门禁的宿主适配器：唯一放行点 `admitOnce`，三条入口（tools/pre-execute、tools
 * 守卫、command 面）共用同一判定。
 *
 * P1 在 P0 的 resolve → identity → audit → receipt 之间插入两段：来源判定（子代理
 * 一律不写）与逐次确认（命中 `confirmPush`/`confirmDopWrite` 时弹一次卡片，超时或
 * 通道缺失即拒绝）。允许结论进会话内 LRU：同一次调用的重试不再打扰用户，但仍要
 * 过身份复验、参数摘要复验与一次性收据。未登记动作（含全部读动作）是 out-of-scope：
 * 直接放行，不读身份、不写审计（D22/D23）。
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

import { decideAction } from './catalog.mjs';
import { CATEGORY, classifyAction } from './classify.mjs';
import { collectPathCandidates } from './path-sources.mjs';
import { redactPath } from './audit.mjs';
import { canonicalize, judgeProtectedPath } from './paths.mjs';
import {
  compileContentRules,
  digestContent,
  observationsFromContent,
  payloadsForAction,
  payloadsFromArguments,
  scanPayloads,
} from './content-rules.mjs';
import { DEFAULT_CONFIRMATION_TIMEOUT_MS } from './config.mjs';
import {
  WIRED_PROCESS_RULES,
  evaluateProcessRules,
  factsFromArguments,
  factsFromContent,
} from './process-rules.mjs';
import {
  CONFIRM_CODES,
  CONFIRM_REASONS,
  buildConfirmationCard,
} from './confirm.mjs';
import {
  PERSONA,
  agentKindOf,
  confirmDelegatedCopy,
  delegationSummary,
  personaOf,
  rootOf,
} from './delegation.mjs';
import { reuseKeyOf } from './reuse.mjs';

const AUDIT_FAILURE_COPY = (action, sinkKind, target) => {
  const shape = target === undefined ? '(无目标)' : target.includes('/') ? target.split('/').slice(-2).join('/') : target;
  return `受控写「${action}」已中止：本次执行记录无法写入（存储 ${sinkKind}，目标 ${shape}）。`
    + '请检查策略日志目录的写权限、磁盘空间与路径配置后重试；在记录可写之前本次动作不会执行。';
};

const AUDIT_OUTSTANDING_COPY = '上一次执行记录尚未回写，为避免漏记，本次受控写已中止；请检查策略存储并确认缺口后重试。';

const IDENTITY_COPY = (action) => `未解析到 IAM 身份，受控写「${action}」已拒绝：请在「设置 → 账号」完成登录后重试。`;

/** 拒绝文案里的"业务目标"：路径形状只留最后一段，绝对路径不进用户面。 */
function businessTarget(target) {
  if (typeof target !== 'string') return undefined;
  const value = target.trim();
  if (value === '') return undefined;
  if (!/[\\/]/u.test(value)) return value;
  const segments = value.split(/[\\/]+/u).filter((segment) => segment !== '');
  return segments.at(-1);
}

function goalOf(target) {
  return businessTarget(target) ?? '未提供';
}

const UNREGISTERED_COPY = (action) => `未登记动作「${action}」已阻止：该动作没有登记进策略目录，`
  + '按「默认放行，开启后未登记即拒」的规则拒绝执行。下一步：在策略目录登记该动作（业务目标与读写类别）后重试。';

const HUMAN_RECORD_COPY = (action) => `受控写「${action}」已拒绝：人工评审结论必须由人做出，策略插件不代写评审记录。`
  + '下一步：请评审人本人在评审界面提交结论。';

const PROTECTED_PATH_COPY = (target, label) => `受保护路径规则拒绝了这次写入：「${goalOf(target)}」`
  + `命中了受保护文件类别 ${label}。下一步：如确需改动该文件，请由人手动完成，或先确认该路径的归属后再重试。`;

const PATH_SCOPE_COPY = (target) => `受保护路径规则拒绝了这次写入：「${goalOf(target)}」：无法确认这次调用所属的工作区范围。`
  + '下一步：确认宿主提供了会话工作区目录后重试，或改由人手动完成。';

const PATH_UNRESOLVABLE_COPY = (field, target) => `受保护路径规则拒绝了这次写入：「${goalOf(target)}」：`
  + `无法确认参数 ${field} 指向的真实路径（可能不存在、不可访问或存在循环链接）。下一步：确认该路径可访问后重试，或改由人手动完成。`;

function normalizeActor(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (value !== null && typeof value === 'object') {
    if (typeof value.principal === 'string' && value.principal.trim() !== '') return value.principal;
    if (typeof value.subject === 'string' && value.subject.trim() !== '') return value.subject;
  }
  return undefined;
}

function targetOf(exec) {
  const value = exec?.arguments?.target;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 参数摘要只覆盖工具名与 arguments，用于放行后的"参数有没有被改写"复验——
 * 这一步必须同步，正文通道（`exec.content`）可能是异步函数，不能塞进来。
 */
function staticDigestOf(exec) {
  return digestContent({ name: exec?.name ?? null, arguments: exec?.arguments ?? null });
}

/**
 * 正文摘要额外覆盖 `exec.content`：Gitee 与 DevOps 把写出去的正文放在这条私有通道上，
 * 只散列 arguments 会让"同目标、同参数、不同正文"的两次写在审计里长得一模一样。
 * 函数形式的正文在这里解析一次；解析失败用占位符，避免因为读不到正文就放行无记录。
 */
function digestInput(exec, content) {
  return {
    name: exec?.name ?? null,
    arguments: exec?.arguments ?? null,
    ...(content === undefined ? {} : { content }),
  };
}

/** 正文是普通对象时同步算：放行路径上多余的 await 会改变宿主看到的时序。 */
function contentDigestOf(exec) {
  if (typeof exec?.content !== 'function') return digestContent(digestInput(exec, exec?.content));
  return (async () => {
    try {
      return digestContent(digestInput(exec, await exec.content()));
    } catch {
      return digestContent(digestInput(exec, '[content-unavailable]'));
    }
  })();
}

/**
 * 正文通道只解析一次：摘要与内容闸必须看同一份文本，否则"扫过的"与"记下的"可能不是同一段。
 * 读不到就如实标记（内容闸按 D48 放行并告警，不因为读不到正文而阻断业务）。
 */
async function resolveContent(exec) {
  if (typeof exec?.content !== 'function') return { readable: true, value: exec?.content };
  try {
    return { readable: true, value: await exec.content() };
  } catch {
    return { readable: false, value: undefined };
  }
}

/** 待扫字段 = 动作声明字段 ∪ 正文通道里的文本键；正文读不到时只扫参数。 */
function contentPayloads(action, args, content) {
  const payloads = payloadsForAction(action, args ?? {});
  if (content.readable && content.value !== undefined && content.value !== null) {
    payloads.push(...payloadsFromArguments(content.value));
  }
  return payloads;
}

const CONTENT_SCAN_FAILED_COPY = (action) => `受控写「${action}」已拒绝：正文扫描失败，不能按"没有命中"放行。`
  + '请重试；持续失败时检查规则配置与正文结构。';

const CONTENT_HARD_COPY = (action, findings) => {
  const ids = [...new Set(findings.map((finding) => finding.rule))].join('、');
  return `受控写「${action}」已拒绝：提交内容命中了不允许放行的高风险信息（${ids}）。`
    + '请从正文中移除后重试；这类内容不能通过人工确认放行。';
};

const PROCESS_DENIED_COPY = (action, denials) => {
  const ids = [...new Set(denials.map((item) => item.rule))].join('、');
  const detail = denials.map((item) => item.reason).join('；');
  return `受控写「${action}」已拒绝：不满足流程前置条件（${ids}）。${detail}。`
    + '请按流程补齐后重试；流程条件不接受人工确认放行。';
};

/**
 * 流程闸只接已接线的规则（`WIRED_PROCESS_RULES`）：依赖外部事实源的两条要等
 * 事实源注入后再启用，否则"查不到状态"会被误读成"不满足流程"。
 */
function evaluateProcess(exec, action, content, report) {
  try {
    // 参数事实（操作、分支、force）与正文事实（建 PR 正文、评审正文）合并：
    // Gitee 工具只把正文放在 `exec.content`，参数里没有正文。
    const facts = { ...factsFromArguments(exec?.arguments ?? {}) };
    if (content === undefined) {
      // 没有正文快照（例如未开启内容闸的阶段）不算"读不到"，交给规则按缺字段判定。
    } else if (content.readable === true) {
      Object.assign(facts, factsFromContent(content.value));
    } else {
      facts.contentUnreadable = true;
    }
    return evaluateProcessRules({
      rules: WIRED_PROCESS_RULES,
      facts,
      action,
    });
  } catch (error) {
    // 求值抛错不等于没有违反：按不可确认拒绝，与内容扫描失败同口径。
    // 但拒绝要能排障：把错误摘要交给日志与观察回调，审计只记规则名不记堆栈。
    try {
      report?.(error);
    } catch {
      // 报告通道自身失败不影响拒绝结论。
    }
    return Object.freeze({
      deny: Object.freeze([Object.freeze({
        rule: 'process-rule-error',
        reason: 'the process rules could not be evaluated',
      })]),
      confirm: Object.freeze([]),
      unevaluated: Object.freeze([]),
    });
  }
}

/**
 * `subject` 是 provider 自证（Gitee guard 要求 `gitee`），与 IAM `actor` 是两个字段。
 * 从工具名前缀推断来源，推断不出来就不写，交给消费方按"没自证"处理。
 */
function subjectOf(toolName, action) {
  const name = typeof toolName === 'string' ? toolName : '';
  if (name.startsWith('forge_gitee_')) return 'gitee';
  if (name.startsWith('forge_devops_')) return 'devops';
  if (typeof action === 'string' && action.startsWith('gitee.')) return 'gitee';
  return undefined;
}

// `params` 只写调用摘要：正文/评论/补丁等业务内容既不落审计，也不进日志。
// 需要的完整性由 `contentDigest`（参数整体摘要）承担。
const CONTENT_ARG_KEYS = new Set(['title', 'body', 'description', 'content', 'message', 'comment', 'review', 'summary', 'text', 'diff', 'patch']);

function summarizeArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args ?? {};
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    summary[key] = CONTENT_ARG_KEYS.has(key) ? '[content]' : value;
  }
  return summary;
}

/**
 * 六个 `POLICY_CONFIRM_*` 码的用户文案：码本身留在结构化结果与审计里，不拼进正文。
 * 每条都说清"没有执行"与"能否重试"，也都不提内部路径或实现细节。
 */
const CONFIRM_DENY_COPY = Object.freeze({
  [CONFIRM_CODES.DENIED]: (action) => `受控写「${action}」已取消：你在确认卡片上选择了取消本次写入。可重新发起该动作。`,
  [CONFIRM_CODES.TIMEOUT]: (action, seconds) => `受控写「${action}」未执行：等待人工确认超时（${seconds} 秒）。可重新发起该动作。`,
  [CONFIRM_CODES.UNAVAILABLE]: (action) => `受控写「${action}」未执行：当前环境没有可用的确认通道（需要桌面端人工确认）。请在桌面端重试。`,
  [CONFIRM_CODES.INVALID_ANSWER]: (action) => `受控写「${action}」未执行：确认应答无法识别，按未确认处理。请重新发起该动作。`,
  [CONFIRM_CODES.DELEGATED]: (action) => confirmDelegatedCopy(action),
  [CONFIRM_CODES.CANCELLED]: (action) => `受控写「${action}」未执行：本次调用在等待确认时被取消。可重新发起该动作。`,
  [CONFIRM_CODES.ERROR]: (action) => `受控写「${action}」未执行：确认流程出现异常。请重试；若持续失败请联系管理员。`,
});

/** 审计里对确认结论的一句话：超时与通道缺失不能写成"用户拒绝"。 */
const ANSWER_SUMMARY = Object.freeze({
  [CONFIRM_CODES.DENIED]: '取消本次写入',
  [CONFIRM_CODES.TIMEOUT]: '等待超时，未确认',
  [CONFIRM_CODES.UNAVAILABLE]: '确认通道不可用，未确认',
  [CONFIRM_CODES.INVALID_ANSWER]: '应答无法识别，未确认',
  [CONFIRM_CODES.DELEGATED]: '子代理来源，未确认',
  [CONFIRM_CODES.CANCELLED]: '调用被取消，未确认',
  [CONFIRM_CODES.ERROR]: '确认流程异常，未确认',
});

/** 确认记录写不进去时本次动作不执行；文案不提「审计」，只说记录没写成。 */
const CONFIRM_RECORD_FAILED_COPY = (action) => `受控写「${action}」未执行：本次的确认过程没有留下可用记录，按未确认处理。请检查策略存储后重试。`;

function denyCopyOf(code, action, timeoutMs) {
  const seconds = Math.max(1, Math.round((Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CONFIRMATION_TIMEOUT_MS) / 1_000));
  const copy = code !== undefined && Object.hasOwn(CONFIRM_DENY_COPY, code) ? CONFIRM_DENY_COPY[code] : undefined;
  return (copy ?? CONFIRM_DENY_COPY[CONFIRM_CODES.ERROR])(action, seconds);
}

function answerSummary(decision, code) {
  if (decision === 'allow') return '允许本次写入';
  return code !== undefined && Object.hasOwn(ANSWER_SUMMARY, code) ? ANSWER_SUMMARY[code] : '未确认';
}

function deny(reason, code) {
  return code === undefined
    ? Object.freeze({ kind: 'deny', reason })
    : Object.freeze({ kind: 'deny', reason, code });
}

function toolAction(tools, toolName) {
  if (tools instanceof Map) return tools.get(toolName);
  if (tools !== null && typeof tools === 'object' && Object.hasOwn(tools, toolName)) return tools[toolName];
  return undefined;
}

/**
 * @param {{catalog: Map, rules?: object, pipeline?: readonly object[], audit: object,
 *   tools?: object | Map, getActor?: Function, onDecision?: Function, now?: () => number,
 *   confirmations?: {ask: Function}, decisionCache?: object, timeoutMs?: number}} options
 */
export function createGate({
  catalog,
  rules = {},
  pipeline = [],
  audit,
  tools = {},
  getActor,
  onDecision,
  warn,
  now,
  confirmations,
  decisionCache,
  timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  maxContentBytes,
  protectedRoots = [],
} = {}) {
  const stages = Object.freeze([...(pipeline ?? [])]);
  // 内置规则集随包编译一次；v1 不接受自定义规则（D49），组织规则留到后续阶段。
  const contentRules = compileContentRules().rules;
  const clock = now ?? (() => Date.now());
  const approved = new WeakMap();
  const admitting = new WeakSet();
  const admitted = new Map();
  const pendingSettlements = new Set();
  const confirmationTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONFIRMATION_TIMEOUT_MS;
  let confirmationCount = 0;
  let disposed = false;

  function sessionIdOf(exec) {
    const header = exec?.agent?.session?.header;
    const id = header?.id;
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
  }

  /** 内容闸：hard 由调用方拒绝；confirm/soft 只回报，是否弹卡由判定流程决定。 */
  function scanContent(action, args, content) {
    try {
      const scanned = scanPayloads(contentRules, contentPayloads(action, args, content), {
        ...(maxContentBytes === undefined ? {} : { maxBytes: maxContentBytes }),
        ...(content.readable ? { observations: observationsFromContent(content.value) } : {}),
      });
      // 正文读不到不是扫描器的返回值：在这里补一条同构的"未扫全"记录，交给调用方统一记账。
      const skipped = [...scanned.skipped];
      if (content.readable === false) skipped.push({ field: 'content', reason: 'unreadable' });
      return Object.freeze({
        ...scanned,
        skipped: Object.freeze(skipped),
        truncated: scanned.truncated || skipped.some((item) => item.reason === 'truncated'),
      });
    } catch {
      // 扫描异常不能等价于"没有命中"：内容闸是安全组件，宁可拒绝也不能让 hard 规则失效。
      return Object.freeze({
        findings: Object.freeze([]),
        hard: Object.freeze([]),
        confirm: Object.freeze([]),
        soft: Object.freeze([]),
        skipped: Object.freeze([{ field: 'content', reason: 'scan-failed' }]),
        truncated: false,
        failed: true,
      });
    }
  }

  function callIdOf(exec) {
    const value = exec?.callId;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  /** 单条审计（asked/answered/来源拒绝）。写失败只回报 false，由调用方决定拒绝。 */
  async function writeRecord(fields) {
    if (audit === undefined || audit === null || typeof audit.record !== 'function') return false;
    try {
      await audit.record(fields);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 拒绝也要留证据，但证据写不进去不该把拒绝变成放行：判定本身已经是 fail-closed，
   * 这里只做 best-effort 记录，记录失败时在结果里标 `evidence: 'unrecorded'`，
   * 让调用链能看到"这次拒绝没有留下审计痕迹"，而不是静默当作已记录。
   */
  async function denyWithEvidence(fields, reason, code) {
    const recorded = await writeRecord(fields);
    if (recorded) return deny(reason, code);
    return Object.freeze({
      kind: 'deny',
      reason,
      ...(code === undefined ? {} : { code }),
      evidence: 'unrecorded',
    });
  }

  function actionFor(toolName) {
    return toolAction(tools, toolName);
  }

  function isControlled(action) {
    return catalog instanceof Map && catalog.has(action);
  }

  function isEnforced(toolName) {
    const action = actionFor(toolName);
    return action !== undefined && isControlled(action);
  }

  function classifyCategory(action) {
    try {
      return classifyAction(action)?.category;
    } catch {
      return undefined;
    }
  }

  /**
   * 语义开关是否需要门禁介入。未登记读动作与"开关全关的未登记动作"仍然
   * out-of-scope：不读身份、不写审计、不受审计缺口影响。
   */
  function requiresGate(action) {
    // 目录缺失时不能因为"看起来未登记"就放行：映射到了策略动作就交给门禁，由 admit 报 fail closed。
    // admitOnce 里也判一次同样的条件，但那一步是对外的 fail-closed 结论（带错误码），
    // 这里的判定只决定"要不要进门禁"，两处职责不同，不能合并。
    if (!(catalog instanceof Map)) return true;
    if (isControlled(action)) return true;
    const category = classifyCategory(action);
    if (category === CATEGORY.HUMAN_RECORD && rules?.denyHumanRecord === true) return true;
    return rules?.denyUnknownAction === true && category !== CATEGORY.READ;
  }

  function allowOutOfScope() {
    return Object.freeze({ kind: 'allow', rule: 'out-of-scope' });
  }

  /** 语义阶段拒绝用的审计字段：只写允许字段，不含参数原文；路径只留尾 4 段。 */
  function semanticFields(exec, action, target, meta, extra = {}) {
    const subject = subjectOf(exec?.name, action);
    return {
      ...(subject === undefined ? {} : { subject }),
      actor: meta.actor,
      action,
      target: redactPath(target),
      tool: exec?.name,
      decision: 'deny',
      agent: { kind: meta.kind },
      ...(meta.operationId === undefined ? {} : { operationId: meta.operationId }),
      ...extra,
    };
  }

  /**
   * 受保护路径阶段（protectPaths）。任何一步无法判定都按拒绝处理，
   * 但拒绝文案不含路径、errno 或异常文本。
   */
  async function protectedPathDenial(exec, action, target, meta) {
    const workspaceRoot = exec?.agent?.session?.header?.cwd;
    const scopeFields = semanticFields(exec, action, target, meta, {
      rule: 'protectPaths',
      summary: `受控写 ${action} 无法确认受保护路径作用域，已拒绝`,
    });
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
      return denyWithEvidence(scopeFields, PATH_SCOPE_COPY(target), 'POLICY_PATH_SCOPE_UNAVAILABLE');
    }
    try {
      // 只为校验工作区本身可归一化；结果不参与判定，路径由下面的候选逐个归一化。
      canonicalize(workspaceRoot);
    } catch {
      return denyWithEvidence(scopeFields, PATH_SCOPE_COPY(target), 'POLICY_PATH_SCOPE_UNAVAILABLE');
    }
    const collected = collectPathCandidates(exec?.arguments, { workspaceRoot });
    const unresolvable = (field) => denyWithEvidence(
      semanticFields(exec, action, target, meta, {
        rule: 'protectPaths',
        summary: `受控写 ${action} 的参数 ${field} 无法确认真实路径，已拒绝`,
      }),
      PATH_UNRESOLVABLE_COPY(field, target),
      'POLICY_PATH_UNRESOLVABLE',
    );
    if (collected.truncated === true) return unresolvable('path');
    for (const candidate of collected.candidates) {
      // 超长路径被截断后就不再是原值：按"无法确认真实路径"拒绝，而不是拿截断值去判。
      if (candidate.truncated === true) return unresolvable(candidate.field);
      let judged;
      try {
        // 相对参数按会话工作区解释；绝对参数原样归一化。两者都走同一条 canonicalize。
        const candidatePath = isAbsolute(candidate.value)
          ? candidate.value
          : resolvePath(workspaceRoot, candidate.value);
        judged = judgeProtectedPath(candidatePath, { workspaceRoot, roots: protectedRoots });
      } catch {
        return unresolvable(candidate.field);
      }
      if (judged.judged !== true || judged.protected !== true) continue;
      const label = judged.kind === 'name' ? judged.pattern : '配置追加的保护范围';
      return denyWithEvidence(
        semanticFields(exec, action, target, meta, {
          rule: 'protectPaths',
          ruleIds: judged.ruleIds,
          summary: `受控写 ${action} 命中受保护路径（${judged.category}），已拒绝`,
        }),
        PROTECTED_PATH_COPY(target, label),
        'POLICY_PROTECTED_PATH',
      );
    }
    return undefined;
  }

  function check(toolName, request = {}) {
    const action = actionFor(toolName) ?? (isControlled(toolName) ? toolName : undefined);
    if (action === undefined) {
      return Object.freeze({ action: 'allow', rule: 'out-of-scope', reason: `tool "${toolName}" is not under policy control` });
    }
    const decision = decideAction({ catalog, rules, action, target: request?.target });
    onDecision?.(decision);
    return decision;
  }

  async function settle(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    // 结清即释放：`admitted` 只用来在放行与结清之间挡住同一个 callId 的并发重放，
    // 留着已结清的条目会把执行对象（含正文）一直强引用到插件卸载。
    if (entry.exec?.callId !== undefined) admitted.delete(String(entry.exec.callId));
    // 失败/取消/未知的调用没有换来一个可复用的"允许"：撤掉缓存，重试仍要重新确认。
    if (entry.cacheKey !== undefined && outcome.decision !== 'executed') {
      decisionCache?.delete?.(entry.cacheKey);
    }
    const promise = audit.settle(entry.receipt, { decision: outcome.decision, rule: outcome.rule ?? entry.decision?.rule, ...outcome.extra });
    pendingSettlements.add(promise);
    try {
      await promise;
    } finally {
      pendingSettlements.delete(promise);
    }
  }

  /**
   * 判定顺序固定为：动作解析 → 身份 → 未登记动作 → 人工留痕 → 受保护路径 →
   * 内容闸 → 确认 → 审计 → 回执；每个开关命中时只写一条拒记录。
   * Returns `{kind:'allow'}` or `{kind:'deny', reason}`.
   */
  async function admit(ctx, exec, action) {
    // One execution object gets exactly one admission, even under concurrent
    // prepare listeners; a second one must not mint another receipt.
    if (approved.has(exec) || admitting.has(exec)) {
      return deny('this execution was already admitted by the policy gate');
    }
    admitting.add(exec);
    try {
      return await admitOnce(ctx, exec, action);
    } finally {
      admitting.delete(exec);
    }
  }

  async function admitOnce(ctx, exec, action) {
    const target = targetOf(exec);
    // 判定顺序（AC-8）：动作解析 → 身份 → 人工留痕 → 未登记动作 → 受保护路径 →
    // 流程闸 → 内容闸 → 确认 → 审计 → 回执。前三个语义阶段命中即拒绝并留证据，卡片
    // 无法翻转。人工留痕排在未登记之前：未登记的人工留痕动作应当报"人工留痕不能由
    // agent 写"，而不是被误报成"未登记"，与 catalog.decideAction 的口径一致。
    if (!(catalog instanceof Map)) {
      return deny('no compiled policy catalog is available', 'POLICY_CATALOG_UNAVAILABLE');
    }
    const registered = isControlled(action);
    const category = classifyCategory(action);
    if (!registered && !requiresGate(action)) return allowOutOfScope();
    const persona = personaOf(exec?.agent);
    const kind = agentKindOf(exec);
    const operationId = exec?.callId === undefined ? undefined : String(exec.callId);
    // 来源不拒绝写入：子代理需要人确认时由主会话代问（见确认段），只有找不到可代问的根才拒。
    const actor = normalizeActor(await getActor?.(ctx));
    if (actor === undefined) {
      return deny(IDENTITY_COPY(action));
    }
    const meta = { actor, kind, operationId };
    if (category === CATEGORY.HUMAN_RECORD && rules?.denyHumanRecord === true) {
      // 人工留痕：不执行、不弹卡、不留正文；证据里只有动作与规则。
      return denyWithEvidence(
        semanticFields(exec, action, target, meta, {
          rule: 'denyHumanRecord',
          ruleIds: ['human-record'],
          summary: `人工留痕动作 ${action} 命中 denyHumanRecord，已拒绝`,
        }),
        HUMAN_RECORD_COPY(action),
        'POLICY_HUMAN_RECORD',
      );
    }
    if (!registered && rules?.denyUnknownAction === true && category !== CATEGORY.READ) {
      return denyWithEvidence(
        semanticFields(exec, action, target, meta, {
          rule: 'denyUnknownAction',
          ruleIds: ['unregistered-action'],
          summary: `未登记动作 ${action} 命中 denyUnknownAction，已拒绝`,
        }),
        UNREGISTERED_COPY(action),
        'POLICY_UNREGISTERED_ACTION',
      );
    }
    if (!registered) return allowOutOfScope();
    if (rules?.protectPaths === true) {
      const denied = await protectedPathDenial(exec, action, target, meta);
      if (denied !== undefined) return denied;
    }
    // #417 的 enforceProcessRules 接入点：流程事实判定必须排在受保护路径之后、
    // 内容闸之前；该开关当前仍按"未实现"拒绝挂载，不生成这一阶段。
    const decision = decideAction({ catalog, rules, action, target });
    onDecision?.(decision);
    if (decision.action === 'deny') {
      return deny(decision.reason);
    }
    const sessionId = sessionIdOf(exec);
    const digest = staticDigestOf(exec);
    const subject = subjectOf(exec?.name, action);
    // 正文只解析一次：流程闸、内容闸与执行摘要必须看同一份快照。
    // 流程闸打开时要读正文（建 PR 正文、评审正文都在 `exec.content`），
    // 因此不能只在内容闸打开时才解析。
    const scanning = rules?.contentGate === true;
    const needsContent = scanning || rules?.enforceProcessRules === true;
    const content = needsContent ? await resolveContent(exec) : undefined;
    const contentDigest = content !== undefined
      ? digestContent(digestInput(exec, content.readable ? content.value : '[content-unavailable]'))
      : typeof exec?.content === 'function'
        ? await contentDigestOf(exec)
        : contentDigestOf(exec);
    // 流程闸先于内容闸：先判"这一步该不该发生"，再看"内容能不能发出去"。
    const process = rules?.enforceProcessRules === true
      ? evaluateProcess(exec, action, content, (error) => {
        // 只在求值抛错时触发：消息可能包含规则名，不含业务正文。
        const detail = typeof error?.message === 'string' ? error.message : String(error);
        warn?.(`[forge-policy] 流程规则求值失败，本次按不可确认拒绝：${detail}`);
        try {
          onDecision?.({ kind: 'process-error', action, message: detail });
        } catch {
          // 观察回调失败不影响判定。
        }
      })
      : undefined;
    // 卡片发给谁、通道当下是否可用：命中规则分类与确认原因都要用这一份判定。
    // 子代理自己收不到卡片（宿主 assertLiveRoot 只认存活根），交给它的根会话代问。
    let cardAgent = exec?.agent;
    if (persona === PERSONA.CHILD) cardAgent = rootOf(ctx, exec?.agent);
    const channelAvailable = confirmations !== undefined
      && typeof confirmations.available === 'function'
      && confirmations.available({ ctx, agent: cardAgent }) === true;
    if (process !== undefined && process.deny.length > 0) {
      const processRuleIds = [...new Set(process.deny.map((item) => item.rule))];
      return denyWithEvidence({
        ...(subject === undefined ? {} : { subject }),
        actor,
        action,
        target,
        tool: exec?.name,
        decision: 'deny',
        rule: 'process-rule-denied',
        operationId,
        agent: { kind },
        ruleIds: processRuleIds,
        summary: `受控写 ${action} 不满足流程前置条件（${processRuleIds.join('、')}）`,
      }, PROCESS_DENIED_COPY(action, process.deny), 'POLICY_PROCESS_DENIED');
    }
    const scanned = scanning ? scanContent(action, exec?.arguments, content) : undefined;
    // 命中的规则与未扫全的字段：拒绝、确认两段记录与 begin 共用这一份元数据，
    // 审计才能说明"为什么问"以及"哪里没扫全"（`字段:原因`，如 `body:truncated`）。
    // 命中规则分两份：`ruleIds` 是这次调用命中的全部规则（begin 记录用），
    // `askedRuleIds` 只含真正进了确认卡的原因——没有升级为确认的软命中如果写进
    // asked/answered，审计就会声称"因为某条流程规则才问"，而卡片里并没有它。
    const processRuleIds = process === undefined ? [] : process.confirm.map((item) => item.rule);
    const contentRuleIds = scanned === undefined ? [] : scanned.findings.map((finding) => finding.rule);
    const processAsked = processRuleIds.length > 0
      && (decision.action === 'confirm' || channelAvailable);
    const hitRules = [...processRuleIds, ...contentRuleIds];
    const ruleIds = hitRules.length === 0 ? undefined : [...new Set(hitRules)];
    const askedRuleIds = (() => {
      const asked = [...(processAsked ? processRuleIds : []), ...contentRuleIds];
      return asked.length === 0 ? undefined : [...new Set(asked)];
    })();
    const contentSkipped = scanned === undefined || scanned.skipped.length === 0
      ? undefined
      : [...new Set(scanned.skipped.map((item) => `${item.field}:${item.reason}`))];
    const contentTruncated = scanned?.truncated === true ? true : undefined;
    // 扫描器自身失败时按不可确认拒绝：异常不代表没有命中，放行会让 H1/H2 形同虚设。
    if (scanned?.failed === true) {
      return denyWithEvidence({
        ...(subject === undefined ? {} : { subject }),
        actor,
        action,
        target,
        tool: exec?.name,
        decision: 'deny',
        rule: 'content-scan-failed',
        operationId,
        agent: { kind },
        ...(contentSkipped === undefined ? {} : { contentSkipped }),
        summary: `受控写 ${action} 的正文扫描失败，按不可确认拒绝`,
      }, CONTENT_SCAN_FAILED_COPY(action), 'POLICY_CONTENT_SCAN_FAILED');
    }
    if (scanned !== undefined && scanned.hard.length > 0) {
      // H1/H2 不可确认：连卡片都不弹，直接留证据拒绝。
      return denyWithEvidence({
        ...(subject === undefined ? {} : { subject }),
        actor,
        action,
        target,
        tool: exec?.name,
        decision: 'deny',
        rule: 'content-hard-block',
        operationId,
        agent: { kind },
        ruleIds,
        ...(contentSkipped === undefined ? {} : { contentSkipped }),
        ...(contentTruncated === undefined ? {} : { truncated: true }),
        summary: `受控写 ${action} 的正文命中不可放行的内容风险`,
      }, CONTENT_HARD_COPY(action, scanned.hard), 'POLICY_CONTENT_HARD');
    }
    // 确认原因按顺序合并：动作确认在前、内容风险在后，客户端据此走分步表单（D25）。
    const reasons = [];
    if (decision.action === 'confirm') reasons.push('action');
    // 软流程命中：本来就要弹卡、或当下通道可用时升级为确认；两者都不成立时
    // 按放行 + 审计处理（与内容软命中同口径，D36）。
    if (processAsked) reasons.push('process');
    if (scanned !== undefined
      && (scanned.confirm.length > 0 || (scanned.soft.length > 0 && decision.action === 'confirm'))) {
      reasons.push('content');
    }
    const reasonsKey = reasons.join(',');
    let rule = decision.rule;
    let cacheKey;
    if (reasons.length > 0) {
      // 来源判定在查缓存之前：命中缓存也不能让子代理替人跳过确认。
      // cardAgent 上面已解析：找不到可代问的根会话时，需要人确认的写入只能拒绝。
      if (cardAgent === undefined) {
        return denyWithEvidence({
          action,
          target,
          tool: exec?.name,
          decision: 'deny',
          rule: 'confirm-delegated-refused',
          code: CONFIRM_CODES.DELEGATED,
          operationId,
          agent: { kind },
          summary: delegationSummary(action),
        }, confirmDelegatedCopy(action), CONFIRM_CODES.DELEGATED);
      }
      const callId = callIdOf(exec);
      // 读不到正文时摘要只是占位串：两次"读不到"会算出同一个键，这样的决定不能复用，
      // 否则确认过的是一次看不见的正文，重试时同样看不见却会被当作同一份内容放行。
      const cacheable = content === undefined || content.readable !== false;
      const key = cacheable
        ? reuseKeyOf({ tool: exec?.name, callId, action, digest, contentDigest })
        : undefined;
      const hit = key !== undefined && decisionCache !== undefined ? decisionCache.peek(key) : undefined;
      if (hit !== undefined
        && hit.digest === digest
        && hit.contentDigest === contentDigest
        && hit.action === action
        && hit.actor === actor
        && hit.session === sessionId
        && hit.reasons === reasonsKey) {
        // 同一个决定的重试：不再打扰用户，但仍要过身份复验、一次性收据与执行后复验。
        decisionCache.touch(key);
        cacheKey = key;
        rule = 'reused-decision';
      } else {
        const card = buildConfirmationCard({
          action,
          target,
          args: exec?.arguments ?? {},
          reasons,
          origin: persona === PERSONA.CHILD ? 'subagent' : 'root',
        });
        const askedAt = clock();
        const asked = await writeRecord({
          ...(subject === undefined ? {} : { subject }),
          actor,
          action,
          target,
          tool: exec?.name,
          decision: 'pending',
          rule: 'confirm-required',
          operationId,
          agent: { kind },
          summary: `受控写 ${action} 需要人工确认（${reasons.map((reason) => CONFIRM_REASONS[reason]).join('；')}）${persona === PERSONA.CHILD ? '，已转交主会话代问' : ''}`,
          ...(askedRuleIds === undefined ? {} : { ruleIds: askedRuleIds }),
          ...(contentSkipped === undefined ? {} : { contentSkipped }),
          ...(contentTruncated === undefined ? {} : { truncated: true }),
          phase: 'asked',
        });
        // 先有记录，再问人：asked 写不进去时连卡片都不该弹。
        if (!asked) return deny(CONFIRM_RECORD_FAILED_COPY(action), CONFIRM_CODES.ERROR);
        confirmationCount += 1;
        const verdict = (await confirmations?.ask({
          ctx,
          agent: cardAgent,
          action,
          questions: card.questions,
          timeoutMs: confirmationTimeoutMs,
          signal: exec?.signal,
        })) ?? { decision: 'deny', code: CONFIRM_CODES.UNAVAILABLE };
        const answeredOk = await writeRecord({
          ...(subject === undefined ? {} : { subject }),
          actor,
          action,
          target,
          tool: exec?.name,
          decision: verdict.decision,
          ...(verdict.decision === 'allow' ? {} : { code: verdict.code }),
          rule: 'confirm-required',
          operationId,
          agent: { kind },
          durationMs: clock() - askedAt,
          summary: `受控写 ${action} 的确认结论：${answerSummary(verdict.decision, verdict.code)}`,
          ...(askedRuleIds === undefined ? {} : { ruleIds: askedRuleIds }),
          ...(contentSkipped === undefined ? {} : { contentSkipped }),
          ...(contentTruncated === undefined ? {} : { truncated: true }),
          phase: 'answered',
        });
        if (!answeredOk) return deny(CONFIRM_RECORD_FAILED_COPY(action), CONFIRM_CODES.ERROR);
        if (verdict.decision !== 'allow') {
          return deny(denyCopyOf(verdict.code, action, confirmationTimeoutMs), verdict.code ?? CONFIRM_CODES.ERROR);
        }
        if (key !== undefined && decisionCache !== undefined) {
          decisionCache.set({
            key,
            tool: exec?.name,
            callId,
            action,
            digest,
            contentDigest,
            actor,
            session: sessionId,
            reasons: reasonsKey,
            decidedAt: clock(),
          });
          cacheKey = key;
        }
        rule = 'confirm-allowed';
      }
    }
    let receipt;
    try {
      receipt = await audit.begin({
        ...(subject === undefined ? {} : { subject }),
        actor,
        action,
        target,
        tool: exec?.name,
        decision: 'allow',
        rule,
        operationId,
        policyVersion: undefined,
        agent: { kind },
        summary: `受控写 ${action}（目标 ${target ?? '(未提供)'}）`,
        params: summarizeArguments(exec?.arguments ?? {}),
        contentDigest,
        ...(ruleIds === undefined ? {} : { ruleIds }),
        ...(contentSkipped === undefined ? {} : { contentSkipped }),
        ...(contentTruncated === undefined ? {} : { truncated: true }),
      });
    } catch (error) {
      // 放行结论没能落成记录：本次不算一次成功的"允许"，撤掉复用缓存，重试仍要重新确认。
      if (cacheKey !== undefined) decisionCache?.delete?.(cacheKey);
      if (error?.code === 'POLICY_AUDIT_GAP_OUTSTANDING') return deny(AUDIT_OUTSTANDING_COPY);
      return deny(AUDIT_FAILURE_COPY(action, audit?.sinks?.()?.kind ?? 'memory', target));
    }
    const entry = {
      exec,
      contentDigest,
      action,
      target,
      actor,
      staticDigest: digest,
      decision,
      receipt,
      cacheKey,
      startedAt: receipt.startedAt,
      used: false,
      settled: false,
    };
    approved.set(exec, entry);
    if (exec?.callId !== undefined) admitted.set(String(exec.callId), exec);
    return Object.freeze({ kind: 'allow' });
  }

  async function cancel(entry, reason, rule = 'cancelled') {
    await settle(entry, { decision: 'cancelled', rule });
    return deny(reason);
  }

  async function preExecute(ctx, exec, next) {
    const action = actionFor(exec?.name);
    if (action === undefined || !requiresGate(action)) {
      return typeof next === 'function' ? next() : Object.freeze({ kind: 'allow' });
    }
    if (disposed) return deny('the policy gate is no longer mounted');
    // A final-result observer settles asynchronously; the next controlled call
    // waits for it so a failed settlement cannot slip through as a fresh begin.
    if (pendingSettlements.size > 0) await Promise.allSettled([...pendingSettlements]);
    if (typeof audit?.isDegraded === 'function' && audit.isDegraded()) return deny(AUDIT_OUTSTANDING_COPY);
    const admission = await admit(ctx, exec, action);
    if (admission.kind !== 'allow') return admission;
    const entry = approved.get(exec);
    if (typeof next !== 'function') return admission;
    let downstream;
    try {
      downstream = await next();
    } catch (error) {
      await settle(entry, { decision: 'error', rule: 'downstream-failed' });
      throw error;
    }
    if (downstream !== undefined && downstream?.kind !== 'allow') {
      return cancel(entry, downstream?.reason ?? 'a downstream stage refused the call', 'downstream-refused');
    }
    const changedReason = await recheck(entry, exec, ctx);
    if (changedReason !== undefined) return cancel(entry, changedReason.reason);
    return Object.freeze({ kind: 'allow' });
  }

  /**
   * 放行之后、执行之前的最终复验：卸载、取消、参数改写、身份切换，任何一项变化都不能
   * 让这次写入落地。`tools/pre-execute` 与 `executeAction` 共用这一份判定，避免两条入口
   * 各自维护、慢慢走样。
   */
  async function recheck(entry, exec, ctx) {
    if (disposed) return { reason: 'the policy gate was unloaded before the call started', rule: 'unloaded' };
    if (exec?.signal?.aborted === true) return { reason: 'the call was cancelled after it was admitted', rule: 'cancelled' };
    if (staticDigestOf(exec) !== entry.staticDigest) {
      return { reason: 'the arguments changed before the call started', rule: 'arguments-changed' };
    }
    if (entry.contentDigest !== undefined) {
      const current = await contentDigestOf(exec);
      if (current !== entry.contentDigest) {
        return { reason: 'the content changed before the call started', rule: 'content-changed' };
      }
    }
    if (typeof getActor === 'function') {
      const current = normalizeActor(await getActor(ctx));
      if (current !== entry.actor) return { reason: 'the IAM identity changed after the call was admitted', rule: 'identity-changed' };
    }
    return undefined;
  }

  function guard(ctxOrExec, maybeExec) {
    const exec = maybeExec ?? ctxOrExec;
    const action = actionFor(exec?.name);
    if (action === undefined || !requiresGate(action)) return undefined;
    if (disposed) return 'the policy gate is no longer mounted';
    const entry = approved.get(exec);
    if (entry === undefined) {
      return exec?.callId !== undefined && admitted.has(String(exec.callId))
        ? 'this call id was already admitted by another call'
        : 'this call was not admitted by the policy gate';
    }
    if (entry.used) return 'the admission receipt for this call was already used';
    if (typeof audit?.isDegraded === 'function' && audit.isDegraded()) {
      return 'an earlier audit gap is outstanding; the call is refused until it is acknowledged';
    }
    if (pendingSettlements.size > 0) return 'a previous settlement is still pending; the call is refused';
    if (exec?.signal?.aborted === true) return 'the call was cancelled after it was admitted';
    if (staticDigestOf(exec) !== entry.staticDigest) return 'the arguments changed after the call was admitted';
    // 普通对象正文在反序列化后仍可被宿主或下游改写：同步路径也要绑定扫描时的那一份。
    if (entry.contentDigest !== undefined
      && typeof exec?.content !== 'function'
      && contentDigestOf(exec) !== entry.contentDigest) {
      return 'the content changed after the call was admitted';
    }
    if (typeof getActor === 'function' && normalizeActor(getActor(undefined)) !== entry.actor) {
      return 'the IAM identity changed after the call was admitted';
    }
    entry.used = true;
    return undefined;
  }


/** 业务结果里的结论：失败/拒绝/未知都不算一次成功的"允许"，据此撤掉复用缓存。 */
const BUSINESS_FAILED = new Set(['failed', 'denied', 'error']);
const BUSINESS_UNKNOWN = new Set(['unknown', 'pending', 'timeout']);

function businessDecisionOf(result) {
  const candidates = [result, result?.value, result?.result];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const status = typeof candidate.status === 'string' ? candidate.status.trim().toLowerCase() : '';
    if (status === '') continue;
    if (BUSINESS_FAILED.has(status)) return 'error';
    if (BUSINESS_UNKNOWN.has(status)) return 'unknown';
  }
  return 'executed';
}

  async function postExecute(exec, result) {
    const entry = approved.get(exec);
    if (entry === undefined || entry.settled) return;
    const failed = result?.isError === true || result?.kind === 'error';
    await settle(entry, { decision: failed ? 'error' : businessDecisionOf(result) });
  }

  /** `recheck` 的拒绝文案：说清"没有执行"，也不把内部规则名抛给用户。 */
  function executeDenyCopy(action, rule) {
    if (rule === 'cancelled') return `受控写「${action}」已取消：调用在排队等待期间被取消，本次未执行。`;
    if (rule === 'identity-changed') return `受控写「${action}」未执行：等待期间登录身份发生变化，请重新发起该动作。`;
    if (rule === 'arguments-changed') return `受控写「${action}」未执行：等待期间参数发生变化，请重新发起该动作。`;
    if (rule === 'content-changed') return `受控写「${action}」未执行：等待期间正文内容发生变化，请重新发起该动作。`;
    if (rule === 'unloaded') return `受控写「${action}」未执行：策略插件已卸载，本次未执行。`;
    return `受控写「${action}」未执行：放行后状态发生变化。`;
  }

  async function executeAction(ctx, action, exec, operation) {
    if (typeof operation !== 'function') {
      return { kind: 'error', text: '受控写缺少执行体，已拒绝执行。' };
    }
    if (!requiresGate(action)) return operation();
    if (disposed) return { kind: 'error', text: 'the policy gate is no longer mounted' };
    const record = exec ?? {};
    const admission = await admit(ctx, record, action);
    // 拒绝时 code 必须跟着结构化结果一起交出去，调用方不能只有一句自然语言可用。
    if (admission.kind !== 'allow') {
      return admission.code === undefined
        ? { kind: 'error', text: admission.reason }
        : { kind: 'error', text: admission.reason, code: admission.code };
    }
    const entry = approved.get(record);
    const changedReason = await recheck(entry, record, ctx);
    if (changedReason !== undefined) {
      await settle(entry, { decision: 'cancelled', rule: changedReason.rule });
      return { kind: 'error', text: executeDenyCopy(action, changedReason.rule) };
    }
    // 复验与执行之间不能再有 await：普通对象正文在执行体拿到之前必须仍是扫描时那一份。
    if (entry.contentDigest !== undefined
      && typeof record?.content !== 'function'
      && contentDigestOf(record) !== entry.contentDigest) {
      await settle(entry, { decision: 'cancelled', rule: 'content-changed' });
      return { kind: 'error', text: executeDenyCopy(action, 'content-changed') };
    }
    entry.used = true;
    let result;
    try {
      result = await operation();
    } catch (error) {
      await settle(entry, { decision: 'error', rule: 'operation-failed' });
      throw error;
    }
    const current = normalizeActor(await getActor?.(ctx));
    if (typeof getActor === 'function' && current !== entry.actor) {
      await settle(entry, { decision: 'error', rule: 'identity-changed' });
      return { kind: 'error', text: '执行后复验发现 IAM 身份已变化，本次动作结果按失败处理。' };
    }
    const failed = result?.isError === true || result?.kind === 'error';
    await settle(entry, { decision: failed ? 'error' : businessDecisionOf(result) });
    return result;
  }

  function dispose() {
    disposed = true;
    for (const entry of admitted.values()) {
      const admittedEntry = approved.get(entry);
      if (admittedEntry !== undefined && !admittedEntry.settled) {
        void settle(admittedEntry, { decision: 'unknown', rule: 'gate-disposed' });
      }
    }
    admitted.clear();
  }

  return Object.freeze({
    stages,
    actionFor,
    isEnforced,
    check,
    preExecute,
    guard,
    postExecute,
    executeAction,
    /** 本次挂载内真正发起过的人工询问次数（复用命中不计数）。 */
    confirmationCount: () => confirmationCount,
    dispose,
    now: clock,
    /** 诊断用：还在"已放行、未结清"之间的执行数（结清后必须归零，否则执行对象被长期持有）。 */
    pendingAdmissions: () => admitted.size,
  });
}
