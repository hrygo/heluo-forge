import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { createGatewayCredentialStore, GATEWAY_RECORD_KEY, GATEWAY_REF } from '../src/store.mjs';
import { createAtomicGatewayFixture, seedLegacyGateway } from './support/atomic-gateway.mjs';

const input = { value: `uag-${'a'.repeat(32)}`, ownerSubject: 'synthetic-user', issuer: 'https://iam.corp.example', baseURL: 'https://gateway.corp.example/v1', enteredAt: '2026-11-02T00:00:00.000Z' };
const replacement = { ...input, value: `uag-${'b'.repeat(32)}` };
const deferred = () => Promise.withResolvers();
function fixture() {
  const f = createAtomicGatewayFixture();
  const legacyWrites = [];
  for (const name of ['set', 'unset', 'modifyRecord', 'deleteRecord']) {
    const original = f.credentials[name].bind(f.credentials);
    f.credentials[name] = (...args) => {
      if (args[0] === GATEWAY_REF || args[0] === GATEWAY_RECORD_KEY) {
        legacyWrites.push(name); throw new Error('legacy gateway primitives are forbidden');
      }
      return original(...args);
    };
  }
  return { ...f, legacyWrites, store: createGatewayCredentialStore(f.credentials, f.options) };
}
const unchanged = (f, before) => assert.equal(isDeepStrictEqual(f.pair(), before), true);

test('explicit joint capability commits metadata/value together without legacy writes', async () => {
  const f = fixture();
  const result = await f.store.save(input);
  assert.equal(result.ok, true);
  assert.equal(f.adapter.attempts, 1);
  assert.equal(f.adapter.commits, 1);
  assert.equal(f.pair().value === input.value, true);
  assert.equal(f.pair().record.payload.version, 3);
  assert.equal(f.pair().record.payload.issuer, input.issuer);
  assert.equal(f.pair().record.payload.baseURL, input.baseURL);
  assert.match(f.pair().record.payload.writeOperationId, /^[0-9a-f-]{36}$/);
  assert.match(f.pair().record.payload.valueDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(f.pair().record), /uag-/);
  assert.deepEqual(f.legacyWrites, []);
});

test('identical value/owner/timestamp saves still acquire distinct generations', async () => {
  const f = fixture(); await f.store.save(input);
  const first = f.pair().record.payload.writeOperationId;
  await f.store.save(input);
  assert.notEqual(f.pair().record.payload.writeOperationId, first);
  assert.equal(f.adapter.commits, 2);
});

