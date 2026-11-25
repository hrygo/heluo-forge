/**
 * Assembly tests of the desktop shell: the wiring in `shell.mjs`, driven
 * through a stand-in for the Electron interface. Each case starts a whole shell
 * world (package, marker, installer, web profile) and looks at what reached
 * the interface: windows, dialogs, killed processes, opened addresses.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ShellError } from '../src/errors.mjs';
import { EMPLOYEE_PACKAGE_SCHEMA } from '../src/first-run.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { guidanceFor, startShell } from '../src/shell.mjs';

const TOKEN = 'process-token-7f3a9c';
const ORIGIN = 'http://127.0.0.1:43210';
const LAUNCH = `${ORIGIN}/?token=${TOKEN}`;
const TARBALL = 'enterprise-plugin/heluo-forge-enterprise-1.2.3-corp.1.tgz';
const SECRET = 'enterprise-plugin/iam-client-secret.txt';
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-shell-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** An employee package as the unified build leaves it, client secret included. */
function employeePackage(directory, { version = '1.2.3' } = {}) {
  mkdirSync(directory, { recursive: true });
  const put = (relative, content) => {
    mkdirSync(dirname(join(directory, relative)), { recursive: true });
    writeFileSync(join(directory, relative), content);
  };
  put('installer/init-enterprise-plugin.mjs', 'export async function runInit() {}\n');
  put('enterprise-plugin/private-release.json', '{"schema":"heluo-private-release/1"}\n');
  put(SECRET, 'synthetic-client-secret-value');
  put(TARBALL, 'tarball bytes');
  put('employee-manifest.json', `${JSON.stringify({
    schema: EMPLOYEE_PACKAGE_SCHEMA,
    version,
    packages: [{ role: 'enterprise', name: '@heluo/forge-enterprise', version: `${version}-corp.1`, file: TARBALL, sha256: sha256Of('tarball bytes') }],
    configKeys: ['iam.clientId'],
    clientSecretEmbedded: true,
  }, null, 2)}\n`);
  const files = [];
  const walk = (current, prefix = '') => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else files.push(`${sha256Of(readFileSync(path))}  ${prefix}${name}`);
    }
  };
  walk(directory);
  put('SHA256SUMS', `${files.join('\n')}\n`);
  return {
    directory,
    // What the installer does once the secret is in the credential store.
    consumeSecret: () => rmSync(join(directory, SECRET)),
  };
}

