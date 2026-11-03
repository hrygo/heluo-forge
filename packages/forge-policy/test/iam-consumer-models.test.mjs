import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFixture, request, chunks, collect, provider, model } from './support/iam-consumer-models.mjs';
import { hold } from './support/iam-consumer.mjs';
import { installIamConsumerModel } from '../src/iam-consumer-models.mjs';

const fixed = (values, code) => {
  const last = values.at(-1); assert.equal(last.type, 'finish');
  assert.ok(['error', 'aborted'].includes(last.reason.kind));
  assert.match(last.reason.failure.code, code ?? /^IAM_CONSUMPTION_(UNVERIFIED|DENIED|CHANGED|UNKNOWN|INPUT_INVALID)$/);
  assert.doesNotMatch(JSON.stringify(values), /SYNTHETIC_PRIVATE/);
};
const entered = (gate, pending) => Promise.race([gate.entered, pending.then(() => assert.fail('actual adapter waiting boundary not reached'))]);

test('registered prepareCall is metadata only; actual stream entry eagerly fixes one operation and sends one frozen request', async (t) => {
  const h = modelFixture(t); const prepared = await h.prepare();
  assert.equal(h.authority.counts.capture, 0); assert.equal(h.authority.counts.read, 0);
  h.probe((actual) => {
    assert.equal(typeof actual[Symbol.asyncIterator], 'function'); assert.equal(actual.then, undefined);
    assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
  });
  const input = request(); const keys = Reflect.ownKeys(input); const outer = prepared.stream(input);
  assert.equal(h.calls.waterfall, 1); assert.equal(h.authority.counts.capture, 0, 'outer waterfall default is lazy, not authorization');
  const result = await collect(outer);
  assert.equal(result.at(-1).reason.kind, 'stop'); assert.equal(h.counts.send, 1);
  assert.equal(h.requests[0].provider, provider); assert.equal(h.requests[0].model, model);
  assert.equal(h.requests[0].purpose, 'compaction', 'SDK purpose is not business authorization purpose');
  assert.ok(Object.isFrozen(h.requests[0].messages)); assert.deepEqual(Reflect.ownKeys(input), keys);
  assert.equal(h.calls.info, 1); assert.equal(h.calls.retry, 1);
  assert.deepEqual(prepared.retryPolicy, { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0 });
});

for (const change of ['iam', 'logout', 'target', 'purpose']) {
  test(`actual registered model refuses ${change} before its sender`, async (t) => {
    const h = modelFixture(t);
    if (change === 'iam') h.removeIam();
    if (change === 'logout') h.authority.clearWitness();
    if (change === 'target') h.authority.grant({ target: 'other/model' });
    if (change === 'purpose') h.authority.grant({ purpose: 'compaction' });
    fixed(await h.run()); assert.equal(h.counts.send, 0);
  });
}

test('source rebind while actual beforeSend waits cannot obtain a replacement permit', async (t) => {
  const gate = hold(); t.after(gate.release); const h = modelFixture(t, { beforeSend: () => gate.pause() });
  const pending = h.run(); await entered(gate, pending); h.bind(); gate.release();
  fixed(await pending, /CHANGED/); assert.equal(h.counts.send, 0);
  assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
});

test('between actual stream creation and first iterator next no new session can replace the captured one', async (t) => {
  const h = modelFixture(t);
  h.probe(() => { h.authority.replaceWitness(); });
  fixed(await h.run(), /CHANGED/); assert.equal(h.counts.send, 0);
  assert.equal(h.authority.counts.capture, 1); assert.equal(h.authority.counts.read, 1);
});

