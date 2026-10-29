import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bumpClarifyVersion,
  ClarifyError,
  clarifyRevisionId,
  CLARIFY_REASONS,
  CLARIFY_STATUSES,
  confirmClarifySheet,
  createClarifySheet,
  HARD_GATE_KINDS,
  renderClarifySheet,
  validateClarifySheet,
} from '../src/clarify.mjs';

/** 合格的硬门禁发现：2 个 effect 互异的选项、利弊非空、推荐属于选项。 */
function gateFinding(overrides = {}) {
  return {
    id: 'Q-1',
    kind: 'acceptance',
    question: '“可用”指什么？',
    basis: 'acceptance_criteria[1]：“变更后界面可用”',
    options: [
      { id: 'O-1', label: '可通过构建', effect: '验收只看构建与冒烟', pros: ['当天可验收'], cons: ['性能问题留到后续'] },
      { id: 'O-2', label: '通过性能基线', effect: '需要先补性能基线用例', pros: ['一次量化'], cons: ['延长 2 天'] },
    ],
    recommendation: { optionId: 'O-2', why: '与需求里的性能目标一致' },
    ...overrides,
  };
}

/** 非关键歧义：进假设段，不需要选项。 */
function assumptionFinding(label, overrides = {}) {
  return {
    id: `F-${label}`,
    kind: 'naming',
    text: `${label} 假设`,
    basis: `${label} 的依据`,
    impactIfWrong: `${label} 若不成立的影响`,
    ...overrides,
  };
}

/** 改完内容重算修订标识，避免 revision-mismatch 掩盖被测规则。 */
function reseal(sheet) {
  sheet.revisionId = clarifyRevisionId(sheet);
  return sheet;
}

test('HARD_GATE_KINDS 只有 acceptance / scope，其余类别进假设而不是门禁', () => {
  assert.deepEqual([...HARD_GATE_KINDS], ['acceptance', 'scope']);
  assert.deepEqual([...CLARIFY_STATUSES], ['pending', 'ready']);

  const sheet = createClarifySheet({
    changeId: 'ARD123456',
    findings: [gateFinding(), assumptionFinding('A')],
  });
  assert.equal(sheet.gate.length, 1);
  assert.equal(sheet.gate[0].kind, 'acceptance');
  assert.deepEqual(sheet.assumptions.map((item) => item.id), ['H-1']);
  assert.equal(sheet.assumptions[0].text, 'A 假设');
  assert.deepEqual(sheet.rejected, []);
});

test('合格澄清单：门禁项结构完整、validate 通过、修订标识与状态正确', () => {
  const sheet = createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding()] });

  assert.deepEqual(sheet.gate[0], {
    id: 'Q-1',
    kind: 'acceptance',
    question: '“可用”指什么？',
    basis: 'acceptance_criteria[1]：“变更后界面可用”',
    options: [
      { id: 'O-1', label: '可通过构建', effect: '验收只看构建与冒烟', pros: ['当天可验收'], cons: ['性能问题留到后续'] },
      { id: 'O-2', label: '通过性能基线', effect: '需要先补性能基线用例', pros: ['一次量化'], cons: ['延长 2 天'] },
    ],
    recommendation: { optionId: 'O-2', why: '与需求里的性能目标一致' },
  });

  const check = validateClarifySheet(sheet);
  assert.equal(check.ok, true, JSON.stringify(check.problems));
  assert.deepEqual(check.problems, []);
  assert.match(sheet.revisionId, /^ARD123456\/1\/[0-9a-f]{8}$/);
  assert.equal(sheet.status, 'pending', '有硬门禁项就必须等人确认，不能自称 ready');
});

test('无门禁项且自身合格 → ready；有门禁项 → pending', () => {
  const ready = createClarifySheet({ changeId: 'ARD123456', findings: [assumptionFinding('A')] });
  assert.equal(ready.status, 'ready');
  assert.equal(validateClarifySheet(ready).ok, true);

  const pending = createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding()] });
  assert.equal(pending.status, 'pending');
});

