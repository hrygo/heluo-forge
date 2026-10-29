/**
 * TK6 交付判定（AC-18 / AC-21）：提交信息前缀校验 + 关闭条件四项只判不执行。
 *
 * 这些用例守的是"门禁静默失效"这一类错误：
 * 1. **不合规必须抛**——`assertCommitMessage` 只返回 `{ok:false}` 时，动作层的 `try/catch` 会把
 *    违规当通过（没人会去看返回值），所以用例断言的是 `throws`，并且断言异常上带着
 *    `reason` 与 `expectedFormat`（给人照着改的那句话）。
 * 2. **`unknown` 不计入通过**——CI/UAT 取不到证据时的正常形态是 `unknown`，整体状态必须是
 *    `unknown` 而不是 `ready`；把"没证据"当"通过"是这里最贵的错误。
 * 3. **只判定不执行**——`executed` 恒为 `false`，且命令白名单里根本没有 `close`/`merge`；
 *    白名单断言读的是真实的 `GITEE_COMMANDS`，不是用例自己编的清单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOSE_EXPECTATIONS,
  CLOSE_ITEMS,
  CLOSE_NOTE,
  CLOSE_REASONS,
  CLOSE_SOURCE_TYPES,
  CLOSE_STATUSES,
  CLOSE_STATUS_VALUES,
  COMMIT_REASONS,
  CommitMessageError,
  DeliveryError,
  assertCommitMessage,
  expectedCommitFormat,
  judgeCloseReadiness,
  verifyCommitMessage,
} from '../src/gitee-delivery.mjs';
import { GITEE_COMMANDS } from '../src/gitee-adapter.mjs';
import { buildReviewRecord, recordHumanConfirmation } from '../src/gitee-review.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');
const CHANGE = 'CHG-2026-0042';
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OLD = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const AT = '2026-10-29T10:00:00.000Z';

function commitError(fn, reason) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CommitMessageError, `期望 CommitMessageError，收到 ${error?.name}`);
    assert.ok(error instanceof DeliveryError, 'CommitMessageError 是 DeliveryError 的子类（调用方按一种错误处理）');
    assert.equal(error.reason, reason, `期望 ${reason}，收到 ${error.reason}（${error.message}）`);
    assert.equal(error.code, reason);
    assert.equal(error.ok, false);
    // 期望格式必须是"能照着改"的那一句；没有变更号时给出占位形态。
    assert.ok(
      typeof error.expectedFormat === 'string' && /^\[.+\] 一句话说明$/u.test(error.expectedFormat),
      `异常要带期望格式，收到 ${error.expectedFormat}`,
    );
    return error;
  }
  assert.fail(`期望抛出 ${reason}，但没有抛错`);
}

function deliveryError(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DeliveryError, `期望 DeliveryError，收到 ${error?.name}`);
    assert.equal(error.code, code, `期望 ${code}，收到 ${error.code}`);
    return error;
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`);
}

const item = (result, name) => result.items.find((entry) => entry.item === name);
const byName = (result) => Object.fromEntries(result.items.map((entry) => [entry.item, entry.status]));

/** 一份"四项都能判"的基础条件；各用例只覆盖自己关心的那一项。 */
function criteria(overrides = {}) {
  return {
    acceptance: { status: 'passed', evidence: '验收通过（UAT 2026-10-29）', sourceType: 'uat' },
    merged: { status: 'passed', evidence: 'PR !42 已合入' },
    pendingDelivery: { count: 0 },
    humanConfirmed: { decision: 'confirmed', commit: COMMIT },
    ...overrides,
  };
}

test('常量：四项条件、三态、来源类型与边界说明（AC-21）', () => {
  assert.deepEqual([...CLOSE_ITEMS], ['acceptance', 'merged', 'pendingDelivery', 'humanConfirmed']);
  assert.deepEqual(Object.keys(CLOSE_EXPECTATIONS).sort(), [...CLOSE_ITEMS].sort());
  assert.deepEqual([...CLOSE_STATUSES], ['passed', 'failed', 'unknown']);
  assert.deepEqual([...CLOSE_STATUS_VALUES], ['ready', 'blocked', 'unknown']);
  assert.ok(CLOSE_SOURCE_TYPES.includes('uat') && CLOSE_SOURCE_TYPES.includes('human'));
  assert.ok(CLOSE_SOURCE_TYPES.every((source) => typeof source === 'string' && source !== ''));
  assert.match(CLOSE_NOTE, /不执行|需人工/u);
  assert.match(CLOSE_NOTE, /close/u);
  assert.match(CLOSE_NOTE, /merge/u);
  assert.ok(Object.values(CLOSE_REASONS).every((reason) => /^CLOSE_|^CRITERION_|^PENDING_|^HUMAN_|^STALE_/u.test(reason)));
});

