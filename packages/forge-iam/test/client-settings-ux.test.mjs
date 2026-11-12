import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

// DESIGN.md §4 (docs/teamflow/20261109-enterprise-settings-ux/DESIGN.md):
// one expanded step while signed out, a single highest-priority issue, one
// merged credential wording, the diagnostic copy behind 诊断, and one
// authorization disclaimer.
const ready = {
  state: 'ready', configured: true, signedIn: true, canSignIn: false, canSignOut: true,
  principal: 'synthetic-person', error: null, missing: [], exclusive: 'ok',
  gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
  modelAccess: { configured: true, state: 'ready', models: [{ id: 'corp-chat', name: 'corp-chat' }] },
};
const signedOut = {
  state: 'signed-out', configured: true, signedIn: false, canSignIn: true, canSignOut: false,
  principal: null, error: null, missing: [], exclusive: 'ok', gatewayCredential: { state: 'unknown' },
};

const walk = (node) => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(walk)] : [];
const flat = (node) => typeof node === 'string' ? node : (node?.children ?? []).map(flat).join('');
// Text a reader sees before opening any fold: a closed <details> hides its body.
const unfolded = (node) => {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'details') return '';
  return (node.children ?? []).map(unfolded).join('');
};
const detailsWithSummary = (tree, label) => walk(tree)
  .find((node) => node.type === 'details' && flat(node.children?.[0]) === label);

async function fixture(t, view, { navigator } = {}) {
  const requests = [];
  const writes = [];
  const panel = await mountPanel(async (path) => {
    requests.push(path);
    if (path === '/api/forge-iam/view') return Response.json(view);
    throw new Error(`unexpected synthetic request: ${path}`);
  }, { navigator: navigator ?? { clipboard: { writeText: async (text) => { writes.push(text); } } } });
  t.after(() => panel.close());
  return { panel, requests, writes };
}

test('signed out expands only the login step and folds the rest behind 登录后可配置', async (t) => {
  const { panel, requests } = await fixture(t, signedOut);
  let tree = panel.render();
  assert.ok(panel.findButton(tree, '登录企业账号'), 'the login step must stay expanded');
  assert.equal(panel.findButton(tree, '保存凭据'), undefined, 'the credential step must start folded');
  assert.doesNotMatch(panel.text(tree), /企业模型设置/, 'the model step must start folded');

  const current = walk(tree).filter((node) => node.props?.['aria-current'] === 'step');
  assert.equal(current.length, 1);
  assert.match(flat(current[0]), /^身份/);

  const toggle = panel.findButton(tree, '登录后可配置');
  assert.ok(toggle, 'missing the 登录后可配置 row');
  assert.equal(toggle.props['aria-expanded'], false);
  const before = requests.length;
  toggle.props.onClick();
  assert.equal(requests.length, before, 'expanding the fold must not issue a request');

  tree = panel.render();
  assert.ok(panel.findButton(tree, '保存凭据'), 'expanding must reveal the credential step');
  assert.match(panel.text(tree), /企业模型设置/, 'expanding must reveal the model step');
});

test('signed in expands all three steps and highlights the current one', async (t) => {
  const { panel } = await fixture(t, ready);
  const tree = panel.render();
  assert.equal(panel.findButton(tree, '登录后可配置'), undefined);
  assert.ok(panel.findButton(tree, '保存凭据'));
  assert.match(panel.text(tree), /企业模型设置/);

  const current = walk(tree).filter((node) => node.props?.['aria-current'] === 'step');
  assert.equal(current.length, 1);
  assert.match(flat(current[0]), /^模型/);
});

test('file-backed credentials do not expose storage implementation details', async (t) => {
  const { panel } = await fixture(t, { ...ready, gatewayCredential: { ...ready.gatewayCredential, storage: 'file' } });
  const tree = panel.render();
  const text = panel.text(tree);
  assert.doesNotMatch(text, /凭据保存在本地文件中，保护方式取决于当前配置。/);
  assert.doesNotMatch(text, /凭证未使用系统安全存储，请联系管理员。/);
});

test('other non-keychain storage still displays the security warning', async (t) => {
  const { panel } = await fixture(t, { ...ready, gatewayCredential: { ...ready.gatewayCredential, storage: 'memory' } });
  assert.match(panel.text(panel.render()), /凭证未使用系统安全存储，请联系管理员。/);
});

