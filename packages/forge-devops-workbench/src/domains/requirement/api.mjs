/**
 * 需求域（需求列表 / 需求与故事详情 / 迭代条目 / RMP 文档检索与大纲正文）API 适配器。
 * 二期新增领域（project / dev / efficiency / testing）可直接参照本模块结构扩展。
 */
import { ERROR_CODES, WorkbenchError } from '../../shared/errors.mjs';

export const EXCLUSIVE_REQ_VIEWS = Object.freeze([
  'managedByMe',
  'acceptanceByMe',
  'appliedByMe',
  'participantHasMe',
]);

/**
 * 创建需求域上游 API 客户端。
 *
 * @param {(() => object) | { getDopClient: () => object, getRmpClient: () => object }} getDopOrPorts
 * @param {() => object} [getRmpArg]
 */
export function createRequirementApi(getDopOrPorts, getRmpArg) {
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
    queryRequirements({ view = 'managedByMe', search = '', pageNum = 1, pageSize = 20, signal, requestId } = {}) {
      if (!EXCLUSIVE_REQ_VIEWS.includes(view)) {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `不支持的需求视角: ${String(view)}`, { requestId });
      }
      const query = { search, pageNum, pageSize };
      for (const candidate of EXCLUSIVE_REQ_VIEWS) {
        query[candidate] = candidate === view ? 'true' : 'false';
      }
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/commonDashboard/requirement/query',
        query,
        routeKey: 'requirements.query',
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

    getRequirementOne({ id, signal, requestId } = {}) {
      const cleanId = String(id ?? '').trim();
      if (cleanId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少需求标识 requirementId', { requestId });
      }
      return dop().requestDop({
        method: 'GET',
        path: `/asd/api/requirement/one/${encodeURIComponent(cleanId)}`,
        routeKey: 'requirements.one',
        signal,
        requestId,
      });
    },

    getStoryOne({ id, signal, requestId } = {}) {
      const cleanId = String(id ?? '').trim();
      if (cleanId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少用户故事标识 storyId', { requestId });
      }
      return dop().requestDop({
        method: 'GET',
        path: `/asd/api/story/one/${encodeURIComponent(cleanId)}`,
        routeKey: 'story.one',
        signal,
        requestId,
      });
    },

    getSprintIssueListBySprint({
      sprintId,
      pageNum = 1,
      pageSize = 20,
      search = '',
      assignToUserId = '',
      signal,
      requestId,
    } = {}) {
      const cleanSprintId = String(sprintId ?? '').trim();
      if (cleanSprintId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少迭代标识 sprintId', { requestId });
      }
      return dop().requestDop({
        method: 'GET',
        path: `/asd/api/sprint/${encodeURIComponent(cleanSprintId)}/issue/list`,
        query: { pageNum, pageSize, search, assignToUserId },
        routeKey: 'story.sprintIssues',
        signal,
        requestId,
      });
    },

    getSprintIssueList({ sprintId, signal, requestId } = {}) {
      const cleanSprintId = String(sprintId ?? '').trim();
      if (cleanSprintId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少迭代标识 sprintId', { requestId });
      }
      return dop().requestDop({
        method: 'GET',
        path: `/asd/api/sprint/${encodeURIComponent(cleanSprintId)}/issue/list`,
        query: { pageNum: 1, pageSize: 20, search: '', assignToUserId: '' },
        routeKey: 'story.sprintIssues',
        signal,
        requestId,
      });
    },

    getStoryReqItems({ storyId, pageNum = 1, pageSize = 20, signal, requestId } = {}) {
      const cleanId = String(storyId ?? '').trim();
      if (cleanId === '') {
        throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少用户故事标识 storyId', { requestId });
      }
      return dop().requestDop({
        method: 'GET',
        path: '/asd/api/story/reqItem/query',
        query: { storyId: cleanId, pageNum, pageSize },
        routeKey: 'story.reqItems',
        signal,
        requestId,
      });
    },

    listAllVerDoc(params = {}) {
      return rmp().listAllVerDoc(params);
    },

    listAllNewVerDoc(params = {}) {
      return rmp().listAllNewVerDoc(params);
    },

    listRelDocByReqCode(params = {}) {
      return rmp().listRelDocByReqCode(params);
    },

    getOutlineTree(params = {}) {
      return rmp().getOutlineTree(params);
    },

    getTabContent(params = {}) {
      return rmp().getTabContent(params);
    },
  });
}
