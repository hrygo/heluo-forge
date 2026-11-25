/**
 * 补丁层装载后果：AC-1 / AC-2 / AC-3 / AC-4 / AC-7 / AC-8（r7 起的编号口径）。
 *
 * r4（`docs/teamflow/20261029-r4-forge-gitee`）的编号在这里就地改写，**语义保留、只换编号**：
 *   - 原 AC-7（3 读可用 / 5 写未登记）→ **AC-1**（3 读 + 1 只读判定可用 / 4 写未登记）；
 *   - 原 AC-17（5 写 denied + operation 0 次）→ **AC-3**（4 写 denied；判定不再算写）。
 * 新增 AC-2（判定默认可用且 executed=false）、AC-4（默认登记判定、不默认登记写）、
 * AC-8（目录缺 judge 仍可挂载、判定降级 denied）。
 *
 * 这些用例一律从**真实的 `cordis.patch.yml`** 里取目录来挂真实策略服务，再挂真实插件：
 * "判定开箱可用 / 写动作默认禁用"的证据必须是分发配置本身，而不是测试里自造的目录。
 *
 * "0 次调用"以**门禁 operation 回调的调用次数**计量：`policy.executeAction` 的 operation 回调
 * 是通往 `service.invoke → 适配器 → execFile` 的唯一路径，计数它既等价于"适配器与 execFile
 * 出口 0 次调用"，又不依赖任何真实可执行文件（端口、跨平台都稳）。
 *
 * 反向证明（"denied 不是硬编码"）单独一处：换一个**放行**的策略服务，同一个工具就不再
 * `denied`——两半合起来才说明默认禁用来自那份目录，而不是代码里写死的拒绝。
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply } from '../src/index.mjs';
import { GITEE_READ_ACTIONS } from '../src/gitee-read.mjs';
import { GITEE_JUDGE_TOOLS, GITEE_TOOLS, GITEE_WRITE_TOOLS } from '../src/gitee-tools.mjs';
import { createFakeHost, invokeTool, parsePatch, readPatch } from './helpers/fake-host.mjs';

const PATCH_FILE = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** 5 个受控工具的最小合法入参（4 写 + 1 判定；判定的"全通过"输入另见 DELIVERY_CALL）。 */
const WRITE_CALLS = Object.freeze({
  forge_gitee_issue_write: {
    op: 'create',
    target: 'acme/repo',
    changeId: 'CHG-2026-001',
    title: '同步变更',
    body: '正文',
    confirm: { repo: 'acme/repo', object: 'acme/repo' },
  },
  forge_gitee_pr_write: {
    op: 'create',
    target: 'acme/repo',
    changeId: 'CHG-2026-001',
    head: 'feat/sync',
    base: 'main',
    title: '同步变更',
    body: '正文',
    confirm: { repo: 'acme/repo', object: 'acme/repo' },
  },
  forge_gitee_review_publish: {
    target: 'acme/repo!12',
    changeId: 'CHG-2026-001',
    commit: 'a'.repeat(40),
    body: '## 结论\n通过',
    confirm: { repo: 'acme/repo', object: 'acme/repo!12' },
  },
  forge_gitee_review_record: {
    repoRoot: PACKAGES_DIR,
    changeId: 'CHG-2026-001',
    commit: 'a'.repeat(40),
    model: 'test-model',
    findings: [],
    risks: [],
    opinion: 'approve',
    conclusion: 'pass',
  },
  forge_gitee_delivery_gate: {
    changeId: 'CHG-2026-001',
    commit: 'a'.repeat(40),
    message: '[CHG-2026-001] feat: 同步变更',
    criteria: { acceptance: 'pass', merged: 'unknown', pendingDelivery: 'pass', humanConfirmed: 'pass' },
  },
});

/**
 * AC-2 的合法输入（TECHNICAL §3.2 逐字）：四项条件全部 passed / count 0。
 *
 * 裸结论字符串 `'pass'` 现在与对象 `status: 'passed'` 同义（r7 QA DEF-1：工具描述声明的取值
 * 必须真的被接受）；这里仍用对象事实写法，覆盖 TECHNICAL §3.2 声明的形状。
 */
