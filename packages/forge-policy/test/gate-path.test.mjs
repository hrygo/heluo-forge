import assert from 'node:assert/strict';
import test from 'node:test';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../src/gate.mjs';
import { createAuditBarrier, createMemorySink } from '../src/audit.mjs';
import { resolveConfig } from '../src/config.mjs';
import { buildPipeline } from '../src/pipeline.mjs';

// P3 起路径规则已接入：关闭时路径参数被完全忽略；开启后配置可解析、流水线有路径阶段，
// 具体判定由 gate-protected-paths.test.mjs 覆盖。
const ACTION = 'gitee.issue.write';
const CATALOG = new Map([[ACTION, Object.freeze({ action: ACTION, target: 'issue', category: 'dev-write', decision: 'allow' })]]);

function gateWith() {
  const audit = createAuditBarrier({ sink: createMemorySink({ buffer: 8 }) });
  return createGate({
    catalog: CATALOG,
    tools: { demo_write: ACTION },
    rules: {},
    audit,
    getActor: () => 'svc-policy-test',
  });
}

function writeExec() {
  return {
    name: 'demo_write',
    arguments: { target: join(tmpdir(), 'secret.txt') },
    callId: 'c1',
    agent: { kind: 'agent' },
    signal: new AbortController().signal,
  };
}

test('关闭路径规则时，门禁没有路径阶段也不看路径参数', async () => {
  const gate = gateWith();
  const exec = writeExec();
  const decision = await gate.preExecute({}, exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'allow');
  assert.equal(gate.stages.some((stage) => stage.stage === 'protected-paths'), false);
  assert.equal(gate.guard(exec), undefined);
});

test('开启路径规则后配置可解析，流水线按顺序装配路径阶段', () => {
  const config = resolveConfig({ catalog: [], rules: { protectPaths: true } });
  assert.equal(config.rules.protectPaths, true);
  assert.deepEqual(
    buildPipeline(config.rules).map((stage) => stage.stage),
    ['resolve', 'identity', 'protected-paths', 'audit', 'receipt'],
  );
});

test('结清后不再持有执行对象：pendingAdmissions 回到 0', async () => {
  // 评审 P2：`admitted` 只该在"已放行、未结清"之间挡住同一个 callId，
  // 结清后仍留着会把执行对象（含正文）一直强引用到插件卸载。
  const gate = gateWith();
  const exec = writeExec();
  const pre = await gate.preExecute({}, exec, () => Promise.resolve({ kind: 'allow' }));
  assert.equal(pre.kind, 'allow');
  assert.equal(gate.pendingAdmissions(), 1, '放行后到结清前必须被追踪');

  await gate.postExecute(exec, { isError: false });
  assert.equal(gate.pendingAdmissions(), 0, '结清后必须释放');
});
