import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fail } from './errors.mjs';
import { PRIMARY_RUNTIME_DIR, PRIMARY_RUNTIME_VARIABLE } from './layout.mjs';

/**
 * The primary runtime the app ships, as far as the shell is concerned
 * (CORP-DSH-DESIGN-025).
 *
 * `stage-primary-runtime.mjs` puts upstream's relocatable payload of Node.js,
 * pnpm and CPython under `resources/primary-runtime`. The shell reads nothing
 * inside it and builds no path into it: it names the directory in a child's
 * environment, and upstream's own tool — unlocked by the enterprise bundle's
 * patch layer — reads the payload from there.
 */

/**
 * The shell's variable for a child's environment. The payload is part of what
 * the installer embedded, so one that is missing, unreadable or built for
 * another machine is refused the way a missing dsh or pnpm is: the app does not
 * start against resources it was not built with.
 *
 * @param {string} resources `process.resourcesPath` of the packaged app
 * @returns {{[PRIMARY_RUNTIME_VARIABLE]: string}}
 */
export function primaryRuntimeVariable(resources) {
  const directory = join(resources, PRIMARY_RUNTIME_DIR);
  const manifestPath = join(directory, 'runtime.json');
  // The manifest is what upstream's tool validates first: a directory without it is a payload that was not staged whole.
  if (!existsSync(manifestPath)) fail('EMBEDDED_RUNTIME_MISSING', `the bundled runtime is missing its manifest: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('EMBEDDED_RUNTIME_MISSING', `the bundled runtime has no readable manifest: ${manifestPath}`);
  }
  if (manifest?.platform !== process.platform || manifest?.arch !== process.arch) {
    fail('EMBEDDED_RUNTIME_MISSING', `the bundled runtime was built for ${manifest?.platform}-${manifest?.arch}, not for ${process.platform}-${process.arch}`);
  }
  return { [PRIMARY_RUNTIME_VARIABLE]: directory };
}
