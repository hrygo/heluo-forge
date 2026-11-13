import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountPanel } from './support/client-panel.mjs';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) {
    findAll(child, predicate, out);
  }
  return out;
}

function baseView({
  models = [],
  enabled = [],
  options = {},
  manualTruncated = 0,
  gatewayState = 'configured',
  sessionState = 'ready',
  signedIn = true,
} = {}) {
  return {
    state: sessionState,
    configured: true,
    signedIn,
    canSignOut: signedIn,
    subject: signedIn ? 'user-alice' : null,
    principal: signedIn ? 'alice' : null,
    gatewayCredential: {
      state: gatewayState,
      baseURL: 'https://gateway.corp.example/v1',
      deviceLabel: 'workstation-1',
    },
    modelAccess: {
      state: 'ready',
      configured: gatewayState === 'configured',
      stale: false,
      defaultModelId: enabled[0] ?? null,
      enabled,
      options,
      models,
      ...(manualTruncated > 0 ? { manualTruncated } : {}),
    },
  };
}

function findByAriaLabel(root, label) {
  return find(root, (node) => node.props?.['aria-label'] === label);
}

test('manual model UI supports adding into an empty catalog with trim, Enter submit, success notice and manual badge', async (t) => {
  const requests = [];
  let currentView = baseView({ models: [] });

  const panel = await mountPanel(async (path, init) => {
    requests.push({ path, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
    if (path === '/api/forge-iam/models/manual') {
      const payload = JSON.parse(init.body);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['x-forge-iam-request'], '1');
      assert.deepEqual(payload, { action: 'add', id: 'deepseek-chat' });
      currentView = baseView({
        models: [
          { id: 'deepseek-chat', displayName: 'deepseek-chat', source: 'manual', capabilities: { text: true, image: false } },
        ],
      });
      return Response.json({
        ok: true,
        persisted: true,
        removed: false,
        defaultModelId: null,
        enabled: [],
        manual: [{ id: 'deepseek-chat' }],
        models: currentView.modelAccess.models,
        view: currentView,
      });
    }
    return Response.json(currentView);
  }, { componentId: 'forge-models' });
  t.after(() => panel.close());

  const addToggle = panel.findButton(panel.render(), '手动添加');
  assert.ok(addToggle);
  assert.equal(addToggle.props['aria-expanded'], false);
  addToggle.props.onClick();

  const openedTree = panel.render();
  assert.equal(panel.findButton(openedTree, '手动添加').props['aria-expanded'], true);
  assert.match(panel.text(openedTree), /模型 ID 长度不超过 200，不限字符集；能否调用以企业网关权限为准/);

  const idInput = findByAriaLabel(openedTree, '模型 ID');
  assert.ok(idInput);
  idInput.props.onInput({ target: { value: '  deepseek-chat  ' } });

  findByAriaLabel(panel.render(), '模型 ID').props.onKeyDown({
    key: 'Enter',
    preventDefault() {},
  });
  await new Promise((r) => setTimeout(r, 0));

  const postCalls = requests.filter((req) => req.path === '/api/forge-iam/models/manual');
  assert.equal(postCalls.length, 1);

  const afterTree = panel.render();
  assert.equal(findByAriaLabel(afterTree, '模型 ID'), undefined, '添加成功后应关闭手动表单');
  const renderedText = panel.text(afterTree);
  assert.match(renderedText, /已添加 deepseek-chat，可在列表中配置并启用。/);
  assert.match(renderedText, /deepseek-chat/);
  assert.match(renderedText, /手动/);
  assert.doesNotMatch(renderedText, /不随目录刷新移除/);
  assert.ok(find(afterTree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('fiam-model-item-manual')), '手动模型条目应有专属视觉标识类');
  assert.ok(find(afterTree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('fiam-badge-manual')), '手动徽标应使用专属样式');
  assert.ok(findByAriaLabel(afterTree, '删除手动模型 deepseek-chat'));

  const successNotice = find(afterTree, (node) =>
    node.props?.role === 'status' && typeof node.props?.className === 'string'
    && node.props.className.includes('fiam-notice-success')
    && panel.text(node).includes('已添加 deepseek-chat'));
  assert.ok(successNotice, '添加成功提示应使用 success 样式');
});

test('manual model form validates empty, >200 chars, and duplicate IDs locally without network calls, and Escape cancels', async (t) => {
  const manualPosts = [];
  const currentView = baseView({
    models: [
      { id: 'gateway-chat', displayName: 'gateway-chat', source: 'gateway', capabilities: { text: true, image: false } },
    ],
    enabled: ['gateway-chat'],
  });

  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/models/manual') manualPosts.push(init);
    return Response.json(currentView);
  }, { componentId: 'forge-models' });
  t.after(() => panel.close());

  panel.findButton(panel.render(), '手动添加').props.onClick();

  // 1. Empty / whitespace-only
  findByAriaLabel(panel.render(), '模型 ID').props.onChange({ target: { value: '   ' } });
  await panel.findButton(panel.render(), '确认添加').props.onClick();
  assert.equal(manualPosts.length, 0);
  assert.match(panel.text(panel.render()), /模型 ID 不能为空且长度不得超过 200 个字符/);

  // 2. Typing clears inline error; >200 chars triggers inline error
  findByAriaLabel(panel.render(), '模型 ID').props.onChange({ target: { value: 'a'.repeat(201) } });
  assert.doesNotMatch(panel.text(panel.render()), /模型 ID 不能为空且长度不得超过 200 个字符/);
  await panel.findButton(panel.render(), '确认添加').props.onClick();
  assert.equal(manualPosts.length, 0);
  assert.match(panel.text(panel.render()), /模型 ID 不能为空且长度不得超过 200 个字符/);

  // 3. Duplicate of existing catalog model
  findByAriaLabel(panel.render(), '模型 ID').props.onChange({ target: { value: 'gateway-chat' } });
  await panel.findButton(panel.render(), '确认添加').props.onClick();
  assert.equal(manualPosts.length, 0);
  assert.match(panel.text(panel.render()), /该模型已在当前目录中，请直接启用，无需重复添加/);

  // 4. Escape closes form & discards draft error/value
  findByAriaLabel(panel.render(), '模型 ID').props.onKeyDown({ key: 'Escape', preventDefault() {} });
  assert.equal(findByAriaLabel(panel.render(), '模型 ID'), undefined);

  panel.findButton(panel.render(), '手动添加').props.onClick();
  assert.equal(findByAriaLabel(panel.render(), '模型 ID').props.value, '');
});

