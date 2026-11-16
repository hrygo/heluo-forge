import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// C, client side: a session whose sliding refresh window lapsed is terminal, and
// the account page, the launcher and the banner must say so instead of leaving
// the failure to the next token request. These are source-shape assertions in the
// same style as client-structure.test.mjs: the copy is the interface here.

test('the client derives an unrenewable expiry from the Host view', () => {
  assert.match(clientSource, /renewable:\s*view\?\.renewal\s*!==\s*['"]unavailable['"]/);
  assert.match(clientSource, /expiredUnrenewable:\s*state\s*===\s*['"]expired['"]\s*&&\s*view\?\.renewal\s*===\s*['"]unavailable['"]/,
    'only an expired session whose renewal is gone may use the terminal copy');
});

test('the launcher distinguishes a lapsed session from a transient failure', () => {
  assert.match(clientSource, /if\s*\(ui\.expiredUnrenewable\)\s*\{[^}]*会话已过期/);
  assert.match(clientSource, /长时间未使用，会话已过期，请重新登录/);
});

test('the account page explains an unrenewable session and a closing window', () => {
  assert.match(clientSource, /长时间未使用，会话已过期且无法自动续期，请重新登录。/);
  assert.match(clientSource, /会话续期窗口即将结束/);
  assert.match(clientSource, /RENEWAL_WARNING_MS\s*=\s*300000/);
});

test('the account badge and banner do not report a plain expiry when renewal is gone', () => {
  assert.match(clientSource, /会话已过期，需重新登录/);
  assert.match(clientSource, /expiredUnrenewable:\s*['"]长时间未使用，会话已过期，请重新登录['"]/);
});

test('the account card renders the renewal notice it receives', () => {
  // A notice that is computed and passed but never placed in the tree is dead
  // code; count both the destructuring and the rendered child here, and rely on
  // client-renewal-render.test.mjs for the rendered result.
  const start = clientSource.indexOf('function renderAccountCard(');
  const end = clientSource.indexOf('function renderGatewayCard(');
  assert.ok(start > 0 && end > start, 'renderAccountCard must exist');
  const body = clientSource.slice(start, end);
  assert.ok((body.match(/renewalNotice/g) ?? []).length >= 2,
    'renewalNotice is received but never rendered');
});
