/**
 * A stand-in for `@deepseek-ai/dsh-tool-workspace-dependencies` (CORP-DSH-PLAN-026 §4.3 P2-4).
 *
 * The staging script takes the payload's layout from that package inside the
 * staged dsh closure. These tests cannot ship the real package, so a fixture
 * puts this file where the script looks for it. It keeps the contract the
 * script relies on — the four exported functions, the paths they derive, the
 * aliases they preserve — and none of the tool registration.
 */
import { cp, lstat, readlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u;

export async function parsePrimaryRuntime(value) {
  const valid = typeof value?.desktopVersion === 'string' && value.desktopVersion !== '' && typeof value.python === 'string' && VERSION.test(value.python);
  if (!valid || !['win32', 'darwin', 'linux'].includes(value?.platform) || !['x64', 'arm64'].includes(value?.arch)) {
    throw new Error('primary runtime: invalid metadata');
  }
  return value;
}

export function workspaceDependencyPaths(root, manifest) {
  const dependencies = join(root, 'dependencies');
  const windows = manifest.platform === 'win32';
  return {
    python: join(dependencies, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    ...(manifest.node === undefined ? {} : { node: join(dependencies, 'node', 'bin', windows ? 'node.exe' : 'node'), nodePackages: join(dependencies, 'node', 'node_modules') }),
    ...(manifest.pnpm === undefined ? {} : { pnpm: join(dependencies, 'pnpm', 'bin', 'pnpm.mjs') }),
    pythonPackages: join(dependencies, 'python', ...(windows ? ['Lib'] : ['lib', `python${manifest.python.split('.').slice(0, 2).join('.')}`]), 'site-packages'),
    pythonDistributions: manifest.pythonPackages,
  };
}

export async function primaryRuntimePythonAliases(root, manifest) {
  const aliases = new Map();
  if (manifest.platform === 'win32') return aliases;
  const interpreter = `python${manifest.python.split('.').slice(0, 2).join('.')}`;
  for (const name of ['python', 'python3']) {
    const path = `dependencies/python/bin/${name}`;
    let entry;
    try {
      entry = await lstat(join(root, path));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!entry.isSymbolicLink()) continue;
    if ((await readlink(join(root, path))) !== interpreter || !(await lstat(join(root, 'dependencies/python/bin', interpreter))).isFile()) {
      throw new Error(`primary runtime: invalid Python alias ${path}`);
    }
    aliases.set(path, interpreter);
  }
  return aliases;
}

export async function copyPrimaryRuntime(source, destination, manifest) {
  const aliases = await primaryRuntimePythonAliases(source, manifest);
  const excluded = new Set([...aliases.keys()].map((path) => join(source, path)));
  await cp(source, destination, { recursive: true, dereference: true, filter: (path) => !excluded.has(path) });
  for (const [path, target] of aliases) await symlink(target, join(destination, path));
}
