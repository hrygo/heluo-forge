import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as module from '../src/iam-consumer.mjs';
import { createConsumerFixture, execution, hold } from './support/iam-consumer.mjs';

const code = (expected) => (error) => error.code === `IAM_CONSUMPTION_${expected}`
  && !JSON.stringify(error).includes('SYNTHETIC_PRIVATE') && !String(error.message).includes('SYNTHETIC_PRIVATE')
  && error.cause === undefined;
const setup = (options) => { const fixture = createConsumerFixture(options); return { ...fixture, core: module.createIamConsumer(fixture.options) }; };

for (const kind of ['tool', 'model']) {
  test(`${kind} core captures one witness, reads one permit and dispatches exactly once`, async () => {
    const h = setup({ kind }); const exec = execution(); const keys = Reflect.ownKeys(exec);
    const operation = await h.core.prepare(exec, h.scope);
    assert.ok(Object.isFrozen(operation)); assert.deepEqual(Reflect.ownKeys(operation), []);
    assert.equal(h.core.assertCurrent(operation, exec), true);
    assert.equal(h.seen.witness, h.witness()); assert.ok(Object.isFrozen(h.seen.scope));
    assert.deepEqual(h.seen.scope, h.scope);
    const result = await h.core.dispatch(operation, exec, (input) => {
      assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.body));
      assert.deepEqual(input, exec.arguments);
      return h.send(input);
    });
    assert.equal(h.core.assertCurrent(operation, exec), true, 'sent operation remains checkable for streaming until finish');
    assert.equal(h.core.finish(operation, exec, result), result);
    assert.equal(h.counts.capture, 1); assert.equal(h.counts.read, 1); assert.equal(h.counts.send, 1);
    assert.deepEqual(Reflect.ownKeys(exec), keys, 'no witness, permit or operation is attached to execution');
    await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
    await assert.rejects(h.core.prepare(exec, h.scope), code('CHANGED'));
    h.core.release(operation); h.core.dispose();
  });
}

for (const field of ['iam', 'witnessSource', 'authorizer', 'consumer']) {
  test(`missing or unregistered ${field} rejects before capture and permit read`, async () => {
    const h = setup(); h.bind({ iam: h.iam, witnessSource: h.witnessSource, authorizer: h.authorizer, consumer: h.consumer, [field]: {} });
    await assert.rejects(h.core.prepare(execution(), h.scope), code('UNVERIFIED'));
    assert.equal(h.counts.capture, 0); assert.equal(h.counts.read, 0); assert.equal(h.counts.send, 0);
  });
}

for (const field of ['issuer', 'subject', 'kind', 'target', 'purpose', 'revision']) {
  test(`permit ${field} mismatch or empty revision never authorizes a send`, async () => {
    const h = setup(); h.grant({ [field]: field === 'revision' ? '' : 'wrong-value' });
    await assert.rejects(h.core.prepare(execution(), h.scope), code('DENIED'));
    assert.equal(h.counts.read, 1); assert.equal(h.counts.send, 0);
  });
}

test('unregistered or malformed scope is not inferred from a tool name or caller readOnly flag', async () => {
  const h = setup();
  await assert.rejects(h.core.prepare(execution(), { ...h.scope, target: 'unregistered' }), code('UNVERIFIED'));
  await assert.rejects(h.core.prepare(execution(), { ...h.scope, allowed: true }), code('INPUT_INVALID'));
  assert.equal(h.counts.capture, 0); assert.equal(h.counts.read, 0);
});

test('no session, revoked permission and local deadline expiry remain denied', async () => {
  const h = setup(); h.clearWitness();
  await assert.rejects(h.core.prepare(execution('no-session'), h.scope), code('DENIED'));
  assert.equal(h.counts.read, 0);
  h.replaceWitness(); h.revoke();
  await assert.rejects(h.core.prepare(execution('revoked'), h.scope), code('DENIED'));
  h.grant({}, { ttl: 5 }); h.advance(5);
  await assert.rejects(h.core.prepare(execution('expired'), h.scope), code('DENIED'));
  assert.equal(h.counts.send, 0);
});

