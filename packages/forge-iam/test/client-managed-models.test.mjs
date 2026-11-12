import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountPanel } from './support/client-panel.mjs';
import { buildThinkingLevelMap } from '../src/model-options.mjs';
import { MESSAGES } from '../src/managed-models.mjs';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

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
  input('网关地址').props.onChange({ target: { value: 'http://next-gateway.corp.example/v1' } });
  input('个人访问凭证').props.onChange({ target: { value: 'synthetic-ui-key' } });
  assert.equal(input('个人访问凭证').props.type, 'password');
  assert.match(panel.text(panel.render()), /有未保存的更改/);
  await panel.findButton(panel.render(), '保存凭据').props.onClick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].baseURL, 'http://next-gateway.corp.example/v1');
  assert.equal(writes[0].key, 'synthetic-ui-key');
  assert.equal(input('个人访问凭证').props.value, '');
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

  // Edit fields: text stays a draft, the modality checkbox commits at once and
  // carries the draft with it, so no separate save click is needed.
  input('显示名称 1').props.onChange({ target: { value: '企业定制模型' } });
  input('上下文窗口 1').props.onChange({ target: { value: '128K' } });
  input('最大输出 Token 1').props.onChange({ target: { value: '8K' } });
  await input('图片输入模态 1').props.onChange({ target: { checked: true } });

  assert.equal(modelWrites.length, 1);
  assert.deepEqual(modelWrites[0].options['corp-chat'], {
    name: '企业定制模型',
    contextWindow: '128K',
    maxTokens: '8K',
    inputModalities: ['text', 'image'],
  });
  assert.match(panel.text(panel.render()), /模型配置已自动保存并生效/);
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
  const gatewayIdx = fullText.indexOf('填写企业 AI 网关签发的个人访问凭证。');
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
  await byLabel('推理强度下界 1').props.onChange({ target: { value: 'xhigh' } });
  await byLabel('推理强度上界 1').props.onChange({ target: { value: 'xhigh' } });

  assert.equal(writes.length, 2);
  assert.deepEqual(writes.at(-1).options['corp-chat'].reasoningEfforts, { off: null, xhigh: 'xhigh' });
  // Undeclared levels stay unsupported, so the chip row reports this one level.
  assert.equal(buildThinkingLevelMap(writes.at(-1).options['corp-chat'].reasoningEfforts).medium, null);
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
  await lowerSelect().props.onChange({ target: { value: 'low' } });
  await upperSelect().props.onChange({ target: { value: 'xhigh' } });
  assert.match(panel.text(panel.render()), /当前生效：开放区间：Low → Medium → High → XHigh（共 4 档/);
  assert.match(panel.text(panel.render()), /深度推理 · Low~XHigh/);

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

test('model advanced section includes in-place save button and shows top unsaved changes banner', async t => {
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

  // Expand model
  await panel.findButton(panel.render(), '精细配置 ▼').props.onClick();

  // Initially no unsaved banner
  assert.doesNotMatch(panel.text(panel.render()), /模型配置有未保存的修改/);

  // Edit model name
  const input = label => nodes(panel.render()).find(node => node.props['aria-label'] === label);
  input('显示名称 1').props.onChange({ target: { value: '智能对话 4.0' } });

  // Unsaved banner is visible at top of model list
  assert.match(panel.text(panel.render()), /模型配置有未保存的修改/);
  assert.doesNotMatch(panel.text(panel.render()), /网关目录同步（共|企业模型已与网关目录保持同步/);
  // Capacity guidance remains visible once models are ready.
  assert.match(panel.text(panel.render()), /上下文长度和最大输出不要超过模型支持的上限/);

  // Save via in-place button in the expanded model panel
  const inPlaceSave = nodes(panel.render()).find(node =>
    node.type === 'button' && node.props['aria-label'] === '保存模型配置' && node.props.className?.includes('forge-iam-primary')
  );
  assert.ok(inPlaceSave);
  await inPlaceSave.props.onClick();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].options['corp-chat'].name, '智能对话 4.0');
  assert.match(panel.text(panel.render()), /模型精细化配置已保存并生效/);
});

