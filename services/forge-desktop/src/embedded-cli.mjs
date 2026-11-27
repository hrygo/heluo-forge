import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fail } from './errors.mjs';
import { APP_ARCHIVE_PARTS, DSH_ENTRY_PARTS, PRIMARY_RUNTIME_PNPM_PARTS, primaryRuntimeNodeParts } from './layout.mjs';
import { archiveRootOf, installPhysicalPaths } from './physical-paths.mjs';

/**
 * The one entry the shell starts whenever it needs dsh: the web profile, and
 * every command the installer runs. It executes as Node (`ELECTRON_RUN_AS_NODE`),
 * so nothing here imports `electron`; the real Electron process is `main.mjs`.
 */
export const EMBEDDED_ENTRY = fileURLToPath(import.meta.url);

/**
 * How dsh reaches pnpm for every package operation: the Node and the pnpm of
 * the primary runtime the app ships, as one plain child process. Left to
 * itself dsh looks for a `pnpm` on PATH, so a machine without one could not
 * install the enterprise plugin. The payload's Node — the interpreter its own
 * tools run — is the interpreter here too, so the app keeps a single copy of
 * pnpm and no `ELECTRON_RUN_AS_NODE` switch: the binary is a Node already.
 * Nothing is added to the environment; dsh merges what is here itself.
 *
 * @param {{nodeEntry: string, pnpmEntry: string}} input
 *   `nodeEntry` is the payload's Node binary; `pnpmEntry` is its `bin/pnpm.mjs`.
 */
export function packageManagerFor({ nodeEntry, pnpmEntry }) {
  if (typeof nodeEntry !== 'string' || nodeEntry === '' || typeof pnpmEntry !== 'string' || pnpmEntry === '') {
    fail('BAD_ARGUMENT', 'the package manager needs the bundled runtime Node and its pnpm entry');
  }
  return { command: nodeEntry, args: [pnpmEntry], env: {} };
}

/** `import()` of the dsh entry; an injection point for the offline tests. */
const loadEntry = (path) => import(pathToFileURL(path).href);

/**
 * Run the dsh command line (`process.argv`, unchanged) with the app's package
 * manager. dsh's public entry takes the package manager as an option, which is
 * how the install reaches pnpm: nothing of dsh is modified or wrapped.
 *
 * @param {{dshEntry: string, nodeEntry: string, pnpmEntry: string, install?: Function, load?: Function}} input
 *   `install` and `load` are injection points for tests.
 */
export async function runEmbeddedCli({ dshEntry, nodeEntry, pnpmEntry, install = installPhysicalPaths, load = loadEntry }) {
  // Before any of dsh is linked. A builtin's named exports are bound to the
  // functions an importer finds at that moment, so a runtime loaded from inside
  // the archive must have the physical path layer in place first.
  const archiveRoot = archiveRootOf(dshEntry);
  if (archiveRoot !== null) install({ archiveRoot });
  const entry = await load(dshEntry);
  if (typeof entry?.runCli !== 'function') fail('EMBEDDED_RUNTIME_MISSING', 'the embedded runtime does not provide the command line entry');
  await entry.runCli({ packageManager: packageManagerFor({ nodeEntry, pnpmEntry }) });
}

/**
 * Where the packaged app keeps the three entries; outside it there is nothing
 * to run. All are looked for before anything is imported, so a missing one is
 * refused as such, not reported as a load error. The embedded runtime is inside
 * the archive; the bundled runtime it uses for pnpm travels unpacked beside it.
 */
function entryPaths() {
  const resources = process.resourcesPath;
  if (typeof resources !== 'string' || resources === '') {
    fail('EMBEDDED_RUNTIME_MISSING', 'this entry runs only from the packaged application');
  }
  const paths = {
    dshEntry: join(resources, ...APP_ARCHIVE_PARTS, ...DSH_ENTRY_PARTS),
    nodeEntry: join(resources, ...primaryRuntimeNodeParts(process.platform)),
    pnpmEntry: join(resources, ...PRIMARY_RUNTIME_PNPM_PARTS),
  };
  if (!existsSync(paths.dshEntry) || !existsSync(paths.nodeEntry) || !existsSync(paths.pnpmEntry)) {
    fail('EMBEDDED_RUNTIME_MISSING', 'this entry runs only from the packaged application: the embedded runtime, or the bundled runtime its pnpm runs from, is missing');
  }
  return paths;
}

if (import.meta.main) {
  Promise.resolve()
    .then(entryPaths)
    .then((paths) => runEmbeddedCli(paths))
    .catch((error) => {
      // What the command printed is on the streams already; this is only why it ended.
      process.stderr.write(`${error?.stack ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