test('the issue list shows only the highest-priority issue and folds the rest', async (t) => {
  const broken = {
    ...signedOut, state: 'unconfigured', configured: false, canSignIn: false,
    missing: ['clientId'], exclusive: 'exclusive-violation', error: 'exclusive-violation',
  };
  const { panel } = await fixture(t, broken);
  const tree = panel.render();
  const seen = unfolded(tree);
  assert.match(seen, /登录设置有冲突，请联系管理员。/);
  assert.doesNotMatch(seen, /企业登录设置不完整，请联系管理员。/);
  assert.doesNotMatch(seen, /企业登录尚未设置，请联系管理员。/);

  const more = detailsWithSummary(tree, '查看全部问题');
  assert.ok(more, 'missing the 查看全部问题 fold');
  assert.notEqual(more.props.open, true);
  const folded = flat(more);
  assert.match(folded, /企业登录设置不完整，请联系管理员。/);
  assert.match(folded, /企业登录尚未设置，请联系管理员。/);
  assert.ok(folded.indexOf('企业登录设置不完整') < folded.indexOf('企业登录尚未设置'));

  const all = panel.text(tree);
  // The server repeats the conflict as view.error; the same condition must not
  // surface twice (generic 操作未完成 + the issue line above it).
  assert.doesNotMatch(all, /操作未完成/);
  for (const issue of ['登录设置有冲突，请联系管理员。', '企业登录设置不完整，请联系管理员。', '企业登录尚未设置，请联系管理员。']) {
    assert.equal(all.split(issue).length - 1, 1, `${issue} must appear once`);
  }
});

test('a single issue does not offer a fold', async (t) => {
  const { panel } = await fixture(t, { ...signedOut, state: 'unconfigured', configured: false, canSignIn: false });
  const tree = panel.render();
  assert.match(unfolded(tree), /企业登录尚未设置，请联系管理员。/);
  assert.equal(detailsWithSummary(tree, '查看全部问题'), undefined);
});

test('an unknown credential state is stated once as 凭据状态尚未确认', async (t) => {
  const { panel } = await fixture(t, { ...ready, gatewayCredential: { state: 'unknown' } });
  const text = panel.text(panel.render());
  assert.match(text, /个人访问凭证：凭据状态尚未确认/);
  assert.doesNotMatch(text, /状态未知/);
  assert.doesNotMatch(text, /网关凭据状态尚未确认，请刷新核实/);
  assert.equal(text.split('凭据状态尚未确认').length - 1, 1);
});

test('the model card no longer repeats the login button as a hint', async (t) => {
  const { panel } = await fixture(t, { ...ready, gatewayCredential: { state: 'unconfigured' } });
  const text = panel.text(panel.render());
  assert.doesNotMatch(text, /下一步：登录企业账号/);
  assert.match(text, /下一步：在上方保存当前账号的个人凭证。/);
});

test('复制问题信息 lives in a collapsed 诊断 fold and still copies', async (t) => {
  const { panel, writes, requests } = await fixture(t, ready);
  const tree = panel.render();
  const diagnostics = detailsWithSummary(tree, '诊断');
  assert.ok(diagnostics, 'missing the 诊断 fold');
  assert.notEqual(diagnostics.props.open, true);

  const buttons = walk(tree).filter((node) => node.type === 'button' && flat(node) === '复制问题信息');
  assert.equal(buttons.length, 1, 'the diagnostic copy must exist once');
  assert.ok(panel.findButton(diagnostics, '复制问题信息'), '复制问题信息 must be inside 诊断');

  const before = requests.length;
  await buttons[0].props.onClick();
  assert.equal(requests.length, before, 'copying must not issue a request');
  assert.equal(JSON.parse(writes[0]).format, 'forge-iam-diagnostic');

  const after = panel.render();
  assert.match(flat(detailsWithSummary(after, '诊断')), /问题信息已复制/);
});

test('the page keeps exactly one authorization disclaimer', async (t) => {
  const { panel } = await fixture(t, ready);
  const tree = panel.render();
  assert.equal(panel.text(tree).split('登录只建立身份，不代表已获得业务写权限。').length - 1, 1);
  assert.match(unfolded(tree), /登录只建立身份，不代表已获得业务写权限。/);
});

test('signed-out journey steps reveal their folded cards instead of silently doing nothing', async (t) => {
  const { panel, requests } = await fixture(t, signedOut);
  const step = (tree, label) => walk(tree).find((node) =>
    String(node.props?.className ?? '').includes('fiam-journey-step') && flat(node).includes(label));
  let tree = panel.render();

  const credential = step(tree, '凭据');
  assert.ok(credential, 'missing the 凭据 journey step');
  const before = requests.length;
  credential.props.onClick();
  assert.equal(requests.length, before, 'revealing a step must not issue a request');
  tree = panel.render();
  assert.ok(panel.findButton(tree, '保存凭据'), 'clicking 凭据 must reveal the credential card');
  assert.match(panel.text(tree), /企业模型设置/, 'clicking 凭据 must mount the model card too');
  assert.equal(panel.findButton(tree, '收起个人设置').props['aria-expanded'], true);

  // Once mounted, the identity step still points at its own card and must not
  // fold the personal cards back.
  const identity = step(tree, '身份');
  assert.ok(identity);
  identity.props.onClick();
  tree = panel.render();
  assert.ok(panel.findButton(tree, '保存凭据'));

  const second = await fixture(t, signedOut);
  let secondTree = second.panel.render();
  const model = step(secondTree, '模型');
  assert.ok(model, 'missing the 模型 journey step');
  model.props.onClick();
  secondTree = second.panel.render();
  assert.match(second.panel.text(secondTree), /企业模型设置/,
    'clicking 模型 must mount the model card instead of doing nothing');
  assert.ok(second.panel.findButton(secondTree, '保存凭据'));
});
