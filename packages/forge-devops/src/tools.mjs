/**
 * `@heluo/forge-devops` 的模型可见工具面（D 方案：3 个 = 1 只读 runner + 1 聚合读 + 1 产物落盘）。
 *
 * 平台收敛原则：devops 只讲 dop 变更流程，仓库 / Issue / PR 的读写全部归 `@heluo/forge-gitee`。
 * 因此这里不再有 `issue_write` / `pr_write` / `repository_read` / `issue_read` / `pr_read`——
 * 同一事实两个入口，模型迟早会各用一次并得到两套结论。
 *
 * 三个刻意的设计点：
 * 1. **参数名一律用 `target`**：策略门禁只读 `exec.arguments.target`，用 `command`/`path`
 *    之类的名字会让 `target-required` 这类规则永远无法满足（2026-10-24 实测的目录缺口）。
 * 2. **只读面是一个受枚举约束的 typed runner**（`forge_devops_query`）：`action` 与策略目录
 *    同名，不另造词表；`change.read` 只接受单个变更号，`change.list` 只接受 `@me`（工具层
 *    直接拒绝，零下游调用），两条动作的原始事实与归一投影都在结果里可见。
 * 3. **产物落盘没有平台动作**（`action: null`）：它只写本地 `.dsh-devops/`，但 kind 与证据
 *    必须齐全；clarify / plan 的正文由纯函数机检后渲染，缺 findings / 缺验证方式不落盘。
 *
 * 工具名 → 动作的映射表是唯一真源（`QUERY_TOOL` / `FLOW_TOOLS` / `DEVOPS_TOOLS`）：
 * 工具只做 schema、目标规范化与错误映射，业务判定留在纯函数模块里，
 * 这样"哪个工具走哪个门禁动作"可以逐条核对（静态门禁也按这张表验 3 个名字）。
 */
import { failureMessageOf, toolFailureOf } from './failure-face.mjs';
import { READ_ACTIONS } from './read.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * 只读 runner 的工具名（唯一入口）：动作由参数 `action` 在下面枚举内选择，
 * 不再一个读动作一个工具——否则"加一条读能力"就要新增一个工具名。
 */
export const QUERY_TOOL = 'forge_devops_query';

/** 只读 runner 允许的动作词表（与策略目录、补丁层 catalog 同名，不另造词）。 */
export const QUERY_ACTIONS = Object.freeze([...READ_ACTIONS]);

/** `change.list` 唯一接受的 target：平台按登录凭据取"我"的清单，不接受任意用户。 */
const SELF_TARGET = '@me';

/** 流程工具：`kind` 区分聚合读 / 本地落盘，`action` 是门禁动作（落盘为 null）。 */
export const FLOW_TOOLS = Object.freeze({
  forge_devops_change_context: Object.freeze({ kind: 'read', action: 'change.read' }),
  forge_devops_artifact_write: Object.freeze({ kind: 'artifact', action: null }),
});

/**
 * 模型可见工具名（顺序即注册顺序）：1 只读 runner → 1 聚合读 → 1 落盘。
 * 静态门禁按这份枚举核对"恰好 3 个"，避免"加了工具忘登记"或"删了模块留下幽灵入口"。
 */
export const DEVOPS_TOOLS = Object.freeze([QUERY_TOOL, ...Object.keys(FLOW_TOOLS)]);

/** 工具边界的原因码（平台侧四状态 done/failed/denied/unknown 由适配器给出，不在此表）。 */
export const TOOL_REASONS = Object.freeze({
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  MISSING_ARGUMENT: 'MISSING_ARGUMENT',
  MISSING_TARGET: 'MISSING_TARGET',
  UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET',
  INTERNAL: 'INTERNAL',
});

const TARGET_HINT = Object.freeze({
  'change.read': '系统变更号，例如 CHG-2026-0042',
  'change.list': `只接受 ${SELF_TARGET}（当前登录用户的变更清单）`,
});

