import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('client declares settings.launcher injection and registration', () => {
  assert.match(clientSource, /ctx\.slots\.inject\(['"]settings\.launcher['"]/);
  assert.match(clientSource, /name:\s*['"]settings\.launcher['"]/);
  assert.match(clientSource, /id:\s*['"]forge-iam-launcher['"]/);
});

test('client contains IamLauncher component and shield icon renderer', () => {
  assert.match(clientSource, /function IamLauncher\(/);
  assert.match(clientSource, /fiam-launcher/);
  assert.match(clientSource, /IamShieldIcon/);
});

test('launcher renders composite status indicator for gateway and session', () => {
  assert.match(clientSource, /getLauncherStatus/);
  assert.match(clientSource, /fiam-launcher-menu/);
  assert.match(clientSource, /fiam-launcher-dot/);
});

test('launcher supports desensitized diagnostics and D1 sign-out', () => {
  assert.match(clientSource, /navigator\.clipboard\.writeText/);
  assert.match(clientSource, /postJson\(['"]\/api\/forge-iam\/sign-out['"]\)/);
});


test('launcher diagnostics exclude account identifiers, URLs and device labels', async t => {
  const { mountPanel } = await import('./support/client-panel.mjs');
  let copied;
  const view = { state: 'ready', configured: true, signedIn: true, subject: 'private-person', issuer: 'https://private.example',
    gatewayCredential: { state: 'configured', deviceLabel: 'private-device' } };
  const panel = await mountPanel(async () => Response.json(view), {
    componentId: 'forge-iam-launcher', componentProps: { wide: true },
    navigator: { clipboard: { writeText: async text => { copied = text; } } },
  });
  t.after(() => panel.close());
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; }
  };
  find(panel.render(), node => node.type === 'button' && node.props.className === 'fiam-launcher-btn').props.onClick({ stopPropagation() {} });
  const menu = find(panel.render(), node => node.type?.name === 'IamLauncherMenu');
  assert.ok(menu);
  await menu.props.onCopyDiagnostics();
  assert.doesNotMatch(copied, /private-person|private.example|private-device/);
  assert.equal(JSON.parse(copied).iamState, 'ready');
});

test('launcher displays principal in wide mode and distinguishes owner-mismatch and model counts', async t => {
  const { mountPanel } = await import('./support/client-panel.mjs');
  const view = {
    state: 'ready',
    configured: true,
    signedIn: true,
    principal: 'E90210',
    gatewayCredential: { state: 'owner-mismatch', deviceLabel: 'MacBook-Pro' },
    modelAccess: { state: 'ready', models: [{ id: 'corp-chat' }, { id: 'corp-coder' }] },
  };
  const panel = await mountPanel(async () => Response.json(view), {
    componentId: 'forge-iam-launcher',
    componentProps: { wide: true },
  });
  t.after(() => panel.close());
  const text = panel.text(panel.render());
  assert.match(text, /E90210/);
  assert.match(text, /凭据账号不匹配/);
});

test('launcher closes open menu and resets sign-out confirmation when session transitions away from ready', async t => {
  const { mountPanel } = await import('./support/client-panel.mjs');
  let currentView = {
    state: 'ready',
    configured: true,
    signedIn: true,
    principal: 'E90210',
    gatewayCredential: { state: 'configured' },
    modelAccess: { state: 'ready', models: [{ id: 'corp-chat' }] },
  };
  const panel = await mountPanel(async () => Response.json(currentView), {
    componentId: 'forge-iam-launcher',
    componentProps: { wide: true },
  });
  t.after(() => panel.close());
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; }
  };
  find(panel.render(), node => node.type === 'button' && node.props.className === 'fiam-launcher-btn').props.onClick({ stopPropagation() {} });
  let menu = find(panel.render(), node => node.type?.name === 'IamLauncherMenu');
  assert.ok(menu);
  await menu.props.onSignOut({ stopPropagation() {} });
  menu = find(panel.render(), node => node.type?.name === 'IamLauncherMenu');
  assert.equal(menu.props.confirmSignOut, true);

  currentView = { state: 'signed-out', configured: true, signedIn: false, gatewayCredential: { state: 'unconfigured' } };
  await panel.tick();
  assert.equal(find(panel.render(), node => node.type?.name === 'IamLauncherMenu'), undefined);
});

test('launcher eliminates distracting token refresh count and shows stable active status', async t => {
  const { mountPanel } = await import('./support/client-panel.mjs');
  const view = {
    state: 'ready',
    configured: true,
    signedIn: true,
    principal: 'E1001',
    accessExpiresAt: new Date(Date.now() + 120000).toISOString(),
    gatewayCredential: { state: 'configured', deviceLabel: 'MacBook-Pro' },
    modelAccess: { state: 'loading', models: [{ id: 'corp-chat' }] },
  };
  const panel = await mountPanel(async () => Response.json(view), {
    componentId: 'forge-iam-launcher',
    componentProps: { wide: true },
  });
  t.after(() => panel.close());
  const text = panel.text(panel.render());
  assert.match(text, /企业认证有效/);
  assert.doesNotMatch(text, /正在同步模型/);

  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; }
  };
  find(panel.render(), node => node.type === 'button' && node.props.className === 'fiam-launcher-btn').props.onClick({ stopPropagation() {} });
  const menu = find(panel.render(), node => node.type?.name === 'IamLauncherMenu');
  assert.ok(menu);
  const menuText = panel.text(menu.type(menu.props));

  assert.doesNotMatch(menuText, /登录会话/);
  assert.doesNotMatch(menuText, /分钟后刷新/);
  assert.match(menuText, /已同步 1 个模型/);
});

test('launcher names an unreachable sign-in and an empty-catalogue sync failure', async t => {
  const { mountPanel } = await import('./support/client-panel.mjs');
  const base = { configured: true, signedIn: true, principal: 'E1001', gatewayCredential: { state: 'configured' } };
  const unreachable = await mountPanel(async () => Response.json({ ...base, state: 'unreachable' }), {
    componentId: 'forge-iam-launcher', componentProps: { wide: true },
  });
  t.after(() => unreachable.close());
  assert.match(unreachable.text(unreachable.render()), /连接登录受阻/);

  const failing = await mountPanel(async () => Response.json({
    ...base, state: 'ready',
    modelAccess: { state: 'error', error: 'ENTERPRISE_GATEWAY_UNAVAILABLE', models: [] },
  }), { componentId: 'forge-iam-launcher', componentProps: { wide: true } });
  t.after(() => failing.close());
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; }
  };
  const text = failing.text(failing.render());
  assert.match(text, /模型同步异常/);
  find(failing.render(), node => node.type === 'button' && node.props.className === 'fiam-launcher-btn').props.onClick({ stopPropagation() {} });
  const menu = find(failing.render(), node => node.type?.name === 'IamLauncherMenu');
  assert.match(failing.text(menu.type(menu.props)), /同步异常/);
});

test('launcher sign-out clears the cached catalogue for that person', async t => {
  const { mountPanel } = await import('./support/client-panel.mjs');
  const key = 'forge-iam.cached-models.v2:E1001:https://gateway.corp.example/v1';
  const view = {
    state: 'ready', configured: true, signedIn: true, principal: 'E1001',
    gatewayCredential: { state: 'configured', matchesAccount: true, baseURL: 'https://gateway.corp.example/v1' },
    modelAccess: { configured: true, state: 'ready', models: [{ id: 'corp-chat' }] },
  };
  const panel = await mountPanel(async (path) => {
    if (path === '/api/forge-iam/sign-out') {
      return Response.json({ view: { state: 'signed-out', configured: true, signedIn: false } });
    }
    return Response.json(view);
  }, {
    storage: { [key]: JSON.stringify([{ id: 'corp-chat' }]) },
    componentId: 'forge-iam-launcher', componentProps: { wide: true },
  });
  t.after(() => panel.close());
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) { const found = find(child, predicate); if (found) return found; }
  };
  find(panel.render(), node => node.type === 'button' && node.props.className === 'fiam-launcher-btn').props.onClick({ stopPropagation() { } });
  let menu = find(panel.render(), node => node.type?.name === 'IamLauncherMenu');
  await menu.props.onSignOut({ stopPropagation() { } });
  menu = find(panel.render(), node => node.type?.name === 'IamLauncherMenu');
  await menu.props.onSignOut({ stopPropagation() { } });
  // The shortcut people actually use must leave no other identity's list behind.
  assert.equal(panel.storage.has(key), false);
});