for (const which of ['first', 'later']) {
  test(`${which} actual chunk wait does not yield old text after source change`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = modelFixture(t, { send: () => (async function* () {
      if (which === 'later') yield { type: 'block-start', index: 0, blockType: 'text' };
      await gate.pause(); yield { type: 'text-delta', index: 0, text: 'SYNTHETIC_PRIVATE stale text' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })() });
    const pending = h.run(); await entered(gate, pending); h.authority.replaceWitness(); gate.release();
    const values = await pending; fixed(values, /CHANGED/);
    assert.equal(values.length, which === 'later' ? 2 : 1); assert.equal(h.counts.send, 1);
  });
}

for (const outcome of ['success', 'error']) {
  test(`sent ${outcome} settling after caller cancellation stays fixed and never retries`, async (t) => {
    const gate = hold(); t.after(gate.release); const cancel = new AbortController();
    const h = modelFixture(t, { send: async () => {
      await gate.pause(); if (outcome === 'error') throw new Error('SYNTHETIC_PRIVATE late error'); return chunks();
    } });
    const input = { ...request(), signal: cancel.signal };
    const pending = h.run(input); await entered(gate, pending); cancel.abort(); gate.release();
    fixed(await pending, /CHANGED/); assert.equal(h.counts.send, 1);
    assert.equal(h.calls.stream, 1); assert.equal(h.ctx.llm.providerRetryPolicy(provider).maxRetries, 0);
  });
}

for (const outcome of ['throw', 'finish']) {
  test(`current ${outcome} failure is fixed UNKNOWN, not a leaked provider error or a replay`, async (t) => {
    const h = modelFixture(t, { send: () => (async function* () {
      if (outcome === 'throw') throw new Error('SYNTHETIC_PRIVATE transport');
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FOREIGN', message: 'SYNTHETIC_PRIVATE provider' } } };
    })() });
    fixed(await h.run(), /UNKNOWN/); assert.equal(h.counts.send, 1); assert.equal(h.calls.stream, 1);
  });
}

test('owner fiber unload withdraws the route and old awaited iterator cannot adopt its late result', async (t) => {
  const gate = hold(); t.after(gate.release);
  const h = modelFixture(t, { send: () => (async function* () { await gate.pause(); yield { type: 'text-delta', index: 0, text: 'SYNTHETIC_PRIVATE old' }; })() });
  const pending = h.run(); await entered(gate, pending); h.unload();
  assert.equal(h.routes.has(provider), false); gate.release(); fixed(await pending, /CHANGED/); assert.equal(h.counts.send, 1);
});

test('IAM source removal leaves the registered adapter route present but denied', async (t) => {
  const h = modelFixture(t); h.removeIam(); fixed(await h.run());
  assert.equal(h.routes.get(provider).adapter, h.installed.adapter); assert.equal(h.counts.send, 0);
});

test('route conflict fails without replacing the existing adapter or sending anything', async (t) => {
  const h = modelFixture(t);
  assert.throws(() => installIamConsumerModel(h.ctx, h.options), /IAM_CONSUMPTION_/);
  assert.equal(h.routes.size, 1); assert.equal(h.routes.get(provider).adapter, h.installed.adapter); assert.equal(h.counts.send, 0);
});

test('foreign provider/model cannot borrow the owned route or its scope', async (t) => {
  const h = modelFixture(t);
  const unknown = await h.run({ ...request(), provider: 'foreign' }); assert.equal(unknown.at(-1).reason.failure.code, 'NO_ADAPTER');
  fixed(await h.run({ ...request(), model: 'foreign-model' })); assert.equal(h.counts.send, 0); assert.equal(h.counts.source, 0);
});

for (const field of ['top', 'messages']) {
  test(`original ${field} mutation during handler wait is not hidden by a stale private frame`, async (t) => {
    const gate = hold(); t.after(gate.release); const h = modelFixture(t, { beforeSend: () => gate.pause() });
    const input = request(); const pending = h.run(input); await entered(gate, pending);
    if (field === 'top') input.messages = structuredClone(input.messages);
    else input.messages[0].content[0].text = 'SYNTHETIC_PRIVATE changed';
    gate.release(); fixed(await pending, /CHANGED/); assert.equal(h.counts.send, 0);
  });
}

