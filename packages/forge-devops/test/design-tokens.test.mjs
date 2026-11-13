import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadClient, mountReadiness } from './support/readiness-harness.mjs';

const _DIR = dirname(fileURLToPath(import.meta.url));
void _DIR;

function captureInjectedCss() {
  const tags = [];
  const prevDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    head: { appendChild: (el) => { tags.push(el); } },
    createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove: () => {} }),
  };
  try {
    loadClient();
    const sheet = tags.find((el) => el.dataset?.pluginCss === '@heluo/forge-devops/client.css');
    return sheet?.textContent ?? '';
  } finally {
    globalThis.document = prevDocument;
  }
}

function walkTree(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit);
    return;
  }
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkTree(child, visit);
  }
}

test('forge-devops CSS adopts IAM card/button/input/state tokens without legacy static colors', () => {
  const css = captureInjectedCss();
  assert.ok(css.length > 0, 'ensureStyle should populate stylesheet content');

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
    assert.ok(css.includes(token), `expected IAM design token ${token} in forge-devops CSS`);
  }

  assert.doesNotMatch(
    css,
    /--dsw-static-|--dsw-alias-brand-primary|--dsw-alias-label-primary-inverted|rgba?\(/u,
    'legacy/static colors must not appear in forge-devops CSS',
  );
});

test('ReadinessSection renders card surface, icon avatar, and bordered secondary action buttons', async () => {
  const ok = (body) => ({ ok: true, status: 200, body });
  const mounted = await mountReadiness({
    props: { embedded: true, navigate: () => {} },
    responses: [
      ok({ state: 'signed-in', gatewayCredential: { state: 'configured', matchesAccount: true }, modelAccess: { state: 'ready' } }),
      ok({ revision: 'rev-1', ready: true, entries: {}, layers: { inherited: [], override: [], missing: [] } }),
      ok({ revision: 'rev-1', ready: true, entries: {} }),
    ],
  });
  try {
    const classes = new Set();
    const buttonClasses = [];
    walkTree(mounted.tree(), (node) => {
      const cls = String(node.props?.className ?? '');
      for (const name of cls.split(/\s+/u)) if (name) classes.add(name);
      if (node.type === 'button') buttonClasses.push(cls);
    });
    assert.ok(classes.has('fdv-surface'), 'ReadinessSection should render inside .fdv-surface card');
    assert.ok(classes.has('fdv-avatar'), 'ReadinessSection header should include .fdv-avatar');
    assert.ok(!classes.has('fdv-page-title'), 'embedded ReadinessSection should not duplicate page title');
    assert.ok(buttonClasses.length >= 2 && buttonClasses.every((c) => c.split(/\s+/u).includes('fdv-btn')), 'action buttons should use bordered .fdv-btn');
  } finally {
    mounted.unmount();
  }
});

test('DevopsSection renders IAM card surface header, avatar, bordered buttons, and dirty highlight', async () => {
  const frames = new Map();
  let dirty = false;
  let frameKey = 'root';
  const react = {
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
      return { ok: false, status: 404, json: async () => null };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        revision: 'rev-1',
        ready: true,
        writable: { ok: true },
        entries: {
          dopBin: { origin: 'discovered', path: '/usr/local/bin/dop', candidates: [] },
          timeoutMs: { origin: 'default', value: 20000 },
        },
      }),
    };
  };

  try {
    const { module, t } = loadClient({ react });
    const settle = async () => {
      let tree = null;
      for (let pass = 0; pass < 10; pass += 1) {
        dirty = false;
        tree = expand(renderFrame('root', () => module.DevopsSection({ t })), 'root');
        for (const frame of frames.values()) {
          for (const fn of frame.pending.splice(0)) fn();
        }
        await new Promise((r) => setImmediate(r));
        if (!dirty) break;
      }
      return expand(renderFrame('root', () => module.DevopsSection({ t })), 'root');
    };

    const tree = await settle();
    const classes = new Set();
    let takeOverBtn = null;
    walkTree(tree, (node) => {
      const cls = String(node.props?.className ?? '');
      for (const name of cls.split(/\s+/u)) if (name) classes.add(name);
      if (node.type === 'button' && cls.split(/\s+/u).includes('fdv-btn') && node.children?.includes(t('action.takeOver'))) {
        takeOverBtn = node;
      }
    });

    assert.ok(classes.has('fdv-surface'), 'DevopsSection should render .fdv-surface');
    assert.ok(classes.has('fdv-card-header'), 'DevopsSection should render .fdv-card-header');
    assert.ok(classes.has('fdv-avatar'), 'DevopsSection should render .fdv-avatar');
    assert.ok(takeOverBtn, 'TakeOver action should use bordered .fdv-btn');

    takeOverBtn.props.onClick();
    const dirtyTree = await settle();
    const dirtyClasses = new Set();
    walkTree(dirtyTree, (node) => {
      const cls = String(node.props?.className ?? '');
      for (const name of cls.split(/\s+/u)) if (name) dirtyClasses.add(name);
    });
    assert.ok(dirtyClasses.has('fdv-note-dirty'), 'unsaved edits should highlight receipt note with .fdv-note-dirty');
  } finally {
    globalThis.fetch = prevFetch;
  }
});
