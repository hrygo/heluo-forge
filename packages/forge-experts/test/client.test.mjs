import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function loadClientModule({ eventSources = [], fetchImpl = null, react = null } = {}) {
  let moduleDef = null;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onmessage = null;
      this.onerror = null;
      eventSources.push(this);
    }
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
    fail() {
      this.onerror?.(new Error('sse-drop'));
    }
    close() {
      this.closed = true;
    }
  }

  globalThis.window = {
    __ModuleLoader__: {
      load(def) { moduleDef = def; },
    },
    EventSource: FakeEventSource,
  };
  if (fetchImpl) globalThis.fetch = fetchImpl;

  const runner = new Function(clientSource);
  runner();

  const exported = moduleDef.factory((dep) => {
    if (dep === 'react') {
      return react ?? {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useRef: (init) => ({ current: init }),
        useCallback: (fn) => fn,
        useEffect: () => {},
      };
    }
    throw new Error(`Unexpected client require: ${dep}`);
  });

  const restore = () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  };

  return { moduleDef, exported, restore };
}

test('client single bundle registers settings.section, keeps production @ trigger closed, and disposes cleanly', () => {
  const { moduleDef, exported, restore } = loadClientModule();
  try {
    assert.equal(moduleDef?.id, '@heluo/forge-experts');
    assert.deepEqual(exported.inject, ['slots']);
    const registeredSections = [];
    let disposedCount = 0;
    let triggerCalled = false;
    const disposers = [];
    const ctx = {
      slots: {
        inject(_slotName, fn) {
          fn();
          return () => { disposedCount += 1; };
        },
        register(meta, component) {
          registeredSections.push({ meta, component });
          return () => {};
        },
      },
      inputTriggers: {
        registerSource() {
          triggerCalled = true;
          return () => {};
        },
      },
      effect(register) {
        const disposer = register();
        if (typeof disposer === 'function') disposers.push(disposer);
      },
    };

    exported.apply(ctx);
    assert.equal(registeredSections.length, 2);
    assert.equal(registeredSections[0].meta.name, 'settings.section');
    assert.equal(registeredSections[0].meta.id, 'forge-experts');
    assert.equal(registeredSections[0].meta.label(), '专家智能体');
    assert.equal(registeredSections[1].meta.name, 'chat.taskCard');
    assert.equal(registeredSections[1].meta.id, 'forge-experts-task-card');
    assert.equal(registeredSections[1].meta.label(), '专家任务状态');
    assert.equal(triggerCalled, false, 'production @ trigger must remain closed by default');

    for (const fn of disposers) fn();
    assert.equal(disposedCount, 2, 'all slot registrations must be released through the Cordis effect');
  } finally {
    restore();
  }
});

test('isolated mentions preview registers @ group, validates onPick version, resets version on dropGroup, drops group on SSE invalidation/disconnect without touching native groups, and restores on ready', async () => {
  const eventSources = [];
  let releaseDelayedFetch;
  let callIndex = 0;

  const fetchImpl = async (url) => {
    callIndex += 1;
    if (url.includes('query=slow')) {
      await new Promise((resolve) => { releaseDelayedFetch = resolve; });
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          scopeEpoch: 2,
          viewVersion: callIndex,
          candidates: [
            {
              expertId: 'exp-1',
              displayName: '经营分析专家',
              disambiguation: '财务组',
              responsibility: '报表分析',
              scopeEpoch: 2,
              viewVersion: callIndex,
            },
          ],
        };
      },
    };
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    const activeGroups = new Map([
      ['native-files', { id: 'native-files', trigger: '@' }],
      ['native-sessions', { id: 'native-sessions', trigger: '@' }],
    ]);
    let registerCalls = 0;
    let unregisterCalls = 0;
    const disposeCallbacks = [];

    const ctx = {
      slots: {
        inject(_name, fn) { fn(); return () => {}; },
        register() { return () => {}; },
      },
      inputTriggers: {
        registerSource(spec) {
          registerCalls += 1;
          activeGroups.set(spec.id, spec);
          return () => {
            unregisterCalls += 1;
            activeGroups.delete(spec.id);
          };
        },
      },
      effect(register) {
        const disposer = register();
        if (typeof disposer === 'function') disposeCallbacks.push(disposer);
      },
    };

    exported.apply(ctx, { isolatedMentionsPreview: true });
    assert.equal(registerCalls, 1);
    assert.equal(activeGroups.has('forge-experts-mentions'), true);
    assert.equal(activeGroups.has('native-files'), true);

    // Query returns disambiguated label and onPick enforces version match.
    const source = activeGroups.get('forge-experts-mentions');
    const rows = await source.query('', { sessionId: 'sess-1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, '经营分析专家 · 财务组');
    assert.equal(source.onPick(rows[0]).accepted, true);
    assert.equal(source.onPick({ ...rows[0], viewVersion: 999 }).accepted, false);

    // In-flight query interrupted by SSE disconnect must be discarded, group unregistered, and stale picked item rejected.
    const slowQuery = source.query('slow', { sessionId: 'sess-1' });
    assert.equal(eventSources.length, 1);
    eventSources[0].fail();
    assert.equal(unregisterCalls, 1);
    assert.equal(activeGroups.has('forge-experts-mentions'), false);
    assert.equal(source.onPick(rows[0]).accepted, false, 'stale item must be rejected after dropGroup resets active version');
    assert.equal(activeGroups.has('native-files'), true, 'native file group must remain untouched');
    assert.equal(activeGroups.has('native-sessions'), true, 'native session group must remain untouched');
    releaseDelayedFetch();
    assert.deepEqual(await slowQuery, []);

    // Reconnect ready re-registers the expert group; preference-updated drops and refreshes it.
    eventSources[0].emit({ type: 'ready', scopeEpoch: 2, viewVersion: 3 });
    assert.equal(registerCalls, 2);
    assert.equal(activeGroups.has('forge-experts-mentions'), true);

    eventSources[0].emit({ type: 'preference-updated', scopeEpoch: 2, viewVersion: 4 });
    assert.equal(unregisterCalls, 2);
    assert.equal(registerCalls, 3);

    for (const fn of disposeCallbacks) fn();
    assert.equal(activeGroups.has('forge-experts-mentions'), false);
    assert.equal(eventSources[0].closed, true);
  } finally {
    restore();
  }
});

