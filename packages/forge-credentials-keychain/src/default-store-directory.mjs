import { lstatSync } from 'node:fs';
import * as path from 'node:path';

function inspectPath(directory, inspect) {
  try { return inspect(directory); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function selectDefaultStoreDirectory({ platform, home, localAppData, xdgDataHome, paths = path, inspect = lstatSync }) {
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'HeluoForge');
  if (platform === 'win32') {
    const valid = typeof localAppData === 'string' && localAppData.length > 0
      && paths.isAbsolute(localAppData) && paths.parse(localAppData).root.length > 1;
    return paths.join(valid ? localAppData : paths.join(home, 'AppData', 'Local'), 'HeluoForge');
  }
  const previous = paths.join(home, '.local', 'share', 'HeluoForge');
  if (platform !== 'linux' || typeof xdgDataHome !== 'string' || !paths.isAbsolute(xdgDataHome)) return previous;
  const selected = paths.join(xdgDataHome, 'HeluoForge');
  if (paths.resolve(selected) === paths.resolve(previous)) return previous;
  // Preserve even an incomplete old store. Two distinct existing locations
  // require an explicit choice instead of silently creating a second store.
  const oldPath = inspectPath(previous, inspect);
  const newPath = inspectPath(selected, inspect);
  if (oldPath && newPath) {
    if (oldPath.isDirectory() && newPath.isDirectory() && oldPath.ino > 0
        && oldPath.ino === newPath.ino && oldPath.dev === newPath.dev) return previous;
    throw Object.assign(new Error('multiple credential store directories exist; select one explicitly'), { code: 'CRED_STORE_PATH_CONFLICT' });
  }
  return oldPath ? previous : selected;
}
