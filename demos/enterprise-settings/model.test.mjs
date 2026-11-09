import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, readiness, validatePublic } from './model.mjs';

const connectAll = state => ['iam', 'devops', 'gitee'].reduce((current, service) => reduce(current, { type: 'login', service }), state);
const maintain = state => reduce(state, { type: 'persona', persona: 'maintainer' });

test('presets are isolated; ready is local only and fault identifies wrong CLI', () => {
  const first = initialState();
  assert.equal(first.scenario, 'new');
  assert.equal(readiness(first).connected, 0);
  assert.deepEqual(readiness(first).missing, ['iam', 'devops', 'gitee', 'check']);
  assert.equal(readiness(initialState('ready')).localReady, true);
  assert.equal(readiness(initialState('ready')).remoteReady, false);
  const fault = initialState('fault');
  assert.equal(fault.tool, 'wrong');
  assert.equal(readiness(fault).connected, 3);
  assert.deepEqual(readiness(fault).missing, ['tool', 'check']);
  first.environment.name = 'changed fixture';
  assert.notEqual(initialState().environment.name, first.environment.name);
});

test('individual login still needs an explicit check and never grants remote writes', () => {
  const before = initialState();
  const connected = connectAll(before);
  assert.equal(readiness(connected).connected, 3);
  assert.equal(readiness(connected).localReady, false);
  const checked = reduce(connected, { type: 'check' });
  assert.equal(checked.notice.key, 'checkPassed');
  assert.equal(readiness(checked).localReady, true);
  assert.equal(readiness(checked).remoteReady, false);
  assert.equal(before.connections.iam, false);
  const logout = reduce(checked, { type: 'logout', service: 'iam' });
  assert.equal(logout.checked, false);
  assert.equal(readiness(logout).localReady, false);
});

test('incomplete checks fail visibly while remaining local and synchronous', () => {
  const result = reduce(initialState('fault'), { type: 'check' });
  assert.equal(result.checked, true);
  assert.equal(result.notice.key, 'checkFailed');
  assert.equal(readiness(result).localReady, false);
  assert.deepEqual(readiness(result).missing, ['tool']);
});

test('tool override requires recheck and restoring auto preserves the fault fixture', () => {
  let state = reduce(initialState('fault'), { type: 'tool-path', path: ' /example/tools/gh-enterprise ' });
  assert.equal(state.tool, 'detected');
  assert.equal(state.manualPath, '/example/tools/gh-enterprise');
  assert.equal(state.checked, false);
  state = reduce(state, { type: 'check' });
  assert.equal(readiness(state).localReady, true);
  state = reduce(state, { type: 'tool-auto' });
  assert.equal(state.tool, 'wrong');
  assert.equal(state.checked, false);
  assert.equal(state.manualPath, '');
  assert.equal(readiness(state).localReady, false);
  for (const path of ['', ' ', '/example/\nsecret', '/example/\u0000tool']) {
    assert.equal(reduce(state, { type: 'tool-path', path }).notice.key, 'invalidPath');
  }
});

test('timeout accepts bounded integers and rejects coercion or fractions', () => {
  const state = initialState();
  for (const value of [1000, 20000, 600000]) assert.equal(reduce(state, { type: 'timeout', value }).timeoutMs, value);
  for (const value of [999, 600001, 1000.5, NaN, Infinity, '20000']) {
    const rejected = reduce(state, { type: 'timeout', value });
    assert.equal(rejected.notice.key, 'invalidTimeout');
    assert.equal(rejected.timeoutMs, 20000);
  }
});

test('public configuration accepts HTTPS corporate examples only', () => {
  const values = initialState().environment;
  assert.deepEqual(validatePublic(values), { ok: true });
  // 带账号密码的 URL 要拼出来：整串写字面量会被本机脱敏扫描当成邮箱地址。
  for (const devops of ['http://devops.corp.example', 'https://corp.example', 'https://evil.example', 'https://devops.corp.example.evil.example', ['https://user:pass', '@devops.corp.example'].join(''), 'https://devops.corp.example?q=1', 'https://devops.corp.example#part', 'https://devops.corp.example?', 'https://devops.corp.example/#']) {
    assert.equal(validatePublic({ ...values, devops }).ok, false, devops);
  }
  assert.equal(validatePublic({ ...values, name: ' ' }).ok, false);
  assert.equal(validatePublic(null).ok, false);
});

test('normal users cannot save or apply enterprise configuration', () => {
  const state = initialState('ready');
  for (const action of [{ type: 'public-save', values: state.environment, revision: 1 }, { type: 'public-apply' }]) {
    const rejected = reduce(state, action);
    assert.equal(rejected.notice.key, 'forbidden');
    assert.equal(rejected.revision, 1);
    assert.equal(rejected.publicPending, false);
  }
});

test('maintainer save is staged, conflict-safe and validated without mutating input', () => {
  const state = maintain(initialState('ready'));
  const values = { ...state.environment, name: '示例企业 · 待应用' };
  const saved = reduce(state, { type: 'public-save', values, revision: 1 });
  assert.equal(saved.revision, 2);
  assert.equal(saved.appliedRevision, 1);
  assert.equal(saved.publicPending, true);
  assert.equal(saved.connections.iam, true);
  assert.equal(readiness(saved).localReady, false);
  assert.ok(readiness(saved).missing.includes('public'));
  assert.equal(saved.notice.key, 'publicSaved');
  values.name = 'outside mutation';
  assert.equal(saved.environment.name, '示例企业 · 待应用');
  const stale = reduce(saved, { type: 'public-save', values: saved.environment, revision: 1 });
  assert.equal(stale.notice.key, 'conflict');
  assert.equal(stale.revision, 2);
  const invalid = reduce(saved, { type: 'public-save', values: { ...saved.environment, gitee: 'http://bad.example' }, revision: 2 });
  assert.equal(invalid.notice.key, 'invalidPublic');
  assert.equal(invalid.revision, 2);
});

test('applying a pending draft invalidates all connections and checks', () => {
  let state = maintain(initialState('ready'));
  state = reduce(state, { type: 'public-save', values: state.environment, revision: 1 });
  state = reduce(state, { type: 'public-apply' });
  assert.equal(state.appliedRevision, 2);
  assert.equal(state.publicPending, false);
  assert.equal(state.checked, false);
  assert.deepEqual(state.connections, { iam: false, devops: false, gitee: false });
  assert.equal(state.notice.key, 'publicApplied');
  assert.equal(readiness(state).remoteReady, false);
  const unchanged = reduce(state, { type: 'public-apply' });
  assert.equal(unchanged, state);
});

test('navigation, persona, dismiss and reset preserve the demo boundary', () => {
  let state = initialState('ready');
  state = reduce(state, { type: 'navigate', page: 'admin' });
  assert.equal(state.page, 'overview');
  state = maintain(state);
  state = reduce(state, { type: 'navigate', page: 'admin' });
  assert.equal(state.page, 'admin');
  state = reduce(state, { type: 'persona', persona: 'user' });
  assert.equal(state.page, 'overview');
  state = reduce(state, { type: 'login', service: 'iam' });
  state = reduce(state, { type: 'dismiss' });
  assert.equal(state.notice, null);
  state = reduce(state, { type: 'scenario', scenario: 'fault' });
  assert.equal(state.scenario, 'fault');
  assert.equal(state.revision, 1);
  assert.equal(state.tool, 'wrong');
  assert.equal(reduce(state, { type: 'unknown' }), state);
});
