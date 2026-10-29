import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_KINDS,
  assertModelRecorded,
  buildReviewRecord,
  HUMAN_DECISIONS,
  MODEL_TIERS,
  recordHumanConfirmation,
  renderReview,
  REVIEW_REASONS,
  REVIEW_STATUSES,
  reviewStaleness,
  ReviewError,
} from '../src/review.mjs';

/** 本任务统一使用的样例变更号与 sha。 */
const ARD = 'ARD123456';
const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const AT = '2026-10-28T21:00:00+08:00';

function sample(overrides = {}) {
  return {
    changeId: ARD,
    commit: SHA,
    model: 'gpt-6.1-sol',
    findings: ['幂等键未覆盖空标题'],
    risks: ['gh 写动作指向真实远端'],
    opinion: '建议先补回读用例',
    conclusion: '可进入人工确认',
    ...overrides,
  };
}

function throwsCode(fn, code) {
  return assert.throws(fn, (error) => {
    assert.ok(error instanceof ReviewError, `应抛 ReviewError：${error?.message}`);
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}`);
    return true;
  });
}

test('AI 栏由 buildReviewRecord 写满、人工栏留空，模型名与 commit 必填且被归一化', () => {
  const review = buildReviewRecord(sample());

  assert.equal(review.changeId, ARD);
  assert.equal(review.commit, SHA);
  assert.deepEqual(review.model, { name: 'gpt-6.1-sol', tier: null, degraded: false, note: '' });
  assert.deepEqual(
    review.aiColumn.map((entry) => [entry.id, entry.kind]),
    [
      ['A-1', 'issue'],
      ['R-1', 'risk'],
      ['O-1', 'opinion'],
    ],
  );
  assert.deepEqual(review.aiColumn.map((entry) => entry.kind), [...AI_KINDS]);
  assert.deepEqual(review.humanColumn, [], '人工栏必须为空：只有 recordHumanConfirmation 能写');
  assert.equal(review.status, 'pending-human');
  assert.equal(review.conclusion, '可进入人工确认');
});

test('模型名缺失、档位外模型未声明降级、声明降级却不说明，都拒绝写入', () => {
  throwsCode(() => buildReviewRecord(sample({ model: '' })), REVIEW_REASONS.MODEL_NOT_RECORDED);
  throwsCode(() => buildReviewRecord(sample({ model: 'gpt-3.5-mini' })), REVIEW_REASONS.DEGRADED_NOT_DECLARED);
  throwsCode(
    () => buildReviewRecord(sample({ model: { name: 'gpt-3.5-mini', degraded: true } })),
    REVIEW_REASONS.DEGRADED_NOTE_REQUIRED,
  );
  throwsCode(() => assertModelRecorded({ modelName: 'gpt-6-astra', degraded: true }), REVIEW_REASONS.DEGRADED_NOTE_REQUIRED);

  const degraded = buildReviewRecord(sample({ model: { name: 'gpt-3.5-mini', degraded: true, note: 'profile 无更强档位' } }));
  assert.deepEqual(degraded.model, { name: 'gpt-3.5-mini', tier: null, degraded: true, note: 'profile 无更强档位' });

  // 档内模型无需声明降级；四个档位名是 PRD 原文名单，逐个可用。
  assert.doesNotThrow(() => assertModelRecorded({ modelName: 'gpt-6.1-sol' }));
  assert.deepEqual([...MODEL_TIERS], ['deepseek-v4-pro', 'gpt-6.1-sol', 'gpt-6-astra', 'muse-spark-1.3-contributor']);
});

test('commit 必须是 7–40 位十六进制 sha；HEAD、分支名、空串、短 hex 一律拒绝', () => {
  for (const commit of ['HEAD', 'main', '', 'abc12', 'z'.repeat(40), undefined]) {
    throwsCode(() => buildReviewRecord(sample({ commit })), REVIEW_REASONS.INVALID_COMMIT);
  }
  const short = buildReviewRecord(sample({ commit: 'ABC1234' }));
  assert.equal(short.commit, 'abc1234', '短 sha 归一化成小写');
});

test('缺变更号、缺结论、空 AI 条目直接拒绝（不产出半截记录）', () => {
  throwsCode(() => buildReviewRecord(sample({ changeId: '' })), REVIEW_REASONS.MISSING_CHANGE_ID);
  throwsCode(() => buildReviewRecord(sample({ conclusion: '  ' })), REVIEW_REASONS.MISSING_CONCLUSION);
  throwsCode(() => buildReviewRecord(sample({ findings: [''] })), REVIEW_REASONS.AI_ENTRY_INVALID);
  throwsCode(() => buildReviewRecord(sample({ risks: [{}] })), REVIEW_REASONS.AI_ENTRY_INVALID);
});

test('人工确认只能经 recordHumanConfirmation：返回新对象、不改入参，且 buildReviewRecord 忽略自填的 humanColumn', () => {
  const review = buildReviewRecord(sample({ humanColumn: [{ by: 'ai', at: AT, commit: SHA, decision: 'confirmed' }] }));
  assert.deepEqual(review.humanColumn, [], 'buildReviewRecord 不提供自填"已确认"的入口');

  const confirmed = recordHumanConfirmation(review, { by: 'hosea', at: AT, commit: SHA, decision: 'confirmed', note: '同意' });
  assert.notEqual(confirmed, review, '返回新对象，不原地改');
  assert.equal(review.humanColumn.length, 0, '原记录保持只有 AI 栏');
  assert.equal(review.status, 'pending-human');
  assert.deepEqual(confirmed.humanColumn, [{ by: 'hosea', at: AT, commit: SHA, decision: 'confirmed', note: '同意' }]);
  assert.equal(confirmed.status, 'confirmed');

  const rejected = recordHumanConfirmation(confirmed, { by: 'lead', at: AT, commit: SHA, decision: 'changes-requested', note: '补回读用例' });
  assert.equal(rejected.status, 'changes-requested');
  assert.equal(rejected.humanColumn.length, 2, '多条确认保留历史');
});

test('人工确认的四个必填项各自缺失都拒绝，且不认未定义的结论', () => {
  const review = buildReviewRecord(sample());
  throwsCode(() => recordHumanConfirmation(review, { at: AT, commit: SHA, decision: 'confirmed' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation(review, { by: 'hosea', commit: SHA, decision: 'confirmed' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation(review, { by: 'hosea', at: 'not-a-time', commit: SHA, decision: 'confirmed' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation(review, { by: 'hosea', at: AT, commit: 'HEAD', decision: 'confirmed' }), REVIEW_REASONS.INVALID_COMMIT);
  throwsCode(() => recordHumanConfirmation(review, { by: 'hosea', at: AT, commit: SHA, decision: 'approved' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation({}, { by: 'hosea', at: AT, commit: SHA, decision: 'confirmed' }), REVIEW_REASONS.INVALID_REVIEW);
  assert.deepEqual([...HUMAN_DECISIONS], ['confirmed', 'changes-requested', 'rejected']);
});

test('sha 变一位即 stale；短 sha 是长 sha 前缀视为同一版本；无法核对一律 stale', () => {
  const review = buildReviewRecord(sample());
  assert.equal(reviewStaleness(review, SHA), 'current');
  assert.equal(reviewStaleness(review, `${SHA.slice(0, 39)}b`), 'stale');
  assert.equal(reviewStaleness(review, 'aaaaaaa'), 'current', '短 sha 前缀一致即同一版本');
  assert.equal(reviewStaleness(review, SHA.toUpperCase()), 'current', '大小写不是版本差异');
  assert.equal(reviewStaleness(review, 'HEAD'), 'stale', '无法解析当前 commit 时不沿用旧记录');
  assert.equal(reviewStaleness({}, SHA), 'stale');
  assert.equal(reviewStaleness(review, undefined), 'stale');
});

test('stale 属流程态，不进审查状态词表；确认状态与版本一致性是两条轴', () => {
  assert.equal(REVIEW_STATUSES.includes('stale'), false);
  assert.deepEqual([...REVIEW_STATUSES], ['pending-human', 'confirmed', 'changes-requested', 'rejected']);

  const review = recordHumanConfirmation(buildReviewRecord(sample()), { by: 'hosea', at: AT, commit: SHA, decision: 'confirmed' });
  assert.equal(review.status, 'confirmed');
  assert.equal(reviewStaleness(review, HEAD), 'stale', '已确认但 sha 变了：确认过期，状态仍是 confirmed');
});

test('renderReview 两栏可分、模型与 sha 可见、未确认与降级都明说', () => {
  const pending = renderReview(buildReviewRecord(sample()));
  assert.match(pending, /^# 交叉审查 — ARD123456/mu);
  assert.match(pending, /gpt-6\.1-sol/u);
  assert.ok(pending.includes(SHA), '渲染含被审 sha');
  assert.match(pending, /## AI 审查栏/u);
  assert.match(pending, /## 人工确认栏/u);
  assert.match(pending, /尚无人工确认/u);
  assert.match(pending, /- `A-1` 幂等键未覆盖空标题/u);
  assert.match(pending, /可进入人工确认/u);

  const degraded = renderReview(buildReviewRecord(sample({ model: { name: 'muse-spark-1.3-contributor', degraded: true, note: '仅同模型二次审查' } })));
  assert.match(degraded, /未使用更强模型/u);
  assert.match(degraded, /仅同模型二次审查/u);

  const confirmed = renderReview(
    recordHumanConfirmation(buildReviewRecord(sample()), { by: 'hosea', at: AT, commit: SHA, decision: 'confirmed', note: '通过' }),
  );
  assert.equal(confirmed.includes('尚无人工确认'), false);
  assert.match(confirmed, /\| 时间 \| 确认人 \| 针对 commit \| 结论 \| 备注 \|/u);
  assert.match(confirmed, /hosea/u);
  assert.match(confirmed, /confirmed/u);
});

test('审查错误码固定且唯一，便于工具层按码映射提示', () => {
  const codes = Object.values(REVIEW_REASONS);
  assert.equal(new Set(codes).size, codes.length, '错误码不得重复');
  for (const code of [
    'MISSING_CHANGE_ID',
    'INVALID_COMMIT',
    'MISSING_CONCLUSION',
    'MODEL_NOT_RECORDED',
    'DEGRADED_NOT_DECLARED',
    'DEGRADED_NOTE_REQUIRED',
    'AI_ENTRY_INVALID',
    'HUMAN_ENTRY_INVALID',
    'INVALID_REVIEW',
  ]) {
    assert.ok(codes.includes(code), `缺少错误码 ${code}`);
  }
});