test('选项质量逐条判不通过：数量、effect 互异、利弊非空、推荐属于选项、依据与问句', () => {
  const cases = [
    ['options-min', (sheet) => {
      sheet.gate[0].options = sheet.gate[0].options.slice(0, 1);
      sheet.gate[0].recommendation.optionId = 'O-1';
    }],
    ['options-max', (sheet) => {
      sheet.gate[0].options.push(
        { id: 'O-4', label: 'x', effect: 'e4', pros: ['p'], cons: ['c'] },
        { id: 'O-5', label: 'y', effect: 'e5', pros: ['p'], cons: ['c'] },
      );
    }],
    ['option-effect-duplicate', (sheet) => {
      sheet.gate[0].options[1].effect = sheet.gate[0].options[0].effect;
    }],
    ['option-pros-empty', (sheet) => { sheet.gate[0].options[0].pros = []; }],
    ['option-cons-empty', (sheet) => { sheet.gate[0].options[1].cons = ['   ']; }],
    ['recommendation-not-in-options', (sheet) => { sheet.gate[0].recommendation.optionId = 'O-9'; }],
    ['recommendation-why-missing', (sheet) => { sheet.gate[0].recommendation.why = ''; }],
    ['basis-missing', (sheet) => { sheet.gate[0].basis = '  '; }],
    ['question-missing', (sheet) => { sheet.gate[0].question = ''; }],
    ['option-label-missing', (sheet) => { sheet.gate[0].options[0].label = ''; }],
  ];

  for (const [rule, mutate] of cases) {
    const sheet = reseal(createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding()] }));
    mutate(sheet);
    reseal(sheet);
    const check = validateClarifySheet(sheet);
    assert.equal(check.ok, false, `${rule} 必须判不通过`);
    assert.ok(
      check.problems.some((problem) => problem.code === CLARIFY_REASONS.CLARIFY_INVALID && problem.rule === rule),
      `${rule}: ${JSON.stringify(check.problems)}`,
    );
  }
});

test('零选项的硬门禁问题进 rejected(no-options) 并判不通过；缺 kind 进 unknown-kind', () => {
  const noOptions = createClarifySheet({
    changeId: 'ARD123456',
    findings: [{ id: 'F-9', kind: 'scope', question: '范围到哪？', basis: 'sub_systems[0]', options: [] }],
  });
  assert.equal(noOptions.gate.length, 0);
  assert.deepEqual(noOptions.rejected, [{ findingId: 'F-9', reason: 'no-options' }]);
  assert.equal(noOptions.status, 'pending');
  const noOptionsCheck = validateClarifySheet(noOptions);
  assert.equal(noOptionsCheck.ok, false);
  assert.ok(noOptionsCheck.problems.some((problem) => problem.code === CLARIFY_REASONS.NO_OPTIONS));

  const noKind = createClarifySheet({ changeId: 'ARD123456', findings: [{ id: 'F-10', text: '说不清' }] });
  assert.deepEqual(noKind.rejected, [{ findingId: 'F-10', reason: 'unknown-kind' }]);
  assert.equal(validateClarifySheet(noKind).ok, false);
  assert.ok(validateClarifySheet(noKind).problems.some((problem) => problem.code === CLARIFY_REASONS.UNKNOWN_KIND));

  const empty = createClarifySheet({ changeId: 'ARD123456', findings: [] });
  assert.equal(empty.status, 'ready');
  assert.equal(validateClarifySheet(empty).ok, true);
});

test('H-n 编号稳定、显式编号保留、同号覆盖即替换', () => {
  const findings = [assumptionFinding('A'), assumptionFinding('B')];
  const first = createClarifySheet({ changeId: 'ARD123456', findings });
  const second = createClarifySheet({ changeId: 'ARD123456', findings });
  assert.deepEqual(first.assumptions.map((item) => item.id), ['H-1', 'H-2']);
  assert.equal(second.revisionId, first.revisionId, '同输入必须同修订标识');

  const reserved = createClarifySheet({
    changeId: 'ARD123456',
    findings: [assumptionFinding('C', { assumptionId: 'H-3' }), assumptionFinding('A'), assumptionFinding('B')],
  });
  assert.deepEqual(reserved.assumptions.map((item) => item.id), ['H-3', 'H-1', 'H-2'], '自动编号必须跳过显式占用的号');

  const replaced = createClarifySheet({
    changeId: 'ARD123456',
    findings: [assumptionFinding('A', { assumptionId: 'H-1' }), assumptionFinding('B2', { assumptionId: 'H-1' })],
  });
  assert.equal(replaced.assumptions.length, 1, '同号是替换，不是新增');
  assert.equal(replaced.assumptions[0].text, 'B2 假设');
});

