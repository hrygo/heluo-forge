/**
 * 共存三形态：AC-13（P1）。
 *
 * 三种形态都是**装载后果**，不是设计偏好，所以全部用"真实策略服务 + 真实补丁层数据"
 * 离线复现：
 *   A 单装——只装本包：8 个工具、3 条只读目录；策略落在 `gitee` 服务域（`isolate`），
 *     root 域不出现 `policy`，不与任何别的 provider 抢名字。
 *   B 叠加（D-2 的修法）——devops 补丁层 + 本包补丁层**都按原样叠加**：两个策略实例分处
 *     root 与 `gitee` 两个服务域，17 个工具全枚举、0 行激活失败、devops 的 4 条目录一条不少。
 *     反向叠加同样成立。
 *   B- 反证（门禁有牙）——把本包两行的 `isolate` 去掉再叠加：两个策略实例撞进同一服务域，
 *     第二个 `apply` 抛 `POLICY_SERVICE_CONFLICT`，本包插件按"动作未登记"fail closed。
 *     这就是 D-2 的原始失败形态；用例锁住"隔离不是可选项"。
 *   C 并层——另一条合法路径：唯一的策略行把 GitHub 的 4 条与 gitee 的 3 条并在一起，插件行
 *     去掉 `isolate` 共用同一实例，7 条目录 / 17 个工具全枚举。
 *
 * GitHub 侧用等价假插件（9 个哑工具 + 同样的"目录未登记即 fail closed"）：本包测试不导入
 * devops 源码（包间零源码依赖），而"叠加"这个后果只取决于"它也要求策略目录"这一点。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { GITEE_READ_ACTIONS } from '../src/gitee-read.mjs';
import { GITEE_TOOLS } from '../src/gitee-tools.mjs';
import { createEquivalentPlatformPlugin, createFakeHost, readPatch } from './helpers/fake-host.mjs';

const GITEE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
const DEVOPS_PATCH = fileURLToPath(new URL('../../forge-devops/cordis.patch.yml', import.meta.url));
/** 本包策略行的服务域 label（补丁层两行必须同值，否则 provider 与 consumer 互相看不见）。 */
const GITEE_REALM = 'gitee';

/** GitHub 侧的等价工具面（devops 有 9 个工具；名字与语义无关，只用于计数与枚举）。 */
const DEVOPS_EQUIVALENT_TOOLS = Object.freeze(
  Array.from({ length: 9 }, (_, index) => `forge_devops_equivalent_${index + 1}`),
);

async function layers() {
  const gitee = await readPatch(GITEE_PATCH);
  const devops = await readPatch(DEVOPS_PATCH);
  const giteePolicy = gitee.find((row) => row.name === '@heluo/forge-policy');
  const giteePlugin = gitee.find((row) => row.name === '@heluo/forge-gitee');
  const devopsPolicy = devops.find((row) => row.name === '@heluo/forge-policy');
  const devopsPlugin = devops.find((row) => row.name === '@heluo/forge-devops');
  assert.ok(giteePolicy && giteePlugin, 'gitee 补丁层缺行');
  assert.ok(devopsPolicy && devopsPlugin, 'devops 补丁层缺行');
  return { gitee, devops, giteePolicy, giteePlugin, devopsPolicy, devopsPlugin };
}

function devopsEquivalent(devopsPolicy) {
  return createEquivalentPlatformPlugin({
    label: 'forge-devops-equivalent',
    readActions: devopsPolicy.catalog.map((entry) => entry.action),
    toolNames: DEVOPS_EQUIVALENT_TOOLS,
  });
}

/**
 * 按宿主的行为挂一整层：每一行独立成败，**不因某行失败而中断后续行**（这正是"叠加安装"
 * 里"第二个策略冲突、后面的插件行仍然被执行"的现实）。`dropIsolate` 只用于反证形态。
 */
