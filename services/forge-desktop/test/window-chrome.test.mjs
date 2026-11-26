/**
 * Tests of the shell's window chrome: the rules in `window-chrome.mjs`, the
 * bridge its title bar is given, and the title bar page itself. None of it
 * needs Electron — the bridge runs against a stand-in, the page is read as text.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  ACTION_CHANNEL,
  BRIDGE_TYPE,
  chromeState,
  contentBounds,
  hasTitleBarBridge,
  isTitleBarRequest,
  isWindowAction,
  STATE_CHANNEL,
  titleBarQuery,
  WINDOW_ACTIONS,
  windowChrome,
} from '../src/window-chrome.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(PKG_ROOT, 'src');
const read = (path) => readFileSync(path, 'utf8');
const titleBarPage = () => read(join(PKG_ROOT, 'resources', 'titlebar.html'));

test('macOS and Windows drop the system title bar for the shell\'s own; any other platform keeps it', () => {
  const mac = windowChrome({ platform: 'darwin' });
  assert.equal(mac.frameless, true);
  assert.equal(mac.controls, 'traffic-lights');
  // The system lights would sit under the bar's own.
  assert.equal(mac.hideSystemButtons, true);
  assert.ok(mac.barHeight > 0);
  const windows = windowChrome({ platform: 'win32' });
  assert.equal(windows.frameless, true);
  assert.equal(windows.controls, 'caption');
  assert.equal(windows.hideSystemButtons, false);
  assert.ok(windows.barHeight > 0);
  for (const platform of ['linux', 'freebsd', '', undefined]) {
    assert.deepEqual(windowChrome({ platform }), { frameless: false, barHeight: 0, controls: null, hideSystemButtons: false, window: {} });
  }
  // A hidden title bar, never a window with its frame or its background taken
  // away: each of those costs the shadow, resizing from the edges, or maximising.
  for (const platform of ['darwin', 'win32']) {
    const { window } = windowChrome({ platform });
    assert.deepEqual(window, { titleBarStyle: 'hidden' });
  }
});

test('the content sits below the bar, has the whole window without one, and all of it in full screen', () => {
  assert.deepEqual(contentBounds({ width: 1280, height: 800, barHeight: 28 }), { x: 0, y: 28, width: 1280, height: 772 });
  assert.deepEqual(contentBounds({ width: 1280, height: 800, barHeight: 32 }), { x: 0, y: 32, width: 1280, height: 768 });
  assert.deepEqual(contentBounds({ width: 1280, height: 800, barHeight: 0 }), { x: 0, y: 0, width: 1280, height: 800 });
  assert.deepEqual(contentBounds({ width: 1280, height: 800, barHeight: 28, fullscreen: true }), { x: 0, y: 0, width: 1280, height: 800 });
  // A window shorter than its bar is never given a negative area.
  assert.deepEqual(contentBounds({ width: 200, height: 20, barHeight: 32 }), { x: 0, y: 32, width: 200, height: 0 });
});

test('the title bar is started with what it needs to draw itself, and nothing else', () => {
  assert.deepEqual(titleBarQuery({ platform: 'win32', barHeight: 32, title: '河洛 Forge 企业版' }), { platform: 'win32', bar: '32', title: '河洛 Forge 企业版' });
});

test('only the three window actions are actions', () => {
  assert.deepEqual([...WINDOW_ACTIONS], ['minimize', 'toggle-maximize', 'close']);
  for (const action of WINDOW_ACTIONS) assert.equal(isWindowAction(action), true);
  const others = ['destroy', 'show', 'reload', 'Minimize', 'minimize ', '', undefined, null, 0, {}, ['close'], { toString: () => 'close' }];
  for (const other of others) assert.equal(isWindowAction(other), false, `${String(other)} is not an action`);
});

test('a request is the title bar\'s only when it comes from that page, in its main frame', () => {
  const window = { webContents: { mainFrame: { id: 'bar' } } };
  const { webContents } = window;
  assert.equal(isTitleBarRequest(webContents, webContents.mainFrame, window), true);
  // Another page of the same window...
  const content = { mainFrame: { id: 'content' } };
  assert.equal(isTitleBarRequest(content, content.mainFrame, window), false);
  // ...a frame inside the title bar...
  assert.equal(isTitleBarRequest(webContents, { id: 'frame' }, window), false);
  // ...the title bar's frame arriving on another page...
  assert.equal(isTitleBarRequest(content, webContents.mainFrame, window), false);
  // ...or nothing at all.
  assert.equal(isTitleBarRequest(undefined, undefined, window), false);
  assert.equal(isTitleBarRequest(webContents, webContents.mainFrame, null), false);
});

test('what the title bar is told is two plain facts: zoomed, and frontmost or not', () => {
  assert.deepEqual(chromeState({ maximized: true, focused: false }), { maximized: true, focused: false });
  // Anything short of exactly `true` is no; a focus that was never reported counts as frontmost.
  assert.deepEqual(chromeState({ maximized: 'yes' }), { maximized: false, focused: true });
});

test('a title bar counts as in place only when its bridge came up on the page', () => {
  // The probe asks for the type only: nothing of the page is read, and it cannot throw.
  assert.equal(BRIDGE_TYPE, 'typeof window.forgeWindow');
  const { evaluate } = loadBridge();
  assert.equal(evaluate(BRIDGE_TYPE), 'object');
  // A page whose preload did not take has no bridge, and is not a title bar that can be used.
  const bare = loadBridge();
  bare.evaluate('window.forgeWindow = undefined');
  assert.equal(bare.evaluate(BRIDGE_TYPE), 'undefined');
  for (const type of ['undefined', 'function', 'string', 'boolean', 'number']) assert.equal(hasTitleBarBridge(type), false, type);
  assert.equal(hasTitleBarBridge('object'), true);
  assert.equal(hasTitleBarBridge(undefined), false);
});

/** The bridge, run against a stand-in for the `electron` a sandboxed page is given. */
function loadBridge() {
  const exposed = {};
  const invoked = [];
  const listeners = new Map();
  const requires = [];
  const ipcRenderer = {
    invoke: (...args) => {
      invoked.push(args);
      return Promise.resolve();
    },
    on: (channel, listener) => listeners.set(listener, channel),
    removeListener: (channel, listener) => {
      if (listeners.get(listener) === channel) listeners.delete(listener);
    },
  };
  // The page the preload runs in. Its `window` is its global, as in a real page,
  // so an expression can be evaluated there as the shell evaluates one.
  const context = {
    require: (name) => {
      requires.push(name);
      return {
        contextBridge: {
          exposeInMainWorld: (key, api) => {
            exposed[key] = api;
            context[key] = api;
          },
        },
        ipcRenderer,
      };
    },
  };
  context.window = context;
  vm.createContext(context);
  const source = read(join(SOURCE, 'window-chrome.preload.cjs'));
  vm.runInContext(source, context, { filename: 'window-chrome.preload.cjs' });
  return { exposed, invoked, listeners, requires, source, evaluate: (expression) => vm.runInContext(expression, context) };
}

