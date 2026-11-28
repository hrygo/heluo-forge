/**
 * 总览域业务编排（顶部 7 路并发待办 + 5 路三大进展板聚合 + ITSM 单实例免密换链）。
 */
import { ERROR_CODES, toErrorEnvelope, WorkbenchError } from '../../shared/errors.mjs';
import { sanitizePortalUrl } from '../../shared/url-safety.mjs';
import {
  createOverviewApi,
  IMPL_PROGRESS_VIEWS,
  PROJ_PROGRESS_VIEWS,
  REQ_PROGRESS_VIEWS,
} from './api.mjs';

function summarizeTodoCategories(results, existingProfileName = '', portalLinks = null) {
  const specs = [
    {
      key: 'global',
      label: '全局待办',
      domain: 'dop',
      extract: (d) => ({
        count: Number(d?.totalItems ?? (Array.isArray(d?.items) ? d.items.length : 0)),
        items: (Array.isArray(d?.items) ? d.items : []).slice(0, 10).map((it) => ({
          id: it.id ?? it.code ?? '',
          code: it.code ?? it.id ?? '',
          title: it.summary ?? it.title ?? it.name ?? '全局待办项',
          state: it.state?.name ?? it.status ?? '',
          date: it.planOnlineDate ?? it.createDate ?? '',
          portalUrl: portalLinks?.todoCenterUrl?.() ?? '',
        })),
      }),
    },
    {
      key: 'stories',
      label: '故事 / 任务',
      domain: 'dop',
      extract: (d) => ({
        count: Number(d?.totalItems ?? (Array.isArray(d?.items) ? d.items.length : 0)),
        items: (Array.isArray(d?.items) ? d.items : []).slice(0, 10).map((it) => ({
          id: it.id ?? it.code ?? '',
          code: it.code ?? '',
          title: it.summary ?? '用户故事',
          state: it.state?.name ?? '',
          progressState: it.progressState?.name ?? '',
          date: it.planOnlineDate ?? '',
          delayed: Boolean(it.scheduleDelay || it.releaseDelay),
          portalUrl: portalLinks?.storyUrl?.(it.id || it.code) ?? '',
        })),
      }),
    },
    {
      key: 'bizFlow',
      label: '流程 / 评审会',
      domain: 'dop',
      extract: (d) => {
        const list = Array.isArray(d?.data?.workItems) ? d.data.workItems : [];
        return {
          count: Number(d?.data?.total ?? d?.total ?? list.length),
          items: list.slice(0, 10).map((it) => {
            const defKey = it.processDefinitionKey ?? it.definitionKey ?? it.definition?.key ?? '';
            const taskId = it.taskId ?? it.id ?? it.businessId ?? '';
            return {
              id: it.id ?? it.businessId ?? '',
              code: it.code ?? '',
              title: it.title ?? it.name ?? '流程任务',
              state: it.status ?? it.state ?? '',
              date: it.createTime ?? '',
              portalUrl: portalLinks?.bizFlowUrl?.(defKey, taskId) ?? portalLinks?.todoCenterUrl?.() ?? '',
            };
          }),
        };
      },
    },
    {
      key: 'defects',
      label: '阻塞缺陷',
      domain: 'dop',
      extract: (d) => ({
        count: Number(d?.totalItems ?? (Array.isArray(d?.items) ? d.items.length : 0)),
        items: (Array.isArray(d?.items) ? d.items : []).slice(0, 10).map((it) => ({
          id: it.id ?? it.code ?? '',
          code: it.code ?? '',
          title: it.summary ?? it.title ?? '缺陷项',
          state: it.state?.name ?? '',
          date: it.createDate ?? '',
          portalUrl: portalLinks?.todoCenterUrl?.() ?? '',
        })),
      }),
    },
    {
      key: 'announcements',
      label: '公告 / 发布窗口',
      domain: 'dop',
      extract: (d) => {
        const list = Array.isArray(d?.data)
          ? d.data
          : (Array.isArray(d?.data?.items) ? d.data.items : []);
        return {
          count: Number(d?.total ?? d?.data?.total ?? list.length),
          items: list.slice(0, 10).map((it) => ({
            id: it.id ?? '',
            code: it.id ?? '',
            title: it.procalmationTitle ?? it.title ?? '发布窗口公告',
            state: it.startTime
              ? `${it.startTime} ~ ${it.endTime ?? ''}`
              : (it.windowStart ? `${it.windowStart} ~ ${it.windowEnd ?? ''}` : ''),
            date: it.createTime ?? it.publishTime ?? '',
            portalUrl: portalLinks?.todoCenterUrl?.() ?? '',
          })),
        };
      },
    },
    {
      key: 'itsm',
      label: 'ITSM 工单',
      domain: 'dop',
      extract: (d) => {
        const list = Array.isArray(d?.data?.results) ? d.data.results : [];
        return {
          count: Number(d?.data?.totalRecord ?? d?.total ?? list.length),
          items: list.slice(0, 10).map((it) => {
            const wjbiid = String(it.WJBIID ?? '').trim();
            return {
              id: it.BUSINESS_ID ?? it.ID_ ?? wjbiid,
              code: it.BUSINESS_ID ?? '',
              wjbiid,
              title: it.title ?? 'ITSM 工单',
              state: it.USERTASK_NAME ?? it.typeName ?? '',
              date: it.ASSIGN_TIME ?? it.CREATETIME ?? '',
              portalUrl: portalLinks?.itsmUrl?.(wjbiid || it.BUSINESS_ID || it.ID_) ?? '',
            };
          }),
        };
      },
    },
    {
      key: 'rmp',
      label: '需求平台待办',
      domain: 'rmp',
      extract: (d) => {
        const list = Array.isArray(d?.data?.resultList) ? d.data.resultList : [];
        return {
          count: Number(d?.data?.totalRows ?? list.length),
          items: list.slice(0, 10).map((it) => ({
            id: it.iid ?? it.docid ?? it.id ?? '',
            code: it.code ?? '',
            title: it.docname ?? it.title ?? `${existingProfileName || ''} 需求任务`.trim(),
            state: it.docstatus ?? it.status ?? '',
            date: it.createTime ?? '',
            portalUrl: portalLinks?.rmpDocUrl?.(it.docid ?? it.iid ?? it.code) ?? '',
          })),
        };
      },
    },
  ];

  const categories = {};
  const partialErrors = [];
  let totalCount = 0;

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const settled = results[i];
    if (settled?.status === 'fulfilled') {
      const normalized = spec.extract(settled.value);
      totalCount += normalized.count;
      categories[spec.key] = {
        key: spec.key,
        label: spec.label,
        count: normalized.count,
        items: normalized.items,
        degraded: false,
        error: null,
      };
    } else {
      const env = toErrorEnvelope(settled?.reason, { partialData: null });
      partialErrors.push({
        domain: spec.domain,
        routeKey: `todo.${spec.key}`,
        ...env.error,
      });
      categories[spec.key] = {
        key: spec.key,
        label: spec.label,
        count: 0,
        items: [],
        degraded: true,
        error: env.error,
      };
    }
  }

  return { totalCount, categories, partialErrors };
}

