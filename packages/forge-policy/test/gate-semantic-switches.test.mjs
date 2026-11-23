import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAuditBarrier, createMemorySink } from '../src/audit.mjs';
import { createGate } from '../src/gate.mjs';

// P3 · 三个语义开关（denyUnknownAction / denyHumanRecord / protectPaths）在门禁里的
// 判定顺序与"关闭时静默"性质：未登记读动作、未知工具名、关闭态都不读身份、不写审计。
const ISSUE = 'gitee.issue.write';
const HUMAN = 'gitee.review.record';
const UNREGISTERED_WRITE = 'gitee.pr.write';
const READ = 'change.read';

const TOOLS = {
  forge_issue_write: ISSUE,
  forge_review_record: HUMAN,
  forge_pr_write: UNREGISTERED_WRITE,
  forge_read: READ,
};

function gateFor({ rules = {}, tools = TOOLS, catalogActions = [ISSUE, HUMAN], catalog } = {}) {
  const sink = createMemorySink({ buffer: 50 });
  const compiled = catalog === undefined
    ? new Map(catalogActions.map((action) => [action, Object.freeze({
      action,
      target: action === HUMAN ? 'pull-request' : 'issue',
      category: action === HUMAN ? 'human-record' : 'dev-write',
      decision: 'allow',
    })]))
    : catalog;
  const identityCalls = { count: 0 };
  const gate = createGate({
    catalog: compiled,
    tools,
    rules,
    audit: createAuditBarrier({ sink }),
    getActor: () => {
      identityCalls.count += 1;
      return 'svc-policy-test';
    },
  });
  return { gate, sink, identityCalls };
}

function execFor(name, args, { cwd, callId = 'c1' } = {}) {
  return {
    name,
    arguments: args,
    callId,
    agent: { kind: 'agent', session: { header: { cwd } } },
    signal: new AbortController().signal,
  };
}

const denies = (sink) => sink.records().filter((record) => record.decision === 'deny');

test('全关时未登记写动作出闸放行：不读身份、不写审计、不生成拒绝', async () => {
  const { gate, sink, identityCalls } = gateFor();
  const decision = await gate.preExecute({}, execFor('forge_pr_write', { target: 'acme/demo!1' }));
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(identityCalls.count, 0);
  assert.deepEqual(sink.records(), []);
});

test('denyUnknownAction 打开后只收紧写与不可分类的动作', async () => {
  const { gate, sink, identityCalls } = gateFor({ rules: { denyUnknownAction: true } });
  const write = await gate.preExecute({}, execFor('forge_pr_write', { target: 'acme/demo!1', body: 'private body' }));
  assert.equal(write.kind, 'deny');
  assert.equal(write.code, 'POLICY_UNREGISTERED_ACTION');
  assert.match(String(write.reason), /默认放行，开启后未登记即拒/u);
  assert.equal(String(write.reason).includes('private body'), false);

  const records = denies(sink);
  assert.equal(records.length, 1);
  assert.equal(records[0].rule, 'denyUnknownAction');
  assert.equal('params' in records[0], false);

  // 未登记读动作仍出闸：不算"写入"，不读身份、不写审计。
  const read = await gate.preExecute({}, execFor('forge_read', { target: 'C-1' }));
  assert.deepEqual(read, { kind: 'allow' });
  assert.equal(identityCalls.count, 1, 'the deny read the identity; the read did not');
  assert.equal(denies(sink).length, 1);

  // 工具名不在映射里：不是策略动作，直接放行。
  const unknownTool = await gate.preExecute({}, execFor('forge_unknown', { target: 'x' }));
  assert.deepEqual(unknownTool, { kind: 'allow' });
});