const DELIVERY_CALL = Object.freeze({
  changeId: 'CHG-2026-001',
  message: '[CHG-2026-001] 判定默认登记',
  commit: 'a'.repeat(40),
  criteria: {
    acceptance: { status: 'passed', evidence: '离线 CI 全绿', sourceType: 'ci' },
    merged: { status: 'passed', evidence: 'PR 已合入', sourceType: 'platform' },
    pendingDelivery: { count: 0 },
    humanConfirmed: { decision: 'confirmed' },
  },
});
/** 取分发补丁层的两行（策略行 + 插件行）。 */
async function shippedRows() {
  const rows = await readPatch(PATCH_FILE);
  const policyRow = rows.find((row) => row.name === '@heluo/forge-policy');
  const pluginRow = rows.find((row) => row.name === '@heluo/forge-gitee');
  assert.ok(policyRow !== undefined, '分发补丁层必须自带策略行（否则插件装上也用不了）');
  assert.ok(pluginRow !== undefined, '分发补丁层必须插入本包');
  return { rows, policyRow, pluginRow };
}

/**
 * 用**真服务 + 真目录**挂载，并给门禁的 operation 回调计数。
 *
 * 包装层只转发（catalog/decide/auditRecords 都是真服务的），所以"未登记即 deny"的行为
 * 完全由 `@heluo/forge-policy` 决定。
 */
async function mountWithRealPolicy({ catalog, pluginConfig } = {}) {
  const { policyRow, pluginRow } = await shippedRows();
  const host = createFakeHost();
  const counter = { operations: 0, actions: [] };
  const installed = host.mountPolicy({ catalog: catalog ?? policyRow.catalog, audit: policyRow.audit });
  assert.equal(installed.ok, true, `策略层挂载失败：${installed.error?.message ?? ''}`);
  const real = installed.policy;
  host.ctx.provide('policy', {
    catalog: real.catalog,
    decide: (...args) => real.decide(...args),
    auditRecords: (...args) => real.auditRecords(...args),
    approvalFor: (...args) => real.approvalFor(...args),
    executeAction: (ctx, action, exec, operation) =>
      real.executeAction(ctx, action, exec, async (...args) => {
        counter.operations += 1;
        counter.actions.push(action);
        return operation(...args);
      }),
  });
  const mounted = host.mount(apply, pluginConfig ?? pluginRow.config);
  return { host, counter, real, mounted, pluginRow, policyRow };
}

/** 放行桩：目录取自真实编译结果，但门禁一律放行（反向证明用）。 */
async function mountWithAdmittingPolicy({ pluginConfig } = {}) {
  const { policyRow, pluginRow } = await shippedRows();
  const host = createFakeHost();
  const installed = host.mountPolicy({ catalog: policyRow.catalog, audit: policyRow.audit });
  assert.equal(installed.ok, true);
  const real = installed.policy;
  const calls = [];
  host.ctx.provide('policy', {
    catalog: real.catalog,
    decide: (action) => ({ action: 'allow', reason: `stub allows ${action}`, rule: 'registered-action' }),
    auditRecords: () => [],
    executeAction: async (ctx, action, exec, operation) => {
      calls.push(action);
      return operation();
    },
  });
  const mounted = host.mount(apply, pluginConfig ?? pluginRow.config);
  return { host, calls, mounted, pluginRow, policyRow };
}

test('AC-1: 用分发补丁层挂载后，6 条受控写随包登记；只读动作不登记、按 out-of-scope 透传', async () => {
  const { host, real, mounted } = await mountWithRealPolicy();
  assert.equal(mounted.ok, true, `插件挂载失败：${mounted.error?.message ?? ''}`);
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);
  assert.equal(real.catalog.size, 6, '默认目录 = 6 条受控写（只读动作不登记）');

  // 只读动作不在控制面：未登记即 out-of-scope 放行，且不产生受控执行记录。
  for (const action of ['change.read', 'change.list', ...GITEE_READ_ACTIONS, 'gitee.delivery.judge']) {
    assert.equal(real.catalog.has(action), false, `${action} 是只读动作，不得登记`);
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, 'allow', `${action} 应按 out-of-scope 放行：${decision.reason}`);
    assert.equal(decision.rule, 'out-of-scope');
  }

  // 写动作随包登记（未登记只会得到误导性的 unregistered-action），但登记不等于放行：
  // 执行期还要过身份与审计，默认决策由内置分类给出。
  for (const [action, want] of [
    ['gitee.issue.write', 'allow'],
    ['gitee.pr.write', 'allow'],
    ['gitee.review.publish', 'allow'],
    ['change.clarification.write', 'allow'],
  ]) {
    assert.equal(real.catalog.has(action), true, `${action} 必须随包登记：默认分发开箱即可走受控写`);
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, want, `${action} 的默认决策应为 ${want}（实际：${decision.action}/${decision.reason}）`);
  }
  // 远端写与人工留痕的默认分类仍留在编译结果里（P0 不启用对应规则）。
  assert.equal(real.catalog.get('gitee.git.push')?.decision, 'confirm');
  assert.equal(real.catalog.get('gitee.review.record')?.decision, 'deny');
});