for (const change of ['permission', 'witness', 'owner', 'rebind', 'input', 'cancel']) {
  test(`${change} during permit read cannot be repaired with a fresh witness or permit`, async (t) => {
    const h = setup(); const exec = execution(); const gate = hold(); t.after(gate.release);
    const cancel = new AbortController(); exec.signal = cancel.signal;
    h.setReadBarrier(() => gate.pause());
    const pending = h.core.prepare(exec, h.scope); const observed = pending.catch((error) => error);
    await Promise.race([gate.entered, pending]);
    if (change === 'permission') h.grant();
    if (change === 'witness') h.replaceWitness();
    if (change === 'owner') h.unload();
    if (change === 'rebind') h.bind();
    if (change === 'input') exec.arguments.target = 'repo-B';
    if (change === 'cancel') cancel.abort();
    // The permit is first observed when read resolves: a no-longer-current
    // first permit is DENIED; already captured witness/tuple/input changes are CHANGED.
    gate.release(); assert.ok(code(change === 'permission' ? 'DENIED' : 'CHANGED')(await observed));
    assert.equal(h.counts.capture, 1); assert.equal(h.counts.read, 1); assert.equal(h.counts.send, 0);
  });
}

test('only the original execution object can use an operation, even with identical callId and fields', async () => {
  const h = setup(); const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
  const clone = { ...exec };
  assert.throws(() => h.core.assertCurrent(operation, clone), code('CHANGED'));
  await assert.rejects(h.core.dispatch(operation, clone, h.send), code('CHANGED'));
  assert.equal(h.counts.send, 0);
});

test('same tuple owner rebind invalidates old operation without re-reading authority', async () => {
  const h = setup(); const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
  h.unbind(); h.bind();
  assert.throws(() => h.core.assertCurrent(operation, exec), code('CHANGED'));
  await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
  assert.equal(h.counts.capture, 1); assert.equal(h.counts.read, 1); assert.equal(h.counts.send, 0);
});

test('single dispatch remains consumed while its result awaits, and late success is not adopted after cancellation', async (t) => {
  const h = setup(); const exec = execution(); const cancel = new AbortController(); exec.signal = cancel.signal;
  const operation = await h.core.prepare(exec, h.scope); const gate = hold(); t.after(gate.release);
  const pending = h.core.dispatch(operation, exec, async (input) => { h.send(input); await gate.pause(); return 'SYNTHETIC_PRIVATE success'; });
  const observed = pending.catch((error) => error);
  await gate.entered;
  await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
  cancel.abort(); gate.release();
  assert.ok(code('CHANGED')(await observed));
  assert.equal(h.counts.send, 1);
});

test('current downstream failure is fixed UNKNOWN and cannot replay the original execution', async () => {
  const h = setup(); const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
  await assert.rejects(h.core.dispatch(operation, exec, () => { h.counts.send++; throw new Error('SYNTHETIC_PRIVATE downstream'); }), code('UNKNOWN'));
  await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
  await assert.rejects(h.core.prepare(exec, h.scope), code('CHANGED'));
  assert.equal(h.counts.send, 1);
});

test('releasing old operation in finally cannot clear an independent new operation', async () => {
  const h = setup(); const oldExec = execution('old'); const nextExec = execution('new');
  const old = await h.core.prepare(oldExec, h.scope);
  const next = await h.core.prepare(nextExec, h.scope);
  h.core.release(old);
  assert.equal(h.core.assertCurrent(next, nextExec), true);
  const result = await h.core.dispatch(next, nextExec, h.send);
  assert.equal(h.core.finish(next, nextExec, result), result);
  assert.equal(h.counts.send, 1);
});

