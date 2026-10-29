import test from 'node:test';
import assert from 'node:assert/strict';

import { confirmClarifySheet, createClarifySheet, validateClarifySheet } from '../src/clarify.mjs';
import {
  buildDeliveryPlan,
  DEFAULT_BOUNDARY,
  PLAN_GAP_REASONS,
  PlanError,
  renderPlan,
  validatePlan,
  VERIFICATION_KINDS,
} from '../src/plan.mjs';

/** 本任务统一使用的样例变更号。 */
const ARD = 'ARD123456';

/** 两个验收条件、两个不同交付边界的合格计划入参。 */
function sampleInput() {
  return {
    changeId: 'ARD123456',
    criteria: [
      { index: 1, text: '接口返回 200' },
      { index: 2, text: '页面可导出' },
    ],
    items: [
      { criterionIndex: 1, change: '补接口', verification: [{ kind: 'unit', command: 'node --test test/api.test.mjs' }], files: ['src/api.mjs'], boundary: 'api' },
      { criterionIndex: 2, change: '补导出', verification: [{ kind: 'manual', command: '人工点导出' }], files: ['src/ui.mjs'], boundary: 'web' },
    ],
  };
}

test('逐条映射：每条验收条件都有实现项与验证方式，且计划里没有阶段字段', () => {
  const plan = buildDeliveryPlan(sampleInput());

  assert.deepEqual(validatePlan(plan), { ok: true, gaps: [] });
  assert.equal('stages' in plan, false, '不引入固定阶段模板');
  assert.equal('stage' in plan.items[0], false);
  assert.deepEqual(plan.criteria, [
    { index: 1, text: '接口返回 200' },
    { index: 2, text: '页面可导出' },
  ]);
  assert.deepEqual(plan.items[0], {
    id: 'P-1',
    criterionIndex: 1,
    change: '补接口',
    verification: [{ kind: 'unit', command: 'node --test test/api.test.mjs' }],
    files: ['src/api.mjs'],
    boundary: 'api',
  });
  assert.deepEqual(plan.items.map((item) => item.id), ['P-1', 'P-2']);
});

test('验收条件可用裸字符串，序号按位置；验证方式裸字符串等价 command', () => {
  const plan = buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['接口返回 200', '页面可导出'],
    items: [{ criterionIndex: 1, change: '补接口', verification: ['node --test test/api.test.mjs'] }],
  });
  assert.deepEqual(plan.criteria, [
    { index: 1, text: '接口返回 200' },
    { index: 2, text: '页面可导出' },
  ]);
  assert.deepEqual(plan.items[0].verification, [{ kind: 'command', command: 'node --test test/api.test.mjs' }]);
  assert.deepEqual(validatePlan(plan).gaps, [{ criterionIndex: 2, reason: PLAN_GAP_REASONS.MISSING_CRITERION }]);
});

test('无验证方式、未知验证种类、空命令：一律判 NO_VERIFICATION', () => {
  const noVerification = validatePlan(buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [{ criterionIndex: 1, change: '补接口' }],
  }));
  assert.deepEqual(noVerification.gaps, [
    { criterionIndex: 1, reason: PLAN_GAP_REASONS.NO_VERIFICATION, itemId: 'P-1' },
  ]);

  const unknownKind = validatePlan(buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [{ criterionIndex: 1, change: '补接口', verification: [{ kind: 'smoke', command: '跑一遍' }] }],
  }));
  assert.deepEqual(unknownKind.gaps, [
    { criterionIndex: 1, reason: PLAN_GAP_REASONS.NO_VERIFICATION, itemId: 'P-1', kind: 'smoke' },
  ]);

  const emptyCommand = validatePlan(buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [{ criterionIndex: 1, change: '补接口', verification: [{ kind: 'unit', command: '  ' }] }],
  }));
  assert.deepEqual(emptyCommand.gaps, [
    { criterionIndex: 1, reason: PLAN_GAP_REASONS.NO_VERIFICATION, itemId: 'P-1', field: 'command' },
  ]);
  assert.deepEqual([...VERIFICATION_KINDS], ['unit', 'integration', 'e2e', 'command', 'manual']);
});

