import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';
import { buildThinkingLevelMap } from '../src/model-options.mjs';

const view = {
  state: 'ready', canSignOut: true, principal: 'synthetic-person',
  gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
  modelAccess: { configured: true, state: 'ready', models: [{ id: 'corp-chat', name: 'corp-chat' }] }
};
const nodes = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : [];

test('account form saves gateway URL and a masked Key together and clears the draft after success', async t => {
  const writes = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/credential') {
      writes.push(JSON.parse(init.body));
      return Response.json({ view: { ...view, gatewayCredential: { ...view.gatewayCredential, baseURL: writes.at(-1).baseURL } } });
    }
    throw new Error('unexpected synthetic request');
  }); t.after(() => panel.close());
  const input = label => nodes(panel.render()).find(node => node.props['aria-label'] === label);
  assert.equal(input('网关地址').props.value, view.gatewayCredential.baseURL);
  input('网关地址').props.onChange({ target: { value: 'https://next-gateway.corp.example/v1' } });
  input('UAG 个人凭证').props.onChange({ target: { value: 'synthetic-ui-key' } });
  assert.equal(input('UAG 个人凭证').props.type, 'password');
  assert.match(panel.text(panel.render()), /有未保存的更改/);
  await panel.findButton(panel.render(), '保存凭据').props.onClick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].baseURL, 'https://next-gateway.corp.example/v1');
  assert.equal(writes[0].key, 'synthetic-ui-key');
  assert.equal(input('UAG 个人凭证').props.value, '');
  assert.equal(input('网关地址').props.value, writes[0].baseURL);
  assert.match(panel.text(panel.render()), /已保存/);
  assert.doesNotMatch(panel.text(panel.render()), /有未保存的更改|synthetic-ui-key/);
});

test('refresh action uses only the Host model route and shows the returned catalogue', async t => {
  const requests = [];
  const panel = await mountPanel(async path => {
    requests.push(path);
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/models') return Response.json({
      models: [{ id: 'new-chat' }],
      view: { ...view, modelAccess: { ...view.modelAccess, models: [{ id: 'new-chat', name: 'new-chat' }] } }
    });
    throw new Error('unexpected synthetic request');
  }); t.after(() => panel.close());
  await panel.findButton(panel.render(), '刷新模型列表').props.onClick();
  assert.deepEqual(requests, ['/api/forge-iam/view', '/api/forge-iam/models']);
  assert.match(panel.text(panel.render()), /new-chat/);
  assert.match(panel.text(panel.render()), /模型列表已更新，共 1 个模型/);
  assert.doesNotMatch(panel.text(panel.render()), /corp-chat/);
});

test('fine-grained model options can be edited, expanded, and saved to the models endpoint', async t => {
  const modelWrites = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      modelWrites.push(JSON.parse(init.body));
      return Response.json({ ok: true, view });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  }); t.after(() => panel.close());

  // Expand model configuration
  const configBtn = panel.findButton(panel.render(), '精细配置 ▼');
  assert.ok(configBtn);
  await configBtn.props.onClick();

  // Find input fields
  const input = label => nodes(panel.render()).find(node => node.props['aria-label'] === label);
  assert.ok(input('显示名称 1'));
  assert.ok(input('上下文窗口 1'));
  assert.ok(input('最大输出 Token 1'));
  assert.ok(input('图片输入模态 1'));

  // Edit fields
  input('显示名称 1').props.onChange({ target: { value: '企业定制模型' } });
  input('上下文窗口 1').props.onChange({ target: { value: '128K' } });
  input('最大输出 Token 1').props.onChange({ target: { value: '8K' } });
  input('图片输入模态 1').props.onChange({ target: { checked: true } });

  // Save options
  const saveBtn = panel.findButton(panel.render(), '保存模型配置');
  assert.ok(saveBtn);
  await saveBtn.props.onClick();

  assert.equal(modelWrites.length, 1);
  assert.deepEqual(modelWrites[0].options['corp-chat'], {
    name: '企业定制模型',
    contextWindow: '128K',
    maxTokens: '8K',
    inputModalities: ['text', 'image'],
  });
  assert.match(panel.text(panel.render()), /模型精细化配置已保存并生效/);
});