test('returning the old iterator cannot release a newer operation on the same registered adapter', async (t) => {
  const gate = hold(); t.after(gate.release); let calls = 0;
  const h = modelFixture(t, { beforeSend: async () => { if (++calls === 1) await gate.pause(); } });
  let actualOld;
  h.probe((actual) => { actualOld ??= actual[Symbol.asyncIterator](); });
  const old = h.ctx.llm.stream(request())[Symbol.asyncIterator](); const pendingOld = old.next();
  await entered(gate, pendingOld);
  // Close the actual adapter iterator. Native outer async-generator return() is
  // queued behind its outstanding next() and cannot promise immediate abort.
  const closing = actualOld.return();
  const newer = h.ctx.llm.stream(request())[Symbol.asyncIterator]();
  assert.equal((await newer.next()).value.type, 'block-start');
  gate.release(); await pendingOld; await closing;
  const remaining = await collect({ [Symbol.asyncIterator]: () => newer });
  assert.equal(remaining.at(-1).reason.kind, 'stop'); assert.equal(h.counts.send, 1);
});

test('foreign iterator cleanup exception is fixed, never the provider cause', async (t) => {
  const h = modelFixture(t, { send: () => ({ [Symbol.asyncIterator]() { return this; },
    async next() { return { done: false, value: { type: 'block-start', index: 0, blockType: 'text' } }; },
    async return() { throw new Error('SYNTHETIC_PRIVATE cleanup'); },
  }) });
  const iterator = h.ctx.llm.stream(request())[Symbol.asyncIterator](); await iterator.next();
  await assert.rejects(iterator.return(), (error) => /^IAM_CONSUMPTION_/.test(error.code)
    && !JSON.stringify({ message: error.message, cause: error.cause }).includes('SYNTHETIC_PRIVATE'));
  assert.equal(h.counts.send, 1);
});

test('bare iterable sender result is not a model AsyncIterable', async (t) => {
  const h = modelFixture(t, { send: () => [] }); fixed(await h.run(), /UNKNOWN/); assert.equal(h.counts.send, 1);
});

test('ordinary provider is not claimed and retains its independent default policy', async (t) => {
  const h = modelFixture(t); let calls = 0;
  h.ctx.llm.registerAdapter(['ordinary'], { providerInfo: (id) => ({ id, name: 'Ordinary' }), providerRetryPolicy: () => undefined,
    async prepareCall(p, m) { return { model: { provider: p, id: m, name: m }, stream() { calls++; return chunks(); } }; } });
  const values = await h.run({ ...request(), provider: 'ordinary', model: 'ordinary-model' });
  assert.equal(values.at(-1).reason.kind, 'stop'); assert.equal(calls, 1); assert.equal(h.counts.source, 0);
  assert.equal(h.ctx.llm.providerRetryPolicy('ordinary').maxRetries, 5, 'no global retry prohibition is claimed');
});

test('a normal finish is not adopted while its final iterator done wait becomes stale', async (t) => {
  const gate = hold(); t.after(gate.release);
  const h = modelFixture(t, { send: () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }; await gate.pause();
  })() });
  const pending = h.run(); await entered(gate, pending); h.authority.replaceWitness(); gate.release();
  const result = await pending; fixed(result, /CHANGED/); assert.equal(result.length, 1); assert.equal(h.counts.send, 1);
});

test('actual registered adapter iterator throw converges a foreign consumer error without leaking it', async (t) => {
  const h = modelFixture(t); let actual;
  h.probe((stream) => { actual = stream[Symbol.asyncIterator](); });
  const outer = h.ctx.llm.stream(request())[Symbol.asyncIterator](); await outer.next();
  const outcome = await actual.throw(new Error('SYNTHETIC_PRIVATE consumer'));
  fixed([outcome.value], /CHANGED/); await outer.return(); assert.equal(h.counts.send, 1);
});

