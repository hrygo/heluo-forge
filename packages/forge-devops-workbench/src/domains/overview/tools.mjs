/**
 * 总览域只读模型工具：`forge_workbench_todo_summary`。
 */
import { json, TOOL_OUTPUT, toolFailure } from '../../shared/tool-helpers.mjs';

export const OVERVIEW_TOOL_NAMES = Object.freeze([
  'forge_workbench_todo_summary',
]);

/**
 * 构造总览域只读工具定义。
 *
 * @param {{ getSummary: Function }} service
 */
export function buildOverviewTools(service) {
  return [
    {
      name: 'forge_workbench_todo_summary',
      description:
        'Read 7-channel todos and 3 progress boards (requirement, implementation, project) summary from workbench.',
      parameters: {
        type: 'object',
        properties: {
          reqView: { type: 'string', enum: ['manager', 'business'] },
          implView: { type: 'string', enum: ['responsible', 'participate', 'creator'] },
          projView: { type: 'string', enum: ['responsible', 'participant'] },
        },
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        try {
          const sum = await service.getSummary({
            reqView: args?.reqView ?? 'manager',
            implView: args?.implView ?? 'responsible',
            projView: args?.projView ?? 'responsible',
          });
          return json({
            ok: true,
            totalTodos: sum.todos.totalCount,
            todoCounts: Object.fromEntries(
              Object.entries(sum.todos.categories).map(([k, v]) => [k, { label: v.label, count: v.count, degraded: v.degraded }]),
            ),
            boards: sum.boards,
            partialErrors: sum.partialErrors,
          });
        } catch (err) {
          return toolFailure('forge_workbench_todo_summary', err);
        }
      },
    },
  ];
}
