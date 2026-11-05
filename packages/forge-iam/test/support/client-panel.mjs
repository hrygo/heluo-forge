import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

export async function mountPanel(fetch, { open = () => null, navigator, componentId = 'forge-iam', componentProps = {}, storage } = {}) {
  const source = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  const cells = [];
  const effects = [];
  const cleanups = [];
  const timers = new Map();
  const locations = [];
  // A Map-backed localStorage: the panel caches model personalisation there, so
  // tests must be able to seed and inspect it instead of relying on absence.
  const persisted = new Map(Object.entries(storage ?? {}));
  const localStorage = {
    get length() { return persisted.size; },
    key: index => [...persisted.keys()][index] ?? null,
    getItem: key => persisted.has(key) ? persisted.get(key) : null,
    setItem: (key, value) => { persisted.set(key, String(value)); },
    removeItem: (key) => { persisted.delete(key); },
  };
  let closed = false;
  let lateUpdates = 0;
  let cursor = 0;
  let nextTimer = 0;
  let Panel;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], (next) => { if (closed) lateUpdates++; cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) {
      const index = cursor++;
      if (!(index in cells)) { cells[index] = true; effects.push(fn); }
    },
  };
  const window = {
    __ModuleLoader__: { load(definition) {
      const plugin = definition.factory((name) => {
        assert.equal(name, 'react');
        return React;
      });
      plugin.apply({ slots: {
        inject(_name, register) { register(); },
        register(options, component) { if (options.id === componentId) Panel = component; },
      } });
    } },
    location: { assign: (url) => locations.push(url) },
    open, navigator, localStorage,
  };
  runInNewContext(source, {
    window, fetch, navigator, setTimeout: () => 0,
    setInterval: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
  });
  assert.ok(Panel);
  const render = () => { cursor = 0; return Panel(componentProps); };
  render();
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  await new Promise(setImmediate);
  const text = (node) => typeof node === 'string' ? node : node?.children?.map(text).join('') ?? '';
  const findButton = (node, label) => {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === 'button' && text(node) === label) return node;
    for (const child of node.children ?? []) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return undefined;
  };
  return {
    render, text, findButton, locations, storage: persisted,
    tick() { assert.equal(timers.size, 1); return [...timers.values()][0](); },
    get lateUpdates() { return lateUpdates; },
    close() { closed = true; for (const cleanup of cleanups) cleanup(); assert.equal(timers.size, 0); },
  };
}