test('验收条件缺实现项 → MISSING_CRITERION；实现项指向不存在的条件 → UNKNOWN_CRITERION', () => {
  const missing = validatePlan(buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a', 'b'],
    items: [{ criterionIndex: 1, change: '补接口', verification: ['node --test'] }],
  }));
  assert.deepEqual(missing.gaps, [{ criterionIndex: 2, reason: PLAN_GAP_REASONS.MISSING_CRITERION }]);

  const unknown = validatePlan(buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [{ criterionIndex: 3, change: '补接口', verification: ['node --test'] }],
  }));
  assert.deepEqual(unknown.gaps, [
    { criterionIndex: 3, reason: PLAN_GAP_REASONS.UNKNOWN_CRITERION, itemId: 'P-1' },
    { criterionIndex: 1, reason: PLAN_GAP_REASONS.MISSING_CRITERION },
  ]);
});

test('实现项缺 criterionIndex 或内容为空 → INVALID_ITEM，且该条件仍判缺失', () => {
  const plan = buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [{ change: '补接口', verification: ['node --test'] }, { criterionIndex: 1, verification: ['node --test'] }],
  });
  const check = validatePlan(plan);
  assert.deepEqual(check.gaps, [
    { criterionIndex: null, reason: PLAN_GAP_REASONS.INVALID_ITEM, itemId: 'P-1', field: 'criterionIndex' },
    { criterionIndex: 1, reason: PLAN_GAP_REASONS.INVALID_ITEM, itemId: 'P-2', field: 'change' },
    { criterionIndex: 1, reason: PLAN_GAP_REASONS.MISSING_CRITERION },
  ]);
});

test('无验收条件、缺变更号、计划不是对象：判不通过而不是放行', () => {
  const noCriteria = validatePlan(buildDeliveryPlan({ changeId: 'ARD123456' }));
  assert.deepEqual(noCriteria.gaps, [{ criterionIndex: null, reason: PLAN_GAP_REASONS.NO_CRITERIA }]);

  const noChangeId = validatePlan({ criteria: [], items: [], split: { issues: [], prs: [] } });
  assert.deepEqual(noChangeId.gaps, [
    { criterionIndex: null, reason: PLAN_GAP_REASONS.MISSING_CHANGE_ID },
    { criterionIndex: null, reason: PLAN_GAP_REASONS.NO_CRITERIA },
  ]);

  assert.deepEqual(validatePlan(null), {
    ok: false,
    gaps: [{ criterionIndex: null, reason: PLAN_GAP_REASONS.INVALID_PLAN }],
  });
});

test('固定阶段模板：计划级 stages 与实现项级 stage 都判 FIXED_STAGE_TEMPLATE，build 也不透传', () => {
  const plan = buildDeliveryPlan(sampleInput());

  const planLevel = validatePlan({ ...plan, stages: [{ name: 'test' }] });
  assert.ok(planLevel.gaps.some((gap) => gap.reason === PLAN_GAP_REASONS.FIXED_STAGE_TEMPLATE && gap.criterionIndex === null));
  assert.equal(planLevel.ok, false);

  const itemLevel = validatePlan({ ...plan, items: plan.items.map((item) => ({ ...item, stage: 'impl' })) });
  assert.ok(itemLevel.gaps.some(
    (gap) => gap.reason === PLAN_GAP_REASONS.FIXED_STAGE_TEMPLATE && gap.itemId === 'P-1' && gap.criterionIndex === 1,
  ));

  const stripped = buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [{ criterionIndex: 1, change: '补接口', verification: ['node --test'], stage: 'impl', stages: ['x'] }],
  });
  assert.equal('stage' in stripped.items[0], false, '契约外字段不得进入计划');
  assert.equal('stages' in stripped.items[0], false);
  assert.equal(validatePlan(stripped).ok, true);
});

