import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_STATUSES } from '../src/actions.mjs';
import * as reportApi from '../src/report.mjs';
import {
  buildReport,
  CLOSE_READINESS_REASONS,
  DELIVERY_STATES,
  EVIDENCE_FIELDS,
  PLATFORM_WRITE_ACTIONS,
  issueCloseReadiness,
  renderReport,
  REPORT_ACTION_STATUSES,
  REPORT_CONCLUSIONS,
  REPORT_GAP_REASONS,
  REPORT_SOURCE_TYPES,
  ReportError,
  UAT_NOTE,
  validateReport,
} from '../src/report.mjs';
import { buildReviewRecord, recordHumanConfirmation } from '../src/review.mjs';
import { FLOW_ACTIONS } from '../src/tools.mjs';

const ARD = 'ARD123456';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const AT = '2026-10-28T21:00:00+08:00';

const evidence = (sourceType, overrides = {}) => ({
  command: 'dop change view ARD123456 --json',
  at: AT,
  hostVersion: '0.2.1-rc.2',
  target: 'ARD123456',
  sourceType,
  result: '退出码 0，字段齐全',
  ...overrides,
});

const criteria = (overrides = {}) => [
  {
    index: 1,
    text: '上下文卡字段齐全',
    evidence: [evidence('mock')],
    conclusion: 'passed',
    ...overrides,
  },
];

function sampleReport(overrides = {}) {
  return buildReport({
    changeId: ARD,
    criteria: [
      {
        index: 1,
        text: '上下文卡字段齐全',
        evidence: [evidence('mock'), evidence('enterprise', { command: 'dop change view ARD123456 --json --endpoint', result: '企业环境同字段' })],
        conclusion: 'passed',
      },
      { index: 2, text: '报告逐条证据', evidence: [evidence('mock', { command: 'node --test test/report.test.mjs' })], conclusion: 'passed' },
    ],
    delivery: [{ ref: 'hrygo/heluo-forge#101', state: 'merged' }],
    uat: { status: 'passed', detail: '企业 UAT 环境部署后核对通过', sourceType: 'enterprise' },
    host: { hostVersion: '0.2.1-rc.2', at: AT },
    ...overrides,
  });
}

function gapCodes(report) {
  return validateReport(report).gaps.map((gap) => gap.code);
}

test('逐条证据：六字段缺一项即判不合格，并定位到验收条件与证据序号', () => {
  const report = sampleReport();
  assert.deepEqual(validateReport(report), { ok: true, gaps: [] });
  assert.deepEqual([...EVIDENCE_FIELDS], ['command', 'at', 'hostVersion', 'target', 'sourceType', 'result']);

  const missingAt = structuredClone(report);
  delete missingAt.criteria[0].evidence[0].at;
  const gaps = validateReport(missingAt).gaps;
  assert.deepEqual(gaps.map((gap) => gap.code), [REPORT_GAP_REASONS.MISSING_EVIDENCE_FIELDS]);
  assert.equal(gaps[0].criterionIndex, 1);
  assert.equal(gaps[0].evidenceIndex, 0);
  assert.equal(gaps[0].detail, 'at');

  const missingResult = structuredClone(report);
  missingResult.criteria[1].evidence[0].result = '';
  assert.equal(gapCodes(missingResult).includes(REPORT_GAP_REASONS.MISSING_EVIDENCE_FIELDS), true);
});

test('没有证据、来源类型非法、结论非法都逐条可见（不静默放行）', () => {
  const noEvidence = sampleReport();
  noEvidence.criteria[1].evidence = [];
  const gaps = validateReport(noEvidence).gaps;
  assert.deepEqual(
    gaps.map((gap) => [gap.code, gap.criterionIndex]),
    [[REPORT_GAP_REASONS.MISSING_EVIDENCE, 2]],
  );

  const badSource = sampleReport();
  badSource.criteria[0].evidence[0].sourceType = 'real';
  assert.equal(gapCodes(badSource).includes(REPORT_GAP_REASONS.INVALID_SOURCE_TYPE), true);

  const badConclusion = sampleReport();
  badConclusion.criteria[0].conclusion = 'ok';
  assert.equal(gapCodes(badConclusion).includes(REPORT_GAP_REASONS.INVALID_CONCLUSION), true);
  assert.deepEqual([...REPORT_CONCLUSIONS], ['passed', 'failed', 'not-verified']);
});

