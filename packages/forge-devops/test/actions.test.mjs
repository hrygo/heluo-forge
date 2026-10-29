/**
 * actions：平台动作的四状态、幂等与回读（设计 §5.4 / §7.1 / §7.3 / §7.7，AC-16 / AC-19）。
 *
 * 逐条覆盖 AC-16 的判据：
 * - 四状态各走一遍（`done` / `failed` / `denied` / `unknown`），且**不混入**流程态；
 * - 幂等键 = 变更号 + 对象类型 + 归一化标题的哈希；
 * - 创建前查 open 对象、命中即复用（`reused:true`）；
 * - 回读不一致 → `unknown`，且**不再调一次创建**（不自动重放）；
 * - 拒绝路径（门禁拒绝 / 确认缺失 / 承建未定 / 参数非法）**适配器零调用**；
 * - 写动作向门禁声明 `egress:'platform-write'`（走确认通道）。
 *
 * AC-19：澄清的 dop 通道恒 `denied/COMMAND_NOT_WHITELISTED`，且一次都不访问 dop 适配器。
 * 全部用例注入假 gh/假门禁，不 spawn 真实 `gh`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_REASONS,
  ACTION_STATUSES,
  EGRESS_PLATFORM_WRITE,
  commentIssueIdempotent,
  commentPrIdempotent,
  createIssueIdempotent,
  createPrIdempotent,
  idempotencyKey,
  normalizeTitle,
  writeClarification,
} from '../src/actions.mjs';
import { FLOW_ACTIONS } from '../src/tools.mjs';

const REPO = 'acme/demo';
const CHANGE = 'ARD123456';
const CONFIRM = Object.freeze({ repo: REPO, object: REPO });

/**
 * 假 gh 适配器：默认"平台是空的、创建成功、回读一致"，每个用例只改需要的那一两个方法。
 * 每次调用都记账，用来断言"拒绝路径零调用"。
 */
function fakeGh(overrides = {}) {
  const calls = [];
  const defaults = {
    listOpenIssues: async () => ({ status: 'succeeded', items: [] }),
    listOpenPrs: async () => ({ status: 'succeeded', items: [] }),
    readIssue: async () => ({
      status: 'succeeded',
      object: { number: 7, title: 'Fix gate', state: 'OPEN', url: `https://gh.test/${REPO}/issues/7`, comments: [] },
    }),
    readPr: async () => ({
      status: 'succeeded',
      object: {
        number: 9,
        title: 'Fix gate',
        state: 'OPEN',
        url: `https://gh.test/${REPO}/pull/9`,
        headRefName: 'feat/gate',
        baseRefName: 'main',
        comments: [],
      },
    }),
    createIssue: async () => ({ status: 'succeeded', number: 7, url: `https://gh.test/${REPO}/issues/7` }),
    createPr: async () => ({ status: 'succeeded', number: 9, url: `https://gh.test/${REPO}/pull/9` }),
    commentIssue: async () => ({ status: 'succeeded', url: `https://gh.test/${REPO}/issues/7#issuecomment-1`, comment_id: '1' }),
    commentPr: async () => ({ status: 'succeeded', url: `https://gh.test/${REPO}/pull/9#issuecomment-2`, comment_id: '2' }),
  };
  const gh = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    gh[name] = async (args) => {
      calls.push({ name, args });
      const override = overrides[name];
      if (typeof override === 'function') return override(args);
      if (override !== undefined) return override;
      return fallback(args);
    };
  }
  gh.calls = calls;
  gh.count = (name) => calls.filter((entry) => entry.name === name).length;
  return gh;
}

/** 放行门禁：记录入参后原样执行下游。 */
function allowGuard() {
  const seen = [];
  return {
    seen,
    execute: async (input, operation) => {
      seen.push(input);
      return {
        status: 'done',
        action: input.action,
        target: input.target,
        reason: null,
        rule: null,
        detail: null,
        mayHaveSideEffect: false,
        value: await operation(),
      };
    },
  };
}

