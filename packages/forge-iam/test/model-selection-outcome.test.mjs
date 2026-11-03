import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelSelection, MODEL_SELECTION_REASONS } from '../src/model-gate.mjs';

const target = { provider: 'enterprise', model: 'corp-default' };
const original = { provider: 'disabled-official', model: 'old-default' };
const sentinel = 'SYNTHETIC_PRIVATE_SDK_SENTINEL';

// Recording-only settings stand-in: no Host, network, filesystem or real SDK writes.
function recordingSettings({ failSave = false, commitBeforeFailure = false, thrown,
  failReadAt = 0, afterRead } = {}) {
  const state = { stored: { ...original }, reads: 0, writes: 0 };
  return {
    state,
    readSelection() {
      state.reads++;
      if (state.reads === failReadAt) throw thrown;
      if (state.reads > 1 && afterRead !== undefined) state.stored = afterRead;
      return state.stored;
    },
    async saveSelection(next) {
      state.writes++;
      if (!failSave || commitBeforeFailure) state.stored = { ...next };
      if (failSave) throw thrown;
    },
  };
}

function apply(settings, extra = {}) {
  return applyModelSelection({
    decision: { allow: true, switchTo: { ...target } },
    enterprise: target,
    readSelection: settings.readSelection,
    saveSelection: settings.saveSelection,
    ...extra,
  });
}

function assertNoPrivateOutput(result) {
  assert.equal(JSON.stringify(result).includes(sentinel), false, 'SDK private text must not reach the result');
}

function assertNotes(result, expected) {
  assert.equal(JSON.stringify(result.notes) === JSON.stringify([expected]), true, 'notes must be fixed safe text');
}

function assertOriginalTarget(result) {
  assert.equal(result.attempted?.provider === target.provider && result.attempted?.model === target.model,
    true, 'attempted must preserve the original target');
}

for (const commitBeforeFailure of [false, true]) {
  for (const kind of ['Error', 'undefined']) {
    test(`save rejection has unknown outcome without retry/readback: commit=${commitBeforeFailure}, thrown=${kind}`, async () => {
      const settings = recordingSettings({ failSave: true, commitBeforeFailure,
        thrown: kind === 'Error' ? new Error(sentinel) : undefined });
      const result = await apply(settings);
      assert.deepEqual(settings.state.stored, commitBeforeFailure ? target : original);
      assert.equal(settings.state.writes, 1);
      assert.equal(settings.state.reads, 1, 'do not infer this write outcome from a later shared read');
      assert.equal(result.written, null);
      assert.equal(result.verified, false);
      assert.equal(result.reason, MODEL_SELECTION_REASONS.WRITE_FAILED);
      assertOriginalTarget(result);
      assert.equal(Object.isFrozen(result.attempted), true);
      assertNotes(result, '写入调用失败，持久化结果未知；不自动重试或补偿');
      assertNoPrivateOutput(result);
    });
  }
}

for (const kind of ['Error', 'undefined']) {
  test(`initial read failure remains a genuine no-write with fixed notes: thrown=${kind}`, async () => {
    const settings = recordingSettings({ failReadAt: 1, thrown: kind === 'Error' ? new Error(sentinel) : undefined });
    const result = await apply(settings);
    assert.equal(result.written, false);
    assert.equal(result.verified, false);
    assert.equal(result.attempted, undefined);
    assert.equal(result.reason, MODEL_SELECTION_REASONS.NO_WRITE_UNPROVABLE_SELECTION);
    assert.equal(settings.state.writes, 0);
    assert.equal(settings.state.reads, 1);
    assert.deepEqual(settings.state.stored, original);
    assertNotes(result, '读取当前选择失败，未调用写入');
    assertNoPrivateOutput(result);
  });

  test(`fulfilled save followed by read failure is unverified without leaking SDK text: thrown=${kind}`, async () => {
    const settings = recordingSettings({ failReadAt: 2, thrown: kind === 'Error' ? new Error(sentinel) : undefined });
    const result = await apply(settings);
    assert.equal(result.written, true);
    assert.equal(result.verified, false);
    assertOriginalTarget(result);
    assert.equal(result.reason, MODEL_SELECTION_REASONS.WRITE_UNVERIFIED);
    assert.equal(settings.state.writes, 1);
    assert.equal(settings.state.reads, 2);
    assert.deepEqual(settings.state.stored, target);
    assertNotes(result, '写入调用已返回，但回读失败，持久化结果未验证');
    assertNoPrivateOutput(result);
  });
}

for (const afterRead of [{ provider: sentinel, model: `${sentinel}-model` }, null, 42]) {
  test(`readback ${afterRead === null ? 'null' : typeof afterRead} mismatch is fixed-text and never compensates`, async () => {
    const settings = recordingSettings({ afterRead });
    const result = await apply(settings);
    assert.equal(result.written, true);
    assert.equal(result.verified, false);
    assertOriginalTarget(result);
    assert.equal(result.reason, MODEL_SELECTION_REASONS.WRITE_UNVERIFIED);
    assert.equal(settings.state.writes, 1);
    assert.equal(settings.state.reads, 2);
    assert.equal(settings.state.stored === afterRead, true, 'do not overwrite a later shared selection');
    assertNotes(result, '写入调用已返回，但回读不一致，持久化结果未验证');
    assertNoPrivateOutput(result);
  });
}

test('fulfilled save without a reader does not claim durable storage', async () => {
  const settings = recordingSettings();
  const result = await apply(settings, { readSelection: undefined, currentSelection: original });
  assert.equal(result.written, true);
  assert.equal(result.verified, false);
  assert.equal(result.reason, MODEL_SELECTION_REASONS.WRITTEN);
  assertOriginalTarget(result);
  assert.equal(settings.state.writes, 1);
  assert.equal(settings.state.reads, 0);
  assertNotes(result, '写入调用已返回，但未回读验证；不证明持久化完成');
});

test('fulfilled save and equal readback only prove immediate agreement, not durability', async () => {
  const settings = recordingSettings();
  const result = await apply(settings);
  assert.equal(result.written, true);
  assert.equal(result.verified, true);
  assert.equal(result.reason, MODEL_SELECTION_REASONS.WRITTEN);
  assertOriginalTarget(result);
  assert.equal(settings.state.writes, 1);
  assert.equal(settings.state.reads, 2);
  assertNotes(result, '写入调用已返回并回读一致；不证明持久化完成');
});

test('attempted target stays the original request when caller changes its decision during save', async () => {
  const settings = recordingSettings();
  const decision = { allow: true, switchTo: { ...target } };
  const result = await apply(settings, {
    decision,
    saveSelection(next) {
      const saving = settings.saveSelection(next);
      decision.switchTo.provider = sentinel;
      decision.switchTo.model = `${sentinel}-model`;
      return saving;
    },
  });
  assert.deepEqual(settings.state.stored, target);
  assertOriginalTarget(result);
  assert.equal(result.written, true);
  assert.equal(result.verified, true);
  assert.equal(settings.state.writes, 1);
  assert.equal(settings.state.reads, 2);
  assertNoPrivateOutput(result);
});

for (const decision of [{ allow: false }, { allow: true }]) {
  test(`skipped decision never claims a write: allow=${decision.allow}`, async () => {
    const settings = recordingSettings();
    const result = await apply(settings, { decision });
    assert.equal(result.written, false);
    assert.equal(result.verified, false);
    assert.equal(result.attempted, undefined);
    assert.equal(settings.state.writes, 0);
    assert.equal(settings.state.reads, 1);
    assert.deepEqual(settings.state.stored, original);
  });
}