test('AC-2: 默认目录下判定默认可用：done + ready + executed false + remote_calls 0', async () => {
  const { host, counter, mounted } = await mountWithRealPolicy();
  assert.equal(mounted.ok, true);

  const { body } = await invokeTool(host, 'forge_gitee_delivery_gate', DELIVERY_CALL);
  assert.equal(body?.ok, true, `判定应可用（实际：${body?.status}/${body?.reason}）`);
  assert.equal(body?.status, 'done');
  assert.equal(body?.rule, 'ready');
  assert.equal(body?.readback?.via, 'gitee-delivery');
  assert.equal(body?.readback?.ok, true);
  assert.equal(body?.readback?.ready, true);
  assert.deepEqual(body?.readback?.unknown_items, []);
  // 只判定不执行：executed 是判定体的运行时声明，恒 false；写动作不会有这个键。
  assert.equal(body?.executed, false);
  assert.equal(body?.remote_calls, 0);
  assert.doesNotMatch(JSON.stringify(body), /"status":"denied"/u);
  // 判定确实经过了策略门禁，而不是绕过目录直通。
  assert.equal(counter.operations, 1);
  assert.deepEqual(counter.actions, ['gitee.delivery.judge']);
});

test('AC-3: 默认目录下 4 个写工具逐个 denied（登记不等于放行）、规则固定、门禁 operation 0 次', async () => {
  const { host, counter, mounted } = await mountWithRealPolicy();
  assert.equal(mounted.ok, true);
  assert.deepEqual(
    [...GITEE_WRITE_TOOLS, ...GITEE_JUDGE_TOOLS],
    Object.keys(WRITE_CALLS),
    '受控工具（4 写 + 1 判定）与负测入参必须一一对应',
  );
  assert.equal(Object.keys(WRITE_CALLS).length, 5, '负测入参表仍覆盖全部 5 个受控工具');

  for (const toolName of GITEE_WRITE_TOOLS) {
    const { body } = await invokeTool(host, toolName, WRITE_CALLS[toolName]);
    assert.notEqual(body?.ok, true, `${toolName} 不得返回空成功（ok:true）`);
    assert.equal(body?.status, 'denied', `${toolName} 应为 denied（实际：${body?.status}/${body?.reason}）`);
    assert.notEqual(body?.rule, 'argument-invalid', `${toolName} 必须由策略门禁拒绝`);
    assert.equal(typeof body?.rule, 'string', `${toolName} 的 denied 必须带 rule`);
    assert.ok(body.rule.length > 0, `${toolName} 的 rule 不能为空`);
    assert.ok(typeof body?.reason === 'string' && body.reason.length > 0, `${toolName} 必须说明原因`);
    assert.doesNotMatch(JSON.stringify(body), /"status":"done"/u, `${toolName} 不得出现"空成功"`);
    assert.equal(body?.evidence, undefined, `${toolName} 被拒时不得留下执行证据`);
    // executed 是判定专用键：写信封多出它就成了"写动作也承认只判定不执行"。
    assert.equal(body?.executed, undefined, `${toolName} 的写信封不得出现 executed`);
  }

  assert.equal(counter.operations, 0, `写动作被拒时门禁 operation 必须 0 次（实际：${counter.operations}）`);
  assert.deepEqual(counter.actions, []);
});

