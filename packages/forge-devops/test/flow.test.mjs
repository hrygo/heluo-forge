import test from 'node:test';
import assert from 'node:assert/strict';

import { createDevopsFlow } from '../src/flow.mjs';
import { FLOW_ACTIONS } from '../src/tools.mjs';

/**
 * 流程组合根（D-1）：`apply` 装配的正是这个工厂。这里用假 `execFile` 走一遍
 * 「配置 → runner → dop/gh → 承建判定 → 上下文卡」与写动作前置，全程不 spawn 真实 CLI。
 *
 * 后面两组用例专测 r6 的**三段仓库**（`org/group/repo`，企业 Gitee 命名空间）：
 * 承建判定与评论目标都保留完整路径，同组兄弟仓库 / 另一命名空间 / 折叠成两段都必须拒绝。
 */

const CHANGE = {
  id: 'ARD123456',
  title: '积分商城改造',
  status: 'in_progress',
  type: 'requirement',
  owner: 'hosea',
  description: '积分商城支持兑换券',
  acceptance_criteria: ['兑换券可抵扣', '失败可重试'],
  created_at: '2026-10-20T00:00:00Z',
  sub_systems: [{ code: 'points-mall', name: '积分商城' }],
  user_stories: [{ id: 'US-10001', title: '兑换券抵扣', release_info: { release_num: 'R20261020001' } }],
};

const REPO = { name: 'points-mall', nameWithOwner: 'acme/points-mall', description: '积分商城', url: 'https://example.invalid/acme/points-mall' };

const CONFIG = Object.freeze({
  dopBin: '/opt/fake/dop',
  dopEndpoint: 'https://dop.example.invalid',
  ghBin: 'gh',
  ghOwner: 'acme',
  sourceType: 'mock',
  timeoutMs: 20000,
});

/** 假 `execFile`：按固定 argv 形状回放，记录每次调用；回调式与 cli-runner 的兼容路径一致。 */
function fakeCli() {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args] });
    const joined = args.join(' ');
    let payload = 'null';
    if (joined.startsWith('change view ')) payload = JSON.stringify(CHANGE);
    else if (joined.startsWith('repo list ')) payload = JSON.stringify([REPO]);
    else if (joined.startsWith('issue list ')) payload = '[]';
    else if (joined.startsWith('pr list ')) payload = '[]';
    process.nextTick(() => callback(null, `${payload}\n`, ''));
  };
  return { calls, execFile };
}

const policyStub = {
  catalog: new Map(),
  executeAction: async () => {
    throw new Error('本用例不应走到门禁');
  },
};

const now = () => '2026-10-28T12:00:00.000Z';

test('配置齐全时 startFromChange 产出 ready 上下文卡：dop/gh 各一次、承建判定不猜', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ config: CONFIG, execFile, now });
  const result = await flow.startFromChange({ changeId: 'ARD123456' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.changeId, 'ARD123456');
  assert.equal(result.context.change.changeId, 'ARD123456');
  assert.equal(result.context.change.releaseInfo.value.releaseNum, 'R20261020001', '排期取 release_info 首个非空');
  assert.equal(result.building.status, 'resolved');
  assert.equal(result.building.selected, 'acme/points-mall');
  assert.deepEqual(result.unknowns, []);
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2).join(' ')),
    ['change view', 'repo list', 'issue list', 'pr list'],
    '取数只走固定 argv：一条变更、一次仓库清单、两轮关联对象',
  );
  assert.match(result.text, /上下文卡/u);
  assert.match(result.text, /acme\/points-mall/u);
});

test('未配置运行时环境：产出 blocked 卡、未知项点名 CONFIG_MISSING，且零子进程调用', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ env: {}, execFile, now });
  const result = await flow.startFromChange({ changeId: 'ARD123456' });

  assert.equal(result.ok, true, '流程面仍可达：不抛异常，把原因写进卡里');
  assert.equal(result.status, 'blocked');
  assert.equal(result.context.change, null);
  assert.equal(result.config.dopBin, false, '只报"配没配"，不回显路径或 endpoint');
  assert.deepEqual(result.unknowns.map((item) => item.field), ['dop.change.view', 'gh.repository.list']);
  assert.ok(result.unknowns.every((item) => item.reason === 'CONFIG_MISSING'));
  assert.equal(calls.length, 0, '未配置时不得发起任何子进程（AC-22）');
});