for (const failure of ['promise-true', 'promise-reject', 'throw']) {
  test(`independent verifier ${failure} is never authority and emits no private error`, async () => {
    const h = setup();
    h.options.verifyConsumerSources = () => {
      if (failure === 'promise-true') return Promise.resolve(true);
      if (failure === 'promise-reject') return Promise.reject(new Error('SYNTHETIC_PRIVATE verifier'));
      throw new Error('SYNTHETIC_PRIVATE verifier');
    };
    await assert.rejects(h.core.prepare(execution(), h.scope), code('UNVERIFIED'));
    assert.equal(h.counts.capture, 0); assert.equal(h.counts.read, 0);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

for (const source of ['witness', 'permit']) {
  test(`${source} async current cannot authorize the already prepared operation`, async () => {
    const h = setup(); const target = source === 'witness' ? h.witnessSource : h.authorizer;
    target.isCurrent = () => Promise.reject(new Error('SYNTHETIC_PRIVATE current'));
    await assert.rejects(h.core.prepare(execution(), h.scope), code('DENIED'));
    assert.equal(h.counts.send, 0);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test('caller accessors and cyclic payloads are fixed input denials without executing the accessor', async () => {
  const h = setup(); let reads = 0;
  const args = { target: 'repo-A', get body() { reads++; throw new Error('SYNTHETIC_PRIVATE accessor'); } };
  await assert.rejects(h.core.prepare(execution('accessor', args), h.scope), code('INPUT_INVALID'));
  assert.equal(reads, 0);
  const cyclic = {}; cyclic.body = cyclic;
  await assert.rejects(h.core.prepare(execution('cycle', cyclic), h.scope), code('INPUT_INVALID'));
  assert.equal(h.counts.capture, 0);
});

for (const field of ['name', 'callId', 'rootCallId', 'token', 'agent', 'arguments']) {
  test(`execution ${field} replacement cannot borrow an unchanged callId or input digest`, async () => {
    const h = setup(); const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
    exec[field] = field === 'token' ? Symbol('replacement') : field === 'agent' ? { ...exec.agent }
      : field === 'arguments' ? structuredClone(exec.arguments) : 'replacement';
    await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
    assert.equal(h.counts.send, 0);
  });
}

for (const change of ['getSources', 'verifier', 'capture', 'witnessCurrent', 'read', 'permitCurrent']) {
  test(`${change} function replacement rejects the original operation even when it returns identical data`, async () => {
    const h = setup(); const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
    const owner = ['getSources', 'verifier'].includes(change) ? h.options : ['capture', 'witnessCurrent'].includes(change) ? h.witnessSource : h.authorizer;
    const key = change === 'verifier' ? 'verifyConsumerSources' : change.endsWith('Current') ? 'isCurrent' : change;
    const original = owner[key]; owner[key] = function (...args) { return original.apply(this, args); };
    assert.throws(() => h.core.assertCurrent(operation, exec), code('CHANGED'));
    owner[key] = original;
    await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
    assert.equal(h.counts.send, 0);
  });
}

for (const change of ['expiry', 'revoke', 'owner', 'dispose']) {
  test(`${change} after preparation refuses the final synchronous send boundary`, async () => {
    const h = setup(); const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
    if (change === 'expiry') h.advance(1000);
    if (change === 'revoke') h.revoke();
    if (change === 'owner') h.unload();
    if (change === 'dispose') h.core.dispose();
    await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
    assert.equal(h.counts.send, 0); assert.equal(h.counts.capture, 1); assert.equal(h.counts.read, 1);
  });
}

for (const field of ['issuer', 'revision']) {
  test(`mutating the original permit ${field} cannot redefine the independent comparison copy`, async () => {
    const h = setup(); h.grant({}, { mutable: true });
    const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
    h.permit()[field] = 'changed';
    assert.equal(h.authorizer.isCurrent(h.permit()), true, 'controller identity/deadline alone cannot hide field mutation');
    await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
    assert.equal(h.counts.send, 0);
  });
}

test('scope mutation after preparation cannot redefine the registered purpose', async () => {
  const h = setup(); const scope = { ...h.scope }; const exec = execution();
  const operation = await h.core.prepare(exec, scope); scope.purpose = 'other';
  await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
  assert.equal(h.counts.send, 0);
});

test('valid SDK-style fused signal replacement preserves the original operation', async () => {
  const h = setup(); const exec = execution(); const extra = new AbortController();
  const operation = await h.core.prepare(exec, h.scope);
  exec.signal = AbortSignal.any([exec.signal, extra.signal]);
  const result = await h.core.dispatch(operation, exec, h.send);
  assert.equal(h.core.finish(operation, exec, result), result);
  assert.equal(h.counts.send, 1);
});

for (const which of ['original', 'current']) {
  test(`${which} signal cancellation is observed without requiring signal identity`, async () => {
    const h = setup(); const exec = execution(); const original = new AbortController(); const current = new AbortController();
    exec.signal = original.signal; const operation = await h.core.prepare(exec, h.scope);
    exec.signal = current.signal;
    (which === 'original' ? original : current).abort();
    await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
    assert.equal(h.counts.send, 0);
  });
}

test('an already cancelled execution is CHANGED, not a malformed request or a new permit read', async () => {
  const h = setup(); const exec = execution(); const cancel = new AbortController(); exec.signal = cancel.signal; cancel.abort();
  await assert.rejects(h.core.prepare(exec, h.scope), code('CHANGED'));
  assert.equal(h.counts.capture, 0); assert.equal(h.counts.read, 0);
});

for (const outcome of ['success', 'error']) {
  test(`owner unload while a sent ${outcome} awaits drops the old outcome and does not affect a new core`, async (t) => {
    const h = setup(); const exec = execution(); const operation = await h.core.prepare(exec, h.scope);
    const gate = hold(); t.after(gate.release);
    const pending = h.core.dispatch(operation, exec, async (input) => {
      h.send(input); await gate.pause();
      if (outcome === 'error') throw new Error('SYNTHETIC_PRIVATE late error');
      return 'SYNTHETIC_PRIVATE late success';
    });
    const observed = pending.catch((error) => error);
    await Promise.race([gate.entered, pending]); h.unload();
    const next = setup(); const nextExec = execution('new'); const nextOperation = await next.core.prepare(nextExec, next.scope);
    gate.release(); assert.ok(code('CHANGED')(await observed)); h.core.release(operation);
    const result = await next.core.dispatch(nextOperation, nextExec, next.send);
    assert.equal(next.core.finish(nextOperation, nextExec, result), result);
    assert.equal(h.counts.send, 1); assert.equal(next.counts.send, 1);
  });
}

for (const bad of ['getSources', 'read', 'capture']) {
  test(`rejecting async ${bad} is converged and never reveals private error text`, async () => {
    const h = setup();
    const reject = () => Promise.reject(new Error('SYNTHETIC_PRIVATE source'));
    if (bad === 'getSources') h.options.getSources = reject;
    else if (bad === 'read') h.authorizer.read = reject;
    else h.witnessSource.capture = reject;
    await assert.rejects(h.core.prepare(execution(), h.scope), code(bad === 'capture' ? 'DENIED' : 'UNVERIFIED'));
    assert.equal(h.counts.send, 0);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test('permit unknown fields and accessor fields are rejected without evaluating the getter', async () => {
  const h = setup(); h.grant({ allowed: true });
  await assert.rejects(h.core.prepare(execution('unknown'), h.scope), code('DENIED'));
  h.grant({}, { mutable: true }); let reads = 0;
  Object.defineProperty(h.permit(), 'revision', { get() { reads++; throw new Error('SYNTHETIC_PRIVATE permit'); } });
  await assert.rejects(h.core.prepare(execution('getter'), h.scope), code('DENIED'));
  assert.equal(reads, 0); assert.equal(h.counts.send, 0);
});

test('independent verifier reentry cannot revoke a permit between its last current check and send', async () => {
  const h = setup(); const original = h.options.verifyConsumerSources; let armed = false; let checks = 0;
  h.options.verifyConsumerSources = (...args) => { if (armed && ++checks === 2) h.revoke(); return original(...args); };
  const exec = execution(); const operation = await h.core.prepare(exec, h.scope); armed = true;
  await assert.rejects(h.core.dispatch(operation, exec, h.send), code('CHANGED'));
  assert.equal(h.counts.send, 0);
});

test('explicit isolated-testing subpath exports only the private B core inside existing package files', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./isolated-testing'], './src/isolated-testing.mjs');
  assert.ok(manifest.files.includes('src'));
  const testing = await import('@heluo/forge-policy/isolated-testing');
  assert.deepEqual(Object.keys(testing), ['createIamConsumer', 'installIamConsumerModel', 'installIamConsumerTools']);
  assert.equal(testing.createIamConsumer, module.createIamConsumer);
});
