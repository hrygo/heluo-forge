import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAuditBarrier, createMemorySink } from '../src/audit.mjs';
import { createGate } from '../src/gate.mjs';
import { resolveProtectedRoots } from '../src/paths.mjs';

// P3 · 门禁里的受保护路径阶段：命中即拒绝并留一条证据；工作区外的路径不判；
// 判不了（作用域缺失/循环链接/候选超限）一律 fail closed，文案不带路径与 errno。
const POSIX = process.platform !== 'win32';
const ACTION = 'gitee.issue.write';

function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'forge-policy-gate-paths-'));
  mkdirSync(join(workspace, 'sub'));
  writeFileSync(join(workspace, '.env'), 'SECRET=fixture\n');
  writeFileSync(join(workspace, 'notes.txt'), 'notes\n');
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function gateFor({ rules = {}, protectedRoots = [] } = {}) {
  const sink = createMemorySink({ buffer: 50 });
  const audit = createAuditBarrier({ sink });
  const gate = createGate({
    catalog: new Map([[ACTION, Object.freeze({ action: ACTION, target: 'issue', category: 'dev-write', decision: 'allow' })]]),
    tools: { demo_write: ACTION },
    rules,
    audit,
    getActor: () => 'svc-policy-test',
    protectedRoots,
  });
  return { gate, sink };
}

function execFor(args, { cwd, name = 'demo_write', callId = 'c1' } = {}) {
  return {
    name,
    arguments: args,
    callId,
    agent: { kind: 'agent', session: { header: { cwd } } },
    signal: new AbortController().signal,
  };
}

async function pre(gate, exec) {
  return gate.preExecute({}, exec);
}

const denyRecords = (sink) => sink.records().filter((record) => record.decision === 'deny');

test('关闭时既不生成路径阶段，也不看路径参数', async (t) => {
  const workspace = fixture(t);
  const { gate, sink } = gateFor();
  assert.equal(gate.stages.some((stage) => stage.stage === 'protected-paths'), false);
  const decision = await pre(gate, execFor({ target: 'acme/demo!1', path: join(workspace, '.env') }, { cwd: workspace }));
  assert.equal(decision.kind, 'allow');
  assert.equal(denyRecords(sink).length, 0);
});

test('工作区内的受保护文件被拒绝，证据只写类别不写路径', async (t) => {
  const workspace = fixture(t);
  const { gate, sink } = gateFor({ rules: { protectPaths: true } });
  const decision = await gate.preExecute(
    {},
    execFor({ target: 'acme/demo!1', path: join(workspace, 'sub', '..', '.env') }, { cwd: workspace }),
    () => { throw new Error('downstream must not run when the path stage denies'); },
  );

  assert.equal(decision.kind, 'deny');
  assert.equal(decision.code, 'POLICY_PROTECTED_PATH');
  assert.match(String(decision.reason), /受保护路径规则拒绝/u);
  assert.match(String(decision.reason), /命中了受保护文件类别 \.env/u);
  assert.equal(String(decision.reason).includes(workspace), false, 'the copy must not carry the absolute path');

  const records = denyRecords(sink);
  assert.equal(records.length, 1, 'one deny, one evidence record');
  assert.equal(records[0].rule, 'protectPaths');
  assert.deepEqual(records[0].ruleIds, ['name:.env']);
  assert.equal(JSON.stringify(records[0]).includes(workspace), false);
  assert.equal('params' in records[0], false);
});

test('普通文件与工作区外的路径都放行（路径规则只判命中项）', async (t) => {
  const workspace = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'forge-policy-gate-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const { gate, sink } = gateFor({ rules: { protectPaths: true } });

  assert.equal((await pre(gate, execFor({ target: 'acme/demo!1', path: join(workspace, 'notes.txt') }, { cwd: workspace }))).kind, 'allow');
  const outsideDecision = await pre(gate, execFor({ target: 'acme/demo!1', path: join(outside, '.env') }, { cwd: workspace }));
  assert.equal(outsideDecision.kind, 'allow', 'outside the scope no path judgement is made');
  assert.equal(denyRecords(sink).length, 0);
});

