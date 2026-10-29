/**
 * `@heluo/forge-gitee` 的只读面（TK4，AC-15）：请求校验、信封归一与三个读工具定义。
 *
 * 这一段只做三件事，且都不联网、不起子进程：
 * 1. **请求校验**：动作必须落在 `gitee.*` 只读命名空间，目标不能为空；不合格的请求在
 *    子进程之前就拒（`UNKNOWN_ACTION`/`MISSING_TARGET`），而不是让 CLI 报错。
 * 2. **信封归一**：适配器给的是"事实"（`succeeded`/`unknown`），这里补成 AC-15 要求的读信封
 *    ——`provider` 必填、五项齐全（`status`/`source_revision`/`observed_at`/`provider`/
 *    `result_refs`），失败一律翻译成**固定 reason 枚举**，绝不抛错、绝不自动重试。
 * 3. **降级到 `unknown` 而不是猜**（TECHNICAL §4.2）：结果不是键值对象、缺结构化状态、输出
 *    被截断、取不到事实版本、混入 GitHub 语义字段——这五类都降级成 `unknown` 并写明
 *    `error_code`，同时保留已取到的载荷与 `missing_fields`（"取不到"与"没有"不是一件事）。
 *
 * 三条与 devops 对齐但不共享代码的不变量（AC-12）：
 * - `provider` 只认 `GITEE_PROVIDER`：别的 provider 的结果不许被盖上 gitee 的章；
 * - 主机守卫只认企业内主机：配置主机为空时**不判定**（默认安装即可只读，r3 的"装上就能用"），
 *   一旦配置了，就拒绝公共 SaaS 主机、拒绝指向别处的目标与结果链接（`HOST_NOT_ENTERPRISE`）；
 * - 失败不重试：`retry_policy` 只声明"允许再发一次新的只读调用"（`read_recheck`），本模块
 *   自己绝不重发；被拒的动作（策略/凭据/服务已卸载）给 `denied` 且 `retry_policy: null`。
 *
 * 归一为什么可以幂等：`index.mjs` 在服务边界也会调 `normalizeGiteeReadResult`，工具层拿到
 * 的是**已经归一过的信封**。识别出信封就原样返回，否则二次归一会把清单读（`source_revision`
 * 恒为 `null`）误判成"缺事实版本"再降一级。
 */

import { GITEE_LIST_LIMIT, GITEE_PROVIDER } from './gitee-adapter.mjs';

/** 只读动作（唯一真源）：入口 `readActions()`、补丁层目录与工具定义都从这里取。 */
export const GITEE_READ_ACTIONS = Object.freeze([
  'gitee.repository.read',
  'gitee.issue.read',
  'gitee.pr.read',
]);

/**
 * 读信封的状态（TECHNICAL §4.3 的四个值）：
 * - `succeeded`：拿到了完整事实，且事实版本（`source_revision`）可核对；
 * - `failed`：确定的失败（CLI 不存在、非零退出、主机非企业、缺令牌、请求越界）；
 * - `partial`：拿到了事实但有字段取不到（`missing_fields` 非空）；
 * - `unknown`：可能已经执行，但事实不可确认（超时、截断、非 JSON、缺版本）。
 */
export const GITEE_READ_STATUSES = Object.freeze(['succeeded', 'failed', 'partial', 'unknown']);

/**
 * 工具边界上额外可能出现的一个状态：请求在"读之前"就被准入拒绝（策略未登记/拒绝、凭据
 * 阻断、服务已卸载）。它不是读结果，所以单列，不混进上面四个事实状态里。
 */
export const GITEE_READ_BOUNDARY_STATUSES = Object.freeze(['denied']);

/**
 * 读失败原因固定枚举（AC-15）：自由文本只进 `message`，不新增枚举值。
 * 前六个是 AC-15 点名的六类失败，其余是适配器/准入侧的固定原因。
 */