function mountLayer(host, rows, { devopsPolicy, dropIsolate = false } = {}) {
  const results = [];
  for (const row of rows) {
    const isolate = dropIsolate ? undefined : row.isolate;
    if (row.name === '@heluo/forge-policy') {
      const mounted = host.mountPolicy({ catalog: row.catalog, audit: row.audit, isolate });
      results.push({ kind: 'policy', row, ...mounted });
      continue;
    }
    const plugin = row.name === '@heluo/forge-gitee' ? apply : row.name === '@heluo/forge-devops' ? devopsEquivalent(devopsPolicy) : undefined;
    if (plugin === undefined) continue;
    const mounted = host.mount(plugin, row.config, row.name, { isolate });
    results.push({ kind: 'plugin', tool: row.name, ...mounted });
  }
  return results;
}

const failuresOf = (results) => results.filter((result) => result.ok !== true).map((result) => `${result.row.id}:${result.code ?? 'ok'}`);

test('AC-13 形态 A: 单装本包——8 个工具、3 条只读目录、策略隔离在 gitee 域', async () => {
  const { gitee } = await layers();
  const host = createFakeHost();
  const results = mountLayer(host, gitee);

  assert.equal(results.length, 2);
  assert.deepEqual(failuresOf(results), [], '单装不该有任何失败行');
  assert.equal(host.policyIn(GITEE_REALM).catalog.size, GITEE_READ_ACTIONS.length);
  assert.equal(host.policyIn(undefined), undefined, 'root 服务域不出现 policy（不污染别的 provider）');
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);
  assert.equal(host.services.get('gitee').status(), 'ready');
});

test('AC-13 形态 B: 叠加两层（D-2）——两个策略实例各在各的服务域，17 个工具全枚举、0 行激活失败', async () => {
  const { gitee, devops, giteePolicy, devopsPolicy, giteePlugin } = await layers();

  // B-1：先 devops 后 gitee（QA 复现 D-2 的顺序）。
  const host = createFakeHost();
  const first = mountLayer(host, devops, { devopsPolicy });
  assert.deepEqual(failuresOf(first), [], 'devops 层单独挂载应当成功');
  assert.deepEqual(host.toolNames(), [...DEVOPS_EQUIVALENT_TOOLS]);

  const second = mountLayer(host, gitee, { devopsPolicy });
  assert.deepEqual(failuresOf(second), [], '叠加本包不得让任何一行失败（D-2 的判据）');
  assert.equal(host.toolNames().length, DEVOPS_EQUIVALENT_TOOLS.length + GITEE_TOOLS.length);
  assert.deepEqual(
    [...host.toolNames()].sort(),
    [...DEVOPS_EQUIVALENT_TOOLS, ...GITEE_TOOLS].sort(),
    '两边的工具都必须可枚举',
  );

  // 关键：devops 的目录一条不少（没有被本包的策略行覆盖），两份目录份属不同实例。
  const rootPolicy = host.policyIn(undefined);
  const giteeRealmPolicy = host.policyIn(GITEE_REALM);
  assert.ok(rootPolicy !== undefined, 'devops 的 root 策略实例必须还在');
  assert.notEqual(rootPolicy, giteeRealmPolicy, '两个策略实例必须是两份，不能是同一个');
  assert.equal(rootPolicy.catalog.size, devopsPolicy.catalog.length);
  assert.equal(giteeRealmPolicy.catalog.size, giteePolicy.catalog.length);
  for (const entry of devopsPolicy.catalog) {
    assert.equal(rootPolicy.catalog.get(entry.action)?.enabled, true, `devops 的 ${entry.action} 应仍然可用`);
  }
  assert.equal(host.services.get('gitee').status(), 'ready');

  // B-2：反方向（先 gitee 后 devops），结论必须对称。
  const reverse = createFakeHost();
  assert.deepEqual(failuresOf(mountLayer(reverse, gitee, { devopsPolicy })), []);
  assert.deepEqual(failuresOf(mountLayer(reverse, devops, { devopsPolicy })), []);
  assert.equal(reverse.toolNames().length, 17);
  assert.equal(reverse.services.get('gitee').status(), 'ready');
  assert.equal(reverse.policyIn(undefined).catalog.size, devopsPolicy.catalog.length);
  // 两份补丁层各自 0 条写动作：叠加不会顺手打开任何写权限。
  assert.equal(giteePlugin.isolate?.policy, GITEE_REALM);
  assert.equal(giteePolicy.catalog.filter((entry) => entry.kind !== 'read').length, 0);
});