test('production dispatchEnabled mounts @ source with disambiguated homonymous labels, prepareSubmit binding, and draft preservation on revocation/stale pick (#245/#246)', async () => {
  const eventSources = [];
  const postBodies = [];
  let nextSelectionResponse = {
    ok: true,
    status: 201,
    body: {
      selectionToken: 'sel-prod-1',
      expertId: 'exp-fin-2',
      sessionId: 'sess-1',
      draftDigest: 'sha256:abc',
      expiresAt: '2030-01-01T00:02:00.000Z',
    },
  };

  const fetchImpl = async (url, init) => {
    if (url.includes('/mentions')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scopeEpoch: 5,
            viewVersion: 7,
            candidates: [
              { expertId: 'exp-fin-1', displayName: '经营分析专家', disambiguation: '华东区', responsibility: '区域报表', scopeEpoch: 5, viewVersion: 7 },
              { expertId: 'exp-fin-2', displayName: '经营分析专家', responsibility: '集团汇总', scopeEpoch: 5, viewVersion: 7 },
            ],
          };
        },
      };
    }
    if (url.includes('/selections') && init?.method === 'POST') {
      postBodies.push(JSON.parse(init.body));
      const res = nextSelectionResponse;
      return { ok: res.ok, status: res.status, async json() { return res.body; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    let registeredSpec = null;
    const disposeCallbacks = [];
    const ctx = {
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      inputTriggers: {
        registerSource(spec) {
          registeredSpec = spec;
          return () => { registeredSpec = null; };
        },
      },
      effect(register) {
        const d = register();
        if (typeof d === 'function') disposeCallbacks.push(d);
      },
    };

    exported.apply(ctx, { dispatchEnabled: true });
    assert.ok(registeredSpec && typeof registeredSpec.prepareSubmit === 'function');

    const rows = await registeredSpec.query('', { sessionId: 'sess-1' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].label, '经营分析专家 · 华东区');
    assert.equal(rows[1].label, '经营分析专家 · 集团汇总', 'homonymous experts without disambiguation prefer human-readable responsibility over internal expertId');

    // Valid pick -> prepareSubmit returns selectionToken and buffers draft for SSE recovery
    const recoveredEvents = [];
    registeredSpec.onDraftRecovery((evt) => recoveredEvents.push(evt));
    const ok = await registeredSpec.prepareSubmit({
      picked: rows[1],
      sessionId: 'sess-1',
      taskText: 'Summarize group revenue',
      draftVersion: 4,
      reuseRefs: ['ref-1'],
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.selectionToken, 'sel-prod-1');
    assert.equal(ok.preserveDraft, false);
    assert.equal(postBodies.length, 1);
    assert.equal(postBodies[0].expertId, 'exp-fin-2');
    assert.equal(postBodies[0].draftVersion, 4);

    // SSE turn-finalized with preserveDraft: true restores buffered draft & surfaces notice
    eventSources[0].emit({
      type: 'turn-finalized',
      sessionId: 'sess-1',
      expertId: 'exp-fin-2',
      status: 'model_did_not_delegate',
      preserveDraft: true,
      notice: '主助手未调用所选专家，已保留草稿。',
    });
    assert.equal(recoveredEvents.length, 1);
    assert.equal(recoveredEvents[0].draft.taskText, 'Summarize group revenue');
    assert.equal(recoveredEvents[0].notice, '主助手未调用所选专家，已保留草稿。');

    // Server revocation/conflict -> draft preserved with clear notice
    nextSelectionResponse = {
      ok: false,
      status: 403,
      body: { error: { code: 'EXPERT_CALL_FORBIDDEN', message: 'revoked' } },
    };
    const revoked = await registeredSpec.prepareSubmit({
      picked: rows[1],
      sessionId: 'sess-1',
      taskText: 'Important unsent draft',
      draftVersion: 5,
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.code, 'EXPERT_CALL_FORBIDDEN');
    assert.equal(revoked.preserveDraft, true);
    assert.equal(revoked.draft.taskText, 'Important unsent draft');
    assert.match(revoked.notice, /查看权限/u);

    // Stale pick after SSE invalidation -> rejected locally with draft preserved and zero POST
    eventSources[0].emit({ type: 'scope-changed', scopeEpoch: 6, viewVersion: 8 });
    const stale = await registeredSpec.prepareSubmit({
      picked: rows[1],
      sessionId: 'sess-1',
      taskText: 'Draft after switch',
      draftVersion: 6,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'EXPERT_SELECTION_INVALID');
    assert.equal(stale.preserveDraft, true);
    assert.equal(stale.draft.taskText, 'Draft after switch');
    assert.equal(postBodies.length, 2, 'stale pick must not issue a new POST /selections');

    for (const fn of disposeCallbacks) fn();
    assert.equal(registeredSpec, null);
  } finally {
    restore();
  }
});

test('ExpertTaskStatusCard & deriveTaskCardState distinguish queued/succeeded/waiting_user/cancelled/unknown, collapse rawResult by default, and trigger reconnect reconcile (#247)', async () => {
  const eventSources = [];
  const reconcileCalls = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/tasks/reconcile') && init?.method === 'POST') {
      reconcileCalls.push(url);
      return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
    }
    return { ok: true, status: 200, async json() { return { candidates: [] }; } };
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    // 1. queued != completed
    const queued = exported.deriveTaskCardState({ taskId: 't-1', status: 'queued' });
    assert.equal(queued.completed, false);
    assert.equal(queued.showCancelAction, true);
    assert.match(queued.statusLabel, /尚未完成/u);

    // 2. succeeded: fail-closed sources/artifacts & collapsed raw output by default
    const succeeded = exported.deriveTaskCardState({
      taskId: 't-2',
      status: 'succeeded',
      summary: 'Q4 growth 18%',
      rawResult: 'Full transcript',
      sources: [{ title: 'OK', authorized: true }, { title: 'Hidden' }, { title: 'Denied', authorized: false }],
      artifacts: [{ name: 'out.md', authorized: true }, { name: 'secret.json', authorized: false }],
    });
    assert.equal(succeeded.completed, true);
    assert.equal(succeeded.rawResultCollapsedDefault, true);
    assert.equal(succeeded.authorizedSources.length, 1);
    assert.equal(succeeded.authorizedArtifacts.length, 1);

    const cardTree = exported.ExpertTaskStatusCard({
      task: {
        taskId: 't-2',
        status: 'succeeded',
        summary: 'Q4 growth 18%',
        rawResult: 'Full transcript',
        sources: [{ title: 'OK', authorized: true }],
      },
    });
    const renderedJson = JSON.stringify(cardTree);
    assert.match(renderedJson, /展开专家原文/u);
    assert.doesNotMatch(renderedJson, /Full transcript/u, 'rawResult must remain collapsed by default');

    // 3. waiting_user: read-only notice + explicit followup box
    const waiting = exported.deriveTaskCardState({
      taskId: 't-3',
      status: 'waiting_user',
      waitingUserNotice: { readOnly: true, message: '请确认目标区域' },
    });
    assert.equal(waiting.showFollowupInput, true);
    assert.equal(waiting.waitingUserNotice, '请确认目标区域');

    // 4. cancelled: explicitly states external actions are not reverted
    const cancelled = exported.deriveTaskCardState({ taskId: 't-4', status: 'cancelled' });
    assert.match(cancelled.cancellationNotice, /外部动作不会被自动撤销/u);

    // 5. unknown: shows reconcile button
    const unknown = exported.deriveTaskCardState({ requestId: 'req-9', status: 'unknown' });
    assert.equal(unknown.isUnknown, true);
    assert.equal(unknown.showReconcileAction, true);

    // 6. SSE ready in dispatchEnabled mode triggers POST /tasks/reconcile
    const ctx = {
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      inputTriggers: { registerSource() { return () => {}; } },
      effect() {},
    };
    exported.apply(ctx, { dispatchEnabled: true });
    eventSources[0].emit({ type: 'ready', scopeEpoch: 1, viewVersion: 1 });
    await Promise.resolve();
    assert.equal(reconcileCalls.length, 1);
  } finally {
    restore();
  }
});

test('Stage C4-B async task status & recovery card renders reconcile, refresh, cancel, waiting_user read-only notice, and artifacts (#247)', () => {
  const { exported, restore } = loadClientModule();
  try {
    const registered = [];
    const ctx = {
      slots: {
        inject(_slotName, fn) { fn(); return () => {}; },
        register(meta, component) { registered.push({ meta, component }); return () => {}; },
      },
      effect() {},
    };

    exported.apply(ctx, { dispatchEnabled: true });
    const cardEntry = registered.find((r) => r.meta.id === 'forge-experts-task-card');
    assert.ok(cardEntry, 'chat.taskCard slot must be registered');

    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    const unknownTree = cardEntry.component({
      initialTask: { requestId: 'req-unknown-1', status: 'unknown', expertName: '财务分析专家' },
    });
    assert.equal(unknownTree.props['data-task-status'], 'unknown');
    assert.equal(findNodes(unknownTree, (n) => n.props?.['data-testid'] === 'fexp-task-reconcile').length, 1);
    assert.equal(findNodes(unknownTree, (n) => n.props?.['data-testid'] === 'fexp-task-cancel').length, 0);

    const waitingTree = cardEntry.component({
      initialTask: { taskId: 'task-wait-1', requestId: 'req-2', status: 'waiting_user', runGeneration: 2, expertName: '法务专家' },
    });
    assert.equal(waitingTree.props['data-task-status'], 'waiting_user');
    assert.equal(findNodes(waitingTree, (n) => n.props?.['data-testid'] === 'fexp-task-waiting-notice').length, 1);
    assert.equal(findNodes(waitingTree, (n) => n.props?.['data-testid'] === 'fexp-task-refresh').length, 1);
    assert.equal(findNodes(waitingTree, (n) => n.props?.['data-testid'] === 'fexp-task-cancel').length, 1);

    const doneTree = cardEntry.component({
      initialTask: {
        taskId: 'task-done-1',
        status: 'completed',
        runGeneration: 1,
        result: 'Q4 营收同比增长 18%',
        artifacts: [{ id: 'art-1', label: '经营分析简报.pdf', authorized: true }],
      },
    });
    assert.equal(doneTree.props['data-task-status'], 'completed');
    assert.equal(findNodes(doneTree, (n) => n.props?.['data-testid'] === 'fexp-task-result').length, 1);
    assert.equal(findNodes(doneTree, (n) => n.props?.['data-testid'] === 'fexp-task-artifacts').length, 1);
    assert.equal(findNodes(doneTree, (n) => n.props?.['data-testid'] === 'fexp-task-cancel').length, 0);
  } finally {
    restore();
  }
});

test('buffered pendingDraft survives preference invalidation and reconnect in the same scope (#481/#483)', async () => {
  const eventSources = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/mentions')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scopeEpoch: 5,
            viewVersion: 7,
            candidates: [{ expertId: 'exp-fin-1', displayName: '经营分析专家', scopeEpoch: 5, viewVersion: 7 }],
          };
        },
      };
    }
    if (url.includes('/selections') && init?.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            selectionToken: 'sel-reconnect-1',
            expertId: 'exp-fin-1',
            sessionId: 'sess-reconnect',
            draftDigest: 'sha256:rec',
            expiresAt: '2030-01-01T00:02:00.000Z',
          };
        },
      };
    }
    if (url.includes('/tasks/reconcile')) {
      return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    let registeredSpec = null;
    const disposeCallbacks = [];
    const ctx = {
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      inputTriggers: {
        registerSource(spec) {
          registeredSpec = spec;
          return () => { registeredSpec = null; };
        },
      },
      effect(register) {
        const d = register();
        if (typeof d === 'function') disposeCallbacks.push(d);
      },
    };

    exported.apply(ctx, { dispatchEnabled: true });
    const rows = await registeredSpec.query('', { sessionId: 'sess-reconnect' });
    const recovered = [];
    registeredSpec.onDraftRecovery((evt) => recovered.push(evt));

    const prep = await registeredSpec.prepareSubmit({
      picked: rows[0],
      sessionId: 'sess-reconnect',
      taskText: 'Draft preserved across SSE reconnect',
      draftVersion: 9,
    });
    assert.equal(prep.ok, true);

    eventSources[0].emit({ type: 'preference-updated', scopeEpoch: 5, viewVersion: 8 });
    eventSources[0].emit({ type: 'mentions-invalidated', scopeEpoch: 5, viewVersion: 9 });
    eventSources[0].fail();
    eventSources[0].emit({ type: 'ready', scopeEpoch: 5, viewVersion: 9 });
    eventSources[0].emit({
      type: 'turn-finalized',
      sessionId: 'sess-reconnect',
      expertId: 'exp-fin-1',
      status: 'model_did_not_delegate',
      code: 'EXPERT_RATE_LIMITED',
      preserveDraft: true,
    });

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].draft?.taskText, 'Draft preserved across SSE reconnect');
    assert.match(recovered[0].notice, /请求过多/u);

    for (const fn of disposeCallbacks) fn();
  } finally {
    restore();
  }
});

test('turn-finalized with mismatched draftDigest never restores another window draft in the same session (#484)', async () => {
  const eventSources = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/mentions')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scopeEpoch: 5,
            viewVersion: 7,
            candidates: [{ expertId: 'exp-fin-1', displayName: '经营分析专家', scopeEpoch: 5, viewVersion: 7 }],
          };
        },
      };
    }
    if (url.includes('/selections') && init?.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            selectionToken: 'sel-win-b',
            expertId: 'exp-fin-1',
            sessionId: 'sess-shared',
            draftDigest: 'sha256:digest-B',
            expiresAt: '2030-01-01T00:02:00.000Z',
          };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    let registeredSpec = null;
    const disposeCallbacks = [];
    const ctx = {
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      inputTriggers: {
        registerSource(spec) {
          registeredSpec = spec;
          return () => { registeredSpec = null; };
        },
      },
      effect(register) {
        const d = register();
        if (typeof d === 'function') disposeCallbacks.push(d);
      },
    };

    exported.apply(ctx, { dispatchEnabled: true });
    const rows = await registeredSpec.query('', { sessionId: 'sess-shared' });
    const recovered = [];
    registeredSpec.onDraftRecovery((evt) => recovered.push(evt));

    const prepB = await registeredSpec.prepareSubmit({
      picked: rows[0],
      sessionId: 'sess-shared',
      taskText: 'Window B draft',
      draftVersion: 2,
    });
    assert.equal(prepB.ok, true);

    // Window A's failure arrives with digest-A: must NOT recover Window B's draft.
    eventSources[0].emit({
      type: 'turn-finalized',
      sessionId: 'sess-shared',
      expertId: 'exp-fin-1',
      draftDigest: 'sha256:digest-A',
      status: 'model_did_not_delegate',
      preserveDraft: true,
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].draft, null, 'mismatched draftDigest must not fall back to another window draft');

    // Window B's own failure later arrives with digest-B: Window B's draft is still intact.
    eventSources[0].emit({
      type: 'turn-finalized',
      sessionId: 'sess-shared',
      expertId: 'exp-fin-1',
      draftDigest: 'sha256:digest-B',
      status: 'model_did_not_delegate',
      preserveDraft: true,
    });
    assert.equal(recovered.length, 2);
    assert.equal(recovered[1].draft?.taskText, 'Window B draft');

    for (const fn of disposeCallbacks) fn();
  } finally {
    restore();
  }
});

