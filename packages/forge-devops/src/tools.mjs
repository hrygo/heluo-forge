/**
 * `@heluo/forge-devops` 的模型可见工具面（9 个：4 只读 + 1 聚合读 + 3 平台写 + 1 产物落盘）。
 *
 * 四个刻意的设计点：
 * 1. **参数名一律用 `target`**：策略门禁只读 `exec.arguments.target`，用 `command`/`path`
 *    之类的名字会让 `target-required` 这类规则永远无法满足（2026-10-24 实测的目录缺口）。
 * 2. **工具名 → 动作的映射表是唯一真源**（`READ_TOOLS` / `FLOW_TOOLS`）：工具只做 schema、
 *    confirm 前置校验与错误映射，业务判定（幂等、回读、四状态）留在纯函数模块里，
 *    这样"哪个工具走哪个门禁动作"可以逐条核对。
 * 3. **写工具必须带 `confirm: { repo, object }`**：模型自填"已确认"不算数，
 *    repo/object 与实际写入目标不一致时直接 `denied`，一次下游调用都不发生。
 *    仓库引用统一交给 `repo-ref.mjs` 解析（`org/group/repo#12` 的 repo 是**完整三段**
 *    `org/group/repo`，不折成 `group/repo`）——工具面不再自写正则，判词与适配器、门禁只有一份。
 * 4. **产物落盘没有平台动作**（`action: null`）：它只写本地 `.dsh-devops/`，
 *    但仍要求 kind 与证据齐全，避免"报告没有证据也算产物"。
 */
import { READ_ACTIONS } from './read.mjs';
import { repoOfTarget } from './repo-ref.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** 工具名 → 动作；只含读动作（工具名与此表是唯一真源，测试逐条核对）。 */
export const READ_TOOLS = Object.freeze({
  forge_devops_change_read: 'change.read',
  forge_devops_repository_read: 'repository.read',
  forge_devops_issue_read: 'issue.read',
  forge_devops_pr_read: 'pr.read',
});

/** 流程工具：`kind` 区分聚合读 / 平台写 / 本地落盘，`action` 是门禁动作（落盘为 null）。 */
export const FLOW_TOOLS = Object.freeze({
  forge_devops_change_context: Object.freeze({ kind: 'read', action: 'change.read' }),
  forge_devops_issue_write: Object.freeze({ kind: 'write', action: 'issue.create_or_update' }),
  forge_devops_pr_write: Object.freeze({ kind: 'write', action: 'pr.create_or_update' }),
  forge_devops_clarify_write: Object.freeze({ kind: 'write', action: 'change.clarification.write' }),
  forge_devops_artifact_write: Object.freeze({ kind: 'artifact', action: null }),
});

/** 门禁动作词表（写动作全在这里，禁止在工具里另写动作字符串）。 */
export const FLOW_ACTIONS = Object.freeze({
  ISSUE: 'issue.create_or_update',
  PR: 'pr.create_or_update',
  PR_COMMENT: 'review.ai.publish',
  CLARIFY: 'change.clarification.write',
});

/** 工具边界的原因码（平台侧四状态 done/failed/denied/unknown 由适配器给出，不在此表）。 */
export const TOOL_REASONS = Object.freeze({
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  MISSING_ARGUMENT: 'MISSING_ARGUMENT',
  MISSING_TARGET: 'MISSING_TARGET',
  INTERNAL: 'INTERNAL',
});

