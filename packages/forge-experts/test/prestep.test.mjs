import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreStepGuard } from '../src/prestep.mjs';
import { createSelectionService } from '../src/selection.mjs';
import { apply } from '../src/index.mjs';
import { ExpertsError } from '../src/errors.mjs';

function makeScope(overrides = {}) {
  return Object.freeze({
    instanceId: 'inst-1',
    orgId: 'org-1',
    issuer: 'https://iam.corp.example',
    subject: 'emp-alice',
    scopeEpoch: 1,
    ...overrides,
  });
}

function makeHarness({ dispatchEnabled = true, initialScope = makeScope() } = {}) {
  let activeScope = initialScope;
  let clock = 1_700_000_000_000;
  let mentionVersion = 1;

  const selection = createSelectionService({
    isDispatchEnabled: () => dispatchEnabled,
    resolveScope: async () => activeScope,
    assertScopeCurrent: (epoch, expected) => {
      if (epoch !== activeScope.scopeEpoch || expected.subject !== activeScope.subject) {
        throw new ExpertsError('EXPERT_SCOPE_MISMATCH', 'Scope changed');
      }
    },
    resolveSessionScope: async (sessionId) => ({ delegationScope: `dsh:session:${sessionId}` }),
    getMentionVersion: () => mentionVersion,
    now: () => clock,
    selectionTtlMs: 60_000,
  });

  const prestep = createPreStepGuard({
    isDispatchEnabled: () => dispatchEnabled,
    resolveScope: async () => activeScope,
    inspectSelection: (params) => selection.inspect(params),
    discardSelection: (token) => selection.discard(token),
  });

  return {
    selection,
    prestep,
    setScope(next) { activeScope = next; },
    advanceTime(ms) { clock += ms; },
    bumpMentionVersion() { mentionVersion += 1; },
    getScope: () => activeScope,
  };
}