test('ExpertTaskStatusCard clears previous generation result, rawResult, sources, and artifacts after followup (#484)', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let moduleDef = null;

  globalThis.window = {
    __ModuleLoader__: { load(def) { moduleDef = def; } },
  };
  globalThis.fetch = async (url, init) => {
    if (url.includes('/followups') && init?.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async json() {
          return { taskId: 'task-gen-1', status: 'running', runGeneration: 2 };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    new Function(clientSource)();
    const stateSlots = [];
    const refSlots = [];
    let stateIdx = 0;
    let refIdx = 0;
    const exported = moduleDef.factory((dep) => {
      if (dep === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState(init) {
            const idx = stateIdx++;
            if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
            return [
              stateSlots[idx],
              (next) => {
                stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next;
              },
            ];
          },
          useRef(init) {
            const idx = refIdx++;
            if (!(idx in refSlots)) refSlots[idx] = { current: init };
            return refSlots[idx];
          },
          useCallback: (fn) => fn,
          useEffect: () => {},
        };
      }
      throw new Error(`Unexpected require: ${dep}`);
    });

    const initialTask = {
      taskId: 'task-gen-1',
      requestId: 'req-gen-1',
      status: 'waiting_user',
      runGeneration: 1,
      summary: 'Generation 1 summary',
      result: 'Generation 1 output',
      rawResult: 'Generation 1 raw transcript',
      sources: [{ id: 's1', title: 'Old Source', authorized: true }],
      artifacts: [{ id: 'a1', label: 'old-report.pdf', authorized: true }],
      waitingUserNotice: { readOnly: true, message: 'Need region filter' },
    };

    const renderCard = () => {
      stateIdx = 0;
      refIdx = 0;
      return exported.ExpertTaskStatusCard({ initialTask });
    };
    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    const beforeTree = renderCard();
    assert.equal(findNodes(beforeTree, (n) => n.props?.['data-testid'] === 'fexp-task-result').length, 1);
    assert.equal(findNodes(beforeTree, (n) => n.props?.['data-testid'] === 'fexp-task-artifacts').length, 1);

    const inputNode = findNodes(beforeTree, (n) => n.type === 'input')[0];
    inputNode.props.onChange({ target: { value: 'Focus on East China' } });
    const midTree = renderCard();
    const followupBtn = findNodes(midTree, (n) => n.props?.['data-testid'] === 'fexp-followup-btn')[0];
    await followupBtn.props.onClick();

    const afterTree = renderCard();
    assert.equal(afterTree.props['data-task-status'], 'running');
    assert.equal(findNodes(afterTree, (n) => n.props?.['data-testid'] === 'fexp-task-result').length, 0);
    assert.equal(findNodes(afterTree, (n) => n.props?.['data-testid'] === 'fexp-raw-drawer').length, 0);
    assert.equal(findNodes(afterTree, (n) => n.props?.['data-testid'] === 'fexp-task-sources').length, 0);
    assert.equal(findNodes(afterTree, (n) => n.props?.['data-testid'] === 'fexp-task-artifacts').length, 0);
    assert.equal(findNodes(afterTree, (n) => n.props?.['data-testid'] === 'fexp-task-waiting-notice').length, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('ExpertTaskStatusCard enters unknown reconcile state on followup EXPERT_ACCEPTANCE_UNKNOWN and prevents duplicate submit (#484)', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let moduleDef = null;
  let followupCalls = 0;
  let reconciledRequestId = null;

  globalThis.window = {
    __ModuleLoader__: { load(def) { moduleDef = def; } },
  };
  globalThis.fetch = async (url, init) => {
    if (url.includes('/followups') && init?.method === 'POST') {
      followupCalls += 1;
      return {
        ok: false,
        status: 503,
        async json() {
          return {
            error: {
              code: 'EXPERT_ACCEPTANCE_UNKNOWN',
              message: 'wire dropped',
              details: { requestId: 'req-followup-unknown-9' },
            },
          };
        },
      };
    }
    if (url.includes('/tasks/by-request/req-followup-unknown-9')) {
      reconciledRequestId = 'req-followup-unknown-9';
      return {
        ok: true,
        status: 200,
        async json() {
          return { taskId: 'task-fu-1', status: 'running', runGeneration: 2 };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    new Function(clientSource)();
    const stateSlots = [];
    const refSlots = [];
    let stateIdx = 0;
    let refIdx = 0;
    const exported = moduleDef.factory((dep) => {
      if (dep === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState(init) {
            const idx = stateIdx++;
            if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
            return [
              stateSlots[idx],
              (next) => {
                stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next;
              },
            ];
          },
          useRef(init) {
            const idx = refIdx++;
            if (!(idx in refSlots)) refSlots[idx] = { current: init };
            return refSlots[idx];
          },
          useCallback: (fn) => fn,
          useEffect: () => {},
        };
      }
      throw new Error(`Unexpected require: ${dep}`);
    });

    const initialTask = {
      taskId: 'task-fu-1',
      requestId: 'req-orig-1',
      status: 'waiting_user',
      runGeneration: 1,
    };
    const renderCard = () => {
      stateIdx = 0;
      refIdx = 0;
      return exported.ExpertTaskStatusCard({ initialTask });
    };
    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    const beforeTree = renderCard();
    const inputNode = findNodes(beforeTree, (n) => n.type === 'input')[0];
    inputNode.props.onChange({ target: { value: 'Add Q4 breakdown' } });
    const midTree = renderCard();
    const followupBtn = findNodes(midTree, (n) => n.props?.['data-testid'] === 'fexp-followup-btn')[0];
    await followupBtn.props.onClick();

    const unknownTree = renderCard();
    assert.equal(unknownTree.props['data-task-status'], 'unknown');
    assert.equal(findNodes(unknownTree, (n) => n.props?.['data-testid'] === 'fexp-followup-btn').length, 0, 'followup submit must be blocked while acceptance is unknown');
    const reconcileBtn = findNodes(unknownTree, (n) => n.props?.['data-testid'] === 'fexp-task-reconcile')[0];
    assert.ok(reconcileBtn, 'card must expose reconcile button with new followup requestId');

    await reconcileBtn.props.onClick();
    const reconciledTree = renderCard();
    assert.equal(reconciledRequestId, 'req-followup-unknown-9');
    assert.equal(followupCalls, 1, 'only one remote followup may be created');
    assert.equal(reconciledTree.props['data-task-status'], 'running');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('ExpertTaskStatusCard re-reads authoritative status instead of mixing snapshots when runGeneration changes between /tasks/:id and /result (#484)', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let moduleDef = null;
  let statusCalls = 0;

  globalThis.window = {
    __ModuleLoader__: { load(def) { moduleDef = def; } },
  };
  globalThis.fetch = async (url) => {
    if (url.endsWith('/tasks/task-mix-1')) {
      statusCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return statusCalls === 1
            ? { taskId: 'task-mix-1', status: 'waiting_user', runGeneration: 1 }
            : { taskId: 'task-mix-1', status: 'running', runGeneration: 2 };
        },
      };
    }
    if (url.endsWith('/tasks/task-mix-1/result')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { taskId: 'task-mix-1', runGeneration: 2, result: 'Gen 2 partial output' };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    new Function(clientSource)();
    const stateSlots = [];
    const refSlots = [];
    let stateIdx = 0;
    let refIdx = 0;
    const exported = moduleDef.factory((dep) => {
      if (dep === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState(init) {
            const idx = stateIdx++;
            if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
            return [
              stateSlots[idx],
              (next) => {
                stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next;
              },
            ];
          },
          useRef(init) {
            const idx = refIdx++;
            if (!(idx in refSlots)) refSlots[idx] = { current: init };
            return refSlots[idx];
          },
          useCallback: (fn) => fn,
          useEffect: () => {},
        };
      }
      throw new Error(`Unexpected require: ${dep}`);
    });

    const initialTask = { taskId: 'task-mix-1', status: 'waiting_user', runGeneration: 1, result: 'Gen 1 old output' };
    const renderCard = () => {
      stateIdx = 0;
      refIdx = 0;
      return exported.ExpertTaskStatusCard({ initialTask });
    };
    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    const beforeTree = renderCard();
    const refreshBtn = findNodes(beforeTree, (n) => n.props?.['data-testid'] === 'fexp-task-refresh')[0];
    await refreshBtn.props.onClick();

    const afterTree = renderCard();
    assert.equal(statusCalls, 2, 'must re-read authoritative status when runGeneration drifts');
    assert.equal(afterTree.props['data-task-status'], 'running');
    assert.equal(findNodes(afterTree, (n) => n.props?.['data-testid'] === 'fexp-followup-btn').length, 0);
    assert.equal(findNodes(afterTree, (n) => n.props?.['data-testid'] === 'fexp-task-result').length, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('reconnect reconcile stream stays active when dispatchEnabled is false without mounting @ trigger (#484 §9.2)', async () => {
  const eventSources = [];
  const reconcileCalls = [];
  let triggerRegistered = false;
  const fetchImpl = async (url, init) => {
    if (url.includes('/tasks/reconcile') && init?.method === 'POST') {
      reconcileCalls.push(url);
      return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    const disposers = [];
    const ctx = {
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      inputTriggers: {
        registerSource() {
          triggerRegistered = true;
          return () => {};
        },
      },
      effect(register) {
        const d = register();
        if (typeof d === 'function') disposers.push(d);
      },
    };

    exported.apply(ctx, { dispatchEnabled: false });
    assert.equal(triggerRegistered, false, '@ trigger must remain closed when dispatchEnabled is false');
    assert.equal(eventSources.length, 1);
    eventSources[0].emit({ type: 'ready', scopeEpoch: 1, viewVersion: 1 });
    await Promise.resolve();
    assert.equal(reconcileCalls.length, 1, 'existing tasks must still auto-reconcile on reconnect after dispatchEnabled is turned off');

    for (const fn of disposers) fn();
    assert.equal(eventSources[0].closed, true);
  } finally {
    restore();
  }
});

test('ExpertTaskStatusCard uses independent followup requestId when fetch drops and clears previous generation on SSE task-reconciled (#484)', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let moduleDef = null;
  const eventSources = [];
  const followupBodies = [];
  const reconciledIds = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      eventSources.push(this);
    }
    emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() {}
  }

  globalThis.window = {
    __ModuleLoader__: { load(def) { moduleDef = def; } },
    EventSource: FakeEventSource,
  };
  globalThis.fetch = async (url, init) => {
    if (url.includes('/followups') && init?.method === 'POST') {
      followupBodies.push(JSON.parse(init.body));
      throw new Error('network dropped after server accept');
    }
    if (url.includes('/tasks/by-request/')) {
      const id = decodeURIComponent(url.split('/tasks/by-request/')[1]);
      reconciledIds.push(id);
      return { ok: true, status: 200, async json() { return { taskId: 'task-drop-1', status: 'running', runGeneration: 2 }; } };
    }
    return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
  };

  try {
    new Function(clientSource)();
    const stateSlots = [];
    const refSlots = [];
    const effectCleanups = [];
    let stateIdx = 0;
    let refIdx = 0;
    const exported = moduleDef.factory((dep) => {
      if (dep === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState(init) {
            const idx = stateIdx++;
            if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
            return [
              stateSlots[idx],
              (next) => {
                stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next;
              },
            ];
          },
          useRef(init) {
            const idx = refIdx++;
            if (!(idx in refSlots)) refSlots[idx] = { current: init };
            return refSlots[idx];
          },
          useCallback: (fn) => fn,
          useEffect(fn) {
            const cleanup = fn();
            if (typeof cleanup === 'function') effectCleanups.push(cleanup);
          },
        };
      }
      throw new Error(`Unexpected require: ${dep}`);
    });

    const disposers = [];
    exported.apply({
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      effect(register) { const d = register(); if (typeof d === 'function') disposers.push(d); },
    }, { dispatchEnabled: false });

    const initialTask = {
      taskId: 'task-drop-1',
      requestId: 'req-orig-old-1',
      status: 'waiting_user',
      runGeneration: 1,
      summary: 'Gen 1 summary',
      result: 'Gen 1 result',
      rawResult: 'Gen 1 raw',
      sources: [{ id: 's1', title: 'Gen 1 source', authorized: true }],
      artifacts: [{ id: 'a1', label: 'gen1.pdf', authorized: true }],
    };
    const renderCard = () => {
      stateIdx = 0;
      refIdx = 0;
      return exported.ExpertTaskStatusCard({ initialTask });
    };
    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    const t0 = renderCard();
    findNodes(t0, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'Followup text' } });
    const t1 = renderCard();
    await findNodes(t1, (n) => n.props?.['data-testid'] === 'fexp-followup-btn')[0].props.onClick();

    assert.equal(followupBodies.length, 1);
    const sentReqId = followupBodies[0].requestId;
    assert.ok(sentReqId && sentReqId !== 'req-orig-old-1', 'followup must send an independent requestId');

    const tUnknown = renderCard();
    assert.equal(tUnknown.props['data-task-status'], 'unknown');
    assert.equal(findNodes(tUnknown, (n) => n.props?.['data-testid'] === 'fexp-followup-btn').length, 0);
    assert.equal(findNodes(tUnknown, (n) => n.props?.['data-testid'] === 'fexp-task-refresh').length, 0, 'generic refresh must stay locked while followup acceptance is unknown');

    // Auto-reconcile SSE event with runGeneration: 2 converges card and clears Gen 1 results.
    eventSources[0].emit({
      type: 'task-reconciled',
      requestId: sentReqId,
      taskId: 'task-drop-1',
      status: 'running',
      runGeneration: 2,
    });
    const tAfterSse = renderCard();
    assert.equal(tAfterSse.props['data-task-status'], 'running');
    assert.equal(findNodes(tAfterSse, (n) => n.props?.['data-testid'] === 'fexp-task-result').length, 0);
    assert.equal(findNodes(tAfterSse, (n) => n.props?.['data-testid'] === 'fexp-raw-drawer').length, 0);
    assert.equal(findNodes(tAfterSse, (n) => n.props?.['data-testid'] === 'fexp-task-artifacts').length, 0);
    assert.equal(reconciledIds.includes('req-orig-old-1'), false);

    for (const c of effectCleanups) c();
    for (const d of disposers) d();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

for (const viaSse of [false, true]) {
  test(`follow-up 404 hides cached results and preserves the draft for same-request readback via ${viaSse ? 'SSE' : 'manual reconciliation'} (#484)`, async (t) => {
    const taskId = 'task-unavailable';
    const originalRequest = 'request-original';
    const submittedText = 'Follow-up draft';
    const cached = {
      summary: 'cached summary',
      rawResult: 'cached raw result',
      result: 'cached result',
      sources: [{ authorized: true, title: 'cached source' }],
      artifacts: [{ authorized: true, label: 'cached artifact' }],
    };
    const initialTask = { taskId, requestId: originalRequest, status: 'waiting_user', runGeneration: 1, ...cached };
    let followupId;
    let authorized = false;
    let sends = 0;
    const reconciledRequests = [];
    const card = mountReviewTaskCard(t, {
      initialTask,
      async fetchImpl(url, init) {
        if (url.endsWith('/followups')) {
          sends += 1;
          followupId = JSON.parse(init.body).requestId;
          if (!viaSse) throw new Error('response lost before receipt was read');
          return cardJson(503, { error: { code: 'EXPERT_ACCEPTANCE_UNKNOWN', details: { requestId: followupId } } });
        }
        if (url.includes('/by-request/')) {
          reconciledRequests.push(url);
          return authorized
            ? cardJson(200, { taskId, status: 'waiting_user', runGeneration: 2 })
            : cardJson(404, { error: { code: 'EXPERT_TASK_NOT_FOUND' } });
        }
        if (url.endsWith('/result')) return cardJson(200, { result: 'fresh authorized result', runGeneration: 2 });
        assert.ok(url.endsWith(`/tasks/${taskId}`), url);
        return cardJson(200, { status: 'waiting_user', runGeneration: 2 });
      },
    });

    const initial = card.render();
    assert.equal(cardElement(initial, 'fexp-task-result').children[0], cached.result);
    cardElement(initial, 'fexp-raw-toggle').props.onClick();
    cardElement(initial, 'fexp-followup-box').children[0].props.onChange({ target: { value: submittedText } });
    await cardElement(card.render(), 'fexp-followup-btn').props.onClick();
    const pending = card.render();
    assert.equal(pending.props['data-task-status'], 'unknown');
    assert.ok(followupId && followupId !== originalRequest);
    if (viaSse) card.emitReconciled({ requestId: followupId, notFound: true, status: 'not_found' });
    else await cardElement(pending, 'fexp-task-reconcile').props.onClick();

    const unavailable = card.render();
    assert.equal(unavailable.props['data-task-status'], 'not_found');
    assert.match(cardElement(unavailable, 'fexp-task-notice').children[0], /未找到.*无权查看/u);
    const assertHidden = (tree) => {
      for (const id of ['fexp-task-summary', 'fexp-task-result', 'fexp-task-sources', 'fexp-task-artifacts', 'fexp-raw-drawer', 'fexp-followup-btn', 'fexp-task-cancel']) {
        assert.equal(cardElement(tree, id), null, id);
      }
    };
    assertHidden(unavailable);
    assertHidden(card.render({ ...initialTask }));
    const retainedDraft = cardElement(unavailable, 'fexp-followup-box').children[0];
    assert.equal(retainedDraft.props.value, submittedText);
    assert.equal(retainedDraft.props.readOnly, true);
    assert.equal(sends, 1);

    // Explicitly retry the read, keeping the same requestId. A fresh authorized result can then be displayed.
    authorized = true;
    await cardElement(card.render(), 'fexp-task-reconcile').props.onClick();
    const settled = card.render();
    assert.equal(settled.props['data-task-status'], 'waiting_user');
    assert.equal(cardElement(settled, 'fexp-followup-box').children[0].props.value, '');
    assert.equal(cardElement(settled, 'fexp-task-result'), null);
    await cardElement(settled, 'fexp-task-refresh').props.onClick();
    assert.equal(cardElement(card.render(), 'fexp-task-result').children[0], 'fresh authorized result');
    assert.deepEqual(reconciledRequests, Array(viaSse ? 1 : 2).fill(`/api/forge-experts/tasks/by-request/${followupId}`));
    assert.equal(sends, 1);
  });
}

test('reconnect inside 5s cooldown schedules a single trailing reconcile once cooldown elapses (#484)', async () => {
  const eventSources = [];
  let reconcileCalls = 0;
  const scheduledTimers = [];
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const origDateNow = Date.now;
  let fakeNow = 1_700_000_000_000;

  Date.now = () => fakeNow;
  globalThis.setTimeout = (fn, delay) => {
    const token = { fn, delay, cleared: false };
    scheduledTimers.push(token);
    return token;
  };
  globalThis.clearTimeout = (token) => {
    if (token && typeof token === 'object') token.cleared = true;
  };

  const fetchImpl = async (url, init) => {
    if (url.includes('/tasks/reconcile') && init?.method === 'POST') {
      reconcileCalls += 1;
      return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    const disposers = [];
    exported.apply({
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      effect(register) { const d = register(); if (typeof d === 'function') disposers.push(d); },
    }, { dispatchEnabled: false });

    eventSources[0].emit({ type: 'ready', scopeEpoch: 1, viewVersion: 1 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    assert.equal(reconcileCalls, 1);

    // Reconnect 1s later (inside 5s cooldown) -> coalesced into one trailing timer.
    fakeNow += 1_000;
    eventSources[0].emit({ type: 'ready', scopeEpoch: 1, viewVersion: 1 });
    eventSources[0].emit({ type: 'ready', scopeEpoch: 1, viewVersion: 1 });
    assert.equal(reconcileCalls, 1);
    assert.equal(scheduledTimers.length, 1);
    assert.equal(scheduledTimers[0].delay, 4_000);

    // Cooldown elapses and trailing timer fires -> second reconcile runs.
    fakeNow += 4_000;
    scheduledTimers[0].fn();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    assert.equal(reconcileCalls, 2);

    for (const d of disposers) d();
  } finally {
    Date.now = origDateNow;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    restore();
  }
});

test('manual and automatic reconciliation clear accepted followupText even when reconciled status is waiting_user (#484)', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let moduleDef = null;
  const eventSources = [];
  const sentReqIds = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      eventSources.push(this);
    }
    emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() {}
  }

  globalThis.window = {
    __ModuleLoader__: { load(def) { moduleDef = def; } },
    EventSource: FakeEventSource,
  };
  globalThis.fetch = async (url, init) => {
    if (url.includes('/followups') && init?.method === 'POST') {
      sentReqIds.push(JSON.parse(init.body).requestId);
      throw new Error('dropped after accept');
    }
    if (url.includes('/tasks/by-request/')) {
      return {
        ok: true,
        status: 200,
        async json() { return { taskId: 'task-clr-1', status: 'waiting_user', runGeneration: 2 }; },
      };
    }
    return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
  };

  try {
    new Function(clientSource)();
    const stateSlots = [];
    const refSlots = [];
    const effectCleanups = [];
    let stateIdx = 0;
    let refIdx = 0;
    const exported = moduleDef.factory((dep) => {
      if (dep === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState(init) {
            const idx = stateIdx++;
            if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
            return [
              stateSlots[idx],
              (next) => { stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next; },
            ];
          },
          useRef(init) {
            const idx = refIdx++;
            if (!(idx in refSlots)) refSlots[idx] = { current: init };
            return refSlots[idx];
          },
          useCallback: (fn) => fn,
          useEffect(fn) {
            const cleanup = fn();
            if (typeof cleanup === 'function') effectCleanups.push(cleanup);
          },
        };
      }
      throw new Error(`Unexpected require: ${dep}`);
    });

    const disposers = [];
    exported.apply({
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      effect(register) { const d = register(); if (typeof d === 'function') disposers.push(d); },
    }, { dispatchEnabled: false });

    const initialTask = { taskId: 'task-clr-1', requestId: 'req-0', status: 'waiting_user', runGeneration: 1 };
    const renderCard = () => {
      stateIdx = 0;
      refIdx = 0;
      return exported.ExpertTaskStatusCard({ initialTask });
    };
    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    // 1. Manual reconcile confirms acceptance (status: waiting_user) -> followupText is cleared.
    const t0 = renderCard();
    findNodes(t0, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'Accepted followup 1' } });
    const t1 = renderCard();
    await findNodes(t1, (n) => n.props?.['data-testid'] === 'fexp-followup-btn')[0].props.onClick();
    const tUnknown1 = renderCard();
    await findNodes(tUnknown1, (n) => n.props?.['data-testid'] === 'fexp-task-reconcile')[0].props.onClick();
    const tAfterManual = renderCard();
    assert.equal(tAfterManual.props['data-task-status'], 'waiting_user');
    assert.equal(findNodes(tAfterManual, (n) => n.type === 'input')[0].props.value, '', 'manual reconcile must clear accepted followupText');

    // 2. Auto SSE task-reconciled confirms acceptance (status: waiting_user) -> followupText is cleared.
    findNodes(tAfterManual, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'Accepted followup 2' } });
    const t2 = renderCard();
    await findNodes(t2, (n) => n.props?.['data-testid'] === 'fexp-followup-btn')[0].props.onClick();
    renderCard();
    eventSources[0].emit({
      type: 'task-reconciled',
      requestId: sentReqIds[1],
      taskId: 'task-clr-1',
      status: 'waiting_user',
      runGeneration: 3,
    });
    const tAfterAuto = renderCard();
    assert.equal(tAfterAuto.props['data-task-status'], 'waiting_user');
    assert.equal(findNodes(tAfterAuto, (n) => n.type === 'input')[0].props.value, '', 'auto reconcile must clear accepted followupText');

    for (const c of effectCleanups) c();
    for (const d of disposers) d();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('ExpertTaskStatusCard drops stale lower-generation reconcile snapshots, preserves edits made during slow followup, and protects unknown lock on parent re-render (#484)', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let moduleDef = null;
  const eventSources = [];
  let releaseSlowFollowup = null;
  let followupAttempt = 0;

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      eventSources.push(this);
    }
    emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() {}
  }

  globalThis.window = {
    __ModuleLoader__: { load(def) { moduleDef = def; } },
    EventSource: FakeEventSource,
  };
  globalThis.fetch = async (url, init) => {
    if (url.includes('/followups') && init?.method === 'POST') {
      followupAttempt += 1;
      if (followupAttempt === 1) {
        await new Promise((resolve) => { releaseSlowFollowup = resolve; });
        return { ok: true, status: 201, async json() { return { taskId: 'task-race-1', status: 'running', runGeneration: 2 }; } };
      }
      throw new Error('wire drop on 2nd followup');
    }
    return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
  };

  try {
    new Function(clientSource)();
    const stateSlots = [];
    const refSlots = [];
    const effectCleanups = [];
    let stateIdx = 0;
    let refIdx = 0;
    const exported = moduleDef.factory((dep) => {
      if (dep === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState(init) {
            const idx = stateIdx++;
            if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
            return [
              stateSlots[idx],
              (next) => { stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next; },
            ];
          },
          useRef(init) {
            const idx = refIdx++;
            if (!(idx in refSlots)) refSlots[idx] = { current: init };
            return refSlots[idx];
          },
          useCallback: (fn) => fn,
          useEffect(fn) {
            const cleanup = fn();
            if (typeof cleanup === 'function') effectCleanups.push(cleanup);
          },
        };
      }
      throw new Error(`Unexpected require: ${dep}`);
    });

    const disposers = [];
    exported.apply({
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      effect(register) { const d = register(); if (typeof d === 'function') disposers.push(d); },
    }, { dispatchEnabled: false });

    let currentInitial = { taskId: 'task-race-1', requestId: 'req-g1', status: 'waiting_user', runGeneration: 1 };
    const renderCard = () => {
      stateIdx = 0;
      refIdx = 0;
      return exported.ExpertTaskStatusCard({ initialTask: currentInitial });
    };
    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    // 1. Slow followup disables input and preserves text if modified before response resolves.
    const t0 = renderCard();
    findNodes(t0, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'First followup' } });
    const t1 = renderCard();
    const pendingSubmit = findNodes(t1, (n) => n.props?.['data-testid'] === 'fexp-followup-btn')[0].props.onClick();
    const tBusy = renderCard();
    assert.equal(findNodes(tBusy, (n) => n.type === 'input')[0].props.disabled, true, 'followup input must be disabled while submitting');
    findNodes(tBusy, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'Newer unsent note' } });
    releaseSlowFollowup();
    await pendingSubmit;
    const tAfterFu = renderCard();
    assert.equal(tAfterFu.props['data-task-status'], 'running');

    // 2. Late lower-generation reconcile event (g1 waiting_user) must NOT roll back g2 running.
    eventSources[0].emit({
      type: 'task-reconciled',
      requestId: 'req-g1',
      taskId: 'task-race-1',
      status: 'waiting_user',
      runGeneration: 1,
    });
    const tAfterLateReconcile = renderCard();
    assert.equal(tAfterLateReconcile.props['data-task-status'], 'running', 'stale lower-generation reconcile must not roll back task');

    // 3. Move to g2 waiting_user, trigger wire-drop unknown lock, then parent re-renders with new initialTask object for same taskId -> lock must remain intact.
    currentInitial = { taskId: 'task-race-1', requestId: 'req-g2', status: 'waiting_user', runGeneration: 2 };
    renderCard();
    const tWait2 = renderCard();
    assert.equal(tWait2.props['data-task-status'], 'waiting_user');
    assert.equal(findNodes(tWait2, (n) => n.type === 'input')[0].props.value, 'Newer unsent note');
    await findNodes(tWait2, (n) => n.props?.['data-testid'] === 'fexp-followup-btn')[0].props.onClick();
    const tLocked = renderCard();
    assert.equal(tLocked.props['data-task-status'], 'unknown');

    currentInitial = { taskId: 'task-race-1', requestId: 'req-g2', status: 'waiting_user', runGeneration: 2 };
    renderCard();
    const tAfterParentRerender = renderCard();
    assert.equal(tAfterParentRerender.props['data-task-status'], 'unknown', 'parent re-render must not clobber active unknown reconcile lock');

    for (const c of effectCleanups) c();
    for (const d of disposers) d();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('SSE reconnect ready polls /turns/finalized and recovers draft finalized during disconnect (#484)', async () => {
  const eventSources = [];
  let finalizedPolls = 0;
  const fetchImpl = async (url, init) => {
    if (url.includes('/mentions')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scopeEpoch: 5,
            viewVersion: 7,
            candidates: [{ expertId: 'exp-fin-1', displayName: '经营分析专家', scopeEpoch: 5, viewVersion: 7 }],
          };
        },
      };
    }
    if (url.includes('/selections') && init?.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            selectionToken: 'sel-missed-sse-1',
            expertId: 'exp-fin-1',
            sessionId: 'sess-missed',
            draftDigest: 'sha256:missed-1',
            expiresAt: '2030-01-01T00:02:00.000Z',
          };
        },
      };
    }
    if (url.includes('/turns/finalized')) {
      finalizedPolls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scopeEpoch: 5,
            items: [{
              sessionId: 'sess-missed',
              expertId: 'exp-fin-1',
              draftDigest: 'sha256:missed-1',
              status: 'model_did_not_delegate',
              preserveDraft: true,
              notice: '主助手未调用所选专家，已保留您的草稿。',
            }],
          };
        },
      };
    }
    if (url.includes('/tasks/reconcile')) {
      return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    let registeredSpec = null;
    const disposers = [];
    exported.apply({
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      inputTriggers: {
        registerSource(spec) {
          registeredSpec = spec;
          return () => { registeredSpec = null; };
        },
      },
      effect(register) { const d = register(); if (typeof d === 'function') disposers.push(d); },
    }, { dispatchEnabled: true });

    const rows = await registeredSpec.query('', { sessionId: 'sess-missed' });
    const recovered = [];
    registeredSpec.onDraftRecovery((evt) => recovered.push(evt));

    const prep = await registeredSpec.prepareSubmit({
      picked: rows[0],
      sessionId: 'sess-missed',
      taskText: 'Draft finalized while SSE was disconnected',
      draftVersion: 3,
    });
    assert.equal(prep.ok, true);

    // SSE disconnects while turn finalizes on host, then reconnects with ready (no turn-finalized SSE frame received).
    eventSources[0].fail();
    eventSources[0].emit({ type: 'ready', scopeEpoch: 5, viewVersion: 7 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    assert.equal(finalizedPolls, 1);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].draft?.taskText, 'Draft finalized while SSE was disconnected');

    for (const d of disposers) d();
  } finally {
    restore();
  }
});