const TARGET_HINT = Object.freeze({
  'change.read': '系统变更号，例如 CHG-2026-0042',
  'repository.read': '仓库标识，例如 group/repo 或 org/group/repo',
  'issue.read': 'Issue 引用，例如 group/repo#123 或 org/group/repo#123',
  'pr.read': 'PR 引用，例如 group/repo!456 或 org/group/repo!456',
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
  IDEMPOTENT_REPLAY: 'reuse-existing-object',
  READBACK_MISMATCH: 'inspect-platform',
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
 * 写动作的确认前置：`confirm.repo` 必须等于目标的仓库（完整 2 或 3 段路径），
 * `confirm.object` 必须等于目标本身。
 * 返回 null 表示通过，否则返回原因码。只在工具边界做一次，语义与门禁的 confirm 通道一致。
 *
 * 取仓库走 `repoOfTarget`（单点解析，剥 `#n` / `!n`）：旧实现自写的两段正则对
 * `org/group/repo#12` 取不到仓库，会恒返 `MISSING_TARGET`，写动作永远到不了门禁。
 * 这里**不做裸名兜底**：`confirm.repo='group/repo'` 对 `org/group/repo` 仍是
 * `CONFIRMATION_REQUIRED`——把三段折成两段等于把两个仓库判成同一个，那是放松门禁。
 */
function checkConfirm(confirm, target, { repoBound = true } = {}) {
  if (confirm === null || typeof confirm !== 'object' || Array.isArray(confirm)) {
    return TOOL_REASONS.CONFIRMATION_REQUIRED;
  }
  const object = typeof target === 'string' ? target.trim() : '';
  if (object === '') return TOOL_REASONS.MISSING_TARGET;
  if (typeof confirm.object !== 'string' || confirm.object.trim() !== object) {
    return TOOL_REASONS.CONFIRMATION_REQUIRED;
  }
  if (!repoBound) return null;
  const repo = repoOfTarget(object);
  if (repo === null) return TOOL_REASONS.MISSING_TARGET;
  if (typeof confirm.repo !== 'string' || confirm.repo.trim() !== repo) {
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
        return failure(action, reasonOf(error), error?.message ?? error);
      }
    },
  };
}

/** 聚合读：一次取回变更、承建仓库与关联对象，渲染成上下文卡（不再让模型自己拼事实）。 */
function contextTool(service) {
  return {
    name: 'forge_devops_change_context',
    description:
      'Aggregate read (change.read): system change record, building repository decision and ' +
      'related objects in one context card. Unknowns and blocked candidates are returned ' +
      'explicitly instead of being guessed.',
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
        return failure('change.read', reasonOf(error), error?.message ?? error);
      }
    },
  };
}

const CONFIRM_SCHEMA = Object.freeze({
  type: 'object',
  description: '写入确认：repo 必须等于目标仓库，object 必须等于目标引用（模型自填不算数）',
  properties: {
    repo: {
      type: 'string',
      description: '目标仓库的完整路径（含命名空间，2 或 3 段），例如 group/repo 或 org/group/repo',
    },
    object: { type: 'string', description: '本次要写的对象，例如 group/repo#123' },
  },
  required: ['repo', 'object'],
  additionalProperties: false,
});

/**
 * 拒绝时的可读原因：`MISSING_TARGET` 有两种成因——没给 target，或给了 target 但取不出仓库
 * （链接、裸编号、1 段、4 段、段内含空格）。两者都零下游调用，但要让人看见是哪一种，
 * 否则调用方会以为"参数齐全却被说成缺 target"。
 */
function confirmDetail(reason, target) {
  if (reason !== TOOL_REASONS.MISSING_TARGET) {
    return `confirm 与写入目标不一致：target=${target || '(空)'}`;
  }
  return target === ''
    ? '缺少 target，无法核对写入对象'
    : `target 不是可核对的仓库引用（需要 2 或 3 段仓库路径，可带 #n / !n）：target=${target}`;
}

