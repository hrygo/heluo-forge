/**
 * Resource layout of the packaged shell, shared with the staging and packaging
 * tools.
 *
 * These relative paths are the contract between `stage-desktop-payload.mjs`
 * and `stage-primary-runtime.mjs` (which fill `<resources>/`) and the shell
 * (which reads it once packed): a change on either side without the other
 * fails the layout contract test instead of a packaged app at first run.
 */

/**
 * The archive the shell's own code and the embedded runtime travel in,
 * relative to the resources root. What the runtime hands to the operating
 * system — native libraries, programs, the directories a native process reads
 * — is unpacked beside it as `app.asar.unpacked`, under the same relative path.
 */
export const APP_ARCHIVE_PARTS = ['app.asar'];

/** The embedded runtime entry, relative to the archive root. */
export const DSH_ENTRY_PARTS = ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];

/**
 * The primary runtime the app ships, relative to the resources root: upstream's
 * relocatable payload of standalone Node.js, pnpm and CPython with the Office
 * libraries, under its own `runtime.json`. The shell names the directory to the
 * web profile through `PRIMARY_RUNTIME_VARIABLE`, and takes the package
 * manager's two entries out of it.
 */
export const PRIMARY_RUNTIME_DIR = 'primary-runtime';

/**
 * The pnpm of the primary runtime, relative to the resources root: the
 * `bin/pnpm.mjs` of the payload's pnpm package. Every dsh package operation
 * runs it with the payload's own Node, so none of them looks for a pnpm on
 * PATH and the app unpacks no pnpm of its own — the payload is the one copy.
 */
export const PRIMARY_RUNTIME_PNPM_PARTS = [PRIMARY_RUNTIME_DIR, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'];

/**
 * The Node of the primary runtime, relative to the resources root: `node.exe`
 * on Windows, `node` elsewhere. The same interpreter the payload's own tools
 * run is the interpreter of every package operation.
 *
 * @param {NodeJS.Platform} [platform] defaults to the running platform
 */
export function primaryRuntimeNodeParts(platform = process.platform) {
  return [PRIMARY_RUNTIME_DIR, 'dependencies', 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node'];
}

/**
 * The variable the web profile reads the payload's location from. Upstream's
 * own rows are keyed to this name, and the enterprise bundle's patch layer
 * unlocks them by it.
 */
export const PRIMARY_RUNTIME_VARIABLE = 'DSH_PRIMARY_RUNTIME';

/** The tray icon, relative to the resources root. */
export const TRAY_ICON_PARTS = ['brand', 'tray.png'];

/** Prepended to every child's PATH; carries the staged toolchain when present. */
export const BIN_DIR = 'bin';

/** Where the first-run lookup probes for an employee package, resources-relative. */
export const ASSETS_DIR = 'enterprise-assets';

/** The shell's own setup page, resources-relative: no preload, no links, no values. */
export const STATUS_PAGE_PARTS = ['brand', 'status.html'];

/** The shell's own title bar, resources-relative. Which buttons it draws, its height and the title arrive via the query string. */
export const TITLE_BAR_PARTS = ['brand', 'titlebar.html'];