test('映射了但分类不出的动作按未登记写处理', async () => {
  const { gate, sink } = gateFor({
    rules: { denyUnknownAction: true },
    tools: { demo_write: 'custom.unclassified' },
  });
  const decision = await gate.preExecute({}, execFor('demo_write', { target: 'acme/demo' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.code, 'POLICY_UNREGISTERED_ACTION');
  assert.equal(denies(sink)[0].rule, 'denyUnknownAction');
});

test('目录不可用时 fail closed，连读动作也不放行', async () => {
  const { gate, identityCalls } = gateFor({ catalog: null });
  const decision = await gate.preExecute({}, execFor('forge_issue_write', { target: 'acme/demo!1' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.code, 'POLICY_CATALOG_UNAVAILABLE');
  assert.equal(identityCalls.count, 0);
});

test('denyHumanRecord 命中即拒绝：不执行、不弹卡、不留正文', async () => {
  const { gate, sink } = gateFor({ rules: { denyHumanRecord: true, contentGate: true } });
  const decision = await gate.preExecute(
    {},
    execFor('forge_review_record', { target: 'acme/demo!2', body: 'looks good to me' }),
    () => { throw new Error('a denied human record must not reach the content gate'); },
  );
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.code, 'POLICY_HUMAN_RECORD');
  assert.match(String(decision.reason), /人工评审结论必须由人做出/u);
  const records = denies(sink);
  assert.equal(records.length, 1);
  assert.equal(records[0].rule, 'denyHumanRecord');
  assert.equal(JSON.stringify(records[0]).includes('looks good to me'), false);
  assert.equal('params' in records[0], false);
  assert.equal(gate.confirmationCount(), 0);
});

test('denyHumanRecord 关闭时人工留痕放行且照常写审计', async () => {
  const { gate, sink } = gateFor();
  const exec = execFor('forge_review_record', { target: 'acme/demo!2' });
  const decision = await gate.preExecute({}, exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'allow');
  await gate.postExecute(exec, { isError: false });
  const records = sink.records();
  assert.ok(records.length >= 2, 'begin and settle records');
  assert.equal(records.filter((record) => record.decision === 'deny').length, 0);
  assert.ok(records.every((record) => record.rule !== 'denyHumanRecord'));
});

test('三个开关同时打开时按 未登记 → 人工留痕 → 受保护路径 的顺序归因', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-policy-switches-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { gate, sink } = gateFor({ rules: { denyUnknownAction: true, denyHumanRecord: true, protectPaths: true } });

  const unregistered = await gate.preExecute({}, execFor('forge_pr_write', { target: 'acme/demo!1', path: join(workspace, '.env') }, { cwd: workspace }));
  assert.equal(unregistered.code, 'POLICY_UNREGISTERED_ACTION');

  const human = await gate.preExecute({}, execFor('forge_review_record', { target: 'acme/demo!2', path: join(workspace, '.env') }, { cwd: workspace, callId: 'c2' }));
  assert.equal(human.code, 'POLICY_HUMAN_RECORD');

  const registered = await gate.preExecute({}, execFor('forge_issue_write', { target: 'acme/demo!1', path: join(workspace, '.env') }, { cwd: workspace, callId: 'c3' }));
  assert.equal(registered.code, 'POLICY_PROTECTED_PATH');

  const records = denies(sink);
  assert.deepEqual(records.map((record) => record.rule), ['denyUnknownAction', 'denyHumanRecord', 'protectPaths']);
  for (const record of records) assert.equal(record.action !== undefined, true);
});

test('开关关闭时结果里不会出现"已阻止"或任何拒绝码', async () => {
  const { gate } = gateFor();
  for (const [name, args] of [
    ['forge_pr_write', { target: 'acme/demo!1' }],
    ['forge_review_record', { target: 'acme/demo!2' }],
    ['forge_issue_write', { target: 'acme/demo!1' }],
  ]) {
    const decision = await gate.preExecute({}, execFor(name, args));
    assert.equal(decision.kind, 'allow');
    assert.equal(decision.code, undefined);
    assert.equal(/已阻止|已拒绝/u.test(String(decision.reason ?? '')), false);
  }
});

test('未登记的人工留痕动作按人工留痕拒绝，不会被误报成未登记', async () => {
  // 两个开关都开、动作没进目录，但分类表认得它是 human-record：
  // 结论必须与 catalog.decideAction 一致（先判人工留痕），否则人看到的原因会指错方向。
  const { gate, sink } = gateFor({
    rules: { denyHumanRecord: true, denyUnknownAction: true },
    catalogActions: [ISSUE],
  });
  const decision = await gate.preExecute({}, execFor('forge_review_record', { target: 'acme/demo!1' }));
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.code, 'POLICY_HUMAN_RECORD');
  assert.equal(denies(sink)[0].rule, 'denyHumanRecord');
});

test('语义拒绝的证据里，路径形状的 target 只留尾四段', async () => {
  const { gate, sink } = gateFor({ rules: { denyUnknownAction: true } });
  const target = ['', 'Users', 'svc', 'private', 'secret', 'notes.env'].join('/');
  const decision = await gate.preExecute({}, execFor('forge_pr_write', { target }));
  assert.equal(decision.kind, 'deny');
  const record = denies(sink)[0];
  assert.equal(record.target, ['svc', 'private', 'secret', 'notes.env'].join('/'));
  assert.equal(JSON.stringify(record).includes(['', 'Users'].join('/')), false);
});
