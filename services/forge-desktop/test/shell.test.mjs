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
import { BRIDGE_TYPE, STATE_CHANNEL } from '../src/window-chrome.mjs';

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
function fakeElectron({ lock = true, tray = true, loadFails = false, dialogFails = false, titleBarFails = false, bridgeMissing = false } = {}) {
  const log = [];
  const handlers = {};
  const windows = [];
  const views = [];
  const trays = [];
  const messages = [];
  const externals = [];
  const ipc = {};
  let answers = [];

  /** What the shell uses of a page's web contents: what it loads, what it is told, and what it asks for. */
  class Page {
    constructor({ failLoads = false, failFiles = false, bridgeType = 'object' } = {}) {
      this.failLoads = failLoads;
      this.failFiles = failFiles;
      this.bridgeType = bridgeType;
      this.own = {};
      this.sent = [];
      this.loads = [];
      this.mainFrame = { page: this };
    }
    /** What the shell asks the page directly, as it does to learn whether the bridge took. */
    executeJavaScript(expression) {
      this.probes ??= [];
      this.probes.push(expression);
      return Promise.resolve(expression === BRIDGE_TYPE ? this.bridgeType : undefined);
    }
    on(event, handler) {
      this.own[event] = handler;
    }
    send(channel, state) {
      this.sent.push({ channel, state });
    }
    focus() {
      this.focusCount = (this.focusCount ?? 0) + 1;
    }
    setWindowOpenHandler(handler) {
      this.open = handler;
    }
    loadURL(url) {
      this.loads.push(url);
      return this.failLoads ? Promise.reject(new Error('ERR_CONNECTION_REFUSED')) : Promise.resolve();
    }
    loadFile(path, { query } = {}) {
      this.fileLoads ??= [];
      this.fileLoads.push({ path, query });
      return this.failFiles ? Promise.reject(new Error('ERR_FILE_NOT_FOUND')) : Promise.resolve();
    }
  }
  class Window {
    constructor(options) {
      this.options = options;
      this.visible = false;
      this.hidden = 0;
      this.destroyed = false;
      this.own = {};
      this.size = [1280, 800];
      // The window's own page (the title bar, where there is one), and the views laid out over it.
      this.webContents = new Page({ failFiles: titleBarFails, bridgeType: bridgeMissing ? 'undefined' : 'object' });
      this.contentView = { children: [], addChildView: (view) => this.contentView.children.push(view) };
    }
    on(event, handler) {
      this.own[event] = handler;
    }
    loadFile(path, { query } = {}) {
      return this.webContents.loadFile(path, { query });
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
    getContentSize() {
      return this.size;
    }
    setWindowButtonVisibility(visible) {
      this.systemButtons = visible;
    }
    minimize() {
      this.minimized = true;
    }
    maximize() {
      this.maximized = true;
    }
    unmaximize() {
      this.maximized = false;
    }
    isMaximized() {
      return this.maximized === true;
    }
    isFullScreen() {
      return this.fullscreen === true;
    }
    /** The view the work is in: the first view laid over the window. */
    get page() {
      return this.contentView.children[0];
    }
  }
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new Page({ failLoads: loadFails });
      views.push(this);
    }
    setBounds(bounds) {
      this.bounds = bounds;
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
    WebContentsView: View,
    ipcMain: {
      handle: (channel, handler) => {
        ipc[channel] = handler;
      },
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
  return { electron, log, handlers, windows, views, trays, messages, externals, session, ipc, answerNext: (...values) => { answers = values; } };
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
function world(t, { electron = {}, installer, bindHost = '127.0.0.1', markerPath, version, spawnProfile, assets, candidates, preflight, failureStopWaitMs, loadInstaller, diagnosticLog, now } = {}) {
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
    statusPage: '/brand/status.html',
    titleBarPage: '/brand/titlebar.html',
    titleBarPreload: '/apps/window-chrome.preload.cjs',
    ...(preflight === undefined ? {} : { preflight }),
    failureStopWaitMs,
    ...(diagnosticLog === undefined ? {} : { diagnosticLog }),
    ...(now === undefined ? {} : { now }),
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
  assert.deepEqual(fx.installs[0].argv, ['--release', join(fx.pkg.directory, 'enterprise-plugin'), '--profile', 'web', '--dsh', '/apps/electron', '--pnpm-from-host', '--reinstall-on-store-mismatch', '--json']);
  assert.equal(fx.installs[0].exec, fx.exec);
  assert.deepEqual(JSON.parse(readFileSync(join(fx.root, 'userData', 'first-run.json'), 'utf8')), {
    schema: 'heluo-first-run/1',
    manifestDigest: sha256Of(readFileSync(join(fx.pkg.directory, 'employee-manifest.json'))),
    profile: 'web',
  });
  // The page is the hardened shell of a page, and the page is the launch address.
  const [window] = fx.windows;
  assert.deepEqual(window.page.options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
  assert.equal(Object.hasOwn(window.page.options.webPreferences, 'preload'), false);
  assert.deepEqual(window.page.webContents.loads, [LAUNCH]);
  assert.equal(window.visible, true);
  assert.equal(fx.trays.length, 1);
  assert.deepEqual(fx.trays[0].menu.map((item) => item.label), ['显示窗口', '退出']);
  // Only the local service is loaded; other web addresses go out; the rest is stopped.
  const navigated = (target) => {
    const event = { prevented: false, preventDefault: () => { event.prevented = true; } };
    window.page.webContents.own['will-navigate'](event, target);
    return event.prevented;
  };
  assert.equal(navigated(`${ORIGIN}/session/1`), false);
  assert.equal(navigated('https://example.corp.example/help'), true);
  assert.equal(navigated('file:///etc/passwd'), true);
  // A redirect is stopped, and nothing is opened in its place: it did not come
  // from anything done on the user's behalf. A redirect inside the service goes on.
  const redirected = { prevented: false, preventDefault: () => { redirected.prevented = true; } };
  window.page.webContents.own['will-redirect'](redirected, 'https://example.corp.example/');
  assert.equal(redirected.prevented, true);
  const inside = { prevented: false, preventDefault: () => { inside.prevented = true; } };
  window.page.webContents.own['will-redirect'](inside, `${ORIGIN}/next`);
  assert.equal(inside.prevented, false);
  assert.deepEqual(fx.externals, ['https://example.corp.example/help']);
  // New windows are never allowed, whichever address asked for one.
  assert.deepEqual(window.page.webContents.open({ url: 'https://example.corp.example/doc' }), { action: 'deny' });
  assert.deepEqual(window.page.webContents.open({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.equal(fx.externals.includes('file:///etc/passwd'), false);
  // No permission request and no permission check is ever granted.
  const granted = [];
  fx.session.defaultSession.request({}, 'media', (allowed) => granted.push(allowed));
  fx.session.defaultSession.request({}, 'geolocation', (allowed) => granted.push(allowed));
  assert.deepEqual(granted, [false, false]);
  assert.equal(fx.session.defaultSession.check({}, 'notifications'), false);
  // The process token reached the window, which needs it, and nothing else.
  assert.equal(window.page.webContents.loads[0].includes(TOKEN), true);
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

test('the tray retry finishes the setup later and moves the window onto the workspace', async (t) => {
  let unreachable = true;
  let attempts = 0;
  const fx = world(t, {
    installer: async () => {
      attempts += 1;
      return unreachable
        ? { code: 1, lines: [], warnings: [], result: { ok: false, error: { code: 'IAM_DISCOVERY_FAILED', message: 'fetch failed' } } }
        : { code: 0, lines: [], warnings: [], result: { ok: true, status: 'installed' } };
    },
  });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'FIRST_RUN_FAILED', retryable: true });
  const [window] = fx.windows;
  // The network comes back; the user picks the tray retry.
  unreachable = false;
  fx.trays[0].menu.find((item) => item.label === '重试企业配置').click();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (window.page.webContents.loads.length > 0 && fx.processes.length === 1) { clearInterval(timer); resolve(); }
    }, 5);
    timer.unref?.();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, 'the retry re-ran the idempotent installer');
  assert.equal(window.page.webContents.loads.length, 1, 'the workspace address replaced the status page');
  assert.equal(fx.trays[0].menu.some((item) => item.label === '重试企业配置'), false, 'the retry entry leaves once setup is done');
  assert.equal(existsSync(join(fx.root, 'userData', 'first-run.json')), true);
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

test('a failed first run keeps the window on the status page with a tray retry, and no dialog', async (t) => {
  const fx = world(t, {
    installer: async () => ({ code: 1, lines: [], warnings: [], result: { ok: false, error: { code: 'IAM_CLIENT_SECRET_PROVISION_FAILED', message: 'init: 调用 dsh 失败（/a/host/path）' } } }),
  });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'FIRST_RUN_FAILED', retryable: true });
  assert.equal(fx.processes.length, 0);
  assert.equal(fx.windows.length, 1, 'the interface exists from the first moment');
  const [window] = fx.windows;
  assert.equal(window.page.webContents.loads.length, 0, 'no workspace address without a completed setup');
  assert.ok(window.page.webContents.fileLoads.length >= 2, 'initializing, then the failure state');
  assert.equal(window.page.webContents.fileLoads[0].query.state, 'initializing');
  // The page names the installer's code and repeats its reason: one text for every cause said nothing about which one stopped the run.
  assert.deepEqual({ ...window.page.webContents.fileLoads.at(-1).query }, {
    state: 'failed',
    code: 'FIRST_RUN_FAILED',
    installer: 'IAM_CLIENT_SECRET_PROVISION_FAILED',
    reason: 'init: 调用 dsh 失败（/a/host/path）',
    remedy: guidanceFor('FIRST_RUN_FAILED'),
  });
  assert.equal(fx.messages.length, 0, 'no modal dialog for a retryable state');
  assert.equal(fx.log.includes('quit'), false, 'the app stays alive for the retry');
  assert.ok(fx.trays[0].menu.some((item) => item.label === '重试企业配置'));
  assert.equal(existsSync(join(fx.root, 'userData', 'first-run.json')), false, 'no record without success');
});

/** An installer that stopped with a verdict of its own: code, reason, remedy, and what it printed. */
const stoppedInstaller = async () => ({
  code: 1,
  lines: ['企业插件初始化', 'profile：web', '命令：dsh plugin --profile web add /packages/enterprise.tgz'],
  warnings: ['warn: 一条警告'],
  result: {
    ok: false,
    error: { code: 'IAM_DISCOVERY_FAILED', message: 'init: 读取 IAM Discovery 失败（fetch failed）：https://idp.corp.example/x', next: '确认这台机器能访问企业 IAM 后重试；密钥文件仍保留。' },
  },
});

test('a failed first run is written to the log whole: the installer\'s code, reason, remedy, output and warnings', async (t) => {
  const root = temp(t);
  const log = join(root, 'userData', 'logs', 'first-run.log');
  const at = new Date('2026-11-25T12:00:00.000Z');
  const fx = world(t, { installer: stoppedInstaller, diagnosticLog: log, now: () => at });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'FIRST_RUN_FAILED', retryable: true });
  const entry = readFileSync(log, 'utf8');
  assert.match(entry, /^=== 2026-11-25T12:00:00\.000Z 企业配置初始化：失败 ===$/mu);
  assert.match(entry, /^错误码：FIRST_RUN_FAILED（安装器 IAM_DISCOVERY_FAILED）$/mu);
  assert.match(entry, /^原因：init: 读取 IAM Discovery 失败（fetch failed）：https:\/\/idp\.corp\.example\/x$/mu);
  assert.match(entry, /^处理：确认这台机器能访问企业 IAM 后重试；密钥文件仍保留。$/mu);
  // The whole account, in the order it was printed: the page shows a bounded line, the log does not cut.
  assert.match(entry, /^回显：\n  企业插件初始化\n  profile：web\n  命令：dsh plugin --profile web add \/packages\/enterprise\.tgz$/mu);
  assert.match(entry, /^警告：\n  warn: 一条警告$/mu);
  // The installer's remedy is shown in its own words, and the page names the log.
  const query = { ...fx.windows[0].page.webContents.fileLoads.at(-1).query };
  assert.equal(query.installer, 'IAM_DISCOVERY_FAILED');
  assert.equal(query.remedy, '确认这台机器能访问企业 IAM 后重试；密钥文件仍保留。');
  assert.equal(query.log, log);
});

test('a completed first run is written to the log with the installer\'s conclusion', async (t) => {
  const root = temp(t);
  const log = join(root, 'logs', 'first-run.log');
  const at = new Date('2026-11-25T12:30:00.000Z');
  const fx = world(t, {
    diagnosticLog: log,
    now: () => at,
    installer: async () => ({ code: 0, lines: ['状态：已安装同版本 1.2.3-corp.1，本次不写入', '核验：L1 退出码 0'], warnings: [], result: { ok: true, status: 'already-installed' } }),
  });
  assert.equal((await fx.shell.outcome).started, true);
  const entry = readFileSync(log, 'utf8');
  assert.match(entry, /^=== 2026-11-25T12:30:00\.000Z 企业配置初始化：完成 ===\n安装器结论：already-installed（退出码 0）\n回显：\n  状态：已安装同版本 1\.2\.3-corp\.1，本次不写入\n  核验：L1 退出码 0$/mu);
  // A workspace that started shows no failure, so the page never carries the log's path.
  assert.equal(fx.windows[0].page.webContents.fileLoads.some((load) => load.query.log !== undefined), false);
});

test('a retry appends to the same log; a log that cannot be written is not a failure of the application', async (t) => {
  const root = temp(t);
  const log = join(root, 'logs', 'first-run.log');
  let attempts = 0;
  const fx = world(t, {
    diagnosticLog: log,
    // Stops twice with different causes, then completes.
    installer: async () => {
      attempts += 1;
      if (attempts === 1) return stoppedInstaller();
      if (attempts === 2) {
        return { code: 1, lines: [], warnings: [], result: { ok: false, error: { code: 'PNPM_REQUIRED', message: 'init: 找不到 pnpm', next: '先安装 Node.js LTS。' } } };
      }
      return { code: 0, lines: [], warnings: [], result: { ok: true, status: 'installed' } };
    },
  });
  assert.equal((await fx.shell.outcome).retryable, true);
  const [window] = fx.windows;
  // Resolves once the interface shows what the latest attempt came to.
  const settled = (done) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('the retry never settled')); }, 5_000);
    const timer = setInterval(() => {
      if (!done()) return;
      clearInterval(timer);
      clearTimeout(deadline);
      resolve();
    }, 5);
    timer.unref?.();
    deadline.unref?.();
  });
  fx.trays[0].menu.find((item) => item.label === '重试企业配置').click();
  await settled(() => window.page.webContents.fileLoads.at(-1)?.query.installer === 'PNPM_REQUIRED');
  fx.trays[0].menu.find((item) => item.label === '重试企业配置').click();
  await settled(() => window.page.webContents.loads.length === 1 && fx.processes.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  const entries = readFileSync(log, 'utf8').split('\n=== ').filter(Boolean);
  assert.equal(entries.length, 3, 'one entry per attempt, the failed ones and the completed one');
  assert.match(entries[0], /企业配置初始化：失败/);
  assert.match(entries[1], /^2026[^\n]*\n错误码：FIRST_RUN_FAILED（安装器 PNPM_REQUIRED）\n原因：init: 找不到 pnpm\n处理：先安装 Node\.js LTS。$/mu);
  assert.match(entries[2], /企业配置初始化：完成/);

  // A path that cannot be created (a file sits where the directory would be): the shell carries on regardless.
  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, 'occupied');
  const silent = world(t, { installer: stoppedInstaller, diagnosticLog: join(blocked, 'logs', 'first-run.log') });
  assert.deepEqual(await silent.shell.outcome, { started: false, code: 'FIRST_RUN_FAILED', retryable: true });
  assert.equal(silent.windows[0].page.webContents.fileLoads.at(-1).query.reason, 'init: 读取 IAM Discovery 失败（fetch failed）：https://idp.corp.example/x');
});

