import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// C, rendered: the account page must actually show the renewal state. The Host
// side of this contract is in session-renewal-view.test.mjs; here the client is
// mounted with the real module loader and rendered, so a notice that is computed
// but never placed in the tree fails the test.

const base = { configured: true, signedIn: true, canSignIn: false, canSignOut: true, principal: 'synthetic-user', error: null };

async function mountAccountPage(view, t) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const cells = [];
  const effects = [];
  const cleanups = [];
  const timers = new Map();
  const deadlines = new Map();
  let cursor = 0;
  let nextTimer = 0;
  let Panel;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
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
        register(options, component) { if (options.name === 'settings.section' && options.id === 'forge-iam') Panel = component; },
      } });
    } },
    location: { assign() {} },
  };
  runInNewContext(source, {
    window,
    fetch: async () => Response.json({ ...base, ...view, gatewayCredential: { state: 'unknown' } }),
    AbortController,
    setInterval: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn) => { const id = ++nextTimer; deadlines.set(id, fn); return id; },
    clearTimeout: (id) => deadlines.delete(id),
  });
  assert.ok(Panel, 'the account page must register itself');
  const render = () => { cursor = 0; return Panel(); };
  render();
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  await new Promise(setImmediate);
  t.after(() => { for (const cleanup of cleanups) cleanup(); });
  const text = (node) => typeof node === 'string' ? node : node?.children?.map(text).join('') ?? '';
  return { render, text };
}

test('an expired session without a renewal window shows the re-login notice', async (t) => {
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const page = await mountAccountPage({
    state: 'expired', renewal: 'unavailable', accessExpiresAt: deadline,
    refreshExpiresAt: new Date(Date.now() - 1).toISOString(),
  }, t);
  const rendered = page.text(page.render());
  assert.match(rendered, /长时间未使用，会话已过期且无法自动续期，请重新登录。/);
  assert.match(rendered, /会话已过期，需重新登录/);
});

test('a renewable session says nothing about losing the session', async (t) => {
  const page = await mountAccountPage({
    state: 'ready', renewal: 'available',
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 3_700_000).toISOString(),
  }, t);
  const rendered = page.text(page.render());
  assert.doesNotMatch(rendered, /无法自动续期/);
  assert.doesNotMatch(rendered, /会话续期窗口即将结束/);
});

test('a closing renewal window warns while the session still works', async (t) => {
  const page = await mountAccountPage({
    state: 'ready', renewal: 'available',
    accessExpiresAt: new Date(Date.now() + 240_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  }, t);
  const rendered = page.text(page.render());
  assert.match(rendered, /会话续期窗口即将结束/);
  assert.doesNotMatch(rendered, /无法自动续期/);
});