/** 拒绝门禁：**不执行下游**（与真实门禁拒绝时的行为一致）。 */
function denyGuard(reason = 'POLICY_ACTION_UNREGISTERED', rule = 'unregistered-action') {
  const seen = [];
  return {
    seen,
    execute: async (input) => {
      seen.push(input);
      return {
        status: 'denied',
        action: input.action,
        target: input.target,
        reason,
        rule,
        detail: `动作 ${input.action} 未在策略目录登记`,
        mayHaveSideEffect: false,
      };
    },
  };
}

/** 造一个适配器异常（带 `gh-adapter` 的 detail 形状）。 */
function ghError(code, detail = {}) {
  const error = new Error(`gh ${code}`);
  error.code = code;
  error.detail = detail;
  return error;
}

test('ACTION_STATUSES 只有 done/failed/denied/unknown，且顺序固定', () => {
  assert.deepEqual(Array.from(ACTION_STATUSES), ['done', 'failed', 'denied', 'unknown']);
  for (const flowState of ['blocked', 'skipped', 'stale', 'pending', 'ready']) {
    assert.equal(ACTION_STATUSES.includes(flowState), false, `${flowState} 是流程态，不得混进平台动作词表`);
  }
  assert.equal(ACTION_REASONS.COMMAND_NOT_WHITELISTED, 'COMMAND_NOT_WHITELISTED');
  assert.equal(EGRESS_PLATFORM_WRITE, 'platform-write');
});

test('标题归一化：大小写、多余空白、尾部标点都归一，全角标点同样剥掉', () => {
  assert.equal(normalizeTitle(' Fix   Gate. '), 'fix gate');
  assert.equal(normalizeTitle('fix gate'), 'fix gate');
  assert.equal(normalizeTitle('修复门禁！'), '修复门禁');
  assert.equal(normalizeTitle('修复门禁。'), '修复门禁');
  assert.equal(normalizeTitle('   '), '');
  assert.equal(normalizeTitle(undefined), '');
});

test('幂等键：16 位十六进制，标题归一后相等，对象类型与变更号都参与区分', () => {
  const base = idempotencyKey({ change: CHANGE, objectType: 'issue', title: ' Fix   Gate. ' });
  assert.match(base, /^[0-9a-f]{16}$/u);
  assert.equal(base, idempotencyKey({ change: CHANGE, objectType: 'issue', title: 'fix gate' }));
  assert.notEqual(base, idempotencyKey({ change: CHANGE, objectType: 'pr', title: 'fix gate' }));
  assert.notEqual(base, idempotencyKey({ change: 'ARD999999', objectType: 'issue', title: 'fix gate' }));
  assert.notEqual(base, idempotencyKey({ change: CHANGE, objectType: 'issue', title: 'fix another gate' }));
});

test('幂等键：变更号大小写不敏感（同一个变更不能建出两个对象）', () => {
  assert.equal(
    idempotencyKey({ change: 'ARD123456', objectType: 'issue', title: 'fix gate' }),
    idempotencyKey({ change: 'ard123456', objectType: 'issue', title: 'fix gate' }),
  );
});

test('幂等键：缺参抛 TypeError（接线缺陷早暴露，不静默生成碰撞键）', () => {
  assert.throws(() => idempotencyKey({ objectType: 'issue', title: 'x' }), TypeError);
  assert.throws(() => idempotencyKey({ change: CHANGE, title: 'x' }), TypeError);
  assert.throws(() => idempotencyKey({ change: CHANGE, objectType: 'issue', title: '   ' }), TypeError);
});

