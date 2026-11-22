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
    const disposeCallbacks = [];
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
      on(event, fn) {
        if (event === 'dispose') disposeCallbacks.push(fn);
      },
    };

    exported.apply(ctx);
    assert.equal(registeredSections.length, 1);
    assert.equal(registeredSections[0].meta.name, 'settings.section');
    assert.equal(registeredSections[0].meta.id, 'forge-experts');
    assert.equal(registeredSections[0].meta.label(), '专家智能体');
    assert.equal(triggerCalled, false, 'production @ trigger must remain closed by default');

    for (const fn of disposeCallbacks) fn();
    assert.equal(disposedCount, 1);
  } finally {
    restore();
  }
});

test('isolated mentions preview registers @ group, validates onPick version, drops group on SSE invalidation/disconnect without touching native groups, and restores on ready', async () => {
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
      on(event, fn) {
        if (event === 'dispose') disposeCallbacks.push(fn);
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

    // In-flight query interrupted by SSE disconnect must be discarded and group unregistered.
    const slowQuery = source.query('slow', { sessionId: 'sess-1' });
    assert.equal(eventSources.length, 1);
    eventSources[0].fail();
    assert.equal(unregisterCalls, 1);
    assert.equal(activeGroups.has('forge-experts-mentions'), false);
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