test('mock 与企业实测分列：未标注默认 mock，汇总计数，渲染不把 mock 当企业证据', () => {
  const report = sampleReport();
  assert.deepEqual(report.evidenceTotals, { mock: 2, enterprise: 1 });
  assert.deepEqual([...REPORT_SOURCE_TYPES], ['mock', 'enterprise']);

  const defaults = buildReport({
    changeId: ARD,
    criteria: [{ index: 1, text: '未标注来源', evidence: [{ command: 'node --test', at: AT, hostVersion: '0.2.1-rc.2', target: ARD, result: 'ok' }], conclusion: 'passed' }],
    host: { hostVersion: '0.2.1-rc.2', at: AT },
  });
  assert.equal(defaults.criteria[0].evidence[0].sourceType, 'mock', '未标注来源默认 mock（不得默认 enterprise）');
  assert.deepEqual(defaults.evidenceTotals, { mock: 1, enterprise: 0 });

  const text = renderReport(report);
  assert.match(text, /mock 实测 2 条 \/ 企业实测 1 条/u);
  assert.equal(text.includes('本报告无企业实测证据'), false);
  assert.match(text, /\[企业实测\]/u);
  assert.match(text, /\[mock 实测\]/u);

  const mockOnly = renderReport(defaults);
  assert.match(mockOnly, /本报告无企业实测证据/u);
  assert.match(mockOnly, /不得当作企业已联调/u);
});

test('UAT 取不到即 unknown + 原因；非法状态也落 unknown 并保留原始值', () => {
  const absent = buildReport({ changeId: ARD, criteria: criteria(), host: { hostVersion: '0.2.1-rc.2', at: AT } });
  assert.equal(absent.uat.status, 'unknown');
  assert.ok(absent.uat.detail.includes(UAT_NOTE), 'unknown 必须写明读不到的原因与边界');
  assert.equal(absent.blockers.some((blocker) => blocker.code === 'UAT_UNKNOWN'), true, 'UAT unknown 进失败与阻塞');
  assert.match(renderReport(absent), /UAT 与部署边界（只读核对）/u);

  const invalid = buildReport({
    changeId: ARD,
    criteria: criteria(),
    uat: { status: 'green', detail: '厂商口头说通过' },
    host: { hostVersion: '0.2.1-rc.2', at: AT },
  });
  assert.equal(invalid.uat.status, 'unknown');
  assert.match(invalid.uat.detail, /green/u, '原始值保留，便于排查');

  const passed = buildReport({ changeId: ARD, criteria: criteria(), uat: { status: 'passed', detail: '已核对' }, host: { hostVersion: '0.2.1-rc.2', at: AT } });
  assert.equal(validateReport(passed).ok, true);

  const missing = structuredClone(passed);
  delete missing.uat;
  assert.equal(gapCodes(missing).includes(REPORT_GAP_REASONS.MISSING_UAT), true);

  const unknownNoReason = structuredClone(passed);
  unknownNoReason.uat = { status: 'unknown', detail: '' };
  assert.equal(gapCodes(unknownNoReason).includes(REPORT_GAP_REASONS.INVALID_UAT), true);
});

test('H-* 假设逐条出现：未复核判缺口、非法结论判缺口、id 必须 H-n', () => {
  const report = buildReport({
    changeId: ARD,
    criteria: criteria(),
    assumptions: [
      { id: 'H-1', text: 'dop 字段契约与 2026-07-06 一致' },
      { id: 'H-2', text: '目标仓库唯一', result: 'confirmed' },
    ],
    host: { hostVersion: '0.2.1-rc.2', at: AT },
  });
  assert.deepEqual(
    report.assumptionsChecked.map((assumption) => [assumption.id, assumption.result]),
    [
      ['H-1', null],
      ['H-2', 'confirmed'],
    ],
  );
  assert.match(renderReport(report), /\*\*未复核\*\*/u);
  assert.equal(gapCodes(report).includes(REPORT_GAP_REASONS.ASSUMPTION_NOT_CHECKED), true);

  const checked = structuredClone(report);
  checked.assumptionsChecked[0].result = 'confirmed';
  assert.equal(validateReport(checked).ok, true);

  const badResult = structuredClone(checked);
  badResult.assumptionsChecked[1].result = 'maybe';
  assert.equal(gapCodes(badResult).includes(REPORT_GAP_REASONS.INVALID_ASSUMPTION_RESULT), true);

  const badId = structuredClone(checked);
  badId.assumptionsChecked[1].id = 'X-2';
  assert.equal(gapCodes(badId).includes(REPORT_GAP_REASONS.INVALID_ASSUMPTION_ID), true);
});