test('建 Issue：目标不是 owner/name 时 denied，gh 零调用', async () => {
  const gh = fakeGh();
  const guard = allowGuard();
  const result = await createIssueIdempotent({
    guard,
    gh,
    changeId: CHANGE,
    repo: 'not-a-repo',
    title: 'Fix gate',
    body: '正文',
    confirm: { repo: 'not-a-repo', object: 'not-a-repo' },
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.MISSING_TARGET);
  assert.equal(result.calls, 0);
  assert.equal(gh.calls.length, 0);
  assert.equal(guard.seen.length, 0, '输入不成立时连门禁都不必问');
});

test('建 Issue：正文为空时 denied，不创建空 Issue', async () => {
  const gh = fakeGh();
  const result = await createIssueIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    repo: REPO,
    title: 'Fix gate',
    body: '   ',
    confirm: CONFIRM,
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.MISSING_ARGUMENT);
  assert.equal(gh.calls.length, 0);
});

test('建 Issue：缺 confirm 时 denied/CONFIRMATION_REQUIRED，gh 零调用', async () => {
  const gh = fakeGh();
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.CONFIRMATION_REQUIRED);
  assert.equal(result.calls, 0);
  assert.equal(gh.calls.length, 0);
});

test('建 Issue：confirm 与实际对象不一致时 denied，不做"自填已确认"', async () => {
  const gh = fakeGh();
  const result = await createIssueIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    repo: REPO,
    title: 'Fix gate',
    body: '正文',
    confirm: { repo: REPO, object: 'acme/other' },
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.CONFIRMATION_REQUIRED);
  assert.match(result.detail, /acme\/other/u);
  assert.equal(gh.calls.length, 0);
});

test('建 Issue：承建仓库未判定时 denied/BUILDING_NOT_RESOLVED，阻断全部写', async () => {
  const gh = fakeGh();
  const result = await createIssueIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    repo: REPO,
    title: 'Fix gate',
    body: '正文',
    confirm: CONFIRM,
    building: { status: 'blocked', selected: null, candidates: [{ repo: 'acme/a', evidence: 'sub_systems' }, { repo: 'acme/b', evidence: 'sub_systems' }], reasons: ['MULTIPLE_CANDIDATES'] },
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.BUILDING_NOT_RESOLVED);
  assert.match(result.detail, /acme\/a, acme\/b/u);
  assert.equal(gh.calls.length, 0);
});

test('建 Issue：门禁拒绝时 denied 且 gh 零调用', async () => {
  const gh = fakeGh();
  const guard = denyGuard();
  const result = await createIssueIdempotent({ guard, gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'POLICY_ACTION_UNREGISTERED');
  assert.equal(result.calls, 0);
  assert.equal(gh.calls.length, 0);
});

test('建 Issue：平台已有同名 open Issue 时复用，不重复创建', async () => {
  const gh = fakeGh({
    listOpenIssues: async () => ({
      status: 'succeeded',
      items: [{ number: 42, title: 'fix   GATE.', url: `https://gh.test/${REPO}/issues/42`, state: 'OPEN' }],
    }),
  });
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'done');
  assert.equal(result.reused, true);
  assert.equal(result.objectRef, `https://gh.test/${REPO}/issues/42`);
  assert.equal(gh.count('createIssue'), 0, '命中即复用，不得再建一个');
  assert.equal(result.key, idempotencyKey({ change: CHANGE, objectType: 'issue', title: 'Fix gate' }));
});

test('建 Issue：创建前查重失败时 failed，且不创建（不重放）', async () => {
  const gh = fakeGh({
    listOpenIssues: async () => {
      throw ghError('COMMAND_FAILED', { exitCode: 1, mayHaveSideEffect: false });
    },
  });
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, ACTION_REASONS.DUPLICATE_CHECK_FAILED);
  assert.equal(gh.count('createIssue'), 0);
});

