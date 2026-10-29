import test from 'node:test';
import assert from 'node:assert/strict';

import { createDevopsFlow } from '../src/flow.mjs';

/**
 * 流程组合根（D-1）：`apply` 装配的正是这个工厂。这里用假 `execFile` 走一遍
 * 「配置 → runner → dop/gh → 承建判定 → 上下文卡」与写动作前置，全程不 spawn 真实 CLI。
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