test('a refused employee package and a failure that ends the application are written to the log too', async (t) => {
  const root = temp(t);
  const log = join(root, 'logs', 'first-run.log');
  const tampered = world(t, { diagnosticLog: log });
  writeFileSync(join(tampered.pkg.directory, TARBALL), 'changed');
  assert.deepEqual(await tampered.shell.outcome, { started: false, code: 'ASSETS_INVALID', retryable: true });
  // No installer ran: the entry is the shell's own account, with what was wrong in the package.
  const refused = readFileSync(log, 'utf8');
  assert.match(refused, /^=== [^\n]+ 企业配置初始化：失败 ===\n错误码：ASSETS_INVALID\n说明：the employee package is not intact\n问题：\n  .+does not match its digest$/mu);
  assert.equal(refused.includes('安装器'), false);
  // The page has no installer verdict to show: the shell's guidance for the code stands in.
  assert.deepEqual({ ...tampered.windows[0].page.webContents.fileLoads.at(-1).query }, { state: 'failed', code: 'ASSETS_INVALID', remedy: guidanceFor('ASSETS_INVALID'), log });

  const fatal = world(t, { diagnosticLog: join(root, 'fatal.log'), preflight: () => { throw Object.assign(new Error('the embedded runtime entry is missing'), { code: 'EMBEDDED_RUNTIME_MISSING' }); } });
  assert.deepEqual(await fatal.shell.outcome, { started: false, code: 'EMBEDDED_RUNTIME_MISSING' });
  assert.match(readFileSync(join(root, 'fatal.log'), 'utf8'), /^=== [^\n]+ 应用未能启动 ===\n错误码：EMBEDDED_RUNTIME_MISSING\n说明：the embedded runtime entry is missing\n$/u);
});