test('简单变更收敛成 1 Issue + 1 PR；多条实现项按真实边界分组且覆盖性完整', () => {
  const simple = buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [
      { criterionIndex: 1, change: '补接口', verification: ['node --test'] },
      { criterionIndex: 1, change: '补字段', verification: ['node --test'] },
    ],
  });
  assert.equal(simple.split.issues.length, 1);
  assert.equal(simple.split.prs.length, 1);
  assert.deepEqual(simple.split.issues[0], {
    id: 'I-1',
    boundary: DEFAULT_BOUNDARY,
    title: 'ARD123456 交付',
    itemIds: ['P-1', 'P-2'],
  });
  assert.deepEqual(simple.split.prs[0], {
    id: 'PR-1',
    issueId: 'I-1',
    boundary: DEFAULT_BOUNDARY,
    title: 'ARD123456 交付',
    itemIds: ['P-1', 'P-2'],
  });
  assert.deepEqual(validatePlan(simple), { ok: true, gaps: [] });

  const split = buildDeliveryPlan(sampleInput()).split;
  assert.deepEqual(split.issues.map((issue) => [issue.id, issue.boundary, issue.itemIds]), [
    ['I-1', 'api', ['P-1']],
    ['I-2', 'web', ['P-2']],
  ]);
  assert.deepEqual(split.prs.map((pr) => [pr.id, pr.issueId, pr.boundary]), [
    ['PR-1', 'I-1', 'api'],
    ['PR-2', 'I-2', 'web'],
  ]);
  assert.deepEqual(split.issues.map((issue) => issue.title), [
    'ARD123456 交付（api）',
    'ARD123456 交付（web）',
  ]);
  assert.deepEqual(
    split.issues.flatMap((issue) => issue.itemIds).sort(),
    ['P-1', 'P-2'],
    '每个实现项必须恰好落在一个 Issue 里',
  );
  assert.deepEqual(split.prs.flatMap((pr) => pr.itemIds).sort(), ['P-1', 'P-2']);
});

test('重复实现项 id 与缺失交付拆分都判不通过', () => {
  const duplicated = validatePlan(buildDeliveryPlan({
    changeId: 'ARD123456',
    criteria: ['a'],
    items: [
      { id: 'P-1', criterionIndex: 1, change: '补接口', verification: ['node --test'] },
      { id: 'P-1', criterionIndex: 1, change: '补字段', verification: ['node --test'] },
    ],
  }));
  assert.ok(duplicated.gaps.some((gap) => gap.reason === PLAN_GAP_REASONS.DUPLICATE_ITEM_ID && gap.itemId === 'P-1'));

  const noSplit = validatePlan({ ...buildDeliveryPlan(sampleInput()), split: { issues: [], prs: [] } });
  assert.ok(noSplit.gaps.some((gap) => gap.reason === PLAN_GAP_REASONS.NO_DELIVERY_SPLIT && gap.criterionIndex === null));

  const noPr = validatePlan({
    ...buildDeliveryPlan(sampleInput()),
    split: { issues: [{ id: 'I-1', title: 't', itemIds: ['P-1', 'P-2'] }], prs: [] },
  });
  assert.ok(noPr.gaps.some((gap) => gap.reason === PLAN_GAP_REASONS.NO_DELIVERY_SPLIT));
});

test('构建入参非法抛 PlanError（零副作用），缺变更号不生成计划', () => {
  assert.throws(
    () => buildDeliveryPlan({}),
    (error) => error instanceof PlanError && error.code === PLAN_GAP_REASONS.MISSING_CHANGE_ID,
  );
  assert.throws(
    () => buildDeliveryPlan({ changeId: 'ARD123456', criteria: 'oops' }),
    (error) => error instanceof PlanError && error.code === PLAN_GAP_REASONS.INVALID_PLAN && error.detail.field === 'criteria',
  );
  assert.throws(
    () => buildDeliveryPlan({ changeId: 'ARD123456', items: {} }),
    (error) => error instanceof PlanError && error.detail.field === 'items',
  );
});

