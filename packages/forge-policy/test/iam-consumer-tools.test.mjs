import test from 'node:test';
import assert from 'node:assert/strict';
import { toolFixture } from './support/iam-consumer-tools.mjs';
import { hold } from './support/iam-consumer.mjs';
import { createToolRuntime } from './support/tool-runtime.mjs';

const fixed = (result) => {
  assert.ok(result.isError === true || result.kind === 'error');
  assert.match(JSON.stringify(result), /IAM_CONSUMPTION_(UNVERIFIED|DENIED|CHANGED|UNKNOWN|INPUT_INVALID)/);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
};
const entered = (gate, pending) => Promise.race([gate.entered, pending.then(() => assert.fail('actual registered waiting boundary was not reached'))]);

test('actual registered pre/guard/body/finalize/result shares one original operation and one audited send', async (t) => {
  const h = toolFixture(t);
  const result = await h.run();
  assert.equal(result.isError, false); assert.equal(result.value.message, 'synthetic result');
  assert.equal(h.counts.handler, 1); assert.equal(h.counts.send, 1);
  assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
  assert.equal(h.bodyExecutions[0], h.executions[0]);
  assert.deepEqual(h.requests, [{ target: 'repo-A', payload: 'synthetic input' }]);
  assert.deepEqual(h.phases, ['pre', 'guard', 'execute', 'body', 'post', 'finalize', 'result']);
  assert.deepEqual(h.policy.auditRecords().map((record) => record.phase), ['begin', 'settle']);
  assert.equal(h.policy.auditDegraded(), false);
  for (const key of Reflect.ownKeys(h.executions[0])) assert.doesNotMatch(String(key), /permit|witness|operation/);
});

for (const absent of ['iam', 'session', 'verifier']) {
  test(`actual owned tool with absent ${absent} has zero handler and sender calls`, async (t) => {
    const h = toolFixture(t);
    if (absent === 'iam') h.removeIam();
    if (absent === 'session') h.authority.clearWitness();
    if (absent === 'verifier') h.options.verifyConsumerSources = () => false;
    fixed(await h.run());
    assert.equal(h.counts.handler, 0); assert.equal(h.counts.send, 0);
  });
}

test('ordinary unregistered tool keeps its native behavior without touching private sources', async (t) => {
  const h = toolFixture(t); let ordinary = 0;
  h.ctx.tools.register({ name: 'ordinary', description: 'Ordinary fixture tool', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'ordinary' }] },
    async execute() { ordinary++; return { ordinary: true }; } });
  h.removeIam();
  const result = await h.run('ordinary');
  assert.equal(result.isError, false); assert.equal(ordinary, 1); assert.equal(h.counts.source, 0);
});

test('an earlier pre short circuit cannot bypass the missing-original-operation hard guard', async (t) => {
  const h = toolFixture(t);
  h.first('tools/pre-execute', async () => ({ kind: 'allow' }));
  fixed(await h.run()); assert.equal(h.counts.handler, 0); assert.equal(h.counts.send, 0);
  assert.equal(h.authority.counts.capture, 0);
});

for (const point of ['permission', 'audit', 'pre']) {
  test(`actual ${point} waiting boundary cannot rebind the same source tuple and continue`, async (t) => {
    const gate = hold(); t.after(gate.release); const h = toolFixture(t);
    if (point === 'permission') h.authority.setReadBarrier(() => gate.pause());
    if (point === 'audit') h.policy.setAuditSink({ durable: true, async append(record) { if (record.phase === 'begin') await gate.pause(); } });
    if (point === 'pre') h.on('tools/pre-execute', async (_exec, next) => { await gate.pause(); return next(); });
    const pending = h.run(); await entered(gate, pending);
    h.bind(h.installed.tools[0]); gate.release(); fixed(await pending);
    assert.equal(h.counts.handler, 0); assert.equal(h.counts.send, 0);
    assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
  });
}

test('execute waterfall changing the source after native guard never reaches the owned handler', async (t) => {
  const h = toolFixture(t);
  h.on('tools/execute', async (_exec, next) => { h.authority.replaceWitness(); return next(); });
  fixed(await h.run()); assert.equal(h.counts.handler, 0); assert.equal(h.counts.send, 0);
});

