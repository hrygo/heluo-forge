import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

const signedOut = { state: 'signed-out', canSignIn: true };
const ready = { state: 'ready', gatewayCredential: { state: 'unconfigured' } };
const nodes = (node) => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : [];

async function onboarding(t) {
  const writes = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(signedOut);
    if (path === '/api/forge-iam/sign-in') return Response.json({ view: ready });
    if (path === '/api/forge-iam/credential') {
      writes.push(JSON.parse(init.body));
      return Response.json({ view: { ...ready, gatewayCredential: { state: 'configured' } } });
    }
    throw new Error(`unexpected request: ${path}`);
  }, { componentId: 'forge-iam-onboarding' });
  t.after(() => panel.close());
  const button = (name) => {
    const result = panel.findButton(panel.render(), name);
    assert.ok(result, `missing ${name}`);
    return result;
  };
  button('开始').props.onClick();
  await button('登录').props.onClick();
  assert.match(panel.text(panel.render()), /配置模型网关凭据/);
  return { panel, button, writes };
}

test('onboarding displays required credential feedback before any input', async (t) => {
  const { panel, button, writes } = await onboarding(t);
  await button('保存并继续').props.onClick();
  assert.match(panel.text(panel.render()), /请输入 UAG 个人凭证/);
  assert.equal(writes.length, 0);
});

test('onboarding saves a credential without an optional device label', async (t) => {
  const { panel, button, writes } = await onboarding(t);
  const input = nodes(panel.render()).find((node) => node.props['aria-label'] === 'UAG 个人凭证');
  input.props.onChange({ target: { value: 'uag-00000000000000000000000000000000' } });
  await button('保存并继续').props.onClick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].deviceLabel, '');
  assert.match(panel.text(panel.render()), /准备就绪/);
});