test('人工确认只由 confirmClarifySheet 写入：缺确认人/漏决断/选项不存在都拒绝', () => {
  const sheet = createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding()] });

  assert.throws(
    () => confirmClarifySheet(sheet, { by: '  ', decisions: [{ itemId: 'Q-1', optionId: 'O-2' }] }),
    (error) => error instanceof ClarifyError && error.code === CLARIFY_REASONS.CLARIFY_INVALID && /确认人/.test(error.message),
  );
  assert.throws(
    () => confirmClarifySheet(sheet, { by: '张三', decisions: [] }),
    (error) => error instanceof ClarifyError && error.detail.missing.includes('Q-1'),
  );
  assert.throws(
    () => confirmClarifySheet(sheet, { by: '张三', decisions: [{ itemId: 'Q-1', optionId: 'O-9' }] }),
    (error) => error instanceof ClarifyError && /不属于/.test(error.message),
  );

  const invalidSheet = createClarifySheet({
    changeId: 'ARD123456',
    findings: [gateFinding({ options: [{ id: 'O-1', label: '唯一选项', effect: 'e1', pros: ['p'], cons: ['c'] }], recommendation: { optionId: 'O-1', why: 'w' } })],
  });
  assert.throws(
    () => confirmClarifySheet(invalidSheet, { by: '张三', decisions: [] }),
    (error) => error instanceof ClarifyError && Array.isArray(error.detail.problems) && error.detail.problems.length > 0,
  );

  const confirmed = confirmClarifySheet(sheet, {
    by: '张三',
    at: '2026-10-28T12:00:00+08:00',
    decisions: [{ itemId: 'Q-1', optionId: 'O-2', note: '性能优先' }],
  });
  assert.equal(confirmed.status, 'ready');
  assert.equal(confirmed.confirmedBy, '张三');
  assert.equal(confirmed.confirmedAt, '2026-10-28T12:00:00+08:00');
  assert.deepEqual(confirmed.decisions, [{ itemId: 'Q-1', optionId: 'O-2', note: '性能优先' }]);
  assert.notEqual(confirmed.revisionId, sheet.revisionId, '决定进入修订标识：改答案即新修订');
  assert.equal(validateClarifySheet(confirmed).ok, true);
  assert.equal(sheet.status, 'pending', '确认不得就地改写原清单');
});

test('状态与决定自洽：ready 但门禁未决判 confirmation-incomplete，决定必须指向真实选项', () => {
  const sheet = createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding()] });

  const forged = { ...sheet, status: 'ready' };
  const forgedCheck = validateClarifySheet(forged);
  assert.equal(forgedCheck.ok, false);
  assert.ok(forgedCheck.problems.some((problem) => problem.rule === 'confirmation-incomplete'));

  const unknownItem = reseal({ ...sheet, decisions: [{ itemId: 'Q-9', optionId: 'O-1' }] });
  assert.ok(validateClarifySheet(unknownItem).problems.some((problem) => problem.rule === 'decision-unknown-item'));

  const unknownOption = reseal({ ...sheet, decisions: [{ itemId: 'Q-1', optionId: 'O-9' }] });
  assert.ok(validateClarifySheet(unknownOption).problems.some((problem) => problem.rule === 'decision-option-unknown'));

  const duplicate = reseal({
    ...sheet,
    decisions: [
      { itemId: 'Q-1', optionId: 'O-1' },
      { itemId: 'Q-1', optionId: 'O-2' },
    ],
  });
  assert.ok(validateClarifySheet(duplicate).problems.some((problem) => problem.rule === 'decision-duplicate'));
});

test('修改内容不重算修订标识即 revision-mismatch；非法输入抛 ClarifyError', () => {
  const sheet = createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding()] });
  sheet.gate[0].question = '被就地改过的问句';
  const check = validateClarifySheet(sheet);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((problem) => problem.rule === 'revision-mismatch'));

  assert.throws(
    () => clarifyRevisionId({ version: 1 }),
    (error) => error instanceof ClarifyError && error.code === CLARIFY_REASONS.CLARIFY_INVALID,
  );
  assert.throws(
    () => clarifyRevisionId({ changeId: 'ARD123456', version: 0 }),
    (error) => error instanceof ClarifyError && error.code === CLARIFY_REASONS.VERSION_INVALID,
  );
  assert.throws(
    () => createClarifySheet({ changeId: '  ' }),
    (error) => error instanceof ClarifyError && error.code === CLARIFY_REASONS.CLARIFY_INVALID,
  );
  assert.throws(
    () => createClarifySheet({ changeId: 'ARD123456', findings: 'oops' }),
    (error) => error instanceof ClarifyError && error.detail.field === 'findings',
  );

  const missing = validateClarifySheet(null);
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].rule, 'sheet-missing');
});