test('actual owned handler wait rechecks before fake sending and does not prepare a new session', async (t) => {
  const gate = hold(); t.after(gate.release);
  const h = toolFixture(t, { beforeSend: () => gate.pause() });
  const pending = h.run(); await entered(gate, pending);
  h.authority.replaceWitness(); h.authority.grant();
  gate.release(); fixed(await pending);
  assert.equal(h.counts.handler, 1); assert.equal(h.counts.send, 0);
  assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
});

for (const shortCircuit of [false, true]) {
  test(`definition-owned finalize rejects old success after post wait (short circuit=${shortCircuit})`, async (t) => {
    const gate = hold(); t.after(gate.release); const h = toolFixture(t);
    h.first('tools/post-execute', async (_exec, _result, next) => {
      await gate.pause(); return shortCircuit ? { kind: 'accept', value: { target: 'repo-A', message: 'SYNTHETIC_PRIVATE stale success' } } : next();
    });
    const pending = h.run(); await entered(gate, pending);
    h.authority.clearWitness(); gate.release(); fixed(await pending);
    assert.equal(h.counts.send, 1); assert.equal(h.finalResults.at(-1).isError, true);
    assert.equal(h.policy.auditDegraded(), false, 'result fallback settles a short-circuited audit post');
  });
}

test('IAM source removal keeps the existing policy guard and owned tool registered but denied', async (t) => {
  const h = toolFixture(t); const guards = h.guards.length;
  h.removeIam(); fixed(await h.run());
  assert.equal(h.guards.length, guards); assert.equal(h.definitions.has('synthetic.read'), true);
  assert.equal(h.ctx.get('policy'), h.policy); assert.equal(h.counts.send, 0);
});

test('consumer owner unload removes its tools and commands before old handler can send', async (t) => {
  const gate = hold(); t.after(gate.release); const h = toolFixture(t, { beforeSend: () => gate.pause() });
  const retained = h.installed.tools[0]; const pending = h.run(); await entered(gate, pending);
  h.installed.dispose();
  assert.equal(h.definitions.has('synthetic.read'), false); assert.equal(h.commands.has('synthetic-read'), false);
  gate.release(); fixed(await pending); assert.equal(h.counts.send, 0);
  await assert.rejects(retained.execute(h.executions[0].arguments, h.executions[0]), /IAM_CONSUMPTION_/);
});

test('scope target A cannot send request B, and unknown permission-shaped arguments are rejected', async (t) => {
  const h = toolFixture(t);
  fixed(await h.run('synthetic.read', { target: 'repo-B', payload: 'body' }));
  fixed(await h.run('synthetic.read', { target: 'repo-A', payload: 'body', allowed: true }));
  assert.equal(h.counts.handler, 0); assert.equal(h.counts.send, 0); assert.equal(h.authority.counts.read, 0);
});

test('SDK-style execute signal fusion does not invalidate the original operation', async (t) => {
  const h = toolFixture(t);
  h.on('tools/execute', async (exec, next) => { exec.signal = AbortSignal.any([exec.signal, new AbortController().signal]); return next(); });
  assert.equal((await h.run()).isError, false); assert.equal(h.counts.send, 1);
});

for (const point of ['handler', 'sent-error']) {
  test(`cancel at actual ${point} boundary emits fixed failure without retry or late adoption`, async (t) => {
    const gate = hold(); t.after(gate.release); const cancel = new AbortController();
    const h = toolFixture(t, point === 'handler' ? { beforeSend: () => gate.pause() }
      : { send: async () => { await gate.pause(); throw new Error('SYNTHETIC_PRIVATE downstream'); } });
    const pending = h.run('synthetic.read', undefined, cancel.signal); await entered(gate, pending);
    cancel.abort(); gate.release(); fixed(await pending);
    assert.equal(h.counts.send, point === 'handler' ? 0 : 1);
  });
}

test('current fake transport failure is fixed UNKNOWN with one send and no compensation', async (t) => {
  const h = toolFixture(t, { send: async () => { throw new Error('SYNTHETIC_PRIVATE transport'); } });
  const result = await h.run(); fixed(result); assert.match(JSON.stringify(result), /IAM_CONSUMPTION_UNKNOWN/);
  assert.equal(h.counts.send, 1);
});

