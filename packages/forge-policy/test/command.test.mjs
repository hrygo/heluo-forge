import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, PolicyCatalogError } from '../src/index.mjs';

// D1：enabled 的写/确认动作必须有有效台账条目，否则挂载即拒绝（合成批准人，非真实批准）。
const APPROVALS = [
  {
    approval_id: 'APR-CMD-1',
    action: 'issue.create_or_update',
    resource: '*',
    approved_by: 'test-fixture',
    approved_at: '2026-10-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
  },
  {
    approval_id: 'APR-CMD-2',
    action: 'review.human.record',
    resource: '*',
    approved_by: 'test-fixture',
    approved_at: '2026-10-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
  },
];

const CONFIG = {
  audit: { sink: 'memory', allowNonDurable: true },
  approvals: APPROVALS,
  catalog: [
    { action: 'repository.read', kind: 'read', target: 'repository', enabled: true },
    { action: 'issue.create_or_update', kind: 'write', target: 'issue', enabled: true },
    { action: 'review.human.record', kind: 'confirm', target: 'pull-request', enabled: true },
  ],
  tools: {},
};

function fakeHost({ approval, allowed = true } = {}) {
  const provided = new Map();
  const registered = new Map();
  const guards = [];
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: () => () => {},
    get(name) {
      if (name === 'approval') return approval;
      if (name === 'commands') {
        return {
          register(definition) {
            registered.set(definition.name, definition);
            return () => registered.delete(definition.name);
          },
        };
      }
      return provided.get(name);
    },
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
  };
  return { ctx, registered, guards, approvalAllowed: allowed };
}

test('a command naming an unknown or disabled action is refused at registration', () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  const policy = host.ctx.get('policy');
  assert.throws(
    () => policy.registerCommand(host.ctx, { name: 'nope', description: 'x', action: 'change.read', handler: async () => ({}) }),
    (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_COMMAND_ACTION_UNKNOWN',
  );
  assert.throws(
    () => policy.registerCommand(host.ctx, { name: 'nope', description: 'x', action: 'issue.close', handler: async () => ({}) }),
    (error) => error.code === 'POLICY_COMMAND_ACTION_UNKNOWN',
  );
  assert.equal(host.registered.size, 0);
});

test('the command face runs the same decision as the tool face', async () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  const policy = host.ctx.get('policy');
  let runs = 0;
  policy.registerCommand(host.ctx, {
    name: 'forge-read',
    description: 'read the current change',
    action: 'repository.read',
    handler: async () => ((runs += 1), { kind: 'success', text: 'read ok' }),
  });
  const command = host.registered.get('forge-read');
  const invocation = { commandId: 'cmd-1', agent: { id: 'a' }, rawInput: 'repo-a', attachments: [], signal: new AbortController().signal };

  const allowed = await command.handler(invocation);
  assert.equal(allowed.kind, 'success', 'an explicit raw-input target reaches the same gate');
  const denyTarget = await command.handler({ ...invocation, rawInput: '' });
  assert.equal(denyTarget.kind, 'error', 'the command name cannot stand in for a missing business target');

  const disabled = host.ctx.get('policy').decide({ action: 'issue.close', target: 'I-1' });
  assert.equal(disabled.action, 'deny');
  assert.equal(runs, 1);
});

test('a refused confirm action returns an error without running the handler', async () => {
  const approval = { async request() { return 'rejected'; } };
  const host = fakeHost({ approval });
  apply(host.ctx, CONFIG);
  let runs = 0;
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-review',
    description: 'record the human review',
    action: 'review.human.record',
    handler: async () => ((runs += 1), { kind: 'success', text: 'recorded' }),
  });
  const command = host.registered.get('forge-review');
  const result = await command.handler({
    commandId: 'cmd-2',
    agent: { id: 'a' },
    target: 'pr-1',
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /rejected/);
  assert.equal(runs, 0, 'no side effect on a refused confirmation');
});

test('an approved confirmation runs the handler exactly once', async () => {
  const approval = { async request() { return 'allowed-once'; } };
  const host = fakeHost({ approval });
  apply(host.ctx, CONFIG);
  let runs = 0;
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-review',
    description: 'record the human review',
    action: 'review.human.record',
    handler: async () => ((runs += 1), { kind: 'success', text: 'recorded' }),
  });
  const result = await host.registered.get('forge-review').handler({
    commandId: 'cmd-3',
    agent: { id: 'a' },
    target: 'pr-1',
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'success');
  assert.equal(runs, 1);
});

test('a confirm command without an approval channel fails closed', async () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  let runs = 0;
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-review',
    description: 'record the human review',
    action: 'review.human.record',
    handler: async () => ((runs += 1), { kind: 'success', text: 'recorded' }),
  });
  const result = await host.registered.get('forge-review').handler({
    commandId: 'cmd-4',
    agent: { id: 'a' },
    target: 'pr-1',
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /no approval channel/);
  assert.equal(runs, 0);
});
