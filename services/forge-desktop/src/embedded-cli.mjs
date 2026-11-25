import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fail } from './errors.mjs';
import { DSH_ENTRY_PARTS, PNPM_ENTRY_PARTS } from './layout.mjs';

/**
 * The one entry the shell starts whenever it needs dsh: the web profile, and
 * every command the installer runs. It executes as Node (`ELECTRON_RUN_AS_NODE`),
 * so nothing here imports `electron`; the real Electron process is `main.mjs`.
 */
export const EMBEDDED_ENTRY = fileURLToPath(import.meta.url);

/**
 * How dsh reaches pnpm for every package operation: the app's own binary as
 * Node, running the pnpm the app ships. Left to itself dsh looks for a `pnpm`
 * on PATH, so a machine without one could not install the enterprise plugin.
 * The environment holds only the Node switch: dsh merges it into the child's
 * environment itself.
 *
 * @param {{command: string, pnpmEntry: string}} input
 *   `command` is the app binary; `pnpmEntry` is the staged `bin/pnpm.mjs`.
 */
export function packageManagerFor({ command, pnpmEntry }) {
  if (typeof command !== 'string' || command === '' || typeof pnpmEntry !== 'string' || pnpmEntry === '') {
    fail('BAD_ARGUMENT', 'the package manager needs the app binary and the staged pnpm entry');
  }
  return { command, args: [pnpmEntry], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** `import()` of the dsh entry; an injection point for the offline tests. */
const loadEntry = (path) => import(pathToFileURL(path).href);

/**
 * Run the dsh command line (`process.argv`, unchanged) with the app's package
 * manager. dsh's public entry takes the package manager as an option, which is
 * how the install reaches pnpm: nothing of dsh is modified or wrapped.
 *
 * @param {{command: string, dshEntry: string, pnpmEntry: string, load?: Function}} input
 *   `load` is an injection point for tests.
 */
export async function runEmbeddedCli({ command, dshEntry, pnpmEntry, load = loadEntry }) {
  const entry = await load(dshEntry);
  if (typeof entry?.runCli !== 'function') fail('EMBEDDED_RUNTIME_MISSING', 'the embedded runtime does not provide the command line entry');
  await entry.runCli({ packageManager: packageManagerFor({ command, pnpmEntry }) });
}

/**
 * Where the packaged app keeps the two entries; outside it there is nothing to
 * run. Both are looked for before anything is imported, so a missing one is
 * refused as such, not reported as a load error.
 */
function entryPaths() {
  const resources = process.resourcesPath;
  if (typeof resources !== 'string' || resources === '') {
    fail('EMBEDDED_RUNTIME_MISSING', 'this entry runs only from the packaged application');
  }
  const paths = {
    dshEntry: join(resources, ...DSH_ENTRY_PARTS),
    pnpmEntry: join(resources, ...PNPM_ENTRY_PARTS),
  };
  if (!existsSync(paths.dshEntry) || !existsSync(paths.pnpmEntry)) {
    fail('EMBEDDED_RUNTIME_MISSING', 'this entry runs only from the packaged application: the embedded runtime or the bundled pnpm is missing');
  }
  return paths;
}

if (import.meta.main) {
  Promise.resolve()
    .then(entryPaths)
    .then((paths) => runEmbeddedCli({ command: process.execPath, ...paths }))
    .catch((error) => {
      // What the command printed is on the streams already; this is only why it ended.
      process.stderr.write(`${error?.stack ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