test('panel orders account, credential, and model cards and supports sorting and searching models', async t => {
  const multiModelView = {
    ...view,
    modelAccess: {
      configured: true,
      state: 'ready',
      models: [
        { id: 'opencode-zen-2', name: 'opencode-zen-2' },
        { id: 'gpt-6-luna', name: 'gpt-6-luna' },
        { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash' },
      ],
    },
  };
  const panel = await mountPanel(async path => {
    if (path === '/api/forge-iam/view') return Response.json(multiModelView);
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  const fullText = panel.text(panel.render());
  // User journey section order: Account -> Gateway Credential -> Model Settings
  const accountIdx = fullText.indexOf('已绑定企业 OIDC 身份');
  const gatewayIdx = fullText.indexOf('配置用于大模型请求的 UAG 凭证');
  const modelsIdx = fullText.indexOf('企业模型设置');
  assert.ok(accountIdx >= 0 && accountIdx < gatewayIdx);
  assert.ok(gatewayIdx < modelsIdx);

  // Models are sorted alphabetically by ID
  const geminiIdx = fullText.indexOf('gemini-3.5-flash');
  const gptIdx = fullText.indexOf('gpt-6-luna');
  const opencodeIdx = fullText.indexOf('opencode-zen-2');
  assert.ok(geminiIdx < gptIdx && gptIdx < opencodeIdx);

  // Search filters visible models
  const searchInput = nodes(panel.render()).find(node => node.props['aria-label'] === '搜索模型');
  assert.ok(searchInput);
  searchInput.props.onChange({ target: { value: 'luna' } });
  const filteredText = panel.text(panel.render());
  assert.match(filteredText, /gpt-6-luna/);
  assert.doesNotMatch(filteredText, /gemini-3\.5-flash/);
});

for (const options of [{}, { 'corp-chat': {} }]) {
  test(`saved Host enabled set overrides stale browser choices: ${JSON.stringify(options)}`, async t => {
    const writes = [];
    const hostView = { ...view, modelAccess: { ...view.modelAccess, modelOptions: options } };
    const panel = await mountPanel(async (path, init) => {
      if (path === '/api/forge-iam/view') return Response.json(hostView);
      if (init?.method === 'PUT') { writes.push(JSON.parse(init.body)); return Response.json({ ok: true, view: hostView }); }
      throw new Error('unexpected synthetic request');
    }, { storage: { 'forge-iam.model-options.v1': JSON.stringify({ 'other-person-model': { contextWindow: '128K' } }) } });
    t.after(() => panel.close());
    await new Promise(setImmediate);
    assert.deepEqual(writes, []);
    assert.deepEqual(JSON.parse(panel.storage.get('forge-iam.model-options.v1')), options);
  });
}

test('Host runtime options win over a stale local cache and no write is issued', async t => {
  const writes = [];
  const hostView = {
    ...view,
    modelAccess: {
      configured: true,
      state: 'ready',
      models: [{ id: 'corp-chat', name: 'corp-chat' }],
      modelOptions: { 'corp-chat': { contextWindow: '256K' } },
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(hostView);
    if (init?.method === 'PUT') { writes.push(JSON.parse(init.body)); return Response.json({ ok: true, view: hostView }); }
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { storage: { 'forge-iam.model-options.v1': JSON.stringify({ 'corp-chat': { contextWindow: '128K' } }) } });
  t.after(() => panel.close());
  await new Promise(setImmediate);

  assert.deepEqual(writes, []);
  assert.match(panel.text(panel.render()), /256K/);
  assert.doesNotMatch(panel.text(panel.render()), /128K/);
  assert.deepEqual(JSON.parse(panel.storage.get('forge-iam.model-options.v1')), { 'corp-chat': { contextWindow: '256K' } });
});

test('one model can be pinned to a single reasoning level beyond the default ladder', async t => {
  const writes = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({ ok: true, view });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  await panel.findButton(panel.render(), '精细配置 ▼').props.onClick();
  const byLabel = name => nodes(panel.render()).find(node => node.props['aria-label'] === name);
  byLabel('推理强度下界 1').props.onChange({ target: { value: 'xhigh' } });
  byLabel('推理强度上界 1').props.onChange({ target: { value: 'xhigh' } });
  await panel.findButton(panel.render(), '保存模型配置').props.onClick();

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options['corp-chat'].reasoningEfforts, { off: null, xhigh: 'xhigh' });
  // Undeclared levels stay unsupported, so the chip row reports this one level.
  assert.equal(buildThinkingLevelMap(writes[0].options['corp-chat'].reasoningEfforts).medium, null);
});

test('a model that was never enabled is offered for enabling and saved as an empty override', async t => {
  const writes = [];
  const twoModels = { ...view, modelAccess: { ...view.modelAccess, models: [{ id: 'corp-chat' }, { id: 'corp-vision' }] } };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({ ok: true, persisted: true, view: twoModels });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  }); t.after(() => panel.close());
  assert.match(panel.text(panel.render()), /未启用/);
  // Enable/disable lives inside the expanded panel of each row.
  const expandable = nodes(panel.render()).filter(node => node.type === 'button'
    && String(node.children?.[0] ?? '').startsWith('精细配置'));
  assert.equal(expandable.length, 2);
  await expandable[1].props.onClick();
  const byLabel = name => nodes(panel.render()).find(node => node.props['aria-label'] === name);
  await byLabel('启用 corp-vision').props.onClick();
  assert.match(panel.text(panel.render()), /已启用 corp-vision/);
  await panel.findButton(panel.render(), '保存模型配置').props.onClick();
  assert.deepEqual(writes[0].options, { 'corp-vision': {} });
});

test('restoring defaults keeps a model enabled instead of silently disabling it', async t => {
  const writes = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({ ok: true, persisted: true, view });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  }); t.after(() => panel.close());
  await panel.findButton(panel.render(), '精细配置 ▼').props.onClick();
  const input = label => nodes(panel.render()).find(node => node.props['aria-label'] === label);
  input('上下文窗口 1').props.onChange({ target: { value: '128K' } });
  await panel.findButton(panel.render(), '保存模型配置').props.onClick();
  assert.deepEqual(writes.at(-1).options, { 'corp-chat': { contextWindow: '128K' } });

  await panel.findButton(panel.render(), '恢复默认参数').props.onClick();
  await panel.findButton(panel.render(), '保存模型配置').props.onClick();
  // Present with an empty override: enabled, nothing customised.
  assert.deepEqual(writes.at(-1).options, { 'corp-chat': {} });
  assert.doesNotMatch(panel.text(panel.render()), /不再出现在模型选择中/);
});