export const READ_REASONS = Object.freeze({
  /** 动作不在 `gitee.*` 只读命名空间（例如把 devops 的 `issue.read` 传进来）。 */
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  /** 目标为空：没有仓库或工作项可读，不起子进程。 */
  MISSING_TARGET: 'MISSING_TARGET',
  /** 工具定义拿到的服务端口没有 `read()`：装配期错误，不注册哑工具。 */
  NO_READER: 'NO_READER',
  /** 缺令牌环境变量（只在环境变量里取凭据，缺即拒）。 */
  AUTH_MISSING: 'AUTH_MISSING',
  /** CLI 配置目录存在持久令牌：安全阻断（`denied`，零子进程）。 */
  GITEE_PERSISTENT_TOKEN: 'GITEE_PERSISTENT_TOKEN',
  /** 主机不是企业内 Gitee（公共 SaaS 域，或目标/结果链接指向别的主机）。 */
  HOST_NOT_ENTERPRISE: 'HOST_NOT_ENTERPRISE',
  /** CLI 未找到/无法启动（`execFile` ENOENT 等）：AC-15 的"CLI 未找到"。 */
  SPAWN_FAILED: 'SPAWN_FAILED',
  /** 退出码非 0。 */
  NONZERO_EXIT: 'NONZERO_EXIT',
  /** CLI 不认识 `--json` 字段（F1 未验的收缩点）。 */
  UNSUPPORTED_FIELD: 'UNSUPPORTED_FIELD',
  /** 参数不在声明白名单里（`list`/`state`/`limit`/`json` 之外）。 */
  ARG_NOT_WHITELISTED: 'ARG_NOT_WHITELISTED',
  /** 参数值不合法（`list` 非布尔、`json` 为空等）。 */
  ARG_INVALID: 'ARG_INVALID',
  /** 必填参数缺失（写动作才有；读动作保留同名原因以统一消费）。 */
  ARG_MISSING: 'ARG_MISSING',
  /** `--json` 请求了未声明的字段。 */
  JSON_FIELD_NOT_DECLARED: 'JSON_FIELD_NOT_DECLARED',
  /** argv 里出现禁项（纵深防御，正常路径拼不出来）。 */
  FORBIDDEN_ARGV: 'FORBIDDEN_ARGV',
  /** 命令超时：可能已经执行，事实不可确认。 */
  TIMEOUT: 'TIMEOUT',
  /** 输出不是合法 JSON/结构不符。 */
  MALFORMED_RESULT: 'MALFORMED_RESULT',
  /** 输出被 1 MiB 上限截断：AC-15 的"输出截断"。 */
  OUTPUT_TRUNCATED: 'OUTPUT_TRUNCATED',
  /** 结果里没有可翻译的结构化状态。 */
  NO_STRUCTURED_STATUS: 'NO_STRUCTURED_STATUS',
  /** 结果里没有 `updated_at`：事实版本取不到，降级 `unknown`（不编版本）。 */
  MISSING_SOURCE_REVISION: 'MISSING_SOURCE_REVISION',
  /** 结果里混入 GitHub 语义字段（`mergedAt`/`statusCheckRollup` 等）：不采信。 */
  MIXED_PROVIDER_FIELDS: 'MIXED_PROVIDER_FIELDS',
  /** 其余命令级错误（含未登记的适配器错误码）：状态按"可能已执行"处理。 */
  COMMAND_FAILED: 'COMMAND_FAILED',
  /** 策略层拒绝（未登记动作/显式 deny）。 */
  POLICY_DENIED: 'POLICY_DENIED',
  /** 插件已卸载（`GITEE_STATUS_DISPOSED`）：不再执行任何读取。 */
  SERVICE_DISPOSED: 'GITEE_STATUS_DISPOSED',
});

const REASON_VALUES = new Set(Object.values(READ_REASONS));

/**
 * 适配器/CLI 的错误码 → 读原因码的别名（同义不同名，只有这几个）。
 * 其余错误码若本身已是 `READ_REASONS` 的值就直接沿用。
 */
const CODE_ALIASES = Object.freeze({
  PERSISTENT_TOKEN: READ_REASONS.GITEE_PERSISTENT_TOKEN,
  UNKNOWN_READ_ACTION: READ_REASONS.UNKNOWN_ACTION,
  UNKNOWN_COMMAND: READ_REASONS.COMMAND_FAILED,
  GITEE_STATUS_DISPOSED: READ_REASONS.SERVICE_DISPOSED,
});

