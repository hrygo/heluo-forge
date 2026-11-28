import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function loadClientModule({ eventSources = [], fetchImpl = null } = {}) {
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
      return {
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

test('buffered pendingDraft survives SSE scope-changed and disconnect/ready reconnect before turn-finalized recovery (#481/#483)', async () => {
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

    eventSources[0].emit({ type: 'scope-changed', scopeEpoch: 6, viewVersion: 8 });
    eventSources[0].fail();
    eventSources[0].emit({ type: 'ready', scopeEpoch: 6, viewVersion: 8 });
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