test('建 Issue：创建成功且回读一致 → done，记录回读证据', async () => {
  const gh = fakeGh();
  const guard = allowGuard();
  const result = await createIssueIdempotent({ guard, gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'done');
  assert.equal(result.reused, false);
  assert.equal(result.objectRef, `https://gh.test/${REPO}/issues/7`);
  assert.equal(result.calls, 2, '创建 + 回读各一次');
  assert.equal(result.readback.ok, true);
  assert.equal(result.readback.title, 'Fix gate');
  assert.equal(guard.seen[0].egress, 'platform-write', '写动作必须声明出网范围，触发确认通道');
  assert.equal(guard.seen[0].target, REPO);
  assert.equal(guard.seen[0].action, FLOW_ACTIONS.ISSUE);
});

test('建 Issue：回读标题不一致 → unknown/READBACK_MISMATCH，且不重放创建', async () => {
  const gh = fakeGh({
    readIssue: async () => ({
      status: 'succeeded',
      object: { number: 7, title: '另一个标题', state: 'OPEN', url: `https://gh.test/${REPO}/issues/7`, comments: [] },
    }),
  });
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, ACTION_REASONS.READBACK_MISMATCH);
  assert.equal(result.readback.ok, false);
  assert.equal(gh.count('createIssue'), 1, 'unknown 之后不得自动重放');
  assert.equal(gh.count('readIssue'), 1);
});

test('建 Issue：回读失败 → unknown/READBACK_UNAVAILABLE', async () => {
  const gh = fakeGh({
    readIssue: async () => {
      throw ghError('COMMAND_TIMEOUT', { timedOut: true, mayHaveSideEffect: true });
    },
  });
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, ACTION_REASONS.READBACK_UNAVAILABLE);
  assert.equal(gh.count('createIssue'), 1);
});

test('建 Issue：创建命令未启动 → failed（确定没写出去）', async () => {
  const gh = fakeGh({
    createIssue: async () => {
      throw ghError('COMMAND_FAILED', { spawnFailed: true, mayHaveSideEffect: false });
    },
  });
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'COMMAND_FAILED');
  assert.match(result.detail, /未启动/u);
});

test('建 Issue：创建命令超时 → unknown（可能已写，转人工核对）', async () => {
  const gh = fakeGh({
    createIssue: async () => {
      throw ghError('COMMAND_TIMEOUT', { timedOut: true, mayHaveSideEffect: true });
    },
  });
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, ACTION_REASONS.COMMAND_TIMEOUT);
  assert.match(result.detail, /不自动重放/u);
});

test('建 Issue：创建结果里没有编号或链接 → unknown/MALFORMED_RESULT', async () => {
  const gh = fakeGh({ createIssue: async () => ({ status: 'succeeded', number: null, url: '' }) });
  const result = await createIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, ACTION_REASONS.MALFORMED_RESULT);
});

test('建 Issue：没接门禁时直接抛 TypeError（拒绝绕过门禁的装配）', async () => {
  await assert.rejects(
    () => createIssueIdempotent({ gh: fakeGh(), changeId: CHANGE, repo: REPO, title: 'Fix gate', body: '正文', confirm: CONFIRM }),
    TypeError,
  );
});

test('建 PR：同分支的 open PR 已存在时复用', async () => {
  const gh = fakeGh({
    listOpenPrs: async () => ({
      status: 'succeeded',
      items: [{ number: 31, title: '别的标题', url: `https://gh.test/${REPO}/pull/31`, headRefName: 'feat/gate', state: 'OPEN' }],
    }),
  });
  const result = await createPrIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    repo: REPO,
    head: 'feat/gate',
    base: 'main',
    title: 'Fix gate',
    body: '正文',
    confirm: CONFIRM,
  });
  assert.equal(result.status, 'done');
  assert.equal(result.reused, true);
  assert.equal(result.objectRef, `https://gh.test/${REPO}/pull/31`);
  assert.equal(gh.count('createPr'), 0);
  assert.equal(result.key, idempotencyKey({ change: CHANGE, objectType: 'pr', title: 'Fix gate' }));
});

