import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('client single bundle registers settings.section, keeps production @ trigger closed, and disposes cleanly', () => {
  let moduleDef = null;
  const previousWindow = globalThis.window;
  try {
    globalThis.window = {
      __ModuleLoader__: {
        load(def) { moduleDef = def; },
      },
    };
    const runner = new Function(clientSource);
    runner();

    assert.equal(moduleDef?.id, '@heluo/forge-experts');
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
    assert.equal(typeof registeredSections[0].component, 'function');
    assert.equal(triggerCalled, false, 'production @ trigger must remain closed in management stage');

    for (const fn of disposeCallbacks) fn();
    assert.equal(disposedCount, 1);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
