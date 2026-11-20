import assert from 'node:assert/strict';
import test from 'node:test';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../src/gate.mjs';
import { createAuditBarrier, createMemorySink } from '../src/audit.mjs';
import { resolveConfig } from '../src/config.mjs';

// P0 的受保护路径规则没有实现：目录只登记写动作，门禁里也不存在路径阶段。
// 这里锁定两点——关闭时路径参数被完全忽略；开启时挂载直接拒绝（fail closed）。
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

test('开启路径规则时挂载被拒绝，并指出具体配置键', () => {
  assert.throws(
    () => resolveConfig({ catalog: [], rules: { protectPaths: true } }),
    (error) => error.code === 'POLICY_CONFIG_INVALID' && /rules\.protectPaths/u.test(error.message),
  );
});