const NEXT_ACTION = Object.freeze({
  NO_READER: 'configure-reader',
  POLICY_REQUIRED: 'report-to-admin',
  POLICY_ACTION_UNREGISTERED: 'report-to-admin',
  POLICY_DENIED: 'report-to-admin',
  UNKNOWN_ACTION: 'report-to-admin',
  MISSING_TARGET: 'give-a-target',
  // 目标语义不支持（例如 change.list 传了具体用户名）：下一步就是改成 @me，而不是重试同一个参数。
  UNSUPPORTED_TARGET: 'use-@me',
  MALFORMED_RESULT: 'retry',
  NO_STRUCTURED_STATUS: 'report-to-admin',
  MISSING_SOURCE_REVISION: 'report-to-admin',
  CONFIRMATION_REQUIRED: 'confirm-object',
  MISSING_ARGUMENT: 'complete-arguments',
  CONFIG_MISSING: 'configure-runtime',
  COMMAND_NOT_WHITELISTED: 'use-supported-channel',
  // 产物落盘的三种新失败：参数给错（body/data 互斥）与内容不合格（clarify/plan 机检）。
  ARTIFACT_ARGUMENT_MISMATCH: 'fix-arguments',
  ARTIFACT_CLARIFY_INVALID: 'fix-content',
  ARTIFACT_PLAN_INVALID: 'fix-content',
  INTERNAL: 'report-to-admin',
});

/** 统一失败信封：拒绝必须可见，并给出下一步，而不是让调用方猜"为什么没结果"。 */
function failure(action, reason, detail) {
  return json({
    ok: false,
    action,
    reason,
    next_action: NEXT_ACTION[reason] ?? 'report-to-admin',
    detail: String(detail ?? ''),
  });
}

function reasonOf(error) {
  return typeof error?.code === 'string' ? error.code : TOOL_REASONS.INTERNAL;
}

/**
 * 工具失败信封的唯一分流点（r9 / AC-1 第一出口）。
 *
 * 「命令没启动」给**结构化 detail**（`{reason, category, next, command, observedAt}`）并指明
 * `configure-reader`：下一步就是去设置页指一个能启动的入口，模型不必再猜。其余失败维持
 * 字符串 detail——拒绝、缺参、超时给的是原因码，卡片与 report 按字符串读，把对象混进这条
 * 分支会让下游渲染出 `[object Object]`。
 *
 * 两条分支的 message 都经 `failure-face` 脱敏，工具输出因此不携带本机路径（AC-2）。
 */
function failureOf(action, error) {
  const detail = error?.detail;
  if (detail !== null && typeof detail === 'object' && detail.spawnFailed === true) {
    return json(toolFailureOf(action, error));
  }
  return failure(action, reasonOf(error), failureMessageOf(error) || String(error ?? ''));
}

/**
 * 只读 runner：一个工具、`action` 受枚举约束，成功时把**信封 + 命令标签 + 事实投影**一起交出。
 *
 * `change.list` 的 target 语义在本层判定（只接受 `@me`，大小写不敏感并规范化为小写）：
 * 读层与适配器都不认识 `@me`，多判一次就是两套规则；非 `@me` 的目标在这里直接拒绝，
 * **零下游调用**。
 */
function queryTool(service) {
  return {
    name: QUERY_TOOL,
    description:
      'Read-only DevOps query with two actions: change.read (one system change: the raw platform ' +
      'record plus its normalized projection) and change.list (the current user change list; target ' +
      'is @me only, optional status filter). Returns the platform envelope with its source revision; ' +
      'an exit code or free text alone is reported as unknown instead of success. Never writes to ' +
      'the platform.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...QUERY_ACTIONS],
          description: 'Read action (same identifiers as the policy catalog).',
        },
        target: {
          type: 'string',
          description: `change.read: ${TARGET_HINT['change.read']}；change.list: ${TARGET_HINT['change.list']}`,
        },
        status: {
          type: 'string',
          description: 'Only for change.list: platform status filter (lowercase token). Ignored by change.read.',
        },
      },
      required: ['action', 'target'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim() : '';
      const target = typeof args?.target === 'string' ? args.target.trim() : '';
      if (action === 'change.list') {
        if (target.toLowerCase() !== SELF_TARGET) {
          return failure(
            action,
            TOOL_REASONS.UNSUPPORTED_TARGET,
            `change.list 只接受 ${SELF_TARGET}：target=${target || '(空)'}`,
          );
        }
        return awaitQuery(service, { action, target: SELF_TARGET, status: args?.status });
      }
      // change.read 与未知 action 走同一条：`status` 只对 change.list 生效，这里不传。
      return awaitQuery(service, { action, target });
    },
  };
}