/** A stand-in for the Electron interface that records what the shell does with it. */
function fakeElectron({ lock = true, tray = true, loadFails = false, dialogFails = false } = {}) {
  const log = [];
  const handlers = {};
  const windows = [];
  const trays = [];
  const messages = [];
  const externals = [];
  let answers = [];
  class Window {
    constructor(options) {
      this.options = options;
      this.loads = [];
      this.visible = false;
      this.hidden = 0;
      this.destroyed = false;
      this.own = {};
      this.webContents = {
        own: {},
        on: (event, handler) => {
          this.webContents.own[event] = handler;
        },
        setWindowOpenHandler: (handler) => {
          this.open = handler;
        },
      };
    }
    on(event, handler) {
      this.own[event] = handler;
    }
    loadURL(url) {
      this.loads.push(url);
      return loadFails ? Promise.reject(new Error('ERR_CONNECTION_REFUSED')) : Promise.resolve();
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
      this.hidden += 1;
    }
    focus() {
      this.focused = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      const event = { prevented: false, preventDefault: () => { event.prevented = true; } };
      this.own.close?.(event);
      if (!event.prevented) this.destroyed = true;
      return event;
    }
  }
  class Tray {
    constructor(image) {
      if (!tray) throw new Error('this desktop has no system tray');
      this.image = image;
      this.own = {};
      trays.push(this);
    }
    setToolTip(toolTip) {
      this.toolTip = toolTip;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    on(event, handler) {
      this.own[event] = handler;
    }
  }
  const session = {
    defaultSession: {
      setPermissionRequestHandler(handler) {
        this.request = handler;
      },
      setPermissionCheckHandler(handler) {
        this.check = handler;
      },
    },
  };
  const electron = {
    app: {
      requestSingleInstanceLock: () => lock,
      whenReady: () => {
        log.push('ready');
        return Promise.resolve();
      },
      quit: () => log.push('quit'),
      on: (event, handler) => {
        (handlers[event] ??= []).push(handler);
      },
    },
    BrowserWindow: class Recorded extends Window {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: (path) => ({ path }) },
    session,
    shell: {
      openExternal: (url) => {
        externals.push(url);
        return Promise.resolve();
      },
    },
    dialog: {
      showMessageBox: async (...args) => {
        messages.push(args.at(-1));
        // No display, or a dialog that fails: what the shell must survive.
        if (dialogFails) throw new Error('showMessageBox failed');
        return { response: answers.length === 0 ? 1 : answers.shift() };
      },
    },
  };
  return { electron, log, handlers, windows, trays, messages, externals, session, answerNext: (...values) => { answers = values; } };
}

/** A web profile process that announces at once and exits only when told. */
function webProfile() {
  const kills = [];
  let settleExit;
  const never = new Promise(() => {});
  return {
    kills,
    handle: {
      kill: (signal) => {
        kills.push(signal);
      },
      exited: new Promise((resolve) => {
        settleExit = resolve;
      }),
      // Prints its announcement, then stays quiet with its pipes open.
      output: (async function* () {
        yield `dsh web: ${LAUNCH}\n`;
        await never;
      })(),
      errors: (async function* () {
        await never;
      })(),
    },
    exit: (info = { code: 0, signal: 'SIGTERM' }) => settleExit(info),
  };
}

/** A whole shell world: package, marker, installer, web profile and the Electron stand-in. */
function world(t, { electron = {}, installer, bindHost = '127.0.0.1', markerPath, version, spawnProfile, assets, candidates, preflight, failureStopWaitMs, loadInstaller } = {}) {
  const fx = fakeElectron(electron);
  const root = temp(t);
  // `assets` reuses a package that already exists (typically one a first run consumed).
  const pkg = assets === undefined ? employeePackage(join(root, 'assets'), { version }) : { directory: assets, consumeSecret() {} };
  const processes = [];
  const installs = [];
  const exec = () => {};
  const shell = startShell(fx.electron, {
    platform: electron.platform ?? 'linux',
    assetsCandidates: candidates ?? [pkg.directory],
    markerPath: markerPath ?? join(root, 'userData', 'first-run.json'),
    profile: 'web',
    bindHost,
    embeddedCommand: '/apps/electron',
    env: { PATH: '/usr/bin' },
    exec,
    loadInstaller: loadInstaller ?? (() => installer ?? (async (input) => {
      installs.push(input);
      pkg.consumeSecret();
      return { code: 0, lines: [], warnings: [], result: { ok: true, status: 'installed' } };
    })), 
    createRuntime,
    spawnProfile: spawnProfile ?? (() => {
      const process = webProfile();
      processes.push(process);
      return process.handle;
    }),
    runtimeOptions: { startTimeoutMs: 60_000, stopGraceMs: 5_000 },
    trayIcon: '/apps/tray.png',
    ...(preflight === undefined ? {} : { preflight }),
    failureStopWaitMs,
  });
  return { ...fx, root, pkg, processes, installs, exec, shell };
}

// What the user and the system browser were shown. The window's own load address is not part of it.
const shownAndOpened = (fx) => JSON.stringify({ messages: fx.messages, externals: fx.externals, trays: fx.trays.map((tray) => tray.toolTip) });

test('the first run installs the package, then a window shows the local service and nothing else', async (t) => {
  const fx = world(t);
  const outcome = await fx.shell.outcome;
  assert.equal(outcome.started, true);
  assert.equal(outcome.origin, ORIGIN);
  // The installer ran once, with the package, the profile and the embedded runtime.
  assert.equal(fx.installs.length, 1);
  assert.deepEqual(fx.installs[0].argv, ['--release', join(fx.pkg.directory, 'enterprise-plugin'), '--profile', 'web', '--dsh', '/apps/electron', '--json']);
  assert.equal(fx.installs[0].exec, fx.exec);
  assert.deepEqual(JSON.parse(readFileSync(join(fx.root, 'userData', 'first-run.json'), 'utf8')), {
    schema: 'heluo-first-run/1',
    manifestDigest: sha256Of(readFileSync(join(fx.pkg.directory, 'employee-manifest.json'))),
    profile: 'web',
  });
  // The window is the hardened shell of a page, and the page is the launch address.
  const [window] = fx.windows;
  assert.deepEqual(window.options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
  assert.equal(Object.hasOwn(window.options.webPreferences, 'preload'), false);
  assert.deepEqual(window.loads, [LAUNCH]);
  assert.equal(window.visible, true);
  assert.equal(fx.trays.length, 1);
  assert.deepEqual(fx.trays[0].menu.map((item) => item.label), ['显示窗口', '退出']);
  // Only the local service is loaded; other web addresses go out; the rest is stopped.
  const navigated = (target) => {
    const event = { prevented: false, preventDefault: () => { event.prevented = true; } };
    window.webContents.own['will-navigate'](event, target);
    return event.prevented;
  };
  assert.equal(navigated(`${ORIGIN}/session/1`), false);
  assert.equal(navigated('https://example.corp.example/help'), true);
  assert.equal(navigated('file:///etc/passwd'), true);
  // A redirect is stopped, and nothing is opened in its place: it did not come
  // from anything done on the user's behalf. A redirect inside the service goes on.
  const redirected = { prevented: false, preventDefault: () => { redirected.prevented = true; } };
  window.webContents.own['will-redirect'](redirected, 'https://example.corp.example/');
  assert.equal(redirected.prevented, true);
  const inside = { prevented: false, preventDefault: () => { inside.prevented = true; } };
  window.webContents.own['will-redirect'](inside, `${ORIGIN}/next`);
  assert.equal(inside.prevented, false);
  assert.deepEqual(fx.externals, ['https://example.corp.example/help']);
  // New windows are never allowed, whichever address asked for one.
  assert.deepEqual(window.open({ url: 'https://example.corp.example/doc' }), { action: 'deny' });
  assert.deepEqual(window.open({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.equal(fx.externals.includes('file:///etc/passwd'), false);
  // No permission request and no permission check is ever granted.
  const granted = [];
  fx.session.defaultSession.request({}, 'media', (allowed) => granted.push(allowed));
  fx.session.defaultSession.request({}, 'geolocation', (allowed) => granted.push(allowed));
  assert.deepEqual(granted, [false, false]);
  assert.equal(fx.session.defaultSession.check({}, 'notifications'), false);
  // The process token reached the window, which needs it, and nothing else.
  assert.equal(window.loads[0].includes(TOKEN), true);
  assert.equal(shownAndOpened(fx).includes(TOKEN), false);
  assert.deepEqual(fx.processes[0].kills, []);
});

test('a loader that hands back a promise (the main.mjs wiring) is awaited before the first run', async (t) => {
  // main.mjs wires `loadInstaller: (path) => import(path).then((m) => m.runInit)`:
  // the shell must await it, or the first run sees a Promise instead of the
  // installer function and dies with BAD_ARGUMENT (issue #463 follow-up).
  const invoked = [];
  const fx = world(t, {
    loadInstaller: async () => (input) => {
      invoked.push(input);
      return { code: 0, lines: [], warnings: [], result: { ok: true, status: 'installed' } };
    },
  });
  const outcome = await fx.shell.outcome;
  assert.equal(outcome.started, true, `the shell must start, not report ${outcome.code}`);
  assert.equal(invoked.length, 1, 'the promised installer must have run exactly once');
  assert.equal(existsSync(fx.markerPath ?? join(fx.root, 'userData', 'first-run.json')), true);
});

test('a package whose first run is done is not installed again; a changed one is', async (t) => {
  const first = world(t);
  assert.equal((await first.shell.outcome).started, true);
  assert.equal(first.installs.length, 1);
  // The installer consumed the secret file, so the package is no longer whole.
  assert.equal(existsSync(join(first.pkg.directory, SECRET)), false);

  const second = world(t, { assets: first.pkg.directory, markerPath: join(first.root, 'userData', 'first-run.json') });
  assert.equal((await second.shell.outcome).started, true);
  assert.equal(second.installs.length, 0, 'a done first run is not repeated');
  assert.equal(second.messages.length, 0);
  assert.equal(second.processes.length, 1);

  const third = world(t, { version: '1.2.4', markerPath: join(first.root, 'userData', 'first-run.json') });
  assert.equal((await third.shell.outcome).started, true);
  assert.equal(third.installs.length, 1, 'another package is installed');
});

test('a failed first run stops the shell before any service or window exists', async (t) => {
  const fx = world(t, {
    installer: async () => ({ code: 1, lines: [], warnings: [], result: { ok: false, error: { code: 'IAM_CLIENT_SECRET_PROVISION_FAILED', message: 'init: 调用 dsh 失败（/a/host/path）' } } }),
  });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'FIRST_RUN_FAILED' });
  assert.equal(fx.processes.length, 0);
  assert.equal(fx.windows.length, 0);
  assert.equal(fx.messages.length, 1);
  assert.equal(fx.messages[0].type, 'error');
  assert.match(fx.messages[0].message, /FIRST_RUN_FAILED/);
  assert.equal(fx.messages[0].message.includes('/a/host/path'), false, 'the installer text is not shown');
  assert.equal(existsSync(join(fx.root, 'userData', 'first-run.json')), false, 'no record without success');
  assert.equal(fx.log.at(-1), 'quit');
});

test('without a package, with a broken one, or with a forbidden bind address, nothing starts', async (t) => {
  const tampered = world(t);
  writeFileSync(join(tampered.pkg.directory, TARBALL), 'changed');
  assert.deepEqual(await tampered.shell.outcome, { started: false, code: 'ASSETS_INVALID' });
  assert.equal(tampered.processes.length, 0);
  assert.match(tampered.messages[0].message, /ASSETS_INVALID/);

  const none = world(t, { candidates: [join(temp(t), 'absent')] });
  assert.deepEqual(await none.shell.outcome, { started: false, code: 'ASSETS_NOT_FOUND' });
  assert.equal(none.installs.length, 0);

  const elsewhere = world(t, { bindHost: '0.0.0.0' });
  assert.deepEqual(await elsewhere.shell.outcome, { started: false, code: 'BIND_HOST_REJECTED' });
  assert.equal(elsewhere.installs.length, 0);
});

test('a broken package that comes first is reported; the shell does not quietly take another', async (t) => {
  const intact = employeePackage(join(temp(t), 'intact'));
  const broken = employeePackage(join(temp(t), 'broken'));
  writeFileSync(join(broken.directory, TARBALL), 'changed');
  const fx = world(t, { candidates: [broken.directory, intact.directory] });
  // Taking the intact one would leave the record of the first run pointing at
  // a package other than the first, and the next start would not agree with it.
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'ASSETS_INVALID' });
  assert.equal(fx.installs.length, 0);
  assert.equal(fx.processes.length, 0);
  assert.equal(existsSync(join(fx.root, 'userData', 'first-run.json')), false);
});

test('a lost record of the first run costs one more installer run, not a start that never succeeds', async (t) => {
  const markerPath = join(temp(t), 'userData', 'first-run.json');
  const pkg = employeePackage(join(temp(t), 'assets'));
  const first = world(t, { assets: pkg.directory, candidates: [pkg.directory], markerPath });
  assert.equal((await first.shell.outcome).started, true);
  assert.equal(first.installs.length, 1);
  pkg.consumeSecret();
  // The record did not survive (a crash between the installer and the record);
  // the package is already consumed.
  rmSync(markerPath);
  const again = world(t, { assets: pkg.directory, candidates: [pkg.directory], markerPath });
  assert.equal((await again.shell.outcome).started, true);
  assert.equal(again.installs.length, 1, 'the installer runs once more; it is idempotent');
  assert.equal(again.messages.length, 0);
  const settled = world(t, { assets: pkg.directory, candidates: [pkg.directory], markerPath });
  assert.equal((await settled.shell.outcome).started, true);
  assert.equal(settled.installs.length, 0);
});

test('a missing embedded runtime is said before anything is touched', async (t) => {
  const fx = world(t, {
    preflight: () => {
      throw new ShellError('EMBEDDED_RUNTIME_MISSING', 'the embedded runtime entry is missing');
    },
  });
  // Nothing that needs the runtime is attempted: not the installer, not the service.
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'EMBEDDED_RUNTIME_MISSING' });
  assert.equal(fx.installs.length, 0);
  assert.equal(fx.processes.length, 0);
  assert.match(fx.messages[0].message, /找不到内嵌运行时/);
});

