import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyModelSelection,
  evaluateModelGate,
  MODEL_SELECTION_REASONS,
  ModelGateError,
} from '../src/model-gate.mjs';

const enterprise = { provider: 'enterprise', model: 'corp-default' };
const officialSelection = { provider: 'deepseek-official', model: 'deepseek-flash', explicit: true };
const availableProviders = ['enterprise'];
const disabledProviders = ['deepseek-official'];

const switchDecision = (selection) =>
  evaluateModelGate({
    signedIn: true,
    gatewayCredential: 'present',
    enterprise,
    selection,
    availableProviders,
    disabledProviders,
  });

test('当前指向已禁用模型时写入企业模型并回读验证', async () => {
  const writes = [];
  let stored = officialSelection;
  const result = await applyModelSelection({
    decision: switchDecision(officialSelection),
    readSelection: () => stored,
    saveSelection: (target) => {
      writes.push(target);
      stored = { ...target, explicit: false };
    },
    enterprise,
    availableProviders,
    disabledProviders,
  });
  assert.equal(result.written, true);
  assert.equal(result.verified, true);
  assert.equal(result.reason, MODEL_SELECTION_REASONS.WRITTEN);
  assert.deepEqual(writes, [{ provider: 'enterprise', model: 'corp-default' }]);
});

test('绝不覆盖用户显式选择的企业模型（即使判定要求切换）', async () => {
  const writes = [];
  const result = await applyModelSelection({
    // 故意传一个"要求切换到另一模型"的判定，写入接线必须自己挡住。
    decision: { allow: true, switchTo: { provider: 'enterprise', model: 'another-model' }, reason: 'forged' },
    currentSelection: { provider: 'enterprise', model: 'corp-default', explicit: true },
    saveSelection: (target) => writes.push(target),
    enterprise: { provider: 'enterprise', model: 'corp-default' },
    availableProviders,
    disabledProviders,
  });
  assert.equal(result.written, false);
  assert.equal(result.reason, MODEL_SELECTION_REASONS.NO_WRITE_KEEP_EXPLICIT);
  assert.deepEqual(writes, []);
});

test('显式选择仍可用的非企业模型也不被静默覆盖', async () => {
  const writes = [];
  const result = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise, reason: 'forged' },
    currentSelection: { provider: 'other-corp', model: 'x', explicit: true },
    saveSelection: (target) => writes.push(target),
    availableProviders: ['enterprise', 'other-corp'],
    disabledProviders,
  });
  assert.equal(result.reason, MODEL_SELECTION_REASONS.NO_WRITE_KEEP_EXPLICIT);
  assert.deepEqual(writes, []);
});

test('判定拒绝、无目标、已是目标模型都不写', async () => {
  const writes = [];
  const saveSelection = (target) => writes.push(target);
  const denied = await applyModelSelection({
    decision: { allow: false, reason: 'not-signed-in' },
    currentSelection: officialSelection,
    saveSelection,
    enterprise,
    availableProviders,
    disabledProviders,
  });
  assert.equal(denied.reason, MODEL_SELECTION_REASONS.NO_WRITE_GATE_DENIED);

  const noTarget = await applyModelSelection({
    decision: { allow: true, reason: 'keep-explicit-enterprise' },
    currentSelection: officialSelection,
    saveSelection,
    enterprise,
    availableProviders,
    disabledProviders,
  });
  assert.equal(noTarget.reason, MODEL_SELECTION_REASONS.NO_WRITE_NO_TARGET);

  const already = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise, reason: 'idempotent' },
    currentSelection: { provider: 'enterprise', model: 'corp-default', explicit: false },
    saveSelection,
    enterprise,
    availableProviders,
    disabledProviders,
  });
  assert.equal(already.reason, MODEL_SELECTION_REASONS.NO_WRITE_ALREADY_ENTERPRISE);
  assert.deepEqual(writes, []);
});

test('无法证明当前选择时不写', async () => {
  const writes = [];
  const unreadable = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise },
    readSelection: () => {
      throw new Error('settings unavailable');
    },
    saveSelection: (target) => writes.push(target),
    enterprise,
  });
  assert.equal(unreadable.written, false);
  assert.equal(unreadable.reason, MODEL_SELECTION_REASONS.NO_WRITE_UNPROVABLE_SELECTION);

  const junk = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise },
    currentSelection: { provider: 42 },
    saveSelection: (target) => writes.push(target),
    enterprise,
  });
  assert.equal(junk.reason, MODEL_SELECTION_REASONS.NO_WRITE_UNPROVABLE_SELECTION);
  assert.deepEqual(writes, []);
});

test('写入失败与写入后回读不一致都如实报告，不谎报成功', async () => {
  const failed = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise },
    currentSelection: officialSelection,
    saveSelection: () => {
      throw new Error('read-only settings');
    },
    enterprise,
    availableProviders,
    disabledProviders,
  });
  assert.equal(failed.written, false);
  assert.equal(failed.reason, MODEL_SELECTION_REASONS.WRITE_FAILED);

  const mismatched = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise },
    currentSelection: officialSelection,
    saveSelection: () => {},
    readSelection: () => ({ provider: 'enterprise', model: 'something-else' }),
    enterprise,
    availableProviders,
    disabledProviders,
  });
  assert.equal(mismatched.written, true);
  assert.equal(mismatched.verified, false);
  assert.equal(mismatched.reason, MODEL_SELECTION_REASONS.WRITE_UNVERIFIED);

  const unreadableAfter = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise },
    readSelection: () => {
      throw new Error('gone');
    },
    saveSelection: () => {},
    enterprise,
  });
  assert.equal(unreadableAfter.reason, MODEL_SELECTION_REASONS.NO_WRITE_UNPROVABLE_SELECTION);

  let reads = 0;
  const afterWriteUnreadable = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise },
    readSelection: () => {
      reads += 1;
      if (reads > 1) throw new Error('settings vanished');
      return officialSelection;
    },
    saveSelection: () => {},
    enterprise,
  });
  assert.equal(afterWriteUnreadable.written, true);
  assert.equal(afterWriteUnreadable.verified, false);
  assert.equal(afterWriteUnreadable.reason, MODEL_SELECTION_REASONS.WRITE_UNVERIFIED);
  assert.match(afterWriteUnreadable.notes.join(' '), /回读失败/);

  const noReader = await applyModelSelection({
    decision: { allow: true, switchTo: enterprise },
    currentSelection: officialSelection,
    saveSelection: () => {},
    enterprise,
    availableProviders,
    disabledProviders,
  });
  assert.equal(noReader.written, true);
  assert.equal(noReader.verified, false);
  assert.match(noReader.notes.join(' '), /未回读验证/);
});

test('非法输入直接报错', async () => {
  await assert.rejects(() => applyModelSelection(null), (error) => error instanceof ModelGateError && error.code === 'MODEL_GATE_INPUT_INVALID');
  await assert.rejects(() => applyModelSelection({ decision: {}, saveSelection: () => {} }), (error) => error.code === 'MODEL_GATE_INPUT_INVALID');
  await assert.rejects(() => applyModelSelection({ decision: { allow: true } }), (error) => error.code === 'MODEL_GATE_INPUT_INVALID');
  await assert.rejects(
    () => applyModelSelection({ decision: { allow: true }, saveSelection: () => {}, enterprise: { provider: 'x' } }),
    (error) => error.code === 'MODEL_GATE_INPUT_INVALID',
  );
  await assert.rejects(
    () => applyModelSelection({ decision: { allow: true }, saveSelection: () => {}, readSelection: 42 }),
    (error) => error.code === 'MODEL_GATE_INPUT_INVALID',
  );
});
