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
        useState: (init) => [init, () => {}],
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
    assert.equal(registeredSections.length, 1);
    assert.equal(registeredSections[0].meta.name, 'settings.section');
    assert.equal(registeredSections[0].meta.id, 'forge-experts');
    assert.equal(registeredSections[0].meta.label(), '专家智能体');
    assert.equal(triggerCalled, false, 'production @ trigger must remain closed by default');

    for (const fn of disposers) fn();
    assert.equal(disposedCount, 1, 'section registration must be released through the Cordis effect');
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
    assert.equal(rows[1].label, '经营分析专家 (exp-fin-2)', 'homonymous experts without disambiguation must fall back to stable expertId');

    // Valid pick -> prepareSubmit returns selectionToken
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
