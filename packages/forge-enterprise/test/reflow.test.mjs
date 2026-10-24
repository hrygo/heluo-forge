import assert from 'node:assert/strict';
import test from 'node:test';

import { detectOfficialRowReflow, EnterpriseReflowError, OFFICIAL_ROWS, rowsFromDump } from '../src/reflow.mjs';

const dump = (entries) =>
  entries
    .map(([id, disabled]) => `- id: ${id}\n  source: builtin${disabled ? '\n  disabled: true' : ''}`)
    .join('\n');

test('四行全部禁用才算不回灌', () => {
  const patched = detectOfficialRowReflow({
    observed: new Map(OFFICIAL_ROWS.map((id) => [id, true])),
  });
  assert.equal(patched.ok, true);
  assert.deepEqual([...patched.reflowed], []);
  assert.deepEqual([...patched.disabled], [...OFFICIAL_ROWS]);
  assert.equal(patched.checked, 4);
});

test('官方行重新启用即报回灌，缺席行单独记录', () => {
  const base = detectOfficialRowReflow({
    observed: new Map([
      ['deepseek-account', false],
      ['llm-deepseek-account', false],
      ['llm-deepseek', false],
    ]),
  });
  assert.equal(base.ok, false);
  assert.deepEqual([...base.reflowed], ['deepseek-account', 'llm-deepseek-account', 'llm-deepseek']);
  assert.deepEqual([...base.absent], ['ui-settings-account']);

  const strict = detectOfficialRowReflow({
    observed: new Map(OFFICIAL_ROWS.filter((id) => id !== 'ui-settings-account').map((id) => [id, true])),
    requireAll: true,
  });
  assert.equal(strict.ok, false, 'requireAll 时缺席行也判失败');
  assert.deepEqual([...strict.absent], ['ui-settings-account']);
});

test('状态未知按回灌处理，不按"没写 disabled 就等于禁用"放行', () => {
  const unknown = detectOfficialRowReflow({
    observed: [
      { id: 'deepseek-account' },
      { id: 'ui-settings-account', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'llm-deepseek', disabled: false },
    ],
  });
  assert.equal(unknown.ok, false);
  assert.deepEqual([...unknown.reflowed], ['deepseek-account', 'llm-deepseek']);
});

test('额外行与自定义期望集', () => {
  const result = detectOfficialRowReflow({
    observed: { probe_body: true, 'deepseek-account': true },
    expected: ['deepseek-account'],
  });
  assert.equal(result.ok, true, '无关行不影响结论');
  assert.equal(result.checked, 1);
});

test('非法输入直接报错，而不是默默通过', () => {
  assert.throws(() => detectOfficialRowReflow(null), (error) => error.code === 'ENTERPRISE_REFLOW_INPUT_INVALID');
  assert.throws(() => detectOfficialRowReflow({ observed: 42 }), (error) => error.code === 'ENTERPRISE_REFLOW_INPUT_INVALID');
  assert.throws(() => detectOfficialRowReflow({ observed: [{}] }), (error) => error.code === 'ENTERPRISE_REFLOW_INPUT_INVALID');
  assert.throws(() => detectOfficialRowReflow({ observed: {}, expected: [1] }), (error) => error.code === 'ENTERPRISE_REFLOW_INPUT_INVALID');
  assert.throws(() => rowsFromDump(undefined), (error) => error instanceof EnterpriseReflowError);
});

test('dump 解析认得嵌套缩进与注释边界', () => {
  const text = [
    '# composed by heluo-forge',
    '- id: deepseek-account',
    '  disabled: true',
    '  source: builtin',
    '- id: llm-deepseek',
    '  source: builtin',
    '# patched by forge-enterprise',
    '- id: forge-policy',
    '  disabled: false',
  ].join('\n');
  const rows = rowsFromDump(text);
  assert.equal(rows.get('deepseek-account'), true);
  assert.equal(rows.get('llm-deepseek'), null, '没写 disabled 的行状态未知');
  assert.equal(rows.get('forge-policy'), false);
  const verdict = detectOfficialRowReflow({ observed: rows });
  assert.equal(verdict.ok, false);
  assert.deepEqual([...verdict.reflowed], ['llm-deepseek']);
  assert.deepEqual([...verdict.absent], ['ui-settings-account', 'llm-deepseek-account']);
});

test('dump 夹具与实际输出形状一致', () => {
  const rows = rowsFromDump(dump([
    ['deepseek-account', true],
    ['ui-settings-account', false],
  ]));
  assert.deepEqual([...rows.keys()], ['deepseek-account', 'ui-settings-account']);
  assert.equal(detectOfficialRowReflow({ observed: rows }).ok, false);
});

test('a disabled field nested in the row config does not count as the row being disabled', () => {
  // The official row is enabled; only a plugin option inside its config block
  // says `disabled: true`. Reading any indentation as the row-level field would
  // report this reflow as pass and hide that the patch never took effect.
  const rows = rowsFromDump([
    '- id: llm-deepseek',
    '  config:',
    '    disabled: true',
    '- id: deepseek-account',
    '  disabled: true',
  ].join('\n'));
  assert.equal(rows.get('llm-deepseek'), null, 'nested config 不能冒充行级 disabled');
  assert.equal(rows.get('deepseek-account'), true);
  const verdict = detectOfficialRowReflow({
    observed: rows,
    expected: ['llm-deepseek', 'deepseek-account'],
    requireAll: true,
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual([...verdict.reflowed], ['llm-deepseek']);
  assert.deepEqual([...verdict.disabled], ['deepseek-account']);
});
