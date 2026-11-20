import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../src/index.mjs';

const write = { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' };

function host(config = {}) {
  const services = new Map(), listeners = new Map(), commands = new Map(), guards = [];
  services.set('iam', { getView: () => ({ signedIn: true, principal: { subject: 'svc-policy-test' } }) });
  const ctx = {
    get: (key) => key === 'commands' ? { register: (definition) => {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    } } : services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
  };
  const dispose = apply(ctx, { catalog: [write], tools: { synthetic: write.action }, ...config });
  return { ctx, policy: services.get('policy'), guards, commands, listeners, dispose };
}

const execution = (args = { target: 'repo-A' }) => ({ name: 'synthetic', arguments: args, callId: 'call-1', agent: { kind: 'agent' }, signal: new AbortController().signal });
const invocation = () => ({ commandId: 'command-1', target: 'repo-A', rawInput: 'repo-A', signal: new AbortController().signal });
const allow = async () => ({ kind: 'allow' });
const accept = async () => ({ kind: 'accept' });

for (const failure of ['missing', 'failing', 'timeout']) {
  test(`a ${failure} audit sink refuses commands with zero body calls`, async () => {
    const h = host({ audit: { sink: 'memory', timeoutMs: 10 } });
    let runs = 0;
    if (failure === 'missing') h.policy.setAuditSink(null);
    if (failure === 'failing') h.policy.setAuditSink({ durable: true, append() { throw new Error('synthetic failure'); } });
    if (failure === 'timeout') h.policy.setAuditSink({ durable: true, append: () => new Promise(() => {}) });
    h.policy.registerCommand(h.ctx, { name: 'synthetic-write', description: 'Write a synthetic issue', action: write.action,
      handler: async () => (++runs, { kind: 'success', text: 'written' }) });
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      const result = await h.commands.get('synthetic-write').handler(invocation());
      assert.equal(result.kind, 'error');
      assert.equal(result.text.includes('审计'), false, 'user copy must not mention the audit word');
      assert.match(result.text, /记录|存储|重试/u);
      assert.equal(runs, 0);
    } finally { clearTimeout(keepAlive); h.dispose(); }
  });
}

test('a guard cannot allow a call that no pre-execute stage admitted', () => {
  const h = host();
  assert.match(String(h.guards[0](execution())), /not admitted/u);
  assert.deepEqual(h.policy.auditRecords(), []);
  h.dispose();
});

test('a receipt is specific to one execution and its audited arguments', async () => {
  const h = host();
  const exec = execution();
  await h.listeners.get('tools/pre-execute')(exec, allow);
  assert.match(String(h.guards[0](execution())), /already admitted/u, 'another object cannot reuse a call id');
  exec.arguments.target = 'repo-B';
  assert.match(String(h.guards[0](exec)), /changed/u);
  const fresh = execution();
  await h.listeners.get('tools/pre-execute')(fresh, allow);
  assert.equal(h.guards[0](fresh), undefined);
  assert.match(String(h.guards[0](fresh)), /used/u);
  h.dispose();
});

test('an audited tool has one admission and cannot replay its receipt', async () => {
  const h = host();
  const exec = execution();
  await h.listeners.get('tools/pre-execute')(exec, allow);
  assert.equal(h.guards[0](exec), undefined);
  assert.match(String(h.guards[0](exec)), /used|consumed/u);
  await h.listeners.get('tools/post-execute')(exec, { isError: false }, accept);
  assert.equal(h.policy.auditRecords().length, 2);
  h.dispose();
});

test('commands settle successful and throwing outcomes through the same audit barrier', async () => {
  const h = host();
  h.policy.registerCommand(h.ctx, { name: 'synthetic-write', description: 'Write a synthetic issue', action: write.action,
    handler: async () => ({ kind: 'success', text: 'written' }) });
  assert.equal((await h.commands.get('synthetic-write').handler(invocation())).kind, 'success');
  assert.deepEqual(h.policy.auditRecords().map((r) => r.phase), ['begin', 'settle']);
  h.policy.registerCommand(h.ctx, { name: 'synthetic-error', description: 'Exercise an error outcome', action: write.action,
    handler: async () => { throw new Error('synthetic body error'); } });
  await assert.rejects(() => h.commands.get('synthetic-error').handler(invocation()), /synthetic body error/);
  assert.equal(h.policy.auditRecords().at(-1).decision, 'error');
  h.dispose();
});

test('a command settle failure preserves its result and denies the next command', async () => {
  const h = host();
  let writes = 0, runs = 0;
  h.policy.setAuditSink({ durable: true, append() { if (++writes > 1) throw new Error('synthetic settle error'); } });
  h.policy.registerCommand(h.ctx, { name: 'synthetic-write', description: 'Write a synthetic issue', action: write.action,
    handler: async () => (++runs, { kind: 'success', text: 'executed' }) });
  assert.equal((await h.commands.get('synthetic-write').handler(invocation())).kind, 'success');
  assert.equal(h.policy.auditDegraded(), true);
  assert.equal((await h.commands.get('synthetic-write').handler(invocation())).kind, 'error');
  assert.equal(runs, 1);
  h.dispose();
});

test('retained commands fail closed after their policy is disposed', async () => {
  const h = host();
  let runs = 0;
  h.policy.registerCommand(h.ctx, { name: 'retained', description: 'Exercise lifecycle cleanup', action: write.action,
    handler: async () => (++runs, { kind: 'success' }) });
  const retained = h.commands.get('retained').handler;
  h.dispose();
  assert.match((await retained(invocation())).text, /no longer mounted/u);
  assert.equal(runs, 0);
});

test('concurrent preparation and reuse after settlement cannot mint another admission', async () => {
  const h = host();
  let release, writes = 0;
  h.policy.setAuditSink({ durable: true, append() {
    if (++writes === 1) return new Promise((resolve) => { release = resolve; });
  } });
  const exec = execution();
  const first = h.listeners.get('tools/pre-execute')(exec, allow);
  const concurrent = await h.listeners.get('tools/pre-execute')(exec, allow);
  assert.equal(concurrent.kind, 'deny');
  release();
  assert.equal((await first).kind, 'allow');
  assert.equal(h.guards[0](exec), undefined);
  await h.listeners.get('tools/post-execute')(exec, { isError: false }, accept);
  assert.equal((await h.listeners.get('tools/pre-execute')(exec, allow)).kind, 'deny');
  assert.equal(writes, 2, 'one begin and one settle only');
  h.dispose();
});

test('structured command arguments are normalized once and parser errors are redacted', async () => {
  const h = host();
  let runs = 0;
  h.policy.registerCommand(h.ctx, { name: 'structured', description: 'Use a trusted argument parser', action: write.action,
    resolveArguments: () => ({ target: 'repo-normalized' }),
    handler: async (_invocation, args) => (++runs, { kind: 'success', text: args.target }) });
  assert.equal((await h.commands.get('structured').handler(invocation())).text, 'repo-normalized');
  assert.equal(h.policy.auditRecords()[0].target, 'repo-normalized');
  for (const [name, resolver] of [['invalid', () => 'not an argument object'], ['throwing', () => { throw new Error('secret-canary'); }]]) {
    h.policy.registerCommand(h.ctx, { name, description: 'Exercise parser rejection', action: write.action,
      resolveArguments: resolver, handler: async () => (++runs, { kind: 'success' }) });
    const result = await h.commands.get(name).handler(invocation());
    assert.equal(result.kind, 'error');
    assert.equal(result.text.includes('secret-canary'), false);
  }
  assert.equal(runs, 1);
  h.dispose();
});
