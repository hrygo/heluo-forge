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
 * 从分发补丁层里**只删掉 judge 那一条目录**（其余逐字保留）。
 *
 * AC-8：判定缺失不该阻塞挂载（`assertReadCatalog` 只要求 3 条读动作），只把判定降级成
 * denied。这里不动插件行与审计行，模拟"存量补丁层还没跟上 r7 目录"的装配后果。
 */
async function shippedRowsWithoutJudge() {
  const text = await readFile(PATCH_FILE, 'utf8');
  const lines = text.split('\n');
  const judgeLines = lines.filter((line) => /^\s*-\s*\{\s*action:\s*'gitee\.delivery\.judge'/u.test(line));
  assert.equal(judgeLines.length, 1, `分发补丁层必须恰好一条 judge 目录（实际：${judgeLines.length}）`);
  const rows = parsePatch(lines.filter((line) => judgeLines.includes(line) === false).join('\n'));
  const policyRow = rows.find((row) => row.name === '@heluo/forge-policy');
  const pluginRow = rows.find((row) => row.name === '@heluo/forge-gitee');
  assert.ok(policyRow !== undefined && pluginRow !== undefined, '补丁层结构被改动过：策略行/插件行缺失');
  assert.equal(policyRow.catalog.length, 5, '删掉 judge 后应只剩 5 条：change.read / change.list + 3 条 gitee 只读');
  return { policyRow, pluginRow };
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

test('AC-1: 用分发补丁层挂载后，6 条并集可用（含 change.read / change.list）、4 个写动作未登记', async () => {
  const { host, real, mounted } = await mountWithRealPolicy();
  assert.equal(mounted.ok, true, `插件挂载失败：${mounted.error?.message ?? ''}`);
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);
  assert.equal(
    real.catalog.size,
    GITEE_READ_ACTIONS.length + GITEE_JUDGE_TOOLS.length + 2,
    '默认目录 = 3 条 gitee 只读 + 1 条只读判定 + devops 的 change.read / change.list（两包共用同一份并集）',
  );

  for (const action of ['change.read', 'change.list', ...GITEE_READ_ACTIONS, 'gitee.delivery.judge']) {
    const target = action === 'gitee.delivery.judge' || action.startsWith('change.') ? 'CHG-2026-001' : 'acme/repo';
    const decision = real.decide({ action, target });
    assert.equal(decision.action, 'allow', `${action} 应可用：${decision.reason}`);
    assert.equal(decision.rule, 'registered-action');
  }

  const writeActions = ['gitee.issue.write', 'gitee.pr.write', 'gitee.review.publish', 'gitee.review.record'];
  for (const action of writeActions) {
    assert.equal(real.catalog.has(action), false, `${action} 不该出现在分发目录里（默认禁用写）`);
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, 'deny');
    assert.equal(decision.rule, 'unregistered-action');
  }
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

test('AC-3: 默认目录下 4 个写工具逐个 denied、规则固定、门禁 operation 0 次', async () => {
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

test('AC-4: 默认登记判定、不默认登记写', async () => {
  const { real } = await mountWithRealPolicy();
  assert.equal(real.catalog.size, 6, `默认目录应恰好 6 条（3 读 + 1 判定 + change.read + change.list），实际 ${real.catalog.size}`);
  assert.equal(real.catalog.get('change.read')?.kind, 'read', 'devops 的变更读也在这份并集目录里（同装时唯一来源）');
  assert.equal(real.catalog.get('change.list')?.kind, 'read', 'devops 的变更清单读同样在这份并集目录里（同装时唯一来源）');

  const judge = real.catalog.get('gitee.delivery.judge');
  assert.ok(judge !== undefined, '判定必须随包登记（开箱可用），否则等于没有这个能力');
  assert.equal(judge.kind, 'read', '判定是只读能力：kind 错成 write 就会被"写动作要确认"的口径误伤');
  assert.equal(judge.target, 'change', 'target 必须逐字 change（补丁层/README/设计文档同字面）');
  assert.equal(judge.egress, 'allow', "egress 缺省会取 'confirm'，判定在无审批台账时永远拿不到 allow");
  assert.equal(judge.enabled, true);

  for (const action of ['gitee.issue.write', 'gitee.pr.write', 'gitee.review.publish', 'gitee.review.record']) {
    assert.equal(real.catalog.has(action), false, `${action} 不该被默认登记`);
  }
  assert.equal(
    [...real.catalog.values()].filter((entry) => entry.kind === 'write').length,
    0,
    '默认目录里不得出现任何 write 条目',
  );

  for (const action of [...GITEE_READ_ACTIONS, 'gitee.delivery.judge']) {
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, 'allow', `${action} 应走"登记即可用"：${decision.reason}`);
    assert.equal(decision.rule, 'registered-action');
  }
});

test('AC-8: 目录缺 judge 时仍可挂载，判定降级 denied', async () => {
  const { policyRow, pluginRow } = await shippedRowsWithoutJudge();
  const { host, counter, real, mounted } = await mountWithRealPolicy({
    catalog: policyRow.catalog,
    pluginConfig: pluginRow.config,
  });
  assert.equal(mounted.ok, true, `判定缺失不得阻塞挂载：${mounted.error?.message ?? ''}`);
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS], '10 个工具照旧注册（工具面不随目录条数变）');

  const { body } = await invokeTool(host, 'forge_gitee_delivery_gate', DELIVERY_CALL);
  assert.equal(body?.status, 'denied', `判定未登记时必须 denied（实际：${body?.status}）`);
  assert.equal(body?.rule, 'unregistered-action');
  assert.equal(body?.ok, false);
  assert.equal(counter.operations, 0, '判定没登记就不该进 operation');
  for (const action of GITEE_READ_ACTIONS) {
    assert.equal(real.decide({ action, target: 'acme/repo' }).action, 'allow', '3 条读目录照旧可用');
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

// r7 保留（编号不变）：AC-8 证明"缺判定不影响挂载"，这里反过来证明"缺读目录直接拒绝挂载"。
// 两条合起来才说明 `assertReadCatalog` 的门槛仍是 3 条**读**动作，判定不在门槛里。
test('AC-7 反向: 目录为空/缺一条时拒绝挂载，且不留下半个工具面', async () => {
  const { policyRow, pluginRow } = await shippedRows();

  const empty = createFakeHost({ catalog: [], audit: policyRow.audit });
  try {
    apply(empty.ctx, pluginRow.config);
    assert.fail('空目录必须拒绝挂载');
  } catch (error) {
    assert.equal(error.code, 'GITEE_ACTION_UNREGISTERED');
    assert.deepEqual(error.detail.missing, [...GITEE_READ_ACTIONS]);
  }
  assert.deepEqual(empty.toolNames(), []);

  const partial = createFakeHost();
  const installed = partial.mountPolicy({
    catalog: policyRow.catalog.filter((entry) => entry.action !== 'gitee.pr.read'),
    audit: policyRow.audit,
  });
  assert.equal(installed.ok, true);
  assert.throws(
    () => apply(partial.ctx, pluginRow.config),
    (error) => error.code === 'GITEE_ACTION_UNREGISTERED' && error.detail.missing.join(',') === 'gitee.pr.read',
  );
  assert.deepEqual(partial.toolNames(), []);
});

test('AC-7/AC-1: 任何插入本包的补丁层都必须自带目录与审计（全仓扫描）', async () => {
  const packagesUrl = new URL('../../', import.meta.url);
  const entries = await readdir(packagesUrl, { withFileTypes: true });
  const layers = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await readFile(new URL(`${entry.name}/cordis.patch.yml`, packagesUrl), 'utf8');
      layers.push({ package: entry.name, rows: parsePatch(text) });
    } catch {
      continue;
    }
  }
  assert.ok(layers.length >= 2, '至少本包与 forge-devops 各有补丁层');

  let insertsGitee = 0;
  for (const { package: packageName, rows } of layers) {
    const giteeRow = rows.find((row) => row.name === '@heluo/forge-gitee');
    if (giteeRow === undefined) continue;
    insertsGitee += 1;
    const policyRow = rows.find((row) => row.name === '@heluo/forge-policy');
    assert.ok(policyRow !== undefined, `${packageName} 插入 gitee 却没有自带策略行`);
    // 只要求 3 条 gitee 只读目录：AC-8 明确"缺 judge 不阻塞挂载"，所以这里不能把判定算进门槛；
    // 并集里的 change.read / change.list 属于 devops，也不计入 gitee 的最低要求。
    for (const action of GITEE_READ_ACTIONS) {
      assert.ok(
        policyRow.catalog.some((entry) => entry.action === action),
        `${packageName} 的策略行目录缺 gitee 只读动作 ${action}`,
      );
    }
    assert.equal(policyRow.audit.sink, 'memory', `${packageName} 的策略行缺显式审计舱`);
    assert.equal(policyRow.audit.allowNonDurable, true);
    assert.equal(typeof giteeRow.config, 'object', `${packageName} 的 gitee 行缺显式 config`);
    assert.equal(giteeRow.config === null, false);
  }
  assert.equal(insertsGitee, 1, '当前只有本包插入 gitee（devops 的补丁层不得偷偷插入本包）');
});
