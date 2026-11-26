/**
 * The bridge of the shell's own title bar page, and of nothing else: the
 * workspace and the status page load without a preload and never see it.
 *
 * It carries three window actions that take no argument, and the state the
 * shell sends down for the buttons to follow. Nothing else of Electron, and
 * nothing that hands data back up. CommonJS, because a sandboxed renderer has
 * no module loader.
 */
const { contextBridge, ipcRenderer } = require('electron');

const ACTION_CHANNEL = 'forge:window-action';
const STATE_CHANNEL = 'forge:window-state';

contextBridge.exposeInMainWorld('forgeWindow', {
  minimize: () => ipcRenderer.invoke(ACTION_CHANNEL, 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke(ACTION_CHANNEL, 'toggle-maximize'),
  close: () => ipcRenderer.invoke(ACTION_CHANNEL, 'close'),
  /** Calls `listener` with the window's state now and on every change; returns what stops it. */
  onState: (listener) => {
    const subscription = (_event, state) => listener(state);
    ipcRenderer.on(STATE_CHANNEL, subscription);
    return () => {
      ipcRenderer.removeListener(STATE_CHANNEL, subscription);
    };
  },
});