function writeTool({ service, method, toolName, description, action, properties, required, run, repoBound = true }) {
  return {
    name: toolName,
    description,
    parameters: {
      type: 'object',
      properties: { ...properties, confirm: CONFIRM_SCHEMA },
      required: [...required, 'confirm'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      const target = typeof args?.target === 'string' ? args.target.trim() : '';
      const denied = checkConfirm(args?.confirm, target, { repoBound });
      if (denied !== null) return failure(action, denied, confirmDetail(denied, target));
      try {
        const missing = run.missing(args);
        if (missing !== null) return failure(action, TOOL_REASONS.MISSING_ARGUMENT, `缺少参数 ${missing}`);
        const result = await service[method](run.payload(args, target));
        return json({ ok: result?.status === 'done', result });
      } catch (error) {
        return failure(action, reasonOf(error), error?.message ?? error);
      }
    },
  };
}

function issueWriteTool(service) {
  return writeTool({
    service,
    method: 'issueWrite',
    toolName: 'forge_devops_issue_write',
    action: FLOW_ACTIONS.ISSUE,
    description:
      'Create or comment an issue (issue.create_or_update). Idempotent: the object is looked ' +
      'up before creation and re-read afterwards; a mismatch is reported as unknown, never replayed.',
    properties: {
      op: { type: 'string', enum: ['create', 'comment'], description: 'create=新建 Issue，comment=追加评论' },
      target: { type: 'string', description: '仓库（create）或 Issue 引用（comment），例如 group/repo#123 或 org/group/repo#123' },
      title: { type: 'string', description: 'create 必填：Issue 标题' },
      body: { type: 'string', description: '正文（Markdown）' },
    },
    required: ['op', 'target', 'body'],
    run: {
      missing: (args) => {
        if (args?.op === 'create' && typeof args?.title !== 'string') return 'title';
        return null;
      },
      payload: (args, target) => ({
        op: args?.op,
        target,
        title: args?.title,
        body: args?.body,
        confirm: args?.confirm,
      }),
    },
  });
}

function prWriteTool(service) {
  return writeTool({
    service,
    method: 'prWrite',
    toolName: 'forge_devops_pr_write',
    action: FLOW_ACTIONS.PR,
    description:
      'Open a pull request (pr.create_or_update) or comment on one (review.ai.publish). Merging, ' +
      'closing and releasing are not available: those commands do not exist in this plugin.',
    properties: {
      op: { type: 'string', enum: ['create', 'comment'], description: 'create=新建 PR，comment=追加审查评论' },
      target: { type: 'string', description: '仓库（create）或 PR 引用（comment），例如 group/repo!456 或 org/group/repo!456' },
      head: { type: 'string', description: 'create 必填：源分支' },
      base: { type: 'string', description: 'create 必填：目标分支' },
      title: { type: 'string', description: 'create 必填：PR 标题' },
      body: { type: 'string', description: '正文（Markdown）' },
      commit: { type: 'string', description: 'comment 必填：被评论的 commit sha（审查记录与 sha 绑定）' },
    },
    required: ['op', 'target', 'body'],
    run: {
      missing: (args) => {
        if (args?.op !== 'create') {
          return typeof args?.commit === 'string' && args.commit.trim().length > 0 ? null : 'commit';
        }
        for (const key of ['head', 'base', 'title']) {
          if (typeof args?.[key] !== 'string' || args[key].trim().length === 0) return key;
        }
        return null;
      },
      payload: (args, target) => ({
        op: args?.op,
        target,
        head: args?.head,
        base: args?.base,
        title: args?.title,
        body: args?.body,
        commit: args?.commit,
        confirm: args?.confirm,
      }),
    },
  });
}

/** 澄清回写：dop 没有澄清写命令，恒 denied 且零调用——但拒绝必须可见，不能静默跳过。 */
function clarifyWriteTool(service) {
  return writeTool({
    service,
    method: 'clarifyWrite',
    toolName: 'forge_devops_clarify_write',
    action: FLOW_ACTIONS.CLARIFY,
    description:
      'Write the clarification sheet back to the platform (change.clarification.write). The dop ' +
      'command face has no clarification write, so this is reported as denied with zero calls; ' +
      'the sheet stays as a local artifact.',
    properties: {
      target: { type: 'string', description: '系统变更号，例如 CHG-2026-0042' },
      body: { type: 'string', description: '澄清回写正文（Markdown）' },
    },
    required: ['target', 'body'],
    repoBound: false,
    run: {
      missing: () => null,
      payload: (args, target) => ({ target, body: args?.body, confirm: args?.confirm }),
    },
  });
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
        return failure('artifact.write', reasonOf(error), error?.message ?? error);
      }
    },
  };
}

/** 构造 9 个工具定义：4 只读按 READ_ACTIONS 顺序，其后是流程工具。 */
export function buildDevopsTools(service) {
  const known = new Set(READ_ACTIONS);
  const reads = Object.entries(READ_TOOLS)
    .filter(([, action]) => known.has(action))
    .map(([toolName, action]) => readTool(service, toolName, action));
  return [
    ...reads,
    contextTool(service),
    issueWriteTool(service),
    prWriteTool(service),
    clarifyWriteTool(service),
    artifactWriteTool(service),
  ];
}