test('建 PR：回读分支对不上 → unknown/READBACK_MISMATCH，不重放', async () => {
  const gh = fakeGh({
    readPr: async () => ({
      status: 'succeeded',
      object: { number: 9, title: 'Fix gate', url: `https://gh.test/${REPO}/pull/9`, headRefName: 'feat/other', baseRefName: 'main', comments: [] },
    }),
  });
  const result = await createPrIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    repo: REPO,
    head: 'feat/gate',
    base: 'main',
    title: 'Fix gate',
    body: '正文',
    confirm: CONFIRM,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, ACTION_REASONS.READBACK_MISMATCH);
  assert.equal(gh.count('createPr'), 1);
});

test('建 PR：缺 head/base 时 denied，gh 零调用', async () => {
  const gh = fakeGh();
  const result = await createPrIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    repo: REPO,
    head: '',
    base: 'main',
    title: 'Fix gate',
    body: '正文',
    confirm: CONFIRM,
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.MISSING_ARGUMENT);
  assert.equal(gh.calls.length, 0);
});

test('写 Issue 评论：目标格式非法时 denied，gh 零调用', async () => {
  const gh = fakeGh();
  const result = await commentIssueIdempotent({ guard: allowGuard(), gh, changeId: CHANGE, target: '7', body: '正文' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.MISSING_TARGET);
  assert.equal(gh.calls.length, 0);
});

test('写 Issue 评论：已有同正文评论时复用，不重复刷评论', async () => {
  const gh = fakeGh({
    readIssue: async () => ({
      status: 'succeeded',
      object: {
        number: 7,
        title: 'Fix gate',
        url: `https://gh.test/${REPO}/issues/7`,
        comments: [{ id: 'c1', body: '澄清正文', url: 'https://gh.test/comment/1', author: 'bot', createdAt: '2026-10-28T00:00:00Z' }],
      },
    }),
  });
  const result = await commentIssueIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    target: `${REPO}#7`,
    body: '澄清正文',
    confirm: { repo: REPO, object: `${REPO}#7` },
  });
  assert.equal(result.status, 'done');
  assert.equal(result.reused, true);
  assert.equal(gh.count('commentIssue'), 0);
  assert.equal(result.action, FLOW_ACTIONS.CLARIFY);
});

test('写 Issue 评论：写入后回读不到该正文 → unknown/READBACK_MISMATCH', async () => {
  const gh = fakeGh({
    readIssue: async () => ({
      status: 'succeeded',
      object: { number: 7, title: 'Fix gate', url: `https://gh.test/${REPO}/issues/7`, comments: [] },
    }),
  });
  const result = await commentIssueIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    target: `${REPO}#7`,
    body: '澄清正文',
    confirm: { repo: REPO, object: `${REPO}#7` },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, ACTION_REASONS.READBACK_MISMATCH);
  assert.equal(gh.count('commentIssue'), 1);
});

test('写 PR 审查评论：缺 commit 时 denied，审查必须绑定提交', async () => {
  const gh = fakeGh();
  const result = await commentPrIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    target: `${REPO}!9`,
    commit: '',
    body: '审查意见',
    confirm: { repo: REPO, object: `${REPO}!9` },
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, ACTION_REASONS.MISSING_ARGUMENT);
  assert.equal(gh.calls.length, 0);
});

test('写 PR 审查评论：成功时回读记录里带 commit', async () => {
  let reads = 0;
  const gh = fakeGh({
    readPr: async () => {
      reads += 1;
      return {
        status: 'succeeded',
        object: {
          number: 9,
          title: 'Fix gate',
          url: `https://gh.test/${REPO}/pull/9`,
          headRefName: 'feat/gate',
          baseRefName: 'main',
          comments: reads === 1 ? [] : [{ id: 'c2', body: '审查意见', url: 'https://gh.test/comment/2' }],
        },
      };
    },
  });
  const result = await commentPrIdempotent({
    guard: allowGuard(),
    gh,
    changeId: CHANGE,
    target: `${REPO}!9`,
    commit: 'abc1234',
    body: '审查意见',
    confirm: { repo: REPO, object: `${REPO}!9` },
  });
  assert.equal(result.status, 'done');
  assert.equal(result.action, FLOW_ACTIONS.PR_COMMENT);
  assert.equal(result.readback.commit, 'abc1234');
  assert.equal(result.objectRef, 'https://gh.test/comment/2');
});

