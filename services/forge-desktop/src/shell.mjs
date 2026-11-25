import { appendDiagnostic, failureRecord, firstRunDone, firstRunStopped, installerVerdict, statusQuery } from './diagnostic.mjs';
import { fail } from './errors.mjs';
import {
  firstRunNeeded,
  identifyEmployeePackage,
  initializeProfile,
  locateEnterpriseAssets,
  writeFirstRunMarker,
} from './first-run.mjs';
import { closeAction, quitConfirmation } from './lifecycle.mjs';
import { assertBindHost } from './loopback.mjs';
import { classifyTarget, permissionAllowed } from './navigation.mjs';

const TITLE = '河洛 Forge 企业版';

// What the user can do about each failure. The code is always shown with it,
// and every code the modules can raise has an entry (asserted by the tests).
const GUIDANCE = Object.freeze({
  ASSETS_NOT_FOUND: '未找到企业资产包。请确认员工包已随应用放置，然后从托盘菜单重试。',
  ASSETS_INVALID: '企业资产包不完整或已被改动。请重新放置完整的员工包，然后从托盘菜单重试。',
  FIRST_RUN_FAILED: '企业插件初始化失败。回到企业网络后从托盘菜单「重试企业配置」续跑；仍然失败时请联系管理员并提供错误码。',
  FIRST_RUN_MARKER: '无法记录初始化结果。请检查应用数据目录是否可写后重新启动。',
  BAD_ARGUMENT: '应用的启动参数不完整。请重新安装应用。',
  BIND_HOST_REJECTED: '配置的监听地址不被允许。',
  SPAWN_FAILED: '无法启动内嵌运行时。请重新安装应用。',
  START_TIMEOUT: '本机服务没有在限定时间内就绪。请重新启动应用。',
  PORT_CONFLICT: '本机服务需要的端口被占用。关闭占用该端口的程序后重新启动。',
  EXITED_BEFORE_READY: '本机服务在就绪前退出。请重新启动应用。',
  EXITED: '本机服务已经退出。重新启动应用可以再次进入工作区。',
  LAUNCH_URL_INVALID: '本机服务宣告的地址无法识别。请重新安装应用。',
  LAUNCH_URL_REJECTED: '本机服务宣告的地址不在允许的范围内。请重新安装应用。',
  STOPPED: '本机服务在就绪前被停止。请重新启动应用。',
  STOPPING: '本机服务正在停止。请等它结束后重新启动应用。',
  EMBEDDED_RUNTIME_MISSING: '找不到内嵌运行时。请重新安装应用。',
  UNKNOWN: '应用无法启动。请重新启动应用；仍然失败时请联系管理员并提供错误码。',
});

/** The guidance shown for a failure code; null when there is none. */
export function guidanceFor(code) {
  return GUIDANCE[code] ?? null;
}

/**
 * Assemble the shell on an Electron interface: first run, then the web profile,
 * then the window and the tray that show it. Every decision is made by the
 * modules above; this file only connects them.
 *
 * The Electron interface is passed in, so the wiring is tested against a stand-in.
 *
 * @param {{app: object, BrowserWindow: Function, Tray?: Function, Menu: object, nativeImage: object,
 *   session: object, shell: object, dialog: object}} electron
 * @param {{platform: string, assetsCandidates: string[], markerPath: string, profile: string, bindHost: string,
 *   embeddedCommand: string, env: object, exec: Function, loadInstaller: Function,
 *   createRuntime: Function, spawnProfile: Function, runtimeOptions?: object, trayIcon?: string,
 *   statusPage?: string, preflight?: Function, failureStopWaitMs?: number,
 *   diagnosticLog?: string, now?: Function, scriptExec?: Function}} options
 *   `statusPage` is the shell's own local setup page: loaded while the first
 *   run is pending or has failed, replaced by the workspace when it succeeds.
 *   `preflight` runs before anything else and fails the start by throwing; `failureStopWaitMs`
 *   bounds how long a failure report waits for the service to stop.
 *   `diagnosticLog` is the file the first run and every reported failure are
 *   written to, and whose path the status page shows; `now` supplies the time of an entry.
 *   `scriptExec` is the executor the installer runs the plugin's own CLI with
 *   (the secret provisioning commands); without it the installer uses its terminal form.
 * @returns {{outcome: Promise<{started: boolean, origin?: string, code?: string}>}}
 */
