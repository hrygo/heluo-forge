import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createGatewayCredentialStore } from '../src/store.mjs';
import { createAtomicGatewayFixture } from './support/atomic-gateway.mjs';

const input = Object.freeze({ value: `uag-${'a'.repeat(32)}`, ownerSubject: 'synthetic-user',
  deviceLabel: 'synthetic-label', enteredAt: '2026-11-02T00:00:00.000Z' });
const otherValue = `uag-${'b'.repeat(32)}`;
const mutate = (pair, field) => {
  if (field === 'value') {
    pair.value = otherValue;
    if (pair.record?.payload?.type !== 'heluo-iam-gateway-tombstone') {
      pair.record.payload.valueDigest = createHash('sha256').update(otherValue).digest('hex');
    }
  } else if (field === 'owner') pair.record.payload.ownerSubject = 'synthetic-other';
  else if (field === 'label') pair.record.payload.deviceLabel = 'converted-label';
  else pair.record.payload.writeOperationId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
};
function fixture() {
  const f = createAtomicGatewayFixture();
  return { ...f, store: createGatewayCredentialStore(f.credentials, f.options) };
}
const operation = (f, name) => name === 'save' ? f.store.save(input) : f.store.clear();
const unknown = (error) => { assert.equal(error?.code, 'IAM_GATEWAY_WRITE_UNKNOWN'); return true; };

for (const [name, fields] of [['save', ['value', 'owner', 'label', 'generation']], ['clear', ['value', 'generation']]]) {
  for (const field of fields) {
    test(`${name} rejects adapter mutation of ${field} before admission without committing`, async () => {
      const f = fixture(); const before = f.pair();
      f.adapter.beforeCommit = (_expected, next) => mutate(next, field);
      await assert.rejects(operation(f, name), unknown);
      assert.equal(f.adapter.commits, 0);
      assert.equal(isDeepStrictEqual(f.pair(), before), true);
    });
  }
}

for (const name of ['save', 'clear']) {
  test(`${name} mutation after admission cannot become a successful receipt`, async () => {
    const f = fixture(); const cas = f.adapter.compareAndSwap.bind(f.adapter);
    f.adapter.compareAndSwap = (scope, expected, next, guard) => cas(scope, expected, next, () => {
      const admitted = guard(); mutate(next, name === 'save' ? 'value' : 'generation'); return admitted;
    });
    await assert.rejects(operation(f, name), unknown);
    assert.equal(f.adapter.commits, 1);
    assert.equal(f.adapter.attempts, 1);
    // The already committed fault is not compensated or retried.
    assert.equal(f.pair().record !== undefined, true);
  });

  test(`${name} receipt remains valid when only adapter arguments change after its commit`, async () => {
    const f = fixture(); const cas = f.adapter.compareAndSwap.bind(f.adapter); let exposed;
    f.adapter.compareAndSwap = (scope, expected, next, guard) => {
      exposed = next; return cas(scope, expected, next, guard);
    };
    f.adapter.afterCommit = () => mutate(exposed, name === 'save' ? 'owner' : 'generation');
    const result = await operation(f, name);
    assert.equal(result.ok, true);
    assert.equal(f.adapter.commits, 1);
    if (name === 'save') {
      assert.equal(result.credential.ownerSubject, input.ownerSubject);
      assert.equal(f.pair().value === input.value, true);
    } else assert.equal(f.pair().value, undefined);
  });
}

test('save result metadata is detached from retained adapter arguments', async () => {
  const f = fixture(); const cas = f.adapter.compareAndSwap.bind(f.adapter); let exposed;
  f.adapter.compareAndSwap = (scope, expected, next, guard) => {
    exposed = next; return cas(scope, expected, next, guard);
  };
  const result = await f.store.save(input);
  const before = structuredClone(result.credential);
  mutate(exposed, 'owner'); mutate(exposed, 'label');
  assert.equal(isDeepStrictEqual(result.credential, before), true);
  assert.equal(isDeepStrictEqual(f.pair().record.payload, before), true);
});

test('mutating expected cannot retarget an old save to a newer committed pair', async () => {
  const f = fixture(); const cas = f.adapter.compareAndSwap.bind(f.adapter); let injected = false;
  let newest;
  f.adapter.compareAndSwap = async (scope, expected, next, guard) => {
    if (!injected) {
      injected = true;
      await f.store.save({ ...input, value: otherValue });
      newest = f.pair();
      Object.assign(expected, structuredClone(newest));
    }
    return cas(scope, expected, next, guard);
  };
  await assert.rejects(f.store.save(input), unknown);
  assert.equal(f.adapter.commits, 1);
  assert.equal(isDeepStrictEqual(f.pair(), newest), true);
});

test('mutating a retained snapshot after delivery does not retarget the store snapshot', async () => {
  const f = fixture(); let retained; let held = false;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  f.adapter.afterSnapshot = (pair) => { retained ??= pair; };
  f.adapter.beforeCommit = async () => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
  };
  const pending = f.store.save(input).then(() => null, (error) => error);
  await entered.promise;
  await f.store.save({ ...input, value: otherValue });
  const newest = f.pair(); Object.assign(retained, structuredClone(newest));
  release.resolve();
  assert.equal((await pending)?.code, 'IAM_GATEWAY_CHANGED');
  assert.equal(f.adapter.commits, 1);
  assert.equal(isDeepStrictEqual(f.pair(), newest), true);
});
