import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectionService } from '../src/selection.mjs';

function makeScope(overrides = {}) {
  return Object.freeze({
    instanceId: 'delegra-prod-01',
    orgId: 'org-alpha',
    issuer: 'https://iam.corp.example',
    subject: 'emp-1001',
    scopeEpoch: 1,
    ...overrides,
  });
}

test('selection fails closed when dispatch is disabled and enforces single-use draft binding', async () => {
  let dispatchEnabled = false;
  let nowMs = 1_700_000_000_000;
  let scope = makeScope();
  let mentionVersion = 3;

  const selection = createSelectionService({
    isDispatchEnabled: () => dispatchEnabled,
    resolveScope: async () => scope,
    assertScopeCurrent: (epoch) => {
      if (epoch !== scope.scopeEpoch) {
        const err = new Error('scope changed');
        err.code = 'EXPERT_SCOPE_MISMATCH';
        throw err;
      }
    },
    resolveSessionScope: async (sessionId) => (
      sessionId === 'sess-1' ? { delegationScope: 'proj-alpha' } : null
    ),
    getMentionVersion: () => mentionVersion,
    now: () => nowMs,
    selectionTtlMs: 60_000,
  });

  await assert.rejects(
    () => selection.prepare({
      expertId: 'exp-1',
      sessionId: 'sess-1',
      scopeEpoch: 1,
      viewVersion: 3,
      taskText: 'Summarize Q4 revenue',
    }),
    (err) => err.code === 'EXPERT_DISPATCH_DISABLED' && err.status === 404,
  );

  dispatchEnabled = true;

  // Unverified session delegationScope fails closed.
  await assert.rejects(
    () => selection.prepare({
      expertId: 'exp-1',
      sessionId: 'sess-unknown',
      scopeEpoch: 1,
      viewVersion: 3,
      taskText: 'Summarize Q4 revenue',
    }),
    (err) => err.code === 'EXPERT_SCOPE_UNVERIFIED' && err.status === 409,
  );

  // Stale mention version is rejected.
  await assert.rejects(
    () => selection.prepare({
      expertId: 'exp-1',
      sessionId: 'sess-1',
      scopeEpoch: 1,
      viewVersion: 2,
      taskText: 'Summarize Q4 revenue',
    }),
    (err) => err.code === 'EXPERT_SCOPE_MISMATCH' && err.status === 409,
  );

  // Valid prepare + consume succeeds once, then replay fails.
  const prepared = await selection.prepare({
    expertId: 'exp-1',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 3,
    taskText: 'Summarize Q4 revenue',
    draftVersion: 7,
    reuseRefs: ['report:2026-q4'],
  });
  assert.ok(prepared.selectionToken);
  assert.equal(prepared.delegationScope, 'proj-alpha');
  assert.equal(selection.pendingCount(), 1);

  const consumed = selection.consume({
    selectionToken: prepared.selectionToken,
    scope,
    scopeEpoch: 1,
    sessionId: 'sess-1',
    taskText: 'Summarize Q4 revenue',
    draftVersion: 7,
    reuseRefs: ['report:2026-q4'],
  });
  assert.equal(consumed.expertId, 'exp-1');
  assert.equal(consumed.delegationScope, 'proj-alpha');
  assert.equal(selection.pendingCount(), 0);

  // Replay of the same selectionToken fails closed.
  assert.throws(
    () => selection.consume({
      selectionToken: prepared.selectionToken,
      scope,
      scopeEpoch: 1,
      sessionId: 'sess-1',
      taskText: 'Summarize Q4 revenue',
      draftVersion: 7,
      reuseRefs: ['report:2026-q4'],
    }),
    (err) => err.code === 'EXPERT_SELECTION_INVALID' && err.status === 409,
  );

  // Draft text mutation after prepare invalidates the selection.
  const mutated = await selection.prepare({
    expertId: 'exp-1',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 3,
    taskText: 'Original draft',
    draftVersion: 1,
  });
  assert.throws(
    () => selection.consume({
      selectionToken: mutated.selectionToken,
      scope,
      scopeEpoch: 1,
      sessionId: 'sess-1',
      taskText: 'Tampered draft',
      draftVersion: 1,
    }),
    (err) => err.code === 'EXPERT_SELECTION_INVALID',
  );

  // Expiry invalidates the selection.
  const expiring = await selection.prepare({
    expertId: 'exp-1',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 3,
    taskText: 'Will expire',
  });
  nowMs += 60_001;
  assert.throws(
    () => selection.consume({
      selectionToken: expiring.selectionToken,
      scope,
      scopeEpoch: 1,
      sessionId: 'sess-1',
      taskText: 'Will expire',
    }),
    (err) => err.code === 'EXPERT_SELECTION_INVALID',
  );

  // Invalidation by expert or scope drops pending selections cleanly.
  const toDrop = await selection.prepare({
    expertId: 'exp-2',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 3,
    taskText: 'Drop me on disable',
  });
  selection.invalidateExpert(1, 'exp-2');
  assert.equal(selection.pendingCount(), 0);
  assert.throws(
    () => selection.consume({
      selectionToken: toDrop.selectionToken,
      scope,
      scopeEpoch: 1,
      sessionId: 'sess-1',
      taskText: 'Drop me on disable',
    }),
    (err) => err.code === 'EXPERT_SELECTION_INVALID',
  );
});
