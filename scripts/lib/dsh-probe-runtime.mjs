/** Locate the installed CLI's SDK without assuming the launcher is a Node entry. */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Return an SDK require anchor and, for the measured macOS desktop layout, the
 * Electron executable that can read that SDK's ASAR archive. Never unpack or
 * modify the host. An explicit DSH_NODE_MODULES retains its existing precedence.
 */
export function resolveDshProbeHost({ dsh = 'dsh', searchPath = process.env.PATH ?? '', modules } = {}) {
  if (modules) return { anchor: join(resolve(modules), '__probe__.cjs'), runtime: null, kind: 'explicit-modules' };
  const candidates = isAbsolute(dsh) || /[/\\]/u.test(dsh)
    ? [resolve(dsh)]
    : searchPath.split(delimiter).filter(Boolean).map((part) => join(part, dsh));
  const command = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (command === undefined) throw new Error('DSH executable not found; supply DSH_BIN or DSH_NODE_MODULES');
  const cli = realpathSync(command);
  const resources = resolve(dirname(cli), '../../..');
  const archive = join(resources, 'app.asar');
  const macOS = join(resources, '..', 'MacOS');
  if (basename(resources) === 'Resources' && existsSync(archive) && existsSync(macOS)) {
    const executables = readdirSync(macOS)
      .map((name) => join(macOS, name))
      .filter((path) => statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0);
    if (executables.length !== 1) throw new Error('DSH desktop runtime requires exactly one executable in Contents/MacOS');
    return {
      anchor: join(resources, 'app.asar', 'dsh', 'package.json'),
      runtime: realpathSync(executables[0]),
      kind: 'electron-asar',
    };
  }
  return { anchor: cli, runtime: null, kind: 'node-cli' };
}
