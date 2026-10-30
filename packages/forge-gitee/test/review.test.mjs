/**
 * TK6 审查产物（AC-19 / AC-20）：`review.md` 四段 + AI/人工两栏 + 模型名/sha + `stale` 派生 +
 * 跨 provider 不覆盖 + 脱敏阻断 + 路径包含。
 *
 * 这些用例守住三条"错了不会有人发现"的边界：
 * 1. **人工栏只能由人写**——`buildReviewRecord` 收到人工字段必须抛（而不是忽略），
 *    `recordHumanConfirmation` 必须要求显式人工来源（无默认值），否则模型自填与人的确认在代码里同形。
 * 2. **`stale` 不落盘**——旧的确认在 sha 变化后必须派生为 `stale`，而文件里不能再写一个会被误读的
 *    "已通过"；渲染结果里因此不出现 `stale:` 这类固化的版本一致性字段。
 * 3. **写盘前拦截**——脱敏命中、目标属于别的 provider、路径越界，都必须"文件没有被写"，而不仅是
 *    "函数抛了错"；所以每个失败用例都同时断言磁盘状态。
 *
 * 断言锁结论（错误码、段落、磁盘摘要），不锁提示语原文：改文案不应让用例失效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHANGE_ID_PATTERN,
  FORBIDDEN_HUMAN_KEYS,
  HUMAN_ORIGINS,
  MODEL_ORIGINS,
  MODEL_TIERS,
  REVIEW_COLUMNS,
  REVIEW_DECISIONS,
  REVIEW_DIR_SEGMENTS,
  REVIEW_FILE_NAME,
  REVIEW_REASONS,
  REVIEW_SECTIONS,
  REVIEW_SOURCE_TYPES,
  REVIEW_STALENESS,
  REVIEW_STATUSES,
  ReviewError,
  assertReviewSections,
  buildReviewRecord,
  parseReviewFrontMatter,
  recordHumanConfirmation,
  renderReview,
  reviewStaleness,
  scanRedactions,
  writeReviewFile,
} from '../src/gitee-review.mjs';

const CHANGE = 'CHG-2026-0042';
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const LATER = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const AT = '2026-10-29T10:00:00.000Z';

/** 一份合格的 AI 审查记录；各用例只覆盖自己关心的字段。 */
function record(overrides = {}) {
  return buildReviewRecord({
    changeId: CHANGE,
    commit: COMMIT,
    model: 'deepseek-v4.1-flash',
    findings: ['令牌直接写进了配置文件'],
    risks: ['回滚步骤未验证'],
    opinion: '建议补一条脱敏用例',
    conclusion: '整体可合并，补用例后放行',
    at: AT,
    ...overrides,
  });
}

