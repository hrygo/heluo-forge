/**
 * 提示词模板的同源只读端点（r20）：把补丁层 `config.promptTemplate` 下发给浏览器半。
 *
 * 为什么只读：模板是**项目维护者**的口径配置，不是终端用户的偏好。用户改不好反而更危险
 * （少一步验收、漏掉"缺验收标准先问我"），所以页面不提供编辑入口，只消费配置值；
 * 改模板的唯一入口是 profile 补丁层的 `config.promptTemplate`，改完重载 profile 生效。
 *
 * 因此这里没有 POST：写面不存在，也就不需要请求体、预检头与回读比对那一整套。
 * 非法配置在装配期就被 `runtime-config` 的 schema 拦下（拒绝激活），不会流到这里。
 */

import {
  CLI_API_PREFIX,
  fail,
  normalizeRoutePath,
  ok,
  splitRequestUrl,
  writeResponse,
} from './http.mjs';
import { PROMPT_FIELD, PROMPT_PLACEHOLDER, validatePromptTemplate } from './prompt-template.mjs';

/** 模板端点：`/api/forge-devops/prompt`。 */
export const PROMPT_ROUTE_PATH = `${CLI_API_PREFIX}/prompt`;

/** 本模块自己的原因码：与存储/装配层分开，页面按 HTTP 状态处理。 */
export const PROMPT_HTTP_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  UNAVAILABLE: 'PROMPT_UNAVAILABLE',
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} [options]
 * @param {() => {template: string, source: 'config'|'default'}} [options.resolve] 有效模板的来源
 * @returns {Readonly<{handleGet: Function}>}
 */
export function createPromptApi({ resolve = null } = {}) {
  const canRead = typeof resolve === 'function';

  /** GET：返回有效模板；`source` 说明它来自补丁层配置还是内置默认值。 */
  function handleGet() {
    if (!canRead) return fail(503, PROMPT_HTTP_CODES.UNAVAILABLE, '提示词模板尚未装配');
    let view;
    try {
      view = resolve();
    } catch {
      return fail(503, PROMPT_HTTP_CODES.UNAVAILABLE, '读取提示词模板失败');
    }
    if (!isPlainObject(view)) return fail(503, PROMPT_HTTP_CODES.UNAVAILABLE, '读取提示词模板失败');
    const body = {
      ok: true,
      template: typeof view.template === 'string' ? view.template : '',
      source: view.source === 'config' ? 'config' : 'default',
      placeholder: PROMPT_PLACEHOLDER,
    };
    // 配置里有模板但内容不合法：已回落默认值，把原因一并透出，维护者 curl 一次就能定位。
    const warning = typeof view.warning === 'string' && view.warning !== '' ? view.warning : null;
    if (warning !== null) body.warning = warning;
    return ok(body);
  }

  return Object.freeze({ handleGet });
}

/**
 * Node `req/res` 适配器：只服务 `PROMPT_ROUTE_PATH`；只有 GET/HEAD，其他方法 405。
 *
 * @param {{handleGet: Function}} api `createPromptApi()` 的结果
 * @param {{path?: string}} [options] `path` 可覆盖端点（默认 `PROMPT_ROUTE_PATH`）
 */
export function toPromptRoute(api, options = {}) {
  const routePath = normalizeRoutePath(
    typeof options?.path === 'string' && options.path !== '' ? options.path : PROMPT_ROUTE_PATH,
  );

  return async function handleForgeDevopsPromptRequest(req, res) {
    let result;
    try {
      const { pathname } = splitRequestUrl(req?.url);
      if (pathname !== routePath) {
        result = fail(404, PROMPT_HTTP_CODES.NOT_FOUND, '未知的提示词模板端点');
      } else {
        const method = String(req?.method ?? 'GET').toUpperCase();
        if (method === 'GET' || method === 'HEAD') {
          result = api.handleGet(req);
        } else {
          result = fail(405, PROMPT_HTTP_CODES.METHOD_NOT_ALLOWED, '提示词模板只读：改写请编辑 profile 补丁层的 config.promptTemplate', null, {
            allow: 'GET',
          });
        }
      }
    } catch {
      result = fail(500, PROMPT_HTTP_CODES.UNAVAILABLE, '提示词模板端点执行失败');
    }
    writeResponse(res, result);
  };
}

export default { PROMPT_ROUTE_PATH, PROMPT_HTTP_CODES, createPromptApi, toPromptRoute };
