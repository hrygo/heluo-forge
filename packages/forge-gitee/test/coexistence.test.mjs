/**
 * 共存三形态（r10：AC-13 由「两行隔离」翻转为「同一行单实例」）。
 *
 * r4 时代靠 `isolate: { policy: gitee }` 把两个 bundle 隔到不同服务域，代价是同装后有两份
 * 策略实例、两套读面事实。r10 按平台切库：两份补丁层插**同一个** `id: heluo-policy`、目录是
 * 6 条受控写、两处都**不写** `isolate`——loader 按 id 覆盖 config，装配后果只应有一个策略实例。
 *
 * P0 起（TECH-CHANGE §3.1/§3.4）只读动作不登记：目录条目只有 action/target/category，
 * 挂载前置只要求策略提供 `executeAction`。旧事实（12 条并集、enabled:true、缺只读动作
 * 即拒绝挂载）已被本阶段取代。
 *
 * 三种形态都是**装载后果**，不是设计偏好，所以全部用"真实策略服务 + 真实补丁层数据"离线复现：
 *   A 单装本包——11 个工具（3 读 + 4 写 + 1 判定 + 1 快照 + 2 git）、6 条受控写目录、策略落在 root 域。
 *   B 叠加两层——按 loader 语义合并（同 id 覆盖、后装者胜）后只有一个策略实例、15 个工具
 *     全枚举、0 行激活失败；两个方向的叠加必须对称。
 *   B- 反证——单边把 `gitee.pr.write` 从本包目录里删掉再叠加：幸存配置由装配顺序决定，
 *     但挂载不再因此失败；未登记的动作只是变成 out-of-scope，不再进入受控流水线。
 *   C 并层单一策略行——同一份 6 条目录 / 15 个工具；卸载归零；六条写随包登记但
 *     `gitee.review.record` 恒拒、`gitee.git.push` 逐次确认。
 *
 * devops 侧用等价假插件（4 个哑工具 + 同样只要求策略 admission 入口）：本包测试不导入
 * devops 源码（包间零源码依赖），而"叠加"这个后果只取决于"它也要求策略入口"这一点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { GITEE_READ_ACTIONS } from '../src/gitee-read.mjs';
import { GITEE_JUDGE_TOOLS, GITEE_TOOLS } from '../src/gitee-tools.mjs';
import { createEquivalentPlatformPlugin, createFakeHost, readPatch } from './helpers/fake-host.mjs';

const GITEE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
const DEVOPS_PATCH = fileURLToPath(new URL('../../forge-devops/cordis.patch.yml', import.meta.url));

const POLICY_NAME = '@heluo/forge-policy';
const SHARED_POLICY_ID = 'heluo-policy';
/** P0 目录：六条受控写（只读动作不登记）。 */
const UNION_ACTIONS = Object.freeze([
  'gitee.issue.write',
  'gitee.pr.write',
  'change.clarification.write',
  'gitee.review.publish',
  'gitee.git.push',
  'gitee.review.record',
]);
/** 只读动作：仍在词表里，但不再进目录、不进受控流水线。 */
const READ_ACTIONS = Object.freeze([
  'change.read',
  'change.list',
  'gitee.repository.read',
  'gitee.issue.read',
  'gitee.pr.read',
  'gitee.delivery.judge',
]);
/** 本包工具面（r12）：3 读 + 4 受控写 + 1 判定 + 1 快照 + 2 git = 11。 */
const GITEE_TOOL_COUNT = 11;
/** devops 工具面 4 个（等价假插件按同一数量开工具）。 */
const DEVOPS_EQUIVALENT_TOOLS = Object.freeze(
  Array.from({ length: 4 }, (_, index) => `forge_devops_equivalent_${index + 1}`),
);
const TOTAL_TOOL_COUNT = GITEE_TOOL_COUNT + DEVOPS_EQUIVALENT_TOOLS.length;

async function layers() {
  const gitee = await readPatch(GITEE_PATCH);
  const devops = await readPatch(DEVOPS_PATCH);
  const giteePolicy = gitee.find((row) => row.name === POLICY_NAME);
  const giteePlugin = gitee.find((row) => row.name === '@heluo/forge-gitee');
  const devopsPolicy = devops.find((row) => row.name === POLICY_NAME);
  const devopsPlugin = devops.find((row) => row.name === '@heluo/forge-devops');
  assert.ok(giteePolicy && giteePlugin, 'gitee 补丁层缺行');
  assert.ok(devopsPolicy && devopsPlugin, 'devops 补丁层缺行');
  assert.equal(giteePolicy.id, SHARED_POLICY_ID, 'gitee 策略行 id 必须是 heluo-policy（r10 单实例）');
  assert.equal(devopsPolicy.id, SHARED_POLICY_ID, 'devops 策略行 id 必须是 heluo-policy');
  assert.deepEqual(
    giteePolicy.catalog.map((entry) => entry.action),
    [...UNION_ACTIONS],
    'gitee 侧目录必须是 6 条受控写（只读动作不登记）',
  );
  for (const action of READ_ACTIONS) {
    assert.equal(
      giteePolicy.catalog.some((entry) => entry.action === action),
      false,
      `${action} 是只读动作，不得进入目录`,
    );
  }
  for (const entry of giteePolicy.catalog) {
    assert.equal(entry.enabled, undefined, 'P0 目录条目只有 action/target/category，没有 enabled');
    assert.ok(entry.target && entry.category, `${entry.action} 必须声明 target 与 category`);
  }
  assert.deepEqual(
    devopsPolicy.catalog,
    giteePolicy.catalog,
    '两份补丁层的目录必须逐字相同：loader 只留一份 config',
  );
  for (const [name, row] of [['gitee', giteePolicy], ['gitee', giteePlugin], ['devops', devopsPolicy], ['devops', devopsPlugin]]) {
    assert.equal(row.isolate, undefined, `${name} 的 ${row.id} 不得写 isolate：r10 两个 bundle 同处 root 域`);
  }
  return { gitee, devops, giteePolicy, giteePlugin, devopsPolicy, devopsPlugin };
}

