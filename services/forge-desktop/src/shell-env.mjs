import { delimiter as pathDelimiter } from 'node:path';

// Node and Electron knobs are set by the shell for its own children. They are
// dropped from everything inherited, so a value in the user's shell profile
// cannot add loaders to, or change the mode of, the embedded runtime.
const SHELL_OWNED = new Set(['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']);
const VARIABLE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;

/** `KEY=VALUE` lines as an object. Anything else in the text is not an environment variable. */
export function parseShellEnv(text) {
  const env = {};
  for (const raw of String(text ?? '').split('\n')) {
    const match = VARIABLE.exec(raw.replace(/\r$/u, ''));
    if (match !== null && !SHELL_OWNED.has(match[1])) env[match[1]] = match[2];
  }
  return env;
}

/**
 * Arguments that ask the user's login shell for its environment, the way a
 * terminal would have it (version managers, package managers, proxies). Windows
 * has no login shell: a GUI process there already carries the user's PATH.
 */
export function loginShellArgs({ platform = process.platform, shell = '' } = {}) {
  if (platform === 'win32' || shell === '') return null;
  return [shell, '-ilc', 'printenv'];
}

/**
 * The environment of a child the shell starts: the GUI process's variables,
 * overridden by the login shell's, with `prepend` ahead of PATH. A login shell
 * that produced nothing leaves the GUI environment in place.
 */
export function childEnvironment(guiEnv = {}, loginEnv = {}, { prepend = [], delimiter = pathDelimiter } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(guiEnv)) {
    if (!SHELL_OWNED.has(key) && typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(loginEnv)) {
    if (!SHELL_OWNED.has(key) && typeof value === 'string') env[key] = value;
  }
  const added = prepend.filter((entry) => typeof entry === 'string' && entry !== '');
  if (added.length === 0) return env;
  // Keep whichever spelling the environment already uses (`Path` on Windows),
  // and only one: its value is read before the spelling is settled.
  const isPath = (key) => key.toLowerCase() === 'path';
  const pathKey = Object.keys(env).find(isPath) ?? 'PATH';
  const existing = Object.entries(env).filter(([key]) => isPath(key)).map(([, value]) => value);
  for (const key of Object.keys(env)) if (isPath(key)) delete env[key];
  env[pathKey] = [...added, ...existing].filter(Boolean).join(delimiter);
  return env;
}
