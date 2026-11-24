/**
 * What closing the last window does. The web profile keeps running either
 * way: closing a window never interrupts a task. macOS keeps the app in the
 * Dock, so hiding is always recoverable there; elsewhere the tray is what
 * makes a hidden window reachable again, so without one the app quits.
 */
export function closeAction({ platform = process.platform, trayAttached = false } = {}) {
  if (platform === 'darwin') return 'hide';
  return trayAttached ? 'hide' : 'quit';
}

/**
 * Quitting stops the web profile and interrupts whatever it is running. The
 * shell cannot yet ask the web profile whether a task is running, so the user
 * is always asked to confirm.
 */
export function quitConfirmation() {
  return { required: true, message: '退出会中断正在运行的任务。确定退出「河洛 Forge 企业版」吗？' };
}
