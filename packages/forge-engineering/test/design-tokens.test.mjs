import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

function loadContainer() {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  let loaded = null;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
  new Function('window', 'require', source)(
    { __ModuleLoader__: { load: (def) => { loaded = def; } } },
    () => react,
  );
  const mod = loaded.factory(() => react);
  let sectionComp = null;
  let registeredDict = null;
  mod.apply({
    locale: {
      register: (_ns, dict) => { registeredDict = dict; },
      bind: (ns) => (key) => registeredDict?.[ns === 'engineering' ? 'zh' : 'en']?.[key] ?? registeredDict?.zh?.[key] ?? key,
    },
    slots: {
      declare: () => {},
      register: (meta, comp) => {
        if (meta.name === 'settings.section') sectionComp = comp;
        return () => {};
      },
      inject: (_name, cb) => cb(),
    },
    effect: (fn) => fn(),
  });
  return { sectionComp, dict: registeredDict };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

function flattenText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  return Array.isArray(node.children) ? node.children.map(flattenText).join('') : '';
}

test('container section renders IAM-aligned style tokens and 3-step journey bar', () => {
  const { sectionComp, dict } = loadContainer();
  assert.ok(sectionComp, 'settings.section component should be registered');

  const tree = sectionComp({
    t: (key) => dict.zh[key] ?? key,
    renderSlot: (_name, _props, opts) => opts.fallback,
  });

  const styleNodes = [];
  const steps = [];
  let hasSlotWrapper = false;
  walk(tree, (node) => {
    if (node.type === 'style') styleNodes.push(flattenText(node));
    const cls = String(node.props?.className ?? '');
    if (cls.split(/\s+/u).includes('heluo-engineering-step')) steps.push(node);
    if (cls.split(/\s+/u).includes('heluo-engineering-slot')) hasSlotWrapper = true;
  });

  assert.equal(styleNodes.length, 1, 'EngineeringSection should emit its scoped <style> element');
  const css = styleNodes[0];

  for (const token of [
    '--dsw-alias-settings-card-fill',
    '--dsw-alias-settings-card-stroke',
    '--dsw-alias-border-l4',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-state-business-primary',
    '--dsw-radius-xl',
    '--dsw-radius-lg',
    '--dsw-font-m-18',
    '--dsw-font-s-14',
    '--dsw-font-xxs-12',
    'max-width:720px',
  ]) {
    assert.ok(css.includes(token), `expected IAM token or layout rule ${token} in forge-engineering CSS`);
  }

  assert.doesNotMatch(css, /--dsw-static-|--dsw-alias-brand-primary|#[0-9a-fA-F]{3,8}/u, 'no static or hex colors allowed');
  assert.equal(steps.length, 3, 'journey bar must present 3 steps');
  assert.ok(hasSlotWrapper, 'child slot should be wrapped in .heluo-engineering-slot');
});

test('user-facing zh/en container copy avoids exposing internal technical jargon', () => {
  const { dict } = loadContainer();
  const zhText = Object.values(dict.zh).join('\n');
  const enText = Object.values(dict.en).join('\n');
  assert.doesNotMatch(`${zhText}\n${enText}`, /\bDOP\b|\bCLI\b|技术详情|独立令牌/u);
});
