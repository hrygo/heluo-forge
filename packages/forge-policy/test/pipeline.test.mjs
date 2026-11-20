import assert from 'node:assert/strict';
import test from 'node:test';

import { STAGE, activeRules, buildPipeline, isObserveOnly } from '../src/pipeline.mjs';

test('the stage table keeps the full 0–10 order', () => {
  assert.deepEqual(Object.keys(STAGE), [
    'RESOLVE', 'DELEGATION', 'IDENTITY', 'UNKNOWN_ACTION', 'HUMAN_RECORD',
    'PROTECTED_PATHS', 'PROCESS_RULES', 'CONTENT_GATE', 'CONFIRMATION', 'AUDIT', 'RECEIPT',
  ]);
  assert.equal(Object.isFrozen(STAGE), true);
});

test('all-off assembles only the four always-on stages', () => {
  const pipeline = buildPipeline();
  assert.deepEqual(pipeline.map((stage) => stage.stage), ['resolve', 'identity', 'audit', 'receipt']);
  for (const stage of pipeline) {
    assert.equal(stage.rule, null);
    assert.equal(Object.isFrozen(stage), true);
  }
  assert.equal(Object.isFrozen(pipeline), true);
  assert.deepEqual(activeRules(), []);
  assert.equal(isObserveOnly(), true);
});

test('an unimplemented switch never generates a stage (closed rules stay closed)', () => {
  // 配置层已经拒绝打开这些开关；流水线是纯函数，也必须不因入参为 true 就多出阶段。
  for (const rules of [
    { denyDelegatedWrites: true },
    { denyUnknownAction: true },
    { denyHumanRecord: true },
    { protectPaths: true },
    { enforceProcessRules: true },
    { contentGate: true },
    { confirmPush: true },
    { confirmDopWrite: true },
    { confirmPush: true, confirmDopWrite: true },
  ]) {
    assert.deepEqual(buildPipeline(rules).map((stage) => stage.stage), ['resolve', 'identity', 'audit', 'receipt']);
    assert.deepEqual(activeRules(rules), []);
    assert.equal(isObserveOnly(rules), true);
  }
});

test('unknown or non-boolean switches are ignored by the pipeline', () => {
  assert.deepEqual(activeRules({ confirmPush: 'yes', nope: true }), []);
  assert.deepEqual(buildPipeline({ confirmPush: 'yes' }).map((stage) => stage.stage), ['resolve', 'identity', 'audit', 'receipt']);
});