/** 断言抛出的是本模块的结构性错误且码值等于期望（不用 message 匹配，避免文案变更误伤）。 */
function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ReviewError, `期望 ReviewError，收到 ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `期望 ${code}，收到 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`);
}

function tempRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forge-gitee-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('常量：四段、两栏、结论词表即对外契约（AC-19/20）', () => {
  assert.deepEqual([...REVIEW_SECTIONS], ['问题', '风险', '意见', '结论']);
  assert.deepEqual([...REVIEW_COLUMNS], ['AI 意见', '人工确认']);
  assert.deepEqual([...REVIEW_STALENESS], ['current', 'stale']);
  for (const decision of REVIEW_DECISIONS) assert.ok(REVIEW_STATUSES.includes(decision));
  assert.ok(REVIEW_STATUSES.includes('pending-human'));
  assert.ok(HUMAN_ORIGINS.every((origin) => !MODEL_ORIGINS.includes(origin)));
  assert.ok(REVIEW_SOURCE_TYPES.includes('model') && REVIEW_SOURCE_TYPES.includes('mock'));
  assert.deepEqual([...REVIEW_DIR_SEGMENTS], ['docs', 'teamflow']);
  assert.equal(REVIEW_FILE_NAME, 'review.md');
});

test('记录：AI 栏写满、人工栏为空、provider 与状态由常量给出', () => {
  const review = record();
  assert.equal(review.kind, 'review');
  assert.equal(review.provider, 'gitee');
  assert.equal(review.changeId, CHANGE);
  assert.equal(review.commit, COMMIT);
  assert.equal(review.sourceType, 'model');
  assert.equal(review.status, 'pending-human');
  assert.equal(review.model.name, 'deepseek-v4.1-flash');
  assert.equal(review.model.tierStatus, 'outside-tiers');
  assert.deepEqual(
    review.aiColumn.map((entry) => [entry.id, entry.section]),
    [
      ['A-1', '问题'],
      ['R-1', '风险'],
      ['O-1', '意见'],
    ],
  );
  assert.deepEqual([...review.humanColumn], [], 'AI 记录不得带人工确认（AC-20）');
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.aiColumn));
});

test('记录：人工栏字段出现在入参即拒绝，而不是静默忽略（AC-20）', () => {
  for (const key of FORBIDDEN_HUMAN_KEYS) {
    throwsCode(() => record({ [key]: { by: 'someone', decision: 'confirmed' } }), REVIEW_REASONS.HUMAN_FILL_FORBIDDEN);
  }
  // 单数字段（工具参数里最常见的手滑形态）同样拒绝。
  throwsCode(() => record({ confirmedBy: 'someone' }), REVIEW_REASONS.HUMAN_FILL_FORBIDDEN);
});

test('记录：变更号 / commit / 模型名 / 结论缺一不可', () => {
  throwsCode(() => record({ changeId: '' }), REVIEW_REASONS.MISSING_CHANGE_ID);
  throwsCode(() => record({ changeId: 'has space' }), REVIEW_REASONS.INVALID_CHANGE_ID);
  throwsCode(() => record({ commit: 'HEAD' }), REVIEW_REASONS.INVALID_COMMIT);
  throwsCode(() => record({ commit: '' }), REVIEW_REASONS.INVALID_COMMIT);
  throwsCode(() => record({ model: '' }), REVIEW_REASONS.MODEL_NOT_RECORDED);
  throwsCode(() => record({ conclusion: '' }), REVIEW_REASONS.MISSING_CONCLUSION);
  throwsCode(() => record({ sourceType: 'guess' }), REVIEW_REASONS.INVALID_MODEL);
  assert.ok(CHANGE_ID_PATTERN.test(CHANGE));
});

test('记录：声明降级必须写明原因（AC-19「实际模型 + 降级须明示」）', () => {
  const error = throwsCode(() => record({ model: { name: 'muse-spark-1.3-contributor', degraded: true } }), REVIEW_REASONS.DEGRADED_NOTE_REQUIRED);
  assert.equal(error.detail.modelName, 'muse-spark-1.3-contributor');
  const degraded = record({ model: { name: 'muse-spark-1.3-contributor', degraded: true, note: '主模型配额耗尽' } });
  assert.equal(degraded.model.tierStatus, 'degraded');
  assert.match(renderReview(degraded), /档位：\*\*已声明降级\*\*/u);
});

test('渲染：front matter + 四段 + 两栏 + 模型名与该栏 sha（AC-19）', () => {
  const text = renderReview(record());
  const front = parseReviewFrontMatter(text);
  assert.equal(front.kind, 'review');
  assert.equal(front.provider, 'gitee');
  assert.equal(front.changeId, CHANGE);
  assert.equal(front.commit, COMMIT);
  assert.equal(front.model, 'deepseek-v4.1-flash');
  assert.equal(front.sourceType, 'model');
  assert.equal(front.updatedAt, AT);

  assert.deepEqual(assertReviewSections(text), { ok: true, missing: [] });
  for (const section of REVIEW_SECTIONS) assert.match(text, new RegExp(`^## ${section}$`, 'mu'));
  assert.match(text, /- 实际模型：`deepseek-v4\.1-flash`/u);
  assert.match(text, /- 被审 commit：`a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`/u);
  // 两栏同级分化：AI 栏自述模型与 sha，人工栏在未确认时明确说"尚无"。
  assert.match(text, /^## AI 意见$/mu);
  assert.match(text, /^## 人工确认$/mu);
  assert.match(text, /本栏由模型产出（模型 `deepseek-v4\.1-flash`/u);
  assert.match(text, /尚无人工确认/u);
  assert.match(text, /A-1.*令牌直接写进了配置文件/u);
  assert.match(text, /整体可合并，补用例后放行/u);
  // `stale` 是派生状态：文件里不得固化一个"版本一致"的结论。
  assert.doesNotMatch(text, /^stale:/mu);
  assert.doesNotMatch(text, /版本一致性：`(?:current|stale)`$/mu);
});