test('the bridge hands the title bar three actions and the window\'s state, and nothing else', async () => {
  const { exposed, invoked, listeners, requires, source } = loadBridge();
  // One thing is required, the same one on every platform, and once.
  assert.deepEqual(requires, ['electron']);
  assert.equal((source.match(/\brequire\(/gu) ?? []).length, 1);
  // One object on the page, with four members.
  assert.deepEqual(Object.keys(exposed), ['forgeWindow']);
  const bridge = exposed.forgeWindow;
  assert.deepEqual(Object.keys(bridge).sort(), ['close', 'minimize', 'onState', 'toggleMaximize']);
  // Each action names itself on the one channel the shell answers.
  await bridge.minimize();
  await bridge.toggleMaximize();
  await bridge.close();
  assert.deepEqual(invoked, [[ACTION_CHANNEL, 'minimize'], [ACTION_CHANNEL, 'toggle-maximize'], [ACTION_CHANNEL, 'close']]);
  // Nothing is forwarded and nothing comes back: an action has nothing to carry.
  assert.equal(await bridge.minimize('anything', { url: 'https://corp.example/' }), undefined);
  assert.deepEqual(invoked.at(-1), [ACTION_CHANNEL, 'minimize']);
  // The state arrives on its own channel, as the state alone; it stops when told.
  const seen = [];
  const stop = bridge.onState((state) => seen.push(state));
  const [listener] = listeners.keys();
  assert.equal(listeners.get(listener), STATE_CHANNEL);
  listener({ sender: 'whatever the event carries' }, { maximized: true });
  listener({}, { maximized: false, focused: false });
  assert.deepEqual(seen, [{ maximized: true }, { maximized: false, focused: false }]);
  stop();
  assert.equal(listeners.size, 0);
});

/** Kept pure so the mutation cases below prove each rule fails. */
export function titleBarProblems(source) {
  const problems = [];
  // The bar is what the window is dragged by, and its buttons stay clickable inside it.
  if (!/app-region:\s*drag/u.test(source)) problems.push("the title bar must be the window's drag region");
  if (!/app-region:\s*no-drag/u.test(source)) problems.push('the title bar controls must leave the drag region');
  // One page, two looks.
  for (const platform of ['darwin', 'win32']) {
    if (!source.includes(`html[data-platform="${platform}"]`)) problems.push(`the title bar must have a ${platform} look`);
  }
  // Everything shown is text.
  if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/u.test(source)) problems.push('the title bar must show text only, never markup or code');
  // Nothing from outside, and nothing that could bring it in.
  if (/<a\b|https?:\/\/|<link\b|<script[^>]*\bsrc=|<img\b|@import\b|url\(/u.test(source)) problems.push('the title bar must stay local');
  if (!/Content-Security-Policy" content="default-src 'none'/u.test(source)) problems.push('the title bar must allow nothing to load');
  // No capability beyond the bridge.
  if (/\brequire\(|\bprocess\b|\bipcRenderer\b|\bBuffer\b|\bimport\s*\(|window\.dsh|localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket/u.test(source)) {
    problems.push('the title bar must use nothing but its bridge');
  }
  // The bridge whole: every member, on the page's one bridge.
  if (!source.includes('const bridge = window.forgeWindow;')) problems.push('the title bar must take the bridge it is given');
  for (const member of ['minimize', 'toggleMaximize', 'close', 'onState']) {
    if (!source.includes(`bridge.${member}(`)) problems.push(`the title bar must use bridge.${member}`);
  }
  return problems;
}

test('标题栏页面约束：可拖动、按钮可点、两种外观、只以文本显示、无外链、只用桥接（变异证明）', () => {
  const page = titleBarPage();
  assert.deepEqual(titleBarProblems(page), []);
  // The actions it offers are exactly the ones the shell answers.
  const offered = [...page.matchAll(/data-action="([a-z-]+)"/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(offered)].sort(), [...WINDOW_ACTIONS].sort());
  const variants = [
    [page.replace('app-region: drag; -webkit-app-region: drag;', ''), /drag region/],
    [page.replace('app-region: no-drag; -webkit-app-region: no-drag;', ''), /leave the drag region/],
    [page.replaceAll('data-platform="darwin"', 'data-platform="macos"'), /darwin look/],
    [page.replaceAll('data-platform="win32"', 'data-platform="windows"'), /win32 look/],
    [page.replace("document.getElementById('title').textContent = query.get('title')", "document.getElementById('title').innerHTML = query.get('title')"), /text only/],
    [page.replace('</header>', '<a href="#">帮助</a></header>'), /stay local/],
    [page.replace('<script>', '<script src="./titlebar.js">'), /stay local/],
    [page.replace("default-src 'none'", "default-src 'self'"), /allow nothing to load/],
    [page.replace('const bridge = window.forgeWindow;', 'const bridge = window.forgeWindow ?? window.dsh;'), /nothing but its bridge/],
    [page.replace("const query = new URLSearchParams(location.search);", "const query = new URLSearchParams(require('node:url').parse(location.search).query);"), /nothing but its bridge/],
    [page.replace('const bridge = window.forgeWindow;', 'const bridge = Object.create(null);'), /take the bridge/],
    [page.replace('bridge.close()', 'void 0'), /bridge\.close/],
    [page.replace('bridge.toggleMaximize()', 'void 0'), /bridge\.toggleMaximize/],
    [page.replace('bridge.minimize()', 'void 0'), /bridge\.minimize/],
    [page.replace('bridge.onState(follow);', ''), /bridge\.onState/],
  ];
  for (const [variant, pattern] of variants) {
    const problems = titleBarProblems(variant);
    assert.ok(problems.length > 0, 'a mutated page must produce at least one problem');
    assert.match(problems.join('\n'), pattern);
  }
});

test('the page and the bridge name the same actions and channels as the shell', () => {
  const page = titleBarPage();
  const { source } = loadBridge();
  // The bridge cannot import the module (a sandboxed page has no module loader), so it spells them out.
  assert.ok(source.includes(`'${ACTION_CHANNEL}'`));
  assert.ok(source.includes(`'${STATE_CHANNEL}'`));
  // The page asks by name, and only for names the shell answers.
  for (const action of WINDOW_ACTIONS) assert.ok(page.includes(`data-action="${action}"`), action);
});

/** Kept pure so the mutation below proves it fails. */
export function preloadGivers(sources) {
  const givers = Object.entries(sources).filter(([, source]) => /\bpreload\s*:/u.test(source)).map(([name]) => name);
  if (givers.length === 1 && givers[0] === 'shell.mjs') return [];
  return [`the bridge must be handed out in shell.mjs alone, found ${givers.length === 0 ? 'nowhere' : givers.join(', ')}`];
}

test('one bridge in the whole shell, handed out where the title bar is loaded（变异证明）', () => {
  const sources = Object.fromEntries(readdirSync(SOURCE).filter((name) => name.endsWith('.mjs')).map((name) => [name, read(join(SOURCE, name))]));
  assert.deepEqual(preloadGivers(sources), []);
  // It is handed to the window's own page — the title bar — and never spelled out for the content.
  assert.match(sources['shell.mjs'], /\{ preload: options\.titleBarPreload \}/u);
  assert.equal(/\bpreload\b/u.test(sources['window-chrome.mjs']), false);
  const elsewhere = { ...sources, 'navigation.mjs': `${sources['navigation.mjs']}\n// preload: 'x'` };
  assert.deepEqual(preloadGivers(elsewhere), ['the bridge must be handed out in shell.mjs alone, found navigation.mjs, shell.mjs']);
  const nowhere = { ...sources, 'shell.mjs': sources['shell.mjs'].replace(/\bpreload:/u, 'bridge:') };
  assert.deepEqual(preloadGivers(nowhere), ['the bridge must be handed out in shell.mjs alone, found nowhere']);
});
