/**
 * 工作台标准化工程提示词统一分派注册表（聚合各业务域提示词构造器）。
 */
import { ERROR_CODES, WorkbenchError } from './shared/errors.mjs';
import {
  MAX_DOC_INJECT_BYTES,
  MAX_ONE_SENTENCE_CHARS,
  NODATA_HTML_RE,
  stripHtmlToText,
  truncateUtf8Bytes,
} from './shared/prompt-utils.mjs';
import {
  buildRequirementPrompt,
  REQUIREMENT_PROMPT_ACTION_KEYS,
} from './domains/requirement/prompts.mjs';

export {
  MAX_DOC_INJECT_BYTES,
  MAX_ONE_SENTENCE_CHARS,
  NODATA_HTML_RE,
  stripHtmlToText,
  truncateUtf8Bytes,
};

const DOMAIN_PROMPT_BUILDERS = Object.freeze([
  { keys: REQUIREMENT_PROMPT_ACTION_KEYS, build: buildRequirementPrompt },
]);

export const PROMPT_ACTION_KEYS = Object.freeze(
  DOMAIN_PROMPT_BUILDERS.flatMap((entry) => entry.keys),
);

/**
 * 统一提示词构建入口（按 actionKey 路由至所属领域构造器）。
 *
 * @param {object} spec
 */
export function buildWorkbenchPrompt(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '提示词构造参数必须为对象');
  }
  const entry = DOMAIN_PROMPT_BUILDERS.find((item) => item.keys.includes(spec.actionKey));
  if (entry) {
    return entry.build(spec);
  }
  throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `一期不支持的提示词动作键: ${String(spec.actionKey ?? '')}`);
}