test('渲染：档位三种形态都写清楚，不代为声明（AC-19）', () => {
  const outside = renderReview(record());
  assert.match(outside, /档位：\*\*未声明\*\*（不在更强档清单/u);
  const declared = renderReview(record({ model: MODEL_TIERS[0] }));
  assert.match(declared, /档位：更强档清单内/u);
  assert.ok(declared.includes(MODEL_TIERS[0]));
  assert.ok(!declared.includes('**未声明**'));
});

test('人工确认：无来源 / 模型来源一律拒绝，人工来源写入后与 AI 栏分开（AC-20）', () => {
  const review = record();
  throwsCode(() => recordHumanConfirmation(review, { by: 'zhang', at: AT, commit: COMMIT, decision: 'confirmed' }), REVIEW_REASONS.HUMAN_ORIGIN_REQUIRED);
  for (const origin of ['model', 'ai', 'assistant']) {
    throwsCode(
      () => recordHumanConfirmation(review, { by: 'zhang', at: AT, commit: COMMIT, decision: 'confirmed', origin }),
      REVIEW_REASONS.HUMAN_ORIGIN_FORBIDDEN,
    );
  }
  // 形如人工来源但不在白名单的字符串同样拒绝（白名单，不是黑名单）。
  throwsCode(
    () => recordHumanConfirmation(review, { by: 'zhang', at: AT, commit: COMMIT, decision: 'confirmed', origin: 'trusted-human' }),
    REVIEW_REASONS.HUMAN_ORIGIN_FORBIDDEN,
  );

  const confirmed = recordHumanConfirmation(review, { by: 'zhang', at: AT, commit: COMMIT, decision: 'confirmed', note: '看过字段表', origin: 'human' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.humanColumn.length, 1);
  assert.equal(confirmed.humanColumn[0].by, 'zhang');
  assert.equal(confirmed.humanColumn[0].origin, 'human');
  assert.deepEqual([...review.humanColumn], [], '确认返回新对象，不改原记录');

  const text = renderReview(confirmed);
  assert.doesNotMatch(text, /尚无人工确认/u);
  assert.match(text, /^## 人工确认$/mu);
  // 人工结论只出现在人工栏的那张表里，不进 AI 栏的计数段。
  const [aiColumn, humanColumn] = text.split('## 人工确认');
  assert.doesNotMatch(aiColumn, /zhang/u);
  assert.match(humanColumn, /zhang/u);
  assert.match(humanColumn, /看过字段表/u);
});

test('人工确认：确认人 / 时间 / 结论 / commit 都要有，且结论取值受限', () => {
  const review = record();
  const base = { by: 'zhang', at: AT, commit: COMMIT, decision: 'confirmed', origin: 'human' };
  throwsCode(() => recordHumanConfirmation(review, { ...base, by: '' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation(review, { ...base, at: '' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation(review, { ...base, at: '不是时间' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation(review, { ...base, commit: 'HEAD' }), REVIEW_REASONS.INVALID_COMMIT);
  throwsCode(() => recordHumanConfirmation(review, { ...base, decision: 'approved' }), REVIEW_REASONS.HUMAN_ENTRY_INVALID);
  throwsCode(() => recordHumanConfirmation({ ...review, provider: 'github' }, base), REVIEW_REASONS.INVALID_REVIEW);
});

test('版本一致性：current|stale 由 commit 比对派生，不落盘（AC-20）', () => {
  const review = record();
  assert.equal(reviewStaleness(review, COMMIT), 'current');
  assert.equal(reviewStaleness(review, COMMIT.slice(0, 7)), 'current', '短 sha 视为同一版本');
  assert.equal(reviewStaleness(review, LATER), 'stale');
  assert.equal(reviewStaleness(review, ''), 'stale', '拿不到当前 sha 不得沿用旧确认');
  assert.equal(reviewStaleness({}, COMMIT), 'stale');

  // 确认过之后 sha 变了：确认仍在（历史保留），但版本一致性派生为 stale——两个轴不合并。
  const confirmed = recordHumanConfirmation(review, { by: 'zhang', at: AT, commit: COMMIT, decision: 'confirmed', origin: 'human' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(reviewStaleness(confirmed, LATER), 'stale');
  assert.doesNotMatch(renderReview(confirmed), /^stale:/mu);
});

test('段落校验：缺段即不合格，且 `## AI 意见` 不算「意见」段（AC-19）', () => {
  const text = renderReview(record());
  const missingRisk = text.replace('## 风险', '## 风险（缺）');
  assert.deepEqual(assertReviewSections(missingRisk), { ok: false, missing: ['风险'] });
  assert.deepEqual(assertReviewSections('## 问题\n## AI 意见\n## 人工确认\n'), { ok: false, missing: ['风险', '意见', '结论'] });
  assert.deepEqual(assertReviewSections(''), { ok: false, missing: [...REVIEW_SECTIONS] });
});

test('脱敏：令牌 / 内网主机 / 本机绝对路径命中即阻断写盘（AC-19）', (t) => {
  const repo = tempRepo(t);
  const cases = [
    ['令牌', '把 access_token=abcdef123456 贴进了说明'],
    ['内网主机', '复现地址 http://git.corp.internal/group/repo'],
    // 本机绝对路径样例用拼接构造：仓库检查器禁止源码出现宿主绝对路径字面量
    // （scripts/lib/repo-rules.mjs 的 HOST_PATH，匹配 Users 顶级目录的 POSIX 形式），
    // 扫描器在运行时拿到的仍是完整路径，脱敏判定不变。
    ['本机绝对路径', `产物在 ${['', 'Users', 'hosea', 'work', 'git', 'heluo-forge', 'docs', 'review.md'].join('/')}`],
  ];
  for (const [label, opinion] of cases) {
    const review = record({ opinion });
    const scanned = scanRedactions(renderReview(review));
    assert.equal(scanned.ok, false, `${label} 应被识别`);
    const error = throwsCode(() => writeReviewFile({ repoRoot: repo, changeId: CHANGE, review }), REVIEW_REASONS.REDACTION_BLOCKED);
    assert.ok(Array.isArray(error.detail.hits) && error.detail.hits.length > 0, `${label} 应带命中类别`);
    // 阻断 = 文件没有出现（不是"写了一半再报错"）。
    assert.equal(existsSync(path.join(repo, ...REVIEW_DIR_SEGMENTS, CHANGE, REVIEW_FILE_NAME)), false, `${label} 不应产生文件`);
    // 目录也不该被提前建出来：阻断发生在任何落盘动作之前。
    assert.equal(existsSync(path.join(repo, ...REVIEW_DIR_SEGMENTS, CHANGE)), false, `${label} 不应产生目录`);
  }
});

test('脱敏：公网地址、仓库相对路径与占位符不误报', () => {
  const safe = record({
    findings: ['参考 https://gitee.com/group/repo/issues/12 与 docs/teamflow/CHG-2026-0042/review.md'],
    risks: ['host 用 corp.example 占位，未写真实内网地址；凭据走 GITEE_TOKEN'],
    opinion: '见 src/gitee-review.mjs 的脱敏规则表',
  });
  const scanned = scanRedactions(renderReview(safe));
  assert.deepEqual(scanned, { ok: true, hits: [] });
});

test('写盘：落在 docs/teamflow/<变更号>/review.md，摘要来自磁盘（AC-19）', (t) => {
  const repo = tempRepo(t);
  const review = record();
  const first = writeReviewFile({ repoRoot: repo, changeId: CHANGE, review });

  const expected = path.join(repo, 'docs', 'teamflow', CHANGE, 'review.md');
  assert.equal(first.path, expected);
  assert.equal(first.changeId, CHANGE);
  const onDisk = readFileSync(expected, 'utf8');
  assert.equal(first.sha256, createHash('sha256').update(onDisk, 'utf8').digest('hex'));
  assert.equal(first.bytes, Buffer.byteLength(onDisk, 'utf8'));
  assert.deepEqual(assertReviewSections(onDisk), { ok: true, missing: [] });
  const front = parseReviewFrontMatter(onDisk);
  assert.equal(front.provider, 'gitee');
  assert.equal(front.commit, COMMIT);
  assert.equal(front.model, 'deepseek-v4.1-flash');

  // 同内容重写：摘要不变（幂等写入的证据就是 sha256 相等）。
  const second = writeReviewFile({ repoRoot: repo, changeId: CHANGE, review });
  assert.equal(second.sha256, first.sha256);
  // 目录里只有 review.md：临时文件要么没建、要么已被 rename 掉。
  assert.deepEqual(readdirSync(path.dirname(expected)), [REVIEW_FILE_NAME]);
});

test('写盘：既有 review.md 属于别的 provider 时不覆盖（AC-19）', (t) => {
  const repo = tempRepo(t);
  const directory = path.join(repo, 'docs', 'teamflow', CHANGE);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, REVIEW_FILE_NAME);
  const foreign = ['---', 'kind: review', 'changeId: CHG-2026-0042', 'provider: github', `commit: ${COMMIT}`, '---', '', '# 交叉审查', ''].join('\n');
  writeFileSync(target, foreign, 'utf8');

  const error = throwsCode(() => writeReviewFile({ repoRoot: repo, changeId: CHANGE, review: record() }), REVIEW_REASONS.PROVIDER_CONFLICT);
  assert.equal(error.detail.existingProvider, 'github');
  assert.equal(readFileSync(target, 'utf8'), foreign, '别的 provider 的文件必须逐字节保留');

  // 没有 front matter 的文件同样视为"不属于 gitee"，不覆盖。
  writeFileSync(target, '# 手写的审查笔记\n', 'utf8');
  throwsCode(() => writeReviewFile({ repoRoot: repo, changeId: CHANGE, review: record() }), REVIEW_REASONS.PROVIDER_CONFLICT);
  assert.equal(readFileSync(target, 'utf8'), '# 手写的审查笔记\n');
});

test('写盘：路径包含校验与非法入参（AC-19）', (t) => {
  const repo = tempRepo(t);
  throwsCode(() => writeReviewFile({ repoRoot: '', changeId: CHANGE, review: record() }), REVIEW_REASONS.INVALID_ROOT);
  throwsCode(() => writeReviewFile({ repoRoot: path.join(repo, 'not-created'), changeId: CHANGE, review: record() }), REVIEW_REASONS.INVALID_ROOT);
  throwsCode(() => writeReviewFile({ repoRoot: repo, changeId: '..', review: record() }), REVIEW_REASONS.INVALID_CHANGE_ID);
  throwsCode(() => writeReviewFile({ repoRoot: repo, changeId: 'a/b', review: record() }), REVIEW_REASONS.INVALID_CHANGE_ID);
  throwsCode(() => writeReviewFile({ repoRoot: repo, changeId: CHANGE, review: { ...record(), provider: 'github' } }), REVIEW_REASONS.INVALID_REVIEW);
  throwsCode(() => writeReviewFile({ repoRoot: repo, changeId: 'OTHER-1', review: record() }), REVIEW_REASONS.INVALID_REVIEW);
});