test('clearing a customised input field leaves the model enabled with an empty override', async t => {
  const writes = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({ ok: true, persisted: true, view });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  }); t.after(() => panel.close());
  await panel.findButton(panel.render(), '精细配置 ▼').props.onClick();
  const input = label => nodes(panel.render()).find(node => node.props['aria-label'] === label);
  input('显示名称 1').props.onChange({ target: { value: 'My Chat' } });
  input('显示名称 1').props.onChange({ target: { value: '' } });
  await panel.findButton(panel.render(), '保存模型配置').props.onClick();
  // Still enabled with empty object, not completely removed from options
  assert.deepEqual(writes.at(-1).options, { 'corp-chat': {} });
});

test('default context window displays 200K and one-click enable immediately activates and persists a model with default parameters', async t => {
  const writes = [];
  const twoModels = {
    ...view,
    modelAccess: {
      ...view.modelAccess,
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-coder', name: 'corp-coder' }],
      modelOptions: { 'corp-chat': {} },
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({
        ok: true, persisted: true, view: {
          ...twoModels,
          modelAccess: { ...twoModels.modelAccess, modelOptions: writes.at(-1).options },
        }
      });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await new Promise(setImmediate);

  // Default context window badge is 200K and maxTokens is 64K
  assert.match(panel.text(panel.render()), /200K · 输出 64K/);
  // User journey bar shows 3 steps with concise titles: 身份, 凭据, 模型
  assert.match(panel.text(panel.render()), /身份/);
  assert.match(panel.text(panel.render()), /凭据/);
  assert.match(panel.text(panel.render()), /模型/);
  assert.match(panel.text(panel.render()), /已认证/);
  assert.match(panel.text(panel.render()), /已就绪/);

  // One-click enable button on the row enables corp-coder with default parameters and persists immediately
  const byLabel = name => nodes(panel.render()).find(node => node.props['aria-label'] === name);
  const oneClickBtn = byLabel('一键启用 corp-coder');
  assert.ok(oneClickBtn);
  await oneClickBtn.props.onClick();

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, { 'corp-chat': {}, 'corp-coder': {} });
  assert.match(panel.text(panel.render()), /已采用默认参数启用 corp-coder 并生效/);
});

test('reasoning effort supports lower and upper bound selection and auto-aligns when lower > upper', async t => {
  const writes = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({ ok: true, persisted: true, view });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  await panel.findButton(panel.render(), '精细配置 ▼').props.onClick();
  const byLabel = name => nodes(panel.render()).find(node => node.props['aria-label'] === name);
  const lowerSelect = () => byLabel('推理强度下界 1');
  const upperSelect = () => byLabel('推理强度上界 1');
  assert.ok(lowerSelect());
  assert.ok(upperSelect());

  // Select lower bound = low, upper bound = xhigh
  lowerSelect().props.onChange({ target: { value: 'low' } });
  upperSelect().props.onChange({ target: { value: 'xhigh' } });
  assert.match(panel.text(panel.render()), /当前生效：开放区间：Low → Medium → High → XHigh（共 4 档/);
  assert.match(panel.text(panel.render()), /深度推理 · Low~XHigh/);

  await panel.findButton(panel.render(), '保存模型配置').props.onClick();
  assert.deepEqual(writes.at(-1).options['corp-chat'].reasoningEfforts, {
    off: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
  });
  const map = buildThinkingLevelMap(writes.at(-1).options['corp-chat'].reasoningEfforts);
  assert.equal(map.minimal, null);
  assert.equal(map.low, 'low');
  assert.equal(map.medium, 'medium');
  assert.equal(map.high, 'high');
  assert.equal(map.xhigh, 'xhigh');
  assert.equal(map.max, null);

  // Selecting a lower bound higher than current upper bound automatically raises upper bound (never anti-human)
  lowerSelect().props.onChange({ target: { value: 'max' } });
  assert.equal(upperSelect().props.value, 'max');
  assert.match(panel.text(panel.render()), /固定单档：Max/);
});