test('server rejection keeps manual form open with user draft intact and renders mapped error notice', async (t) => {
  const currentView = baseView({ models: [] });
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/models/manual') {
      return Response.json({ error: { code: 'IAM_MANUAL_MODEL_LIMIT' } }, { status: 409 });
    }
    return Response.json(currentView);
  }, { componentId: 'forge-models' });
  t.after(() => panel.close());

  panel.findButton(panel.render(), '手动添加').props.onClick();
  findByAriaLabel(panel.render(), '模型 ID').props.onChange({ target: { value: 'vendor/model-101' } });
  await panel.findButton(panel.render(), '确认添加').props.onClick();

  const tree = panel.render();
  const input = findByAriaLabel(tree, '模型 ID');
  assert.ok(input, '服务端报错时必须保留手动表单展开');
  assert.equal(input.props.value, 'vendor/model-101', '服务端报错时必须保留用户输入草稿');
  assert.match(panel.text(tree), /手动添加的模型数量已达上限（最多 100 个）/);
});

test('rebuildError on manual add renders warn notice and unpersisted options notice also uses warn class', async (t) => {
  let currentView = baseView({
    models: [
      { id: 'gw-1', displayName: 'gw-1', source: 'gateway', capabilities: { text: true, image: false } },
    ],
  });

  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/models/manual') {
      currentView = baseView({
        models: [
          ...currentView.modelAccess.models,
          { id: 'custom-2', displayName: 'custom-2', source: 'manual', capabilities: { text: true, image: false } },
        ],
      });
      return Response.json({
        ok: true,
        persisted: true,
        rebuildError: 'ENTERPRISE_MODELS_UNAVAILABLE',
        view: currentView,
      });
    }
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      return Response.json({ ok: true, persisted: false, view: currentView });
    }
    return Response.json(currentView);
  }, { componentId: 'forge-models' });
  t.after(() => panel.close());

  panel.findButton(panel.render(), '手动添加').props.onClick();
  findByAriaLabel(panel.render(), '模型 ID').props.onChange({ target: { value: 'custom-2' } });
  await panel.findButton(panel.render(), '确认添加').props.onClick();

  let tree = panel.render();
  assert.match(panel.text(tree), /手动模型 custom-2 已保存，但模型路由暂不可用：企业模型暂不可用/);
  assert.ok(find(tree, (node) =>
    node.props?.role === 'status'
    && node.props?.className?.includes('fiam-notice-warn')
    && panel.text(node).includes('暂不可用')));

  await panel.findButton(tree, '保存模型配置').props.onClick();
  tree = panel.render();
  assert.ok(find(tree, (node) =>
    node.props?.role === 'status'
    && node.props?.className?.includes('fiam-notice-warn')
    && panel.text(node).includes('未能写入持久存储')));
});

