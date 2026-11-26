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

/**
 * The pnpm the app ships, relative to the resources root: the `bin/pnpm.mjs`
 * of the locked npm package. Every dsh package operation runs it with the
 * app's binary as Node, so none of them looks for a pnpm on PATH.
 */
export const PNPM_ENTRY_PARTS = ['pnpm', 'bin', 'pnpm.mjs'];

/**
 * The primary runtime the app ships, relative to the resources root: upstream's
 * relocatable payload of standalone Node.js, pnpm and CPython with the Office
 * libraries, under its own `runtime.json`. The shell reads nothing inside it;
 * it names the directory to the web profile through `PRIMARY_RUNTIME_VARIABLE`.
 */
export const PRIMARY_RUNTIME_DIR = 'primary-runtime';

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