test('AC-4: 默认目录恰好 6 条受控写：读动作不登记，写按内置分类受控（取代事实：旧实现登记 12 条并集并显式 enabled）', async () => {
  const { real } = await mountWithRealPolicy();
  assert.equal(real.catalog.size, 6, `默认目录应恰好 6 条受控写，实际 ${real.catalog.size}`);
  for (const action of ['change.read', 'change.list', ...GITEE_READ_ACTIONS, 'gitee.delivery.judge']) {
    assert.equal(real.catalog.has(action), false, `${action} 是只读动作，不得登记`);
  }

  const writes = ['gitee.issue.write', 'gitee.pr.write', 'change.clarification.write', 'gitee.review.publish', 'gitee.git.push', 'gitee.review.record'];
  const wants = {
    'gitee.issue.write': ['issue', 'dev-write'],
    'gitee.pr.write': ['pull-request', 'dev-write'],
    'change.clarification.write': ['change', 'dev-write'],
    'gitee.review.publish': ['pull-request', 'review-write'],
    'gitee.git.push': ['repository', 'remote-write'],
    'gitee.review.record': ['pull-request', 'human-record'],
  };
  for (const action of writes) {
    const entry = real.catalog.get(action);
    assert.ok(entry !== undefined, `${action} 必须随包登记（未登记只会得到误导性的拒绝）`);
    assert.equal(entry.target, wants[action][0], `${action} 的 target 必须与内置词表一致`);
    assert.equal(entry.category, wants[action][1], `${action} 的 category 必须与内置词表一致`);
    assert.equal(entry.enabled, undefined, `${action} 不得再声明 enabled：登记只决定可见性`);
    assert.equal(entry.revision, undefined, `${action} 不得声明 revision`);
  }
  assert.equal(real.catalog.get('gitee.git.push')?.decision, 'confirm', 'push 是远端写：分类给出逐次确认（P0 未启用确认规则）');
  assert.equal(real.catalog.get('gitee.review.record')?.decision, 'deny', '人工评审留痕不由 Agent 发起');

  // 全关语义：六条写都放行到执行（身份与审计仍恒开），读动作按 out-of-scope 放行。
  for (const action of writes) {
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, 'allow', `${action} 在全部开关关闭时应放行：${decision.reason}`);
  }
  for (const action of ['change.read', 'change.list', ...GITEE_READ_ACTIONS, 'gitee.delivery.judge']) {
    const decision = real.decide({ action, target: action.startsWith('change.') || action === 'gitee.delivery.judge' ? 'CHG-2026-001' : 'acme/repo' });
    assert.equal(decision.action, 'allow', `${action} 应按 out-of-scope 放行：${decision.reason}`);
    assert.equal(decision.rule, 'out-of-scope');
  }
});

test('AC-8: 判定不再要求登记——未登记的判定按 out-of-scope 透传（取代事实：旧实现缺 judge 时降级 denied）', async () => {
  const { policyRow, pluginRow } = await shippedRows();
  const { host, counter, real, mounted } = await mountWithRealPolicy({
    catalog: policyRow.catalog,
    pluginConfig: pluginRow.config,
  });
  assert.equal(mounted.ok, true, `判定缺失不得阻塞挂载：${mounted.error?.message ?? ''}`);
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS], '11 个工具照旧注册（工具面不随目录条数变）');
  assert.equal(real.catalog.has('gitee.delivery.judge'), false, '判定是只读动作：P0 不再登记');

  const { body } = await invokeTool(host, 'forge_gitee_delivery_gate', DELIVERY_CALL);
  assert.notEqual(body?.status, 'denied', `未登记判定应按 out-of-scope 透传（实际：${body?.status}）`);
  assert.equal(counter.operations, 1, '透传后照常进入 operation：判定能力不再依赖策略目录');
  for (const action of GITEE_READ_ACTIONS) {
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, 'allow', '3 条读动作同样按 out-of-scope 放行');
    assert.equal(decision.rule, 'out-of-scope');
  }
});

test('AC-3 反向: 放行的策略服务下同一工具不再 denied——默认禁用来自目录而非硬编码', async () => {
  const { host, calls, mounted } = await mountWithAdmittingPolicy({
    pluginConfig: { cliPath: '/nonexistent/gitee-cli-absent-for-tests' },
  });
  assert.equal(mounted.ok, true);

  let body;
  try {
    ({ body } = await invokeTool(host, 'forge_gitee_issue_write', WRITE_CALLS.forge_gitee_issue_write));
  } catch (error) {
    body = { status: 'threw', error: error?.message };
  }
  assert.ok(calls.includes('gitee.issue.write'), `工具必须把动作交给门禁（实际：${calls.join(',') || '无'}）`);
  assert.notEqual(body?.status, 'denied', '策略放行后不该再是 denied');
  assert.notEqual(body?.status, 'done', 'CLI 不存在时不得返回 done');
});