test('a v1 pair is never migrated implicitly and stays read-only', async () => {
  const f = fixture(); seedLegacyGateway(f.credentials, input);
  const before = f.pair();
  await assert.rejects(f.store.save(replacement), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  await assert.rejects(f.store.clear(), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  unchanged(f, before);
  assert.equal(f.adapter.commits, 0);
  assert.deepEqual(f.legacyWrites, []);
});

test('a v2 pair is replaceable once by an explicit re-entry (issue #226)', async () => {
  const f = fixture();
  // A record written before the binding existed: digest valid, no issuer.
  f.credentials.records.set(GATEWAY_RECORD_KEY, { kind: 'grant', payload: {
    version: 2, ownerSubject: input.ownerSubject, enteredAt: input.enteredAt,
    writeOperationId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    valueDigest: createHash('sha256').update(input.value).digest('hex'),
  } });
  f.credentials.refs.set(GATEWAY_REF, input.value);
  await f.store.save(replacement);
  assert.equal(f.pair().record.payload.version, 3);
  assert.equal(f.adapter.commits, 1);
});

for (const state of ['orphan', 'unknown-version', 'wrong-kind', 'corrupt']) {
  test(`inconsistent ${state} pair cannot be repaired or silently claimed`, async () => {
    const f = fixture();
    f.credentials.refs.set(GATEWAY_REF, input.value);
    if (state !== 'orphan') f.credentials.records.set(GATEWAY_RECORD_KEY,
      state === 'wrong-kind' ? { kind: 'api-key', key: 'synthetic' }
        : { kind: 'grant', payload: state === 'corrupt' ? {} : { version: 99, ownerSubject: input.ownerSubject, enteredAt: input.enteredAt } });
    const before = f.pair();
    for (const operation of ['save', 'clear']) {
      await assert.rejects(() => operation === 'save' ? f.store.save(replacement) : f.store.clear(), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
    }
    unchanged(f, before); assert.equal(f.adapter.commits, 0);
  });
}

test('digest mismatch is not mutable and is not resolved as matching modern metadata', async () => {
  const f = fixture(); await f.store.save(input);
  const credential = (await f.store.read()).credential;
  f.credentials.refs.set(GATEWAY_REF, replacement.value);
  const before = f.pair();
  assert.deepEqual(await f.store.resolve(credential), { invalid: true });
  await assert.rejects(f.store.clear(), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  unchanged(f, before);
});

test('clear atomically leaves a unique logical tombstone, including repeated empty clears', async () => {
  const f = fixture(); await f.store.save(input);
  await f.store.clear();
  const first = f.pair();
  assert.equal(first.value, undefined);
  assert.equal(first.record.payload.type, 'heluo-iam-gateway-tombstone');
  assert.equal((await f.store.read()).credential, null);
  await f.store.clear();
  assert.notEqual(f.pair().record.payload.writeOperationId, first.record.payload.writeOperationId);
  assert.equal(f.adapter.commits, 3);
  assert.deepEqual(f.legacyWrites, []);
});

for (const intervening of ['save', 'save-clear', 'empty-clear']) {
  test(`an old snapshot cannot overwrite an intervening ${intervening}`, async () => {
    const f = fixture(); const entered = deferred(); const release = deferred(); let blocked = false;
    f.adapter.beforeCommit = async (_expected, next) => {
      if (!blocked && next.value === input.value) { blocked = true; entered.resolve(); await release.promise; }
    };
    const pending = f.store.save(input).then(() => null, (error) => error);
    await entered.promise;
    if (intervening !== 'empty-clear') await f.store.save(replacement);
    if (intervening !== 'save') await f.store.clear();
    const newest = f.pair();
    release.resolve();
    assert.equal((await pending)?.code, 'IAM_GATEWAY_CHANGED');
    unchanged(f, newest);
    assert.deepEqual(f.legacyWrites, []);
  });
}

for (const operation of ['save', 'clear']) {
  for (const result of ['false', 'throw', 'promise']) {
    test(`${operation} guard ${result} is evaluated synchronously and commits nothing`, async () => {
      const f = fixture(); const before = f.pair(); let calls = 0;
      const failure = Object.assign(new Error('synthetic guard rejected'), { code: 'IAM_DISPOSED' });
      const guard = () => { calls++; if (result === 'throw') throw failure; return result === 'promise' ? Promise.resolve(true) : false; };
      const pending = operation === 'save' ? f.store.save(input, { guard }) : f.store.clear({ guard });
      await assert.rejects(pending, { code: result === 'throw' ? 'IAM_DISPOSED' : 'IAM_GATEWAY_CHANGED' });
      await new Promise(setImmediate);
      assert.equal(calls, 1); assert.equal(f.adapter.commits, 0); unchanged(f, before);
    });
  }
}

test('revoking the exact capability before commit rejects an earlier snapshot', async () => {
  const f = fixture(); let verified = true;
  const options = { ...f.options, verifyGatewayAtomicStore: (...args) => verified && f.options.verifyGatewayAtomicStore(...args) };
  const store = createGatewayCredentialStore(f.credentials, options);
  f.adapter.beforeCommit = () => { verified = false; };
  const before = f.pair();
  await assert.rejects(store.save(input), { code: 'IAM_GATEWAY_ATOMIC_UNVERIFIED' });
  unchanged(f, before); assert.equal(f.adapter.commits, 0);
});

for (const stage of ['snapshot', 'beforeCommit', 'afterCommit', 'badReceipt']) {
  test(`${stage} failure is unknown, never retried or rolled back`, async () => {
    const f = fixture(); const before = f.pair();
    const failure = () => { throw new Error('synthetic private backend detail'); };
    if (stage === 'snapshot') f.adapter.snapshot = failure;
    else if (stage === 'beforeCommit') f.adapter.beforeCommit = failure;
    else if (stage === 'afterCommit') f.adapter.afterCommit = failure;
    else {
      const cas = f.adapter.compareAndSwap.bind(f.adapter);
      f.adapter.compareAndSwap = async (...args) => { await cas(...args); return { ok: true }; };
    }
    await assert.rejects(f.store.save(input), (error) => {
      assert.equal(error.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
      assert.doesNotMatch(error.message, /synthetic private|uag-/); return true;
    });
    assert.equal(f.adapter.attempts, stage === 'snapshot' ? 0 : 1);
    assert.equal(f.adapter.commits, ['afterCommit', 'badReceipt'].includes(stage) ? 1 : 0);
    if (f.adapter.commits === 0) unchanged(f, before);
    else assert.equal(f.pair().value === input.value, true);
    assert.deepEqual(f.legacyWrites, []);
  });
}

test('a valid receipt describes its own commit, not a later writer current state', async () => {
  const f = fixture();
  f.adapter.afterCommit = async () => { f.adapter.afterCommit = null; await f.store.save(replacement); };
  assert.equal((await f.store.save(input)).ok, true);
  assert.equal(f.adapter.commits, 2);
  assert.equal(f.pair().value === replacement.value, true);
});

test('a tombstone with an array generation is invalid and cannot be silently reclaimed', async () => {
  const f = fixture();
  f.credentials.records.set(GATEWAY_RECORD_KEY, { kind: 'grant', payload: {
    version: 2, type: 'heluo-iam-gateway-tombstone', writeOperationId: ['ffffffff-ffff-4fff-bfff-ffffffffffff'],
  } });
  const before = f.pair();
  assert.equal((await f.store.read()).ok, false);
  await assert.rejects(f.store.save(input), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  await assert.rejects(f.store.clear(), { code: 'IAM_GATEWAY_LEGACY_READ_ONLY' });
  unchanged(f, before); assert.equal(f.adapter.commits, 0);
});

test('a throwing receipt getter is unknown even after a real commit', async () => {
  const f = fixture(); const cas = f.adapter.compareAndSwap.bind(f.adapter);
  f.adapter.compareAndSwap = async (...args) => {
    await cas(...args);
    return { get ok() { throw new Error('synthetic private receipt detail'); } };
  };
  await assert.rejects(f.store.save(input), (error) => {
    assert.equal(error.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.doesNotMatch(error.message, /synthetic private/); return true;
  });
  assert.equal(f.adapter.commits, 1);
  assert.equal(f.pair().value === input.value, true);
  assert.deepEqual(f.legacyWrites, []);
});

for (const stage of ['snapshot', 'beforeCommit', 'afterCommit']) {
  for (const operation of ['save', 'clear']) {
    test(`${operation} with undefined rejection at ${stage} is still a safe unknown result`, async () => {
      const f = fixture(); const before = f.pair();
      f.adapter[stage] = async () => { throw undefined; };
      await assert.rejects(operation === 'save' ? f.store.save(input) : f.store.clear(), (error) => {
        assert.equal(error?.code, 'IAM_GATEWAY_WRITE_UNKNOWN'); return true;
      });
      assert.equal(f.adapter.commits, stage === 'afterCommit' ? 1 : 0);
      if (stage !== 'afterCommit') unchanged(f, before);
      assert.deepEqual(f.legacyWrites, []);
    });
  }
}

for (const operation of ['save', 'clear']) {
  test(`${operation} normalizes a non-Error guard rejection before committing`, async () => {
    const f = fixture(); const before = f.pair();
    const guard = () => { throw undefined; };
    await assert.rejects(operation === 'save' ? f.store.save(input, { guard }) : f.store.clear({ guard }),
      (error) => { assert.equal(error?.code, 'IAM_GATEWAY_CHANGED'); return true; });
    assert.equal(f.adapter.commits, 0); unchanged(f, before);
  });
}
