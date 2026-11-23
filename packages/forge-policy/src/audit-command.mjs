/**
 * 只读命令 `/policy-audit [N]`：注册即读，不写审计、不改策略状态、不触发重扫。
 *
 * 宿主没有 `commands` 服务时注册是空操作（返回空 disposer），不阻断插件挂载。
 * 命令输出只经 `audit-query.mjs` 的格式化层，异常一律折算成"审计源不可读"。
 */
import { formatAuditReport, parseAuditCount } from './audit-query.mjs';

export const AUDIT_COMMAND_NAME = 'policy-audit';
export const AUDIT_COMMAND_DESCRIPTION = '查看最近 N 条策略审计摘要（只读；默认 20，上限 200）。';
export const AUDIT_COMMAND_HINT = '条数 N，可选，1–200，默认 20';

/**
 * @param {object} ctx 提供 `commands` 的宿主上下文
 * @param {{audit?: {read?: Function}}} [options] 审计屏障（需有只读 `read`）
 * @returns {Function} disposer；没有 commands 服务时是空操作
 */
export function registerAuditCommand(ctx, options = {}) {
  const audit = options.audit;
  const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined;
  if (commands === undefined || commands === null || typeof commands.register !== 'function') {
    return () => {};
  }
  return commands.register({
    name: AUDIT_COMMAND_NAME,
    description: AUDIT_COMMAND_DESCRIPTION,
    input: { hint: AUDIT_COMMAND_HINT },
    handler: async (invocation) => {
      const parsed = parseAuditCount(invocation?.rawInput);
      let snapshot;
      try {
        snapshot = audit !== undefined && audit !== null && typeof audit.read === 'function'
          ? await audit.read({ limit: parsed.limit })
          : { records: [], corrupt: 0, missing: true, unreadable: false };
      } catch {
        snapshot = { records: [], corrupt: 0, missing: false, unreadable: true };
      }
      const report = formatAuditReport(snapshot);
      if (report.kind !== 'success' || parsed.note === undefined) return report;
      return Object.freeze({ kind: 'success', text: `${report.text}\n${parsed.note}` });
    },
  });
}