test('plain text and pasted @-mention strings without a selectionToken pass through unbound with zero delegation', async () => {
  const { prestep } = makeHarness();

  const plain = await prestep.prepareTurn({
    sessionId: 'sess-1',
    taskText: 'Hello @经营分析专家 please summarize Q4',
  });
  assert.equal(plain.allowed, true);
  assert.equal(plain.expertBound, false);
  assert.equal(plain.turnId, null);
  assert.equal(plain.preserveDraft, false);

  // Any hallucinated delegate tool call during an unbound turn fails closed.
  assert.throws(
    () => prestep.beforeToolCall({ turnId: null, toolName: 'forge_experts.delegate', toolInput: { selectionToken: 'forged' } }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_SELECTION_INVALID',
  );
});

test('forged, mutated-draft, expired, or cross-identity selectionTokens fail closed and preserve user draft', async () => {
  const h = makeHarness();
  const prepared = await h.selection.prepare({
    expertId: 'exp-fin-1',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 1,
    taskText: 'Review Q4 budget',
    draftVersion: 3,
    reuseRefs: ['ref-a'],
  });

  // 1. Forged token
  const forged = await h.prestep.prepareTurn({
    sessionId: 'sess-1',
    selectionToken: 'forged-token-xyz',
    taskText: 'Review Q4 budget',
    draftVersion: 3,
    reuseRefs: ['ref-a'],
  });
  assert.equal(forged.allowed, false);
  assert.equal(forged.code, 'EXPERT_SELECTION_INVALID');
  assert.equal(forged.preserveDraft, true);
  assert.equal(forged.draft.taskText, 'Review Q4 budget');

  // 2. Draft text mutated after selection (before submit) -> invalidates token & preserves updated draft
  const mutated = await h.prestep.prepareTurn({
    sessionId: 'sess-1',
    selectionToken: prepared.selectionToken,
    taskText: 'Review Q4 budget and wire funds',
    draftVersion: 3,
    reuseRefs: ['ref-a'],
  });
  assert.equal(mutated.allowed, false);
  assert.equal(mutated.code, 'EXPERT_SELECTION_INVALID');
  assert.equal(mutated.preserveDraft, true);
  assert.equal(mutated.draft.taskText, 'Review Q4 budget and wire funds');
  assert.equal(h.selection.pendingCount(), 0, 'failed inspection must invalidate the stale token');

  // 3. Identity switch between selection and submit -> EXPERT_SCOPE_MISMATCH + draft preserved
  const prepared2 = await h.selection.prepare({
    expertId: 'exp-fin-1',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 1,
    taskText: 'Audit vendor list',
    draftVersion: 1,
  });
  h.setScope(makeScope({ subject: 'emp-bob', scopeEpoch: 2 }));
  const switched = await h.prestep.prepareTurn({
    sessionId: 'sess-1',
    selectionToken: prepared2.selectionToken,
    taskText: 'Audit vendor list',
    draftVersion: 1,
  });
  assert.equal(switched.allowed, false);
  assert.equal(switched.code, 'EXPERT_SCOPE_MISMATCH');
  assert.equal(switched.preserveDraft, true);
  assert.equal(switched.draft.taskText, 'Audit vendor list');
});

test('beforeToolCall blocks mis-targeted expert or swapped token, and finalizeTurn preserves draft & discards token when model does not delegate (#245/#247)', async () => {
  const h = makeHarness();
  const prepared = await h.selection.prepare({
    expertId: 'exp-fin-1',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 1,
    taskText: 'Check margin variance',
    draftVersion: 2,
  });

  const turn = await h.prestep.prepareTurn({
    sessionId: 'sess-1',
    selectionToken: prepared.selectionToken,
    taskText: 'Check margin variance',
    draftVersion: 2,
  });
  assert.equal(turn.allowed, true);
  assert.equal(turn.expertBound, true);
  assert.equal(turn.expertId, 'exp-fin-1');

  // Model tries to route to a different expert -> blocked!
  assert.throws(
    () => h.prestep.beforeToolCall({
      turnId: turn.turnId,
      toolName: 'forge_experts.delegate',
      toolInput: { selectionToken: prepared.selectionToken, expertId: 'exp-other-2', sessionId: 'sess-1' },
    }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_SELECTION_INVALID',
  );

  // Model tries to swap selectionToken -> blocked!
  assert.throws(
    () => h.prestep.beforeToolCall({
      turnId: turn.turnId,
      toolName: 'forge_experts.delegate',
      toolInput: { selectionToken: 'different-token', expertId: 'exp-fin-1', sessionId: 'sess-1' },
    }),
    (err) => err instanceof ExpertsError && err.code === 'EXPERT_SELECTION_INVALID',
  );

  // Model never invokes delegate -> finalizeTurn preserves draft, sets expertParticipated: false, and discards token so replay fails.
  const outcome = h.prestep.finalizeTurn({ turnId: turn.turnId });
  assert.equal(outcome.status, 'model_did_not_delegate');
  assert.equal(outcome.expertParticipated, false);
  assert.equal(outcome.completed, false);
  assert.equal(outcome.preserveDraft, true);
  assert.equal(outcome.draft.taskText, 'Check margin variance');
  assert.ok(outcome.notice.length > 0);
  assert.equal(h.selection.pendingCount(), 0, 'unused token must be discarded to block replay');

  // Replaying the discarded token fails closed.
  const replay = await h.prestep.prepareTurn({
    sessionId: 'sess-1',
    selectionToken: prepared.selectionToken,
    taskText: 'Check margin variance',
    draftVersion: 2,
  });
  assert.equal(replay.allowed, false);
  assert.equal(replay.code, 'EXPERT_SELECTION_INVALID');
});

test('happy path: bound turn allows matching delegate call, consumes single-use token, and finalizes as delegated (completed: false)', async () => {
  const h = makeHarness();
  const prepared = await h.selection.prepare({
    expertId: 'exp-fin-1',
    sessionId: 'sess-1',
    scopeEpoch: 1,
    viewVersion: 1,
    taskText: 'Generate variance table',
    draftVersion: 5,
  });

  const turn = await h.prestep.prepareTurn({
    sessionId: 'sess-1',
    selectionToken: prepared.selectionToken,
    taskText: 'Generate variance table',
    draftVersion: 5,
  });
  assert.equal(turn.allowed, true);

  const guardVerdict = h.prestep.beforeToolCall({
    turnId: turn.turnId,
    toolName: 'forge_experts.delegate',
    toolInput: { selectionToken: prepared.selectionToken, expertId: 'exp-fin-1', sessionId: 'sess-1' },
  });
  assert.equal(guardVerdict.allowed, true);
  assert.equal(guardVerdict.expertId, 'exp-fin-1');

  // Downstream dispatch consumes the token once.
  const consumed = h.selection.consume({
    selectionToken: prepared.selectionToken,
    scope: h.getScope(),
    scopeEpoch: 1,
    sessionId: 'sess-1',
    taskText: 'Generate variance table',
    draftVersion: 5,
  });
  assert.equal(consumed.expertId, 'exp-fin-1');
  assert.equal(h.selection.pendingCount(), 0);

  const finalized = h.prestep.finalizeTurn({ turnId: turn.turnId, delegatedTaskId: 'task-900' });
  assert.equal(finalized.status, 'delegated');
  assert.equal(finalized.expertParticipated, true);
  assert.equal(finalized.completed, false);
  assert.equal(finalized.preserveDraft, false);
});

test('apply() registers prestep guard with agentHooks when dispatchEnabled is true and rolls back / disposes cleanly', async () => {
  let registeredGuard = null;
  let effectCleanup = null;
  let routeDisposed = false;
  let toolsDisposed = 0;

  const ctx = {
    get(serviceName) {
      if (serviceName === 'webServer') return { register: () => () => { routeDisposed = true; } };
      if (serviceName === 'tools') return { register: () => () => { toolsDisposed += 1; } };
      if (serviceName === 'agentHooks') {
        return {
          registerPreStep(guard) {
            registeredGuard = guard;
            return () => { registeredGuard = null; };
          },
        };
      }
      if (serviceName === 'storageDomain') {
        return {
          async open() {
            const m = new Map();
            return { table: () => ({ get: (k) => m.get(k), put: (k, v) => m.set(k, v) }), close: async () => {} };
          },
        };
      }
      return undefined;
    },
    provide() {},
    effect(fn) { effectCleanup = fn(); },
    logger: { warn() {} },
  };

  await apply(ctx, { managementEnabled: true, dispatchEnabled: true });
  assert.ok(registeredGuard && typeof registeredGuard.prepareTurn === 'function');
  await effectCleanup();
  assert.equal(registeredGuard, null);
  assert.equal(routeDisposed, true);
  assert.equal(toolsDisposed, 6);
});

test('active turns are never evicted by capacity; expired turns are pruned by TTL and capacity overflow returns EXPERT_RATE_LIMITED with draft preserved', async () => {
  let clock = 1_700_000_000_000;
  const activeScope = makeScope();
  const selection = createSelectionService({
    isDispatchEnabled: () => true,
    resolveScope: async () => activeScope,
    assertScopeCurrent: () => {},
    resolveSessionScope: async (sessionId) => ({ delegationScope: `dsh:session:${sessionId}` }),
    getMentionVersion: () => 1,
    now: () => clock,
    selectionTtlMs: 300_000,
  });

  const finalizedEvents = [];
  const prestep = createPreStepGuard({
    isDispatchEnabled: () => true,
    resolveScope: async () => activeScope,
    inspectSelection: (params) => selection.inspect(params),
    discardSelection: (token) => selection.discard(token),
    onTurnFinalized: (evt) => finalizedEvents.push(evt),
    now: () => clock,
    turnTtlMs: 10_000,
    maxActiveTurns: 1,
  });

  const p1 = await selection.prepare({ expertId: 'exp-1', sessionId: 'sess-1', scopeEpoch: 1, viewVersion: 1, taskText: 'First active task', draftVersion: 1 });
  const t1 = await prestep.prepareTurn({ sessionId: 'sess-1', selectionToken: p1.selectionToken, taskText: 'First active task', draftVersion: 1 });
  assert.equal(t1.allowed, true);

  // Second concurrent turn hits maxActiveTurns=1 -> rejected fail-closed with EXPERT_RATE_LIMITED,
  // while t1 remains intact and usable!
  const p2 = await selection.prepare({ expertId: 'exp-1', sessionId: 'sess-2', scopeEpoch: 1, viewVersion: 1, taskText: 'Second task', draftVersion: 1 });
  const t2 = await prestep.prepareTurn({ sessionId: 'sess-2', selectionToken: p2.selectionToken, taskText: 'Second task', draftVersion: 1 });
  assert.equal(t2.allowed, false);
  assert.equal(t2.code, 'EXPERT_RATE_LIMITED');
  assert.equal(t2.preserveDraft, true);
  assert.equal(t2.draft.taskText, 'Second task');

  // First turn is still active and passes beforeToolCall.
  assert.equal(
    prestep.beforeToolCall({ turnId: t1.turnId, toolName: 'forge_experts.delegate', toolInput: { selectionToken: p1.selectionToken, expertId: 'exp-1', sessionId: 'sess-1' } }).allowed,
    true,
  );

  // Finalizing without delegatedTaskId fires onTurnFinalized with non-sensitive metadata (no raw taskText).
  const f1 = prestep.finalizeTurn({ turnId: t1.turnId });
  assert.equal(f1.status, 'model_did_not_delegate');
  assert.equal(finalizedEvents.length, 1);
  assert.equal(finalizedEvents[0].sessionId, 'sess-1');
  assert.equal(finalizedEvents[0].preserveDraft, true);
  assert.equal(Object.hasOwn(finalizedEvents[0], 'draft'), false, 'SSE metadata must not broadcast raw draft text');

  // After TTL expires, an unfinalized turn is automatically pruned and frees capacity.
  const t3 = await prestep.prepareTurn({ sessionId: 'sess-2', selectionToken: p2.selectionToken, taskText: 'Second task', draftVersion: 1 });
  assert.equal(t3.allowed, true);
  clock += 15_000;
  assert.equal(prestep.activeTurnCount(), 0);
  assert.equal(selection.pendingCount(), 0, 'expired turn pruning must also discard its unused token');
});

test('apply() logs warn when dispatchEnabled is true and agentHooks.registerPreStep is unavailable', async () => {
  const warnings = [];
  const ctx = {
    get(serviceName) {
      if (serviceName === 'webServer') return { register: () => () => {} };
      if (serviceName === 'tools') return { register: () => () => {} };
      return undefined;
    },
    provide() {},
    effect() {},
    logger: { warn(msg) { warnings.push(msg); } },
  };
  await apply(ctx, { managementEnabled: true, dispatchEnabled: true });
  assert.ok(warnings.some((m) => m.includes('agentHooks.registerPreStep unavailable')));
});