test('提交信息：期望格式给的是可照抄的一句话，不是抽象规则（AC-18）', () => {
  assert.equal(expectedCommitFormat(CHANGE), '[CHG-2026-0042] 一句话说明');
  assert.equal(expectedCommitFormat(''), '[<变更号>] 一句话说明');
});

test('提交信息：合规写法全部放行，且不改写 message（AC-18）', () => {
  const accepted = [
    `[${CHANGE}] 补齐关闭判定`,
    `[${CHANGE}]\t制表符分隔也接受`,
    `[${CHANGE}] 一句话\n\n正文多行不校验`,
    `[${CHANGE}] 全角空格分隔也接受`,
    `[chg-2026-0042] 大小写不敏感`,
    `\n\n[${CHANGE}] 首部空行被剥掉`,
  ];
  for (const message of accepted) {
    const result = assertCommitMessage({ changeId: CHANGE, message });
    assert.equal(result.ok, true, message);
    assert.equal(result.changeId, CHANGE);
    assert.equal(result.expectedFormat, `[${CHANGE}] 一句话说明`);
    assert.equal(typeof result.subject, 'string');
    assert.ok(result.subject.length > 0);
    assert.equal('message' in result, false, '返回值里没有改写后的提交信息');
  }
});

test('提交信息：不合规一律抛错并带 reason + 期望格式（AC-18）', () => {
  commitError(() => assertCommitMessage({ changeId: '', message: `[${CHANGE}] x` }), COMMIT_REASONS.MISSING_CHANGE_ID);
  commitError(() => assertCommitMessage({ changeId: 'has space', message: `[${CHANGE}] x` }), COMMIT_REASONS.INVALID_CHANGE_ID);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: '' }), COMMIT_REASONS.MISSING_MESSAGE);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: '   \n\t ' }), COMMIT_REASONS.MISSING_MESSAGE);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: undefined }), COMMIT_REASONS.MISSING_MESSAGE);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: '补齐关闭判定' }), COMMIT_REASONS.PREFIX_MISSING);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: `[${CHANGE}]` }), COMMIT_REASONS.DESCRIPTION_MISSING);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: `[${CHANGE}]    ` }), COMMIT_REASONS.DESCRIPTION_MISSING);
  // 方括号里写别的变更号 / 带空白：都按"前缀不对"拒，不猜意图。
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: '[CHG-2026-0041] 别的需求' }), COMMIT_REASONS.PREFIX_MISSING);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: `[ ${CHANGE} ] 空白` }), COMMIT_REASONS.PREFIX_MISSING);
  commitError(() => assertCommitMessage({ changeId: CHANGE, message: '[] 空方括号' }), COMMIT_REASONS.PREFIX_MISSING);
  // `change` 是 `changeId` 的别名（调用点用词不同，不是第二个概念）。
  commitError(() => assertCommitMessage({ change: CHANGE, message: 'no prefix' }), COMMIT_REASONS.PREFIX_MISSING);
  assert.equal(assertCommitMessage({ change: CHANGE, message: `[${CHANGE}] 别名` }).ok, true);
});

test('提交信息：`verifyCommitMessage` 对象形态与抛错形态结论一致', () => {
  const ok = verifyCommitMessage({ changeId: CHANGE, message: `[${CHANGE}] 描述` });
  assert.deepEqual({ ok: ok.ok, changeId: ok.changeId }, { ok: true, changeId: CHANGE });
  const bad = verifyCommitMessage({ changeId: CHANGE, message: 'no prefix' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, COMMIT_REASONS.PREFIX_MISSING);
  assert.equal(bad.expectedFormat, `[${CHANGE}] 一句话说明`);
});

test('关闭判定：四项全部 passed 才 ready，且 executed 恒为 false（AC-21）', () => {
  const result = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: criteria(), at: AT });
  assert.equal(result.kind, 'close-readiness');
  assert.equal(result.provider, 'gitee');
  assert.equal(result.changeId, CHANGE);
  assert.equal(result.commit, COMMIT);
  assert.equal(result.status, 'ready');
  assert.equal(result.ready, true);
  assert.deepEqual([...result.blocking], []);
  assert.deepEqual([...result.unknown], []);
  assert.equal(result.executed, false, '只判定：没有执行通道');
  assert.equal(result.note, CLOSE_NOTE);
  assert.equal(result.judgedAt, AT);
  for (const entry of result.items) {
    assert.equal(entry.key, entry.item, 'item 与 key 是同一标识');
    assert.ok(entry.status === 'passed' || entry.status === 'failed' || entry.status === 'unknown');
    assert.ok(entry.evidence.length > 0, `${entry.item} 必须带证据文字`);
    assert.ok(CLOSE_SOURCE_TYPES.includes(entry.sourceType), `${entry.item} 的来源类型不在词表里：${entry.sourceType}`);
  }
  // 声明了来源就用声明的来源（报告要能区分 UAT 与调用方自述）。
  assert.equal(item(result, 'acceptance').sourceType, 'uat');
  assert.equal(item(result, 'merged').sourceType, 'caller-declared');
});

