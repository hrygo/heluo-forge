import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferencesStore, derivePreferenceKey } from '../src/preferences.mjs';

function createMemoryStorageDomain({ failWrite = null, onPut = null, initial = {} } = {}) {
  const data = new Map(Object.entries(initial));
  const opened = [];
  return {
    data,
    opened,
    async open(spec) {
      opened.push(spec);
      return {
        // DSH Domain: records live behind `table(name)`; KvTable.get is a
        // synchronous in-memory read and KvTable.put is the durable write.
        table(name) {
          opened.push({ table: name });
          return {
            get(key) { return data.get(key); },
            async put(key, value) {
              if (onPut) await onPut(key, value);
              if (failWrite) throw failWrite;
              data.set(key, value);
            },
          };
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
  const spec = storage.opened[0];
  assert.deepEqual(Object.keys(spec.tables), ['preferences', 'scope_index'], 'domain spec must declare the table map, not a name array');
  assert.equal(typeof spec.tables.preferences.valueSchema?.parse, 'function', 'table spec needs a parse()-able valueSchema');
  assert.equal(typeof spec.tables.scope_index.valueSchema?.parse, 'function', 'scope_index table spec needs a parse()-able valueSchema');

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

  // Expired editToken cannot enqueue a write and expired settlement is pruned on subsequent reads.
  nowMs += 120_000;
  await assert.rejects(
    () => store.setEnabled({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', enabled: true, editToken: afterRegrant.editToken }),
    (err) => err.code === 'EXPERT_EDIT_TOKEN_EXPIRED',
  );
  await store.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', authContinuityDigest: digest });
  const expiredSettlement = await store.getEditSettlement({
    scope: SCOPE,
    scopeEpoch: 1,
    expertId: 'exp-1',
    editToken: initial.editToken,
    authContinuityDigest: digest,
  });
  assert.equal(expiredSettlement.settlement, 'not_executed');
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

test('close() rejects new reads/writes while draining and reconcileRevocation degrades safely on write failure', async () => {
  let releasePut;
  const storage = createMemoryStorageDomain({
    onPut: async () => {
      await new Promise((resolve) => { releasePut = resolve; });
    },
  });
  const store = createPreferencesStore({
    openStorageDomain: (spec) => storage.open(spec),
    getScopeSnapshot: () => ({ scopeEpoch: 1, scope: SCOPE }),
    assertScopeCurrent: () => {},
    verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'dig-1' }),
  });
  await store.open();
  const initial = await store.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', authContinuityDigest: 'dig-1' });
  const inflightWrite = store.setEnabled({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', enabled: true, editToken: initial.editToken });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const closing = store.close();
  await assert.rejects(
    () => store.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-1', authContinuityDigest: 'dig-1' }),
    (err) => err.code === 'EXPERT_STORAGE_UNAVAILABLE',
  );
  releasePut();
  await inflightWrite;
  await closing;

  // Revocation write failure degrades cleanly without throwing unhandled rejection.
  const key = derivePreferenceKey({ ...SCOPE, expertId: 'exp-rev' });
  const failStorage = createMemoryStorageDomain({
    failWrite: Object.assign(new Error('disk unknown'), { outcome: 'unknown' }),
    initial: {
      [key]: {
        schemaVersion: 1,
        enabled: true,
        revision: 1,
        authContinuityDigest: 'dig-1',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
    },
  });
  const failStore = createPreferencesStore({
    openStorageDomain: (spec) => failStorage.open(spec),
    getScopeSnapshot: () => ({ scopeEpoch: 1, scope: SCOPE }),
    assertScopeCurrent: () => {},
    verifyOrgCallable: async () => ({ callableInOrg: false, authContinuityDigest: null }),
  });
  await failStore.open();
  const res = await failStore.reconcileRevocation({
    scope: SCOPE,
    scopeEpoch: 1,
    expertId: 'exp-rev',
    callableInOrg: false,
    authContinuityDigest: null,
  });
  assert.equal(res.invalidated, true);
  assert.equal(res.degraded, true);
  assert.equal(failStore.isDegraded(), true);
  await failStore.close();
});

test('listConfirmedEnabled survives invalidateScope and cold-start store reopen via durable scope_index', async () => {
  const storage = createMemoryStorageDomain();
  const store1 = createPreferencesStore({
    openStorageDomain: (spec) => storage.open(spec),
    getScopeSnapshot: () => ({ scopeEpoch: 1, scope: SCOPE }),
    assertScopeCurrent: () => {},
    verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'dig-cold' }),
  });
  await store1.open();
  const init = await store1.get({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-cold', authContinuityDigest: 'dig-cold' });
  await store1.setEnabled({ scope: SCOPE, scopeEpoch: 1, expertId: 'exp-cold', enabled: true, editToken: init.editToken });

  // invalidateScope clears in-memory cache; listConfirmedEnabled must rehydrate from scope_index.
  store1.invalidateScope(2);
  const afterInvalidate = await store1.listConfirmedEnabled({ scope: SCOPE });
  assert.deepEqual(afterInvalidate.map((r) => r.expertId), ['exp-cold']);
  await store1.close();

  // Cold-start reopen on the same storageDomain must also recover enabled experts.
  const store2 = createPreferencesStore({
    openStorageDomain: (spec) => storage.open(spec),
    getScopeSnapshot: () => ({ scopeEpoch: 1, scope: SCOPE }),
    assertScopeCurrent: () => {},
    verifyOrgCallable: async () => ({ callableInOrg: true, authContinuityDigest: 'dig-cold' }),
  });
  await store2.open();
  const afterColdStart = await store2.listConfirmedEnabled({ scope: SCOPE });
  assert.deepEqual(afterColdStart.map((r) => r.expertId), ['exp-cold']);
  await store2.close();
});