test('already-aborted metadata prepareCall retains fixed CHANGED before adapter stream entry', async (t) => {
  const h = modelFixture(t);
  fixed(await h.run({ ...request(), signal: AbortSignal.abort() }), /CHANGED/);
  assert.equal(h.counts.send, 0); assert.equal(h.calls.stream, 0); assert.equal(h.authority.counts.capture, 0);
});

test('registry metadata normalization does not trust plain codes, mismatched or accessor carriers', async (t) => {
  const { createModelRuntime } = await import('./support/model-runtime.mjs');
  const host = createModelRuntime(); t.after(host.unload); let thrown, getters = 0;
  host.ctx.llm.registerAdapter(['bridge'], { providerInfo: (id) => ({ id, name: 'Bridge' }), providerRetryPolicy: () => undefined,
    async prepareCall() { throw thrown; }, stream() { assert.fail('metadata error reached stream'); } });
  const code = 'IAM_CONSUMPTION_INPUT_INVALID';
  const plain = Object.assign(new Error(), { code });
  Object.defineProperty(plain, 'message', { get() { getters++; throw new Error('SYNTHETIC_PRIVATE message'); } });
  const mismatch = Object.assign(new Error(), { code, failure: Object.freeze({ code: 'OTHER', message: 'SYNTHETIC_PRIVATE mismatch' }) });
  const accessor = Object.assign(new Error(), { code });
  Object.defineProperty(accessor, 'failure', { get() { getters++; return { code, message: 'SYNTHETIC_PRIVATE accessor' }; } });
  const invalidOptional = Object.assign(new Error(), { code, failure: Object.freeze({ code, message: 'SYNTHETIC_PRIVATE invalid', status: 99 }) });
  for (thrown of [plain, mismatch, accessor, invalidOptional]) {
    const values = await collect(host.ctx.llm.stream({ ...request(), provider: 'bridge' }));
    assert.equal(values.at(-1).reason.failure.code, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(values), /SYNTHETIC_PRIVATE/);
  }
  assert.equal(getters, 0); assert.equal(host.calls.stream, 0);
});

test('registry metadata bridge detaches a valid frozen own-code failure and only SDK facts', async (t) => {
  const { createModelRuntime } = await import('./support/model-runtime.mjs');
  const host = createModelRuntime(); t.after(host.unload);
  const facts = { code: 'IAM_CONSUMPTION_INPUT_INVALID', message: 'fixed metadata failure', status: 503,
    providerRetryAfterMs: 25, requestId: 'synthetic-request', offloadImages: 1 };
  const carried = Object.freeze({ ...facts, body: 'SYNTHETIC_PRIVATE body' });
  const thrown = Object.assign(new Error('SYNTHETIC_PRIVATE raw'), { code: facts.code, failure: carried, cause: 'SYNTHETIC_PRIVATE cause' });
  host.ctx.llm.registerAdapter(['bridge'], { providerInfo: (id) => ({ id, name: 'Bridge' }), providerRetryPolicy: () => undefined,
    async prepareCall() { throw thrown; }, stream() { assert.fail('metadata error reached stream'); } });
  const values = await collect(host.ctx.llm.stream({ ...request(), provider: 'bridge' }));
  const result = values.at(-1).reason.failure;
  assert.deepEqual(result, facts); assert.notEqual(result, carried); assert.ok(Object.isFrozen(result));
  assert.doesNotMatch(JSON.stringify(values), /SYNTHETIC_PRIVATE/); assert.equal(host.calls.stream, 0);
});

test('isolated model factory import has no registration side effects', async () => {
  const testing = await import('@heluo/forge-policy/isolated-testing');
  assert.equal(testing.installIamConsumerModel, installIamConsumerModel);
  const { createModelRuntime } = await import('./support/model-runtime.mjs');
  assert.equal(createModelRuntime().routes.size, 0);
});