test('without a package, with a broken one, or with a forbidden bind address, nothing starts', async (t) => {
  const tampered = world(t);
  writeFileSync(join(tampered.pkg.directory, TARBALL), 'changed');
  assert.deepEqual(await tampered.shell.outcome, { started: false, code: 'ASSETS_INVALID', retryable: true });
  assert.equal(tampered.processes.length, 0);
  assert.equal(tampered.messages.length, 0, 'a retryable state is shown in the window, not a dialog');
  // No installer ran, so the shell's guidance for the code is what the page says to do.
  assert.deepEqual({ ...tampered.windows[0].page.webContents.fileLoads.at(-1).query }, { state: 'failed', code: 'ASSETS_INVALID', remedy: guidanceFor('ASSETS_INVALID') });

  const none = world(t, { candidates: [join(temp(t), 'absent')] });
  assert.deepEqual(await none.shell.outcome, { started: false, code: 'ASSETS_NOT_FOUND', retryable: true });
  assert.equal(none.installs.length, 0);
  assert.ok(none.windows[0].page.webContents.fileLoads.at(-1).query.code === 'ASSETS_NOT_FOUND');

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
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'ASSETS_INVALID', retryable: true });
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
  const done = world(t);
  await done.shell.outcome;
  const fx = world(t, {
    assets: done.pkg.directory,
    markerPath: join(done.root, 'userData', 'first-run.json'),
    spawnProfile: () => {
      throw Object.assign(new Error('spawn electron ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'SPAWN_FAILED' });
  assert.equal(fx.processes.length, 0);
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

/** The platforms that drop the system title bar for the shell's own, and how tall that bar is. */
const FRAMELESS = [['darwin', 28], ['win32', 32]];

for (const [platform, bar] of FRAMELESS) {
  test(`on ${platform} the window's own page is the title bar, and the work sits below it without a bridge`, async (t) => {
    const fx = world(t, { electron: { platform } });
    assert.equal((await fx.shell.outcome).started, true);
    const [window] = fx.windows;
    const [content] = fx.views;
    assert.equal(fx.windows.length, 1);
    // The system title bar is gone. On macOS its lights go with it: the bar draws its own.
    assert.equal(window.options.titleBarStyle, 'hidden');
    assert.equal(window.systemButtons, platform === 'darwin' ? false : undefined);
    assert.deepEqual(window.contentView.children, [content]);
    // The title bar is the window's own page, told which buttons to draw and what to call the window.
    assert.deepEqual(window.webContents.fileLoads, [
      { path: '/brand/titlebar.html', query: { platform, bar: String(bar), title: '河洛 Forge 企业版' } },
    ]);
    // Before anything was shown, the shell asked that page whether its bridge took.
    assert.deepEqual(window.webContents.probes, [BRIDGE_TYPE]);
    // It is the one page with a bridge to the shell, and hardened like every other.
    assert.equal(window.options.webPreferences.preload, '/apps/window-chrome.preload.cjs');
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    // The content is what it always was — no Node, no preload, an isolated context — on the launch address.
    assert.deepEqual(content.options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
    assert.equal(Object.hasOwn(content.options.webPreferences, 'preload'), false);
    assert.deepEqual(content.webContents.loads, [LAUNCH]);
    // It sits below the bar, and follows the window.
    assert.deepEqual(content.bounds, { x: 0, y: bar, width: 1280, height: 800 - bar });
    window.size = [900, 600];
    window.own.resize();
    assert.deepEqual(content.bounds, { x: 0, y: bar, width: 900, height: 600 - bar });
    // The launch address is the content's alone: the title bar is never told it.
    assert.equal(JSON.stringify(window.webContents.fileLoads).includes(TOKEN), false);
    assert.equal(window.visible, true);
    // The keyboard starts in the content, not in the title bar over it: once the status page is up, once the workspace is.
    assert.equal(content.webContents.focusCount, 2);
  });
}

test('a window action is done for the title bar, and for nothing else that asks', async (t) => {
  const fx = world(t, { electron: { platform: 'darwin' } });
  await fx.shell.outcome;
  const [window] = fx.windows;
  const [content] = fx.views;
  const ask = (sender, frame, action) => fx.ipc['forge:window-action']({ sender, senderFrame: frame }, action);
  const fromTitleBar = (action) => ask(window.webContents, window.webContents.mainFrame, action);
  const state = () => JSON.stringify([window.minimized, window.maximized, window.hidden, window.destroyed, fx.log.includes('quit')]);

  // Another page, another frame, or an action the title bar was not given: nothing happens.
  ask(content.webContents, content.webContents.mainFrame, 'minimize');
  ask(content.webContents, content.webContents.mainFrame, 'close');
  ask(window.webContents, content.webContents.mainFrame, 'toggle-maximize');
  ask(window.webContents, {}, 'close');
  ask(undefined, undefined, 'minimize');
  for (const action of ['destroy', 'show', 'load', '', 'MINIMIZE', undefined, null, 0, {}, ['minimize']]) fromTitleBar(action);
  // The window as it started: not minimized, not zoomed, never hidden, never closed.
  assert.equal(state(), JSON.stringify([undefined, undefined, 0, false, false]));

  // The window came up with the keyboard in the content. Only an action that
  // leaves it on screen hands the keyboard back: asking for focus into a window
  // that was just minimized or hidden brings it straight back.
  const { focusCount } = content.webContents;
  fromTitleBar('minimize');
  assert.equal(window.minimized, true);
  assert.equal(content.webContents.focusCount, focusCount);
  fromTitleBar('toggle-maximize');
  assert.equal(window.isMaximized(), true);
  assert.equal(content.webContents.focusCount, focusCount + 1);
  fromTitleBar('toggle-maximize');
  assert.equal(window.isMaximized(), false);
  assert.equal(content.webContents.focusCount, focusCount + 2);
  // Close is the window's own close: with a tray behind it the window hides, and the web profile keeps running.
  fromTitleBar('close');
  assert.equal(window.hidden, 1);
  assert.equal(window.destroyed, false);
  assert.deepEqual(fx.processes[0].kills, []);
  assert.equal(content.webContents.focusCount, focusCount + 2);
  // Coming back from the tray puts the keyboard in the content again.
  fx.trays[0].menu[0].click();
  assert.equal(window.visible, true);
  assert.equal(content.webContents.focusCount, focusCount + 3);
});

test('the title bar is told what the window came to, and full screen takes the bar away', async (t) => {
  const fx = world(t, { electron: { platform: 'win32' } });
  await fx.shell.outcome;
  const [window] = fx.windows;
  const [content] = fx.views;
  const told = () => window.webContents.sent.map((message) => message.state);
  // It is told the state it starts in, so the bar never has to guess.
  assert.deepEqual(window.webContents.sent, [{ channel: STATE_CHANNEL, state: { maximized: false, focused: true } }]);
  window.own.maximize();
  window.own.blur();
  assert.deepEqual(told().slice(-2), [
    { maximized: true, focused: true },
    { maximized: true, focused: false },
  ]);
  window.own.unmaximize();
  window.own.focus();
  assert.deepEqual(told().at(-1), { maximized: false, focused: true });
  // A window that comes to the front would start with the keyboard in the title bar: it is handed to the content.
  const focused = content.webContents.focusCount;
  window.own.focus();
  assert.equal(content.webContents.focusCount, focused + 1);

  // Full screen has no title bar: the content takes the whole window.
  window.fullscreen = true;
  window.own['enter-full-screen']();
  assert.deepEqual(content.bounds, { x: 0, y: 0, width: 1280, height: 800 });
  // The layout asks the window what it is. It does not remember an event: a
  // resize in full screen stays full even if that event never came, and one
  // after the window left full screen gets the bar its place back.
  window.own.resize();
  assert.deepEqual(content.bounds, { x: 0, y: 0, width: 1280, height: 800 });
  window.fullscreen = false;
  window.own.resize();
  assert.deepEqual(content.bounds, { x: 0, y: 32, width: 1280, height: 768 });
  // The bar is not told about full screen: it is covered the whole time.
  assert.equal(JSON.stringify(window.webContents.sent).includes('fullscreen'), false);
});

test('a title bar whose bridge did not take is said before anything is shown', async (t) => {
  // The page loads and the bridge's file is there; the bridge just is not on the page.
  const fx = world(t, { electron: { platform: 'darwin', bridgeMissing: true } });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'TITLE_BAR_MISSING' });
  assert.match(fx.messages[0].message, /窗口组件缺失/);
  assert.deepEqual(fx.windows[0].webContents.probes, [BRIDGE_TYPE]);
  assert.equal(fx.windows[0].visible, false, 'a window whose buttons do nothing is never shown');
  assert.equal(fx.installs.length, 0);
  assert.equal(fx.processes.length, 0);
  assert.equal(fx.log.at(-1), 'quit');
});

test('nothing navigates the title bar and nothing opens from it: it is the page that carries the bridge', async (t) => {
  const fx = world(t, { electron: { platform: 'darwin' } });
  await fx.shell.outcome;
  const [window] = fx.windows;
  const navigated = { prevented: false, preventDefault: () => { navigated.prevented = true; } };
  window.webContents.own['will-navigate'](navigated, 'https://example.corp.example/');
  assert.equal(navigated.prevented, true);
  // Even an address of the local service is not the title bar's to go to.
  const redirected = { prevented: false, preventDefault: () => { redirected.prevented = true; } };
  window.webContents.own['will-redirect'](redirected, `${ORIGIN}/next`);
  assert.equal(redirected.prevented, true);
  assert.deepEqual(window.webContents.open({ url: 'https://example.corp.example/doc' }), { action: 'deny' });
  // Not even the system browser: nothing there is a link the user followed.
  assert.deepEqual(fx.externals, []);
});

test('a platform that keeps its system title bar gets none of this: the work has the whole window, and there is no bridge at all', async (t) => {
  const fx = world(t);
  assert.equal((await fx.shell.outcome).started, true);
  const [window] = fx.windows;
  assert.equal(Object.hasOwn(window.options, 'titleBarStyle'), false);
  assert.equal(Object.hasOwn(window.options.webPreferences, 'preload'), false);
  assert.equal(window.webContents.fileLoads, undefined);
  assert.equal(window.systemButtons, undefined);
  assert.deepEqual(fx.views[0].bounds, { x: 0, y: 0, width: 1280, height: 800 });
  // No title bar to tell, and nothing that answers the bridge.
  window.own.maximize();
  assert.deepEqual(window.webContents.sent, []);
  assert.deepEqual(fx.ipc, {});
});

test('a title bar that cannot be loaded is said before anything is shown or started', async (t) => {
  const fx = world(t, { electron: { platform: 'darwin', titleBarFails: true } });
  assert.deepEqual(await fx.shell.outcome, { started: false, code: 'TITLE_BAR_MISSING' });
  assert.match(fx.messages[0].message, /窗口组件缺失/);
  assert.equal(fx.windows[0].visible, false, 'a window without controls is never shown');
  // Not a state the tray can retry: no installer runs and no service starts.
  assert.equal(fx.installs.length, 0);
  assert.equal(fx.processes.length, 0);
  assert.equal(fx.log.at(-1), 'quit');
});
