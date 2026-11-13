import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeychainProvider, createMemoryBackend } from '@heluo/forge-credentials-keychain';
import { createExtTokenStore, extTokenRecordKey } from '../src/ext-token-store.mjs';
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

  // Account switch or sign-out triggers OWNER_MISMATCH and never reveals secret.
  const otherRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: 'emp-002',
  });
  assert.equal(otherRead.state, 'OWNER_MISMATCH');
  assert.equal(otherRead.ownerMismatch, true);
  assert.equal('token' in otherRead, false);

  const signedOutRead = await store.read({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    currentSubject: null,
  });
  assert.equal(signedOutRead.state, 'OWNER_MISMATCH');
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

