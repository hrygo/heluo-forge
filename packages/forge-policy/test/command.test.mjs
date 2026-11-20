import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, PolicyCatalogError } from '../src/index.mjs';

const IDENTITY = Object.freeze({
  getView() {
    return { state: 'ready', signedIn: true, principal: 'user-a', accessExpiresAt: null };
  },
});

const CONFIG = {
  audit: { sink: 'memory' },
  catalog: [
    { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' },
    { action: 'gitee.git.push', target: 'repository', category: 'remote-write' },
    { action: 'gitee.review.record', target: 'pull-request', category: 'human-record' },
  ],
  tools: {},
};

function fakeHost({ identity = IDENTITY, commands = true } = {}) {
  const provided = new Map();
  const registered = new Map();
  const guards = [];
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: () => () => {},
    get(name) {
      if (name === 'iam') return identity;
      if (name === 'commands') {
        return commands ? { register(definition) {
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        } } : undefined;
      }
      return provided.get(name);
    },
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
  };
  return { ctx, registered, guards };
}

const invocationOf = (extra = {}) => ({
  commandId: 'cmd-1',
  agent: { id: 'agent-1' },
  rawInput: '',
  attachments: [],
  signal: new AbortController().signal,
  ...extra,
});
const definition = (action, name = 'synthetic') => ({ name, description: 'x', action, handler: async () => ({}) });

test('a command naming an unknown or reserved action is refused at registration', () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  const policy = host.ctx.get('policy');

  assert.throws(
    () => policy.registerCommand(host.ctx, definition('change.read')),
    (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_COMMAND_ACTION_UNKNOWN',
  );
  assert.throws(
    () => policy.registerCommand(host.ctx, definition('gitee.review.record')),
    (error) => error.code === 'POLICY_COMMAND_ACTION_RESERVED',
    'a human-record action never gets a command face',
  );
  assert.throws(
    () => policy.registerCommand(host.ctx, { name: '', description: 'x', action: 'gitee.issue.write', handler: async () => ({}) }),
    (error) => error.code === 'POLICY_COMMAND_INVALID',
  );
  assert.throws(
    () => policy.registerCommand(host.ctx, { name: 'nope', description: 'x', action: 'gitee.issue.write' }),
    (error) => error.code === 'POLICY_COMMAND_INVALID',
  );
  assert.equal(host.registered.size, 0);
});

test('the command face runs the same decision as the tool face', async () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  const policy = host.ctx.get('policy');
  let runs = 0;
  policy.registerCommand(host.ctx, {
    name: 'forge-write',
    description: 'write an issue',
    action: 'gitee.issue.write',
    handler: async () => ((runs += 1), { kind: 'success', text: 'written' }),
  });
  const command = host.registered.get('forge-write');

  assert.equal((await command.handler(invocationOf({ rawInput: 'acme/demo' }))).kind, 'success');
  const denyTarget = await command.handler(invocationOf({ rawInput: '' }));
  assert.equal(denyTarget.kind, 'error', 'the command name cannot stand in for a missing business target');
  assert.match(denyTarget.text, /target|目标/u);
  assert.equal(runs, 1);
  assert.deepEqual(policy.auditRecords().map((record) => record.phase), ['begin', 'settle']);
});

test('a write command runs without any approval channel in the all-off configuration', async () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  let runs = 0;
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-push',
    description: 'push',
    action: 'gitee.git.push',
    resolveArguments: (invocation) => ({ target: invocation.rawInput, branch: 'feature/x' }),
    handler: async () => ((runs += 1), { kind: 'success', text: 'pushed' }),
  });
  const result = await host.registered.get('forge-push').handler(invocationOf({ rawInput: 'acme/demo' }));
  assert.equal(result.kind, 'success');
  assert.equal(runs, 1);
});

test('a controlled write without a resolvable IAM actor is denied before the body runs', async () => {
  const host = fakeHost({ identity: { getView: () => ({ state: 'signed-out', signedIn: false }) } });
  apply(host.ctx, CONFIG);
  let runs = 0;
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-write',
    description: 'write an issue',
    action: 'gitee.issue.write',
    handler: async () => ((runs += 1), { kind: 'success', text: 'written' }),
  });
  const result = await host.registered.get('forge-write').handler(invocationOf({ rawInput: 'acme/demo' }));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /IAM 身份/u);
  assert.match(result.text, /设置 → 账号/u);
  assert.equal(runs, 0);
});

test('registering a command without a command host is refused with a host error', () => {
  const host = fakeHost({ commands: false });
  apply(host.ctx, CONFIG);
  assert.throws(
    () => host.ctx.get('policy').registerCommand(host.ctx, definition('gitee.issue.write')),
    (error) => error.code === 'POLICY_HOST_UNAVAILABLE',
  );
});

test('a command handler that throws settles the audit as an error and rethrows', async () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-error',
    description: 'throwing write',
    action: 'gitee.issue.write',
    handler: async () => { throw new Error('synthetic body error'); },
  });
  await assert.rejects(host.registered.get('forge-error').handler(invocationOf({ rawInput: 'acme/demo' })), /synthetic body error/u);
  const records = host.ctx.get('policy').auditRecords();
  assert.deepEqual(records.map((record) => record.phase), ['begin', 'settle']);
  assert.equal(records.at(-1).decision, 'error');
});
