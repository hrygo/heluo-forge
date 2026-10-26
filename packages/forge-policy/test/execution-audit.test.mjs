import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../src/index.mjs';

const read = { action: 'synthetic.read', kind: 'read', target: 'repository', enabled: true };

function host(config = {}) {
  const services = new Map(), listeners = new Map(), commands = new Map(), guards = [];
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
  const dispose = apply(ctx, { catalog: [read], tools: { synthetic: read.action }, ...config });
  return { ctx, policy: services.get('policy'), guards, commands, listeners, dispose };
}

const execution = (args = { target: 'repo-A' }) => ({ name: 'synthetic', arguments: args, callId: 'call-1', signal: new AbortController().signal });
const invocation = () => ({ commandId: 'command-1', target: 'repo-A', rawInput: 'repo-A', signal: new AbortController().signal });

for (const failure of ['missing', 'failing', 'non-durable', 'timeout']) {
  test(`a ${failure} audit sink refuses commands with zero body calls`, async () => {
    const h = host({ audit: { timeoutMs: 10 } });
    let runs = 0;
    if (failure === 'failing') h.policy.setAuditSink({ durable: true, append() { throw new Error('synthetic failure'); } });
    if (failure === 'non-durable') h.policy.setAuditSink({ durable: false, append() {} });
    if (failure === 'timeout') h.policy.setAuditSink({ durable: true, append: () => new Promise(() => {}) });
    h.policy.registerCommand(h.ctx, { name: 'synthetic-read', description: 'Read a synthetic repository', action: read.action,
      handler: async () => (++runs, { kind: 'success', text: 'read' }) });
    // Keep the process alive while the audit barrier's unref'ed deadline runs.
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      const result = await h.commands.get('synthetic-read').handler(invocation());
      assert.equal(result.kind, 'error');
      assert.match(result.text, /audit/);
      assert.equal(runs, 0);
    } finally { clearTimeout(keepAlive); h.dispose(); }
  });
}

test('an earlier waterfall allow cannot bypass the hard audit gate', () => {
  const h = host();
  assert.match(String(h.guards[0](execution())), /audit/);
  assert.deepEqual(h.policy.auditRecords(), []);
  h.dispose();
});

test('a receipt is specific to one execution and its audited arguments', async () => {
  const h = host({ audit: { sink: 'memory', allowNonDurable: true } });
  const exec = execution();
  await h.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }));
  assert.match(String(h.guards[0](execution())), /audit/, 'another object cannot reuse a call id');
  exec.arguments.target = 'repo-B';
  assert.match(String(h.guards[0](exec)), /changed|match|audit/);
  h.dispose();
});

test('an audited tool has one admission and cannot replay its receipt', async () => {
  const h = host({ audit: { sink: 'memory', allowNonDurable: true } });
  const exec = execution();
  await h.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }));
  assert.equal(h.guards[0](exec), undefined);
  assert.match(String(h.guards[0](exec)), /used|consumed|audit/);
  await h.listeners.get('tools/post-execute')(exec, { isError: false }, async () => ({ kind: 'accept' }));
  assert.equal(h.policy.auditRecords().length, 2);
  assert.match(String(h.guards[0](exec)), /audit/);
  h.dispose();
});

test('commands settle successful and throwing outcomes through the same audit barrier', async () => {
  const h = host({ audit: { sink: 'memory', allowNonDurable: true } });
  h.policy.registerCommand(h.ctx, { name: 'synthetic-read', description: 'Read a synthetic repository', action: read.action,
    handler: async () => ({ kind: 'success', text: 'read' }) });
  assert.equal((await h.commands.get('synthetic-read').handler(invocation())).kind, 'success');
  assert.deepEqual(h.policy.auditRecords().map((r) => r.phase), ['begin', 'settle']);
  h.policy.registerCommand(h.ctx, { name: 'synthetic-error', description: 'Exercise an error outcome', action: read.action,
    handler: async () => { throw new Error('synthetic body error'); } });
  await assert.rejects(() => h.commands.get('synthetic-error').handler(invocation()), /synthetic body error/);
  assert.equal(h.policy.auditRecords().at(-1).decision, 'error');
  h.dispose();
});

test('a command settle failure preserves its result and denies the next command', async () => {
  const h = host();
  let writes = 0, runs = 0;
  h.policy.setAuditSink({ durable: true, append() { if (++writes > 1) throw new Error('synthetic settle error'); } });
  h.policy.registerCommand(h.ctx, { name: 'synthetic-read', description: 'Read a synthetic repository', action: read.action,
    handler: async () => (++runs, { kind: 'success', text: 'executed' }) });
  assert.equal((await h.commands.get('synthetic-read').handler(invocation())).kind, 'success');
  assert.equal(h.policy.auditDegraded(), true);
  assert.equal((await h.commands.get('synthetic-read').handler(invocation())).kind, 'error');
  assert.equal(runs, 1);
  h.dispose();
});

test('retained commands fail closed after their policy is disposed', async () => {
  const h = host({ audit: { sink: 'memory', allowNonDurable: true } });
  let runs = 0;
  h.policy.registerCommand(h.ctx, { name: 'retained', description: 'Exercise lifecycle cleanup', action: read.action,
    handler: async () => (++runs, { kind: 'success' }) });
  const retained = h.commands.get('retained').handler;
  h.dispose();
  assert.match((await retained(invocation())).text, /disposed/);
  assert.equal(runs, 0);
});

test('concurrent preparation and reuse after settlement cannot mint another admission', async () => {
  const h = host();
  let release, writes = 0;
  h.policy.setAuditSink({ durable: true, append() {
    if (++writes === 1) return new Promise((resolve) => { release = resolve; });
  } });
  const exec = execution();
  const first = h.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }));
  const concurrent = await h.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }));
  assert.equal(concurrent.kind, 'deny');
  release();
  assert.equal((await first).kind, 'allow');
  assert.equal(h.guards[0](exec), undefined);
  await h.listeners.get('tools/post-execute')(exec, { isError: false }, async () => ({ kind: 'accept' }));
  assert.equal((await h.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))).kind, 'deny');
  assert.equal(writes, 2, 'one begin and one settle only');
  h.dispose();
});

test('structured command arguments are normalized once and parser errors are redacted', async () => {
  const h = host({ audit: { sink: 'memory', allowNonDurable: true } });
  let runs = 0;
  h.policy.registerCommand(h.ctx, { name: 'structured', description: 'Use a trusted argument parser', action: read.action,
    resolveArguments: () => ({ target: 'repo-normalized' }),
    handler: async (_invocation, args) => (++runs, { kind: 'success', text: args.target }) });
  assert.equal((await h.commands.get('structured').handler(invocation())).text, 'repo-normalized');
  assert.equal(h.policy.auditRecords()[0].target, 'repo-normalized');
  for (const [name, resolver] of [['invalid', () => 'not an argument object'], ['throwing', () => { throw new Error('secret-canary'); }]]) {
    h.policy.registerCommand(h.ctx, { name, description: 'Exercise parser rejection', action: read.action,
      resolveArguments: resolver, handler: async () => (++runs, { kind: 'success' }) });
    const result = await h.commands.get(name).handler(invocation());
    assert.equal(result.kind, 'error');
    assert.equal(result.text.includes('secret-canary'), false);
  }
  assert.equal(runs, 1);
  h.dispose();
});
