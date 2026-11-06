import assert from 'node:assert/strict';
import test from 'node:test';

import { hostProbeGate, normalizeDshVersion } from '../scripts/lib/host-probe-gate.mjs';

test('normalizeDshVersion: 裸版本与 dsh 前缀输出', () => {
  assert.equal(normalizeDshVersion('0.2.1-rc.3\n'), '0.2.1-rc.3');
  assert.equal(normalizeDshVersion('dsh 0.2.1-rc.3'), '0.2.1-rc.3');
  assert.equal(normalizeDshVersion('0.2.1'), '0.2.1');
  assert.equal(normalizeDshVersion('  0.2.1-rc.5  '), '0.2.1-rc.5');
});

test('normalizeDshVersion: 无法解析返回空串', () => {
  assert.equal(normalizeDshVersion('not-a-version'), '');
  assert.equal(normalizeDshVersion(''), '');
  assert.equal(normalizeDshVersion(undefined), '');
  assert.equal(normalizeDshVersion(null), '');
  assert.equal(normalizeDshVersion(42), '');
});

test('hostProbeGate: dsh 不可执行 → skip，含实际错误与目标版本', () => {
  const gate = hostProbeGate({
    actual: '',
    target: '0.2.1-rc.3',
    force: false,
    error: new Error('spawnSync dsh ENOENT'),
  });
  assert.equal(gate.skip, true);
  assert.match(gate.reason, /ENOENT/);
  assert.match(gate.reason, /0\.2\.1-rc\.3/);
  assert.match(gate.reason, /K-1/);
});

test('hostProbeGate: FORCE 强制运行（即使版本不等）', () => {
  const gate = hostProbeGate({ actual: 'dsh 0.2.1-rc.5', target: '0.2.1-rc.3', force: true });
  assert.equal(gate.skip, false);
  assert.match(gate.reason, /强制/);
});

test('hostProbeGate: 版本不等（rc.5 vs rc.3）→ skip，文案含实际/目标/K-1/AC-13', () => {
  const gate = hostProbeGate({ actual: 'dsh 0.2.1-rc.5', target: '0.2.1-rc.3' });
  assert.equal(gate.skip, true);
  assert.match(gate.reason, /0\.2\.1-rc\.5/);
  assert.match(gate.reason, /0\.2\.1-rc\.3/);
  assert.match(gate.reason, /K-1/);
  assert.match(gate.reason, /AC-13/);
});

test('hostProbeGate: 实际版本不可解析 → skip 并保留原始文本', () => {
  const gate = hostProbeGate({ actual: 'build from source', target: '0.2.1-rc.3' });
  assert.equal(gate.skip, true);
  assert.match(gate.reason, /build from source/);
  assert.match(gate.reason, /0\.2\.1-rc\.3/);
});

test('hostProbeGate: 版本相等 → 运行且无理由文案', () => {
  const gate = hostProbeGate({ actual: '0.2.1-rc.3', target: '0.2.1-rc.3' });
  assert.equal(gate.skip, false);
  assert.equal(gate.reason, '');
});