test('关闭判定：任一项 failed 即 blocked，并指出是哪一项（AC-21）', () => {
  const result = judgeCloseReadiness({ changeId: CHANGE, criteria: criteria({ merged: { status: 'failed', evidence: 'PR 未合入' } }) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.ready, false);
  assert.deepEqual([...result.blocking], ['merged']);
  assert.equal(item(result, 'merged').reason, CLOSE_REASONS.CRITERION_NOT_PASSED);
});

test('关闭判定：证据取不到是 unknown，不是 blocked，更不是 passed（AC-21）', () => {
  const result = judgeCloseReadiness({ criteria: { acceptance: 'unknown', merged: undefined, humanConfirmed: { decision: 'unknown' } } });
  assert.equal(result.status, 'unknown');
  assert.equal(result.ready, false);
  assert.deepEqual([...result.blocking], []);
  assert.deepEqual([...result.unknown], ['acceptance', 'merged', 'pendingDelivery', 'humanConfirmed']);
  for (const entry of result.items) {
    assert.equal(entry.status, 'unknown');
    assert.equal(entry.reason, CLOSE_REASONS.EVIDENCE_UNAVAILABLE);
  }
  // 完全不传条件：四项都是 unknown（判定器不替调用方编证据）。
  assert.equal(judgeCloseReadiness({}).status, 'unknown');
});

test('关闭判定：pendingDelivery 极性——有未完成交付才是不通过（AC-21）', () => {
  const none = judgeCloseReadiness({ criteria: criteria({ pendingDelivery: { count: 0 } }) });
  assert.equal(item(none, 'pendingDelivery').status, 'passed');
  const some = judgeCloseReadiness({ criteria: criteria({ pendingDelivery: { count: 2 } }) });
  assert.equal(item(some, 'pendingDelivery').status, 'failed');
  assert.equal(item(some, 'pendingDelivery').reason, CLOSE_REASONS.PENDING_DELIVERY);
  const listed = judgeCloseReadiness({ criteria: criteria({ pendingDelivery: ['#31 未合入', '#35 待评审'] }) });
  assert.equal(item(listed, 'pendingDelivery').status, 'failed');
  assert.match(item(listed, 'pendingDelivery').evidence, /2 项/u);
  // 布尔 true = 还有未完成交付 → 不通过（与其余三项极性相反）。
  const flag = judgeCloseReadiness({ criteria: criteria({ pendingDelivery: true }) });
  assert.equal(item(flag, 'pendingDelivery').status, 'failed');
  // 认不出的写法一律 unknown，不猜。
  const bogus = judgeCloseReadiness({ criteria: criteria({ pendingDelivery: { mystery: 1 } }) });
  assert.equal(item(bogus, 'pendingDelivery').status, 'unknown');
});

test('关闭判定：人工确认必须绑定当前 sha，旧 sha 一律 stale（AC-20/AC-21）', () => {
  const passed = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: criteria({ humanConfirmed: { decision: 'confirmed', commit: COMMIT } }) });
  assert.equal(item(passed, 'humanConfirmed').status, 'passed');
  assert.equal(item(passed, 'humanConfirmed').sourceType, 'human');

  // 短 sha 视为同一版本。
  const short = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: criteria({ humanConfirmed: { decision: 'confirmed', commit: COMMIT.slice(0, 7) } }) });
  assert.equal(item(short, 'humanConfirmed').status, 'passed');

  const stale = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: criteria({ humanConfirmed: { decision: 'confirmed', commit: OLD } }) });
  assert.equal(item(stale, 'humanConfirmed').status, 'failed');
  assert.equal(item(stale, 'humanConfirmed').reason, CLOSE_REASONS.STALE_CONFIRMATION);
  assert.equal(stale.status, 'blocked');

  // 知道当前 commit 却没绑定 sha：无法证明确认不是旧版本 → unknown（不是通过）。
  const unbound = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: criteria({ humanConfirmed: { decision: 'confirmed' } }) });
  assert.equal(item(unbound, 'humanConfirmed').status, 'unknown');

  // 布尔声明在不知道当前 commit 时收下，知道当前 commit 时降为 unknown。
  assert.equal(item(judgeCloseReadiness({ criteria: criteria({ humanConfirmed: true }) }), 'humanConfirmed').status, 'passed');
  assert.equal(item(judgeCloseReadiness({ commit: COMMIT, criteria: criteria({ humanConfirmed: true }) }), 'humanConfirmed').status, 'unknown');

  // 不是确认的结论一律不通过；显式 stale 同样不通过。
  for (const decision of ['changes-requested', 'rejected']) {
    const rejected = judgeCloseReadiness({ criteria: criteria({ humanConfirmed: { decision } }) });
    assert.equal(item(rejected, 'humanConfirmed').status, 'failed');
    assert.equal(item(rejected, 'humanConfirmed').reason, CLOSE_REASONS.HUMAN_CONFIRMATION_REQUIRED);
  }
  const marked = judgeCloseReadiness({ criteria: criteria({ humanConfirmed: { stale: true } }) });
  assert.equal(item(marked, 'humanConfirmed').reason, CLOSE_REASONS.STALE_CONFIRMATION);
});