test('delete button only appears on manual models, deletes cleanly without leaving stale unsaved flag, and reports idempotent no-op', async (t) => {
  const calls = [];
  let removedOnce = false;
  let currentView = baseView({
    models: [
      { id: 'gw-model', displayName: 'gw-model', source: 'gateway', capabilities: { text: true, image: false } },
      { id: 'manual-1', displayName: 'manual-1', source: 'manual', capabilities: { text: true, image: false } },
    ],
    enabled: ['gw-model', 'manual-1'],
    options: { 'gw-model': {}, 'manual-1': { maxTokens: 16000 } },
  });

  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/models/manual') {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      if (!removedOnce) {
        removedOnce = true;
        currentView = baseView({
          models: [
            { id: 'gw-model', displayName: 'gw-model', source: 'gateway', capabilities: { text: true, image: false } },
          ],
          enabled: ['gw-model'],
          options: { 'gw-model': {} },
        });
        return Response.json({ ok: true, persisted: true, removed: true, view: currentView });
      }
      return Response.json({ ok: true, persisted: false, removed: false, view: currentView });
    }
    return Response.json(currentView);
  }, { componentId: 'forge-models' });
  t.after(() => panel.close());

  const initialTree = panel.render();
  assert.equal(findByAriaLabel(initialTree, '删除手动模型 gw-model'), undefined, '网关模型禁止显示删除按钮');
  const deleteManualBtn = findByAriaLabel(initialTree, '删除手动模型 manual-1');
  assert.ok(deleteManualBtn);
  assert.equal(findAll(initialTree, (n) => n.type === 'button' && panel.text(n) === '删除').length, 1);

  // Expand manual-1 before deleting to verify expanded state cleanup
  findByAriaLabel(initialTree, '配置 manual-1').props.onClick();
  assert.ok(findByAriaLabel(panel.render(), '删除手动模型 manual-1'));

  await findByAriaLabel(panel.render(), '删除手动模型 manual-1').props.onClick();
  assert.deepEqual(calls, [{ action: 'remove', id: 'manual-1' }]);

  const afterTree = panel.render();
  assert.equal(findByAriaLabel(afterTree, '删除手动模型 manual-1'), undefined);
  assert.doesNotMatch(panel.text(afterTree), /待保存模型配置变更/);
  assert.match(panel.text(afterTree), /已删除手动模型 manual-1。/);
  assert.ok(find(afterTree, (node) =>
    node.props?.role === 'status'
    && node.props?.className?.includes('fiam-notice-success')
    && panel.text(node).includes('已删除手动模型 manual-1')));

  // Direct handler invocation for already-removed id renders idempotent warn notice
  await deleteManualBtn.props.onClick();
  assert.match(panel.text(panel.render()), /手动模型 manual-1 已不在列表中。/);
});

test('manualTruncated shows warning banner, enable-all includes manual items, and sign-out/unconfigured guards hold', async (t) => {
  let currentView = baseView({
    models: [
      { id: 'gw-1', displayName: 'gw-1', source: 'gateway', capabilities: { text: true, image: false } },
      { id: 'manual-1', displayName: 'manual-1', source: 'manual', capabilities: { text: true, image: false } },
    ],
    manualTruncated: 4,
  });
  let savedOptions = null;

  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      savedOptions = JSON.parse(init.body).options;
      return Response.json({ ok: true, persisted: true, view: currentView });
    }
    if (path === '/api/forge-iam/sign-out') {
      currentView = baseView({ models: [], gatewayState: 'unconfigured', sessionState: 'signed-out', signedIn: false });
      return Response.json({ ok: true, view: currentView });
    }
    return Response.json(currentView);
  }, { componentId: 'forge-models' });
  t.after(() => panel.close());

  const tree = panel.render();
  assert.match(panel.text(tree), /另有 4 个未加载（最多支持 100 个）/);

  const enableAllBtn = findByAriaLabel(tree, '全部默认启用');
  assert.match(enableAllBtn.props.title, /含手动条目/);
  await enableAllBtn.props.onClick();
  assert.deepEqual(Object.keys(savedOptions).sort(), ['gw-1', 'manual-1']);

  // Open manual form, type draft, then poll transitions to signed-out -> form closes and clears draft
  panel.findButton(panel.render(), '手动添加').props.onClick();
  findByAriaLabel(panel.render(), '模型 ID').props.onChange({ target: { value: 'draft-unsaved' } });
  currentView = baseView({ models: [], gatewayState: 'unconfigured', sessionState: 'signed-out', signedIn: false });
  await panel.tick();

  assert.equal(findByAriaLabel(panel.render(), '模型 ID'), undefined);
  assert.match(panel.text(panel.render()), /请先登录企业账号/);
});

