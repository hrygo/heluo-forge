import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

const signedOut = { state: 'signed-out', canSignIn: true };
const ready = { state: 'ready', gatewayCredential: { state: 'unconfigured' } };
const nodes = (node) => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(nodes)] : [];

async function onboarding(t, { save, loginView = ready } = {}) {
  const writes = [];
  const panel = await mountPanel(async (path, init) => {
    if (path === '/api/forge-iam/view') return Response.json(signedOut);
    if (path === '/api/forge-iam/sign-in') return Response.json({ view: loginView });
    if (path === '/api/forge-iam/credential') {
      writes.push(JSON.parse(init.body));
      if (save) return save();
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
  assert.match(panel.text(panel.render()), /添加模型访问凭证/);
  return { panel, button, writes };
}

test('onboarding displays required credential feedback before any input', async (t) => {
  const { panel, button, writes } = await onboarding(t);
  await button('保存并继续').props.onClick();
  assert.match(panel.text(panel.render()), /请输入模型访问凭证/);
  assert.equal(writes.length, 0);
});

for (const [gatewayState, notice] of [
  ['unknown', /无法确认凭证是否已保存/],
  ['owner-mismatch', /凭证属于其他账号/],
  ['invalid', /凭证信息需要检查/],
]) {
  test(`skipping preserves an honest ${gatewayState} credential state`, async (t) => {
    const { panel, button, writes } = await onboarding(t, {
      loginView: { ...ready, gatewayCredential: { state: gatewayState } },
    });
    button('稍后配置').props.onClick();
    const text = panel.text(panel.render());
    assert.match(text, notice);
    assert.doesNotMatch(text, /尚未保存|个人凭证已保存/);
    assert.equal(writes.length, 0);
  });
}

test('skipping the credential explains the remaining step and where to return', async (t) => {
  const { panel, button, writes } = await onboarding(t);
  button('稍后配置').props.onClick();
  const text = panel.text(panel.render());
  assert.match(text, /登录完成，尚未配置凭据/);
  assert.match(text, /模型暂不可用/);
  assert.match(text, /模型访问凭证尚未保存/);
  assert.match(text, /设置 → 企业账号/);
  assert.equal(writes.length, 0);
});

test('onboarding saves a credential without an optional device label', async (t) => {
  const { panel, button, writes } = await onboarding(t);
  const input = nodes(panel.render()).find((node) => node.props['aria-label'] === '模型访问凭证');
  input.props.onChange({ target: { value: 'uag-00000000000000000000000000000000' } });
  await button('保存并继续').props.onClick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].deviceLabel, '');
  assert.match(panel.text(panel.render()), /准备就绪/);
  assert.match(panel.text(panel.render()), /模型访问凭证已保存/);
  assert.doesNotMatch(panel.text(panel.render()), /uag-00000000000000000000000000000000/);
});

test('a pending credential save cannot be repeated or skipped', async (t) => {
  const pending = Promise.withResolvers();
  const { panel, button, writes } = await onboarding(t, { save: () => pending.promise });
  t.after(() => pending.resolve(Response.json({ view: ready })));
  const input = nodes(panel.render()).find((node) => node.props['aria-label'] === '模型访问凭证');
  input.props.onChange({ target: { value: 'uag-00000000000000000000000000000000' } });
  const originalSave = button('保存并继续');
  const originalSkip = button('稍后配置');
  const saving = originalSave.props.onClick();
  const duplicate = originalSave.props.onClick();
  originalSkip.props.onClick();
  assert.equal(writes.length, 1);
  assert.equal(button('正在保存…').props.disabled, true);
  assert.equal(button('稍后配置').props.disabled, true);
  assert.match(panel.text(panel.render()), /添加模型访问凭证/);
  pending.resolve(Response.json({ view: { ...ready, gatewayCredential: { state: 'configured' } } }));
  await Promise.all([saving, duplicate]);
  assert.match(panel.text(panel.render()), /准备就绪/);
});

test('onboarding clears stale authorization link on timeout and returns from step 2 to step 1 on session loss', async (t) => {
  let polledView = { state: 'signed-out', canSignIn: true };
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(polledView);
    if (path === '/api/forge-iam/sign-in') {
      return Response.json({
        view: { state: 'authenticating', canSignIn: false },
        authorizationUrl: 'https://idp.corp.example/authorize?state=1',
      });
    }
    throw new Error(`unexpected request: ${path}`);
  }, { componentId: 'forge-iam-onboarding' });
  t.after(() => panel.close());
  const button = (name) => panel.findButton(panel.render(), name);
  button('开始').props.onClick();
  await button('登录').props.onClick();
  assert.match(panel.text(panel.render()), /点此继续登录/);

  polledView = { state: 'error', error: 'IAM_ATTEMPT_EXPIRED', canSignIn: true };
  await panel.tick();
  assert.doesNotMatch(panel.text(panel.render()), /点此继续登录/);

  polledView = ready;
  await panel.tick();
  assert.match(panel.text(panel.render()), /添加模型访问凭证/);

  polledView = { state: 'signed-out', canSignIn: true };
  await panel.tick();
  assert.match(panel.text(panel.render()), /登录企业账号/);
  assert.match(panel.text(panel.render()), /登录状态已变化，请重新登录企业账号/);
});