/** `denied` 信封的 `rule`（与写动作的 rule 语义对齐，便于统一消费）。 */
const DENIED_RULES = Object.freeze({
  POLICY_DENIED: 'policy-denied',
  GITEE_PERSISTENT_TOKEN: 'persistent-credential',
  GITEE_STATUS_DISPOSED: 'service-disposed',
});

/** 降级类原因：事实不可确认（`unknown`），而不是"确定失败"。 */
const UNKNOWN_REASONS = new Set([
  READ_REASONS.TIMEOUT,
  READ_REASONS.MALFORMED_RESULT,
  READ_REASONS.OUTPUT_TRUNCATED,
  READ_REASONS.NO_STRUCTURED_STATUS,
  READ_REASONS.MISSING_SOURCE_REVISION,
  READ_REASONS.MIXED_PROVIDER_FIELDS,
  READ_REASONS.COMMAND_FAILED,
]);

/** 允许再发一次新的只读调用（本模块自己绝不重发）。被拒动作没有下一次。 */
const RETRY_POLICY = 'read_recheck';

/** 公共 SaaS 主机：企业内 Gitee 不该是这些；配成它们说明配置指错了地方。 */
const PUBLIC_SAAS_HOSTS = Object.freeze([
  'gitee.com',
  'www.gitee.com',
  'api.gitee.com',
  'github.com',
  'www.github.com',
  'api.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
]);

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const MAX_MESSAGE = 240;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 单行诊断：去换行、截断，避免把整段 CLI stderr 塞进信封。 */
const clip = (value, limit = MAX_MESSAGE) => {
  const flat = text(value).replace(/\s+/g, ' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

const nowIso = (value) => {
  const candidate = text(value);
  return candidate === '' ? new Date().toISOString() : candidate;
};

/**
 * 只读面错误：带固定 `code`（= 读原因码），可直接喂给 `normalizeGiteeReadError`。
 *
 * 只在**请求形状错误**（动作/目标/服务端口）与装配期缺端口时抛；命令级失败不抛，一律
 * 归一成 `failed`/`unknown` 信封，避免"二次抛错盖掉第一次的原因"。
 */
export class GiteeReadError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = 'GiteeReadError';
    this.code = reason;
    this.reason = reason;
    this.provider = GITEE_PROVIDER;
    this.detail = Object.freeze({ provider: GITEE_PROVIDER, ...detail });
  }
}

/**
 * 校验只读请求：动作必须是三个只读动作之一，目标必须是去空白后的非空字符串。
 *
 * 只做"读层能判"的两件事，目标**形状**（`group/repo`、`group/repo#12`、链接）留给适配器
 * ——那里是 argv 白名单的真源，重复一份只会在两处漂移。
 *
 * @param {unknown} action 动作名
 * @param {unknown} target 目标（仓库/工作项引用）
 * @returns {string} 去空白后的目标
 * @throws {GiteeReadError} `UNKNOWN_ACTION` / `MISSING_TARGET`
 */
export function assertGiteeReadRequest(action, target) {
  const actionKey = text(action);
  if (!GITEE_READ_ACTIONS.includes(actionKey)) {
    throw new GiteeReadError(
      READ_REASONS.UNKNOWN_ACTION,
      `只读动作必须是 ${GITEE_READ_ACTIONS.join(' / ')} 之一；收到 "${actionKey === '' ? '空' : actionKey}"`,
      { action: actionKey, actions: [...GITEE_READ_ACTIONS] },
    );
  }
  const targetRef = text(target);
  if (targetRef === '') {
    throw new GiteeReadError(READ_REASONS.MISSING_TARGET, `${actionKey} 缺少 target：没有仓库或工作项可读`, {
      action: actionKey,
    });
  }
  return targetRef;
}