test('澄清回写：没有通道时 denied，不写平台', async () => {
  const gh = fakeGh();
  const result = await writeClarification({ guard: allowGuard(), gh, sheet: { changeId: CHANGE, revisionId: 'ARD123456/1/abcdef12', body: '正文 abcdef12' }, targets: [] });
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].status, 'denied');
  assert.equal(gh.calls.length, 0);
});

test('澄清回写：dop 通道恒 denied/COMMAND_NOT_WHITELISTED，且从不访问 dop 适配器', async () => {
  const gh = fakeGh();
  const options = new Proxy(
    {
      guard: allowGuard(),
      gh,
      sheet: { changeId: CHANGE, revisionId: 'ARD123456/1/abcdef12', body: '澄清正文 ARD123456/1/abcdef12' },
      targets: ['dop'],
    },
    {
      get(target, key) {
        if (key === 'dop') throw new Error('澄清回写不得访问 dop 适配器（它没有写命令）');
        return target[key];
      },
    },
  );
  const result = await writeClarification(options);
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].status, 'denied');
  assert.equal(result.statuses[0].reason, ACTION_REASONS.COMMAND_NOT_WHITELISTED);
  assert.equal(result.statuses[0].calls, 0);
  assert.match(result.statuses[0].detail, /没有澄清写命令/u);
  assert.equal(gh.calls.length, 0);
});

test('澄清回写：正文不含修订标识时拒绝，不改写正文', async () => {
  const gh = fakeGh();
  const result = await writeClarification({
    guard: allowGuard(),
    gh,
    sheet: { changeId: CHANGE, revisionId: 'ARD123456/1/abcdef12', body: '澄清正文（没写版本号）' },
    targets: ['issue'],
  });
  assert.equal(result.statuses[0].status, 'denied');
  assert.equal(result.statuses[0].reason, ACTION_REASONS.MISSING_ARGUMENT);
  assert.match(result.statuses[0].detail, /不改写正文/u);
  assert.equal(gh.calls.length, 0);
});

test('澄清回写：issue 通道走幂等评论，写入成功后 done', async () => {
  let reads = 0;
  const gh = fakeGh({
    readIssue: async () => {
      reads += 1;
      return {
        status: 'succeeded',
        object: {
          number: 7,
          title: 'Fix gate',
          url: `https://gh.test/${REPO}/issues/7`,
          comments: reads === 1 ? [] : [{ id: 'c3', body: '澄清正文 ARD123456/1/abcdef12', url: 'https://gh.test/comment/3' }],
        },
      };
    },
  });
  const result = await writeClarification({
    guard: allowGuard(),
    gh,
    sheet: {
      changeId: CHANGE,
      revisionId: 'ARD123456/1/abcdef12',
      body: '澄清正文 ARD123456/1/abcdef12',
      issueTarget: `${REPO}#7`,
      confirm: { repo: REPO, object: `${REPO}#7` },
    },
    targets: ['issue'],
  });
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].status, 'done');
  assert.equal(result.statuses[0].action, FLOW_ACTIONS.CLARIFY);
  assert.equal(gh.count('commentIssue'), 1);
});

test('澄清回写：未知通道一律 denied/COMMAND_NOT_WHITELISTED（白名单只有 issue）', async () => {
  const gh = fakeGh();
  const result = await writeClarification({
    guard: allowGuard(),
    gh,
    sheet: { changeId: CHANGE, revisionId: 'ARD123456/1/abcdef12', body: '澄清正文 ARD123456/1/abcdef12', issueTarget: `${REPO}#7` },
    targets: [{ channel: 'wiki', target: 'somewhere' }],
  });
  assert.equal(result.statuses[0].status, 'denied');
  assert.equal(result.statuses[0].reason, ACTION_REASONS.COMMAND_NOT_WHITELISTED);
  assert.equal(gh.calls.length, 0);
});
