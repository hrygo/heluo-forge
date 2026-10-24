/**
 * 探针用只读适配器：把 `devopsReader` 服务提供给 `@heluo/forge-devops`。
 *
 * 它只做一件事——每次被调用就往 `PROBE_READER_LOG` 追加一行 `{action, target}`，
 * 并返回带 `source_revision` 的结构化事实。日志文件是"调用真的穿过了策略门禁、
 * 到达适配器"的物证；凭据、真实平台与网络都不涉及。
 */
import { appendFileSync } from 'node:fs';

export const name = 'probe-devops-reader';
export const inject = [];

export function apply(ctx) {
  ctx.provide('devopsReader', {
    async read({ action, target }) {
      const log = process.env.PROBE_READER_LOG;
      if (typeof log === 'string' && log.length > 0) {
        appendFileSync(log, `${JSON.stringify({ action, target })}\n`);
      }
      return {
        status: 'succeeded',
        target_ref: target,
        source_revision: 'probe-rev-1',
        result_refs: [`${target}@probe-rev-1`],
        observed_at: '2026-10-24T00:00:00Z',
      };
    },
  });
  return () => {};
}
