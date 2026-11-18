import assert from 'node:assert/strict';
import test from 'node:test';
import { clientModule } from './fixtures/client-module.mjs';

const { createClientOperations, normalizeApiFailure, failureDetails, decodeOperationOutcome, isInstallReceipt } = clientModule;
const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };

test('local writes keep uncertain results across consumers and confirm without resending', async () => {
  const calls = [];
  let outcome = { state: 'pending' };
  const controller = createClientOperations(async (path, init) => {
    calls.push({ path, init });
    if (init?.method === 'POST') throw new TypeError('response lost after commit');
    return path.startsWith('/operation-status?') ? outcome : {};
  });
  await assert.rejects(controller.request('/create', options), /response lost/);
  const pending = controller.getSnapshot();
  assert.equal(pending.phase, 'pending');
  assert.match(calls[0].init.headers['x-dsh-skills-operation'], /^[a-f0-9-]{36}$/);
  const secondConsumer = controller;
  await assert.rejects(secondConsumer.request('/delete', options));
  assert.equal(calls.filter(call => call.init?.method === 'POST').length, 1);
  assert.equal((await controller.confirm()).state, 'pending');
  await controller.request('/state');
  assert.equal(controller.getSnapshot(), pending);
  outcome = { state: 'succeeded', result: { name: 'example-skill' } };
  assert.deepEqual(await secondConsumer.confirm(), outcome);
  assert.equal(controller.getSnapshot(), null);
  assert.equal(calls.filter(call => call.init?.method === 'POST').length, 1);
});

test('only normalized confirmed rejection unlocks local writes', async () => {
  let failure = { code: 'error.repo.invalid', error: 'invalid', outcome: 'rejected' };
  const raw = createClientOperations(async () => { throw failure; });
  await assert.rejects(raw.request('/create', options));
  assert.equal(raw.getSnapshot().phase, 'pending');
  failure = normalizeApiFailure(failure);
  const normalized = createClientOperations(async () => { throw failure; });
  await assert.rejects(normalized.request('/create', options));
  assert.equal(normalized.getSnapshot(), null);
});

test('single flight starts before transport yields and failed status reads never unlock', async () => {
  let reject;
  let writes = 0;
  const controller = createClientOperations(async (_path, init) => {
    if (!init) throw new Error('status unavailable');
    writes++;
    return new Promise((_resolve, fail) => { reject = fail; });
  });
  const first = controller.request('/create', options);
  await assert.rejects(controller.request('/delete', options));
  assert.equal(writes, 1);
  reject(new TypeError('lost'));
  await assert.rejects(first);
  await assert.rejects(controller.confirm(), /status unavailable/);
  assert.equal(controller.getSnapshot().phase, 'pending');
});

test('malformed status and receipts remain pending; a verified refusal carries normalized failure', () => {
  for (const value of [null, {}, { state: 'succeeded' }, { state: 'succeeded', result: {} }, { state: 'rejected', code: 'anything', error: 'failed' }]) {
    assert.equal(decodeOperationOutcome(value, isInstallReceipt).state, 'pending');
  }
  const rejected = decodeOperationOutcome({ state: 'rejected', code: 'error.repo.invalid', error: 'invalid' }, isInstallReceipt);
  assert.equal(rejected.state, 'rejected');
  assert.equal(failureDetails(rejected.failure).message, 'invalid');
  assert.deepEqual(decodeOperationOutcome({ state: 'succeeded', result: { name: 'example', root: '/synthetic' } }, isInstallReceipt), { state: 'succeeded', result: { name: 'example', root: '/synthetic' } });
});