/** 原因码 → 信封状态（`denied` 只在准入拒止时出现）。 */
function statusForReason(reason) {
  if (reason === READ_REASONS.POLICY_DENIED
    || reason === READ_REASONS.GITEE_PERSISTENT_TOKEN
    || reason === READ_REASONS.SERVICE_DISPOSED) return 'denied';
  if (UNKNOWN_REASONS.has(reason)) return 'unknown';
  return 'failed';
}

/** 已归一信封的识别：适配器事实里没有 `retry_policy`，所以这一键就是"归一过"的证据。 */
function isReadEnvelope(value) {
  if (!isPlainObject(value)) return false;
  if (value.provider !== GITEE_PROVIDER) return false;
  if (typeof value.action !== 'string' || value.action === '') return false;
  if (!GITEE_READ_STATUSES.includes(value.status) && !GITEE_READ_BOUNDARY_STATUSES.includes(value.status)) return false;
  return 'retry_policy' in value
    && 'source_revision' in value
    && 'observed_at' in value
    && 'error_code' in value
    && Array.isArray(value.result_refs)
    && Array.isArray(value.missing_fields);
}

/** 原因码识别：别名优先，其次必须是已登记的枚举值（未登记一律不采信）。 */
function reasonOfCode(code) {
  const key = text(code);
  if (key === '') return null;
  if (CODE_ALIASES[key] !== undefined) return CODE_ALIASES[key];
  return REASON_VALUES.has(key) ? key : null;
}

/** 错误 → 固定原因码。 */
function reasonForError(error) {
  const detail = isPlainObject(error?.detail) ? error.detail : {};
  if (detail.timedOut === true) return READ_REASONS.TIMEOUT;
  const mapped = reasonOfCode(error?.code) ?? reasonOfCode(error?.reason);
  if (mapped !== null) return mapped;
  if (Number.isInteger(detail.exitCode) && detail.exitCode !== 0) return READ_REASONS.NONZERO_EXIT;
  return READ_REASONS.COMMAND_FAILED;
}

function deniedRuleForReason(reason) {
  return DENIED_RULES[reason] ?? null;
}

/**
 * 拼读信封（唯一构造点）：固定十项在前，`message`/`rule`/载荷在有值时追加。
 *
 * 失败信封不带载荷、不带 `result_refs`——"没读到的东西不许当成事实交出去"。
 */
function buildEnvelope({
  action,
  targetRef,
  status,
  reason = null,
  observedAt,
  sourceRevision = null,
  resultRefs = [],
  missingFields = [],
  payload = null,
  message = '',
  rule = null,
}) {
  const body = {
    provider: GITEE_PROVIDER,
    action: text(action),
    target_ref: targetRef,
    status,
    source_revision: sourceRevision,
    result_refs: [...resultRefs],
    observed_at: observedAt,
    error_code: reason,
    retry_policy: status === 'denied' ? null : RETRY_POLICY,
    missing_fields: [...missingFields],
  };
  if (message !== '') body.message = clip(message);
  if (rule !== null) body.rule = rule;
  if (payload !== null) Object.assign(body, payload);
  return Object.freeze(body);
}

/** 失败信封：确定失败（`failed`）或被拒（`denied`），零载荷。 */
function failureEnvelope({ action, targetRef, reason, observedAt, message = '' }) {
  const status = statusForReason(reason);
  return buildEnvelope({
    action,
    targetRef,
    status,
    reason,
    observedAt,
    message,
    rule: deniedRuleForReason(reason),
  });
}

/** 适配器事实里的载荷：只搬已声明的结构键，不搬 `raw`/`rejected_field` 之类内部字段。 */
function payloadOf(facts) {
  const payload = {};
  if (facts.kind === 'object' || facts.kind === 'list') payload.kind = facts.kind;
  if (typeof facts.command === 'string' && facts.command !== '') payload.command = facts.command;
  if (isPlainObject(facts.object)) payload.object = facts.object;
  if (Array.isArray(facts.items)) payload.items = Object.freeze([...facts.items]);
  if (Number.isInteger(facts.count)) payload.count = facts.count;
  if (facts.truncated === true) payload.truncated = true;
  return payload;
}