for (const reconnect of [false, true]) {
  test('interim acceptance_unknown keeps the exact draft for definite failure over ' + (reconnect ? 'reconnect polling' : 'SSE') + ' (#484)', async (t) => {
    const eventSources = [];
    const calls = [];
    const sessionId = 'sess-late-denial';
    const expertId = 'exp-fin-1';
    const draftDigest = 'sha256:late-denial';
    const draft = { taskText: 'Late policy denial draft', draftVersion: 7, reuseRefs: ['ref-reviewed'] };
    const failed = { sessionId, expertId, draftDigest, status: 'failed', code: 'EXPERT_POLICY_DENIED', preserveDraft: true };
    const { exported, restore } = loadClientModule({
      eventSources,
      async fetchImpl(url) {
        calls.push(url);
        if (url.includes('/mentions')) {
          return cardJson(200, {
            scopeEpoch: 5, viewVersion: 7,
            candidates: [{ expertId, displayName: '经营分析专家', scopeEpoch: 5, viewVersion: 7 }],
          });
        }
        if (url.endsWith('/selections')) return cardJson(201, { selectionToken: 'sel-late-denial', expertId, sessionId, draftDigest });
        if (url.endsWith('/turns/finalized')) return cardJson(200, { scopeEpoch: 5, items: [failed, failed] });
        if (url.endsWith('/tasks/reconcile')) return cardJson(200, { reconciled: [], notFound: [], stillPending: [] });
        assert.fail(`Unexpected request ${url}`);
      },
    });
    let source;
    let dispose;
    t.after(() => { dispose?.(); restore(); });
    exported.apply({
      slots: { inject(_name, register) { return register(); }, register() { return () => {}; } },
      inputTriggers: {
        registerSource(spec) {
          source = spec;
          return () => { source = null; };
        },
      },
      effect(register) { dispose = register(); },
    }, { dispatchEnabled: true });
    const [picked] = await source.query('', { sessionId });
    const recovered = [];
    source.onDraftRecovery((event) => recovered.push(event));
    assert.equal((await source.prepareSubmit({ picked, sessionId, ...draft })).ok, true);

    const stream = eventSources[0];
    stream.emit({
      type: 'turn-finalized', sessionId, expertId, draftDigest, status: 'acceptance_unknown',
      code: 'EXPERT_ACCEPTANCE_UNKNOWN', preserveDraft: false,
    });
    assert.deepEqual(recovered, [], 'uncertain acceptance must not restore the draft');
    if (reconnect) stream.fail();
    else stream.emit({ type: 'turn-finalized', ...failed });
    stream.emit({ type: 'ready', scopeEpoch: 5, viewVersion: 7 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'failed');
    assert.equal(recovered[0].code, 'EXPERT_POLICY_DENIED');
    assert.deepEqual(recovered[0].draft, draft);
    assert.equal(calls.filter((url) => url.endsWith('/turns/finalized')).length, reconnect ? 1 : 0);
    assert.equal(calls.filter((url) => url.endsWith('/selections')).length, 1);
  });
}

for (const reconnect of [false, true]) {
  test(`two selections with the same draft digest recover their own versions via ${reconnect ? 'reconnect' : 'SSE'} (#484)`, async (t) => {
    const eventSources = [];
    const sessionId = 'sess-repeat';
    const expertId = 'exp-fin-1';
    const draftDigest = 'sha256:same-content';
    const drafts = [7, 8].map((draftVersion) => ({ draftVersion, taskText: 'Same text and references', reuseRefs: ['ref-reviewed'] }));
    const recoveryIds = ['draft-first', 'draft-second'];
    const finalEvents = recoveryIds.map((draftRecoveryId) => ({
      sessionId, expertId, draftDigest, draftRecoveryId, status: 'failed', code: 'EXPERT_POLICY_DENIED', preserveDraft: true,
    }));
    let prepareCalls = 0;
    let polls = 0;
    const { exported, restore } = loadClientModule({
      eventSources,
      async fetchImpl(url) {
        if (url.includes('/mentions')) {
          return cardJson(200, {
            scopeEpoch: 5, viewVersion: 7,
            candidates: [{ expertId, displayName: '经营分析专家', scopeEpoch: 5, viewVersion: 7 }],
          });
        }
        if (url.endsWith('/selections')) {
          const index = prepareCalls++;
          return cardJson(201, { selectionToken: `token-${index}`, expertId, sessionId, draftDigest, draftRecoveryId: recoveryIds[index] });
        }
        if (url.endsWith('/turns/finalized')) {
          polls += 1;
          return cardJson(200, { scopeEpoch: 5, items: [finalEvents[0], finalEvents[0], finalEvents[1]] });
        }
        if (url.endsWith('/tasks/reconcile')) return cardJson(200, { reconciled: [], notFound: [], stillPending: [] });
        assert.fail(`Unexpected request ${url}`);
      },
    });
    let source;
    let dispose;
    t.after(() => { dispose?.(); restore(); });
    exported.apply({
      slots: { inject(_name, register) { return register(); }, register() { return () => {}; } },
      inputTriggers: {
        registerSource(spec) {
          source = spec;
          return () => { source = null; };
        },
      },
      effect(register) { dispose = register(); },
    }, { dispatchEnabled: true });
    const [picked] = await source.query('', { sessionId });
    const recovered = [];
    source.onDraftRecovery((event) => recovered.push(event.draft));
    assert.equal((await source.prepareSubmit({ picked, sessionId, ...drafts[0] })).ok, true);

    const stream = eventSources[0];
    stream.emit({ type: 'turn-finalized', ...finalEvents[0], status: 'acceptance_unknown', preserveDraft: false });
    assert.equal((await source.prepareSubmit({ picked, sessionId, ...drafts[1] })).ok, true);
    if (reconnect) {
      stream.fail();
    } else {
      stream.emit({ type: 'turn-finalized', ...finalEvents[0], draftRecoveryId: 'unbuffered-attempt' });
      for (const event of [finalEvents[0], finalEvents[0], finalEvents[1]]) stream.emit({ type: 'turn-finalized', ...event });
    }
    stream.emit({ type: 'ready', scopeEpoch: 5, viewVersion: 7 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    assert.deepEqual(recovered, drafts);
    assert.equal(polls, reconnect ? 1 : 0);
  });
}

function mountDraftRecovery(t, fetchImpl) {
  const eventSources = [];
  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  let source;
  let dispose;
  t.after(() => { dispose?.(); restore(); });
  exported.apply({
    slots: { inject(_name, register) { return register(); }, register() { return () => {}; } },
    inputTriggers: {
      registerSource(spec) {
        source = spec;
        return () => { source = null; };
      },
    },
    effect(register) { dispose = register(); },
  }, { dispatchEnabled: true });
  return { getSource: () => source, stream: eventSources[0], dispose: () => dispose?.() };
}

test('an IAM scope change discards buffered and queued drafts and delayed finalized projections (#484)', async (t) => {
  const sessionId = 'sess-reused';
  const expertId = 'exp-fin-1';
  const draftDigest = 'sha256:identical-across-epochs';
  const pollStarted = Promise.withResolvers();
  const pollReply = Promise.withResolvers();
  let scopeEpoch = 5;
  let submissions = 0;
  const finalized = (draftRecoveryId, epoch = 5) => ({
    type: 'turn-finalized', sessionId, expertId, draftDigest, draftRecoveryId, scopeEpoch: epoch,
    status: 'failed', code: 'EXPERT_POLICY_DENIED', preserveDraft: true,
  });
  const { getSource, stream } = mountDraftRecovery(t, (url) => {
    if (url.includes('/mentions')) return cardJson(200, {
      scopeEpoch, viewVersion: 7, candidates: [{ expertId, displayName: '专家', scopeEpoch, viewVersion: 7 }],
    });
    if (url.endsWith('/selections')) {
      submissions += 1;
      return cardJson(201, {
        selectionToken: `token-${submissions}`, expertId, sessionId, draftDigest, scopeEpoch,
        ...(scopeEpoch === 5 ? { draftRecoveryId: `old-${submissions}` } : {}),
      });
    }
    if (url.endsWith('/turns/finalized')) {
      pollStarted.resolve();
      return pollReply.promise;
    }
    if (url.endsWith('/tasks/reconcile')) return cardJson(200, { reconciled: [], notFound: [] });
    assert.fail(`Unexpected request ${url}`);
  });

  const oldSource = getSource();
  const [picked] = await oldSource.query('', { sessionId });
  for (const taskText of ['queued draft', 'late SSE draft', 'late poll draft']) {
    assert.equal((await oldSource.prepareSubmit({ picked, sessionId, taskText })).ok, true);
  }
  stream.emit(finalized('old-1'));
  stream.emit({ type: 'ready', scopeEpoch });
  await pollStarted.promise;

  scopeEpoch = 6;
  stream.emit({ type: 'scope-changed', scopeEpoch });
  const stale = [];
  const detachStale = oldSource.onDraftRecovery((event) => stale.push(event));
  const recovered = [];
  const currentSource = getSource();
  currentSource.onDraftRecovery((event) => recovered.push(event));
  detachStale();
  stream.emit(finalized('old-2'));
  pollReply.resolve(cardJson(200, { scopeEpoch: 5, items: [finalized('old-3')] }));
  await new Promise(setImmediate);
  assert.deepEqual(stale, []);
  assert.deepEqual(recovered, []);

  const [currentPick] = await currentSource.query('', { sessionId });
  assert.equal((await currentSource.prepareSubmit({ picked: currentPick, sessionId, taskText: 'current draft' })).ok, true);
  // A legacy frame carries no epoch and can collide with a new account's identical digest.
  stream.emit({ ...finalized(undefined), scopeEpoch: undefined });
  assert.deepEqual(recovered, []);
  stream.emit(finalized(undefined, 6));
  assert.deepEqual(recovered.map(({ draft }) => draft?.taskText), ['current draft']);
});

for (const boundary of ['scope-changed', 'reconnect with a different scope', 'disposal']) {
  test(`a pending prepareSubmit cannot register a draft after ${boundary} (#484)`, async (t) => {
    const sessionId = 'sess-prepare';
    const expertId = 'exp-fin-1';
    const started = Promise.withResolvers();
    const reply = Promise.withResolvers();
    const { getSource, stream, dispose } = mountDraftRecovery(t, (url) => {
      if (url.includes('/mentions')) return cardJson(200, {
        scopeEpoch: 5, viewVersion: 7, candidates: [{ expertId, displayName: '专家', scopeEpoch: 5, viewVersion: 7 }],
      });
      if (url.endsWith('/selections')) {
        started.resolve();
        return reply.promise;
      }
      if (url.endsWith('/tasks/reconcile')) return cardJson(200, { reconciled: [], notFound: [] });
      assert.fail(`Unexpected request ${url}`);
    });
    const oldSource = getSource();
    const [picked] = await oldSource.query('', { sessionId });
    const prepare = oldSource.prepareSubmit({ picked, sessionId, taskText: 'old in-flight draft' });
    await started.promise;
    if (boundary === 'disposal') dispose();
    else if (boundary === 'scope-changed') stream.emit({ type: 'scope-changed', scopeEpoch: 6 });
    else {
      stream.fail();
      stream.emit({ type: 'ready', scopeEpoch: 6 });
    }

    reply.resolve(cardJson(201, { selectionToken: 'old-token', draftRecoveryId: 'old-recovery', expertId, sessionId, scopeEpoch: 5 }));
    const late = await prepare;
    assert.equal(late.ok, false);
    assert.equal(late.preserveDraft, true);
    assert.equal(Object.hasOwn(late, 'draft'), false, 'the stale completion must not export the previous scope draft');
    if (boundary !== 'disposal') {
      const restored = [];
      getSource().onDraftRecovery((event) => restored.push(event));
      stream.emit({
        type: 'turn-finalized', scopeEpoch: 6, sessionId, expertId, draftRecoveryId: 'old-recovery',
        status: 'failed', preserveDraft: true,
      });
      assert.deepEqual(restored, []);
    }
  });
}

test('initial ready binds recovery and a restarted Host with a lower epoch clears the prior scope (#484)', async (t) => {
  const sessionId = 'sess-reused';
  const expertId = 'exp-fin-1';
  const draftDigest = 'sha256:reused-across-hosts';
  let scopeEpoch = 9;
  const { getSource, stream } = mountDraftRecovery(t, (url) => {
    if (url.includes('/mentions')) return cardJson(200, {
      scopeEpoch, viewVersion: 1, candidates: [{ expertId, displayName: '专家', scopeEpoch, viewVersion: 1 }],
    });
    if (url.endsWith('/selections')) return cardJson(201, {
      selectionToken: `selected-${scopeEpoch}`, sessionId, expertId, draftDigest, scopeEpoch,
    });
    if (url.endsWith('/tasks/reconcile')) return cardJson(200, { reconciled: [], notFound: [] });
    assert.fail(`Unexpected request ${url}`);
  });
  stream.emit({ type: 'ready', scopeEpoch });
  const oldSource = getSource();
  const [previousPick] = await oldSource.query('', { sessionId });
  assert.equal((await oldSource.prepareSubmit({ picked: previousPick, sessionId, taskText: 'previous draft' })).ok, true);

  stream.fail();
  scopeEpoch = 2;
  stream.emit({ type: 'ready', scopeEpoch });
  const currentSource = getSource();
  const restored = [];
  currentSource.onDraftRecovery((event) => restored.push(event.draft?.taskText));
  const failed = {
    type: 'turn-finalized', sessionId, expertId, draftDigest, status: 'failed', preserveDraft: true,
  };
  stream.emit({ ...failed, scopeEpoch: 9 });
  assert.deepEqual(restored, []);
  const [currentPick] = await currentSource.query('', { sessionId });
  assert.equal((await currentSource.prepareSubmit({ picked: currentPick, sessionId, taskText: 'restarted host draft' })).ok, true);
  stream.emit(failed);
  stream.emit({ ...failed, scopeEpoch: 9 });
  assert.deepEqual(restored, []);
  stream.emit({ ...failed, scopeEpoch });
  assert.deepEqual(restored, ['restarted host draft']);
});

test('ExpertTaskStatusCard ignores late handleRefresh response when a newer generation arrives via reconcile during /result (#484)', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  let moduleDef = null;
  const eventSources = [];
  let releaseDelayedResult = null;
  let resultStarted = null;
  const resultStartedPromise = new Promise((resolve) => { resultStarted = resolve; });

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      eventSources.push(this);
    }
    emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() {}
  }

  globalThis.window = {
    __ModuleLoader__: { load(def) { moduleDef = def; } },
    EventSource: FakeEventSource,
  };
  globalThis.fetch = async (url) => {
    if (url.endsWith('/tasks/task-late-ref-1')) {
      return {
        ok: true,
        status: 200,
        async json() { return { taskId: 'task-late-ref-1', status: 'waiting_user', runGeneration: 1 }; },
      };
    }
    if (url.endsWith('/tasks/task-late-ref-1/result')) {
      resultStarted();
      await new Promise((resolve) => { releaseDelayedResult = resolve; });
      return {
        ok: true,
        status: 200,
        async json() { return { taskId: 'task-late-ref-1', runGeneration: 1, result: 'Old Gen 1 result' }; },
      };
    }
    return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [] }; } };
  };

  try {
    new Function(clientSource)();
    const stateSlots = [];
    const refSlots = [];
    const effectCleanups = [];
    let stateIdx = 0;
    let refIdx = 0;
    const exported = moduleDef.factory((dep) => {
      if (dep === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState(init) {
            const idx = stateIdx++;
            if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
            return [
              stateSlots[idx],
              (next) => { stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next; },
            ];
          },
          useRef(init) {
            const idx = refIdx++;
            if (!(idx in refSlots)) refSlots[idx] = { current: init };
            return refSlots[idx];
          },
          useCallback: (fn) => fn,
          useEffect(fn) {
            const cleanup = fn();
            if (typeof cleanup === 'function') effectCleanups.push(cleanup);
          },
        };
      }
      throw new Error(`Unexpected require: ${dep}`);
    });

    const disposers = [];
    exported.apply({
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      effect(register) { const d = register(); if (typeof d === 'function') disposers.push(d); },
    }, { dispatchEnabled: false });

    const initialTask = { taskId: 'task-late-ref-1', requestId: 'req-late-ref-1', status: 'waiting_user', runGeneration: 1 };
    const renderCard = () => {
      stateIdx = 0;
      refIdx = 0;
      return exported.ExpertTaskStatusCard({ initialTask });
    };
    const findNodes = (node, pred, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      for (const child of node.children ?? []) findNodes(child, pred, acc);
      return acc;
    };

    const t0 = renderCard();
    const refreshPromise = findNodes(t0, (n) => n.props?.['data-testid'] === 'fexp-task-refresh')[0].props.onClick();
    await resultStartedPromise;

    // While /result for g1 is still in flight, SSE reconcile advances card to g2 running.
    eventSources[0].emit({
      type: 'task-reconciled',
      requestId: 'req-late-ref-1',
      taskId: 'task-late-ref-1',
      status: 'running',
      runGeneration: 2,
    });
    renderCard();

    // Delayed g1 /result resolves -> must NOT roll back g2 running to g1 waiting_user.
    releaseDelayedResult();
    await refreshPromise;
    const tAfter = renderCard();
    assert.equal(tAfter.props['data-task-status'], 'running');
    assert.equal(findNodes(tAfter, (n) => n.props?.['data-testid'] === 'fexp-task-result').length, 0);
    assert.equal(findNodes(tAfter, (n) => n.props?.['data-testid'] === 'fexp-followup-btn').length, 0);

    for (const c of effectCleanups) c();
    for (const d of disposers) d();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('turn-finalized arriving while draftRecoveryListener is temporarily unregistered queues recovery and delivers once when new listener attaches (#484)', async () => {
  const eventSources = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/mentions')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            scopeEpoch: 5,
            viewVersion: 7,
            candidates: [{ expertId: 'exp-fin-1', displayName: '经营分析专家', scopeEpoch: 5, viewVersion: 7 }],
          };
        },
      };
    }
    if (url.includes('/selections') && init?.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            selectionToken: 'sel-queued-rec-1',
            expertId: 'exp-fin-1',
            sessionId: 'sess-remount',
            draftDigest: 'sha256:remount-1',
            expiresAt: '2030-01-01T00:02:00.000Z',
          };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { reconciled: [], notFound: [], stillPending: [], items: [] }; } };
  };

  const { exported, restore } = loadClientModule({ eventSources, fetchImpl });
  try {
    let registeredSpec = null;
    const disposers = [];
    exported.apply({
      slots: { inject(_n, fn) { fn(); return () => {}; }, register() { return () => {}; } },
      inputTriggers: {
        registerSource(spec) {
          registeredSpec = spec;
          return () => { registeredSpec = null; };
        },
      },
      effect(register) { const d = register(); if (typeof d === 'function') disposers.push(d); },
    }, { dispatchEnabled: true });

    const rows = await registeredSpec.query('', { sessionId: 'sess-remount' });
    const oldRecovered = [];
    const detachOld = registeredSpec.onDraftRecovery((evt) => oldRecovered.push(evt));

    const prep = await registeredSpec.prepareSubmit({
      picked: rows[0],
      sessionId: 'sess-remount',
      taskText: 'Draft during listener remount',
      draftVersion: 1,
    });
    assert.equal(prep.ok, true);

    // Old listener detaches before turn-finalized arrives.
    detachOld();
    eventSources[0].emit({
      type: 'turn-finalized',
      sessionId: 'sess-remount',
      expertId: 'exp-fin-1',
      draftDigest: 'sha256:remount-1',
      status: 'model_did_not_delegate',
      preserveDraft: true,
      notice: '主助手未调用所选专家，已保留您的草稿。',
    });
    assert.equal(oldRecovered.length, 0);

    // New listener attaches after remount -> receives the queued draft recovery exactly once.
    const newRecovered = [];
    registeredSpec.onDraftRecovery((evt) => newRecovered.push(evt));
    assert.equal(newRecovered.length, 1);
    assert.equal(newRecovered[0].draft?.taskText, 'Draft during listener remount');

    // Attaching another listener later must not replay already-delivered recovery.
    const laterRecovered = [];
    registeredSpec.onDraftRecovery((evt) => laterRecovered.push(evt));
    assert.equal(laterRecovered.length, 0);

    for (const d of disposers) d();
  } finally {
    restore();
  }
});

