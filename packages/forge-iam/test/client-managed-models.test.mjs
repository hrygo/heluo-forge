import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

const view = { state: 'ready', canSignOut: true, principal: 'synthetic-person',
  gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
  modelAccess: { configured: true, state: 'ready', models: [{ id: 'corp-chat', name: 'corp-chat' }] } };
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
    if (path === '/api/forge-iam/models') return Response.json({ models: [{ id: 'new-chat' }],
      view: { ...view, modelAccess: { ...view.modelAccess, models: [{ id: 'new-chat', name: 'new-chat' }] } } });
    throw new Error('unexpected synthetic request');
  }); t.after(() => panel.close());
  await panel.findButton(panel.render(), '刷新模型列表').props.onClick();
  assert.deepEqual(requests, ['/api/forge-iam/view', '/api/forge-iam/models']);
  assert.match(panel.text(panel.render()), /new-chat/);
  assert.match(panel.text(panel.render()), /模型列表已更新，共 1 个模型/);
  assert.doesNotMatch(panel.text(panel.render()), /corp-chat/);
});