test('a failure whose code has no guidance is still shown, and the app still leaves', async (t) => {
  const fx = world(t, {
    preflight: () => {
      throw Object.assign(new Error('something not anticipated'), { code: 'SOMETHING_UNEXPECTED' });
    },
  });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'SOMETHING_UNEXPECTED' });
  assert.match(fx.messages[0].message, /应用无法启动/);
  assert.match(fx.messages[0].message, /SOMETHING_UNEXPECTED/);
  assert.equal(fx.log.at(-1), 'quit');
});

test('a service that will not stop does not keep a failure from being shown', async (t) => {
  const fx = world(t, { electron: { loadFails: true }, failureStopWaitMs: 10 });
  assert.equal((await fx.shell.outcome).started, true);
  // The page could not be loaded: a failure of the service, reported like one.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fx.messages.length, 1);
  assert.match(fx.messages[0].message, /EXITED/);
  // The service was asked to leave, never answered, and was not waited for beyond the limit.
  assert.deepEqual(fx.processes[0].kills, ['SIGTERM']);
  assert.equal(fx.log.at(-1), 'quit');
});

test('a dialog that cannot be shown does not stop the app from leaving', async (t) => {
  const fx = world(t, { electron: { dialogFails: true }, bindHost: '0.0.0.0' });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'BIND_HOST_REJECTED' });
  assert.equal(fx.messages.length, 1, 'the message was tried');
  assert.equal(fx.log.at(-1), 'quit');
});