function devopsEquivalent() {
  // P0 的 devops 挂载只要求策略提供 executeAction（只读动作不登记）。
  return createEquivalentPlatformPlugin({
    label: 'forge-devops-equivalent',
    toolNames: DEVOPS_EQUIVALENT_TOOLS,
  });
}

/**
 * 模拟 loader 的补丁层合并：**同 id 覆盖 config、后装者胜、位置按首次出现**。
 * 这正是 r10 依赖的实测语义（r4 D-2），所以不能用"两行都挂"代替。
 */
function mergeRows(layersInOrder) {
  const byId = new Map();
  for (const rows of layersInOrder) {
    for (const row of rows) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** 按宿主的行为挂一整层：每一行独立成败，**不因某行失败而中断后续行**。 */
function mountLayer(host, rows) {
  const results = [];
  for (const row of rows) {
    if (row.name === POLICY_NAME) {
      const mounted = host.mountPolicy({ catalog: row.catalog, audit: row.audit, isolate: row.isolate });
      results.push({ kind: 'policy', row, ...mounted });
      continue;
    }
    const plugin = row.name === '@heluo/forge-gitee' ? apply : row.name === '@heluo/forge-devops' ? devopsEquivalent() : undefined;
    if (plugin === undefined) continue;
    const mounted = host.mount(plugin, row.config, row.name, { isolate: row.isolate });
    results.push({ kind: 'plugin', tool: row.name, ...mounted });
  }
  return results;
}

const failuresOf = (results) => results.filter((result) => result.ok !== true).map((result) => `${result.row.id}:${result.code ?? 'ok'}`);

test('形态 A: 单装本包——11 个工具、6 条受控写目录、单实例落在 root 域', async () => {
  const { gitee } = await layers();
  const host = createFakeHost();
  const results = mountLayer(host, mergeRows([gitee]));

  assert.deepEqual(failuresOf(results), [], '单装不该有任何失败行');
  assert.equal(host.services.get('gitee').status(), 'ready');
  const policy = host.policyIn(undefined);
  assert.ok(policy !== undefined, '策略必须在 root 域（r10 不再用 isolate）');
  assert.equal(host.policyIn('gitee'), undefined, '不存在 gitee 隔离域');
  assert.equal(host.realms.size, 0, '全仓不得再有 isolate 服务域');
  assert.equal(policy.catalog.size, UNION_ACTIONS.length);
  for (const action of UNION_ACTIONS) {
    const entry = policy.catalog.get(action);
    assert.ok(entry, `${action} 应随包登记`);
    assert.equal(entry.enabled, undefined, `${action} 不应该再有 enabled 字段`);
    assert.ok(['dev-write', 'review-write', 'remote-write', 'human-record'].includes(entry.category), `${action} 必须带内置分类`);
  }
  for (const action of READ_ACTIONS) {
    assert.equal(policy.catalog.has(action), false, `${action} 是只读动作，不应登记`);
  }
  assert.equal(GITEE_TOOLS.length, GITEE_TOOL_COUNT);
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);
  assert.equal(GITEE_READ_ACTIONS.length, 3, 'r10 不减少只读动作');
  assert.equal(GITEE_JUDGE_TOOLS.length, 1, '判定仍是一条只读工具');
});

test('形态 A\': 单装 devops 层同样自洽——并集目录让任一插件单独装都能用', async () => {
  const { devops } = await layers();
  const host = createFakeHost();
  const results = mountLayer(host, mergeRows([devops]));

  assert.deepEqual(failuresOf(results), [], 'devops 单装不该失败（缺 gitee 的读动作不影响它）');
  assert.equal(host.policyIn(undefined).catalog.size, UNION_ACTIONS.length);
  assert.deepEqual(host.toolNames(), [...DEVOPS_EQUIVALENT_TOOLS]);
});

test('形态 B: 叠加两层——同 id 覆盖后只有一个策略实例，15 个工具全枚举、0 行失败', async () => {
  const { gitee, devops } = await layers();

  for (const [first, second, label] of [[devops, gitee, '先 devops 后 gitee'], [gitee, devops, '先 gitee 后 devops']]) {
    const host = createFakeHost();
    const results = mountLayer(host, mergeRows([first, second]));

    assert.deepEqual(failuresOf(results), [], `${label}：叠加不得让任何一行失败（AC-13 的判据）`);
    assert.equal(host.realms.size, 0, `${label}：两处都不写 isolate，不应产生隔离域`);
    assert.ok(host.policyIn(undefined) !== undefined, `${label}：root 域必须有唯一的策略实例`);
    assert.equal(host.policyIn('gitee'), undefined, `${label}：不得再有第二份策略实例`);

    assert.equal(host.toolNames().length, TOTAL_TOOL_COUNT, `${label}：工具面应为 4 + 11 = 15`);
    assert.deepEqual(
      [...host.toolNames()].sort(),
      [...DEVOPS_EQUIVALENT_TOOLS, ...GITEE_TOOLS].sort(),
      `${label}：两边的工具都必须可枚举`,
    );
    assert.equal(new Set(host.toolNames()).size, host.toolNames().length, `${label}：工具名不得重复`);
    assert.equal(host.services.get('gitee').status(), 'ready', `${label}：本包服务必须就绪`);
  }
});

test('形态 B-: 单边删一条目录——幸存配置取决于装配顺序，但不再阻断挂载（门禁对未登记动作放行）', async () => {
  // 取代事实（TECH-CHANGE §3.4）：旧实现把"缺目录"变成挂载期 GITEE_ACTION_UNREGISTERED；
  // P0 只读动作不登记，目录漂移的后果降级为"该动作不进受控流水线（out-of-scope）"。
  const { gitee, devops, giteePolicy } = await layers();
  const driftedPolicy = {
    ...giteePolicy,
    catalog: giteePolicy.catalog.filter((entry) => entry.action !== 'gitee.pr.write'),
  };
  const driftedGitee = gitee.map((row) => (row.id === SHARED_POLICY_ID ? driftedPolicy : row));

  // 缺条目的一份后装 → loader 留下的就是缺条目的那份；两行都必须装配成功。
  const host = createFakeHost();
  const results = mountLayer(host, mergeRows([devops, driftedGitee]));
  assert.deepEqual(failuresOf(results), [], '目录缺一条不再拒绝挂载');
  assert.equal(host.policyIn(undefined).catalog.size, UNION_ACTIONS.length - 1);
  assert.equal(host.policyIn(undefined).catalog.has('gitee.pr.write'), false, '被删的写动作未登记');
  assert.equal(host.services.get('gitee').status(), 'ready', '工具面照常就绪');

  // 换个顺序，后装的 devops 层目录获胜——幸存配置确实取决于装配顺序。
  const reverse = createFakeHost();
  assert.deepEqual(failuresOf(mountLayer(reverse, mergeRows([driftedGitee, devops]))), []);
  assert.equal(reverse.policyIn(undefined).catalog.size, UNION_ACTIONS.length);
  assert.equal(reverse.policyIn(undefined).catalog.has('gitee.pr.write'), true, '后装层目录覆盖前者');
});

test('形态 C: 并层单一策略行——6 条受控写 / 15 个工具；卸载归零；写随包登记但按分类受控', async () => {
  const { gitee, devops, giteePolicy, devopsPolicy } = await layers();
  const host = createFakeHost();

  const merged = mergeRows([devops, gitee]);
  const results = mountLayer(host, merged);
  assert.deepEqual(failuresOf(results), []);
  const policy = host.policyIn(undefined);
  assert.equal(policy.catalog.size, UNION_ACTIONS.length);

  const expected = [...DEVOPS_EQUIVALENT_TOOLS, ...GITEE_TOOLS];
  assert.equal(host.toolNames().length, TOTAL_TOOL_COUNT);
  assert.deepEqual([...host.toolNames()].sort(), [...expected].sort());
  assert.deepEqual(host.services.get('gitee').toolNames(), [...GITEE_TOOLS]);

  // 卸载两边都要干净：单实例不等于"谁都不管清理"。
  host.disposeAll();
  assert.deepEqual(host.toolNames(), []);
  assert.equal(host.services.get('gitee'), undefined);

  // 目录是 6 条受控写：登记只决定可见性，放行由内置分类决定。
  assert.equal(policy.catalog.size, devopsPolicy.catalog.length);
  assert.equal(policy.catalog.size, giteePolicy.catalog.length);
  assert.equal(
    [...policy.catalog.values()].filter((entry) => entry.enabled === true || entry.enabled === false).length,
    0,
    'P0 目录条目不得再有 enabled 开关',
  );
  assert.equal(policy.catalog.get('gitee.git.push')?.decision, 'confirm', 'push 每次推送都要单独确认');
  assert.equal(policy.catalog.get('gitee.review.record')?.decision, 'deny', '人工评审留痕恒拒');
  assert.equal(policy.catalog.has('gitee.delivery.judge'), false, '判定是只读动作，不进目录');
  assert.equal(policy.catalog.get('gitee.issue.write')?.category, 'dev-write');
  assert.equal(policy.catalog.get('gitee.review.publish')?.category, 'review-write');
});