test('写动作前置：未绑定变更号、无门禁、无配置都在子进程之前 denied', async () => {
  const { calls, execFile } = fakeCli();
  const unbound = createDevopsFlow({ config: CONFIG, policy: policyStub, execFile, now });
  const missing = await unbound.issueWrite({ op: 'create', target: 'acme/points-mall', title: '[ARD123456] 实现' });
  assert.equal(missing.status, 'denied');
  assert.equal(missing.reason, 'MISSING_CHANGE_ID');

  const noPolicy = createDevopsFlow({ config: CONFIG, execFile, now });
  await noPolicy.startFromChange({ changeId: 'ARD123456' });
  const ungated = await noPolicy.prWrite({ op: 'create', target: 'acme/points-mall', head: 'feat/x', base: 'main', title: '[ARD123456] 实现' });
  assert.equal(ungated.status, 'denied');
  assert.equal(ungated.reason, 'POLICY_REQUIRED');

  const unconfigured = createDevopsFlow({ env: {}, policy: policyStub, execFile, now });
  await unconfigured.startFromChange({ changeId: 'ARD123456' });
  const nowhere = await unconfigured.issueWrite({ op: 'comment', target: 'acme/points-mall#12', body: '审查意见' });
  assert.equal(nowhere.status, 'denied');
  assert.equal(nowhere.reason, 'CONFIG_MISSING');
  assert.equal(nowhere.calls, 0);
  assert.equal(calls.length, 4, '只有第一次配置齐全的取数发生调用，写动作全部零下游');
});

test('非法变更号早退：不取数、不绑定', async () => {
  const { calls, execFile } = fakeCli();
  const flow = createDevopsFlow({ config: CONFIG, execFile, now });
  for (const input of [undefined, '', '两个 号', 'x']) {
    const result = await flow.startFromChange({ changeId: input });
    assert.equal(result.ok, false, `${String(input)} 应被拒绝`);
    assert.equal(result.reason, 'MISSING_OR_INVALID');
  }
  assert.equal(calls.length, 0);
  assert.equal(flow.describe().configured, true);
});

/* -------------------------------------------------------------------------------------------------
 * 三段仓库（`org/group/repo`）：承建判定、评论目标与门禁核对都按**完整路径**比对。
 * 夹具是 mock（离线 argv 回放），不是企业实测。
 * ----------------------------------------------------------------------------------------------- */

const CHANGE3 = {
  id: 'ARD654321',
  title: '三段命名空间仓库改造',
  status: 'in_progress',
  type: 'requirement',
  owner: 'hosea',
  description: 'org/group/repo 形态下的写路径核对',
  acceptance_criteria: ['评论可写入', '不一致必须拒绝'],
  created_at: '2026-10-20T00:00:00Z',
  sub_systems: [{ code: 'demo', name: '演示' }],
  user_stories: [{ id: 'US-20002', title: '评论核对', release_info: { release_num: 'R20261030002' } }],
};

const REPO3 = {
  name: 'demo',
  nameWithOwner: 'acme/group/demo',
  description: '演示仓库',
  url: 'https://example.invalid/acme/group/demo',
};

const PR3 = {
  number: 12,
  title: 'feat: 演示',
  state: 'OPEN',
  url: 'https://example.invalid/acme/group/demo/pull/12',
  updatedAt: '2026-10-29T00:00:00Z',
  headRefName: 'feat/x',
  baseRefName: 'main',
  isDraft: false,
  mergedAt: null,
};

const COMMENT_URL = 'https://example.invalid/acme/group/demo/pull/12#issuecomment-9001';

/**
 * 假 `execFile`（三段仓库版）：比 `fakeCli` 多一条 `pr view` / `pr comment` 通道——
 * 评论写下去之后回读能看到自己，写动作才能真正走到 `done`，而不是停在"查重/回读失败"。
 */
function fakeCliWithPr() {
  const calls = [];
  const posted = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args] });
    const joined = args.join(' ');
    let payload = 'null';
    if (joined.startsWith('change view ')) payload = JSON.stringify(CHANGE3);
    else if (joined.startsWith('repo list ')) payload = JSON.stringify([REPO3]);
    else if (joined.startsWith('issue list ')) payload = '[]';
    else if (joined.startsWith('pr list ')) payload = '[]';
    else if (joined.startsWith('pr view ')) payload = JSON.stringify({ ...PR3, comments: [...posted] });
    else if (joined.startsWith('pr comment ')) {
      const body = args[args.indexOf('--body') + 1] ?? '';
      posted.push({ id: '9001', body, url: COMMENT_URL, author: { login: 'reviewer' }, createdAt: '2026-10-30T08:00:00Z' });
      payload = COMMENT_URL;
    }
    process.nextTick(() => callback(null, `${payload}\n`, ''));
  };
  return { calls, execFile, posted };
}