function mountReviewTaskCard(t, { initialTask, fetchImpl }) {
  const state = [];
  const refs = [];
  const effects = [];
  let stateIndex;
  let refIndex;
  let effectIndex;
  let pendingEffects;
  let renderAgain;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (update) => {
        const next = typeof update === 'function' ? update(state[index]) : update;
        if (!Object.is(state[index], next)) {
          state[index] = next;
          renderAgain = true;
        }
      }];
    },
    useRef(initial) {
      const index = refIndex++;
      return refs[index] ??= { current: initial };
    },
    useEffect(effect, deps) {
      const index = effectIndex++;
      const previous = effects[index];
      if (previous && deps?.every((value, offset) => Object.is(value, previous.deps?.[offset]))) return;
      pendingEffects.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: effect() };
      });
    },
  };
  const eventSources = [];
  const { exported, restore } = loadClientModule({ eventSources, fetchImpl, react });
  let dispose;
  t.after(() => {
    for (const effect of effects) effect.cleanup?.();
    dispose?.();
    restore();
  });
  exported.apply({ effect(register) { dispose = register(); } });

  return {
    render(nextTask = initialTask) {
      initialTask = nextTask;
      let tree;
      do {
        stateIndex = refIndex = effectIndex = 0;
        pendingEffects = [];
        renderAgain = false;
        tree = exported.ExpertTaskStatusCard({ initialTask });
        for (const effect of pendingEffects) effect();
      } while (renderAgain);
      return tree;
    },
    emitReconciled(entry) {
      eventSources[0].emit({ type: 'task-reconciled', ...entry });
    },
  };
}

