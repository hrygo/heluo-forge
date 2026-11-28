/**
 * 需求域业务编排（我的需求/用户故事、RMP 文档检索与大纲正文读取、四类提示词上下文装配）。
 */
import { Buffer } from 'node:buffer';
import { ERROR_CODES, toErrorEnvelope, WorkbenchError } from '../../shared/errors.mjs';
import { MAX_DOC_INJECT_BYTES, stripHtmlToText, truncateUtf8Bytes } from '../../shared/prompt-utils.mjs';
import { createRequirementApi, EXCLUSIVE_REQ_VIEWS } from './api.mjs';
import { buildRequirementPrompt, REQUIREMENT_PROMPT_ACTION_KEYS } from './prompts.mjs';

const MAX_LOCAL_CONTENT_BYTES = 32 * 1024;
const MAX_RMP_SECTIONS_PER_PROMPT = 12;

/**
 * 创建需求域服务实例。
 *
 * @param {{ runtime: ReturnType<import('../../shared/session-runtime.mjs').createSessionRuntime>, cliBridge?: object, logger?: Function }} options
 */
export function createRequirementDomain({ runtime, cliBridge = null, logger }) {
  const api = createRequirementApi(
    () => runtime.dopClient,
    () => runtime.rmpClient,
  );

  async function getRequirements({ view = 'managedByMe', search = '', pageNum = 1, pageSize = 20 } = {}) {
    runtime.assertActive();
    if (!EXCLUSIVE_REQ_VIEWS.includes(view)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `不支持的需求视角: ${String(view)}`);
    }
    await runtime.resolveAuthSession({ allowSignedOut: false });

    const tracked = runtime.trackController();
    const signal = tracked.controller.signal;
    const portalLinks = runtime.portalLinks;
    const endpointKind = runtime.endpointKind;

    try {
      const [reqSettled, storySettled] = await Promise.allSettled([
        api.queryRequirements({ view, search, pageNum, pageSize, signal }),
        api.getMyIssues({ pageNum, pageSize, signal }),
      ]);

      const partialErrors = [];
      let requirements = { items: [], totalItems: 0, pageNum, pageSize };
      if (reqSettled.status === 'fulfilled') {
        const rawReqs = reqSettled.value;
        requirements = {
          ...rawReqs,
          items: Array.isArray(rawReqs?.items)
            ? rawReqs.items.map((it) => ({
              ...it,
              portalUrl: portalLinks.requirementUrl(it?.requirementId || it?.requirementNo),
            }))
            : [],
        };
      } else {
        const env = toErrorEnvelope(reqSettled.reason, { endpointKind });
        partialErrors.push({ domain: 'dop', routeKey: 'requirements.query', ...env.error });
      }

      let stories = { items: [], totalItems: 0, pageNum, pageSize };
      if (storySettled.status === 'fulfilled') {
        const rawStories = storySettled.value;
        stories = {
          ...rawStories,
          items: Array.isArray(rawStories?.items)
            ? rawStories.items.map((it) => ({
              ...it,
              portalUrl: portalLinks.storyUrl(it?.id || it?.code),
            }))
            : [],
        };
      } else {
        const env = toErrorEnvelope(storySettled.reason, { endpointKind });
        partialErrors.push({ domain: 'dop', routeKey: 'todo.stories', ...env.error });
      }

      return {
        ok: true,
        view,
        requirements,
        stories,
        partialErrors,
      };
    } finally {
      tracked.release();
    }
  }

  async function searchRmpDocs({
    quickSearch = '',
    latestOnly = false,
    reqCode = '',
    currentPage = 1,
    numPerPage = 10,
  } = {}) {
    runtime.assertActive();
    const authState = await runtime.resolveAuthSession({ allowSignedOut: false });
    const tracked = runtime.trackController();
    const portalLinks = runtime.portalLinks;
    try {
      let raw;
      if (reqCode && !quickSearch) {
        raw = await api.listRelDocByReqCode({
          sessionKey: authState.sessionKey,
          reqCode,
          signal: tracked.controller.signal,
        });
      } else if (latestOnly) {
        raw = await api.listAllNewVerDoc({
          sessionKey: authState.sessionKey,
          reqCode,
          quickSearch,
          currentPage,
          numPerPage,
          signal: tracked.controller.signal,
        });
      } else {
        raw = await api.listAllVerDoc({
          sessionKey: authState.sessionKey,
          reqCode,
          quickSearch,
          currentPage,
          numPerPage,
          signal: tracked.controller.signal,
        });
      }

      const items = (Array.isArray(raw?.data?.resultList) ? raw.data.resultList : []).map((doc) => ({
        ...doc,
        portalUrl: portalLinks.rmpDocUrl(doc?.docid || doc?.iid || doc?.code),
      }));
      const totalRows = Number(raw?.data?.totalRows ?? items.length);
      return {
        ok: true,
        items,
        totalRows,
        currentPage: Number(raw?.data?.currentPage ?? currentPage),
        numPerPage: Number(raw?.data?.numPerPage ?? numPerPage),
      };
    } finally {
      tracked.release();
    }
  }

  async function getRmpOutline({ docId, associatedSystem = '', currentPage = 1, numPerPage = 100 } = {}) {
    runtime.assertActive();
    const authState = await runtime.resolveAuthSession({ allowSignedOut: false });
    const tracked = runtime.trackController();
    try {
      const raw = await api.getOutlineTree({
        sessionKey: authState.sessionKey,
        docId,
        associatedSystem,
        currentPage,
        numPerPage,
        signal: tracked.controller.signal,
      });
      return {
        ok: true,
        docId: String(docId),
        nodes: Array.isArray(raw?.data) ? raw.data : [],
      };
    } finally {
      tracked.release();
    }
  }

  async function buildPrompt(input = {}) {
    runtime.assertActive();
    if (!input || typeof input !== 'object') {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '提示词请求参数必须为对象');
    }
    const { actionKey } = input;
    if (!REQUIREMENT_PROMPT_ACTION_KEYS.includes(actionKey)) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `一期不支持的提示词动作键: ${String(actionKey ?? '')}`);
    }

    const authState = await runtime.resolveAuthSession({ allowSignedOut: false });
    const tracked = runtime.trackController();
    const signal = tracked.controller.signal;

    try {
      let promptResult;

      if (actionKey === 'req.create.one_sentence') {
        const profile = await runtime.loadCachedProfile(authState.sessionKey, { signal }).catch(() => null);
        promptResult = buildRequirementPrompt({
          actionKey,
          idea: input.idea,
          ownerName: input.ownerName || profile?.name || '当前用户',
        });
      } else if (actionKey === 'req.clarify.from_doc') {
        if (input.source === 'local') {
          const rawContent = String(input.content ?? '');
          if (Buffer.byteLength(rawContent, 'utf8') > MAX_LOCAL_CONTENT_BYTES) {
            throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '本地文档传入摘录不得超过 32 KiB');
          }
          promptResult = buildRequirementPrompt({
            actionKey,
            source: 'local',
            docName: input.docName || input.fileName,
            docVer: input.docVer || '',
            content: rawContent,
          });
        } else {
          const docId = String(input.docId ?? '').trim();
          const requestedSections = Array.isArray(input.sections)
            ? input.sections
            : (Array.isArray(input.sectionIids) ? input.sectionIids.map((iid) => ({ iid })) : []);
          if (!docId || requestedSections.length === 0) {
            throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '请指定 RMP 文档 docId 与至少 1 个章节节点');
          }
          const limitedSections = requestedSections.slice(0, MAX_RMP_SECTIONS_PER_PROMPT);
          const warnings = [];
          if (requestedSections.length > MAX_RMP_SECTIONS_PER_PROMPT) {
            warnings.push(`单次最多注入前 ${MAX_RMP_SECTIONS_PER_PROMPT} 个章节，其余未拉取`);
          }

          const settledTabs = await Promise.allSettled(
            limitedSections.map((sec) => api.getTabContent({
              sessionKey: authState.sessionKey,
              iid: sec.iid ?? sec.idoc_id ?? '',
              emptyContent: sec.emptyContent,
              signal,
            })),
          );

          const hydratedSections = [];
          for (let i = 0; i < limitedSections.length; i += 1) {
            const metaSec = limitedSections[i];
            const res = settledTabs[i];
            if (res.status === 'fulfilled') {
              hydratedSections.push({
                iid: metaSec.iid ?? metaSec.idoc_id,
                scode: metaSec.scode ?? '',
                sname: metaSec.sname ?? res.value?.data?.sname ?? '',
                html: res.value?.data?.html ?? '',
              });
            } else {
              warnings.push(`章节 ${metaSec.scode || metaSec.sname || i + 1} 正文读取失败，已跳过`);
            }
          }

          promptResult = buildRequirementPrompt({
            actionKey,
            source: 'rmp',
            docName: input.docName,
            docVer: input.docVer,
            sections: hydratedSections,
            warnings,
          });
        }
      } else if (actionKey === 'req.card.clarify_and_split') {
        const requirement = await api.getRequirementOne({ id: input.requirementId, signal });
        promptResult = buildRequirementPrompt({
          actionKey,
          mode: input.mode,
          requirement,
        });
      } else {
        // story.card.design_and_prep
        const story = await api.getStoryOne({ id: input.storyId, signal });
        const sprintId = story?.sprint?.id ?? story?.sprintId ?? '';
        const [sprintSettled, reqItemsSettled] = await Promise.allSettled([
          sprintId ? api.getSprintIssueListBySprint({ sprintId, signal }) : Promise.resolve(null),
          api.getStoryReqItems({ storyId: input.storyId, signal }),
        ]);
        const changeCodes = Array.isArray(story?.systemChanges)
          ? story.systemChanges.map((item) => (typeof item === 'string' ? item : item?.code)).filter(Boolean)
          : [];
        const cliHints = cliBridge?.readChangeContextHint?.(changeCodes) ?? null;
        promptResult = buildRequirementPrompt({
          actionKey,
          story,
          sprintIssue: sprintSettled.status === 'fulfilled' ? sprintSettled.value : null,
          reqItems: reqItemsSettled.status === 'fulfilled' ? reqItemsSettled.value : null,
          cliHints,
        });
      }

      logger?.('workbench.prompt.generated', {
        promptKind: promptResult.meta.promptKind,
        docCount: promptResult.meta.docCount,
        charLength: promptResult.meta.charLength,
        truncated: promptResult.meta.truncated,
        deliveryTarget: 'draft-or-clipboard',
      });

      return promptResult;
    } finally {
      tracked.release();
    }
  }

  async function readRequirementDetail({ requirementId } = {}) {
    runtime.assertActive();
    await runtime.resolveAuthSession({ allowSignedOut: false });
    const tracked = runtime.trackController();
    const portalLinks = runtime.portalLinks;
    try {
      const req = await api.getRequirementOne({ id: requirementId, signal: tracked.controller.signal });
      return {
        ok: true,
        id: req?.id ?? requirementId,
        no: req?.no ?? '',
        name: req?.name ?? '',
        stage: req?.stage?.name ?? '',
        state: req?.state?.name ?? '',
        onlineDate: req?.onlineDate ?? null,
        urgency: req?.urgency ?? null,
        manager: req?.manager ? { loginCode: req.manager.loginCode, name: req.manager.name } : null,
        businessOwner: req?.businessOwner
          ? { loginCode: req.businessOwner.loginCode, name: req.businessOwner.name }
          : null,
        backGround: stripHtmlToText(req?.backGround).text,
        description: stripHtmlToText(req?.description).text,
        reqBenefit: stripHtmlToText(req?.reqBenefit).text,
        reqDocs: Array.isArray(req?.reqDocs)
          ? req.reqDocs.map((d) => ({
            docId: String(d?.docId ?? d?.docid ?? d?.docCode ?? ''),
            docCode: String(d?.docCode ?? ''),
            docName: String(d?.docName ?? d?.docname ?? d?.name ?? ''),
            docVer: String(d?.docVer ?? d?.docver ?? ''),
            portalUrl: portalLinks.rmpDocUrl(d?.docId ?? d?.docid ?? d?.docCode),
          }))
          : [],
        portalUrl: portalLinks.requirementUrl(req?.id || requirementId),
      };
    } finally {
      tracked.release();
    }
  }

  async function readStoryDetail({ storyId } = {}) {
    runtime.assertActive();
    await runtime.resolveAuthSession({ allowSignedOut: false });
    const tracked = runtime.trackController();
    const signal = tracked.controller.signal;
    const portalLinks = runtime.portalLinks;
    try {
      const story = await api.getStoryOne({ id: storyId, signal });
      const sprintId = story?.sprint?.id ?? story?.sprintId ?? '';
      const [sprintSettled, reqItemsSettled] = await Promise.allSettled([
        sprintId ? api.getSprintIssueListBySprint({ sprintId, signal }) : Promise.resolve(null),
        api.getStoryReqItems({ storyId, signal }),
      ]);
      const changeCodes = Array.isArray(story?.systemChanges)
        ? story.systemChanges.map((item) => (typeof item === 'string' ? item : item?.code)).filter(Boolean)
        : [];
      const cliHints = cliBridge?.readChangeContextHint?.(changeCodes) ?? null;
      return {
        ok: true,
        id: story?.id ?? storyId,
        code: story?.code ?? '',
        summary: story?.summary ?? '',
        state: story?.state?.name ?? '',
        planOnlineDate: story?.planOnlineDate ?? null,
        priority: story?.priority ?? null,
        storyPoint: story?.storyPoint ?? null,
        requirement: story?.requirement
          ? {
            id: story.requirement.id,
            no: story.requirement.no,
            name: story.requirement.name,
            portalUrl: portalLinks.requirementUrl(story.requirement.id),
          }
          : null,
        description: stripHtmlToText(story?.description).text,
        acceptanceCriteria: stripHtmlToText(story?.storyAC ?? story?.acceptanceCriteria).text,
        systemChanges: story?.systemChanges ?? [],
        sprintEstimate: sprintSettled.status === 'fulfilled' ? sprintSettled.value?.items ?? [] : [],
        linkedReqItems: reqItemsSettled.status === 'fulfilled' ? reqItemsSettled.value?.items ?? [] : [],
        cliHints,
        portalUrl: portalLinks.storyUrl(story?.id || story?.code || storyId),
      };
    } finally {
      tracked.release();
    }
  }

  async function readRmpSection({ iid } = {}) {
    runtime.assertActive();
    const authState = await runtime.resolveAuthSession({ allowSignedOut: false });
    const tracked = runtime.trackController();
    try {
      const raw = await api.getTabContent({
        sessionKey: authState.sessionKey,
        iid,
        signal: tracked.controller.signal,
      });
      const cleaned = stripHtmlToText(raw?.data?.html ?? '');
      const capped = truncateUtf8Bytes(cleaned.text, MAX_DOC_INJECT_BYTES);
      return {
        ok: true,
        iid: String(iid),
        sname: raw?.data?.sname ?? '',
        isEmptyPlaceholder: cleaned.isEmptyPlaceholder,
        truncated: capped.truncated,
        byteLength: capped.byteLength,
        text: capped.text,
      };
    } finally {
      tracked.release();
    }
  }

  return Object.freeze({
    getRequirements,
    searchRmpDocs,
    getRmpOutline,
    readRequirementDetail,
    readStoryDetail,
    readRmpSection,
    buildPrompt,
  });
}