test('关闭就绪判定：验收通过 + 交付已合入 + 无未完成交付 + 人工确认，四者缺一即不就绪', () => {
  const all = issueCloseReadiness({
    criteria: [{ index: 1, conclusion: 'passed' }],
    prs: [{ ref: 'PR-1', state: 'merged' }],
    pending: [],
    humanConfirmed: true,
  });
  assert.deepEqual(all, { ready: true, missing: [] });

  const noCriteria = issueCloseReadiness({ criteria: [], prs: [], humanConfirmed: true });
  assert.equal(noCriteria.ready, false);
  assert.equal(noCriteria.missing.some((item) => item.code === CLOSE_READINESS_REASONS.NO_CRITERIA), true);
  assert.equal(noCriteria.missing.some((item) => item.code === CLOSE_READINESS_REASONS.NO_DELIVERY_PR), true);

  const notPassed = issueCloseReadiness({ criteria: [{ index: 2, conclusion: 'failed' }], prs: [{ ref: 'PR-1', state: 'merged' }], humanConfirmed: true });
  assert.deepEqual(notPassed.missing.map((item) => item.code), [CLOSE_READINESS_REASONS.CRITERION_NOT_PASSED]);
  assert.match(notPassed.missing[0].detail, /AC-2/u);

  const notMerged = issueCloseReadiness({ criteria: [{ index: 1, conclusion: 'passed' }], prs: [{ ref: 'PR-1', state: 'under-review' }], humanConfirmed: true });
  assert.deepEqual(notMerged.missing.map((item) => item.code), [CLOSE_READINESS_REASONS.PR_NOT_MERGED]);

  const pending = issueCloseReadiness({
    criteria: [{ index: 1, conclusion: 'passed' }],
    prs: [{ ref: 'PR-1', state: 'merged' }],
    pending: [{ ref: 'PR-2', detail: '待审查' }],
    humanConfirmed: true,
  });
  assert.deepEqual(pending.missing.map((item) => item.code), [CLOSE_READINESS_REASONS.PENDING_DELIVERY]);

  const noHuman = issueCloseReadiness({ criteria: [{ index: 1, conclusion: 'passed' }], prs: [{ ref: 'PR-1', state: 'merged' }] });
  assert.deepEqual(noHuman.missing.map((item) => item.code), [CLOSE_READINESS_REASONS.HUMAN_CONFIRMATION_REQUIRED]);
});

test('关闭只判定不执行：模块没有合并/关闭/发布/部署通道，判定函数不改入参', () => {
  const input = { criteria: [{ index: 1, conclusion: 'passed' }], prs: [{ ref: 'PR-1', state: 'merged' }], pending: [], humanConfirmed: true };
  const snapshot = structuredClone(input);
  assert.deepEqual(issueCloseReadiness(input), issueCloseReadiness(input));
  assert.deepEqual(input, snapshot, '判定函数不修改入参');

  // 常量（全大写）不算通道；只查 camelCase 的导出函数里是否藏着动作型名字。
  const functions = Object.keys(reportApi).filter((name) => !/^[A-Z0-9_]+$/u.test(name));
  assert.deepEqual(functions.filter((name) => /^(merge|close|release|deploy|execute|trigger|push|run)/iu.test(name)), []);
  // 白名单与工具面真源逐值一致；合并/关闭/发布类动作不在表内（代码里也不存在对应命令）。
  assert.deepEqual([...PLATFORM_WRITE_ACTIONS].sort(), Object.values(FLOW_ACTIONS).sort());
  for (const blocked of ['pr.merge', 'pr.close', 'issue.close', 'change.done', 'change.create']) {
    assert.equal(PLATFORM_WRITE_ACTIONS.includes(blocked), false, `${blocked} 不得出现在写动作白名单`);
  }

  const report = sampleReport();
  assert.match(renderReport(report), /关闭就绪性（只判定，不执行）/u);
  assert.match(renderReport(report), /不合并 PR、不关闭 Issue/u);
});

