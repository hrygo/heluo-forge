import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Mount several registered slots in the same module factory, as one browser
// page does. Each component has its own hook cells and cleanup lifecycle.
export async function mountPage(fetch, { eventSource } = {}) {
  const source = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  const components = new Map();
  const instances = new Map();
  const retired = [];
  const intervals = new Map();
  const timeouts = new Map();
  const persisted = new Map();
  let current = null;
  let nextTimer = 0;
  let clock = 0;
  const localStorage = {
    get length() { return persisted.size; },
    key: (index) => [...persisted.keys()][index] ?? null,
    getItem: (key) => persisted.get(key) ?? null,
    setItem: (key, value) => persisted.set(key, String(value)),
    removeItem: (key) => persisted.delete(key),
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const instance = current;
      const index = instance.cursor++;
      if (!(index in instance.cells)) instance.cells[index] = initial;
      return [instance.cells[index], (next) => {
        if (instance.closed) { instance.lateUpdates++; return; }
        instance.cells[index] = typeof next === 'function' ? next(instance.cells[index]) : next;
      }];
    },
    useRef(initial) {
      const instance = current;
      const index = instance.cursor++;
      if (!(index in instance.cells)) instance.cells[index] = { current: initial };
      return instance.cells[index];
    },
    useCallback(fn) { current.cursor++; return fn; },
    useEffect(fn) {
      const instance = current;
      const index = instance.cursor++;
      if (!(index in instance.cells)) { instance.cells[index] = true; instance.effects.push(fn); }
    },
  };
  const window = {
    __ModuleLoader__: { load(definition) {
      const plugin = definition.factory((name) => { assert.equal(name, 'react'); return React; });
      plugin.apply({ slots: {
        inject(_name, register) { register(); },
        register(options, component) { components.set(options.id, component); },
      } });
    } },
    localStorage, EventSource: eventSource, AbortSignal: globalThis.AbortSignal,
    location: { assign() {} }, open: () => null,
  };
  runInNewContext(source, {
    window, fetch, AbortController,
    setTimeout: (fn, delay = 0) => { const id = ++nextTimer; timeouts.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn) => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
  });
  const render = (id) => {
    const instance = instances.get(id);
    assert.ok(instance, `component not mounted: ${id}`);
    instance.cursor = 0;
    current = instance;
    try { return instance.component(instance.props); }
    finally { current = null; }
  };
  const mount = (id, props = {}) => {
    assert.ok(!instances.has(id));
    const component = components.get(id);
    assert.ok(component, `unknown component: ${id}`);
    const instance = { component, props, cells: [], effects: [], cleanups: [], cursor: 0, closed: false, lateUpdates: 0 };
    instances.set(id, instance);
    render(id);
    for (const effect of instance.effects.splice(0)) {
      const cleanup = effect();
      if (typeof cleanup === 'function') instance.cleanups.push(cleanup);
    }
  };
  const unmount = (id) => {
    const instance = instances.get(id);
    assert.ok(instance, `component not mounted: ${id}`);
    instance.closed = true;
    for (const cleanup of instance.cleanups.splice(0)) cleanup();
    instances.delete(id);
    retired.push(instance);
  };
  return {
    mount, unmount, render,
    async settled() { await new Promise(setImmediate); },
    async tick() { await Promise.all([...intervals.values()].map((callback) => callback())); },
    advanceTime(ms) {
      clock += ms;
      for (const [id, timer] of timeouts) if (timer.at <= clock) { timeouts.delete(id); timer.fn(); }
    },
    get intervalCount() { return intervals.size; },
    get lateUpdates() { return retired.reduce((total, instance) => total + instance.lateUpdates, 0); },
    close() {
      for (const id of [...instances.keys()]) unmount(id);
      assert.equal(intervals.size, 0);
    },
  };
}
