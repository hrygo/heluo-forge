/**
 * Physical paths for what the embedded runtime hands to the operating system.
 *
 * The runtime travels inside the app's archive (`APP_ARCHIVE_PARTS`). A process
 * that loaded from there reads the archive, loads its unpacked native libraries
 * and runs an unpacked program through `execFile` by its archive path, but
 * `spawn` of that same program fails with ENOTDIR, and a program started with a
 * path into the archive cannot open it at all. Everything that has to be a real
 * file is unpacked beside the archive under the same relative path, so one rule
 * covers every case: a path into the archive whose unpacked copy is on disk is
 * replaced by that copy. The copy serves every consumer the archive path
 * served, and the ones it did not.
 *
 * Not covered, by construction: a command line handed to a shell (`exec`),
 * where a path cannot be told from text, and whatever a native library reads by
 * a path the runtime computed for itself. The runtime resolves those itself
 * where it knows about archives, and the build refuses an archive that leaves a
 * native program or library packed (`scripts/lib/desktop-archive.mjs`).
 *
 * A value is replaced only when the whole of it is a path into the archive: one
 * directory of a `PATH`-like list is left as it is.
 */
import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { fail } from './errors.mjs';
import { APP_ARCHIVE_PARTS } from './layout.mjs';

/** The functions that start one program from a path; `exec` and `fork` are not among them. */
const PROGRAM_STARTS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];

const require = createRequire(import.meta.url);

const existsOnDisk = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * The archive a path leads into, or null when it leads into none. Only a whole
 * path segment counts: the unpacked tree beside an archive, and a name that
 * merely starts the same, are not inside it.
 *
 * @param {unknown} path
 * @param {string} [archive] the archive's file name
 */
export function archiveRootOf(path, archive = APP_ARCHIVE_PARTS[0]) {
  if (typeof path !== 'string') return null;
  let prefix = '';
  for (const part of path.split(/(?=[\\/])/u)) {
    if (part.replace(/^[\\/]/u, '') === archive) return `${prefix}${part}`;
    prefix += part;
  }
  return null;
}

/**
 * The physical counterpart of a value, when it is a path into the archive that
 * is unpacked; any other value is returned as it is.
 *
 * @param {{archiveRoot: string, exists?: (path: string) => boolean, platform?: NodeJS.Platform}} input
 *   `exists` and `platform` are injection points for the offline tests.
 * @returns {(value: unknown) => unknown}
 */
export function createPhysicalPath({ archiveRoot, exists = existsOnDisk, platform = process.platform }) {
  if (typeof archiveRoot !== 'string' || archiveRoot === '' || /[\\/]$/u.test(archiveRoot)) {
    fail('BAD_ARGUMENT', 'the physical path layer needs the archive itself, as a path without a trailing separator');
  }
  // Windows spells the same path in either case and with its own separator; elsewhere a name is what it is.
  const windows = platform === 'win32';
  const prefix = `${archiveRoot}${windows ? '\\' : '/'}`;
  const unpacked = `${archiveRoot}.unpacked`;
  const fold = (value) => (windows ? value.toLowerCase() : value);
  const foldedPrefix = fold(prefix);
  return (value) => {
    if (typeof value !== 'string' || !fold(value).startsWith(foldedPrefix)) return value;
    // The candidate keeps the archive's own spelling: that is what the disk is asked about.
    const candidate = `${unpacked}${value.slice(archiveRoot.length)}`;
    return exists(candidate) ? candidate : value;
  };
}

function translatedArguments(args, physical) {
  return Array.isArray(args) ? args.map(physical) : args;
}

/** A new options object when an environment value or the working directory was replaced, else the caller's own. */
function translatedOptions(options, physical) {
  if (options === null || typeof options !== 'object') return options;
  let changed = false;
  let env = options.env;
  if (env !== null && typeof env === 'object') {
    const entries = Object.entries(env).map(([key, value]) => [key, physical(value)]);
    if (entries.some(([key, value]) => value !== env[key])) {
      env = Object.fromEntries(entries);
      changed = true;
    }
  }
  let cwd = options.cwd;
  if (cwd !== undefined) {
    cwd = physical(cwd);
    if (cwd !== options.cwd) changed = true;
  }
  if (!changed) return options;
  const next = { ...options };
  if (env !== options.env) next.env = env;
  if (cwd !== options.cwd) next.cwd = cwd;
  return next;
}

/**
 * `promisify(execFile)` as the platform defines it, through `start`: the promise
 * carries the child, resolves `{ stdout, stderr }`, and rejects with the error
 * carrying both. `util.promisify` reaches it through a marker set on the function.
 */
function promisedExecFile(start) {
  return (...args) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    promise.child = start(...args, (error, stdout, stderr) => {
      if (error !== null) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    return promise;
  };
}

/**
 * Make every program the runtime starts receive physical paths: the program
 * itself, its string arguments, the values of its environment and its working
 * directory. The rest of a call keeps its meaning: `execFile`'s callback is
 * passed on where the caller put it, and `promisify(execFile)` resolves what it
 * resolves on the platform. The built-in module's named exports are bound to the
 * original functions when an importer is linked, so they are synchronised once
 * with the replaced exports — without that, `import { spawn } from
 * 'node:child_process'` keeps calling the original.
 *
 * @param {{archiveRoot: string, childProcess?: object, sync?: () => void, exists?: (path: string) => boolean, platform?: NodeJS.Platform}} input
 *   `childProcess` and `sync` are injection points for the offline tests.
 * @returns {{patched: string[], physical: (value: unknown) => unknown}}
 */
export function installPhysicalPaths({ archiveRoot, childProcess = require('node:child_process'), sync = require('node:module').syncBuiltinESMExports, exists, platform }) {
  // Refused first: an archive root that is not one leaves the module as it was.
  const physical = createPhysicalPath({ archiveRoot, exists, platform });
  const patched = [];
  for (const name of PROGRAM_STARTS) {
    const original = childProcess[name];
    const replacement = function physicalPaths(...args) {
      const [file, second, third] = args;
      // `(file, options)` and `(file, args, options)`: an object that is not an array in the argument position is the options.
      const options = second !== null && typeof second === 'object' && !Array.isArray(second) ? second : third;
      const next = translatedOptions(options, physical);
      // What follows the options is `execFile`'s callback: it is passed on where the caller put it.
      if (options === second) return original.call(this, physical(file), undefined, next, ...args.slice(2));
      return original.call(this, physical(file), translatedArguments(second, physical), next, ...args.slice(3));
    };
    // The platform marks `execFile` for `util.promisify`; without the marker on the replacement the promise would resolve the output alone.
    if (typeof original?.[promisify.custom] === 'function') {
      Object.defineProperty(replacement, promisify.custom, { enumerable: false, configurable: false, value: promisedExecFile(replacement) });
    }
    childProcess[name] = replacement;
    patched.push(name);
  }
  sync();
  return { patched, physical };
}
