import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeychainProvider, createMemoryBackend } from '@heluo/forge-credentials-keychain';
import { createExtTokenStore, extTokenRecordKey, ExtTokenStoreError } from '../src/ext-token-store.mjs';
import { GATEWAY_RECORD_KEY, GRANT_KEY } from '../src/store.mjs';

test('extTokenRecordKey stays isolated from session and gateway records', () => {
  const key = extTokenRecordKey('alpha-tool');
  assert.equal(key, 'heluo-iam/ext-token-alpha-tool');
  assert.notEqual(key, GRANT_KEY);
  assert.notEqual(key, GATEWAY_RECORD_KEY);
});

test('ext-token-store isolates per extension, binds ownerSubject via AEAD AAD, and fails closed on mismatch', async () => {
  const backend = createMemoryBackend();
  const credentials = createKeychainProvider(backend);
  await credentials.modifyRecord(GRANT_KEY, () => ({ kind: 'grant', payload: { sessionMarker: true } }));

  const store = createExtTokenStore(credentials, { now: () => '2026-11-13T00:00:00.000Z' });
  const saved = await store.save({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    ownerSubject: 'emp-001',
    token: 'secret-alpha-123',
  });
  assert.equal(saved.state, 'HOSTED_ACTIVE');

  // Same account resolves decrypted secret cleanly.
  const ownRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-001',
  });
  assert.equal(ownRead.state, 'HOSTED_ACTIVE');
  assert.equal(ownRead.token, 'secret-alpha-123');

  // Other extension remains unset and IAM session record untouched.
  const betaRead = await store.read({
    extensionId: 'beta-tool',
    storageRef: 'HEL_EXT_BETA_TOKEN',
    currentSubject: 'emp-001',
  });
  assert.equal(betaRead.state, 'UNSET_NO_HOSTED');
  assert.deepEqual(await credentials.readRecord(GRANT_KEY), { kind: 'grant', payload: { sessionMarker: true } });

  // Account switch triggers OWNER_MISMATCH and never reveals the secret.
  const otherRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-002',
  });
  assert.equal(otherRead.state, 'OWNER_MISMATCH');
  assert.equal(otherRead.ownerMismatch, true);
  assert.equal('token' in otherRead, false);

  // Sign-out keeps the record but has no subject to compare: a distinct state,
  // so the account page does not claim another employee left credentials behind.
  const signedOutRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: null,
  });
  assert.equal(signedOutRead.state, 'IAM_NOT_SIGNED_IN');
  assert.equal(signedOutRead.ownerMismatch, false);
  assert.equal('token' in signedOutRead, false);

  // Tampering metadata ownerSubject to emp-002 fails AEAD AAD unseal cleanly (fail-closed).
  await credentials.modifyRecord('heluo-iam/ext-token-alpha-tool', (rec) => ({
    ...rec,
    payload: { ...rec.payload, ownerSubject: 'emp-002' },
  }));
  const tamperedRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-002',
  });
  assert.equal(tamperedRead.state, 'KEYCHAIN_UNAVAILABLE');
  assert.equal('token' in tamperedRead, false);

  // Clear works even after mismatch/tampering and leaves IAM session intact.
  const cleared = await store.clear({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
  });
  assert.equal(cleared.state, 'UNSET_NO_HOSTED');
  assert.deepEqual(await credentials.readRecord(GRANT_KEY), { kind: 'grant', payload: { sessionMarker: true } });
});