/** 主机名归一：去 scheme、路径、大小写与尾部点；空值表示"未配置"。 */
function normalizeHost(value) {
  const raw = text(value).toLowerCase();
  if (raw === '') return '';
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = withoutScheme.split('/')[0].split('?')[0].split('#')[0];
  return host.replace(/\.+$/, '');
}

/** 比较主机时忽略端口差异（`gitee.example.com` 与 `gitee.example.com:8443` 视为同一台）。 */
function sameHost(left, right) {
  if (left === right) return true;
  const stripPort = (host) => host.replace(/:\d+$/, '');
  return stripPort(left) === stripPort(right);
}

function hostOfUrl(value) {
  try {
    const url = new URL(value);
    return normalizeHost(url.host);
  } catch {
    return '';
  }
}

/** 目标自带主机（只有显式 scheme，或无 scheme 的 `host/.../issues/<n>` 链接形态）。 */
function hostOfTarget(targetRef) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(targetRef)) return hostOfUrl(targetRef);
  const [first] = targetRef.split('/');
  if (first !== undefined && first.includes('.') && /(?:^|\/)(?:issues|issue|pulls|pull)\/\d+$/.test(targetRef)) {
    return normalizeHost(first);
  }
  return '';
}

/**
 * 配置主机准入（读之前，零子进程）：
 * - 未配置主机 → 不判定（CLI 自身的企业配置说了算，默认安装即可只读）；
 * - 公共 SaaS 域 → 拒（配错主机等于把企业数据当公共站数据）；
 * - 目标自带主机且与配置不一致 → 拒（不许读别的企业实例）。
 */
function enterpriseHostProblem(host, targetRef) {
  const configured = normalizeHost(host);
  if (configured === '') return null;
  if (!HOST_PATTERN.test(configured)) {
    return `主机配置 "${configured}" 不是合法主机名：请填企业内 Gitee 域名（不带协议与路径）`;
  }
  if (PUBLIC_SAAS_HOSTS.includes(configured)) {
    return `主机配置 "${configured}" 是公共 SaaS 域，不是企业内 Gitee：本包只读企业主机`;
  }
  const targetHost = hostOfTarget(targetRef);
  if (targetHost !== '' && !sameHost(targetHost, configured)) {
    return `目标指向主机 "${targetHost}"，与配置的企业主机 "${configured}" 不一致`;
  }
  return null;
}

/** 结果链接主机复核（读之后）：返回结果不许把人引到别的企业实例去。 */
function hostProblemWithRefs(resultRefs, host) {
  const configured = normalizeHost(host);
  if (configured === '') return null;
  for (const ref of Array.isArray(resultRefs) ? resultRefs : []) {
    const refHost = hostOfUrl(ref);
    if (refHost !== '' && !sameHost(refHost, configured)) {
      return `结果链接指向主机 "${refHost}"，与配置的企业主机 "${configured}" 不一致`;
    }
  }
  return null;
}

/** 服务端口上的配置主机（只从已声明的 `adapter().describe()` 读；取不到就跳过判定）。 */
function configuredHostOf(service) {
  if (typeof service?.adapter !== 'function') return '';
  try {
    const adapter = service.adapter();
    const description = typeof adapter?.describe === 'function' ? adapter.describe() : null;
    return normalizeHost(description?.host);
  } catch {
    return '';
  }
}

/**
 * 把适配器事实归一成读信封（AC-15）。
 *
 * 降级优先级：结果形状（不是对象/缺状态）> 主机不一致 > 截断 > provider 混用/适配器已判
 * `unknown` > 缺事实版本。任何降级都**不抛错**，并把已取到的载荷与 `missing_fields` 带上。
 *
 * @param {{action?: unknown, target?: unknown, result?: unknown, host?: unknown, now?: unknown}} [request]
 * @returns {object} 冻结的读信封
 * @throws {GiteeReadError} 仅当动作/目标不合法（请求形状错误，不是读失败）
 */
