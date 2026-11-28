/**
 * 总览域（ITSM / 审批流 / 全局待办中心 / 三大进展板指标）外链路由器。
 */

/**
 * 基于已安全清洗的 `join(subPath)` 构造总览域外链方法。
 *
 * @param {(subPath: string) => string} join
 */
export function buildOverviewLinks(join) {
  return Object.freeze({
    itsmUrl(wjbiid) {
      const clean = String(wjbiid ?? '').trim();
      return clean
        ? join(`/backstage/workflow/serviceApply/applyCopyView?wjbiid=${encodeURIComponent(clean)}`)
        : '';
    },
    bizFlowUrl(definitionKey, taskId) {
      const key = String(definitionKey ?? '').trim();
      const tid = String(taskId ?? '').trim();
      if (key && tid) {
        return join(`/dop/asd/${encodeURIComponent(key)}?taskId=${encodeURIComponent(tid)}`);
      }
      return join('/dop/asd/dashboard');
    },
    todoCenterUrl() {
      return join('/dop/asd/dashboard');
    },
    /**
     * 三大进展板指标/阶段节点外链模板（P0-5：DOP 全局工作台中心 `/dop/asd/dashboard`，
     * 预留 boardKey / metricKey / view 参数以便后续对接细粒度列表筛选路由）。
     */
    boardLink(_boardKey, _metricKey, _view) {
      return join('/dop/asd/dashboard');
    },
  });
}
