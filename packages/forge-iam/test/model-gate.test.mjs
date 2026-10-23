import assert from 'node:assert/strict';
import test from 'node:test';

import { describeModelGateInput, evaluateModelGate, ModelGateError, MODEL_GATE_REASONS } from '../src/model-gate.mjs';

const enterprise = { provider: 'enterprise-uag', model: 'corp-chat' };
const available = ['enterprise-uag'];
const ready = { signedIn: true, gatewayCredential: 'present', enterprise, availableProviders: available, disabledProviders: ['deepseek'] };

test('未登录一律拒绝，官方 API Key 与本地模型都不构成旁路', () => {
  const decision = evaluateModelGate({ ...ready, signedIn: false, officialApiKeyPresent: true, selection: { provider: 'enterprise-uag', model: 'corp-chat' } });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, MODEL_GATE_REASONS.NOT_SIGNED_IN);
  assert.match(decision.notes.join(' '), /不构成旁路/);
  assert.equal(decision.switchTo, undefined, '未登录不给切换目标，避免把回落当兜底');

  const empty = evaluateModelGate();
  assert.equal(empty.allow, false);
  assert.equal(empty.reason, MODEL_GATE_REASONS.NOT_SIGNED_IN, '默认（空输入）必须是拒绝');
});

test('网关凭据缺失与无企业模型分别拒绝', () => {
  for (const credential of ['missing', 'unconfigured']) {
    const decision = evaluateModelGate({ ...ready, gatewayCredential: credential });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, MODEL_GATE_REASONS.GATEWAY_CREDENTIAL_MISSING);
  }
  const noEnterprise = evaluateModelGate({ ...ready, enterprise: undefined });
  assert.equal(noEnterprise.reason, MODEL_GATE_REASONS.NO_ENTERPRISE_MODEL);
  const disabledEnterprise = evaluateModelGate({ ...ready, disabledProviders: ['enterprise-uag', 'deepseek'] });
  assert.equal(disabledEnterprise.reason, MODEL_GATE_REASONS.ENTERPRISE_MODEL_UNAVAILABLE);
  const absentProvider = evaluateModelGate({ ...ready, availableProviders: [] });
  assert.equal(absentProvider.reason, MODEL_GATE_REASONS.ENTERPRISE_MODEL_UNAVAILABLE);
});

test('没有选择时切到企业模型', () => {
  const decision = evaluateModelGate(ready);
  assert.equal(decision.allow, true);
  assert.equal(decision.reason, MODEL_GATE_REASONS.SELECTION_ABSENT_SWITCHED);
  assert.deepEqual(decision.switchTo, enterprise);
});

test('指向已禁用官方模型时切换，且不覆盖显式企业选择', () => {
  const dangling = evaluateModelGate({ ...ready, selection: { provider: 'deepseek', model: 'deepseek-chat' } });
  assert.equal(dangling.allow, true);
  assert.equal(dangling.reason, MODEL_GATE_REASONS.SELECTION_DISABLED_SWITCHED);
  assert.deepEqual(dangling.switchTo, enterprise);

  const explicitSame = evaluateModelGate({ ...ready, selection: { ...enterprise, explicit: true } });
  assert.equal(explicitSame.allow, true);
  assert.equal(explicitSame.reason, MODEL_GATE_REASONS.KEEP_EXPLICIT_ENTERPRISE);
  assert.equal(explicitSame.switchTo, undefined, '不能覆盖用户已选企业模型');

  const explicitOther = evaluateModelGate({ ...ready, selection: { provider: 'enterprise-uag', model: 'corp-reasoner', explicit: true } });
  assert.equal(explicitOther.reason, MODEL_GATE_REASONS.KEEP_EXPLICIT_ENTERPRISE);
  assert.equal(explicitOther.switchTo, undefined);

  const implicitOther = evaluateModelGate({ ...ready, selection: { provider: 'enterprise-uag', model: 'corp-reasoner' } });
  assert.equal(implicitOther.reason, MODEL_GATE_REASONS.SELECTION_NOT_EXPLICIT_SWITCHED);
  assert.deepEqual(implicitOther.switchTo, enterprise);
});

test('企业之外的提供方不静默放行', () => {
  // 该提供方本身可用，但不是企业模型：不静默改用，交企业侧开通裁定。
  const decision = evaluateModelGate({ ...ready, availableProviders: [...available, 'local-llama'], selection: { provider: 'local-llama', model: 'x', explicit: true } });
  const unavailableOther = evaluateModelGate({ ...ready, selection: { provider: 'third-party', model: 'x', explicit: true } });
  assert.equal(unavailableOther.reason, MODEL_GATE_REASONS.SELECTION_DISABLED_SWITCHED, '不可用的选择一律收敛到企业模型');
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, MODEL_GATE_REASONS.SELECTION_OUTSIDE_ENTERPRISE);
  assert.match(decision.notes.join(' '), /企业侧明确开通/);
});

test('输入不合法直接报错，而不是默默放行', () => {
  assert.throws(() => evaluateModelGate(null), (error) => error instanceof ModelGateError && error.code === 'MODEL_GATE_INPUT_INVALID');
  assert.throws(() => evaluateModelGate({ availableProviders: 'nope' }), (error) => error.code === 'MODEL_GATE_INPUT_INVALID');
  assert.throws(() => evaluateModelGate({ enterprise: { provider: 'x' } }), (error) => error.code === 'MODEL_GATE_INPUT_INVALID');
  assert.throws(() => evaluateModelGate({ selection: { provider: 'x' } }), (error) => error.code === 'MODEL_GATE_INPUT_INVALID');
});

test('输入摘要只含可公开事实', () => {
  const summary = describeModelGateInput({ signedIn: true, gatewayCredential: 'present', enterprise, selection: { provider: 'deepseek', model: 'x' }, availableProviders: available, disabledProviders: ['deepseek'], officialApiKeyPresent: true });
  assert.deepEqual(summary, {
    signedIn: true,
    gatewayCredential: 'present',
    enterpriseDeclared: true,
    selectionProvider: 'deepseek',
    availableProviders: ['enterprise-uag'],
    disabledProviders: ['deepseek'],
    officialApiKeyPresent: true,
  });
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});