export function normalizeGiteeReadResult(request = {}) {
  const { action, target, result, host = '', now } = request ?? {};
  const targetRef = assertGiteeReadRequest(action, target);
  const fallbackObservedAt = nowIso(now);

  // 幂等：服务边界（index.mjs）已归一过的信封原样返回，二次归一不许再降一级。
  if (isReadEnvelope(result)) return Object.freeze({ ...result });

  const facts = isPlainObject(result) ? result : null;
  if (facts === null) {
    return failureEnvelope({
      action,
      targetRef,
      reason: READ_REASONS.MALFORMED_RESULT,
      observedAt: fallbackObservedAt,
      message: '适配器结果不是键值对象：无法确认读到的是什么',
    });
  }

  if (!GITEE_READ_STATUSES.includes(facts.status)) {
    return failureEnvelope({
      action,
      targetRef,
      reason: READ_REASONS.NO_STRUCTURED_STATUS,
      observedAt: nowIso(facts.observed_at ?? fallbackObservedAt),
      message: `适配器结果缺少可翻译的状态（收到 "${text(facts.status) || '空'}"）`,
    });
  }

  const observedAt = nowIso(facts.observed_at ?? fallbackObservedAt);
  const resultRefs = Array.isArray(facts.result_refs)
    ? facts.result_refs.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : [];
  const missingFields = Array.isArray(facts.missing_fields)
    ? facts.missing_fields.filter((entry) => typeof entry === 'string' && entry !== '')
    : [];
  const payload = payloadOf(facts);
  const revision = text(facts.source_revision);

  // provider 自证：别的 provider 的事实不许被盖上 gitee 的章（AC-12）。
  if (facts.provider !== undefined && facts.provider !== GITEE_PROVIDER) {
    return failureEnvelope({
      action,
      targetRef,
      reason: READ_REASONS.MIXED_PROVIDER_FIELDS,
      observedAt,
      message: `结果来自 provider "${text(facts.provider) || '空'}"，不是 gitee：不采信`,
    });
  }

  const hostProblem = enterpriseHostProblem(host, targetRef) ?? hostProblemWithRefs(resultRefs, host);
  if (hostProblem !== null) {
    return failureEnvelope({
      action,
      targetRef,
      reason: READ_REASONS.HOST_NOT_ENTERPRISE,
      observedAt,
      message: hostProblem,
    });
  }

  if (facts.truncated === true) {
    return buildEnvelope({
      action,
      targetRef,
      status: 'unknown',
      reason: READ_REASONS.OUTPUT_TRUNCATED,
      observedAt,
      sourceRevision: revision === '' ? null : revision,
      resultRefs,
      missingFields,
      payload,
      message: '输出被上限截断：可能只拿到一部分，事实不可确认（请缩小范围再读一次）',
    });
  }

  if (facts.status === 'unknown' || facts.status === 'failed') {
    const reason = reasonOfCode(facts.error_code) ?? READ_REASONS.COMMAND_FAILED;
    const message = reason === READ_REASONS.MIXED_PROVIDER_FIELDS
      ? `结果里出现未声明的字段（${text(facts.rejected_field) || '未标注'}）：按 provider 分表不采信`
      : '';
    return buildEnvelope({
      action,
      targetRef,
      status: facts.status,
      reason,
      observedAt,
      sourceRevision: revision === '' ? null : revision,
      resultRefs,
      missingFields,
      payload,
      message,
    });
  }

  // 事实版本：对象读必须有 `source_revision`；清单是查询快照（适配器恒给 `null`）不受此限。
  if (revision === '' && facts.kind !== 'list') {
    return buildEnvelope({
      action,
      targetRef,
      status: 'unknown',
      reason: READ_REASONS.MISSING_SOURCE_REVISION,
      observedAt,
      resultRefs,
      missingFields,
      payload,
      message: '结果里取不到 updated_at：事实版本不可核对，降级 unknown（不编版本号）',
    });
  }

  return buildEnvelope({
    action,
    targetRef,
    status: facts.status,
    observedAt,
    sourceRevision: revision === '' ? null : revision,
    resultRefs,
    missingFields,
    payload,
  });
}

/**
 * 命令级失败 → 读信封（AC-15）：不抛错、不重试，原因码固定；`denied` 只在安全结论时出现。
 *
 * @param {{action?: unknown, target?: unknown, error?: unknown, now?: unknown}} [request]
 * @returns {object} 冻结的读信封
 */
