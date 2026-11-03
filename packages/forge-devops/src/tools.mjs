/**
 * `@heluo/forge-devops` 的模型可见工具面（r10：4 个 = 1 只读 + 1 聚合读 + 1 平台写 + 1 产物落盘）。
 *
 * 平台收敛原则：devops 只讲 dop 变更流程，仓库 / Issue / PR 的读写全部归 `@heluo/forge-gitee`。
 * 因此这里不再有 `issue_write` / `pr_write` / `repository_read` / `issue_read` / `pr_read`——
 * 同一事实两个入口，模型迟早会各用一次并得到两套结论。
 *
 * 三个刻意的设计点：
 * 1. **参数名一律用 `target`**：策略门禁只读 `exec.arguments.target`，用 `command`/`path`
 *    之类的名字会让 `target-required` 这类规则永远无法满足（2026-10-24 实测的目录缺口）。
 * 2. **工具名 → 动作的映射表是唯一真源**（`READ_TOOLS` / `FLOW_TOOLS` / `DEVOPS_TOOLS`）：
 *    工具只做 schema、confirm 前置校验与错误映射，业务判定留在纯函数模块里，
 *    这样"哪个工具走哪个门禁动作"可以逐条核对（静态门禁也按这张表验 4 个名字）。
 * 3. **写工具必须带 `confirm`**：模型自填"已确认"不算数，`confirm.object` 与实际写入目标
 *    不一致时直接拒绝，一次下游调用都不发生。澄清单的目标是变更号（不是仓库），故不做仓库绑定。
 * 4. **产物落盘没有平台动作**（`action: null`）：它只写本地 `.dsh-devops/`，
 *    但仍要求 kind 与证据齐全，避免"报告没有证据也算产物"。
 */
import { failureMessageOf, toolFailureOf } from './failure-face.mjs';
import { READ_ACTIONS } from './read.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** 工具名 → 动作；只含读动作（工具名与此表是唯一真源，测试逐条核对）。 */
export const READ_TOOLS = Object.freeze({
  forge_devops_change_read: 'change.read',
});

/** 流程工具：`kind` 区分聚合读 / 平台写 / 本地落盘，`action` 是门禁动作（落盘为 null）。 */
export const FLOW_TOOLS = Object.freeze({
  forge_devops_change_context: Object.freeze({ kind: 'read', action: 'change.read' }),
  forge_devops_clarify_write: Object.freeze({ kind: 'write', action: 'change.clarification.write' }),
  forge_devops_artifact_write: Object.freeze({ kind: 'artifact', action: null }),
});

/** 门禁动作词表（写动作全在这里，禁止在工具里另写动作字符串）。 */
export const FLOW_ACTIONS = Object.freeze({
  CLARIFY: 'change.clarification.write',
});

/**
 * 模型可见工具名（顺序即注册顺序）：1 只读 → 1 聚合读 → 1 平台写 → 1 落盘。
 * 静态门禁按这份枚举核对"恰好 4 个"，避免"加了工具忘登记"或"删了模块留下幽灵入口"。
 */
export const DEVOPS_TOOLS = Object.freeze([
  ...Object.keys(READ_TOOLS),
  ...Object.keys(FLOW_TOOLS),
]);

/** 工具边界的原因码（平台侧四状态 done/failed/denied/unknown 由适配器给出，不在此表）。 */
export const TOOL_REASONS = Object.freeze({
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  MISSING_ARGUMENT: 'MISSING_ARGUMENT',
  MISSING_TARGET: 'MISSING_TARGET',
  INTERNAL: 'INTERNAL',
});

const TARGET_HINT = Object.freeze({
  'change.read': '系统变更号，例如 CHG-2026-0042',
});

