/**
 * Resource layout of the packaged shell, shared with the staging tool.
 *
 * These relative paths are the contract between `stage-desktop-payload.mjs`
 * (which fills `<resources>/`) and `main.mjs` (which reads it): a change on
 * either side without the other fails the layout contract test instead of a
 * packaged app at first run.
 */

/** The embedded runtime entry, relative to the resources root. */
export const DSH_ENTRY_PARTS = ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];

/** The tray icon, relative to the resources root. */
export const TRAY_ICON_PARTS = ['brand', 'tray.png'];

/** Prepended to every child's PATH; carries the staged toolchain when present. */
export const BIN_DIR = 'bin';

/** Where the first-run lookup probes for an employee package, resources-relative. */
export const ASSETS_DIR = 'enterprise-assets';
