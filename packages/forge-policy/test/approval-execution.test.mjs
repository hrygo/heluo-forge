import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../src/index.mjs';
import { compileApprovals } from '../src/approvals.mjs';
import { compileCatalog } from '../src/catalog.mjs';
import { createGate } from '../src/gate.mjs';

/**
 * FIX-03（#21）：组织批准在每次执行时复验动作、实际资源、版本范围与当前时间，
 * 而不只在挂载时检查；挂载检查保留为早期错误发现。
 */

const WRITE = { action: 'issue.close', kind: 'write', target: 'issue', enabled: true };

const ROW = {
  approval_id: 'APR-EXE-1',
  action: 'issue.close',
  resource: 'group/repo',
  approved_by: 'test-fixture',
  approved_at: '2026-10-01T00:00:00Z',
  revision_range: ['R-1'],
  expires_at: '2099-01-01T00:00:00Z',
};

function fakeHost({ commands } = {}) {
  const provided = new Map();
  const guards = [];
  const listeners = new Map();
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    get: (name) => (name === 'commands' ? commands : provided.get(name)),
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
  };
  return { ctx, guards, provided, listeners };
}

function mount(extra = {}) {
  const host = fakeHost();
  apply(host.ctx, {
    audit: { sink: 'memory', allowNonDurable: true },
    approvals: [ROW],
    catalog: [WRITE],
    tools: { forge_issue_close: 'issue.close' },
    ...extra,
  });
  return host;
}

test('执行期复验通过：动作+实际资源+版本+时限一致才放行', async () => {
  const host = mount();
  let bodyCalls = 0;
  const exec = { name: 'forge_issue_close', arguments: { target: 'group/repo', revision: 'R-1' }, callId: 'c1' };
  const pre = await host.listeners.get('tools/pre-execute')(exec, async () => ((bodyCalls += 1), { kind: 'allow' }));
  assert.equal(pre.kind, 'allow');
  assert.equal(host.guards[0](exec), undefined);
  assert.equal(bodyCalls, 1);
});

test('实际资源错：执行期拒绝且执行体零调用', async () => {
  const host = mount();
  let bodyCalls = 0;
  const exec = { name: 'forge_issue_close', arguments: { target: 'other/repo', revision: 'R-1' }, callId: 'c2' };
  const pre = await host.listeners.get('tools/pre-execute')(exec, async () => ((bodyCalls += 1), { kind: 'allow' }));
  assert.equal(pre.kind, 'deny');
  assert.match(String(pre.reason), /resource-mismatch/u);
  assert.equal(bodyCalls, 0);
});

test('版本错：执行期拒绝且执行体零调用', async () => {
  const host = mount();
  let bodyCalls = 0;
  const exec = { name: 'forge_issue_close', arguments: { target: 'group/repo', revision: 'R-9' }, callId: 'c3' };
  const pre = await host.listeners.get('tools/pre-execute')(exec, async () => ((bodyCalls += 1), { kind: 'allow' }));
  assert.equal(pre.kind, 'deny');
  assert.match(String(pre.reason), /revision-out-of-range/u);
  assert.equal(bodyCalls, 0);
});

test('必需版本缺失：版本绑定的批准不覆盖无版本调用', async () => {
  const host = mount();
  let bodyCalls = 0;
  const exec = { name: 'forge_issue_close', arguments: { target: 'group/repo' }, callId: 'c4' };
  const pre = await host.listeners.get('tools/pre-execute')(exec, async () => ((bodyCalls += 1), { kind: 'allow' }));
  assert.equal(pre.kind, 'deny');
  assert.match(String(pre.reason), /revision-out-of-range/u);
  assert.equal(bodyCalls, 0);
});

test('command 与 tool 两面一致：版本缺失在命令面同样拒绝', async () => {
  const registered = new Map();
  const host = fakeHost({
    commands: {
      register: (definition) => (registered.set(definition.name, definition), () => registered.delete(definition.name)),
    },
  });
  apply(host.ctx, {
    audit: { sink: 'memory', allowNonDurable: true },
    approvals: [ROW],
    catalog: [WRITE],
    tools: {},
  });
  let runs = 0;
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-close',
    description: 'close the issue',
    action: 'issue.close',
    handler: async () => ((runs += 1), { kind: 'success', text: 'closed' }),
  });
  const command = registered.get('forge-close');
  const ok = await command.handler({ commandId: 'cmd-1', target: 'group/repo', revision: 'R-1' });
  assert.equal(ok.kind, 'success');
  const denied = await command.handler({ commandId: 'cmd-2', target: 'group/repo' });
  assert.equal(denied.kind, 'error');
  assert.equal(runs, 1);
});

test('运行中到期：prepare 与 guard 之间批准过期则 guard 拒绝', async () => {
  let nowMs = Date.parse('2026-11-01T00:00:00Z');
  const shortRow = {
    ...ROW,
    approval_id: 'APR-EXE-SHORT',
    approved_at: '2026-10-01T00:00:00Z',
    expires_at: new Date(nowMs + 1000).toISOString(),
  };
  const gate = createGate({
    catalog: compileCatalog([WRITE]),
    tools: { syn: 'issue.close' },
    audit: { begin: async () => ({ id: 'r1' }), settle: async () => ({ action: 'settled' }), isDegraded: () => false },
    approvals: compileApprovals([shortRow]),
    now: () => nowMs,
  });
  const exec = { name: 'syn', arguments: { target: 'group/repo', revision: 'R-1' }, callId: 'c5' };
  const pre = await gate.preExecute({}, exec, async () => {
    nowMs += 60_000;
    return { kind: 'allow' };
  });
  assert.equal(pre.kind, 'allow');
  const reason = gate.guard(exec);
  assert.notEqual(reason, undefined);
  assert.match(String(reason), /expired/u);
});

test('未到生效期：执行时批准尚未生效则拒绝', async () => {
  const nowMs = Date.parse('2026-10-01T00:00:00Z');
  const futureRow = { ...ROW, approval_id: 'APR-EXE-FUTURE', approved_at: '2027-01-01T00:00:00Z' };
  const gate = createGate({
    catalog: compileCatalog([WRITE]),
    tools: { syn: 'issue.close' },
    audit: { begin: async () => ({ id: 'r1' }), settle: async () => ({ action: 'settled' }), isDegraded: () => false },
    approvals: compileApprovals([futureRow]),
    now: () => nowMs,
  });
  const exec = { name: 'syn', arguments: { target: 'group/repo', revision: 'R-1' }, callId: 'c6' };
  const prepared = await gate.preExecute({}, exec, async () => ({ kind: 'allow' }));
  assert.equal(prepared.kind, 'deny');
  assert.match(String(prepared.reason), /not-yet-valid/u);
});
