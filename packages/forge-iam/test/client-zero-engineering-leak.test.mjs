import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountPanel } from './support/client-panel.mjs';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const ENGINEERING_TOKENS = [
  'DEVOPS',
  'GITEE',
  'devops',
  'gitee',
  'heluo.engineering.tab',
  'forge-engineering',
  'forge-devops',
  'forge-gitee',
  '工作项',
  '代码仓',
  '流水线',
  '工作区自检',
];

const PROTOCOL_JARGON = [
  'OIDC',
  'Refresh Token',
  'Access Token',
  'ENTERPRISE_STATIC_KEY',
  'OWNER_MISMATCH',
];

const ready = {
  state: 'ready',
  configured: true,
  signedIn: true,
  canSignOut: true,
  principal: 'E1001',
  gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
  modelAccess: {
    configured: true,
    state: 'ready',
    models: [{ id: 'corp-chat', name: 'corp-chat' }],
  },
};

const signedOut = {
  state: 'signed-out',
  configured: true,
  signedIn: false,
  canSignIn: true,
  gatewayCredential: { state: 'unconfigured' },
  modelAccess: { configured: false, state: 'unconfigured', models: [] },
};

test('standalone @heluo/forge-iam registers two top-level settings sections (-10 and 10) plus icons with zero engineering references', async () => {
  const registered = [];
  const noop = () => () => {};
  const ctx = {
    slots: {
      inject: (_slot, factory) => { factory(); return noop; },
      register: (meta, component) => { registered.push({ meta, component }); return noop; },
    },
  };
  let plugin;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  };
  const prevWindow = globalThis.window;
  const prevDoc = globalThis.document;
  const prevReact = globalThis.React;
  globalThis.window = {
    __ModuleLoader__: {
      load(def) { plugin = def.factory((n) => (n === 'react' ? reactStub : undefined)); },
    },
    document: { head: { appendChild() {} }, getElementById: () => null, createElement: () => ({ style: {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = globalThis.window.document;
  globalThis.React = reactStub;
  try {
    new Function(clientSource)();
    plugin.apply(ctx);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDoc;
    globalThis.React = prevReact;
  }

  const sections = registered.filter((r) => r.meta.name === 'settings.section');
  assert.deepEqual(
    sections.map((s) => ({ id: s.meta.id, order: s.meta.order, label: s.meta.label() })),
    [
      { id: 'forge-iam', order: -10, label: '企业账号' },
      { id: 'forge-models', order: 10, label: '企业模型' },
    ],
  );
  const icons = registered.filter((r) => r.meta.name === 'settings.section.icon');
  assert.deepEqual(icons.map((i) => i.meta.id), ['forge-iam', 'forge-models']);
  for (const icon of icons) {
    const svg = icon.component({});
    assert.equal(svg.type, 'svg');
  }
  for (const token of ENGINEERING_TOKENS) {
    assert.equal(clientSource.includes(token), false, `generic client must not leak engineering term: ${token}`);
  }
});

test('rendered generic surfaces contain zero engineering leakage or protocol jargon across Panel, ModelsPanel and Onboarding', async (t) => {
  const iamPanel = await mountPanel(async () => Response.json(ready), { componentId: 'forge-iam' });
  const modelsPanel = await mountPanel(async () => Response.json(ready), { componentId: 'forge-models' });
  const onboarding = await mountPanel(async () => Response.json(signedOut), { componentId: 'forge-iam-onboarding' });
  t.after(async () => {
    await iamPanel.close();
    await modelsPanel.close();
    await onboarding.close();
  });

  const combinedText = [
    iamPanel.text(iamPanel.render()),
    modelsPanel.text(modelsPanel.render()),
    onboarding.text(onboarding.render()),
  ].join('\n');

  for (const token of [...ENGINEERING_TOKENS, ...PROTOCOL_JARGON]) {
    assert.equal(combinedText.includes(token), false, `generic UI text must not contain ${token}`);
  }
  assert.match(combinedText, /AI 服务 · 已就绪/);
  assert.match(combinedText, /步骤 1 \/ 3/);
  assert.match(combinedText, /默认企业模型/);
});