test('交付分列：已提交/待审查/已合入三组；同一 PR 两个状态判冲突，状态不明直接拒绝', () => {
  const report = buildReport({
    changeId: ARD,
    criteria: criteria(),
    delivery: [
      { ref: 'PR-1', state: 'merged' },
      { ref: 'PR-2', state: 'under-review' },
      { ref: 'PR-3', state: 'submitted' },
    ],
    uat: { status: 'unknown', detail: '未取到' },
    host: { hostVersion: '0.2.1-rc.2', at: AT },
  });
  assert.deepEqual(Object.keys(report.delivery), ['submitted', 'underReview', 'merged']);
  assert.deepEqual(report.deliveryTotals, { submitted: 1, underReview: 1, merged: 1 });
  assert.equal(validateReport(report).ok, true);
  assert.deepEqual([...DELIVERY_STATES], ['submitted', 'under-review', 'merged']);

  const conflict = structuredClone(report);
  conflict.delivery.merged.push({ ref: 'PR-2', state: 'merged' });
  assert.equal(gapCodes(conflict).includes(REPORT_GAP_REASONS.DELIVERY_STATE_CONFLICT), true);

  assert.throws(
    () => buildReport({ changeId: ARD, criteria: criteria(), delivery: [{ ref: 'PR-9' }], host: { hostVersion: 'x', at: AT } }),
    (error) => error instanceof ReportError && error.code === REPORT_GAP_REASONS.INVALID_DELIVERY,
  );
});

test('平台动作四状态：与 actions.ACTION_STATUSES 逐值一致；越权动作与流程态混入都判不合格', () => {
  assert.deepEqual([...REPORT_ACTION_STATUSES], [...ACTION_STATUSES]);

  const report = buildReport({
    changeId: ARD,
    criteria: criteria(),
    actions: [
      { status: 'done', action: 'issue.create_or_update', target: 'hrygo/heluo-forge', objectRef: 'https://github.com/hrygo/heluo-forge/issues/1', reused: true, key: 'k1' },
      { status: 'denied', action: 'change.clarification.write', target: ARD, reason: 'COMMAND_NOT_WHITELISTED' },
    ],
    host: { hostVersion: '0.2.1-rc.2', at: AT },
  });
  assert.equal(validateReport(report).ok, true);
  assert.equal(report.blockers.some((blocker) => blocker.code === 'ACTION_DENIED'), true);
  assert.match(renderReport(report), /\| `done` \| `issue\.create_or_update`/u);
  assert.match(renderReport(report), /平台动作状态 `done\/failed\/denied\/unknown` 与流程态 `blocked\/skipped\/stale` 是两套词表/u);

  const forbidden = structuredClone(report);
  forbidden.actions.push({ status: 'done', action: 'pr.merge', target: 'hrygo/heluo-forge' });
  assert.equal(gapCodes(forbidden).includes(REPORT_GAP_REASONS.ACTION_NOT_ALLOWED), true);

  const mixedVocabulary = structuredClone(report);
  mixedVocabulary.actions.push({ status: 'blocked', action: 'issue.create_or_update', target: 'r' });
  assert.equal(gapCodes(mixedVocabulary).includes(REPORT_GAP_REASONS.INVALID_ACTION_STATUS), true);
});

test('审查摘要绑定模型与 commit；sha 变化后旧确认 stale，报告不得沿用', () => {
  const review = buildReviewRecord({
    changeId: ARD,
    commit: SHA,
    model: 'gpt-6.1-sol',
    findings: ['无阻断问题'],
    conclusion: '可交付',
  });
  const confirmed = recordHumanConfirmation(review, { by: 'hosea', at: AT, commit: SHA, decision: 'confirmed' });

  const current = buildReport({
    changeId: ARD,
    criteria: criteria(),
    delivery: [{ ref: 'PR-1', state: 'merged' }],
    review: confirmed,
    uat: { status: 'passed', detail: '已核对' },
    host: { hostVersion: '0.2.1-rc.2', at: AT, commit: SHA },
  });
  assert.equal(current.review.staleness, 'current');
  assert.equal(validateReport(current).ok, true);
  assert.equal(current.closing.missing.some((item) => item.code === CLOSE_READINESS_REASONS.HUMAN_CONFIRMATION_REQUIRED), false);

  const stale = buildReport({
    changeId: ARD,
    criteria: criteria(),
    delivery: [{ ref: 'PR-1', state: 'merged' }],
    review: confirmed,
    uat: { status: 'passed', detail: '已核对' },
    host: { hostVersion: '0.2.1-rc.2', at: AT, commit: OTHER_SHA },
  });
  assert.equal(stale.review.staleness, 'stale');
  assert.equal(gapCodes(stale).includes(REPORT_GAP_REASONS.HUMAN_CONFIRMATION_STALE), true);
  assert.match(renderReport(stale), /确认已过期/u);
  assert.equal(stale.closing.missing.some((item) => item.code === CLOSE_READINESS_REASONS.HUMAN_CONFIRMATION_REQUIRED), true);

  const unbound = buildReport({ changeId: ARD, criteria: criteria(), review: { changeId: ARD, model: {}, conclusion: '' }, host: { hostVersion: 'x', at: AT } });
  assert.equal(gapCodes(unbound).includes(REPORT_GAP_REASONS.REVIEW_NOT_BOUND), true);
});