test('关闭判定：人工确认也可以直接取 review.md 的人工栏（AC-20/AC-21）', () => {
  const review = buildReviewRecord({
    changeId: CHANGE,
    commit: COMMIT,
    model: 'deepseek-v4.1-flash',
    conclusion: '可合并',
    at: AT,
  });
  const base = { acceptance: { status: 'passed' }, merged: { status: 'passed' }, pendingDelivery: { count: 0 } };

  // 还没人确认：不通过（不是 unknown——"没人确认"是可确定的事实）。
  const pending = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: base, review });
  assert.equal(item(pending, 'humanConfirmed').status, 'failed');
  assert.equal(item(pending, 'humanConfirmed').reason, CLOSE_REASONS.HUMAN_CONFIRMATION_REQUIRED);

  // 确认绑在当前 sha 上：通过，来源标 human。
  const confirmed = recordHumanConfirmation(review, { by: 'zhang', at: AT, commit: COMMIT, decision: 'confirmed', origin: 'human' });
  const current = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: base, review: confirmed });
  assert.equal(item(current, 'humanConfirmed').status, 'passed');
  assert.equal(item(current, 'humanConfirmed').sourceType, 'human');

  // 确认之后又提了新 commit：派生 stale → 不通过（不是把旧确认当通过）。
  const stale = judgeCloseReadiness({ changeId: CHANGE, commit: OLD, criteria: base, review: confirmed });
  assert.equal(item(stale, 'humanConfirmed').status, 'failed');
  assert.equal(item(stale, 'humanConfirmed').reason, CLOSE_REASONS.STALE_CONFIRMATION);

  // 显式条件优先于 review 记录。
  const explicit = judgeCloseReadiness({
    changeId: CHANGE,
    commit: COMMIT,
    criteria: { ...base, humanConfirmed: { decision: 'changes-requested' } },
    review: confirmed,
  });
  assert.equal(item(explicit, 'humanConfirmed').status, 'failed');
});

test('关闭判定：入参校验与确定性（只判不执行，无副作用）', () => {
  deliveryError(() => judgeCloseReadiness({ changeId: 'has space', criteria: criteria() }), CLOSE_REASONS.INVALID_CHANGE_ID);
  deliveryError(() => judgeCloseReadiness({ changeId: CHANGE, commit: 'HEAD', criteria: criteria() }), CLOSE_REASONS.INVALID_COMMIT);
  // 变更号可选：只问"还差什么"时不该因为没给号而崩。
  const anonymous = judgeCloseReadiness({ criteria: criteria() });
  assert.equal(anonymous.changeId, null);
  assert.equal(anonymous.status, 'ready');

  const first = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: criteria(), at: AT });
  const second = judgeCloseReadiness({ changeId: CHANGE, commit: COMMIT, criteria: criteria(), at: AT });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)), '同一输入两次判定结果一致');
});

test('白名单：真实命令面里没有 close / merge / release / workflow（AC-21）', () => {
  const commands = Object.values(GITEE_COMMANDS).map((argv) => argv.join(' '));
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.doesNotMatch(command, /\b(close|merge|release|workflow)\b/u, `命令白名单出现了关闭/合并类动作：${command}`);
  }
  // 静态门禁：代码里（注释之外）不出现这些子命令的字符串形态——防止"表里没有、别处拼出来"。
  // 注释里点名禁项不算违规：声明"这些不做"正是本需求的交付内容之一。
  const codeOnly = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/u.test(line))
      .join('\n');
  const sources = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => [name, codeOnly(readFileSync(path.join(SRC_DIR, name), 'utf8'))]);
  for (const [name, source] of sources) {
    for (const forbidden of ['issue close', 'pr merge', 'pr close', 'release create', 'workflow run', 'change done']) {
      assert.equal(source.toLowerCase().includes(forbidden), false, `${name} 的代码里出现禁项：${forbidden}`);
    }
  }
});