test('in-flight manual add deduplicates double clicks, preserves save button text, and rejects stale post-signout responses', async (t) => {
  let resolveManual;
  let manualPostCount = 0;
  let currentView = baseView({
    models: [{ id: 'gw-1', displayName: 'gw-1', source: 'gateway', capabilities: { text: true, image: false } }],
  });

  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/models/manual') {
      manualPostCount += 1;
      return new Promise((resolve) => {
        resolveManual = resolve;
      });
    }
    if (path === '/api/forge-iam/sign-out') {
      currentView = baseView({ models: [], sessionState: 'signed-out', signedIn: false, gatewayState: 'unconfigured' });
      return Response.json({ ok: true, view: currentView });
    }
    return Response.json(currentView);
  }, { componentId: 'forge-models' });
  t.after(() => panel.close());

  panel.findButton(panel.render(), '手动添加').props.onClick();
  findByAriaLabel(panel.render(), '模型 ID').props.onChange({ target: { value: 'in-flight-model' } });

  const confirmBtn = panel.findButton(panel.render(), '确认添加');
  const firstPromise = confirmBtn.props.onClick();
  const secondPromise = confirmBtn.props.onClick();
  assert.equal(manualPostCount, 1, '同步连点确认添加必须只发送一次请求');

  const pendingTree = panel.render();
  assert.ok(panel.findButton(pendingTree, '正在添加…'));
  assert.equal(panel.findButton(pendingTree, '刷新模型列表').props.disabled, true);
  assert.equal(panel.findButton(pendingTree, '手动添加').props.disabled, true);
  assert.ok(panel.findButton(pendingTree, '保存模型配置'), '手动添加进行中不得把保存模型配置按钮改为正在保存');

  // Sign out transitions view via poll while request is still in-flight -> advances viewBarrier epoch
  currentView = baseView({ models: [], sessionState: 'signed-out', signedIn: false, gatewayState: 'unconfigured' });
  await panel.tick();

  resolveManual(Response.json({
    ok: true,
    persisted: true,
    view: baseView({ models: [{ id: 'in-flight-model', source: 'manual', capabilities: { text: true, image: false } }] }),
  }));
  await Promise.all([firstPromise, secondPromise]);

  const finalText = panel.text(panel.render());
  assert.doesNotMatch(finalText, /已添加 in-flight-model/);
  assert.doesNotMatch(finalText, /in-flight-model/);
});

test('forge-iam settings.section declares no heluo.iam.credential-item child slot and Panel does not invoke it', async (t) => {
  // 1. Verify ctx.slots.register metadata omits R&D credential child slot
  const registered = [];
  const noop = () => () => {};
  const ctx = {
    slots: {
      inject: (_slot, factory) => { factory(); return noop; },
      register: (meta, component) => { registered.push({ meta, component }); return noop; },
    },
  };
  let exportedPlugin;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  };
  const loader = {
    load(definition) {
      exportedPlugin = definition.factory((name) => (name === 'react' ? reactStub : undefined));
    },
  };
  const prevWindow = globalThis.window;
  const prevDoc = globalThis.document;
  const prevReact = globalThis.React;
  globalThis.window = {
    __ModuleLoader__: loader,
    React: reactStub,
    document: { head: { appendChild() {} }, getElementById: () => null, createElement: () => ({ style: {} }) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = globalThis.window.document;
  globalThis.React = reactStub;
  try {
    new Function(clientSource)();
    exportedPlugin.apply(ctx);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDoc;
    globalThis.React = prevReact;
  }

  const sectionMeta = registered.find((entry) => entry.meta.name === 'settings.section')?.meta;
  assert.ok(sectionMeta);
  assert.equal(sectionMeta.id, 'forge-iam');
  assert.equal(sectionMeta.order, -10);
  assert.equal(sectionMeta.children, undefined);

  // 2. Panel stays purely universal even if renderSlot prop is passed
  let slotCalled = false;
  const panel = await mountPanel(async () => Response.json(baseView()), {
    componentProps: {
      renderSlot: () => {
        slotCalled = true;
        return {
          type: 'div',
          props: { 'data-testid': 'unexpected-ext-credential' },
          children: ['扩展凭据测试项：不应出现'],
        };
      },
    },
  });
  t.after(() => panel.close());
  const tree = panel.render();
  assert.equal(slotCalled, false);
  assert.doesNotMatch(panel.text(tree), /DevOps|Gitee|扩展凭据|credential-item/);
});
