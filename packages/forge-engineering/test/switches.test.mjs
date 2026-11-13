import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeSwitchInput,
  EnterpriseSwitchError,
  resolveSwitches,
  ROLE_PRESETS,
  SWITCH_IDS,
  SWITCH_REASONS,
} from '../src/switches.mjs';

const readyDeps = { policy: 'ready', iam: 'ready', audit: 'ready' };
const allCapabilities = { read: true, write: true, publish: true, review: true, observe: true };

test('空输入下五类开关全关且不冒称可用', () => {
  const result = resolveSwitches();
  assert.deepEqual(result.on, []);
  assert.deepEqual([...result.blocked], [...SWITCH_IDS], '依赖未表态时一律 blocked，而不是 off 当默认可用');
  for (const id of SWITCH_IDS) {
    assert.equal(result.switches[id].state, 'blocked');
    assert.equal(result.switches[id].serverAuthorization, 'required');
  }
});

test('硬依赖缺失一律关闭，且不降级为无审计只读', () => {
  const noPolicy = resolveSwitches({ dependencies: { ...readyDeps, policy: 'missing' }, capabilities: allCapabilities, approved: [...SWITCH_IDS] });
  assert.deepEqual(noPolicy.on, []);
  assert.ok(SWITCH_IDS.every((id) => noPolicy.switches[id].reason === SWITCH_REASONS.POLICY_NOT_READY));

  const noIdentity = resolveSwitches({ dependencies: { ...readyDeps, iam: 'missing' }, capabilities: allCapabilities, approved: [...SWITCH_IDS] });
  assert.deepEqual(noIdentity.on, []);
  assert.ok(SWITCH_IDS.every((id) => noIdentity.switches[id].reason === SWITCH_REASONS.IDENTITY_NOT_READY));

  const noAudit = resolveSwitches({ dependencies: { ...readyDeps, audit: 'unconfigured' }, capabilities: allCapabilities, approved: [...SWITCH_IDS] });
  assert.equal(noAudit.switches.read.state, 'blocked', '审计缺失时只读也必须关闭');
  assert.equal(noAudit.switches.read.reason, SWITCH_REASONS.NECESSARY_AUDIT_NOT_READY);
  assert.equal(noAudit.switches['research-write'].state, 'blocked');
  assert.equal(noAudit.switches.observe.state, 'off');
  assert.equal(noAudit.switches.observe.reason, SWITCH_REASONS.NO_EXPORT_SINK);
  assert.deepEqual(noAudit.on, []);
});

test('能力行未落地时是 blocked，不是假装可用', () => {
  const result = resolveSwitches({
    dependencies: readyDeps,
    capabilities: { read: true, observe: true },
    approved: [...SWITCH_IDS],
    c3Approved: true,
  });
  assert.equal(result.switches.read.state, 'on');
  assert.equal(result.switches.observe.state, 'on');
  assert.equal(result.switches['research-write'].state, 'blocked');
  assert.equal(result.switches['ai-publish'].state, 'blocked');
  assert.equal(result.switches['ai-publish'].reason, SWITCH_REASONS.CAPABILITY_NOT_IMPLEMENTED);
});

test('C3 分类未批准时人工 review 通道关闭', () => {
  const blocked = resolveSwitches({ dependencies: readyDeps, capabilities: allCapabilities, approved: [...SWITCH_IDS] });
  assert.equal(blocked.switches['human-review'].state, 'blocked');
  assert.equal(blocked.switches['human-review'].reason, SWITCH_REASONS.C3_NOT_APPROVED);
  const approved = resolveSwitches({ dependencies: readyDeps, capabilities: allCapabilities, approved: [...SWITCH_IDS], c3Approved: true });
  assert.equal(approved.switches['human-review'].state, 'on');
});

test('五类开关相互独立：关掉一类不影响其他类', () => {
  const base = resolveSwitches({ dependencies: readyDeps, capabilities: allCapabilities, approved: [...SWITCH_IDS], c3Approved: true });
  assert.deepEqual([...base.on], [...SWITCH_IDS]);
  for (const off of SWITCH_IDS) {
    const narrowed = resolveSwitches({
      dependencies: readyDeps,
      capabilities: allCapabilities,
      approved: SWITCH_IDS.filter((id) => id !== off),
      c3Approved: true,
    });
    for (const id of SWITCH_IDS) {
      if (id === off) assert.equal(narrowed.switches[id].state, 'off', `${id} 应被关闭`);
      else assert.equal(narrowed.switches[id].state, 'on', `关闭 ${off} 不应影响 ${id}`);
    }
  }
});

test('角色 preset 只能收窄，不能放大已批准范围', () => {
  const role = 'reviewer';
  const result = resolveSwitches({ dependencies: readyDeps, capabilities: allCapabilities, approved: [...SWITCH_IDS], role, c3Approved: true });
  assert.deepEqual([...result.on], [...ROLE_PRESETS.reviewer]);
  assert.equal(result.switches['research-write'].reason, SWITCH_REASONS.ROLE_NARROWS);

  // 未批准的能力即使角色包含也必须保持关闭：收窄不等于放大。
  const narrow = resolveSwitches({ dependencies: readyDeps, capabilities: allCapabilities, approved: ['read'], role: 'developer' });
  assert.deepEqual([...narrow.on], ['read']);

  assert.throws(() => resolveSwitches({ role: 'admin' }), (error) => error instanceof EnterpriseSwitchError && error.code === 'ENTERPRISE_SWITCH_ROLE_UNKNOWN');
});

test('输入不合法直接报错，而不是默默放行', () => {
  assert.throws(() => resolveSwitches(null), (error) => error.code === 'ENTERPRISE_SWITCH_INPUT_INVALID');
  assert.throws(() => resolveSwitches({ approved: 'read' }), (error) => error.code === 'ENTERPRISE_SWITCH_INPUT_INVALID');
  assert.throws(() => resolveSwitches({ approved: ['shell'] }), (error) => error.code === 'ENTERPRISE_SWITCH_UNKNOWN_ID');
});

test('输入摘要只含可公开事实', () => {
  const summary = describeSwitchInput({
    dependencies: readyDeps,
    capabilities: { read: true },
    approved: ['read'],
    role: 'reviewer',
    c3Approved: false,
  });
  assert.deepEqual(summary, {
    policy: 'ready',
    iam: 'ready',
    audit: 'ready',
    capabilities: { read: true },
    approved: ['read'],
    role: 'reviewer',
    c3Approved: false,
  });
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});
