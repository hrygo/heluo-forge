import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferencesStore, derivePreferenceKey } from '../src/preferences.mjs';

function createMemoryStorageDomain({ failWrite = null, initial = {} } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async open() {
      return {
        async get(_table, key) { return data.get(key) ?? null; },
        async set(_table, key, value) {
          if (failWrite) throw failWrite;
          data.set(key, value);
        },
        async close() {},
      };
    },
  };
}

const SCOPE = {
  instanceId: 'inst-1',
  orgId: 'org-a',
  issuer: 'https://iam.example',
  subject: 'emp-1',
};

test('preferences default disabled, enforce editToken revision concurrency, and reset on revocation & re-grant', async () => {
  const storage = createMemoryStorageDomain();
  let digest = 'digest-v1';
  let callable = true;
  let nowMs = 1_700_000_000_000;

  const store = createPreferencesStore({
    openStorageDomain: (spec) => storage.open(spec),
    getScopeSnapshot: () => ({ scopeEpoch: 1, scope: SCOPE }),
    assertScopeCurrent: () => {},
    verifyOrgCallable: async () => ({ callableInOrg: callable, authContinuityDigest: callable ? digest : null }),
    now: () => nowMs,
    editTokenTtlMs: 60_000,
  });
  await store.open();

  // Default state is disabled with revision 0.
  const initial = await store.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', authContinuityDigest: digest });
  assert.equal(initial.enabled, false);
  assert.equal(initial.revision, 0);
  assert.ok(initial.editToken);

  // Two windows read the same revision; second window's stale token must fail with conflict.
  const win2 = await store.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', authContinuityDigest: digest });
  const saved = await store.setEnabled({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', enabled: true, editToken: initial.editToken });
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.enabled, true);
  assert.equal(saved.revision, 1);

  await assert.rejects(
    () => store.setEnabled({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', enabled: true, editToken: win2.editToken }),
    (err) => err.code === 'EXPERT_REVISION_CONFLICT',
  );

  // Settlement readback with the original editToken confirms saved.
  const settled = await store.getEditSettlement({
    scope: SCOPE,
    scopeEpoch: 1,
    expertId: 'exp-1',
    editToken: initial.editToken,
    authContinuityDigest: digest,
  });
  assert.equal(settled.settlement, 'saved');
  assert.equal(settled.enabled, true);

  // Revocation resets persisted preference; re-grant with new continuity digest starts disabled.
  callable = false;
  await store.reconcileRevocation({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', callableInOrg: false, authContinuityDigest: null });
  callable = true;
  digest = 'digest-v2';
  const afterRegrant = await store.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', authContinuityDigest: digest });
  assert.equal(afterRegrant.enabled, false);

  // Expired editToken cannot enqueue a write.
  nowMs += 120_000;
  await assert.rejects(
    () => store.setEnabled({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', enabled: true, editToken: afterRegrant.editToken }),
    (err) => err.code === 'EXPERT_EDIT_TOKEN_EXPIRED',
  );
  await store.close();
});

test('unknown write outcome degrades store fail-closed and preserves unknown schema bytes untouched', async () => {
  const unknownError = Object.assign(new Error('disk fsync uncertain'), { outcome: 'unknown' });
  const storage1 = createMemoryStorageDomain({ failWrite: unknownError });
  const store1 = createPreferencesStore({
    openStorageDomain: (spec) => storage1.open(spec),
    getScopeSnapshot: () => ({ scopeEpoch: 1, scope: SCOPE }),
    assertScopeCurrent: () => {},
    verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'dig-1' }),
  });
  await store1.open();
  const initial = await store1.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', authContinuityDigest: 'dig-1' });
  await assert.rejects(
    () => store1.setEnabled({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', enabled: true, editToken: initial.editToken }),
    (err) => err.code === 'EXPERT_PREF_SAVE_UNKNOWN',
  );
  assert.equal(store1.isDegraded(), true);
  await store1.close();

  // Unknown future schemaVersion in storage must fail closed without mutating stored bytes.
  const key = derivePreferenceKey({ ...SCOPE, expertId: 'exp-future' });
  const futureRecord = { schemaVersion: 99, enabled: true, futureFlag: 'keep-me' };
  const storage2 = createMemoryStorageDomain({ initial: { [key]: futureRecord } });
  const store2 = createPreferencesStore({
    openStorageDomain: (spec) => storage2.open(spec),
    getScopeSnapshot: () => ({ scopeEpoch: 1, scope: SCOPE }),
    assertScopeCurrent: () => {},
    verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'dig-1' }),
  });
  await store2.open();
  await assert.rejects(
    () => store2.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-future', authContinuityDigest: 'dig-1' }),
    (err) => err.code === 'EXPERT_STORAGE_UNAVAILABLE',
  );
  assert.equal(store2.isDegraded(), true);
  assert.deepEqual(storage2.data.get(key), futureRecord);
  await store2.close();
});