// r7 保留（编号不变）：AC-8 证明"缺判定不影响挂载"，这里反过来证明"目录空/缺一条同样不影响挂载"。
// P0 取代事实：旧实现要求 3 条只读动作必须登记且 enabled，缺一条即拒绝挂载（TECH-CHANGE §3.4）。
test('AC-7 反向: 目录为空或缺一条时仍可挂载——只读动作不参与控制面（P0 取代事实）', async () => {
  const { policyRow, pluginRow } = await shippedRows();

  const empty = createFakeHost();
  const emptyMounted = empty.mountPolicy({ catalog: [], audit: policyRow.audit });
  assert.equal(emptyMounted.ok, true, `空目录必须可编译：${emptyMounted.error?.message ?? ''}`);
  apply(empty.ctx, pluginRow.config);
  assert.deepEqual(empty.toolNames(), [...GITEE_TOOLS], '空目录下插件仍挂载：11 个工具照旧注册');

  const partial = createFakeHost();
  const partialRows = policyRow.catalog.filter((entry) => entry.action !== 'gitee.pr.write');
  const partialMounted = partial.mountPolicy({ catalog: partialRows, audit: policyRow.audit });
  assert.equal(partialMounted.ok, true, '缺一条受控写目录仍可编译');
  apply(partial.ctx, pluginRow.config);
  assert.deepEqual(partial.toolNames(), [...GITEE_TOOLS], '缺一条受控写不影响其余工具面');
});

test('AC-7/AC-1: 任何插入本包的补丁层都必须自带目录与审计（全仓扫描）', async () => {
  const packagesUrl = new URL('../../', import.meta.url);
  const entries = await readdir(packagesUrl, { withFileTypes: true });
  // 一个包可以有多层（底座 `cordis.patch.yml` + 叠加层 `cordis.patch.*.yml`），
  // 判据按**包的补丁集合**求并集：单文件自带目录不再成立，但装完这份包必须自带。
  const layers = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let files;
    try {
      files = (await readdir(new URL(`${entry.name}/`, packagesUrl)))
        .filter((name) => /^cordis\.patch(\.[A-Za-z0-9-]+)?\.yml$/u.test(name))
        .sort();
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const rows = [];
    for (const file of files) {
      const text = await readFile(new URL(`${entry.name}/${file}`, packagesUrl), 'utf8');
      rows.push(...parsePatch(text));
    }
    layers.push({ package: entry.name, files, rows });
  }
  assert.ok(layers.length >= 2, '至少本包与 forge-devops 各有补丁层');

  const inserting = [];
  for (const { package: packageName, rows } of layers) {
    const giteeRow = rows.find((row) => row.name === '@heluo/forge-gitee');
    if (giteeRow === undefined) continue;
    inserting.push(packageName);
    const policyRow = rows.find((row) => row.name === '@heluo/forge-policy');
    assert.ok(policyRow !== undefined, `${packageName} 插入 gitee 却没有自带策略行`);
    // P0：策略目录只登记 6 条受控写（action/target/category 三元组），
    // 只读动作不登记、不参与控制面（TECH-CHANGE §3.1 / §3.4）。
    assert.equal(policyRow.catalog.length, 6, `${packageName} 的策略行应恰好 6 条受控写`);
    for (const entry of policyRow.catalog) {
      assert.equal(typeof entry.action, 'string', `${packageName} 的目录条目缺 action`);
      assert.equal(typeof entry.target, 'string', `${packageName} 的目录条目缺 target`);
      assert.match(entry.category, /^(?:dev-write|review-write|remote-write|human-record)$/u);
      assert.equal(entry.enabled, undefined, `${packageName} 的目录条目不得声明 enabled`);
      assert.equal(entry.revision, undefined, `${packageName} 的目录条目不得声明 revision`);
      assert.equal(entry.kind, undefined, `${packageName} 的目录条目不得声明 kind`);
    }
    assert.equal(policyRow.audit.sink, 'memory', `${packageName} 的策略行缺显式审计舱`);
    assert.equal(String(policyRow.audit.buffer), '1000', `${packageName} 的策略行缺环形缓冲容量`);
    assert.equal(String(policyRow.audit.keepDays), '7', `${packageName} 的策略行缺保留天数`);
    assert.equal(policyRow.audit.allowNonDurable, undefined, `${packageName} 不得再声明 allowNonDurable`);
    assert.equal(typeof giteeRow.config, 'object', `${packageName} 的 gitee 行缺显式 config`);
    assert.equal(giteeRow.config === null, false);
  }
  // 分包后由独立研发工具包 @heluo/forge-engineering 挂载 gitee 与政策行，
  // 通用底座 @heluo/forge-enterprise 不得包含 gitee，devops 仍不得偷偷插入。
  assert.deepEqual(inserting.sort(), ['forge-engineering', 'forge-gitee'], '只有本包与企业研发套件插入 gitee');
  assert.ok(!inserting.includes('forge-enterprise'), '通用企业底座不得引入 gitee');
  assert.ok(!inserting.includes('forge-devops'), 'devops 的补丁层不得偷偷插入本包');
});
