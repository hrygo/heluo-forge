/**
 * `@heluo/forge-devops` 的模型可见只读工具（#15 / D4）。
 *
 * 两个刻意的设计点：
 * 1. **参数名用 `target`**：策略门禁只读 `exec.arguments.target`，用 `command`/`path` 之类
 *    的名字会让 `target-required` 这类规则永远无法满足（2026-10-24 实测的目录缺口）。
 *    只读查询的"目标"本来就是变更号/仓库/Issue/PR 引用，这里直接对齐门禁。
 * 2. **只产出四个读工具，没有任何写工具**：写动作按策略设计 §5.1.1 登记逐条准入，
 *    未获批准的写在这里根本不存在，模型"自决调用"也无从发起。
 */
import { READ_ACTIONS } from './read.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** 工具名 → 动作；只含读动作（工具名与此表是唯一真源，测试逐条核对）。 */
export const READ_TOOLS = Object.freeze({
  forge_devops_change_read: 'change.read',
  forge_devops_repository_read: 'repository.read',
  forge_devops_issue_read: 'issue.read',
  forge_devops_pr_read: 'pr.read',
});

const TARGET_HINT = Object.freeze({
  'change.read': '系统变更号，例如 CHG-2026-0042',
  'repository.read': '仓库标识，例如 group/repo',
  'issue.read': 'Issue 引用，例如 group/repo#123',
  'pr.read': 'PR 引用，例如 group/repo!456',
});

const NEXT_ACTION = Object.freeze({
  NO_READER: 'configure-reader',
  POLICY_REQUIRED: 'report-to-admin',
  UNKNOWN_ACTION: 'report-to-admin',
  MISSING_TARGET: 'give-a-target',
  MALFORMED_RESULT: 'retry',
  NO_STRUCTURED_STATUS: 'report-to-admin',
  MISSING_SOURCE_REVISION: 'report-to-admin',
});

function tool(service, toolName, action) {
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
        const reason = typeof error?.code === 'string' ? error.code : 'INTERNAL';
        // 拒绝必须可见：把下一步动作一并给出，而不是让调用方猜"为什么没结果"。
        return json({
          ok: false,
          action,
          reason,
          next_action: NEXT_ACTION[reason] ?? 'report-to-admin',
          detail: String(error?.message ?? error),
        });
      }
    },
  };
}

/** 构造四个只读工具定义（顺序与 READ_ACTIONS 一致）。 */
export function buildDevopsTools(service) {
  const known = new Set(READ_ACTIONS);
  return Object.entries(READ_TOOLS)
    .filter(([, action]) => known.has(action))
    .map(([toolName, action]) => tool(service, toolName, action));
}
