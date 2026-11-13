import assert from 'node:assert/strict';
import test from 'node:test';

import { readClientSource } from './support/client-source.mjs';

// The pre-opened login window is the only user-visible surface between the
// click and the identity provider. These guards keep it from becoming a blank
// page: it must show progress, bound the wait, and fall back to this tab when
// the popup navigation is refused.
const source = readClientSource();

test('the login popup renders a visible status page instead of staying blank', () => {
  assert.match(source, /LOGIN_PLACEHOLDER/);
  assert.match(source, /正在打开企业登录/);
  assert.match(source, /function writeLoginMessage\(popup, title, detail = ''\)/);
  assert.match(source, /没有收到企业登录地址/);
});

test('the sign-in request is bounded and reports a timeout', () => {
  assert.match(source, /const SIGN_IN_TIMEOUT_MS = 15000;/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /IAM_REQUEST_TIMEOUT/);
  // Count every sign-in call first, then how many of them pass the timeout. A new
  // unbounded call site must make this guard fail; counting only the bounded form
  // (and asserting a fixed total) would silently accept an added bare call.
  const calls = source.match(/postJson\(\s*'\/api\/forge-iam\/sign-in'/gu) ?? [];
  const bounded = source.match(/postJson\(\s*'\/api\/forge-iam\/sign-in',\s*\{\s*timeoutMs: SIGN_IN_TIMEOUT_MS,?\s*\}\)/gu) ?? [];
  assert.ok(calls.length > 0, 'the client must call the sign-in endpoint');
  assert.equal(bounded.length, calls.length, 'every sign-in call site must pass the timeout');
});

test('a popup that never leaves about:blank falls back to this tab', () => {
  assert.match(source, /popup\.location\.href === 'about:blank'/);
  assert.match(source, /window\.location\.assign\(url\)/);
  assert.match(source, /}, 1500\);/);
});
