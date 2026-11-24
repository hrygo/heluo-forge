import { fail } from './errors.mjs';
import { firstRunNeeded, initializeProfile, locateEnterpriseAssets, manifestDigestOf, writeFirstRunMarker } from './first-run.mjs';
import { closeAction, quitConfirmation } from './lifecycle.mjs';
import { assertBindHost } from './loopback.mjs';
import { classifyTarget, permissionAllowed } from './navigation.mjs';

const TITLE = '河洛 Forge 企业版';

// What the user can do about each failure. The code is always shown with it.
const GUIDANCE = Object.freeze({
  ASSETS_NOT_FOUND: '未找到完整的企业资产包。请确认员工包已随应用放置，或指定它的位置后重新启动。',
  FIRST_RUN_FAILED: '企业插件初始化失败。重新启动会再试一次；仍然失败时请联系管理员并提供错误码。',
  SPAWN_FAILED: '无法启动内嵌运行时。请重新安装应用。',
  START_TIMEOUT: '本机服务没有在限定时间内就绪。请重新启动应用。',
  PORT_CONFLICT: '本机服务需要的端口被占用。关闭占用该端口的程序后重新启动。',
  EXITED_BEFORE_READY: '本机服务在就绪前退出。请重新启动应用。',
  EXITED: '本机服务已经退出。重新启动应用可以再次进入工作区。',
  BIND_HOST_REJECTED: '配置的监听地址不被允许。',
});

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
 *   createRuntime: Function, spawnProfile: Function, runtimeOptions?: object, trayIcon?: string}} options
 * @returns {{outcome: Promise<{started: boolean, origin?: string, code?: string}>}}
 */
export function startShell(electron, options) {
  const { app } = electron;
  const { platform, assetsCandidates, markerPath, profile, bindHost, embeddedCommand, env, exec, loadInstaller, createRuntime, spawnProfile } = options;
  const context = { window: null, tray: null, runtime: null, quitting: false };

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

  async function boot() {
    assertBindHost(bindHost);
    // A package whose first run is done is not touched again: the installer
    // consumed part of it. Any other package is verified whole, then installed.
    const identified = assetsCandidates.map((candidate) => ({ candidate, manifestDigest: manifestDigestOf(candidate) })).find(({ manifestDigest }) => manifestDigest !== null);
    if (firstRunNeeded({ markerPath, manifestDigest: identified?.manifestDigest ?? null, profile })) {
      const assets = locateEnterpriseAssets({ candidates: assetsCandidates });
      await initializeProfile({ assets, runInit: loadInstaller(assets.installerPath), env, exec, profile, dsh: embeddedCommand });
      if (writeFirstRunMarker(markerPath, { manifestDigest: assets.manifestDigest, profile }) === null) {
        fail('FIRST_RUN_MARKER', 'the first-run record could not be written');
      }
    }
    context.runtime = createRuntime({ ...options.runtimeOptions, spawn: spawnProfile });
    const launch = await context.runtime.start();
    createWindow(launch);
    createTray();
    return { started: true, origin: launch.origin };
  }

  async function report(error) {
    const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    context.quitting = true;
    if (context.runtime !== null) await context.runtime.stop();
    await electron.dialog.showMessageBox({
      type: 'error',
      title: TITLE,
      message: `${GUIDANCE[code] ?? '应用无法启动。'}\n错误码：${code}`,
    });
    app.quit();
    return { started: false, code };
  }

  function createWindow(launch) {
    const window = new electron.BrowserWindow({
      width: 1280,
      height: 800,
      title: TITLE,
      show: false,
      // The renderer gets nothing from the shell: no Node, no preload, an isolated context.
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    context.window = window;
    // Only the local web profile loads here. Any other http(s) address goes to the
    // system browser; everything else is stopped before a loader sees it.
    const guard = (target) => {
      const action = classifyTarget(target, { origin: launch.origin });
      if (action === 'external') void electron.shell.openExternal(target);
      return action;
    };
    const refuse = (event, url) => {
      if (guard(url) !== 'load') event.preventDefault();
    };
    window.webContents.on('will-navigate', refuse);
    window.webContents.on('will-redirect', refuse);
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
    window.loadURL(launch.href).then(
      () => window.show(),
      // A page that cannot be loaded means the service is gone: that is a startup failure, not a quit.
      () => void report({ code: context.runtime.snapshot().failure?.code ?? 'EXITED' }),
    );
  }

  function createTray() {
    if (typeof electron.Tray !== 'function' || options.trayIcon === undefined) return;
    try {
      const tray = new electron.Tray(electron.nativeImage.createFromPath(options.trayIcon));
      tray.setToolTip(TITLE);
      tray.setContextMenu(electron.Menu.buildFromTemplate([
        { label: '显示窗口', click: reveal },
        { label: '退出', click: () => void quit() },
      ]));
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