export function normalizeGiteeReadError(request = {}) {
  const { action, target, error, now } = request ?? {};
  const detail = isPlainObject(error?.detail) ? error.detail : {};
  const observedAt = nowIso(detail.observedAt ?? now);
  const reason = reasonForError(error);
  return failureEnvelope({
    action,
    targetRef: text(target),
    reason,
    observedAt,
    message: text(error?.message),
  });
}

/** 工具返回形状与 devops 同形：`content` 里一段 JSON 文本，便于统一消费。 */
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** 服务端口的前置条件（令牌/持久令牌）：返回 `null` 表示这一步不可用或已通过。 */
async function preflightOf(service) {
  if (typeof service?.preflight !== 'function') return null;
  try {
    const value = await service.preflight();
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 读工具的主路径：请求校验 → 主机准入 → 前置条件 → 读 → 归一 → 结果主机复核。
 *
 * 每一步的失败都归一成信封，绝不让工具执行体抛错（宿主会把抛错当成工具崩溃，模型拿不到
 * 原因码）；准入前失败一次子进程都不起。
 */
async function readThrough(service, action, args) {
  const request = isPlainObject(args) ? args : {};
  const target = text(request.target);
  const params = {};
  for (const [key, value] of Object.entries(request)) {
    if (key !== 'target') params[key] = value;
  }

  let targetRef;
  try {
    targetRef = assertGiteeReadRequest(action, target);
  } catch (error) {
    return normalizeGiteeReadError({ action, target, error });
  }

  const host = configuredHostOf(service);
  const hostProblem = enterpriseHostProblem(host, targetRef);
  if (hostProblem !== null) {
    return failureEnvelope({
      action,
      targetRef,
      reason: READ_REASONS.HOST_NOT_ENTERPRISE,
      observedAt: nowIso(),
      message: hostProblem,
    });
  }

  const preflight = await preflightOf(service);
  if (preflight !== null && preflight.ok === false) {
    const reason = reasonOfCode(preflight.reason) ?? READ_REASONS.COMMAND_FAILED;
    return failureEnvelope({
      action,
      targetRef,
      reason,
      observedAt: nowIso(),
      message: text(preflight.message) || `前置检查未通过（${text(preflight.reason) || '未标注原因'}）`,
    });
  }

  let value;
  try {
    value = await service.read({ action, target: targetRef, params });
  } catch (error) {
    return normalizeGiteeReadError({ action, target: targetRef, error });
  }

  const envelope = normalizeGiteeReadResult({ action, target: targetRef, result: value, host });
  // 幂等透传的信封没有经过上面那道主机复核，这里补一次（零子进程、零副作用）。
  const refProblem = hostProblemWithRefs(envelope.result_refs, host);
  if (refProblem !== null) {
    return failureEnvelope({
      action,
      targetRef,
      reason: READ_REASONS.HOST_NOT_ENTERPRISE,
      observedAt: envelope.observed_at,
      message: refProblem,
    });
  }
  return envelope;
}

/** 三个读工具共用的目标参数（`target` 是唯一必填项）。 */
const TARGET_PROPERTY = Object.freeze({
  type: 'string',
  description: 'Target: "group/repo" for the repository, "group/repo#12" / "12" / an issue or pull-request link for a single item; a list read uses "group/repo".',
});

/** 清单类只读动作的有限参数（与适配器的 `list`/`state`/`limit`/`json` 白名单一一对应）。 */
const LIST_PARAMETERS = Object.freeze({
  list: Object.freeze({
    type: 'boolean',
    description: 'Set true to list items instead of reading one; state/limit/json are only accepted in list mode.',
  }),
  state: Object.freeze({
    type: 'string',
    enum: Object.freeze(['open', 'closed', 'all']),
    description: 'List state filter: open (default) / closed / all.',
  }),
  limit: Object.freeze({
    type: 'integer',
    // D-1：`minimum`/`maximum` 不在宿主支持的 JSON Schema 子集内（只允许 type/oneOf/
    // properties/required/additionalProperties/items/enum/const + annotations），写上去会让
    // 参数面在宿主侧降级。1..GITEE_LIST_LIMIT 的边界由唯一校验点 `gitee-adapter.mjs`
    // （`ARG_INVALID`）在运行期强制，工具面只声明类型与范围文案。
    description: `List size (1-${GITEE_LIST_LIMIT}, default ${GITEE_LIST_LIMIT}); out-of-range is rejected as ARG_INVALID; the read never paginates.`,
  }),
  json: Object.freeze({
    type: 'array',
    items: Object.freeze({ type: 'string' }),
    description: 'Optional subset of the declared Gitee field names; defaults to the full declared set. GitHub-only fields are rejected.',
  }),
});

/** 读工具声明：顺序与 `GITEE_READ_ACTIONS` 一致（仓库 → Issue → PR）。 */
const READ_TOOL_SPECS = Object.freeze([
  Object.freeze({
    name: 'forge_gitee_repository_read',
    action: 'gitee.repository.read',
    description: 'Read one Gitee repository overview through the enterprise Gitee CLI (gh). Returns a Gitee read envelope: provider "gitee", target_ref, status (succeeded / failed / partial / unknown), the fact revision in source_revision, observed_at, result_refs and missing_fields. Failures come back as a fixed error_code (never thrown, never retried). Only Gitee field names are read (for example default_branch, updated_at); GitHub-only fields are rejected.',
    parameters: Object.freeze({}),
  }),
  Object.freeze({
    name: 'forge_gitee_issue_read',
    action: 'gitee.issue.read',
    description: 'Read Gitee issues through the enterprise Gitee CLI (gh). One issue with target "group/repo#12" or an issue link; a list with target "group/repo" and list:true (state defaults to open, limit up to 100). Same Gitee read envelope as forge_gitee_repository_read: status, source_revision, observed_at, result_refs, fixed error_code. Reads only; nothing is created, edited or closed.',
    parameters: LIST_PARAMETERS,
  }),
  Object.freeze({
    name: 'forge_gitee_pr_read',
    action: 'gitee.pr.read',
    description: 'Read Gitee pull requests through the enterprise Gitee CLI (gh). One pull request with target "group/repo#12" or a pull-request link; a list with target "group/repo" and list:true (state defaults to open, limit up to 100). Same Gitee read envelope as forge_gitee_repository_read. Pull requests are only read here: this tool never merges, closes or approves anything.',
    parameters: LIST_PARAMETERS,
  }),
]);

/** 单条读工具定义：object 参数表 + 执行体（返回形状与 devops 同形）。 */
function defineReadTool(service, spec) {
  const properties = Object.freeze({ target: TARGET_PROPERTY, ...spec.parameters });
  const definition = {
    name: spec.name,
    description: spec.description,
    parameters: Object.freeze({
      type: 'object',
      properties,
      required: Object.freeze(['target']),
      additionalProperties: false,
    }),
    async execute(args = {}) {
      return json(await readThrough(service, spec.action, args));
    },
  };
  definition.output = Object.freeze({
    schema: Object.freeze({ type: 'object' }),
    render: (_args, value) => json(value).content,
  });
  return Object.freeze(definition);
}

/**
 * 三个读工具定义（AC-9/14：固定 3 个，无泛化 `run`/`exec` 入口）。
 *
 * `service` 是装配层端口（`index.mjs` 构造）：只用到已声明的 `read` / `preflight` /
 * `adapter` 三个成员；缺 `read()` 时装配期就抛 `NO_READER`，注册上去只会是哑工具。
 *
 * @param {object} service 装配层端口
 * @returns {object[]} 3 个冻结的工具定义
 * @throws {GiteeReadError} `NO_READER`
 */
export function readToolDefinitions(service) {
  if (service === null || typeof service !== 'object' || typeof service.read !== 'function') {
    throw new GiteeReadError(
      READ_REASONS.NO_READER,
      '只读工具定义需要一个提供 read() 的服务端口：缺了它注册上去也只会是哑工具',
      { reason: 'NO_READER' },
    );
  }
  return Object.freeze(READ_TOOL_SPECS.map((spec) => defineReadTool(service, spec)));
}
