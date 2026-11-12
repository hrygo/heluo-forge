import * as path from 'node:path';

export function selectDefaultStoreDirectory({ platform, home, localAppData, xdgDataHome, paths = path }) {
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'HeluoForge');
  if (platform === 'win32') {
    const valid = typeof localAppData === 'string' && localAppData.length > 0
      && paths.isAbsolute(localAppData) && paths.parse(localAppData).root.length > 1;
    return paths.join(valid ? localAppData : paths.join(home, 'AppData', 'Local'), 'HeluoForge');
  }
  const previous = paths.join(home, '.local', 'share', 'HeluoForge');
  if (platform !== 'linux' || typeof xdgDataHome !== 'string' || !paths.isAbsolute(xdgDataHome)) return previous;
  return paths.join(xdgDataHome, 'HeluoForge');
}
