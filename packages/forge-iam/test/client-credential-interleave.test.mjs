import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

// PR #215 复审 P2：账号原本是 ready，用户开始保存凭据，轮询把会话切到 expired，
// 凭据卡被折叠卸载——之后保存失败的回执就落在看不见的地方。内存里的文案不算回执，
// 用户必须在不展开任何折叠的情况下看到它。
const ready = {
  state: 'ready', configured: true, signedIn: true, canSignIn: false, canSignOut: true,
  principal: 'synthetic-person', error: null, missing: [], exclusive: 'ok',
  gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
  modelAccess: { configured: true, state: 'ready', models: [{ id: 'corp-chat', name: 'corp-chat' }] },
};
const expired = { ...ready, state: 'expired', signedIn: false, canSignIn: true, canSignOut: false, principal: null };

const walk = (node) => (node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(walk)] : []);
const flat = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(flat).join(''));
// 读者在不展开折叠时看得到的文本（闭合的 <details> 不算）。
const unfolded = (node) => {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'details') return '';
  return (node.children ?? []).map(unfolded).join('');
};

test('保存凭据途中会话过期：失败回执仍留在可见区，不需要展开「登录后可配置」', async (t) => {
  let resolvePut;
  let view = ready;
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(view);
    if (path === '/api/forge-iam/credential') {
      return new Promise((resolve) => {
        // 与路由同形：错误码在 `error.code` 里（resultCode 只认这个位置）。
        resolvePut = () => resolve(Response.json({ error: { code: 'IAM_GATEWAY_ATOMIC_UNVERIFIED' } }, { status: 503 }));
      });
    }
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());

  const input = () => walk(panel.render()).find((node) => node.props['aria-label'] === '个人访问凭证');
  input().props.onChange({ target: { value: 'synthetic-ui-key' } });
  const saving = panel.findButton(panel.render(), '保存凭据').props.onClick();
  await new Promise(setImmediate);
  assert.ok(panel.findButton(panel.render(), '正在处理…'), '保存进行中时按钮应显示处理中');

  // 轮询把会话切成 expired：此时 personalVisible 为 false，卡片本来会被卸载。
  view = expired;
  await panel.findButton(panel.render(), '刷新').props.onClick();
  resolvePut();
  await saving;
  await new Promise(setImmediate);

  const seen = unfolded(panel.render());
  assert.match(seen, /暂时无法安全地保存或清除凭证，请联系管理员。/,
    '保存失败的回执必须在可见区；藏在折叠里等于没提示');
  assert.equal(panel.findButton(panel.render(), '登录后可配置'), undefined,
    '回执可见时不该再让用户去展开折叠');
});

test('回执看过之后仍可折叠：不把「操作进行中」当成永久展开', async (t) => {
  // 会话本来就是 expired，没有在途操作：个人区保持折叠，不因历史回执常开。
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/view') return Response.json(expired);
    throw new Error(`unexpected synthetic request: ${path}`);
  });
  t.after(() => panel.close());
  const tree = panel.render();
  assert.ok(panel.findButton(tree, '登录后可配置'), '没有在途操作时应保留折叠入口');
  assert.equal(panel.findButton(tree, '保存凭据'), undefined, '折叠时凭据卡不挂载');
});