test('actual registered command uses normalized arguments and original base audit/guard/settlement', async (t) => {
  const h = toolFixture(t);
  const invocation = { commandId: 'command-positive', agent: Object.freeze({ id: 'agent-fixture' }), rawInput: 'repo-A', attachments: [], signal: new AbortController().signal };
  const before = Reflect.ownKeys(invocation);
  const result = await h.commands.get('synthetic-read').handler(invocation);
  assert.equal(result.kind, 'success'); assert.equal(h.counts.send, 1);
  assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
  assert.deepEqual(h.requests, [{ target: 'repo-A', payload: 'synthetic command' }]);
  const exec = h.bodyExecutions[0]; assert.equal(exec.agent, invocation.agent); assert.equal(exec.callId, invocation.commandId);
  assert.equal(typeof exec.token, 'symbol'); assert.equal(typeof exec.rootCallId, 'string');
  assert.deepEqual(Reflect.ownKeys(invocation), before, 'internal execution metadata is not added to CommandInvocation');
  assert.deepEqual(h.policy.auditRecords().map((record) => record.phase), ['begin', 'settle']);
});

for (const absence of ['iam', 'agent', 'target']) {
  test(`actual registered command refuses missing ${absence} with zero handler and sender`, async (t) => {
    const h = toolFixture(t);
    if (absence === 'iam') h.removeIam();
    fixed(await h.command('synthetic-read', absence === 'agent' ? { agent: undefined } : absence === 'target' ? { rawInput: 'repo-B' } : {}));
    assert.equal(h.counts.handler, 0); assert.equal(h.counts.send, 0);
  });
}

for (const point of ['audit', 'handler', 'settlement']) {
  test(`registered command ${point} await cannot adopt a changed session`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = toolFixture(t, point === 'handler' ? { beforeSend: () => gate.pause() } : {});
    if (point !== 'handler') h.policy.setAuditSink({ durable: true, async append(record) {
      if (record.phase === (point === 'audit' ? 'begin' : 'settle')) await gate.pause();
    } });
    const pending = h.command(); await entered(gate, pending);
    h.authority.replaceWitness(); gate.release(); fixed(await pending);
    assert.equal(h.counts.send, point === 'settlement' ? 1 : 0);
    assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
  });
}

test('a foreign error from an awaited owned handler is CHANGED after the original context changes', async (t) => {
  const gate = hold(); t.after(gate.release);
  const h = toolFixture(t, { beforeSend: async () => { await gate.pause(); throw new Error('SYNTHETIC_PRIVATE callee'); } });
  const pending = h.run(); await entered(gate, pending); h.authority.clearWitness(); gate.release();
  const result = await pending; fixed(result); assert.match(JSON.stringify(result), /IAM_CONSUMPTION_CHANGED/);
  assert.equal(h.counts.send, 0);
});

test('an unowned command cannot alias the private action through public service registration', async (t) => {
  const h = toolFixture(t); let sends = 0;
  h.policy.registerCommand(h.ctx, { name: 'foreign', description: 'Unowned alias', action: 'synthetic.read',
    resolveArguments: () => ({ target: 'repo-A', payload: 'body' }),
    handler: async () => { sends++; return { kind: 'success', text: 'unexpected' }; } });
  fixed(await h.command('foreign')); assert.equal(sends, 0); assert.equal(h.counts.source, 0);
});

test('command caller cancellation during its actual handler wait never reaches the sender', async (t) => {
  const gate = hold(); t.after(gate.release); const cancel = new AbortController();
  const h = toolFixture(t, { beforeSend: () => gate.pause() });
  const pending = h.command('synthetic-read', { signal: cancel.signal }); await entered(gate, pending);
  cancel.abort(); gate.release(); fixed(await pending); assert.equal(h.counts.send, 0);
});

test('ordinary apply and isolated module import do not discover sources or register synthetic capabilities', async () => {
  const host = createToolRuntime();
  const testing = await import('@heluo/forge-policy/isolated-testing');
  assert.equal(typeof testing.installIamConsumerTools, 'function');
  assert.equal(host.definitions.size, 0); assert.equal(host.commands.size, 0); assert.equal(host.guards.length, 0);
  const { apply } = await import('../src/index.mjs');
  const config = { audit: { sink: 'memory', allowNonDurable: true }, catalog: [] };
  Object.defineProperty(config, 'getSources', { get() { assert.fail('ordinary config probed a private source'); } });
  const dispose = apply(host.ctx, config);
  assert.equal(host.definitions.size, 0); assert.equal(host.commands.size, 0); dispose();
});
