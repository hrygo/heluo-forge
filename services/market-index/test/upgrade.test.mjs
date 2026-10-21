import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationGate, STATE, planRecovery, reconcileUpgrade, runUpgrade } from '../generator/upgrade.mjs';

const plan = (overrides = {}) => ({
  requestId: 'req-1',
  name: '@heluo/forge-example',
  oldVersion: '1.0.0',
  targetVersion: '1.1.0',
  enabled: true,
  canRemove: true,
  canRecoverOld: true,
  admitTarget: async () => ({ allowed: true }),
  ...overrides,
});

const effects = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    removeBundle: async (name) => {
      calls.push(['remove', name]);
    },
    installBundle: async (options) => {
      calls.push(['install', options.spec, options.enabled, options.saveExact]);
      return { stage: 'client-ready' };
    },
    waitForInstall: async () => null,
    listBundles: async () => [],
    ...overrides,
  };
};

test('正常更版：先移除后精确安装，保留 enabled', async () => {
  const fx = effects();
  const result = await runUpgrade(plan(), fx);
  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.stage, 'client-ready');
  assert.deepEqual(result.steps.map((entry) => entry.id), ['precheck', 'admit-before-remove', 'remove', 'admit-after-remove', 'install']);
  assert.deepEqual(fx.calls, [
    ['remove', '@heluo/forge-example'],
    ['install', '@heluo/forge-example@1.1.0', true, true],
  ]);
});

test('目标未准入时不动旧包', async () => {
  const fx = effects();
  const result = await runUpgrade(plan({ admitTarget: async () => ({ allowed: false, reasons: ['revoked'] }) }), fx);
  assert.equal(result.state, STATE.REJECTED);
  assert.deepEqual(result.reasons, ['revoked']);
  assert.equal(fx.calls.length, 0);
});

test('不可移除或无恢复资格直接拒绝', async () => {
  const fx = effects();
  for (const flags of [{ canRemove: false }, { canRecoverOld: false }]) {
    const result = await runUpgrade(plan(flags), fx);
    assert.equal(result.state, STATE.REJECTED);
    assert.equal(fx.calls.length, 0);
  }
});

test('移除失败即停，不安装、不自动重试', async () => {
  const fx = effects({
    removeBundle: async () => {
      throw new Error('dependency-in-use');
    },
    listBundles: async () => [{ name: '@heluo/forge-example', version: '1.0.0', enabled: true }],
  });
  const result = await runUpgrade(plan(), fx);
  assert.equal(result.state, STATE.REMOVE_FAILED);
  assert.equal(result.inventory.length, 1);
  assert.equal(fx.calls.length, 0);
});

test('移除后目标撤回：停在恢复态，不安装', async () => {
  let phase = 0;
  const fx = effects();
  const result = await runUpgrade(
    plan({
      admitTarget: async () => {
        phase += 1;
        return phase === 1 ? { allowed: true } : { allowed: false, reasons: ['revoked-after-remove'] };
      },
    }),
    fx,
  );
  assert.equal(result.state, STATE.RECOVERY_REQUIRED);
  assert.deepEqual(result.reasons, ['revoked-after-remove']);
  assert.deepEqual(fx.calls, [['remove', '@heluo/forge-example']]);
});

test('安装失败：old-removed/recovery-required，不自动回滚', async () => {
  const fx = effects({
    installBundle: async () => {
      throw new Error('network');
    },
  });
  const result = await runUpgrade(plan(), fx);
  assert.equal(result.state, STATE.RECOVERY_REQUIRED);
  assert.match(result.reasons[0], /install-failed/);
});

test('失联对账：null 不是成功；inventory 确证才算完成', async () => {
  const pending = await reconcileUpgrade({
    requestId: 'r',
    name: '@heluo/forge-example',
    targetVersion: '1.1.0',
    waitForInstall: async () => null,
    listBundles: async () => [{ name: '@heluo/forge-example', version: '1.0.0' }],
  });
  assert.equal(pending.state, STATE.PENDING);
  assert.equal(pending.evidence, 'wait-null-not-failure');

  const confirmed = await reconcileUpgrade({
    requestId: 'r',
    name: '@heluo/forge-example',
    targetVersion: '1.1.0',
    waitForInstall: async () => null,
    listBundles: async () => [{ name: '@heluo/forge-example', version: '1.1.0' }],
  });
  assert.equal(confirmed.state, STATE.COMPLETED);
  assert.equal(confirmed.evidence, 'inventory-confirmed');
});

test('安装返回 unknown 时进入对账而不是重装', async () => {
  const fx = effects({
    installBundle: async () => ({ unknown: true }),
    waitForInstall: async () => null,
    listBundles: async () => [],
  });
  const result = await runUpgrade(plan(), fx);
  assert.equal(result.state, STATE.PENDING);
  assert.equal(result.evidence, 'wait-null-not-failure');
  assert.equal(fx.calls.length, 1);
});

test('恢复计划只在旧版仍获准且 registry 保留时给出', () => {
  const ok = planRecovery({ name: '@heluo/forge-example', oldVersion: '1.0.0', enabled: true, oldVersionAllowed: true, registryHasOldVersion: true });
  assert.equal(ok.allowed, true);
  assert.match(ok.steps[1], /installBundle\(@heluo\/forge-example@1\.0\.0/);

  const revoked = planRecovery({ name: '@heluo/forge-example', oldVersion: '1.0.0', oldVersionAllowed: false, registryHasOldVersion: true });
  assert.equal(revoked.allowed, false);
  assert.deepEqual(revoked.reasons, ['old-version-not-allowed']);

  const missing = planRecovery({ name: '@heluo/forge-example', oldVersion: '1.0.0', oldVersionAllowed: true, registryHasOldVersion: false });
  assert.deepEqual(missing.reasons, ['old-version-not-in-registry']);
});

test('同一 requestId 并发写被拒绝，释放后可再次获取', async () => {
  const gate = new OperationGate();
  let release;
  const first = runUpgrade(plan(), effects({
    removeBundle: () => new Promise((resolve) => {
      release = resolve;
    }),
  }), gate);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runUpgrade(plan(), effects(), gate);
  assert.equal(second.state, STATE.IN_FLIGHT);
  release();
  const done = await first;
  assert.equal(done.state, STATE.COMPLETED);
  assert.equal(gate.size, 0);
  assert.equal(gate.acquire('req-1'), true);
});