test('ext-token-store serializes concurrent writes and reports PENDING_WRITE while in flight', async () => {
  const base = createKeychainProvider(createMemoryBackend());
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let setCalls = 0;
  const credentials = {
    ...base,
    async set(ref, value) {
      setCalls += 1;
      if (setCalls === 1) await firstGate;
      return base.set(ref, value);
    },
  };

  const store = createExtTokenStore(credentials);
  const p1 = store.save({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    ownerSubject: 'emp-001',
    token: 'first-token',
  });
  const p2 = store.save({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    ownerSubject: 'emp-001',
    token: 'second-token',
  });

  await Promise.resolve();
  assert.equal(store.isPending('alpha-tool'), true);
  const pendingRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-001',
  });
  assert.equal(pendingRead.state, 'PENDING_WRITE');

  releaseFirst();
  await Promise.all([p1, p2]);
  assert.equal(store.isPending('alpha-tool'), false);

  const finalRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-001',
  });
  assert.equal(finalRead.state, 'HOSTED_ACTIVE');
  assert.equal(finalRead.token, 'second-token');
});


test('ext-token-store: a failed write rejects without a leaked rejection and restores the previous ciphertext', async () => {
  const backend = createMemoryBackend();
  const base = createKeychainProvider(backend);
  const store = createExtTokenStore(base);
  await store.save({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    ownerSubject: 'emp-001',
    token: 'first-token',
  });
  const before = (await base.resolve('HEL_EXT_ALPHA_TOKEN')).value;

  const failing = {
    ...base,
    async modifyRecord() {
      throw Object.assign(new Error('storage down'), { code: 'KEYCHAIN_UNAVAILABLE' });
    },
  };
  const brokenStore = createExtTokenStore(failing);
  await assert.rejects(
    () => brokenStore.save({
      extensionId: 'alpha-tool',
      storageRef: 'HEL_EXT_ALPHA_TOKEN',
      ownerSubject: 'emp-001',
      token: 'second-token',
    }),
    (err) => err instanceof ExtTokenStoreError && err.code === 'KEYCHAIN_UNAVAILABLE',
  );

  // Let the queue's settlement callback run. A leaked rejection from the queue
  // tail would fail this test process instead of staying silent.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal((await base.resolve('HEL_EXT_ALPHA_TOKEN')).value, before);
  const read = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-001',
  });
  assert.equal(read.state, 'HOSTED_ACTIVE');
  assert.equal(read.token, 'first-token');
});

test('ext-token-store: a failed first write leaves no ciphertext behind', async () => {
  const backend = createMemoryBackend();
  const base = createKeychainProvider(backend);
  const failing = {
    ...base,
    async modifyRecord() {
      throw Object.assign(new Error('storage down'), { code: 'KEYCHAIN_UNAVAILABLE' });
    },
  };
  const store = createExtTokenStore(failing);
  await assert.rejects(
    () => store.save({
      extensionId: 'alpha-tool',
      storageRef: 'HEL_EXT_ALPHA_TOKEN',
      ownerSubject: 'emp-001',
      token: 'first-token',
    }),
    (err) => err instanceof ExtTokenStoreError && err.code === 'KEYCHAIN_UNAVAILABLE',
  );
  // First save has no previous ciphertext to restore, so the rollback must unset
  // the ref; a leftover sealed value would be unreachable but permanent.
  assert.equal(await base.resolve('HEL_EXT_ALPHA_TOKEN'), undefined);
});

test('ext-token-store: clear reports success once the record is gone, even if the ciphertext cannot be unset', async () => {
  const backend = createMemoryBackend();
  const base = createKeychainProvider(backend);
  const store = createExtTokenStore(base);
  await store.save({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    ownerSubject: 'emp-001',
    token: 'first-token',
  });

  const unsetFails = {
    ...base,
    async unset() {
      throw Object.assign(new Error('storage down'), { code: 'KEYCHAIN_UNAVAILABLE' });
    },
  };
  const brokenStore = createExtTokenStore(unsetFails);
  const cleared = await brokenStore.clear({ extensionId: 'alpha-tool', storageRef: 'HEL_EXT_ALPHA_TOKEN' });
  assert.equal(cleared.state, 'UNSET_NO_HOSTED');

  // read() is metadata-driven: the leftover ciphertext is unreachable, so the
  // state must not claim a token is still hosted.
  const read = await brokenStore.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-001',
  });
  assert.equal(read.state, 'UNSET_NO_HOSTED');
});

