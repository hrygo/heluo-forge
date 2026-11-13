import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

function captureGiteeClient(customReact) {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  let definition = null;
  const react = customReact ?? {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  new Function('window', 'require', source)(
    { __ModuleLoader__: { load: (def) => { definition = def; } } },
    () => react,
  );
  const mod = definition.factory(() => react);
  const tags = [];
  let dict = {};
  const registered = [];
  const prevDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    head: { appendChild: (el) => { tags.push(el); } },
    createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove: () => {} }),
  };
  try {
    mod.apply({
      locale: {
        register: (_ns, dicts) => { dict = dicts; },
        bind: () => (key) => dict.zh?.[key] ?? key,
      },
      slots: {
        inject: (_name, cb) => cb(),
        register: (meta, comp) => {
          registered.push({ meta, comp });
          return () => {};
        },
      },
      effect: (fn) => fn(),
    });
  } finally {
    globalThis.document = prevDocument;
  }
  const sheet = tags.find((el) => el.dataset?.pluginCss === '@heluo/forge-gitee/client.css');
  return { styleText: sheet?.textContent ?? '', mod, dict, registered };
}

test('forge-gitee CSS adopts IAM surface/button/input/state tokens without legacy tokens', () => {
  const { styleText } = captureGiteeClient();
  assert.ok(styleText.length > 0, 'ensureStyle should inject CSS');

  for (const token of [
    '--dsw-alias-settings-card-fill',
    '--dsw-alias-settings-card-stroke',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-border-l3',
    '--dsw-alias-border-l4',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-button-primary-hover',
    '--dsw-alias-button-floating-hover',
    '--dsw-alias-label-primary-foreground',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-radius-xl',
    '--dsw-radius-lg',
    '--dsw-radius-md',
    '--dsw-radius-xs',
  ]) {
    assert.ok(styleText.includes(token), `expected IAM design token ${token} in forge-gitee CSS`);
  }

  assert.doesNotMatch(
    styleText,
    /--dsw-static-|--dsw-alias-brand-primary|--dsw-alias-border-secondary|--dsw-alias-bg-primary|--dsw-alias-label-primary-inverted/u,
    'legacy tokens must not appear in forge-gitee CSS',
  );
});

test('GiteeSection renders card surface, avatar header, and unified footer bar in ready state', async () => {
  const frames = new Map();
  let dirty = false;
  let frameKey = 'root';
  const react = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const frame = frames.get(frameKey);
      const idx = frame.cursor++;
      if (!(idx in frame.cells)) frame.cells[idx] = typeof initial === 'function' ? initial() : initial;
      return [
        frame.cells[idx],
        (next) => {
          frame.cells[idx] = typeof next === 'function' ? next(frame.cells[idx]) : next;
          dirty = true;
        },
      ];
    },
    useRef(initial) {
      const frame = frames.get(frameKey);
      const idx = frame.cursor++;
      if (!(idx in frame.cells)) frame.cells[idx] = { current: initial };
      return frame.cells[idx];
    },
    useEffect(fn) {
      const frame = frames.get(frameKey);
      const idx = frame.cursor++;
      if (!frame.effects.has(idx)) {
        frame.effects.add(idx);
        frame.pending.push(fn);
      }
    },
    useCallback: (fn) => fn,
  };

  const renderFrame = (key, fn) => {
    const prev = frameKey;
    frameKey = key;
    let frame = frames.get(key);
    if (!frame) {
      frame = { cursor: 0, cells: [], effects: new Set(), pending: [] };
      frames.set(key, frame);
    }
    frame.cursor = 0;
    try {
      return fn();
    } finally {
      frameKey = prev;
    }
  };

  const expand = (node, key = 'root') => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((c, idx) => expand(c, `${key}[${idx}]`));
    if (typeof node.type === 'function') {
      const childKey = `${key}/${node.type.name || 'fn'}`;
      return expand(renderFrame(childKey, () => node.type(node.props ?? {})), childKey);
    }
    return {
      ...node,
      children: Array.isArray(node.children) ? node.children.map((c, idx) => expand(c, `${key}.${idx}`)) : [],
    };
  };

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/forge-iam/ext-credentials')) {
      return { ok: true, status: 200, json: async () => ({ credentials: [{ extensionId: 'gitee', state: 'UNSET_NO_HOSTED', envHitNames: [] }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        revision: 'rev-1',
        writable: { ok: true },
        entries: { cliPath: { origin: 'inherited', value: 'gitee' }, timeoutMs: { origin: 'default', value: 20000 } },
      }),
    };
  };

  try {
    const { mod, dict } = captureGiteeClient(react);
    let tree = null;
    for (let pass = 0; pass < 10; pass += 1) {
      dirty = false;
      tree = expand(renderFrame('root', () => mod.GiteeSection({ t: (key) => dict.zh[key] ?? key })), 'root');
      for (const frame of frames.values()) {
        for (const fn of frame.pending.splice(0)) fn();
      }
      await new Promise((r) => setImmediate(r));
      if (!dirty) break;
    }
    tree = expand(renderFrame('root', () => mod.GiteeSection({ t: (key) => dict.zh[key] ?? key })), 'root');

    const classes = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const c of node) walk(c);
        return;
      }
      const cls = String(node.props?.className ?? '');
      for (const name of cls.split(/\s+/u)) if (name) classes.add(name);
      if (Array.isArray(node.children)) for (const c of node.children) walk(c);
    };
    walk(tree);

    assert.ok(classes.has('fge-root'));
    assert.ok(classes.has('fge-surface'), 'GiteeSection should render .fge-surface');
    assert.ok(classes.has('fge-card-header'), 'GiteeSection should render .fge-card-header');
    assert.ok(classes.has('fge-avatar'), 'GiteeSection should render .fge-avatar');
    assert.ok(classes.has('fge-footer-bar'), 'GiteeSection ready view should render .fge-footer-bar');
    assert.ok(classes.has('fge-btn'), 'GiteeSection action buttons should use bordered .fge-btn');
    assert.ok(classes.has('fge-primary'), 'GiteeSection save button should use .fge-primary');
    assert.ok(classes.has('fge-cred'), 'GiteeSection should include .fge-cred card');
  } finally {
    globalThis.fetch = prevFetch;
  }
});