test('AC-13 形态 B-: 去掉 isolate 再叠加——两个策略实例撞车，POLICY_SERVICE_CONFLICT 可见（反证）', async () => {
  const { gitee, devops, devopsPolicy } = await layers();
  const host = createFakeHost();
  assert.deepEqual(failuresOf(mountLayer(host, devops, { devopsPolicy })), []);

  const second = mountLayer(host, gitee, { devopsPolicy, dropIsolate: true });
  const policyFailure = second.find((result) => result.kind === 'policy');
  assert.equal(policyFailure.ok, false, '同一服务域里的第二个 heluo-policy 必须可见地失败');
  assert.equal(policyFailure.code, 'POLICY_SERVICE_CONFLICT', `原因码应可读：${policyFailure.error?.message ?? ''}`);
  assert.match(policyFailure.error.message, /already mounted/u);

  const giteeFailure = second.find((result) => result.kind === 'plugin');
  assert.equal(giteeFailure.ok, false, '没有自己那份目录时插件必须 fail closed（不能装一半）');
  assert.equal(giteeFailure.code, 'GITEE_ACTION_UNREGISTERED');
  assert.deepEqual(giteeFailure.detail.missing, [...GITEE_READ_ACTIONS]);
  // 先挂载方的工具还在——"报错"与"工具静默消失"是两种不同的失败。
  assert.deepEqual(host.toolNames(), [...DEVOPS_EQUIVALENT_TOOLS]);
  assert.equal(host.services.get('gitee'), undefined);
});

test('AC-13 形态 C: 并层单一策略行——7 条目录 / 17 个工具全枚举', async () => {
  const { giteePolicy, devopsPolicy, giteePlugin, devopsPlugin } = await layers();
  const host = createFakeHost();

  // 唯一一行策略（不带 isolate，root 域），把 GitHub 的 4 条与 gitee 的 3 条并在一起。
  const merged = {
    catalog: [...devopsPolicy.catalog, ...giteePolicy.catalog],
    audit: devopsPolicy.audit,
  };
  const mountedPolicy = host.mountPolicy(merged);
  assert.equal(mountedPolicy.ok, true, `并层策略挂载失败：${mountedPolicy.error?.message ?? ''}`);
  const policy = mountedPolicy.policy;
  assert.equal(policy.catalog.size, devopsPolicy.catalog.length + giteePolicy.catalog.length);
  assert.equal(policy.catalog.size, 7);

  const devopsMount = host.mount(devopsEquivalent(devopsPolicy), devopsPlugin.config);
  // 并层时本包插件行也要去掉 isolate（共用同一实例），见补丁层注释的"并层"做法。
  const giteeMount = host.mount(apply, giteePlugin.config);
  assert.equal(devopsMount.ok, true, `等价 devops 插件挂载失败：${devopsMount.error?.message ?? ''}`);
  assert.equal(giteeMount.ok, true, `gitee 插件挂载失败：${giteeMount.error?.message ?? ''}`);

  const expected = [...DEVOPS_EQUIVALENT_TOOLS, ...GITEE_TOOLS];
  assert.equal(host.toolNames().length, 17);
  assert.deepEqual([...host.toolNames()].sort(), [...expected].sort());
  assert.equal(new Set(host.toolNames()).size, host.toolNames().length, '工具名不得重复');

  for (const action of [...devopsPolicy.catalog.map((entry) => entry.action), ...GITEE_READ_ACTIONS]) {
    assert.equal(policy.catalog.get(action)?.enabled, true, `${action} 在并层目录里应可用`);
  }
  assert.deepEqual(host.services.get('gitee').toolNames(), [...GITEE_TOOLS]);

  // 卸载两边都要干净：并层不等于"谁都不管清理"。
  host.disposeAll();
  assert.deepEqual(host.toolNames(), []);
  assert.equal(host.services.get('gitee'), undefined);

  // 并层也不打开任何写动作：两份补丁层的目录里都不含写条目（本包 0 write 是 AC-17 的默认口径）。
  assert.equal(merged.catalog.filter((entry) => entry.kind === 'write').length, 0);
});
