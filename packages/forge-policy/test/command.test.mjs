import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, PolicyCatalogError } from '../src/index.mjs';

const IDENTITY = Object.freeze({
  getView() {
    return { state: 'ready', signedIn: true, principal: 'user-a', accessExpiresAt: null };
  },
});

const CONFIG = {
  audit: { sink: 'memory', allowNonDurable: true },
  catalog: [
    { action: 'gitee.repository.read', target: 'repository', enabled: true },
    { action: 'gitee.issue.write', target: 'issue', enabled: true },
    { action: 'gitee.git.push', target: 'repository', enabled: true },
    { action: 'gitee.review.record', target: 'pull-request', enabled: true },
    { action: 'gitee.pr.read', target: 'pull-request', enabled: false },
  ],
  tools: {},
};

function fakeHost({ approval = { async request() { return 'allowed-once'; } } } = {}) {
  const provided = new Map();
  const registered = new Map();
  const guards = [];
  const ctx = {
    tools: { guard: (fn) => (guards.push(fn), () => guards.splice(guards.indexOf(fn), 1)) },
    on: () => () => {},
    get(name) {
      if (name === 'approval') return approval;
      if (name === 'iam') return IDENTITY;
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

test('a command naming an unknown, disabled or reserved action is refused at registration', () => {
  const host = fakeHost();
  apply(host.ctx, CONFIG);
  const policy = host.ctx.get('policy');
  const definition = (action, name = 'nope') => ({ name, description: 'x', action, handler: async () => ({}) });

  assert.throws(
    () => policy.registerCommand(host.ctx, definition('change.read')),
    (error) => error instanceof PolicyCatalogError && error.code === 'POLICY_COMMAND_ACTION_UNKNOWN',
  );
  assert.throws(
    () => policy.registerCommand(host.ctx, definition('gitee.pr.read')),
    (error) => error.code === 'POLICY_COMMAND_ACTION_DISABLED',
  );
  assert.throws(
    () => policy.registerCommand(host.ctx, definition('gitee.review.record')),
    (error) => error.code === 'POLICY_COMMAND_ACTION_RESERVED',
    'a human-record action never gets a command face',
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
    description: 'read the repository',
    action: 'gitee.repository.read',
    handler: async () => ((runs += 1), { kind: 'success', text: 'read ok' }),
  });
  const command = host.registered.get('forge-read');

  assert.equal((await command.handler(invocationOf({ rawInput: 'acme/demo' }))).kind, 'success');
  const denyTarget = await command.handler(invocationOf({ rawInput: '' }));
  assert.equal(denyTarget.kind, 'error', 'the command name cannot stand in for a missing business target');
  assert.equal(runs, 1);
});

test('a write command asks once for the task scope and then reuses it', async () => {
  const requests = [];
  const approval = { async request(request) { requests.push(request); return 'allowed-once'; } };
  const host = fakeHost({ approval });
  apply(host.ctx, CONFIG);
  let runs = 0;
  host.ctx.get('policy').registerCommand(host.ctx, {
    name: 'forge-issue-write',
    description: 'write an issue',
    action: 'gitee.issue.write',
    resolveArguments: (invocation) => ({ target: invocation.rawInput, changeId: invocation.changeId, body: 'plain text' }),
    handler: async () => ((runs += 1), { kind: 'success', text: 'written' }),
  });
  const command = host.registered.get('forge-issue-write');

  assert.equal((await command.handler(invocationOf({ rawInput: 'acme/demo!1', changeId: 'CHG-1' }))).kind, 'success');
  assert.equal((await command.handler(invocationOf({ rawInput: 'acme/demo!2', changeId: 'CHG-1', commandId: 'cmd-2' }))).kind, 'success');
  assert.equal(requests.length, 1, 'the second write reuses the task scope');
  assert.equal(runs, 2);
});

test('a refused push returns an error without running the handler', async () => {
  const approval = { async request() { return 'rejected'; } };
  const host = fakeHost({ approval });
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
  assert.equal(result.kind, 'error');
  assert.match(result.text, /rejected/);
  assert.equal(runs, 0, 'no side effect on a refused confirmation');
});

test('an approved push runs the handler exactly once', async () => {
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

test('a push command without an approval channel fails closed', async () => {
  const host = fakeHost({ approval: null });
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
  assert.equal(result.kind, 'error');
  assert.match(result.text, /no approval channel/);
  assert.equal(runs, 0);
});