/**
 * 可换绑 provider：`pin()` 返回绑定到某一代 provider 的视图，`isCurrent()` 反映
 * 装配层是否已把它换掉。保存/清除必须整段落在一个 provider 上。
 */
function pinnableProvider(provider, state) {
  const call = (method) => (...args) => state.current[method](...args);
  return {
    readRecord: call('readRecord'),
    modifyRecord: call('modifyRecord'),
    deleteRecord: call('deleteRecord'),
    set: call('set'),
    unset: call('unset'),
    resolve: call('resolve'),
    pin() {
      const port = state.current;
      return {
        readRecord: (key) => port.readRecord(key),
        modifyRecord: (key, mutate) => port.modifyRecord(key, mutate),
        deleteRecord: (key) => port.deleteRecord(key),
        set: (ref, value) => port.set(ref, value),
        unset: (ref) => port.unset(ref),
        resolve: (ref) => port.resolve(ref),
        isCurrent: () => state.current === port,
      };
    },
  };
}

test('ext-token-store refuses a save whose provider is replaced mid-write', async () => {
  const first = createKeychainProvider(createMemoryBackend());
  const second = createKeychainProvider(createMemoryBackend());
  const state = { current: first };
  // 在第一次写入之后换绑：模拟「set 与 modifyRecord 之间 provider 被替换」。
  const swapping = pinnableProvider(first, state);
  const originalSet = swapping.pin;
  swapping.pin = () => {
    const port = originalSet();
    return {
      ...port,
      async set(ref, value) {
        await port.set(ref, value);
        state.current = second;
      },
    };
  };

  const store = createExtTokenStore(swapping);
  await assert.rejects(
    store.save({ extensionId: 'alpha-tool', storageRef: 'HEL_EXT_ALPHA_TOKEN', ownerSubject: 'emp-001', token: 'secret-alpha-456' }),
    (error) => error instanceof ExtTokenStoreError && error.code === 'KEYCHAIN_UNAVAILABLE',
  );
  // 两次写入都落在被 pin 的旧 provider 上：没有半条记录跑到新 provider。
  const oldRead = await first.readRecord(extTokenRecordKey('alpha-tool'));
  assert.equal(oldRead?.kind, 'grant');
  assert.equal(await second.readRecord(extTokenRecordKey('alpha-tool')), undefined);
});

test('ext-token-store reports an unavailable storage when the provider changes during a read', async () => {
  const first = createKeychainProvider(createMemoryBackend());
  const second = createKeychainProvider(createMemoryBackend());
  const state = { current: first };
  await first.set('HEL_EXT_ALPHA_TOKEN', 'sealed-placeholder');
  await first.modifyRecord(extTokenRecordKey('alpha-tool'), () => ({
    kind: 'grant',
    payload: {
      version: 1,
      type: 'heluo-iam-ext-token',
      extensionId: 'alpha-tool',
      storageRef: 'HEL_EXT_ALPHA_TOKEN',
      ownerSubject: 'emp-001',
      valueDigest: 'not-matching-any-digest',
      updatedAt: '2026-11-13T00:00:00.000Z',
    },
  }));
  const swapping = pinnableProvider(first, state);
  const originalPin = swapping.pin;
  swapping.pin = () => {
    const port = originalPin();
    return {
      ...port,
      async readRecord(key) {
        const value = await port.readRecord(key);
        state.current = second;
        return value;
      },
    };
  };
  const store = createExtTokenStore(swapping);
  const read = await store.read({ extensionId: 'alpha-tool', storageRef: 'HEL_EXT_ALPHA_TOKEN', currentSubject: 'emp-001' });
  assert.equal(read.state, 'KEYCHAIN_UNAVAILABLE');
  assert.equal(read.token, undefined);
});