test('报告自证会被拦下：关闭就绪与内容矛盾、缺变更号、结构非法', () => {
  const report = sampleReport();
  assert.equal(validateReport(report).ok, true);

  const inconsistent = structuredClone(report);
  inconsistent.delivery = { submitted: [{ ref: 'PR-9', state: 'submitted' }], underReview: [], merged: [] };
  inconsistent.closing = { ready: true, missing: [] };
  assert.equal(gapCodes(inconsistent).includes(REPORT_GAP_REASONS.CLOSING_INCONSISTENT), true);

  assert.deepEqual(validateReport(null).gaps.map((gap) => gap.code), [REPORT_GAP_REASONS.INVALID_REPORT]);
  assert.deepEqual(validateReport([]).gaps.map((gap) => gap.code), [REPORT_GAP_REASONS.INVALID_REPORT]);
  assert.equal(gapCodes({ ...report, changeId: '' }).includes(REPORT_GAP_REASONS.MISSING_CHANGE_ID), true);
  assert.throws(
    () => buildReport({ criteria: [], host: { hostVersion: 'x', at: AT } }),
    (error) => error instanceof ReportError && error.code === REPORT_GAP_REASONS.MISSING_CHANGE_ID,
  );
});

test('renderReport 结构与证据纪律：逐条标注来源、mock 不冒充企业、不声明平台已完成', () => {
  const text = renderReport(sampleReport());
  assert.match(text, /^# 完成报告 — ARD123456/mu);
  assert.match(text, /## 验收条件与证据/u);
  assert.match(text, /### AC-1 上下文卡字段齐全/u);
  assert.match(text, /- 结论：`passed`/u);
  assert.match(text, /宿主 0\.2\.1-rc\.2/u);
  assert.match(text, /目标 ARD123456/u);
  assert.match(text, /## 交付分列/u);
  assert.match(text, /### 已合入（1）/u);
  assert.match(text, /## UAT 与部署边界（只读核对）/u);
  assert.match(text, /## 假设复核（H-\*）/u);
  assert.match(text, /## 平台动作（四状态）/u);
  assert.match(text, /## 失败与阻塞/u);
  assert.match(text, /## 交叉审查/u);
  assert.match(text, /\*\*不改变\*\*系统变更\/用户故事状态/u);

  assert.equal(/系统变更已完成|用户故事已完成/u.test(text), false, '产物不得出现"已完成"式结论（AC-19）');

  const noEvidence = structuredClone(sampleReport());
  noEvidence.criteria[1].evidence = [];
  assert.match(renderReport(noEvidence), /证据：\*\*缺失\*\*（无证据不得判通过）/u);
});

test('证据时间由调用方注入：纯函数不读时钟，缺时间即缺口而不是补一个 now()', () => {
  const report = buildReport({
    changeId: ARD,
    criteria: [{ index: 1, text: '无 at 证据', evidence: [{ command: 'node --test', hostVersion: '0.2.1-rc.2', target: ARD, result: 'ok' }], conclusion: 'passed' }],
    host: { hostVersion: '0.2.1-rc.2' },
  });
  assert.equal(report.host.at, null);
  const gaps = validateReport(report).gaps;
  assert.deepEqual(gaps.map((gap) => [gap.code, gap.detail]), [[REPORT_GAP_REASONS.MISSING_EVIDENCE_FIELDS, 'at']]);
});