/** 放行门禁桩：只记录"门禁看到了什么"，然后照常执行下游（不改动被审计的判定）。 */
function passingGuard() {
  const seen = [];
  return {
    seen,
    execute: async (request, operation) => {
      seen.push({ action: request.action, target: request.target, arguments: request.arguments });
      return { status: 'done', value: await operation() };
    },
  };
}

test('三段仓库的 PR 评论：完整路径与承建仓库一致时放行，且目标一字不改地走到命令面', async () => {
  const { calls, execFile, posted } = fakeCliWithPr();
  const guard = passingGuard();
  const flow = createDevopsFlow({ config: CONFIG, guard, execFile, now });
  const bound = await flow.startFromChange({ changeId: 'ARD654321' });
  assert.equal(bound.building.status, 'resolved');
  assert.equal(bound.building.selected, 'acme/group/demo', '三段仓库保留完整命名空间，不折成两段');

  const before = calls.length;
  const result = await flow.prWrite({
    op: 'comment',
    target: 'acme/group/demo!12',
    commit: 'a1b2c3d4',
    body: '审查意见：三段命名空间下门禁与写路径一致',
    confirm: { repo: 'acme/group/demo', object: 'acme/group/demo!12' },
  });

  assert.equal(result.status, 'done', '三段评论目标与承建仓库是同一个仓库，不应被判不一致');
  assert.equal(result.target, 'acme/group/demo!12', '目标原样回报/下传，不折段');
  assert.equal(result.reused, false);
  assert.deepEqual(result.readback, { target: 'acme/group/demo!12', commit: 'a1b2c3d4', commentId: '9001', ok: true });
  assert.equal(guard.seen.length, 1, '写动作恰好过一次门禁');
  assert.equal(guard.seen[0].action, FLOW_ACTIONS.PR_COMMENT);
  assert.equal(guard.seen[0].target, 'acme/group/demo!12');
  assert.deepEqual(guard.seen[0].arguments, { repo: 'acme/group/demo', commit: 'a1b2c3d4' });
  assert.deepEqual(
    calls.slice(before).map((call) => call.args.slice(0, 2).join(' ')),
    ['pr view', 'pr comment', 'pr view'],
    '查重、写入、回读各一次，位置参数都是完整的三段目标',
  );
  assert.equal(posted.length, 1);
});

test('三段仓库的 PR 评论：同组兄弟仓库、另一命名空间、折叠成两段都必须拒绝', async () => {
  const { calls, execFile } = fakeCliWithPr();
  const guard = passingGuard();
  const flow = createDevopsFlow({ config: CONFIG, guard, execFile, now });
  await flow.startFromChange({ changeId: 'ARD654321' });
  const before = calls.length;

  // `acme/group/other` 与前两段相同、最后一段不同；`group/demo` 是"承建仓库被截成两段"后才会相等的形态。
  for (const target of ['acme/group/other!12', 'acme/other/demo!12', 'group/demo!12']) {
    const result = await flow.prWrite({
      op: 'comment',
      target,
      commit: 'a1b2c3d4',
      body: '审查意见',
      confirm: { repo: target.slice(0, target.indexOf('!')), object: target },
    });
    assert.equal(result.status, 'denied', `${target} 不在承建仓库，必须拒绝`);
    assert.equal(result.reason, 'REPO_NOT_SELECTED', `${target} 的拒绝原因必须是仓库不一致`);
    assert.equal(result.calls, 0);
    assert.equal(result.target, target, '拒绝时目标原样回报，便于人工核对');
  }

  assert.equal(guard.seen.length, 0, '仓库不一致时门禁一次都不该被调用');
  assert.equal(calls.length, before, '不一致判定发生在任何子进程之前');
});

test('评论目标解析不出仓库时不冒充「仓库不一致」：交给权威校验回 MISSING_TARGET，仍然零写入', async () => {
  const { calls, execFile } = fakeCliWithPr();
  const guard = passingGuard();
  const flow = createDevopsFlow({ config: CONFIG, guard, execFile, now });
  await flow.startFromChange({ changeId: 'ARD654321' });
  const before = calls.length;

  const link = 'https://example.invalid/acme/group/demo/pull/12';
  const result = await flow.prWrite({
    op: 'comment',
    target: link,
    commit: 'a1b2c3d4',
    body: '审查意见',
    confirm: { repo: 'acme/group/demo', object: link },
  });

  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'MISSING_TARGET', '原因码应指向目标语法，而不是"写到了候选之外"');
  assert.equal(result.calls, 0);
  assert.equal(guard.seen.length, 0);
  assert.equal(calls.length, before);
});
