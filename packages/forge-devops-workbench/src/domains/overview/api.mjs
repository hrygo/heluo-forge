/**
 * 总览域（7 路待办 + 三大进展板 + ITSM 实时换链）API 适配器。
 * 复用 `shared/dop-client`（裸头 + 403）与 `shared/rmp-sso`（/sso 换 _tk）。
 */
import { ERROR_CODES, WorkbenchError } from '../../shared/errors.mjs';

export const REQ_PROGRESS_VIEWS = Object.freeze(['manager', 'business']);
export const IMPL_PROGRESS_VIEWS = Object.freeze(['responsible', 'participate', 'creator']);
export const PROJ_PROGRESS_VIEWS = Object.freeze(['responsible', 'participant']);

/**
 * 创建总览域上游 API 客户端。
 *
 * @param {(() => object) | { getDopClient: () => object, getRmpClient: () => object }} getDopOrPorts
 * @param {() => object} [getRmpArg]
 */
export function createOverviewApi(getDopOrPorts, getRmpArg) {
  const getDopClient = typeof getDopOrPorts === 'function' ? getDopOrPorts : getDopOrPorts?.getDopClient;
  const getRmpClient = typeof getDopOrPorts === 'function' ? getRmpArg : getDopOrPorts?.getRmpClient;

  const dop = () => {
    const client = typeof getDopClient === 'function' ? getDopClient() : getDopClient;
    if (!client || typeof client.requestDop !== 'function') {
      throw new WorkbenchError(ERROR_CODES.CONFIG_MISSING, undefined, { upstream: 'dop-api' });
    }
    return client;
  };

  const rmp = () => {
    const client = typeof getRmpClient === 'function' ? getRmpClient() : getRmpClient;
    if (!client) {
      throw new WorkbenchError(ERROR_CODES.CONFIG_MISSING, undefined, { upstream: 'rmp-api' });
    }
    return client;
  };

  return Object.freeze({
    getTodoList({ pageNum = 1, pageSize = 20, signal, requestId } = {}) {
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/todo/list',
        query: { pageNum, pageSize },
        routeKey: 'todo.global',
        signal,
        requestId,
      });
    },

    getMyIssues({ pageNum = 1, pageSize = 20, typeIds = 'main_story,assistance_story', signal, requestId } = {}) {
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/issue/myIssue/list',
        query: { pageNum, pageSize, typeIds },
        routeKey: 'todo.stories',
        signal,
        requestId,
      });
    },

    getBizFlowTasks({ pageNum = 1, pageSize = 20, signal, requestId } = {}) {
      return dop().requestDop({
        method: 'GET',
        path: '/odo/api/bizFlow/myTasks',
        query: { pageNum, pageSize },
        routeKey: 'todo.bizFlow',
        signal,
        requestId,
      });
    },

    queryMyDefects({ pageNum = 1, pageSize = 20, signal, requestId } = {}) {
      return dop().requestDop({
        method: 'POST',
        path: '/tmp/api/app/defect/myDefect/query',
        body: { pageNum, pageSize },
        routeKey: 'todo.defects',
        signal,
        requestId,
      });
    },

    getProcalmationList({ page = 1, size = 20, signal, requestId } = {}) {
      return dop().requestDop({
        method: 'GET',
        path: '/odo/api/procalmation/list',
        query: { page, size },
        routeKey: 'todo.announcements',
        signal,
        requestId,
      });
    },

    getOnlineProcessList({ page = 1, size = 20, type = 'todo', signal, requestId } = {}) {
      return dop().requestDop({
        method: 'GET',
        path: '/odo/api/online/process/list',
        query: { page, size, type },
        routeKey: 'todo.itsm',
        signal,
        requestId,
      });
    },

    getOnlineProcessUrl({ wjbiid, signal, requestId } = {}) {
      const cleanId = String(wjbiid ?? '').trim();
      if (cleanId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少 ITSM 工单标识 wjbiid', { requestId });
      }
      return dop().requestDop({
        method: 'GET',
        path: '/odo/api/online/process/url',
        query: { wjbiid: cleanId },
        routeKey: 'todo.itsm.openUrl',
        signal,
        requestId,
      });
    },

    getRequirementProgress({ type = 'manager', signal, requestId } = {}) {
      const resolvedType = REQ_PROGRESS_VIEWS.includes(type) ? type : 'manager';
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/dashboard/requirement/progress',
        query: { type: resolvedType },
        routeKey: 'board.req.progress',
        signal,
        requestId,
      });
    },

    getRequirementInProgress({ type = 'manager', signal, requestId } = {}) {
      const resolvedType = REQ_PROGRESS_VIEWS.includes(type) ? type : 'manager';
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/dashboard/requirement/inProgress',
        query: { type: resolvedType },
        routeKey: 'board.req.inProgress',
        signal,
        requestId,
      });
    },

    getReleaseProgress({ personnel = 'responsible', signal, requestId } = {}) {
      const resolved = IMPL_PROGRESS_VIEWS.includes(personnel) ? personnel : 'responsible';
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/release/progress',
        query: { personnel: resolved },
        routeKey: 'board.impl.release',
        signal,
        requestId,
      });
    },

    getStoryProgress({ personnel = 'responsible', signal, requestId } = {}) {
      const resolved = IMPL_PROGRESS_VIEWS.includes(personnel) ? personnel : 'responsible';
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/story/progress',
        query: { personnel: resolved },
        routeKey: 'board.impl.story',
        signal,
        requestId,
      });
    },

    getProjectProgress({ qType = 'responsible', signal, requestId } = {}) {
      const resolved = PROJ_PROGRESS_VIEWS.includes(qType) ? qType : 'responsible';
      return dop().requestDop({
        method: 'GET',
        path: '/ppm/api/project/progress',
        query: { qType: resolved },
        routeKey: 'board.proj.progress',
        signal,
        requestId,
      });
    },

    listRmpTodoTasks(params = {}) {
      return rmp().listAllTodoTask(params);
    },
  });
}
