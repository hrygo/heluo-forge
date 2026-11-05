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