const NEXT_ACTION = Object.freeze({
  NO_READER: 'configure-reader',
  POLICY_REQUIRED: 'report-to-admin',
  POLICY_ACTION_UNREGISTERED: 'report-to-admin',
  POLICY_DENIED: 'report-to-admin',
  UNKNOWN_ACTION: 'report-to-admin',
  MISSING_TARGET: 'give-a-target',
  MALFORMED_RESULT: 'retry',
  NO_STRUCTURED_STATUS: 'report-to-admin',
  MISSING_SOURCE_REVISION: 'report-to-admin',
  CONFIRMATION_REQUIRED: 'confirm-object',
  MISSING_ARGUMENT: 'complete-arguments',
  CONFIG_MISSING: 'configure-runtime',
  COMMAND_NOT_WHITELISTED: 'use-supported-channel',
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
 * 写动作的确认前置：`confirm.object` 必须等于目标本身。
 *
 * 澄清单的目标是**变更号**（`CHG-2026-0042`），不是仓库引用，所以不做 `confirm.repo` 绑定：
 * 拿一段仓库路径去要求变更号，只会把"参数齐全"误判成"确认不一致"。
 */
function checkConfirm(confirm, target) {
  if (confirm === null || typeof confirm !== 'object' || Array.isArray(confirm)) {
    return TOOL_REASONS.CONFIRMATION_REQUIRED;
  }
  const object = typeof target === 'string' ? target.trim() : '';
  if (object === '') return TOOL_REASONS.MISSING_TARGET;
  if (typeof confirm.object !== 'string' || confirm.object.trim() !== object) {
    return TOOL_REASONS.CONFIRMATION_REQUIRED;
  }
  return null;
}

function readTool(service, toolName, action) {
  return {
    name: toolName,
    description:
      `Read-only DevOps query (${action}). Returns the platform's own facts with a source ` +
      'revision; an exit code or free text alone is reported as unknown instead of success.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: TARGET_HINT[action] } },
      required: ['target'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      try {
        return json({ ok: true, result: await service.read({ action, target: args?.target }) });
      } catch (error) {
        return failureOf(action, error);
      }
    },
  };
}

/** 聚合读：一次取回 dop 变更事实并渲染上下文卡；仓库侧事实由 Gitee 工具回答。 */
function contextTool(service) {
  return {
    name: 'forge_devops_change_context',
    description:
      'Aggregate read (change.read): the system change record and its context card in one call. ' +
      'Repository, Issue and PR facts are provided by the Gitee tools (REPO_FACTS_EXTERNAL), ' +
      'not guessed here.',
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

const CONFIRM_SCHEMA = Object.freeze({
  type: 'object',
  description: '写入确认：object 必须等于目标引用（模型自填不算数）',
  properties: {
    object: { type: 'string', description: '本次要写的对象，例如 CHG-2026-0042' },
  },
  required: ['object'],
  additionalProperties: false,
});

/** 澄清回写：dop 没有澄清写命令，恒 denied 且零调用——但拒绝必须可见，不能静默跳过。 */
function clarifyWriteTool(service) {
  return {
    name: 'forge_devops_clarify_write',
    description:
      'Write the clarification sheet back to the platform (change.clarification.write). The dop ' +
      'command face has no clarification write, so this is reported as denied with zero calls; ' +
      'the sheet stays as a local artifact.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: TARGET_HINT['change.read'] },
        body: { type: 'string', description: '澄清回写正文（Markdown）' },
        confirm: CONFIRM_SCHEMA,
      },
      required: ['target', 'body', 'confirm'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      const action = FLOW_ACTIONS.CLARIFY;
      const target = typeof args?.target === 'string' ? args.target.trim() : '';
      const denied = checkConfirm(args?.confirm, target);
      if (denied !== null) return failure(action, denied, `confirm 与写入目标不一致：target=${target || '(空)'}`);
      try {
        const result = await service.clarifyWrite({ target, body: args?.body });
        return json({ ok: result?.status === 'done', result });
      } catch (error) {
        return failureOf(action, error);
      }
    },
  };
}

/** 产物落盘：唯一出口 `artifacts.mjs`；没有平台动作，但 kind/证据由纯函数机检。 */
function artifactWriteTool(service) {
  return {
    name: 'forge_devops_artifact_write',
    description:
      'Write one requirement artifact under <repo>/.dsh-devops/<change>/ (context|clarify|plan|' +
      'review|report.md) with a fixed six-field front matter. Path escapes are rejected; review ' +
      'requires a commit and a model name, report requires an evidence array.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: '目标仓库根目录（绝对或相对路径）' },
        kind: { type: 'string', enum: ['context', 'clarify', 'plan', 'review', 'report'] },
        body: { type: 'string', description: 'Markdown 正文（不含 front matter）' },
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
      required: ['repoRoot', 'kind', 'body', 'meta'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      try {
        const artifact = await service.artifactWrite({
          repoRoot: args?.repoRoot,
          kind: args?.kind,
          body: args?.body,
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
 * 构造 4 个工具定义：只读按 `READ_ACTIONS` 顺序（r10 只有 `change.read` 一条），
 * 其后是聚合读、平台写与落盘。数量与名字由 `DEVOPS_TOOLS` 单一枚举，静态门禁逐条核对。
 */
export function buildDevopsTools(service) {
  const known = new Set(READ_ACTIONS);
  const reads = Object.entries(READ_TOOLS)
    .filter(([, action]) => known.has(action))
    .map(([toolName, action]) => readTool(service, toolName, action));
  return [...reads, contextTool(service), clarifyWriteTool(service), artifactWriteTool(service)];
}
