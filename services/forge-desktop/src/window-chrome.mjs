/**
 * Window chrome of the shell: which platforms show the shell's own title bar
 * in place of the system's, how the window is then shared between that bar and
 * the content, and what the bar may ask the shell for. Pure, so each rule is
 * tested without Electron; `shell.mjs` only applies it to the interface.
 *
 * The workspace page is left as it is. It keeps the layout of an ordinary
 * browser page and sits below the bar; the bar is the shell's own page.
 */

/** Renderer to main: a window action. Main to renderer: the state of the window. */
export const ACTION_CHANNEL = 'forge:window-action';
export const STATE_CHANNEL = 'forge:window-state';

/** Everything the title bar may ask for. An action takes no argument. */
export const WINDOW_ACTIONS = Object.freeze(['minimize', 'toggle-maximize', 'close']);

/**
 * The chrome on a platform.
 *
 * On a `frameless` platform the system title bar is gone and the window's own
 * page is the shell's title bar, `barHeight` pixels tall. `controls` says which
 * set of buttons it draws. Any other platform keeps the system frame and has no bar.
 *
 * @param {{platform: string}} options
 * @returns {{frameless: boolean, barHeight: number, controls: 'traffic-lights' | 'caption' | null,
 *   hideSystemButtons: boolean, window: object}}
 */
export function windowChrome({ platform }) {
  // A hidden title bar keeps what the system does for a window: the shadow,
  // resizing from the edges, snapping on Windows, the menu and the Dock on macOS.
  if (platform === 'darwin') {
    return { frameless: true, barHeight: 28, controls: 'traffic-lights', hideSystemButtons: true, window: { titleBarStyle: 'hidden' } };
  }
  if (platform === 'win32') {
    return { frameless: true, barHeight: 32, controls: 'caption', hideSystemButtons: false, window: { titleBarStyle: 'hidden' } };
  }
  return { frameless: false, barHeight: 0, controls: null, hideSystemButtons: false, window: {} };
}

/**
 * Where the content sits in a window of this size: below the bar, or over the
 * whole window when there is none. A full-screen window has no bar.
 *
 * @param {{width: number, height: number, barHeight: number, fullscreen?: boolean}} options
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function contentBounds({ width, height, barHeight, fullscreen = false }) {
  const bar = fullscreen ? 0 : barHeight;
  return { x: 0, y: bar, width, height: Math.max(0, height - bar) };
}

/** What the title bar page is started with: the buttons it draws, its height, and the title it shows. */
export function titleBarQuery({ platform, barHeight, title }) {
  return { platform, bar: String(barHeight), title };
}

/**
 * Whether an action is one the title bar may ask for. Anything else — another
 * name, an object, a missing value — is not.
 */
export function isWindowAction(action) {
  return typeof action === 'string' && WINDOW_ACTIONS.includes(action);
}

/**
 * Whether a request comes from the title bar's own page, in its main frame.
 * That page is the only one given the bridge, so nothing else has a reason to
 * ask; a frame inside the title bar is refused all the same.
 *
 * @param {object} sender the web contents the request arrived on
 * @param {object} frame the frame it was sent from
 * @param {object} window the shell's window, whose own web contents is the title bar
 */
export function isTitleBarRequest(sender, frame, window) {
  return window !== null && sender === window.webContents && frame === window.webContents.mainFrame;
}

/**
 * What the title bar is told about the window: which glyph the zoom button
 * carries, whether the bar is out of the way, and whether its buttons look active.
 */
export function chromeState({ maximized, fullscreen, focused }) {
  return { maximized: maximized === true, fullscreen: fullscreen === true, focused: focused !== false };
}