test('model advanced section uses concise interactive help buttons and eliminates redundant static hint texts', async t => {
  const panel = await mountPanel(async path => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  // Expand model
  await panel.findButton(panel.render(), '精细配置 ▼').props.onClick();

  const rendered = panel.render();
  const allNodes = nodes(rendered);

  // Redundant long prose hints are eliminated from static surface
  const renderedText = panel.text(rendered);
  assert.doesNotMatch(renderedText, /留空时使用模型 ID/);
  assert.doesNotMatch(renderedText, /默认 200K，建议不高于模型内部上限/);
  assert.doesNotMatch(renderedText, /默认 64K，单次响应最大生成 Token/);
  assert.doesNotMatch(renderedText, /仅需指定推理强度下界与上界；若下界高于上界将自动对齐/);

  // Interactive help tips exist with popovers and accessible labels
  const helpButtons = allNodes.filter(node => node.type === 'button' && node.props.className === 'fiam-help-btn');
  assert.equal(helpButtons.length, 5);

  const popovers = allNodes.filter(node => node.props.className === 'fiam-help-popover');
  assert.equal(popovers.length, 5);
  assert.ok(popovers.some(p => p.children?.some(c => typeof c === 'string' && c.includes('模型原生 ID'))));
  assert.ok(popovers.some(p => p.children?.some(c => typeof c === 'string' && c.includes('最大上下文容量'))));
  assert.ok(popovers.some(p => p.children?.some(c => typeof c === 'string' && c.includes('深度思考档位'))));
});

test('model list row visually weakens secondary metadata and avoids heavy idle badges', async t => {
  const twoModels = { ...view, modelAccess: { ...view.modelAccess, models: [{ id: 'corp-chat' }, { id: 'corp-vision' }] } };
  const panel = await mountPanel(async path => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  const rendered = panel.render();
  const allNodes = nodes(rendered);

  // Enabled model shows a crisp green badge
  const successBadges = allNodes.filter(node => node.props.className?.includes('fiam-badge-success'));
  assert.ok(successBadges.length >= 1);

  // Secondary specs use clean text elements, not heavy idle badges
  const idleBadges = allNodes.filter(node => node.props.className === 'fiam-badge fiam-badge-idle');
  assert.equal(idleBadges.length, 0);

  // Initially neither is enabled in options, so both display unenabled meta status
  const metaStatus = allNodes.filter(node => node.props.className === 'fiam-model-meta-status');
  assert.equal(metaStatus.length, 2);
  assert.equal(metaStatus[0].children?.[0], '未启用');

  const metaSpecs = allNodes.filter(node => node.props.className === 'fiam-model-meta-spec');
  assert.equal(metaSpecs.length, 2);
});

test('journey bar reflects warning state on credential mismatch and search clear button resets query', async t => {
  const mismatchView = {
    ...view,
    gatewayCredential: { state: 'owner-mismatch', matchesAccount: false },
    modelAccess: {
      configured: true,
      state: 'ready',
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-vision', name: 'corp-vision' }],
    },
  };
  const panel = await mountPanel(async path => {
    if (path === '/api/forge-iam/view') return Response.json(mismatchView);
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  assert.match(panel.text(panel.render()), /需核对/);
  const searchInput = nodes(panel.render()).find(node => node.props['aria-label'] === '搜索模型');
  searchInput.props.onChange({ target: { value: 'vision' } });
  assert.doesNotMatch(panel.text(panel.render()), /corp-chat/);

  const clearBtn = nodes(panel.render()).find(node => node.props['aria-label'] === '清除搜索');
  assert.ok(clearBtn);
  clearBtn.props.onClick();
  assert.match(panel.text(panel.render()), /corp-chat/);
});
test('joint journey and state transitions update credential notice, journey bar, and draft reset across model discovery states', async t => {
  let polledView = {
    ...view,
    gatewayCredential: { state: 'unconfigured', baseURL: 'https://gateway.corp.example/v1' },
    modelAccess: { configured: true, baseURL: 'https://gateway.corp.example/v1', state: 'unconfigured', models: [] },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(polledView);
    if (path === '/api/forge-iam/credential' && init?.method === 'PUT') {
      polledView = {
        ...view,
        gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
        modelAccess: { configured: true, baseURL: 'https://gateway.corp.example/v1', state: 'loading', models: [] },
      };
      return Response.json({ view: polledView });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  const keyInput = nodes(panel.render()).find(node => node.props['aria-label'] === '个人访问凭证');
  keyInput.props.onChange({ target: { value: 'draft-key-value' } });
  const resetDraftBtn = panel.findButton(panel.render(), '重置输入');
  assert.ok(resetDraftBtn);
  resetDraftBtn.props.onClick();
  assert.equal(nodes(panel.render()).find(node => node.props['aria-label'] === '个人访问凭证').props.value, '');

  keyInput.props.onChange({ target: { value: 'uag-00000000000000000000000000000000' } });
  await panel.findButton(panel.render(), '保存凭据').props.onClick();
  assert.match(panel.text(panel.render()), /网关地址和个人访问凭证已保存，正在获取模型列表/);
  assert.match(panel.text(panel.render()), /同步中…/);

  polledView = {
    ...view,
    gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
    modelAccess: {
      configured: true,
      baseURL: 'https://gateway.corp.example/v1',
      state: 'ready',
      models: [{ id: 'corp-chat', name: 'corp-chat' }],
      modelOptions: { 'corp-chat': {} },
    },
  };
  await panel.tick();
  assert.match(panel.text(panel.render()), /网关地址和个人访问凭证已保存，模型目录已同步/);
  assert.match(panel.text(panel.render()), /已启用 1\/1/);
});

test('model list toolbar is sticky, eliminates redundant custom tab, and aligns row actions', async t => {
  const customView = {
    ...view,
    gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
    modelAccess: {
      configured: true,
      baseURL: 'https://gateway.corp.example/v1',
      state: 'ready',
      models: [
        { id: 'corp-chat', name: 'corp-chat' },
        { id: 'corp-coder', name: 'corp-coder' },
      ],
      modelOptions: {
        'corp-chat': { maxTokens: 32000 },
        'corp-coder': {},
      },
    },
  };
  const panel = await mountPanel(async () => Response.json(customView));
  t.after(() => panel.close());

  assert.match(clientSource, /\.fiam-model-toolbar\s*\{[^}]*position:\s*sticky/);
  assert.match(clientSource, /\.fiam-model-list\s*\{[^}]*min-height:\s*480px/);
  assert.match(clientSource, /\.fiam-model-item\.fiam-model-item-expanded\s*\{[^}]*margin-bottom:\s*14px/);
  assert.match(clientSource, /\.fiam-model-item\.fiam-model-item-expanded\s*\{[^}]*box-shadow:/);

  const renderedText = panel.text(panel.render());
  assert.match(renderedText, /全部 \(2\)/);
  assert.match(renderedText, /已启用 \(2\)/);
  assert.doesNotMatch(renderedText, /已个性化 \(/);

  const buttons = nodes(panel.render()).filter(n => n.type === 'button').map(n => panel.text(n));
  assert.ok(!buttons.includes('恢复默认'));

  const enabledChip = nodes(panel.render()).find(n => n.type === 'button' && panel.text(n).includes('已启用'));
  assert.ok(enabledChip);
  enabledChip.props.onClick();
  await panel.tick();
  assert.match(panel.text(panel.render()), /corp-chat/);
});

test('model list leverages cached models during background loading and eliminates all customized badges', async t => {
  const storage = {
    [`forge-iam.cached-models.v2:${view.principal}:${view.gatewayCredential.baseURL}`]:
      JSON.stringify([{ id: 'cached-deepseek', name: 'cached-deepseek' }]),
    // An ownerless v1 entry from an older build must not be adopted.
    'forge-iam.cached-models.v1': JSON.stringify([{ id: 'legacy-other-tenant', name: 'legacy-other-tenant' }]),
    'forge-iam.model-options.v1': JSON.stringify({ 'cached-deepseek': { maxTokens: 16000 } }),
  };
  const loadingView = {
    ...view,
    gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
    modelAccess: { configured: true, state: 'loading', models: [] },
  };
  const panel = await mountPanel(async () => Response.json(loadingView), { storage });
  t.after(() => panel.close());

  const renderedText = panel.text(panel.render());
  assert.doesNotMatch(renderedText, /正在获取模型列表…/);
  assert.match(renderedText, /cached-deepseek/);
  assert.doesNotMatch(renderedText, /legacy-other-tenant/);
  assert.doesNotMatch(renderedText, /已个性化/);
});


test('default reasoning range can be disabled and saved explicitly', async t => {
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
  const input = label => nodes(panel.render()).find(node => node.props['aria-label'] === label);
  assert.equal(input('推理强度下界 1').props.value, 'off');
  assert.equal(input('推理强度上界 1').props.value, 'high');
  await panel.findButton(panel.render(), '关闭推理').props.onClick();
  assert.equal(input('推理强度上界 1').props.value, 'off');
  await panel.findButton(panel.render(), '保存模型配置').props.onClick();
  assert.deepEqual(writes.at(-1).options['corp-chat'].reasoningEfforts, { off: 'off' });
});

test('a cached catalogue is scoped to one person and gateway', async t => {
  const key = person => `forge-iam.cached-models.v2:${person}:https://gateway.corp.example/v1`;
  const first = { ...view, principal: 'person-a', modelAccess: { configured: true, state: 'loading', models: [] } };
  const panel = await mountPanel(async () => Response.json(first), {
    storage: { [key('person-a')]: JSON.stringify([{ id: 'model-of-a' }]) },
  });
  t.after(() => panel.close());
  assert.match(panel.text(panel.render()), /model-of-a/);

  // The same browser signs in as another person: the old list must not survive.
  const second = { ...view, principal: 'person-b', modelAccess: { configured: true, state: 'loading', models: [] } };
  const panel2 = await mountPanel(async () => Response.json(second), {
    storage: {
      [key('person-a')]: JSON.stringify([{ id: 'model-of-a' }]),
      [key('person-b')]: JSON.stringify([{ id: 'model-of-b' }]),
    },
  });
  t.after(() => panel2.close());
  const text = panel2.text(panel2.render());
  assert.match(text, /model-of-b/);
  assert.doesNotMatch(text, /model-of-a/);
});

test('model-access errors say the same thing here as on the host turn surface', async t => {
  // Bilateral: every code the host can put on a model-access error must render the
  // same sentence in the panel, so the two surfaces cannot drift apart code by code.
  for (const code of Object.keys(MESSAGES)) {
    const failed = { ...view, modelAccess: { configured: true, state: 'error', error: code, models: [] } };
    const panel = await mountPanel(async path => {
      if (path === '/api/forge-iam/view') return Response.json(failed);
      if (path === '/api/forge-iam/models') return Response.json({ models: [], view: failed });
      throw new Error(`unexpected synthetic request: ${path}`);
    });
    t.after(() => panel.close());
    assert.ok(MESSAGES[code], `${code} must have a host message`);
    assert.ok(panel.text(panel.render()).includes(MESSAGES[code]), `${code} must repeat the host message in the panel`);
  }
});

test('a rejected request and an unsupported level are explained where they surface', async t => {
  for (const [code, text] of [
    ['ENTERPRISE_GATEWAY_REQUEST_REJECTED', /网关拒绝了本次请求/],
    ['ENTERPRISE_MODEL_REASONING_UNSUPPORTED', /推理档位不受支持/],
  ]) {
    const failed = { ...view, modelAccess: { configured: true, state: 'error', error: code, models: [] } };
    const panel = await mountPanel(async path => {
      if (path === '/api/forge-iam/view') return Response.json(failed);
      if (path === '/api/forge-iam/models') return Response.json({ models: [], view: failed });
      throw new Error(`unexpected synthetic request: ${path}`);
    });
    t.after(() => panel.close());
    assert.match(panel.text(panel.render()), text, `${code} must explain itself in the panel`);
  }
});

test('a stale catalogue is shown with its retry time instead of a blank panel', async t => {
  const requests = [];
  const stale = {
    ...view,
    modelAccess: {
      configured: true, state: 'error', error: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
      stale: true, retryAt: Date.now() + 15000,
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-coder', name: 'corp-coder' }],
    },
  };
  const panel = await mountPanel(async (path) => {
    requests.push(path);
    if (path === '/api/forge-iam/view') return Response.json(stale);
    if (path === '/api/forge-iam/models') return Response.json({ models: [{ id: 'corp-chat' }], view });
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  const text = panel.text(panel.render());
  assert.match(text, /已缓存 2 个模型/);
  assert.match(text, /目录未更新/);
  assert.match(text, /秒后自动重试/);
  assert.match(text, /corp-chat/);
  // The journey step and the card call it the same thing.
  assert.match(text, /目录待刷新/);
  // The reason is explained once, not twice.
  assert.equal(text.split('暂时无法连接企业模型').length - 1, 1);

  // In-notice retry button triggers models refresh immediately without scrolling to bottom
  const retryBtn = panel.findButton(panel.render(), '立即重试');
  assert.ok(retryBtn, 'stale notice must provide an immediate retry button');
  await retryBtn.props.onClick();
  assert.ok(requests.includes('/api/forge-iam/models'));

  // Sticky toolbar refresh button also triggers models refresh
  const toolbarRefreshBtn = panel.findButton(panel.render(), '刷新目录');
  assert.ok(toolbarRefreshBtn, 'toolbar must provide a quick refresh button');
  await toolbarRefreshBtn.props.onClick();
});

test('the row-level disable button stops an enabled model without expanding its panel', async t => {
  const writes = [];
  const twoModels = {
    ...view,
    modelAccess: {
      ...view.modelAccess,
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-coder', name: 'corp-coder' }],
      modelOptions: { 'corp-chat': {}, 'corp-coder': {} },
      defaultModelId: 'corp-coder',
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({
        ok: true, persisted: true,
        view: { ...twoModels, modelAccess: { ...twoModels.modelAccess, modelOptions: writes.at(-1).options } },
      });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await new Promise(setImmediate);

  // The action is reachable while every panel is collapsed: no "精细配置 ▼" click here.
  assert.match(panel.text(panel.render()), /精细配置 ▼/);
  const button = nodes(panel.render()).find(node => node.props['aria-label'] === '一键停用 corp-chat');
  assert.ok(button);
  assert.equal(button.props.disabled, false);
  await button.props.onClick();

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, { 'corp-coder': {} });
  assert.match(panel.text(panel.render()), /已停用 corp-chat/);
  assert.match(panel.text(panel.render()), /请自行选择其他已启用模型/);
  // The row flips to the disabled state, which is the only place the panel renders 一键启用.
  assert.match(panel.text(panel.render()), /一键启用/);
});

test('disabling a model tells the user to choose another without claiming an automatic switch', async t => {
  const writes = [];
  const twoModels = {
    ...view,
    modelAccess: {
      ...view.modelAccess,
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-coder', name: 'corp-coder' }],
      modelOptions: { 'corp-chat': {}, 'corp-coder': {} },
      defaultModelId: 'corp-chat',
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      // The catalogue's preferred model changes independently of the host choice.
      return Response.json({
        ok: true, persisted: true,
        view: {
          ...twoModels,
          modelAccess: { ...twoModels.modelAccess, modelOptions: writes.at(-1).options, defaultModelId: 'corp-coder' },
        },
      });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await new Promise(setImmediate);

  const button = nodes(panel.render()).find(node => node.props['aria-label'] === '一键停用 corp-chat');
  assert.match(button.props.title, /请自行选择其他已启用模型/);
  await button.props.onClick();

  assert.deepEqual(writes[0].options, { 'corp-coder': {} });
  assert.match(panel.text(panel.render()), /请自行选择其他已启用模型/);
  assert.doesNotMatch(panel.text(panel.render()), /默认模型已自动切换|默认可用/);
  assert.match(panel.text(panel.render()), /已启用/);
});

test('disabling the last enabled model submits an empty set and states the consequence', async t => {
  const writes = [];
  const oneModel = {
    ...view,
    modelAccess: {
      ...view.modelAccess,
      models: [{ id: 'corp-chat', name: 'corp-chat' }],
      modelOptions: { 'corp-chat': {} },
      defaultModelId: 'corp-chat',
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(oneModel);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({
        ok: true, persisted: true,
        view: { ...oneModel, modelAccess: { ...oneModel.modelAccess, modelOptions: {}, defaultModelId: null } },
      });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await new Promise(setImmediate);

  const lastButton = nodes(panel.render()).find(node => node.props['aria-label'] === '一键停用 corp-chat');
  assert.match(lastButton.props.title, /最后一个已启用模型/);
  await lastButton.props.onClick();

  assert.deepEqual(writes[0].options, {});
  assert.match(panel.text(panel.render()), /当前没有已启用模型，新对话将无法选择企业模型/);
  assert.match(panel.text(panel.render()), /未启用/);
});

test('the row-level disable saves unrelated unsaved edits in the same submission and says so', async t => {
  const writes = [];
  const twoModels = {
    ...view,
    modelAccess: {
      ...view.modelAccess,
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-coder', name: 'corp-coder' }],
      modelOptions: { 'corp-chat': {}, 'corp-coder': {} },
      defaultModelId: 'corp-coder',
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({
        ok: true, persisted: true,
        view: { ...twoModels, modelAccess: { ...twoModels.modelAccess, modelOptions: writes.at(-1).options } },
      });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await new Promise(setImmediate);

  // Leave an unrelated draft edit on another model, then disable from the row.
  await nodes(panel.render()).find(node => node.props['aria-label'] === '配置 corp-coder').props.onClick();
  const nameInput = () => nodes(panel.render()).find(node => node.props['aria-label'] === '显示名称 2');
  nameInput().props.onChange({ target: { value: '内部编码助手' } });
  assert.match(panel.text(panel.render()), /待保存模型配置变更/);

  await nodes(panel.render()).find(node => node.props['aria-label'] === '一键停用 corp-chat').props.onClick();

  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].options), ['corp-coder']);
  assert.equal(writes[0].options['corp-coder'].name, '内部编码助手');
  assert.match(panel.text(panel.render()), /已停用 corp-chat，其他未保存的修改一并生效/);
  assert.doesNotMatch(panel.text(panel.render()), /待保存模型配置变更/);
});

test('the row flips to the disabled state while the disable is still saving', async t => {
  const writes = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const twoModels = {
    ...view,
    modelAccess: {
      ...view.modelAccess,
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-coder', name: 'corp-coder' }],
      modelOptions: { 'corp-chat': {}, 'corp-coder': {} },
      defaultModelId: 'corp-coder',
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      await gate;
      return Response.json({
        ok: true, persisted: true,
        view: { ...twoModels, modelAccess: { ...twoModels.modelAccess, modelOptions: writes.at(-1).options } },
      });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await new Promise(setImmediate);

  void nodes(panel.render()).find(node => node.props['aria-label'] === '一键停用 corp-chat').props.onClick();
  await new Promise(setImmediate);
  // The row flips to the disabled state before the write settles, so the disable
  // action is not reachable again while the PUT is in flight.
  assert.equal(nodes(panel.render()).find(node => node.props['aria-label'] === '一键停用 corp-chat'), undefined);
  assert.match(panel.text(panel.render()), /未启用/);
  release();
  await new Promise(setImmediate);

  // One click, one write: a repeat cannot interleave a second submission.
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, { 'corp-coder': {} });
});

test('enabling and disabling in the panel saves at once, without a save click', async t => {
  const writes = [];
  const twoModels = {
    ...view,
    modelAccess: {
      ...view.modelAccess,
      models: [{ id: 'corp-chat', name: 'corp-chat' }, { id: 'corp-vision', name: 'corp-vision' }],
      modelOptions: { 'corp-chat': {} },
    },
  };
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(twoModels);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      return Response.json({ ok: true, persisted: true, view: twoModels });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await new Promise(setImmediate);
  const byLabel = name => nodes(panel.render()).find(node => node.props['aria-label'] === name);

  await byLabel('配置 corp-vision').props.onClick();
  await byLabel('启用 corp-vision').props.onClick();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, { 'corp-chat': {}, 'corp-vision': {} });
  assert.match(panel.text(panel.render()), /已启用 corp-vision/);

  await byLabel('停用 corp-vision').props.onClick();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].options, { 'corp-chat': {} });
  assert.match(panel.text(panel.render()), /已停用 corp-vision/);
});

test('a text field writes once on blur and stays quiet when the value did not change', async t => {
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
  const input = label => nodes(panel.render()).find(node => node.props['aria-label'] === label);

  input('显示名称 1').props.onChange({ target: { value: '智能对话' } });
  await new Promise(setImmediate);
  assert.equal(writes.length, 0, 'typing alone must not issue one request per keystroke');

  await input('显示名称 1').props.onBlur({ target: { value: '智能对话' } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options['corp-chat'].name, '智能对话');

  await input('显示名称 1').props.onBlur({ target: { value: '智能对话' } });
  assert.equal(writes.length, 1, 'blurring again without an edit must not write');
});

test('a change made while a save is in flight is queued and wins', async t => {
  const writes = [];
  const releases = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/models' && init?.method === 'PUT') {
      writes.push(JSON.parse(init.body));
      await new Promise(resolve => releases.push(resolve));
      return Response.json({ ok: true, persisted: true, view });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  await panel.findButton(panel.render(), '精细配置 ▼').props.onClick();
  const byLabel = name => nodes(panel.render()).find(node => node.props['aria-label'] === name);

  void byLabel('上下文预设 128K 1').props.onClick();
  await new Promise(setImmediate);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options['corp-chat'].contextWindow, '128K');

  // Second edit lands while the first PUT is still open: it must not be dropped
  // and it must not overtake the response that is already in flight.
  void byLabel('上下文预设 1M 1').props.onClick();
  await new Promise(setImmediate);
  assert.equal(writes.length, 1, 'one write at a time');

  releases[0]();
  await new Promise(setImmediate);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].options['corp-chat'].contextWindow, '1M');
  releases[1]();
  await new Promise(setImmediate);
  assert.match(panel.text(panel.render()), /模型配置已自动保存并生效/);
});