/**
 * 创建总览域服务实例。
 *
 * @param {{ runtime: ReturnType<import('../../shared/session-runtime.mjs').createSessionRuntime>, logger?: Function }} options
 */
export function createOverviewDomain({ runtime, logger }) {
  const api = createOverviewApi(
    () => runtime.dopClient,
    () => runtime.rmpClient,
  );

  let summarySeq = 0;
  /** @type {Map<string, Promise<object>>} */
  const inFlightSummary = new Map();

  runtime.onConfigChange(() => {
    inFlightSummary.clear();
  });
  runtime.onDispose(() => {
    inFlightSummary.clear();
  });

  async function getSummary({
    reqView = 'manager',
    implView = 'responsible',
    projView = 'responsible',
    refresh = false,
  } = {}) {
    runtime.assertActive();
    if (!REQ_PROGRESS_VIEWS.includes(reqView)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `无效需求看板视角: ${String(reqView)}`);
    }
    if (!IMPL_PROGRESS_VIEWS.includes(implView)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `无效实施看板视角: ${String(implView)}`);
    }
    if (!PROJ_PROGRESS_VIEWS.includes(projView)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `无效项目看板视角: ${String(projView)}`);
    }

    const authState = await runtime.resolveAuthSession({ allowSignedOut: false });
    const cacheKey = `${authState.sessionKey}|${reqView}|${implView}|${projView}`;

    if (!refresh && inFlightSummary.has(cacheKey)) {
      return inFlightSummary.get(cacheKey);
    }

    summarySeq += 1;
    const mySeq = summarySeq;
    const tracked = runtime.trackController();
    const signal = tracked.controller.signal;
    const portalLinks = runtime.portalLinks;
    const endpointKind = runtime.endpointKind;
    const isLoopbackEndpoint = runtime.isLoopbackEndpoint;

    const task = (async () => {
      try {
        const profile = await runtime.loadCachedProfile(authState.sessionKey, { refresh: false, signal }).catch(() => null);
        const userName = profile?.loginCode || '';

        const [todoResults, boardResults] = await Promise.all([
          Promise.allSettled([
            api.getTodoList({ signal }),
            api.getMyIssues({ signal }),
            api.getBizFlowTasks({ signal }),
            api.queryMyDefects({ signal }),
            api.getProcalmationList({ signal }),
            api.getOnlineProcessList({ signal }),
            api.listRmpTodoTasks({ sessionKey: authState.sessionKey, userName, signal }),
          ]),
          Promise.allSettled([
            api.getRequirementProgress({ type: reqView, signal }),
            api.getRequirementInProgress({ type: reqView, signal }),
            api.getReleaseProgress({ personnel: implView, signal }),
            api.getStoryProgress({ personnel: implView, signal }),
            api.getProjectProgress({ qType: projView, signal }),
          ]),
        ]);

        const todosSummary = summarizeTodoCategories(todoResults, profile?.name, portalLinks);
        const partialErrors = [...todosSummary.partialErrors];

        const boardKeys = [
          'board.req.progress',
          'board.req.inProgress',
          'board.impl.release',
          'board.impl.story',
          'board.proj.progress',
        ];
        const boardData = [];
        for (let i = 0; i < boardResults.length; i += 1) {
          const settled = boardResults[i];
          if (settled.status === 'fulfilled') {
            boardData.push({ ok: true, data: settled.value, error: null });
          } else {
            const env = toErrorEnvelope(settled.reason, { endpointKind, partialData: null });
            const errItem = { domain: 'dop', routeKey: boardKeys[i], ...env.error };
            partialErrors.push(errItem);
            boardData.push({ ok: false, data: null, error: errItem });
            logger?.('workbench.api.partial_error', errItem);
          }
        }

        for (const todoErr of todosSummary.partialErrors) {
          logger?.('workbench.api.partial_error', todoErr);
        }

        return {
          ok: true,
          requestSeq: mySeq,
          isLatest: mySeq === summarySeq,
          endpointKind,
          isLoopbackEndpoint,
          todos: {
            totalCount: todosSummary.totalCount,
            categories: todosSummary.categories,
          },
          boards: {
            requirement: {
              view: reqView,
              progress: boardData[0].data,
              inProgress: boardData[1].data,
              links: {
                total: portalLinks.boardLink('requirement', 'total', reqView),
                abnormal: portalLinks.boardLink('requirement', 'abnormal', reqView),
                avgAccept: portalLinks.boardLink('requirement', 'avgAccept', reqView),
                avgAnalyze: portalLinks.boardLink('requirement', 'avgAnalyze', reqView),
                inProgress: portalLinks.boardLink('requirement', 'inProgress', reqView),
                pending: portalLinks.boardLink('requirement', 'pending', reqView),
                reviewed: portalLinks.boardLink('requirement', 'reviewed', reqView),
                inOperation: portalLinks.boardLink('requirement', 'inOperation', reqView),
                accepted: portalLinks.boardLink('requirement', 'accepted', reqView),
                released: portalLinks.boardLink('requirement', 'released', reqView),
              },
              errors: [boardData[0].error, boardData[1].error].filter(Boolean),
            },
            implementation: {
              view: implView,
              release: boardData[2].data,
              story: boardData[3].data,
              links: {
                release: {
                  approving: portalLinks.boardLink('implementation', 'release.approving', implView),
                  changing: portalLinks.boardLink('implementation', 'release.changing', implView),
                  waitReleasing: portalLinks.boardLink('implementation', 'release.waitReleasing', implView),
                  releasing: portalLinks.boardLink('implementation', 'release.releasing', implView),
                  delayed: portalLinks.boardLink('implementation', 'release.delayed', implView),
                },
                story: {
                  total: portalLinks.boardLink('implementation', 'story.total', implView),
                  normal: portalLinks.boardLink('implementation', 'story.normal', implView),
                  pause: portalLinks.boardLink('implementation', 'story.pause', implView),
                  releaseDelay: portalLinks.boardLink('implementation', 'story.releaseDelay', implView),
                  scheduleDelay: portalLinks.boardLink('implementation', 'story.scheduleDelay', implView),
                },
              },
              errors: [boardData[2].error, boardData[3].error].filter(Boolean),
            },
            project: {
              view: projView,
              progress: boardData[4].data,
              links: {
                total: portalLinks.boardLink('project', 'total', projView),
                delay: portalLinks.boardLink('project', 'delay', projView),
                newCreate: portalLinks.boardLink('project', 'newCreate', projView),
                requirementAnalysis: portalLinks.boardLink('project', 'requirementAnalysis', projView),
                projectApplication: portalLinks.boardLink('project', 'projectApplication', projView),
                projectPlanning: portalLinks.boardLink('project', 'projectPlanning', projView),
                designAndDevelopment: portalLinks.boardLink('project', 'designAndDevelopment', projView),
                systemTesting: portalLinks.boardLink('project', 'systemTesting', projView),
                acceptanceTesting: portalLinks.boardLink('project', 'acceptanceTesting', projView),
                regressionTesting: portalLinks.boardLink('project', 'regressionTesting', projView),
                release: portalLinks.boardLink('project', 'release', projView),
              },
              errors: [boardData[4].error].filter(Boolean),
            },
          },
          partialErrors,
        };
      } finally {
        tracked.release();
        if (inFlightSummary.get(cacheKey) === task) {
          inFlightSummary.delete(cacheKey);
        }
      }
    })();

    inFlightSummary.set(cacheKey, task);
    return task;
  }

  async function resolveItsmPortalUrl({ wjbiid } = {}) {
    runtime.assertActive();
    const cleanId = String(wjbiid ?? '').trim();
    if (!cleanId) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少 ITSM 工单标识 wjbiid');
    }
    await runtime.resolveAuthSession({ allowSignedOut: false });
    const tracked = runtime.trackController();
    const portalLinks = runtime.portalLinks;
    try {
      const res = await api.getOnlineProcessUrl({ wjbiid: cleanId, signal: tracked.controller.signal });
      const safeUrl = sanitizePortalUrl(res?.data ?? '');
      if (safeUrl) {
        return { ok: true, url: safeUrl, source: 'itsm-sso' };
      }
      const fallback = sanitizePortalUrl(portalLinks.itsmUrl(cleanId));
      if (fallback) {
        return { ok: true, url: fallback, source: 'fallback' };
      }
      throw new WorkbenchError(ERROR_CODES.UPSTREAM_SCHEMA_DRIFT, 'ITSM 跳转链接格式无效', { upstream: 'dop-odo' });
    } finally {
      tracked.release();
    }
  }

  return Object.freeze({
    getSummary,
    resolveItsmPortalUrl,
  });
}
