/**
 * 补丁层装载后果：AC-7（动态半）+ AC-17 + AC-13（形态 A：单装）。
 *
 * 这些用例一律从**真实的 `cordis.patch.yml`** 里取目录来挂真实策略服务，再挂真实插件：
 * "默认禁用写动作"的证据必须是分发配置本身，而不是测试里自造的目录。
 *
 * AC-17 的"0 次调用"在这里以**门禁 operation 回调的调用次数**计量：`policy.executeAction`
 * 的 operation 回调是通往 `service.invoke → 适配器 → execFile` 的唯一路径，计数它既等价于
 * "适配器与 execFile 出口 0 次调用"，又不依赖任何真实可执行文件（端口、跨平台都稳）。
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
import { GITEE_TOOLS, GITEE_WRITE_TOOLS } from '../src/gitee-tools.mjs';
import { createFakeHost, invokeTool, parsePatch, readPatch } from './helpers/fake-host.mjs';

const PATCH_FILE = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** 五写工具的最小合法入参（参数表见 TECHNICAL §工具面）。 */
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

test('AC-7: 用分发补丁层挂载后，3 条只读动作可用、5 个写动作未登记', async () => {
  const { host, real, mounted } = await mountWithRealPolicy();
  assert.equal(mounted.ok, true, `插件挂载失败：${mounted.error?.message ?? ''}`);
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);

  for (const action of GITEE_READ_ACTIONS) {
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, 'allow', `${action} 应可用：${decision.reason}`);
    assert.equal(decision.rule, 'registered-action');
  }

  const writeActions = ['gitee.issue.write', 'gitee.pr.write', 'gitee.review.publish', 'gitee.review.record', 'gitee.delivery.judge'];
  for (const action of writeActions) {
    assert.equal(real.catalog.has(action), false, `${action} 不该出现在分发目录里`);
    const decision = real.decide({ action, target: 'acme/repo' });
    assert.equal(decision.action, 'deny');
    assert.equal(decision.rule, 'unregistered-action');
  }
});

test('AC-17: 默认目录下 5 个写工具逐个 denied + rule，且门禁 operation 0 次', async () => {
  const { host, counter, mounted } = await mountWithRealPolicy();
  assert.equal(mounted.ok, true);
  assert.deepEqual([...GITEE_WRITE_TOOLS], Object.keys(WRITE_CALLS), '写工具名与负测入参必须一一对应');

  for (const toolName of GITEE_WRITE_TOOLS) {
    const { body } = await invokeTool(host, toolName, WRITE_CALLS[toolName]);
    assert.notEqual(body?.ok, true, `${toolName} 不得返回空成功（ok:true）`);
    assert.equal(body?.status, 'denied', `${toolName} 应为 denied（实际：${body?.status}/${body?.reason}）`);
    assert.equal(typeof body?.rule, 'string', `${toolName} 的 denied 必须带 rule`);
    assert.ok(body.rule.length > 0, `${toolName} 的 rule 不能为空`);
    assert.ok(typeof body?.reason === 'string' && body.reason.length > 0, `${toolName} 必须说明原因`);
    assert.doesNotMatch(JSON.stringify(body), /"status":"done"/u, `${toolName} 不得出现"空成功"`);
    assert.equal(body?.evidence, undefined, `${toolName} 被拒时不得留下执行证据`);
  }

  assert.equal(counter.operations, 0, `写动作被拒时门禁 operation 必须 0 次（实际：${counter.operations}）`);
  assert.deepEqual(counter.actions, []);
});

test('AC-17 反向: 放行的策略服务下同一工具不再 denied——默认禁用来自目录而非硬编码', async () => {
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
    assert.ok(policyRow.catalog.length >= 3, `${packageName} 的策略行目录缺 gitee 只读动作`);
    assert.equal(policyRow.audit.sink, 'memory', `${packageName} 的策略行缺显式审计舱`);
    assert.equal(policyRow.audit.allowNonDurable, true);
    assert.equal(typeof giteeRow.config, 'object', `${packageName} 的 gitee 行缺显式 config`);
    assert.equal(giteeRow.config === null, false);
  }
  assert.equal(insertsGitee, 1, '当前只有本包插入 gitee（devops 的补丁层不得偷偷插入本包）');
});
