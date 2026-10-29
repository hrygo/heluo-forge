import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCommitMessage,
  COMMIT_REASONS,
  expectedCommitFormat,
} from '../src/commit-message.mjs';

const ARD = 'ARD123456';

test('合规提交信息通过，并返回可核对的首行与期望格式', () => {
  const result = assertCommitMessage({ changeId: ARD, message: `[${ARD}] 补充变更上下文卡与审查记录` });
  assert.deepEqual(result, {
    ok: true,
    changeId: ARD,
    expectedFormat: `[${ARD}] 一句话说明`,
    subject: '补充变更上下文卡与审查记录',
  });
  assert.equal(expectedCommitFormat(ARD), `[${ARD}] 一句话说明`);
  assert.equal(expectedCommitFormat(''), '[<变更号>] 一句话说明');
});

test('缺前缀一律拒绝，并给出期望格式（不改写）', () => {
  const cases = [
    ['补充上下文卡', 'PLAIN'],
    [`${ARD} 补充上下文卡`, 'NO_BRACKET'],
    [`[${ARD}]补充上下文卡`, 'NO_SPACE'],
    [`[${ARD}] `, 'EMPTY_DESCRIPTION'],
    [`[${ARD}]`, 'BRACKET_ONLY'],
    [`[${ARD} 补充上下文卡`, 'UNCLOSED_BRACKET'],
  ];
  for (const [message, label] of cases) {
    const result = assertCommitMessage({ changeId: ARD, message });
    assert.equal(result.ok, false, `${label} 必须被拒绝：${message}`);
    assert.equal(result.reason, COMMIT_REASONS.PREFIX_MISSING, label);
    assert.equal(result.expectedFormat, `[${ARD}] 一句话说明`);
    assert.equal('message' in result, false, `${label}：拒绝结果不回传 message（拒绝不改写）`);
  }
});

test('方括号里的变更号必须是本变更号：别的号、空号都拒绝', () => {
  const other = assertCommitMessage({ changeId: ARD, message: '[ARD999999] 顺手改了别处' });
  assert.equal(other.ok, false);
  assert.equal(other.reason, COMMIT_REASONS.PREFIX_MISSING);
  assert.match(other.detail, /ARD999999/u);

  const empty = assertCommitMessage({ changeId: ARD, message: '[] 忘了写变更号' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, COMMIT_REASONS.PREFIX_MISSING);

  const spaced = assertCommitMessage({ changeId: ARD, message: `[ ${ARD} ] 方括号内有空格` });
  assert.equal(spaced.ok, false, '方括号内带空格不算合规前缀（避免宽松到认不出变更号）');
});

test('缺参数各自有原因码：缺变更号与缺提交信息不混为一谈', () => {
  assert.deepEqual(assertCommitMessage({ message: `[${ARD}] 只有信息` }), {
    ok: false,
    reason: COMMIT_REASONS.MISSING_CHANGE_ID,
    expectedFormat: '[<变更号>] 一句话说明',
  });
  assert.equal(assertCommitMessage({ changeId: '  ', message: `[${ARD}] x` }).reason, COMMIT_REASONS.MISSING_CHANGE_ID);
  assert.equal(assertCommitMessage().reason, COMMIT_REASONS.MISSING_CHANGE_ID);

  assert.equal(assertCommitMessage({ changeId: ARD }).reason, COMMIT_REASONS.MISSING_MESSAGE);
  assert.equal(assertCommitMessage({ changeId: ARD, message: '   ' }).reason, COMMIT_REASONS.MISSING_MESSAGE);
  assert.equal(assertCommitMessage({ changeId: ARD, message: 42 }).reason, COMMIT_REASONS.MISSING_MESSAGE);
});

test('多行只校验首行：正文随便写，subject 就取首行描述', () => {
  const result = assertCommitMessage({
    changeId: ARD,
    message: `[${ARD}] 补齐审查与报告\n\n正文第一段：证据见 .dsh-devops/ARD123456/report.md\n- 顺带提到 [ARD999999] 也不算错`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.subject, '补齐审查与报告');
});

test('开头空行不豁免前缀：仍按首行判定，不替调用方整理', () => {
  const result = assertCommitMessage({ changeId: ARD, message: `\n\n${ARD} 忘了方括号` });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COMMIT_REASONS.PREFIX_MISSING);
});

test('方括号内大小写不敏感；全角空格可作分隔（中文输入法常见）', () => {
  assert.equal(assertCommitMessage({ changeId: ARD, message: '[ard123456] 大小写不同但同号' }).ok, true);
  const fullWidth = assertCommitMessage({ changeId: ARD, message: `[${ARD}]\u3000全角空格分隔` });
  assert.equal(fullWidth.ok, true);
  assert.equal(fullWidth.subject, '全角空格分隔');
});

test('change 旧别名与 changeId 等价：两个名字共用一套判断', () => {
  const viaAlias = assertCommitMessage({ change: ARD, message: `[${ARD}] 别名调用` });
  assert.equal(viaAlias.ok, true);
  assert.equal(viaAlias.changeId, ARD);
  assert.equal(assertCommitMessage({ change: ARD }).reason, COMMIT_REASONS.MISSING_MESSAGE);

  const both = assertCommitMessage({ changeId: ARD, change: 'ARD000000', message: `[${ARD}] 两个都给` });
  assert.equal(both.ok, true, 'changeId 优先，别名不覆盖显式入参');
  assert.equal(both.changeId, ARD);
});

test('拒绝原因码稳定可枚举（下游据此提示，不解析文案）', () => {
  assert.deepEqual([...Object.values(COMMIT_REASONS)].sort(), ['MISSING_CHANGE_ID', 'MISSING_MESSAGE', 'PREFIX_MISSING']);
  assert.equal(Object.isFrozen(COMMIT_REASONS), true);
});
