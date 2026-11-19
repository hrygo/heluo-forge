/**
 * 提示词模板（r20）：默认正文、占位符校验、渲染与两端一致性。
 *
 * 这里钉的是**离线可判定**的契约：
 *   - 默认模板就是产品口径的那四段（不是随便一句）；
 *   - 校验只认「文本 + 含 {code} + 长度在界内」，CRLF 归一成 LF，首尾空白剪掉；
 *   - 渲染用 `split/join`，编号里的 `$&`/`$1` 原样保留；
 *   - 浏览器半的 `DEFAULT_PROMPT_TEMPLATE` 与宿主默认值逐字一致（两侧不能各改各的）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConfigStandard } from '../src/runtime-config.mjs';
import {
  DEFAULT_PROMPT_TEMPLATE,
  PROMPT_FIELD,
  PROMPT_MAX_LENGTH,
  PROMPT_PLACEHOLDER,
  promptTemplateOf,
  renderPrompt,
  validatePromptTemplate,
} from '../src/prompt-template.mjs';

test('默认模板：四段结构，含占位符，且以约束收尾', () => {
  assert.equal(PROMPT_PLACEHOLDER, '{code}');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('forge_devops_change_context'), '必须点名只读工具，避免 agent 手写 dop');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('列出缺口问我'), '缺验收标准时必须先问，不得编造');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('git status --short'), '动手前必须先查工作区');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('feat/{code}'), '分支命名要带变更号');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('pnpm check'), '交付必须过检查');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('issue-delivery'), '必须点名交付规范');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('不以 # 开头'), '提交纪律要写进模板');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.trimEnd().endsWith('不伪造验证结果。'), '最后一句是验证纪律');
  assert.equal(DEFAULT_PROMPT_TEMPLATE.split('{code}').length - 1, 4, '默认模板出现四次变更号（读取/issue 标题/分支名/PR 标题）');
});

test('校验：非文本、空串、缺占位符、超长一律拒绝，并给中文原因', () => {
  assert.equal(validatePromptTemplate(undefined).ok, false);
  assert.equal(validatePromptTemplate(42).ok, false);
  assert.equal(validatePromptTemplate('   ').ok, false);
  const missing = validatePromptTemplate('没有占位符的模板');
  assert.equal(missing.ok, false);
  assert.match(missing.message, /占位符 \{code\}/u);
  const tooLong = validatePromptTemplate(`{code}${'x'.repeat(PROMPT_MAX_LENGTH)}`);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.message, new RegExp(String(PROMPT_MAX_LENGTH), 'u'));
});

test('校验：CRLF 归一成 LF，首尾空白剪掉，正文不改一个字符', () => {
  const result = validatePromptTemplate('  变更 {code}：\r\n第二行  \r\n  ');
  assert.equal(result.ok, true);
  assert.equal(result.value, '变更 {code}：\n第二行');
});

test('渲染：三处占位符都替换，$& / $1 原样保留，空模板回落默认值', () => {
  assert.equal(renderPrompt('A{code}B{code}C', 'X1'), 'AX1BX1C');
  assert.equal(renderPrompt('{code} $& $1', 'A$&B'), 'A$&B $& $1');
  assert.equal(renderPrompt('', 'X1'), DEFAULT_PROMPT_TEMPLATE.split('{code}').join('X1'));
  assert.equal(renderPrompt(null, ' X1 '), DEFAULT_PROMPT_TEMPLATE.split('{code}').join('X1'), '编号两端空白剪掉');
});

test('配置取值：合法即用配置值，非法或缺席一律回落默认值', () => {
  assert.deepEqual(promptTemplateOf({ [PROMPT_FIELD]: '自定义 {code}' }), { template: '自定义 {code}', source: 'config' });
  assert.deepEqual(promptTemplateOf({ [PROMPT_FIELD]: '没有占位符' }), { template: DEFAULT_PROMPT_TEMPLATE, source: 'default' });
  assert.deepEqual(promptTemplateOf({}), { template: DEFAULT_PROMPT_TEMPLATE, source: 'default' });
  assert.deepEqual(promptTemplateOf(null), { template: DEFAULT_PROMPT_TEMPLATE, source: 'default' });
});

test('两端一致：client.js 的 DEFAULT_PROMPT_TEMPLATE 与宿主默认值逐字相同', () => {
  const file = fileURLToPath(new URL('../client.js', import.meta.url));
  const source = readFileSync(file, 'utf8');
  // 客户端是 IIFE 形态，不能 import；按行字面量比对，任意一行被改动都会在这里失败。
  for (const line of DEFAULT_PROMPT_TEMPLATE.split('\n')) {
    if (line === '') continue;
    const literal = `'${line.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    assert.ok(source.includes(literal), `client.js 缺少默认模板这一行：${line}`);
  }
  assert.ok(source.includes("const PROMPT_PLACEHOLDER = '{code}'"), '客户端占位符常量必须同值');
  assert.ok(source.includes('const PROMPT_MAX_LENGTH = 4000'), '客户端长度上界必须与宿主一致');
});

test('配置面：模板拼错不拒绝激活，类型不对才拒绝', () => {
  // 内容不合法（缺占位符）：装配期放行，交给下发端点回落默认值 + warning，避免一个笔误让整包不工作。
  const lenient = ConfigStandard['~standard'].validate({ [PROMPT_FIELD]: '没有占位符' });
  assert.equal(lenient.issues, undefined);
  assert.equal(lenient.value[PROMPT_FIELD], '没有占位符');

  // 类型不合法：配置结构本身错了，必须拒绝，不能猜维护者想写什么。
  const strict = ConfigStandard['~standard'].validate({ [PROMPT_FIELD]: 42 });
  assert.ok(Array.isArray(strict.issues) && strict.issues.length === 1);
  assert.deepEqual(strict.issues[0].path, [PROMPT_FIELD]);
  assert.equal(strict.issues[0].message, '模板必须是一段文本');
});

test('下发端点：配置里的坏模板回落默认值，并带 warning 说明原因', async () => {
  const { createPromptApi } = await import('../src/prompt-api.mjs');
  const resolve = () => {
    const effective = promptTemplateOf({ [PROMPT_FIELD]: '没有占位符' });
    const checked = validatePromptTemplate('没有占位符');
    return checked.ok === true ? effective : { ...effective, warning: checked.message };
  };
  const body = (await createPromptApi({ resolve }).handleGet()).body;
  assert.equal(body.template, DEFAULT_PROMPT_TEMPLATE);
  assert.equal(body.source, 'default');
  assert.equal(body.warning, '模板必须包含占位符 {code}');
});