test('升版：版本 +1、旧确认与决定失效、历史留痕、原清单不变', () => {
  const sheet = createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding()] });
  const confirmed = confirmClarifySheet(sheet, {
    by: '张三',
    at: '2026-10-28T12:00:00+08:00',
    decisions: [{ itemId: 'Q-1', optionId: 'O-2' }],
  });
  const bumped = bumpClarifyVersion(confirmed, { reason: '补一个折中选项', at: '2026-10-28T13:00:00+08:00' });

  assert.equal(bumped.version, 2);
  assert.match(bumped.revisionId, /^ARD123456\/2\/[0-9a-f]{8}$/);
  assert.notEqual(bumped.revisionId, confirmed.revisionId);
  assert.equal(bumped.status, 'pending');
  assert.deepEqual(bumped.decisions, []);
  assert.equal(bumped.confirmedBy, null);
  assert.equal(bumped.confirmedAt, null);
  assert.deepEqual(bumped.history, [
    { version: 1, revisionId: confirmed.revisionId, reason: '补一个折中选项', at: '2026-10-28T13:00:00+08:00' },
  ]);
  assert.equal(confirmed.version, 1, '升版不得就地改写旧版本');
  assert.equal(confirmed.status, 'ready');

  const bumpedAgain = bumpClarifyVersion(bumped);
  assert.equal(bumpedAgain.version, 3);
  assert.equal(bumpedAgain.history.length, 2);
  assert.equal(bumpedAgain.history[1].reason, 'content-changed');

  assert.throws(
    () => bumpClarifyVersion({ version: 1 }),
    (error) => error instanceof ClarifyError && error.code === CLARIFY_REASONS.CLARIFY_INVALID,
  );
  assert.throws(
    () => bumpClarifyVersion({ changeId: 'ARD123456', version: '1' }),
    (error) => error instanceof ClarifyError && error.code === CLARIFY_REASONS.VERSION_INVALID,
  );
});

test('渲染：门禁项、选项与推荐、假设、未纳入、状态都可见；空清单不抛错', () => {
  const sheet = createClarifySheet({
    changeId: 'ARD123456',
    findings: [
      gateFinding(),
      assumptionFinding('A'),
      { id: 'F-9', kind: 'scope', question: '范围到哪？', basis: 'sub_systems[0]', options: [] },
    ],
  });
  const markdown = renderClarifySheet(sheet);

  assert.match(markdown, /^# 澄清单 — ARD123456/);
  assert.match(markdown, new RegExp(sheet.revisionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markdown, /待人工确认/);
  assert.match(markdown, /### Q-1/);
  assert.match(markdown, /推荐：是 —— 与需求里的性能目标一致/);
  assert.match(markdown, /\*\*O-1 可通过构建\*\*/);
  assert.match(markdown, /利：当天可验收；弊：性能问题留到后续/);
  assert.match(markdown, /\*\*H-1\*\* A 假设/);
  assert.match(markdown, /若不成立：A 若不成立的影响/);
  assert.match(markdown, /F-9：无选项（no-options）/);

  // 含"无选项"项的清单一律不可确认（不通过），故另建一份可确认的清单验证渲染。
  const confirmable = createClarifySheet({ changeId: 'ARD123456', findings: [gateFinding(), assumptionFinding('A')] });
  const confirmed = confirmClarifySheet(confirmable, {
    by: '张三',
    at: '2026-10-28T12:00:00+08:00',
    decisions: [{ itemId: 'Q-1', optionId: 'O-2', note: '性能优先' }],
  });
  const confirmedMarkdown = renderClarifySheet(confirmed);
  assert.match(confirmedMarkdown, /已就绪/);
  assert.match(confirmedMarkdown, /已选：O-2 —— 性能优先/);
  assert.match(confirmedMarkdown, /确认：张三 @ 2026-10-28T12:00:00\+08:00/);

  const empty = renderClarifySheet({ changeId: 'ARD1', version: 1, status: 'ready', gate: [], assumptions: [], rejected: [] });
  assert.match(empty, /无：没有会改变验收结论或承建范围的歧义/);
  assert.doesNotThrow(() => renderClarifySheet(null));
});