function cardElement(tree, testId) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.props?.['data-testid'] === testId) return tree;
  for (const child of tree.children ?? []) {
    const found = cardElement(child, testId);
    if (found) return found;
  }
  return null;
}

function cardJson(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

for (const [deniedAt, statusCode] of [
  ['status', 401], ['result', 403], ['status recheck', 403],
  ['status', 404], ['result', 404], ['status recheck', 404],
]) {
  test(`PR #484 review: clears cached content when ${deniedAt} denies access (${statusCode})`, async (t) => {
    const initialTask = { taskId: 'task-a', requestId: 'request-a', status: 'completed', runGeneration: 1 };
    const cached = {
      runGeneration: 1,
      summary: 'previous summary',
      rawResult: 'previous raw result',
      result: 'previous result',
      sources: [{ authorized: true, title: 'previous source' }],
      artifacts: [{ authorized: true, label: 'previous artifact' }],
    };
    let revoked = false;
    let statusReads = 0;
    let currentResult = cached;
    const code = { 401: 'EXPERT_AUTH_REVOKED', 403: 'EXPERT_ORG_FORBIDDEN', 404: 'EXPERT_TASK_NOT_FOUND' }[statusCode];
    const deny = () => cardJson(statusCode, { error: { code } });
    const card = mountReviewTaskCard(t, {
      initialTask,
      async fetchImpl(url) {
        if (url.endsWith('/tasks/task-a')) {
          statusReads += 1;
          if (revoked && deniedAt === 'status') return deny();
          if (revoked && deniedAt === 'status recheck' && statusReads === 2) return deny();
          return cardJson(200, { status: 'completed', runGeneration: 1 });
        }
        assert.ok(url.endsWith('/tasks/task-a/result'), url);
        if (revoked && deniedAt === 'result') return deny();
        if (revoked && deniedAt === 'status recheck') return cardJson(200, { ...cached, runGeneration: 2 });
        return cardJson(200, currentResult);
      },
    });

    await cardElement(card.render(), 'fexp-task-refresh').props.onClick();
    cardElement(card.render(), 'fexp-raw-toggle').props.onClick();
    assert.equal(cardElement(card.render(), 'fexp-raw-content')?.children[0], cached.rawResult);

    revoked = true;
    statusReads = 0;
    await cardElement(card.render(), 'fexp-task-refresh').props.onClick();
    const assertCleared = (tree) => {
      for (const part of ['fexp-task-summary', 'fexp-task-result', 'fexp-task-sources', 'fexp-task-artifacts', 'fexp-raw-drawer']) {
        assert.equal(cardElement(tree, part), null, part + ' must be removed after authorization is denied');
      }
    };
    const denied = card.render();
    assertCleared(denied);
    assert.match(cardElement(denied, 'fexp-task-notice').children[0], /授权已撤销|无权访问|无权查看/u);
    assertCleared(card.render({ ...initialTask, ...cached }));

    // A successful, authorized result fetch restores only the fresh projection.
    revoked = false;
    currentResult = { runGeneration: 1, rawResult: 'fresh raw result', result: 'fresh result' };
    await cardElement(card.render(), 'fexp-task-refresh').props.onClick();
    const recovered = card.render();
    assert.equal(cardElement(recovered, 'fexp-task-result').children[0], 'fresh result');
    assert.equal(cardElement(recovered, 'fexp-raw-toggle').props['aria-expanded'], false);
    assert.equal(cardElement(recovered, 'fexp-raw-content'), null);
  });
}

test('PR #484 review: a late refresh cannot roll a reconciled task back in the same generation', async (t) => {
  const resultStarted = Promise.withResolvers();
  const resultReply = Promise.withResolvers();
  const initialTask = { taskId: 'task-a', requestId: 'request-a', status: 'waiting_user', runGeneration: 2 };
  const card = mountReviewTaskCard(t, {
    initialTask,
    async fetchImpl(url) {
      if (url.endsWith('/tasks/task-a/result')) {
        resultStarted.resolve();
        return resultReply.promise;
      }
      assert.ok(url.endsWith('/tasks/task-a'), url);
      return cardJson(200, { status: 'waiting_user', runGeneration: 2 });
    },
  });

  const refresh = cardElement(card.render(), 'fexp-task-refresh').props.onClick();
  await resultStarted.promise;
  card.emitReconciled({ ...initialTask, status: 'completed', result: 'authoritative result' });
  // The late reply can arrive in the same event batch, before the reconciled state is rendered.
  resultReply.resolve(cardJson(200, { runGeneration: 2, result: 'stale partial result' }));
  await refresh;

  const current = card.render();
  assert.equal(current.props['data-task-status'], 'completed');
  assert.equal(cardElement(current, 'fexp-task-result').children[0], 'authoritative result');
  assert.equal(cardElement(current, 'fexp-followup-btn'), null);
});

for (const requestOnly of [false, true]) {
  test('PR #484 review: discards manual reconcile after switching ' + (requestOnly ? 'request-only' : 'identified') + ' task cards', async (t) => {
    const reply = Promise.withResolvers();
    const card = mountReviewTaskCard(t, {
      initialTask: { ...(requestOnly ? {} : { taskId: 'task-a' }), requestId: 'request-a', status: 'unknown', runGeneration: 1 },
      async fetchImpl(url) {
        assert.ok(url.endsWith('/tasks/by-request/request-a'), url);
        return reply.promise;
      },
    });

    const reconcile = cardElement(card.render(), 'fexp-task-reconcile').props.onClick();
    const newTask = {
      ...(requestOnly ? {} : { taskId: 'task-b' }),
      requestId: 'request-b',
      status: requestOnly ? 'unknown' : 'completed',
      runGeneration: 1,
      result: 'result for task B',
    };
    const switched = card.render(newTask);
    const newAction = requestOnly ? 'fexp-task-reconcile' : 'fexp-task-refresh';
    reply.resolve(cardJson(200, { taskId: 'task-a', status: 'failed', runGeneration: 1, result: 'result for task A' }));
    await reconcile;

    const current = card.render();
    assert.equal(current.props['data-task-status'], newTask.status);
    assert.equal(cardElement(current, 'fexp-task-result').children[0], 'result for task B');
    assert.match(JSON.stringify(current), /请求号：request-b/u);
    assert.doesNotMatch(JSON.stringify(current), /任务号：task-a/u);
    assert.equal(cardElement(switched, newAction).props.disabled, false, 'the old task must release the card actions');
  });
}

for (const action of ['followup', 'cancel']) {
  test('PR #484 review: discards a late ' + action + ' after switching tasks', async (t) => {
    const reply = Promise.withResolvers();
    const card = mountReviewTaskCard(t, {
      initialTask: { taskId: 'task-a', requestId: 'request-a', status: 'waiting_user', runGeneration: 1 },
      async fetchImpl(url) {
        assert.ok(url.endsWith(action === 'followup' ? '/tasks/task-a/followups' : '/tasks/task-a/cancel'), url);
        return reply.promise;
      },
    });

    const followupInput = (tree) => cardElement(tree, 'fexp-followup-box').children[0];
    if (action === 'followup') followupInput(card.render()).props.onChange({ target: { value: 'draft for task A' } });
    const actionId = action === 'followup' ? 'fexp-followup-btn' : 'fexp-task-cancel';
    const pending = cardElement(card.render(), actionId).props.onClick();
    const taskB = card.render({ taskId: 'task-b', requestId: 'request-b', status: 'waiting_user', runGeneration: 1 });
    followupInput(taskB).props.onChange({ target: { value: 'draft for task B' } });

    if (action === 'followup') reply.reject(new Error('response lost'));
    else reply.resolve(cardJson(200, { status: 'cancelled', runGeneration: 1, cancelRequested: true }));
    await pending;

    const current = card.render();
    assert.equal(current.props['data-task-status'], 'waiting_user');
    assert.match(JSON.stringify(current), /请求号：request-b/u);
    assert.equal(followupInput(current).props.value, 'draft for task B');
    assert.equal(cardElement(current, 'fexp-task-notice'), null);
  });
}

for (const automatic of [true, false]) {
  test('PR #484 review: first dispatch has an explicit inaccessible state after ' + (automatic ? 'automatic' : 'manual') + ' notFound', async (t) => {
    const calls = [];
    const card = mountReviewTaskCard(t, {
      initialTask: { requestId: 'request-first', status: 'unknown' },
      async fetchImpl(url, init) {
        calls.push([url, init?.method]);
        return cardJson(404, { error: { code: 'EXPERT_TASK_NOT_FOUND' } });
      },
    });

    const pending = card.render();
    assert.equal(pending.props['data-task-status'], 'unknown');
    if (automatic) card.emitReconciled({ requestId: 'request-first', notFound: true, status: 'not_found' });
    else await cardElement(pending, 'fexp-task-reconcile').props.onClick();

    const current = card.render();
    assert.equal(current.props['data-task-status'], 'not_found');
    assert.match(cardElement(current, 'fexp-task-status-badge').children[0], /不可访问/u);
    assert.match(cardElement(current, 'fexp-task-notice').children[0], /未找到.*无权查看/u);
    assert.equal(cardElement(current, 'fexp-followup-btn'), null);
    assert.deepEqual(calls, automatic ? [] : [['/api/forge-experts/tasks/by-request/request-first', 'GET']]);
  });
}

for (const sameTask of [true, false]) {
  test('PR #484 recheck: ' + (sameTask ? 'accepts a newer manual result after learning its task id' : 'rejects a result for a conflicting learned task id'), async (t) => {
    const reply = Promise.withResolvers();
    const card = mountReviewTaskCard(t, {
      initialTask: { taskId: '  ', requestId: 'request-a', status: 'unknown' },
      async fetchImpl(url) {
        assert.ok(url.endsWith('/tasks/by-request/request-a'), url);
        return reply.promise;
      },
    });

    const manual = cardElement(card.render(), 'fexp-task-reconcile').props.onClick();
    card.emitReconciled({ requestId: 'request-a', taskId: 'task-a', status: 'running', runGeneration: 1 });
    reply.resolve(cardJson(200, {
      taskId: sameTask ? 'task-a' : 'task-b',
      status: 'completed',
      runGeneration: 2,
      result: 'manual result',
    }));
    await manual;

    const current = card.render();
    assert.match(JSON.stringify(current), /任务号：task-a/u);
    assert.equal(current.props['data-task-status'], sameTask ? 'completed' : 'running');
    assert.equal(cardElement(current, 'fexp-task-result')?.children[0], sameTask ? 'manual result' : undefined);
  });
}

test('PR #484 recheck: a duplicate notFound cannot discard a successful manual retry', async (t) => {
  const reply = Promise.withResolvers();
  const card = mountReviewTaskCard(t, {
    initialTask: { requestId: 'request-a', status: 'unknown' },
    async fetchImpl(url) {
      assert.ok(url.endsWith('/tasks/by-request/request-a'), url);
      return reply.promise;
    },
  });
  card.render();
  const announcement = { requestId: 'request-a', status: 'not_found', notFound: true };
  card.emitReconciled(announcement);
  const unavailable = card.render();
  assert.equal(unavailable.props['data-task-status'], 'not_found');

  const manual = cardElement(unavailable, 'fexp-task-reconcile').props.onClick();
  card.emitReconciled(announcement);
  reply.resolve(cardJson(200, { taskId: 'task-a', status: 'completed', runGeneration: 1, result: 'found result' }));
  await manual;

  const current = card.render();
  assert.equal(current.props['data-task-status'], 'completed');
  assert.equal(cardElement(current, 'fexp-task-result')?.children[0], 'found result');
});

test('PR #484 recheck: a duplicate completed announcement cannot discard a same-generation result refresh', async (t) => {
  const resultStarted = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const card = mountReviewTaskCard(t, {
    initialTask: { requestId: 'request-a', status: 'unknown' },
    async fetchImpl(url) {
      if (url.endsWith('/tasks/task-a/result')) {
        resultStarted.resolve();
        return reply.promise;
      }
      assert.ok(url.endsWith('/tasks/task-a'), url);
      return cardJson(200, { status: 'completed', runGeneration: 1 });
    },
  });
  card.render();
  const announcement = { requestId: 'request-a', taskId: 'task-a', status: 'completed', runGeneration: 1 };
  card.emitReconciled(announcement);

  const refresh = cardElement(card.render(), 'fexp-task-refresh').props.onClick();
  await resultStarted.promise;
  card.emitReconciled(announcement);
  reply.resolve(cardJson(200, { runGeneration: 1, result: 'first authorized result' }));
  await refresh;

  const current = card.render();
  assert.equal(current.props['data-task-status'], 'completed');
  assert.equal(cardElement(current, 'fexp-task-result')?.children[0], 'first authorized result');
});
