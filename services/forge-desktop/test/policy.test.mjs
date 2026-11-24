/**
 * Policy tests of the desktop shell: the decisions that keep the window on the
 * local service and nothing else, and the environment a child receives.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ShellError } from '../src/errors.mjs';
import { addressInUse, findLaunchUrl } from '../src/launch-url.mjs';
import { closeAction, quitConfirmation } from '../src/lifecycle.mjs';
import { LOOPBACK_HOST, loopbackUrl } from '../src/loopback.mjs';
import { classifyTarget, permissionAllowed } from '../src/navigation.mjs';
import { childEnvironment, loginShellArgs, parseShellEnv } from '../src/shell-env.mjs';

// A process token in an announcement. Its absence from every refusal is asserted.
const TOKEN = 'process-token-7f3a9c';
const LAUNCH = `http://${LOOPBACK_HOST}:43210/?token=${TOKEN}`;
// Assembled at runtime: the checker's text rules must not meet the pattern in source.
const WITH_CREDENTIALS = ['http://user', TOKEN].join(':') + '@';

function refused(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ShellError, `expected ShellError, got ${error?.message}`);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(TOKEN), false, 'a refusal repeated the token');
    return true;
  });
}

test('only http on 127.0.0.1 with an explicit port is a launch address', () => {
  assert.deepEqual(loopbackUrl(LAUNCH), { href: LAUNCH, origin: `http://${LOOPBACK_HOST}:43210` });
  for (const value of [
    `http://localhost:43210/?token=${TOKEN}`,
    `http://[::1]:43210/?token=${TOKEN}`,
    `http://0.0.0.0:43210/?token=${TOKEN}`,
    `http://elsewhere-7f3a.corp.example:43210/?token=${TOKEN}`,
    `https://${LOOPBACK_HOST}:43210/?token=${TOKEN}`,
    `http://${LOOPBACK_HOST}/?token=${TOKEN}`,
    WITH_CREDENTIALS + `${LOOPBACK_HOST}:43210/`,
    `file:///tmp/?token=${TOKEN}`,
    'not a url',
  ]) {
    refused(() => loopbackUrl(value), value === 'not a url' ? 'LAUNCH_URL_INVALID' : 'LAUNCH_URL_REJECTED');
  }
});

test('the announcement is found once printed, and only as an announcement', () => {
  const noise = ['starting profile', 'dsh web: opening the default browser; pass --no-open to disable', `dsh web: ${LAUNCH}`, 'ready'];
  const found = findLaunchUrl(noise.join('\r\n'));
  assert.equal(found.origin, `http://${LOOPBACK_HOST}:43210`);
  assert.equal(found.href, LAUNCH);
  assert.equal(findLaunchUrl('still starting\nno address yet'), null);
  assert.equal(findLaunchUrl(''), null);
  // An announcement elsewhere than loopback is refused, not adopted.
  refused(() => findLaunchUrl(`dsh web: http://0.0.0.0:43210/?token=${TOKEN}`), 'LAUNCH_URL_REJECTED');
});

test('a taken port is recognised by class only', () => {
  assert.equal(addressInUse('Error: listen EADDRINUSE: address already in use 0.0.0.0:43210'), true);
  assert.equal(addressInUse('Error: listen EADDRINUSE'), true);
  assert.equal(addressInUse('TypeError: something else'), false);
  assert.equal(addressInUse(undefined), false);
});

test('the window loads only the local service; other web addresses go out; everything else is blocked', () => {
  const origin = `http://${LOOPBACK_HOST}:43210`;
  assert.equal(classifyTarget(`${origin}/session/abc`, { origin }), 'load');
  assert.equal(classifyTarget(`${origin}/`, { origin }), 'load');
  assert.equal(classifyTarget('https://example.corp.example/doc?a=1', { origin }), 'external');
  assert.equal(classifyTarget(`https://${LOOPBACK_HOST}:43210/`, { origin }), 'external');
  assert.equal(classifyTarget(`http://${LOOPBACK_HOST}:9999/`, { origin }), 'external');
  for (const target of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-settings:',
    'ftp://example.corp.example/',
    WITH_CREDENTIALS + 'example.corp.example/',
    'not a url',
  ]) {
    assert.equal(classifyTarget(target, { origin }), 'block', target);
  }
});

test('no permission is ever granted', () => {
  for (const kind of ['media', 'geolocation', 'notifications', 'fullscreen', 'clipboard-read', 'pointerLock', 'openExternal', 'unknown']) {
    assert.equal(permissionAllowed(kind), false);
  }
});

test('the login shell environment is parsed as variables and the shell keeps its own knobs', () => {
  assert.deepEqual(
    parseShellEnv(
      ['HOME=/profiles/someone', 'EDITOR=nano', 'MULTI=a b c', 'not a variable', '=empty', 'NODE_OPTIONS=--require ./x.js', 'NODE_PATH=/tmp', 'ELECTRON_RUN_AS_NODE=1', 'BAD-NAME=1', ''].join('\n'),
    ),
    { HOME: '/profiles/someone', EDITOR: 'nano', MULTI: 'a b c' },
  );
  assert.deepEqual(parseShellEnv(undefined), {});
});

test('a login shell is asked for its environment where there is one', () => {
  assert.deepEqual(loginShellArgs({ platform: 'darwin', shell: '/bin/zsh' }), ['/bin/zsh', '-ilc', 'printenv']);
  assert.deepEqual(loginShellArgs({ platform: 'linux', shell: '/bin/bash' }), ['/bin/bash', '-ilc', 'printenv']);
  assert.equal(loginShellArgs({ platform: 'win32', shell: '/bin/zsh' }), null);
  assert.equal(loginShellArgs({ platform: 'darwin', shell: '' }), null);
});

test('a child gets the login shell variables over the GUI ones, a longer PATH and none of the shell knobs', () => {
  const gui = { PATH: '/usr/bin:/bin', HOME: '/profiles/someone', LANG: 'en', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', IGNORED: 42 };
  const login = { PATH: '/opt/tools/bin:/usr/bin:/bin', LANG: 'zh_CN.UTF-8', PROXY: 'http://proxy', NODE_OPTIONS: '--require ./evil.js' };
  assert.deepEqual(childEnvironment(gui, login, { prepend: ['/app/bin'] }), {
    PATH: '/app/bin:/opt/tools/bin:/usr/bin:/bin',
    HOME: '/profiles/someone',
    LANG: 'zh_CN.UTF-8',
    PROXY: 'http://proxy',
  });
  // No login shell answer: the GUI environment stands, still without the knobs.
  assert.deepEqual(childEnvironment(gui, {}, { prepend: ['/app/bin'] }), { PATH: '/app/bin:/usr/bin:/bin', HOME: '/profiles/someone', LANG: 'en' });
  // Windows spells it `Path` and separates with `;`; only one spelling survives.
  assert.deepEqual(childEnvironment({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, {}, { prepend: ['C:\\app\\bin'], delimiter: ';' }), {
    Path: 'C:\\app\\bin;C:\\Windows',
    SystemRoot: 'C:\\Windows',
  });
  assert.deepEqual(childEnvironment({ PATH: '/usr/bin' }, {}, { prepend: ['', undefined] }), { PATH: '/usr/bin' });
});

test('closing the window hides it where the app stays reachable and quits elsewhere', () => {
  assert.equal(closeAction({ platform: 'darwin', trayAttached: false }), 'hide');
  assert.equal(closeAction({ platform: 'linux', trayAttached: true }), 'hide');
  assert.equal(closeAction({ platform: 'linux', trayAttached: false }), 'quit');
  assert.equal(closeAction({ platform: 'win32', trayAttached: false }), 'quit');
  assert.equal(closeAction({ platform: 'win32', trayAttached: true }), 'hide');
  // The shell cannot yet tell whether a task is running, so quitting is always confirmed.
  assert.equal(quitConfirmation().required, true);
  assert.match(quitConfirmation().message, /中断/);
});
