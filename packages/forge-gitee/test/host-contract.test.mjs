/**
 * 宿主工具契约（D-1 的永久门禁，P0）。
 *
 * 真机事实：宿主 `@deepseek-ai/dsh-tools` 的 `register()` 对每个工具强制
 * `output = { schema, render, presentationMeta? }`、且 `output.schema` 只能用受支持的
 * 关键字子集；一条不合格就抛错、整条 entry 回滚——本包 5 个写工具缺 `output` 时，
 * 连 3 个只读工具都一起拿不到（r4 QA 的 D-1）。
 *
 * 这里用 `helpers/fake-host.mjs` 里**镜像宿主判据**的 `assertHostToolDefinition()`：
 * 假宿主在 `tools.register()` 里就会校验，所以任何回退都逃不过离线用例。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writeToolDefinitions } from '../src/gitee-actions.mjs';
import { readToolDefinitions } from '../src/gitee-read.mjs';
import { assertHostToolDefinition, hostSchemaViolations } from './helpers/fake-host.mjs';

/** 八个工具的最小装配：只提供端口形状，不触达子进程。 */
const stubService = Object.fromEntries(
  ['execute', 'invoke', 'preflight', 'adapter', 'session', 'read'].map((member) => [member, async () => ({})]),
);

const allDefinitions = () => [...readToolDefinitions(stubService), ...writeToolDefinitions(stubService)];

test('D-1: 8 个工具全部满足宿主 register() 判据（output.render 是函数 + schema 只用支持子集）', () => {
  const definitions = allDefinitions();
  assert.equal(definitions.length, 8, '3 读 + 5 写');
  for (const definition of definitions) {
    assert.doesNotThrow(() => assertHostToolDefinition(definition), `${definition.name} 不满足宿主工具契约`);
    assert.deepEqual(hostSchemaViolations(definition.parameters, 'parameters'), [], `${definition.name} 的参数面越界`);
    assert.deepEqual(hostSchemaViolations(definition.output.schema, 'output.schema'), [], `${definition.name} 的输出 schema 越界`);
  }
  const writes = definitions.slice(3).map((definition) => definition.name);
  assert.deepEqual(writes, [
    'forge_gitee_issue_write',
    'forge_gitee_pr_write',
    'forge_gitee_review_publish',
    'forge_gitee_review_record',
    'forge_gitee_delivery_gate',
  ]);
});

test('D-1 门禁有牙: 任一工具退回"没有 output"都必须被拒（断言不是恒真）', () => {
  for (const definition of allDefinitions()) {
    const broken = { ...definition };
    delete broken.output;
    assert.throws(
      () => assertHostToolDefinition(broken),
      new RegExp(`tool "${definition.name}" must declare output`, 'u'),
      `${definition.name} 缺 output 时假宿主必须拒绝（否则离线仍会全绿而真机回滚整条 entry）`,
    );
    const badRender = { ...definition, output: { schema: { type: 'object' }, render: 'not-a-function' } };
    assert.throws(() => assertHostToolDefinition(badRender), /must declare output/u);
  }
  // schema 越界也要被拒：`minimum`/`maximum` 不在宿主支持的子集里。
  const overConstrained = {
    name: 'probe_tool',
    output: { schema: { type: 'object' }, render: () => [] },
    parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } } },
  };
  assertHostToolDefinition(overConstrained); // register() 本身不校验参数面
  assert.match(hostSchemaViolations(overConstrained.parameters, 'parameters').join('\n'), /minimum/u);
});

test('D-1: 写工具的 render 把返回值渲染成宿主可读的 text 内容', () => {
  for (const definition of allDefinitions()) {
    const value = { status: 'done', reason: null, provider: 'gitee' };
    const rendered = definition.output.render([], value);
    assert.ok(Array.isArray(rendered), `${definition.name} 的 render 应返回 content 数组`);
    assert.equal(rendered[0].type, 'text');
    assert.equal(typeof rendered[0].text, 'string');
    assert.match(rendered[0].text, /"status": "done"/u);
  }
});