export function startShell(electron, options) {
  const { app } = electron;
  const { platform, assetsCandidates, markerPath, profile, bindHost, embeddedCommand, env, exec, loadInstaller, createRuntime, spawnProfile } = options;
  const context = { window: null, tray: null, runtime: null, quitting: false, retrying: false, pendingRetry: false, trustedOrigin: null };
  const now = options.now ?? (() => new Date());

  /** One entry in the log, when there is one; an entry that cannot be written is not a failure of the application. */
  function record(text) {
    return typeof options.diagnosticLog === 'string' && options.diagnosticLog !== '' ? appendDiagnostic(options.diagnosticLog, text) : false;
  }

  if (app.requestSingleInstanceLock() === false) {
    // Another copy owns the profile; starting a second web profile would collide with it.
    app.quit();
    return { outcome: Promise.resolve({ started: false, code: 'ANOTHER_INSTANCE' }) };
  }
  app.on('second-instance', () => reveal());
  app.on('window-all-closed', () => {
    if (closeAction({ platform, trayAttached: context.tray !== null }) === 'quit') void quit();
  });
  app.on('before-quit', (event) => {
    // A quit the shell started itself is let through; any other is confirmed and preceded by a stop.
    if (context.quitting) return;
    event.preventDefault();
    void quit();
  });

  /** The installer-driven part: verify the package, install, record the run. */
  async function performFirstRun() {
    // One package, one identity: the first candidate that carries a manifest.
    // Its digest decides whether the first run is done and is what the record
    // of the first run carries, so the two can never disagree.
    const current = identifyEmployeePackage({ candidates: assetsCandidates });
    // A package whose first run is done is not inspected again: the installer
    // consumed part of it. Any other package is verified whole, then installed.
    if (!firstRunNeeded({ markerPath, manifestDigest: current?.manifestDigest ?? null, profile })) return;
    const assets = locateEnterpriseAssets({ candidates: assetsCandidates });
    // main.mjs resolves the installer through a dynamic import: await it, or
    // the profile initializer receives a Promise instead of a function.
    const outcome = await initializeProfile({ assets, runInit: await loadInstaller(assets.installerPath), env, exec, scriptExec: options.scriptExec, profile, dsh: embeddedCommand });
    if (writeFirstRunMarker(markerPath, { manifestDigest: assets.manifestDigest, profile }) === null) {
      fail('FIRST_RUN_MARKER', 'the first-run record could not be written');
    }
    record(firstRunDone({ at: now(), outcome }));
  }

  /** The status page with what is known about the current state; nothing else is loaded before the workspace. */
  function showStatus(query) {
    if (typeof options.statusPage !== 'string' || context.window === null) return;
    context.window.loadFile(options.statusPage, { query }).then(
      () => context.window.show(),
      () => context.window.show(),
    );
  }

  /**
   * A failure shown on the status page: the code, and with a first run that
   * stopped, the installer's own code, reason and remedy. The same account,
   * whole, goes into the log.
   *
   * @returns {string} the code shown
   */
  function showFailure(error) {
    const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    const verdict = code === 'FIRST_RUN_FAILED' ? installerVerdict(error?.details) : null;
    record(firstRunStopped({ at: now(), code, verdict, error }));
    showStatus(statusQuery({ state: 'failed', code, verdict, fallback: guidanceFor(code), log: options.diagnosticLog }));
    return code;
  }

  /** Start the web profile and move the window onto it. */
  async function startWorkspace() {
    context.runtime = createRuntime({ ...options.runtimeOptions, spawn: spawnProfile });
    const launch = await context.runtime.start();
    context.trustedOrigin = launch.origin;
    createTray();
    context.window.loadURL(launch.href).then(
      () => context.window.show(),
      // A page that cannot be loaded means the service is gone: that is a startup failure, not a quit.
      () => void report({ code: context.runtime.snapshot().failure?.code ?? 'EXITED' }),
    );
    return launch;
  }

  /** Tray-driven retry: the same idempotent first run, then the normal start. */
  async function retryFirstRun() {
    if (context.retrying || context.runtime !== null || context.quitting) return;
    context.retrying = true;
    context.pendingRetry = false;
    createTray();
    showStatus({ state: 'initializing' });
    try {
      await performFirstRun();
      await startWorkspace();
    } catch (error) {
      context.pendingRetry = true;
      createTray();
      showFailure(error);
    } finally {
      context.retrying = false;
    }
  }

  async function boot() {
    // What the app needs in order to exist at all, before anything is touched.
    options.preflight?.();
    assertBindHost(bindHost);
    const needed = firstRunNeeded({
      markerPath,
      manifestDigest: identifyEmployeePackage({ candidates: assetsCandidates })?.manifestDigest ?? null,
      profile,
    });
    // The interface exists from the first moment; a bare default profile must
    // not (the official sign-in bypasses stay open until the patch is in).
    openWindow();
    createTray();
    try {
      if (needed) {
        showStatus({ state: 'initializing' });
        await performFirstRun();
      }
      const launch = await startWorkspace();
      return { started: true, origin: launch.origin };
    } catch (error) {
      if (!needed) throw error;
      // The enterprise setup is incomplete, not broken: the window stays on the
      // status page and the tray offers an idempotent retry.
      context.pendingRetry = true;
      createTray();
      const code = showFailure(error);
      return { started: false, code, retryable: true };
    }
  }

  async function report(error) {
    const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    record(failureRecord({ at: now(), code, message: error?.message }));
    context.quitting = true;
    // The service was asked to leave already, or it has left. The user is not
    // kept waiting on it: after `failureStopWaitMs` the failure is shown anyway.
    if (context.runtime !== null) {
      let timer;
      const wait = new Promise((resolve) => {
        timer = setTimeout(resolve, options.failureStopWaitMs ?? 5_000);
        timer.unref?.();
      });
      await Promise.race([context.runtime.stop(), wait]);
      clearTimeout(timer);
    }
    try {
      await electron.dialog.showMessageBox({
        type: 'error',
        title: TITLE,
        message: `${guidanceFor(code) ?? guidanceFor('UNKNOWN')}\n错误码：${code}`,
      });
    } catch {
      // Nothing can be shown (no display, a dialog that fails): the app still leaves.
    }
    app.quit();
    return { started: false, code };
  }

  function openWindow() {
    if (context.window !== null) return;
    const window = new electron.BrowserWindow({
      width: 1280,
      height: 800,
      title: TITLE,
      show: false,
      // The renderer gets nothing from the shell: no Node, no preload, an isolated context.
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    context.window = window;
    // Only the local web profile loads here. A link or a script that navigates
    // elsewhere, or asks for a new window, hands an http(s) address to the
    // system browser; everything else is stopped before a loader sees it. The
    // trusted origin is set when the workspace starts; until then only the
    // shell's own status page has been loaded, and it links nowhere.
    const guard = (target) => {
      const action = classifyTarget(target, { origin: context.trustedOrigin ?? undefined });
      if (action === 'external') void electron.shell.openExternal(target);
      return action;
    };
    const refuse = (event, url) => {
      if (guard(url) !== 'load') event.preventDefault();
    };
    window.webContents.on('will-navigate', refuse);
    // A redirect comes from a server, not from something done on the user's
    // behalf: it is stopped, and nothing is opened in its place.
    window.webContents.on('will-redirect', (event, url) => {
      if (classifyTarget(url, { origin: context.trustedOrigin ?? undefined }) !== 'load') event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      guard(url);
      return { action: 'deny' };
    });
    electron.session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permissionAllowed(permission)));
    electron.session.defaultSession.setPermissionCheckHandler(() => permissionAllowed());
    window.on('close', (event) => {
      if (context.quitting || closeAction({ platform, trayAttached: context.tray !== null }) === 'quit') return;
      // Hiding keeps the web profile and whatever it is running alive.
      event.preventDefault();
      window.hide();
    });
    return window;
  }

  /** The tray follows the shell's state: a pending setup adds the retry entry. */
  function createTray() {
    const template = [
      { label: '显示窗口', click: reveal },
      ...(context.pendingRetry ? [{ label: '重试企业配置', click: () => void retryFirstRun() }] : []),
      { label: '退出', click: () => void quit() },
    ];
    const menu = electron.Menu.buildFromTemplate(template);
    if (context.tray !== null) {
      context.tray.setContextMenu(menu);
      return;
    }
    if (typeof electron.Tray !== 'function' || options.trayIcon === undefined) return;
    try {
      const tray = new electron.Tray(electron.nativeImage.createFromPath(options.trayIcon));
      tray.setToolTip(TITLE);
      tray.setContextMenu(menu);
      tray.on('click', reveal);
      context.tray = tray;
    } catch {
      // No tray on this desktop: closing the window then quits (see closeAction).
      context.tray = null;
    }
  }

  function reveal() {
    if (context.window === null || context.window.isDestroyed()) return;
    context.window.show();
    context.window.focus();
  }

  async function quit() {
    if (context.quitting) return;
    const confirmation = quitConfirmation();
    if (confirmation.required) {
      const { response } = await electron.dialog.showMessageBox({
        type: 'question',
        buttons: ['退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: TITLE,
        message: confirmation.message,
      });
      if (response !== 0) return;
    }
    context.quitting = true;
    // The app leaves only once the web profile has. A stop that never completes keeps the app alive.
    if (context.runtime !== null) await context.runtime.stop();
    app.quit();
  }

  return { outcome: Promise.resolve().then(() => app.whenReady()).then(boot).catch(report) };
}
