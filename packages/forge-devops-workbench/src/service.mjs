/**
 * `@heluo/forge-devops-workbench` 纯薄业务装配入口（CORP-DSH-ENG-003 P2）。
 *
 * 职责约束：
 *   1. 本模块零可变状态，不持有状态机、缓存或 AbortController；
 *   2. 唯一运行时状态轴委托 `src/shared/session-runtime.mjs`，各业务域委托 `src/domains/<domain>/service.mjs`；
 *   3. 新增二期领域时只需接入对应域实例与提示词分派行，无需重写基础设施。
 */
import { createCliBridge } from './shared/cli-bridge.mjs';
import { ERROR_CODES, WorkbenchError } from './shared/errors.mjs';
import { createSessionRuntime } from './shared/session-runtime.mjs';
import { createOverviewDomain } from './domains/overview/service.mjs';
import { REQUIREMENT_PROMPT_ACTION_KEYS } from './domains/requirement/prompts.mjs';
import { createRequirementDomain } from './domains/requirement/service.mjs';
import { buildPortalLinks } from './portal-links.mjs';
import { WORKBENCH_TOOLS } from './tools.mjs';

/**
 * 装配 DOP 工作台服务门面。
 *
 * @param {object} options
 */
export function createWorkbenchService(options = {}) {
  const cliBridge = createCliBridge({
    getDevopsService: options.getDevops,
    getGiteeService: options.getGitee,
  });

  const runtime = createSessionRuntime({
    ...options,
    cliBridge,
    buildPortalLinks,
  });

  const overview = createOverviewDomain({ runtime, logger: options.logger });
  const requirement = createRequirementDomain({ runtime, cliBridge, logger: options.logger });

  const PROMPT_DISPATCHERS = Object.freeze([
    { keys: REQUIREMENT_PROMPT_ACTION_KEYS, handle: (input) => requirement.buildPrompt(input) },
  ]);

  function buildPrompt(input = {}) {
    runtime.assertActive();
    if (!input || typeof input !== 'object') {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '提示词请求参数必须为对象');
    }
    const dispatcher = PROMPT_DISPATCHERS.find((entry) => entry.keys.includes(input.actionKey));
    if (!dispatcher) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `一期不支持的提示词动作键: ${String(input.actionKey ?? '')}`);
    }
    return dispatcher.handle(input);
  }

  return Object.freeze({
    get isLoopbackEndpoint() {
      return runtime.isLoopbackEndpoint;
    },
    get endpointKind() {
      return runtime.endpointKind;
    },
    get portalLinks() {
      return runtime.portalLinks;
    },
    toolNames: () => [...WORKBENCH_TOOLS],
    getBootstrap: runtime.getBootstrap,
    getRuntimeConfig: runtime.getRuntimeConfig,
    updateRuntimeConfig: runtime.updateRuntimeConfig,
    savePreferences: runtime.savePreferences,
    dispose: runtime.dispose,
    resolveItsmPortalUrl: overview.resolveItsmPortalUrl,
    getSummary: overview.getSummary,
    getRequirements: requirement.getRequirements,
    searchRmpDocs: requirement.searchRmpDocs,
    getRmpOutline: requirement.getRmpOutline,
    readRequirementDetail: requirement.readRequirementDetail,
    readStoryDetail: requirement.readStoryDetail,
    readRmpSection: requirement.readRmpSection,
    buildPrompt,
    _internal: {
      get dopClient() {
        return runtime.dopClient;
      },
      get rmpClient() {
        return runtime.rmpClient;
      },
      cliBridge,
      preferencesStore: runtime.preferencesStore,
      runtimeConfigStore: runtime.runtimeConfigStore,
    },
  });
}