test('计划构建是确定性的：同输入同输出，便于幂等创建与逐条核对', () => {
  assert.deepEqual(buildDeliveryPlan(sampleInput()), buildDeliveryPlan(sampleInput()));
});

test('渲染：逐条映射表、实现项明细、交付拆分都可见；畸形计划不抛错', () => {
  const plan = buildDeliveryPlan(sampleInput());
  const markdown = renderPlan(plan);

  assert.match(markdown, /^# 交付计划 — ARD123456/);
  assert.match(markdown, /\| 1 \| 接口返回 200 \| P-1 \| unit node --test test\/api\.test\.mjs \|/);
  assert.match(markdown, /\| 2 \| 页面可导出 \| P-2 \| manual 人工点导出 \|/);
  assert.match(markdown, /### P-1 — AC-1（边界：api）/);
  assert.match(markdown, /- 文件：`src\/api\.mjs`/);
  assert.match(markdown, /- unit：`node --test test\/api\.test\.mjs`/);
  assert.match(markdown, /- manual：人工点导出/);
  assert.match(markdown, /- Issue I-1「ARD123456 交付（api）」：P-1/);
  assert.match(markdown, /- PR PR-1（对应 I-1）「ARD123456 交付（api）」：P-1/);
  assert.doesNotMatch(markdown, /stages/, '渲染里也不得出现阶段模板字样');

  const empty = renderPlan({});
  assert.match(empty, /# 交付计划 — （缺变更号）/);
  assert.match(empty, /无验收条件：计划不成立/);
  assert.match(empty, /无实现项：计划不成立。/);
  assert.match(empty, /缺失：至少需要 1 个 Issue 与 1 个 PR。/);
  assert.doesNotThrow(() => renderPlan(null));
});

test('端到端：未确认的澄清单阻断计划，确认后修订标识与计划同时成立', () => {
  const findings = [
    {
      id: 'Q-1',
      kind: 'acceptance',
      question: '“可用”指什么？',
      basis: 'acceptance_criteria[0]',
      options: [
        { id: 'O-1', label: '可通过构建', effect: '只看构建', pros: ['快'], cons: ['漏性能'] },
        { id: 'O-2', label: '过性能基线', effect: '先补基线', pros: ['可量化'], cons: ['慢 2 天'] },
      ],
      recommendation: { optionId: 'O-2', why: '与性能目标一致' },
    },
  ];
  const sheet = createClarifySheet({ changeId: ARD, findings });
  // 阶段 1：门禁未确认 → 流程停在 waiting-clarification，计划不生成。
  assert.equal(sheet.status, 'pending');
  assert.equal(validateClarifySheet(sheet).ok, true, '清单本身合格，只是等人确认');
  assert.equal(buildDeliveryPlan({ changeId: ARD }).items.length, 0, '计划构建与确认解耦，由装配层按 status 阻断');

  // 阶段 2：人工确认后到达就绪终态，修订标识随决定更新。
  const confirmed = confirmClarifySheet(sheet, { by: '张三', at: '2026-10-28T12:00:00+08:00', decisions: [{ itemId: 'Q-1', optionId: 'O-2' }] });
  assert.equal(confirmed.status, 'ready');
  assert.match(confirmed.revisionId, /^ARD123456\/1\/[0-9a-f]{8}$/);

  // 阶段 3：按确认口径落计划，逐条映射通过即为该流程的终态。
  const plan = buildDeliveryPlan({
    changeId: ARD,
    criteria: [{ index: 1, text: '接口返回 200' }],
    items: [{ criterionIndex: 1, change: '补接口', verification: ['node --test'] }],
  });
  assert.deepEqual(validatePlan(plan), { ok: true, gaps: [] });
  assert.equal(plan.split.issues.length, 1);
  assert.equal(plan.split.prs.length, 1);
});
