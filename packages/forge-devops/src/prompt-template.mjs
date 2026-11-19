/**
 * 变更选择器的提示词模板（r20）：默认正文、占位符规则、纯函数渲染。
 *
 * 这份文件是模板的**唯一事实源**：宿主侧的下发端点、保存校验与客户端兜底都从这里
 * 取默认值。客户端 `client.js` 里保留一份同字面量的常量（浏览器侧不能 import 本包
 * 源码，P1 装载形态），两处的逐字一致由 `test/prompt-template.test.mjs` 静态守。
 *
 * 为什么不是常量写死在客户端：企业把「变更 → issue → 交付 → PR」的流程口径写成模板，
 * 不同团队要改措辞、加仓库约束、换分支命名。模板必须能在设置页编辑、默认值可用、
 * 占位符可校验，而不是让用户去改包源码。
 */

/** 校验失败形状：与 `runtime-config` 的字段校验保持一致（不抛错，交给调用方汇总）。 */
const fail = (message) => ({ ok: false, message });

/** 配置键：写在 profile 补丁层这一条 entry 的 `config:` 里，也可由设置页写回。 */
export const PROMPT_FIELD = 'promptTemplate';

/** 占位符：渲染时替换为变更编号；模板里至少出现一次才算可用。 */
export const PROMPT_PLACEHOLDER = '{code}';

/** 上界：模板是提示词，不是文档；超过这个长度多半是贴错了内容。 */
export const PROMPT_MAX_LENGTH = 4000;

/**
 * 默认模板（r20）：把「读变更 → 建 issue → 按规范交付 → 建 PR」写成四段带约束的动作，
 * 而不是一句话塞五个动作。要点是**先给边界再给动作**：指定只读工具、缺信息就问、
 * 脏工作区先确认、提交与验证纪律写在末尾。
 */
export const DEFAULT_PROMPT_TEMPLATE = [
  '变更 {code}：用 forge_devops_change_context 读取详情，提炼需求与验收标准；',
  '变更单缺少验收标准时，列出缺口问我，不要编造。',
  '',
  '1) 在仓库建 issue：标题含 {code}，正文含需求摘要、验收标准、影响范围；',
  '   已有同编号 open issue 则复用，不重复创建。',
  '2) 用 issue-delivery 处理该 issue：先 git status --short 查工作区，脏则问我；',
  '   按 feat/{code} 分支交付，只改变更范围内代码，补齐测试并跑 pnpm check。',
  '3) 建 PR 关联该 issue：标题含 {code}，描述附交付报告（改动概览/验证命令与结果/未验证项/回滚方式）。',
  '约束：提交说明不以 # 开头；不伪造验证结果。',
].join('\n');

/**
 * 校验一份模板。
 *
 * 只判三件事：是文本、含 `{code}`、长度在界内；换行统一成 `\n`（Windows 粘贴的
 * CRLF 不应让同一份模板在两个平台渲染出不同结果）。
 *
 * @param {unknown} value 用户输入或配置层读到的值
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
export function validatePromptTemplate(value) {
  if (typeof value !== 'string') return fail('模板必须是一段文本');
  const text = value.replace(/\r\n?/gu, '\n').trim();
  if (text === '') return fail('模板不能为空');
  if (!text.includes(PROMPT_PLACEHOLDER)) return fail(`模板必须包含占位符 ${PROMPT_PLACEHOLDER}`);
  if (text.length > PROMPT_MAX_LENGTH) return fail(`模板最多 ${PROMPT_MAX_LENGTH} 个字符`);
  return { ok: true, value: text };
}

/**
 * 用变更编号渲染模板。
 *
 * `split/join` 而不是 `replace`：编号来自平台，一旦包含 `$&` 之类，`String.replace`
 * 会把它当替换模式解析，渲染出的就不是模板原文了。
 *
 * @param {string} template 已校验的模板（未校验时按默认值兜底）
 * @param {string} code 变更编号
 * @returns {string}
 */
export function renderPrompt(template, code) {
  const base = typeof template === 'string' && template.trim() !== '' ? template : DEFAULT_PROMPT_TEMPLATE;
  const id = typeof code === 'string' ? code.trim() : '';
  return base.split(PROMPT_PLACEHOLDER).join(id);
}

/**
 * 从插件配置取有效模板：非法或缺席一律回落默认值。
 *
 * 回落是**有意的**：配置层写坏了不能让选择器整个不可用，也不能拿一段非法文本去渲染。
 *
 * @param {object|null|undefined} config 装配时的插件配置
 * @returns {{template: string, source: 'config' | 'default'}}
 */
export function promptTemplateOf(config) {
  const raw = config !== null && typeof config === 'object' ? config[PROMPT_FIELD] : undefined;
  const result = validatePromptTemplate(raw);
  if (result.ok === true) return { template: result.value, source: 'config' };
  return { template: DEFAULT_PROMPT_TEMPLATE, source: 'default' };
}

export default {
  PROMPT_FIELD,
  PROMPT_PLACEHOLDER,
  PROMPT_MAX_LENGTH,
  DEFAULT_PROMPT_TEMPLATE,
  validatePromptTemplate,
  renderPrompt,
  promptTemplateOf,
};