/** 跑一次只读查询并把结果抬成工具信封（成功形状与失败信封都只有这一处）。 */
async function awaitQuery(service, request) {
  try {
    const envelope = await service.read(request);
    return json({
      ok: true,
      action: envelope?.action ?? request.action,
      target: envelope?.target_ref ?? request.target,
      command: envelope?.command ?? null,
      envelope,
      facts: envelope?.facts,
      truncated: envelope?.truncated === true,
    });
  } catch (error) {
    return failureOf(request.action, error);
  }
}

/** 聚合读：一次取回 dop 变更事实并渲染上下文卡；仓库侧事实由 Gitee 工具回答。 */
function contextTool(service) {
  return {
    name: 'forge_devops_change_context',
    description:
      'Aggregate read (change.read): the system change record and its context card in one call. ' +
      'Use forge_devops_query for raw or single-change facts; use this tool when you need the ' +
      'rendered card that can be written as an artifact. Repository, Issue and PR facts are ' +
      'provided by the Gitee tools (REPO_FACTS_EXTERNAL), not guessed here.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: TARGET_HINT['change.read'] } },
      required: ['target'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      try {
        return json({ ok: true, ...(await service.context({ target: args?.target })) });
      } catch (error) {
        return failureOf('change.read', error);
      }
    },
  };
}

/** 产物落盘：唯一出口 `artifacts.mjs`；没有平台动作，但 kind/证据/正文由纯函数机检。 */
function artifactWriteTool(service) {
  return {
    name: 'forge_devops_artifact_write',
    description:
      'Write one requirement artifact under <repo>/.dsh-devops/<change>/ (context|clarify|plan|' +
      'review|report.md) with a fixed six-field front matter. context/review/report require body ' +
      'and reject data; clarify requires data.findings and no body; plan requires data.criteria/' +
      'data.items and no body. Path escapes are rejected; review requires a commit and a model ' +
      'name; report requires an evidence array.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: '目标仓库根目录（绝对或相对路径）' },
        kind: { type: 'string', enum: ['context', 'clarify', 'plan', 'review', 'report'] },
        body: {
          type: 'string',
          description: 'Markdown 正文（不含 front matter）；clarify/plan 不传 body（正文由机检后的渲染生成）',
        },
        data: {
          type: 'object',
          description: 'clarify 需 findings；plan 需 criteria/items；其余 kind 不接受 data',
          properties: {
            findings: { type: 'array', items: {} },
            criteria: { type: 'array', items: {} },
            items: { type: 'array', items: {} },
          },
          additionalProperties: false,
        },
        meta: {
          type: 'object',
          description: '来源与证据：sourceType/sourceRevision 必填，review 需 commit+model，report 需 evidence[]',
          properties: {
            sourceType: { type: 'string', enum: ['mock', 'enterprise'] },
            sourceRevision: { type: 'string' },
            commit: { type: 'string' },
            model: { type: 'string' },
            evidence: { type: 'array', items: { type: 'object' } },
            generatedAt: { type: 'string' },
          },
          required: ['sourceType', 'sourceRevision'],
          additionalProperties: false,
        },
      },
      required: ['repoRoot', 'kind', 'meta'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      try {
        const artifact = await service.artifactWrite({
          repoRoot: args?.repoRoot,
          kind: args?.kind,
          body: args?.body,
          data: args?.data,
          meta: args?.meta,
        });
        return json({ ok: true, artifact });
      } catch (error) {
        return failureOf('artifact.write', error);
      }
    },
  };
}

/**
 * 构造 3 个工具定义：只读 runner、聚合读、落盘。数量与名字由 `DEVOPS_TOOLS` 单一枚举，
 * 静态门禁逐条核对。
 */
export function buildDevopsTools(service) {
  return [queryTool(service), contextTool(service), artifactWriteTool(service)];
}