test('every failure the modules can raise has guidance for the user', () => {
  const sourceDir = fileURLToPath(new URL('../src', import.meta.url));
  const codes = new Set();
  for (const name of readdirSync(sourceDir)) {
    if (!name.endsWith('.mjs')) continue;
    const source = readFileSync(join(sourceDir, name), 'utf8');
    for (const match of source.matchAll(/(?:fail|failStart|failWith)\('([A-Z_]+)'|new ShellError\('([A-Z_]+)'/g)) codes.add(match[1] ?? match[2]);
  }
  assert.ok(codes.size >= 12, `expected the modules to raise a dozen codes, found ${codes.size}`);
  for (const code of codes) {
    assert.equal(typeof guidanceFor(code), 'string', `${code} reaches the user without guidance`);
  }
  assert.equal(guidanceFor('NO_SUCH_CODE'), null);
});

test('a web profile that cannot start is reported, and the shell leaves', async (t) => {
  const fx = world(t, {
    spawnProfile: () => {
      throw Object.assign(new Error('spawn electron ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'SPAWN_FAILED' });
  assert.equal(fx.windows.length, 0);
  assert.match(fx.messages[0].message, /SPAWN_FAILED/);
  assert.equal(fx.log.at(-1), 'quit');
});

test('a second copy of the app leaves at once: one process owns the profile', async (t) => {
  const fx = world(t, { electron: { lock: false } });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'ANOTHER_INSTANCE' });
  assert.deepEqual(fx.log, ['quit']);
  assert.equal(fx.installs.length, 0);
});

test('closing the window hides it and the web profile keeps running; without a tray it quits', async (t) => {
  const fx = world(t);
  await fx.shell.outcome;
  const [window] = fx.windows;
  assert.equal(window.close().prevented, true);
  assert.equal(window.destroyed, false);
  assert.equal(window.visible, false);
  assert.deepEqual(fx.processes[0].kills, []);
  fx.trays[0].menu[0].click();
  assert.equal(window.visible, true);

  // No tray to come back to: the close goes through, and the last window closing quits.
  const bare = world(t, { electron: { tray: false } });
  await bare.shell.outcome;
  assert.equal(bare.trays.length, 0);
  assert.equal(bare.windows[0].close().prevented, false);
  bare.answerNext(0);
  bare.handlers['window-all-closed'][0]();
  await tick();
  await tick();
  assert.equal(bare.messages.length, 1, 'quitting is still confirmed');
  assert.deepEqual(bare.processes[0].kills, ['SIGTERM']);
});

test('quitting is confirmed first, then waits for the web profile to exit', async (t) => {
  const fx = world(t);
  await fx.shell.outcome;
  const beforeQuit = fx.handlers['before-quit'][0];
  // Cancelled: nothing is stopped and the app stays.
  fx.answerNext(1);
  const cancelled = { prevented: false, preventDefault: () => { cancelled.prevented = true; } };
  beforeQuit(cancelled);
  await tick();
  await tick();
  assert.equal(cancelled.prevented, true);
  assert.equal(fx.messages.length, 1);
  assert.equal(fx.messages[0].type, 'question');
  assert.deepEqual(fx.messages[0].buttons, ['退出', '取消']);
  assert.deepEqual(fx.processes[0].kills, []);
  assert.equal(fx.log.includes('quit'), false);
  // Confirmed: the service is asked to exit, and the app leaves only once it has.
  fx.answerNext(0);
  const confirmed = { preventDefault: () => { confirmed.prevented = true; } };
  beforeQuit(confirmed);
  await tick();
  await tick();
  assert.deepEqual(fx.processes[0].kills, ['SIGTERM']);
  assert.equal(fx.log.includes('quit'), false);
  fx.processes[0].exit();
  await tick();
  assert.equal(fx.log.includes('quit'), true);
  // The quit the shell started is let through when the app reports it back.
  const again = { prevented: false, preventDefault: () => { again.prevented = true; } };
  beforeQuit(again);
  assert.equal(again.prevented, false);
});