test('相对参数按会话工作区解释，符号链接不能洗白目标', async (t) => {
  const workspace = fixture(t);
  const { gate, sink } = gateFor({ rules: { protectPaths: true } });
  const relative = await pre(gate, execFor({ target: 'acme/demo!1', file: './sub/../.env' }, { cwd: workspace }));
  assert.equal(relative.kind, 'deny');
  assert.equal(relative.code, 'POLICY_PROTECTED_PATH');

  if (POSIX) {
    symlinkSync(join(workspace, '.env'), join(workspace, 'sub', 'innocent.txt'));
    const link = await pre(gate, execFor({ target: 'acme/demo!1', path: join(workspace, 'sub', 'innocent.txt') }, { cwd: workspace }));
    assert.equal(link.kind, 'deny');
    assert.equal(link.code, 'POLICY_PROTECTED_PATH');
  }
  assert.equal(denyRecords(sink).length, POSIX ? 2 : 1);
});

test('确认型动作在路径阶段先被拒绝，不会弹确认卡', async (t) => {
  const workspace = fixture(t);
  let asked = 0;
  const sink = createMemorySink({ buffer: 50 });
  const gate = createGate({
    catalog: new Map([['gitee.git.push', Object.freeze({ action: 'gitee.git.push', target: 'repository', category: 'remote-write', decision: 'confirm' })]]),
    tools: { demo_push: 'gitee.git.push' },
    rules: { protectPaths: true, confirmPush: true },
    audit: createAuditBarrier({ sink }),
    getActor: () => 'svc-policy-test',
    confirmations: { ask: async () => { asked += 1; return 'approved'; } },
  });
  const decision = await gate.preExecute(
    {},
    execFor({ target: 'acme/demo', path: join(workspace, '.env') }, { cwd: workspace, name: 'demo_push' }),
    () => Promise.resolve({ kind: 'allow' }),
  );
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.code, 'POLICY_PROTECTED_PATH');
  assert.equal(asked, 0, 'the confirmation card must not be shown for a denied path');
  assert.equal(gate.confirmationCount(), 0);
});

test('配置追加的根用模板标记命中，类别不是绝对路径', async (t) => {
  const workspace = fixture(t);
  const vault = mkdtempSync(join(tmpdir(), 'forge-policy-gate-vault-'));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  writeFileSync(join(vault, 'notes.txt'), 'vault note\n');
  const template = `${vault}/**`;
  const { gate, sink } = gateFor({ rules: { protectPaths: true }, protectedRoots: resolveProtectedRoots([template]) });

  const decision = await pre(gate, execFor({ target: 'acme/demo!1', path: join(vault, 'notes.txt') }, { cwd: workspace }));
  assert.equal(decision.kind, 'deny');
  assert.match(String(decision.reason), /配置追加的保护范围/u);
  assert.deepEqual(denyRecords(sink)[0].ruleIds, [`root:${template}`]);
});

test('缺少会话工作区、循环链接或候选超限都按无法判定拒绝', async (t) => {
  const workspace = fixture(t);
  const { gate, sink } = gateFor({ rules: { protectPaths: true } });

  const noScope = await pre(gate, execFor({ target: 'acme/demo!1', path: join(workspace, '.env') }));
  assert.equal(noScope.kind, 'deny');
  assert.equal(noScope.code, 'POLICY_PATH_SCOPE_UNAVAILABLE');
  assert.equal(String(noScope.reason).includes(workspace), false);

  if (POSIX) {
    symlinkSync(join(workspace, 'loop-b'), join(workspace, 'loop-a'));
    symlinkSync(join(workspace, 'loop-a'), join(workspace, 'loop-b'));
    const looped = await pre(gate, execFor({ target: 'acme/demo!1', path: join(workspace, 'loop-a') }, { cwd: workspace }));
    assert.equal(looped.kind, 'deny');
    assert.equal(looped.code, 'POLICY_PATH_UNRESOLVABLE');
  }

  const tooMany = await pre(gate, execFor(
    { target: 'acme/demo!1', file: Array.from({ length: 40 }, (_, index) => join(workspace, `f-${index}.env`)) },
    { cwd: workspace },
  ));
  assert.equal(tooMany.kind, 'deny');
  assert.equal(tooMany.code, 'POLICY_PATH_UNRESOLVABLE');
  assert.ok(denyRecords(sink).length >= 2);
});
