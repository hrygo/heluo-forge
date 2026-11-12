import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const error = (code, message) => Object.assign(new Error(message), { code });

function stat(path) {
  try { return lstatSync(path); }
  catch (cause) {
    if (cause.code === 'ENOENT') return undefined;
    throw error(cause.code, 'credential path could not be inspected');
  }
}

function realpath(path) {
  try { return realpathSync(path); }
  catch (cause) { throw error(cause.code, 'credential path could not be resolved'); }
}

function directoryInfo(path) {
  const info = stat(path);
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isDirectory()) throw error('CRED_STORE_UNAVAILABLE', 'invalid credential directory');
  if (process.platform !== 'win32' && ((info.mode & 0o7777) !== 0o700
      || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
    throw error('CRED_STORE_PERMISSIONS', 'credential directory permissions or owner are invalid');
  }
  return info;
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function outsideRepository(path) {
  let current = path;
  while (!stat(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  current = realpath(current);
  for (;;) {
    if (stat(join(current, '.git'))) throw error('CRED_STORE_PATH_CONFLICT', 'credential storage must be outside a git work tree');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function createKeyPaths(input) {
  const directory = resolve(input);
  const keyDirectory = `${directory}.keys`;
  const legacy = join(directory, 'keyring.json');
  const separate = join(keyDirectory, 'keyring.json');
  if (within(directory, keyDirectory) || within(keyDirectory, directory)) {
    throw error('CRED_STORE_PATH_CONFLICT', 'credential directories overlap');
  }

  function inspect() {
    outsideRepository(directory);
    outsideRepository(keyDirectory);
    const data = directoryInfo(directory);
    const keys = directoryInfo(keyDirectory);
    if (data && keys) {
      const actualData = realpath(directory);
      const actualKeys = realpath(keyDirectory);
      if (within(actualData, actualKeys) || within(actualKeys, actualData)) {
        throw error('CRED_STORE_PATH_CONFLICT', 'credential directories overlap');
      }
    }
    const isKeyDirectory = (process.platform === 'win32' ? directory.toLowerCase() : directory).endsWith('.keys');
    if ((keys && (stat(join(keyDirectory, 'credentials.sqlite')) || stat(join(keyDirectory, '.git'))))
        || (isKeyDirectory && stat(join(directory.slice(0, -5), 'credentials.sqlite')))) {
      throw error('CRED_STORE_PATH_CONFLICT', 'credential directory has another purpose');
    }
    const old = data && stat(legacy);
    const current = keys && stat(separate);
    if (old && current) throw error('CRED_KEY_UNAVAILABLE', 'credential keyring is unavailable');
    return old ? legacy : current ? separate : undefined;
  }

  function prepareNew() {
    if (inspect()) throw error('CRED_STORE_UNAVAILABLE', 'orphaned keyring exists');
    if (!stat(keyDirectory)) {
      try { mkdirSync(keyDirectory, { mode: 0o700 }); }
      catch (cause) { if (cause.code !== 'EEXIST') throw error(cause.code, 'credential key directory could not be created'); }
      if (process.platform !== 'win32') {
        let fd;
        try { fd = openSync(dirname(keyDirectory), 'r'); fsyncSync(fd); }
        catch { throw error('CRED_KEY_DURABILITY', 'keyring directory could not be synchronized'); }
        finally { if (fd !== undefined) closeSync(fd); }
      }
    }
    if (inspect()) throw error('CRED_STORE_UNAVAILABLE', 'orphaned keyring exists');
    return separate;
  }

  return Object.freeze({ directory, keyDirectory, legacy, separate, inspect, prepareNew });
}
